import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDocument, YAMLSeq } from 'yaml';
import { loadConfig } from './config/load.js';
import { Route, type Config } from './config/schema.js';
import { INSTANCE_DIR, isRepo, profilesDir, workspaceDir } from './instance.js';
import { backupConfig, DAEMON_LOCK_WAIT_MS, withLock, withTableLock, writeTable } from './init.js';
import { planProfile, refreshFloors } from '../capabilities/compile.js';
import { beyond, pendingRefusal, tablePath, writeAccepted } from './accepted.js';
import { commitProfile } from './onboard.js';
import { cleanName, type Platform } from '../core/types.js';

/**
 * A profile that is set up already (made in the app, or by hand) takes the next new chat on one
 * platform, instead of that chat getting a new, empty profile. Opt-in: the owner arms a profile with
 * `angelia profile connect <profile> whatsapp|telegram` (or `--connect` when making it), adds the bot
 * to the group, and writes there. Nothing armed: unknown chats are handled exactly as before.
 *
 * The arm is a line in the state folder's compiled/, which no agent's file tools may open. That does
 * not stop an agent with a shell: it can run `angelia profile connect`, as it can run `profile add`.
 * What holds is who uses an arm: only an owner of the onboard: block (orchestrator.ts), by adding the
 * bot or writing first, and it expires.
 */

/** Why a bind did not happen that is no error to report: nothing armed any more (another chat took
 *  it, or it expired), or the chat is routed in the table on disk already (a restart will route it). */
export class ConnectSkip extends Error {
  constructor(readonly code: 'not-armed' | 'routed', message: string) { super(message); }
}

const ARMED_FILE = join('compiled', 'table', 'connect.json');
export const ARM_HOURS = 24;
export const ARM_HOURS_MAX = 168;

/** One profile waiting for the next new chat on a platform. Times are ISO strings. */
export type ChatPlatform = 'whatsapp' | 'telegram';
/** The new route's settings, when the owner gave them; each one left out is the onboard: block's. */
export interface RouteSettings { owners?: string[]; allow_from?: string[]; mention?: 'required' | 'any' }
export interface Armed { profile: string; platform: ChatPlatform; at: string; until: string; route?: RouteSettings }

/** The settings as the table's schema reads a route's (ids as text, "*" only in allow_from). Throws why not. */
export function checkRoute(r: RouteSettings): RouteSettings {
  const parsed = Route.safeParse({ platform: 'whatsapp', chat: '0', profile: 'x', ...r });
  if (!parsed.success) { const i = parsed.error.issues[0]; throw new Error(`${i.path.join('.') || 'route'}: ${i.message}`); }
  for (const id of [...(r.owners ?? []), ...(r.allow_from ?? [])]) if (!/^[^\s,]+$/.test(id)) throw new Error(`"${id}" is not a sender id: digits, a lid, or "*" (allow only)`);
  if (r.owners?.includes('*')) throw new Error('--owners: "*" would make everyone an owner');
  if (r.owners && !r.owners.length) throw new Error('--owners: at least one id');
  const out: RouteSettings = {};
  if (r.owners) out.owners = parsed.data.owners;
  if (r.allow_from) out.allow_from = parsed.data.allow_from;
  if (r.mention) out.mention = r.mention;
  return out;
}

/** Who may use an arm: the onboard: block's owners only. An arm's --owners are the new route's owners,
 *  not people who may take a profile: an arm made by anyone with a shell must not widen that. */
export function armOwners(cfg: Config): string[] {
  return cfg.onboard?.owners ?? [];
}

const PLATFORMS: readonly string[] = ['whatsapp', 'telegram'];
export const isChatPlatform = (p: string | undefined): p is ChatPlatform => p === 'whatsapp' || p === 'telegram';

/** The file as last read, by path: an owner's message in an unknown chat reads it, and most of those
 *  find it unchanged (or absent). Read again when its mtime or size changes, and after every write here. */
const cache = new Map<string, { mtimeMs: number; size: number; all: Armed[] }>();

function readAll(instance: string): Armed[] {
  const file = join(instance, ARMED_FILE);
  let st;
  try { st = statSync(file); } catch { cache.delete(file); return []; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.all;
  let all: Armed[] = [];
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    all = Array.isArray(v) ? v.filter((x): x is Armed => !!x && typeof x.profile === 'string' && PLATFORMS.includes(x.platform)
      && typeof x.at === 'string' && typeof x.until === 'string') : [];
  } catch { all = []; }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, all });
  return all;
}

