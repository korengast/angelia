import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretFindings } from './secrets.js';

/**
 * Where one person's Angelia lives.
 *
 * `~/.angelia/` is not the router's scratch directory: it is the assistant itself, made concrete.
 * One instance, one folder - back it up, move it to another Mac, or delete it, and each is a single
 * operation. Inside it there is exactly one boundary, and it is the only one that matters:
 *
 *   workspace/   everything "brain". A git repo. Safe to push to a private remote.
 *   everything else   credentials, sessions, logs, the WhatsApp auth store. Never in git.
 *
 * Nesting a workspace inside a state directory is not the mistake - OpenClaw does the same and it
 * works. Fusing them is: then nothing can be version controlled without version controlling
 * secrets. Here the line is structural rather than documentary: the
 * repo root *is* the boundary, and the generated .gitignore is the second lock on it.
 */
export const INSTANCE_DIR = process.env.ANGELIA_STATE_DIR ?? join(homedir(), '.angelia');

/** What in the state folder no agent may open: the secrets file, the WhatsApp login (a copy of wa/ is
 *  that account), the local API's token, the tmux hosts' files, the session map (a session id is
 *  enough to resume another chat's conversation), and what the last compile of each profile wrote
 *  (the launch guard checks a profile against it). The deny floor (compile.ts) and the media check
 *  (media.ts) both read this list. */
export const STATE_PRIVATE = {
  files: ['env', 'api.token', 'sessions.json'],
  dirs: ['wa', 'tui', 'compiled'],
};

/** Credential and private-mail locations under the home folder. Every profile's file tools are denied
 *  them (compile.ts), unless the profile names one in add_dirs; the media check refuses to attach
 *  from them (media.ts), with a few more folders of its own. */
export const HOME_PRIVATE = {
  dirs: ['.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.docker', '.kube', '.password-store',
    'Library/Keychains', 'Library/Cookies', 'Library/Messages', 'Library/Mail'],
  files: ['.netrc', '.git-credentials', '.npmrc', '.pypirc', '.pgpass', '.vault-token', '.zsh_history', '.bash_history'],
};

/** The daemon's API socket in the state folder (daemon/api/server.ts). */
export const API_SOCKET = 'api.sock';

/** The logs and the status file: ids and counts, which an agent may read (the one that builds or
 *  mends the setup needs them) but which are never attached to a chat, where group members would see
 *  other chats' ids. */
export const STATE_LOGS = ['status.json', 'daemon.log', 'daemon.log.1', 'daemon.out', 'jobs.log', 'jobs.out'];

export function workspaceDir(instance = INSTANCE_DIR): string { return join(instance, 'workspace'); }
export function profilesDir(instance = INSTANCE_DIR): string { return join(workspaceDir(instance), 'profiles'); }
export function profileDir(name: string, instance = INSTANCE_DIR): string { return join(profilesDir(instance), name); }
/** The co-working folder: every profile that is not isolated may read and write it (compile.ts). */
export function commonDir(instance = INSTANCE_DIR): string { return join(workspaceDir(instance), '_common'); }

/**
 * The one routing table, for every subcommand.
 *
 * Before this, `daemon` and `check-config` defaulted to `./routing.yaml` while `pair` and
 * `restart` defaulted to the state directory, so which table you were editing depended on
 * which command you happened to type and where you stood. With the table living inside the
 * workspace there has to be exactly one answer.
 *
 * Order: the workspace copy, then `./routing.yaml` for someone running from a checkout. When
 * neither exists, the answer is where a new one belongs.
 */
export function defaultConfigPath(instance = INSTANCE_DIR, cwd = process.cwd()): string {
  const inWorkspace = join(workspaceDir(instance), 'routing.yaml');
  const local = join(cwd, 'routing.yaml');
  for (const p of [inWorkspace, local]) if (existsSync(p)) return p;
  return inWorkspace;
}

/**
 * The table a command works on: the one named on its command line, else `ANGELIA_CONFIG` (set by
 * the LaunchAgent and by every job timer, so a script the daemon's environment runs sees the same
 * table the daemon does), else the default above. Every subcommand goes through here, so which
 * table a command reads never again depends on which command it happens to be.
 */
