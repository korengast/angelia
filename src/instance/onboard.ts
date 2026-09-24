import { cleanName } from '../core/types.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, YAMLSeq } from 'yaml';
import { loadConfig, expandHome } from './config/load.js';
import type { Config } from './config/schema.js';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { INSTANCE_DIR, buildSkeleton, initRepo, isRepo, profilesDir, workspaceDir } from './instance.js';
import { backupConfig, instructionFile } from './init.js';
import { builtinVoiceTools } from '../voice/setup.js';
import { planProfile } from '../capabilities/compile.js';
import type { Platform } from '../core/types.js';

/**
 * A new profile for a chat nobody routed yet (`defaults.unmatched: onboard`).
 *
 * The daemon does the mechanical part, the same way every time: a folder, a starter instruction
 * file, a profile and a route in the table, the profile's capabilities compiled. What the chat is
 * for is not something code can know, so the rest is the agent's first job, steered by the
 * onboarding prompt. The prompt ships with Angelia and an owner may replace it (onboard.prompt).
 */

/** The prompt used when onboard.prompt is not set. */
export const DEFAULT_PROMPT = fileURLToPath(new URL('../../prompts/onboarding.md', import.meta.url));

/** Every backend Angelia runs reads CLAUDE.md. */
const INSTRUCTIONS = 'CLAUDE.md';