/** Whole or not at all; the file goes when the last entry does. */
function writeAll(instance: string, all: Armed[]): void {
  const file = join(instance, ARMED_FILE);
  cache.delete(file);
  if (!all.length) { rmSync(file, { force: true }); return; }
  writeTable(file, JSON.stringify(all) + '\n');
}

/** `waitMs`: the daemon's paths ask for a short wait, since it blocks every chat (review fix C2). */
function locked<T>(instance: string, fn: () => T, waitMs?: number): T {
  mkdirSync(join(instance, 'compiled', 'table'), { recursive: true, mode: 0o700 });
  return withLock(join(instance, ARMED_FILE), fn, waitMs);
}

/** An arm's end as the terminal shows it: "24 Nov 2026, 07:03", local time. */
export const untilText = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const live = (a: Armed, now: Date) => Date.parse(a.until) > now.getTime();

/** What is armed now, expired entries left out. */
export function armedList(instance = INSTANCE_DIR, now = new Date()): Armed[] {
  return readAll(instance).filter((a) => live(a, now));
}

/** The entry for a platform, if one is armed and not expired. */
export function armedFor(instance: string, platform: Platform, now = new Date()): Armed | undefined {
  return armedList(instance, now).find((a) => a.platform === platform);
}

/** Why this profile may not be armed or bound to a chat, if it may not. */
export function connectRefusal(cfg: Config, profile: string, platform?: ChatPlatform): string | undefined {
  if (!cfg.onboard) return 'connect takes the chat\'s owners and allow list from the onboard: block in the routing table; add one first (angelia guide onboard)';
  if (!Object.hasOwn(cfg.profiles, profile)) return `no profile named ${profile} (angelia profiles lists them)`;
  // The onboard block's allow list lets other people talk in the chat: the profile that keeps the
  // instance (shared_write reaches every other profile) must not get a chat that way.
  if (cfg.profiles[profile].shared_write) return `${profile} has shared_write: it keeps the instance, so a chat route to it is written by hand, not taken from the onboard: block`;
  if (platform && !cfg[platform]) return `the routing table has no ${platform}: block, so no ${platform} chat can be routed`;
  return undefined;
}

/** Arm a profile for the next new chat on a platform. Returns the entry it replaced, if any. */
export function arm(instance: string, a: { profile: string; platform: ChatPlatform; hours?: number; now?: Date; route?: RouteSettings }): { armed: Armed; replaced?: Armed } {
  const route = a.route ? checkRoute(a.route) : undefined;
  const hours = a.hours ?? ARM_HOURS;
  if (!Number.isFinite(hours) || hours < 1 || hours > ARM_HOURS_MAX) throw new Error(`--hours: from 1 to ${ARM_HOURS_MAX}`);
  const now = a.now ?? new Date();
  const armed: Armed = { profile: a.profile, platform: a.platform, at: now.toISOString(), until: new Date(now.getTime() + hours * 3600_000).toISOString(), ...(route && Object.keys(route).length ? { route } : {}) };
  return locked(instance, () => {
    const all = readAll(instance).filter((x) => live(x, now));
    const replaced = all.find((x) => x.platform === a.platform);
    writeAll(instance, [...all.filter((x) => x.platform !== a.platform), armed]);
    return { armed, ...(replaced ? { replaced } : {}) };
  });
}

/** Take the entry off a platform; returns it, if one was armed. */
export function cancelArmed(instance: string, platform: ChatPlatform, now = new Date()): Armed | undefined {
  return locked(instance, () => {
    const all = readAll(instance);
    const gone = all.find((x) => x.platform === platform && live(x, now));
    writeAll(instance, all.filter((x) => x.platform !== platform && live(x, now)));
    return gone;
  });
}

/** The entry was used: removed, but only that one (a new arm made since stays). In the daemon: a short
 *  wait for the arm lock (connectArmed tries twice, then logs). */
function used(instance: string, a: Armed): void {
  locked(instance, () => writeAll(instance, readAll(instance).filter((x) => !(x.platform === a.platform && x.at === a.at && x.profile === a.profile))), DAEMON_LOCK_WAIT_MS);
}