export function configPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? env.ANGELIA_CONFIG ?? defaultConfigPath();
}

/**
 * What git must never see, even though it lives in the repo.
 *
 * `.state/` and `.inbox/` are a profile's moving parts. The rest is the warning every project like
 * this ends up writing in its FAQ, made into a file instead: a key that lands in a profile
 * directory by accident is not a commit away from a public mirror.
 */
export const GITIGNORE = `# Generated by angelia init. Safe to extend; the entries above the line are the boundary.
.state/
.inbox/
*.log

# Never, whatever the directory.
.env
.env.*
*.pem
*.key
*.p12
*.pfx
id_rsa
id_ed25519
*credentials*.json
*token*.json
auth.json
secrets/
`;

/** A workspace README, so the boundary is legible to a person who opens the repo in a year. */
const README = `# Angelia workspace

This is the brain half of one Angelia instance, and the only half git ever sees.

- \`routing.yaml\` - which chat reaches which profile.
- \`profiles/<name>/\` - one assistant: its instructions, memory, prompts, generated settings.
- \`_shared/\` - doctrine several profiles import.
- \`_common/\` - files profiles share while working together; an isolated profile has no access.
- \`_capabilities/\` - what several profiles share: \`skills/<name>/\` and \`tools/<name>/\` (\`angelia guide capabilities\`).

The other half of the instance is its parent directory: the bot token, the WhatsApp auth store,
sessions, logs. None of it is in this repo, and none of it should ever be. If you
push this workspace to a remote, make the remote private anyway: it holds chat ids, owner phone
numbers and the paths your agents work in.
`;

export interface Skeleton {
  workspace: string;
  configPath: string;
  created: string[];
}

/** Starter skills shipped with the package (capabilities/skills/), beside dist/ and src/. */
export const STARTER_SKILLS = fileURLToPath(new URL('../../capabilities/skills', import.meta.url));

/**
 * Build the instance skeleton, and never overwrite anything already in it. Setup can be run again
 * - after an upgrade, after a mistake - and the second run must be additive, because everything in
 * here except the generated files is something a person wrote.
 */
export function buildSkeleton(profileNames: string[], instance = INSTANCE_DIR): Skeleton {
  const ws = workspaceDir(instance);
  const created: string[] = [];
  const dir = (p: string, mode = 0o755) => { if (!existsSync(p)) { mkdirSync(p, { recursive: true, mode }); created.push(p); } };
  const file = (p: string, body: string) => { if (!existsSync(p)) { writeFileSync(p, body); created.push(p); } };

  mkdirSync(instance, { recursive: true, mode: 0o700 });
  dir(ws);
  dir(join(ws, 'profiles'));
  dir(join(ws, '_shared'));
  dir(join(ws, '_common'));
  dir(join(ws, '_capabilities'));
  dir(join(ws, '_capabilities', 'skills'));
  dir(join(ws, '_capabilities', 'tools'));
  // The starter skills that ship with the package, copied once; a folder of the same name is the
  // owner's and is never touched. Nothing is granted: the table gives a skill to a profile.
  for (const name of existsSync(STARTER_SKILLS) ? readdirSync(STARTER_SKILLS) : []) {
    const to = join(ws, '_capabilities', 'skills', name);
    if (!existsSync(to)) { cpSync(join(STARTER_SKILLS, name), to, { recursive: true }); created.push(to); }
  }
  for (const name of profileNames) {
    const p = profileDir(name, instance);
    dir(p);
    for (const sub of ['memory', 'prompts', 'docs', 'scripts']) dir(join(p, sub));
  }
  file(join(ws, '.gitignore'), GITIGNORE);
  file(join(ws, 'README.md'), README);
  return { workspace: ws, configPath: join(ws, 'routing.yaml'), created };
}

/** Is there a git repo at `dir` already? */
export function isRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/**
 * `git init` the workspace and make one commit, so there is something to go back to from the first
 * day. Only the workspace: running git anywhere above it would put the credentials in range, which
 * is the whole failure this layout exists to prevent.
 *
 * Returns what happened, in words, because setup reports it and never pretends.
 */