/** A profile name from the chat's own name, unique in the table and on disk. Non-Latin names stay as they are. */
export function profileName(chatName: string | undefined, chat: string, taken: (n: string) => boolean): string {
  const fromName = (chatName ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const base = fromName || `chat-${chat.replace(/\D/g, '').slice(-6) || 'new'}`;
  let n = base;
  for (let k = 2; taken(n); k++) n = `${base}-${k}`;
  return n;
}

/** The prompt text: the leading comment dropped, the placeholders filled. */
export function onboardingPrompt(file: string, vars: Record<string, string>): string {
  const raw = readFileSync(file, 'utf8').replace(/^\s*<!--[\s\S]*?-->\s*/, '');
  return raw.replace(/\{(profile|folder|instructions|chat_name|chat)\}/g, (_, k: string) => vars[k] ?? '').trim();
}

/** The starter file says setup is unfinished, so a later turn without the prompt still knows. */
export function starterFile(name: string): string {
  return instructionFile(name, builtinVoiceTools())
    + '\nThis chat is still being set up. Until this file says what the chat is for, your first job is to find out from the owner and write it here.\n';
}

export interface OnboardOpts {
  /** The routing table on disk. It is edited, then loaded again to check it. */
  table: string;
  /** The daemon's live config: the new profile and route are added to it, so no restart is needed. */
  cfg: Config;
  platform: Platform;
  chat: string;
  chatName?: string;
  instance?: string;
  self?: (profile: string) => string;
  now?: Date;
}

export interface Onboarded {
  name: string; folder: string; prompt: string;
  /** What happened in git, in words. It settles after the new chat's first reply can go out: a push
   *  to a slow remote must not hold that reply, nor any other chat. Never rejects. */
  git?: Promise<string>;
}

export function onboardChat(o: OnboardOpts): Onboarded {
  const ob = o.cfg.onboard;
  if (!ob) throw new Error('no onboard: block in the routing table');
  const instance = o.instance ?? INSTANCE_DIR;
  const root = ob.folder ? resolve(expandHome(ob.folder)) : profilesDir(instance);
  // In the workspace, a new profile is versioned from its first minute: the repo is made if missing.
  const ws = ob.folder ? undefined : workspaceDir(instance);
  // Local git only, once per instance; the timeout keeps a stuck hook or lock from holding the daemon.
  if (ws && !isRepo(ws)) { buildSkeleton([], instance); initRepo(ws, (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })); }
  const name = profileName(o.chatName, o.chat, (n) => n in o.cfg.profiles || existsSync(join(root, n)));
  const folder = join(root, name);

  const doc = parseDocument(readFileSync(o.table, 'utf8'));
  // No anchors (&a1 / *a1) when two fields hold the same list: the table stays plain to read and edit.
  const plain = { aliasDuplicateObjects: false };
  doc.setIn(['profiles', name], doc.createNode({ ...ob.profile, cwd: folder }, plain));
  const route: Record<string, unknown> = { platform: o.platform, chat: o.chat, profile: name };
  if (ob.mention) route.mention = ob.mention;
  route.owners = ob.owners;
  route.allow_from = ob.allow_from ?? ob.owners;
  const routes = doc.get('routes', true);
  if (!(routes instanceof YAMLSeq)) throw new Error(`${o.table}: routes is not a list`);
  const node = doc.createNode(route, { ...plain, flow: true });
  node.commentBefore = ` Onboarded ${(o.now ?? new Date()).toISOString().slice(0, 10)}${o.chatName ? ` from "${o.chatName.replace(/\s+/g, ' ')}"` : ''}.`;
  routes.add(node);

  mkdirSync(folder, { recursive: true });
  const file = join(folder, INSTRUCTIONS);
  if (!existsSync(file)) writeFileSync(file, starterFile(name));

  // The table is only replaced by a version that loads; a failure puts the old one back.
  const backup = backupConfig(o.table, o.now);
  // These options write an untouched table back byte for byte (checked on a real one), so the owner's
  // own layout survives: only the new profile and route are new text.
  writeFileSync(o.table, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  let fresh: Config;
  try { fresh = loadConfig(o.table); } catch (e) { copyFileSync(backup, o.table); throw e; }

  const p = fresh.profiles[name];
  try {
    // An agent must not start before its deny rules are written, so a failure here undoes the route
    // too. Every profile is compiled, capabilities or not: the floor keeps its file tools off
    // Angelia's own secrets, and for grok the same step writes the self block.
    const plan = planProfile(fresh, name, { self: o.self, stateDir: instance });
    if (plan.conflicts.length) throw new Error(`capabilities for ${name}: ${plan.conflicts.join('; ')}`);
    plan.apply();
  } catch (e) { copyFileSync(backup, o.table); throw e; }

  o.cfg.profiles[name] = p;
  o.cfg.routes.push(fresh.routes.find((r) => r.profile === name && r.chat === o.chat)!);
  const prompt = onboardingPrompt(ob.prompt ? resolve(expandHome(ob.prompt)) : DEFAULT_PROMPT, {
    profile: name, folder, instructions: INSTRUCTIONS, chat: `${o.platform}:${o.chat}`, chat_name: o.chatName ? cleanName(o.chatName, 80) : 'no name',
  });
  return { name, folder, prompt, ...(ws ? { git: commitProfile(ws, name) } : {}) };
}

/** One commit with the new folder only, pushed when the workspace has a remote (the owner chose one;
 *  angelia init offers it). A failed push leaves the commit in place for the next push. */
async function commitProfile(ws: string, name: string): Promise<string> {
  // This runs inside the daemon: off the event loop, and a remote that does not answer is given up on.
  const git = async (args: string[]) => (await run('git', args, { cwd: ws, encoding: 'utf8', timeout: 20_000 })).stdout;
  try {
    await git(['add', '--', join('profiles', name)]);
    await git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `Onboard ${name}`, '--', join('profiles', name)]);
    if (!(await git(['remote'])).trim()) return 'committed';
    try { await git(['push', '-q', 'origin', 'HEAD']); return 'committed and pushed'; }
    catch (e) { return `committed, not pushed: ${firstLine(e)}`; }
  } catch (e) {
    return `not committed: ${firstLine(e)}`;
  }
}

const run = promisify(execFile);

/** execFile's error says "Command failed: git …" first and the reason on a later line; a timeout says neither. */
function firstLine(e: unknown): string {
  const err = e as Error & { killed?: boolean; stderr?: string };
  if (err.killed) return 'git did not answer in 20 seconds';
  return (err.stderr?.trim() || err.message).split('\n')[0];
}
