import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { loadConfig } from '../instance/config/load.js';
import { configPath } from '../instance/instance.js';
import { handoffTarget, pickChat, type HandoffTarget } from '../core/handoff.js';

const USAGE = 'usage: angelia handoff [N | platform:chat] [--where] [--session <id>]   (summary line, then the brief, on stdin)';

/**
 * `angelia handoff`, what `/angelia-handoff` runs inside a terminal Claude Code session.
 * `--where` only says where this folder hands off to, and what to write for it. Without it, stdin
 * holds the summary line and, for a brief, the brief after it; the running daemon does the rest.
 * The session id is the terminal's own (CLAUDE_CODE_SESSION_ID) unless --session names one.
 */
export async function handoffCommand(argv: string[], env: NodeJS.ProcessEnv = process.env, stdin = (): string => readFileSync(0, 'utf8')): Promise<string> {
  const { where, session, cwd, chat } = parse(argv, env);
  // A chat's agent has its own token; a handoff picks a chat and moves sessions, which is the owner's.
  if (env.ANGELIA_API_TOKEN) throw new Error('angelia handoff runs from a terminal session, not from a chat\'s agent');
  if (where) {
    const t = handoffTarget(loadConfig(configPath(undefined, env)), cwd);
    return whereText(t, pickChat(t, chat));
  }
  const text = stdin().replace(/\r/g, '');
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) throw new Error(`nothing on stdin: the summary line comes first, then the brief\n${USAGE}`);
  const summary = lines[first].trim();
  const brief = lines.slice(first + 1).join('\n').trim();
  const { post, ownerToken } = await import('../daemon/api/client.js');
  const out = await post('/handoff', { token: ownerToken(), cwd, session, summary, brief, project: projectPointer(cwd), chat });
  return out.mode === 'session'
    ? `Handed over to ${out.key} (profile ${out.profile}): the session goes on there. Type /exit here: typing on in both places splits it.`
    : `Handed over to ${out.key} (profile ${out.profile}): a fresh session there has your brief. Continue in the chat.`;
}

function parse(argv: string[], env: NodeJS.ProcessEnv): { where: boolean; session?: string; cwd: string; chat?: string } {
  let where = false, session = env.CLAUDE_CODE_SESSION_ID || undefined, cwd = process.cwd(), chat: string | undefined;
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n];
    if (a === '--where') where = true;
    else if (a === '--session') session = argv[++n];
    else if (a === '--cwd') cwd = argv[++n] ?? cwd;
    else if (!a.startsWith('--') && !chat) chat = a;
    else throw new Error(`${a}: not understood\n${USAGE}`);
  }
  try { cwd = realpathSync(cwd); } catch { /* the daemon says what is wrong with it */ }
  return { where, session, cwd, chat };
}

function whereText(t: HandoffTarget, key: string): string {
  const why = t.via === 'folder' ? 'this folder is its own' : t.via === 'add_dirs' ? 'this folder is in its add_dirs' : 'the handoff profile for other folders (defaults.handoff)';
  return [
    `mode: ${t.mode}`,
    `profile: ${t.profile} (${why})`,
    `chat: ${key}`,
    t.mode === 'session'
      ? 'The session itself moves to that chat. Write one summary line.'
      : 'The session stays here; that chat starts a fresh session from your brief. Write one summary line, then the brief.',
  ].join('\n');
}

/** The folder, and where git stands in it, for the brief's first line. */
export function projectPointer(cwd: string): string {
  const git = (...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    const last = git('log', '-1', '--format=%h %s');
    const dirty = git('status', '--porcelain').split('\n').filter(Boolean).length;
    return `${cwd} (git: branch ${branch}, last commit ${last}${dirty ? `, ${dirty} uncommitted change${dirty > 1 ? 's' : ''}` : ''})`;
  } catch { return cwd; }
}