export interface BindOpts {
  /** The routing table on disk. It is edited, then loaded again to check it. */
  table: string;
  /** The daemon's live config (or the terminal's): the new route is added to it. */
  cfg: Config;
  profile: string;
  platform: Platform;
  chat: string;
  chatName?: string;
  instance?: string;
  self?: (profile: string) => string;
  now?: Date;
  /** The table's text as it is read for the edit (default: the file). A test stands an edit that lands
   *  between the checks and the read in here. */
  readTable?: (path: string) => string;
  /** The route's own settings (the arm's, or the terminal's); the rest from the onboard: block. */
  route?: RouteSettings;
}

export interface Connected {
  name: string; folder: string;
  /** As onboarding's: what happened in git, settled later. Never rejects. */
  git?: Promise<string>;
}

/**
 * One route to an existing profile, for a chat no route has. The route is built from the onboard:
 * block exactly as onboarding builds it; the profile, its folder and its instruction file are not
 * touched. Every failure puts the table back as it was. The table's read-change-write holds its lock.
 */
export function bindChat(o: BindOpts): Connected {
  return withTableLock(o.table, 'connecting', () => bindLocked(o));
}

function bindLocked(o: BindOpts): Connected {
  const instance = o.instance ?? INSTANCE_DIR;
  const ob = o.cfg.onboard;
  const name = o.profile;
  // The live config's word on the profile only when it has the profile: one added (and accepted) after
  // the daemon started is checked against the table on disk below (review fix M2).
  const why = Object.hasOwn(o.cfg.profiles, name) || !ob ? connectRefusal(o.cfg, name) : undefined;
  if (why || !ob) throw new Error(`not connecting: ${why}`);
  if (!isChatPlatform(o.platform)) throw new Error(`not connecting: ${o.platform} chats are not routed`);
  const key = `${o.platform}:${o.chat}`;
  if (o.cfg.routes.some((r) => r.platform === o.platform && r.chat === o.chat)) throw new Error(`not connecting: ${key} is already routed`);

  // Built on the table as it stands, so that table must be the accepted one (accepted.ts).
  const disk = loadConfig(o.table);
  // Routed on disk already (`profile connect <p> <chat>`, or by hand) and waiting for a restart: that
  // route is the owner's, and a second one would only make the table say two things.
  if (disk.routes.some((r) => r.platform === o.platform && r.chat === o.chat)) throw new ConnectSkip('routed', `${key} is routed in the table on disk already; it is live after the next restart`);
  const pending = pendingRefusal(disk, instance);
  if (pending) throw new Error(`not connecting: ${pending}`);
  // The profile as the accepted table on disk has it: the terminal armed it against that table.
  const onDisk = connectRefusal(disk, name);
  if (onDisk) throw new Error(`not connecting: ${onDisk}`);
  const added = !Object.hasOwn(o.cfg.profiles, name);
  const doc = parseDocument((o.readTable ?? ((p: string) => readFileSync(p, 'utf8')))(o.table));
  if (!doc.hasIn(['profiles', name])) throw new Error(`not connecting: ${name} is not in the routing table on disk`);
  const route: Record<string, unknown> = { platform: o.platform, chat: o.chat, profile: name };
  const own = o.route ? checkRoute(o.route) : {};
  // A connected chat answers only when the bot is mentioned, unless the arm or connect_mention says any.
  route.mention = own.mention ?? ob.connect_mention;
  // The onboard: block's owners stay owners of every chat it routes; --owners adds to them.
  route.owners = own.owners ? [...new Set([...ob.owners, ...own.owners])] : ob.owners;
  route.allow_from = own.allow_from ?? ob.allow_from ?? route.owners;
  const routes = doc.get('routes', true);
  if (!(routes instanceof YAMLSeq)) throw new Error(`${o.table}: routes is not a list`);
  const node = doc.createNode(route, { aliasDuplicateObjects: false, flow: true });
  node.commentBefore = ` Connected ${(o.now ?? new Date()).toISOString().slice(0, 10)} to ${name}${o.chatName ? `, from "${o.chatName.replace(/\s+/g, ' ')}"` : ''}.`;
  routes.add(node);

  const backup = backupConfig(o.table, o.now);
  const restore = () => writeTable(o.table, readFileSync(backup));
  writeTable(o.table, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  let fresh: Config;
  try { fresh = loadConfig(o.table); } catch (e) { restore(); throw e; }
  // Only the new route may differ from the accepted table: anything else came in between.
  const extra = beyond(instance, fresh, [tablePath('routes', key)]);
  if (extra.length) { restore(); throw new Error(`not connecting: the routing table changed while it was written (${extra.join('; ')})`); }
  let others: { undo(): void } | undefined;
  try {
    // Compiled again so the profile's self block knows its new chat.
    const plan = planProfile(fresh, name, { self: o.self, stateDir: instance });
    if (plan.conflicts.length) throw new Error(`capabilities for ${name}: ${plan.conflicts.join('; ')}`);
    // A short wait for the compile lock: this runs in the daemon, and the wait blocks it (review fix L7).
    plan.apply({ waitMs: DAEMON_LOCK_WAIT_MS });
    // A profile new to the live config: every other profile's floor names it (its folder, its agy
    // folder), before its route goes live, as onboarding does.
    if (added) others = refreshFloors(fresh, [name], instance, undefined, { waitMs: DAEMON_LOCK_WAIT_MS });
    // Inside the try (review fix L2): a failed write puts the table back, so the table, the accepted
    // copy and the live config never disagree about the route.
    writeAccepted(fresh, instance);
  } catch (e) {
    try { others?.undo(); } catch { /* the first error is the one to say */ }
    restore();
    throw e;
  }

  if (added) o.cfg.profiles[name] = fresh.profiles[name];
  o.cfg.routes.push(fresh.routes.find((r) => r.profile === name && r.platform === o.platform && r.chat === o.chat)!);
  const folder = fresh.profiles[name].cwd;
  // Versioned like onboarding's profiles, when the folder is the workspace's own (profiles/<name>).
  const ws = workspaceDir(instance);
  const inWs = resolve(folder) === join(profilesDir(instance), name) && existsSync(ws) && isRepo(ws);
  return { name, folder, ...(inWs ? { git: commitProfile(ws, name, `Connect ${name} to a new ${o.platform} chat`, { quietIfNone: true }) } : {}) };
}

/** An owner's first message in a new chat (or the bot added by one), with a profile armed for its
 *  platform: bind, then use the entry up. A failed bind leaves the entry armed. After a good bind the
 *  chat is connected whatever happens to the entry: a removal that fails is tried once more, then logged. */
export function connectArmed(o: Omit<BindOpts, 'profile'> & { log?: (line: string) => void; remove?: (instance: string, a: Armed) => void }): Connected {
  const instance = o.instance ?? INSTANCE_DIR;
  const a = armedFor(instance, o.platform, o.now);
  if (!a) throw new ConnectSkip('not-armed', `no profile is armed for ${o.platform} any more`);
  const made = bindChat({ ...o, profile: a.profile, ...(a.route ? { route: a.route } : {}) });
  const remove = o.remove ?? used;
  for (let n = 1; n <= 2; n++) {
    try { remove(instance, a); break; } catch (e) {
      o.log?.(`connect arm not removed (try ${n} of 2) platform=${a.platform} profile=${a.profile}: ${(e as Error).message}`);
    }
  }
  return made;
}

/** The short preface of the connected chat's first turn, in place of the onboarding prompt. */
export function connectPreface(profile: string, key: string, chatName?: string): string {
  const name = chatName ? cleanName(chatName, 80) : 'no name';
  return `This chat (${key}, "${name}") was just connected to you, ${profile}. You are already set up: your instructions and memory are in your folder as before. Do not start onboarding. Answer the message below.`;
}

/** What the orchestrator's `connect` option is (core/orchestrator.ts): one function for the daemon and its tests. */
export function connectWiring(o: { table: string; cfg: Config; instance: string; self?: (profile: string) => string; log?: (line: string) => void; remove?: (instance: string, a: Armed) => void }) {
  return {
    armed: (platform: Platform) => {
      const a = armedFor(o.instance, platform);
      return a && { profile: a.profile, owners: armOwners(o.cfg), mention: a.route?.mention ?? o.cfg.onboard?.connect_mention ?? 'required', at: Date.parse(a.at) };
    },
    bind: (i: { platform: Platform; chat: string }, chatName?: string) => {
      const made = connectArmed({ table: o.table, cfg: o.cfg, platform: i.platform, chat: i.chat, chatName, instance: o.instance, self: o.self, log: o.log, remove: o.remove });
      return { name: made.name, prompt: connectPreface(made.name, `${i.platform}:${i.chat}`, chatName), ...(made.git ? { git: made.git } : {}) };
    },
  };
}