export function initRepo(workspace: string, run = git): string {
  if (isRepo(workspace)) return 'already a git repo; left alone';
  try {
    run(['init', '-q', '-b', 'main'], workspace);
    run(['add', '-A'], workspace);
    run(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Angelia workspace: initial skeleton'], workspace);
    return 'git repo created, one commit';
  } catch (e) {
    return `not version controlled: ${(e as Error).message}`;
  }
}

/**
 * `angelia workspace sync`: commit everything the profiles changed since the last commit, and push
 * when there is a remote. Made for a daily job: it says nothing when there was nothing to save, and
 * throws (so the job reports it) when the commit or the push fails. The .gitignore above is what
 * keeps credentials out; this commits whatever it lets through.
 */
export function syncWorkspace(workspace = workspaceDir(), now = new Date(), run = git): string {
  if (!isRepo(workspace)) throw new Error(`${workspace} is not a git repo; angelia init makes one`);
  run(['add', '-A'], workspace);
  // The same scan workspace commit runs: agents write their own memory, and a pasted key must not
  // reach the remote because the nightly save took everything. A flagged file is left out, and said.
  const leaks = secretFindings(run(['diff', '--cached', '-U0', '--no-color'], workspace));
  const held = [...new Set(leaks.map((l) => l.slice(0, l.lastIndexOf(': '))))];
  if (held.length) run(['reset', '-q', '--', ...held], workspace);
  const files = run(['diff', '--cached', '--name-only'], workspace).split('\n').filter(Boolean);
  if (files.length) run(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `Workspace sync ${now.toISOString().slice(0, 10)}: ${files.length} file${files.length > 1 ? 's' : ''}`], workspace);
  const saved = files.length ? `saved ${files.length} file${files.length > 1 ? 's' : ''}` : '';
  const pushed = pushWorkspace(workspace, run);
  const said = pushed === 'no remote' ? saved && `${saved}, no remote to push to` : [saved, pushed].filter(Boolean).join(', ');
  return held.length ? [said, `left out, secret-shaped: ${leaks.join('; ')}`].filter(Boolean).join('; ') : said;
}

/** Push when there is a remote and something to push, even a commit an earlier push left behind.
 *  Says 'pushed', '' (nothing to push) or 'no remote'. */
export function pushWorkspace(workspace: string, run = git): string {
  if (!run(['remote'], workspace).trim()) return 'no remote';
  let ahead: string;
  try { ahead = run(['rev-list', '--count', '@{u}..HEAD'], workspace).trim(); } catch { ahead = 'all'; } // no upstream yet
  if (ahead === '0') return '';
  run(['push', '-q', '-u', 'origin', 'HEAD'], workspace);
  return 'pushed';
}

export function git(args: string[], cwd: string): string {
  // A day of changes can be a large diff; the 1 MB default made the scan fail with ENOBUFS.
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 });
}

/**
 * A private GitHub remote, but only when `gh` is already signed in. Setup never logs anyone in and
 * never asks for a credential: an authenticated `gh` is a fact about the machine, and its absence
 * is simply a no.
 */
export function ghReady(run: (args: string[]) => string = gh): boolean {
  try { run(['auth', 'status']); return true; } catch { return false; }
}

export function createPrivateRepo(workspace: string, name: string, run: (args: string[], cwd?: string) => string = gh): string {
  try {
    run(['repo', 'create', name, '--private', '--source', '.', '--remote', 'origin', '--push'], workspace);
    return `pushed to a private repo "${name}"`;
  } catch (e) {
    return `no remote: ${(e as Error).message.split('\n')[0]}`;
  }
}

function gh(args: string[], cwd?: string): string {
  return execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The table's own path, as `status` and `check-config` report it. */
export function describeInstance(instance = INSTANCE_DIR): string {
  const cfg = defaultConfigPath(instance);
  const ws = workspaceDir(instance);
  const lines = [`instance ${instance}`, `table    ${cfg}${existsSync(cfg) ? '' : ' (not created yet)'}`];
  if (existsSync(ws)) lines.push(`workspace ${ws}${isRepo(ws) ? ' (git)' : ' (not version controlled)'}`);
  return lines.join('\n');
}

