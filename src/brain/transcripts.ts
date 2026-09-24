import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where Claude Code keeps every project's transcripts: `<config dir>/projects`. */
export function projectsDir(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
}

/** Claude Code's folder name for a working directory: every character outside [A-Za-z0-9] turned
 *  into a dash. The CLI names it after the path it resolved to, so a cwd that goes through a symlink
 *  (/tmp on macOS is /private/tmp) would otherwise be looked up under a name nobody writes. */
export function projectFolder(cwd: string): string {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* not created yet: the raw path is the best guess */ }
  return real.replace(/[^A-Za-z0-9]/g, '-');
}

/** Where Claude Code keeps a session's transcript: one directory per working directory. */
export function transcriptPath(cwd: string, sessionId: string, home = homedir()): string {
  return join(projectsDir(home), projectFolder(cwd), `${sessionId}.jsonl`);
}

/** Every non-empty transcript of `sessionId` under `root`, wherever it lives, largest first. */
export function findTranscripts(sessionId: string, root: string): string[] {
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return []; }
  const out: { path: string; size: number }[] = [];
  for (const d of dirs) {
    const p = join(root, d, `${sessionId}.jsonl`);
    try { const s = statSync(p); if (s.isFile() && s.size > 0) out.push({ path: p, size: s.size }); } catch { /* not here */ }
  }
  return out.sort((a, b) => b.size - a.size).map((o) => o.path);
}

export type Placement = { status: 'here' } | { status: 'copied'; from: string } | { status: 'missing' };

/**
 * Make `claude --resume <id>` from `cwd` deterministic.
 *
 * The CLI looks for the id under the current cwd's project folder first, then across every other
 * project, and resolves the cross-project search only when exactly one other folder holds the
 * transcript (measured on the docs for 2.1.278). So a session whose profile folder moved keeps
 * working only while its transcript is unique elsewhere; a second copy, or a folder renamed
 * without its transcripts, ends every turn with "No conversation found". Placing the transcript
 * under the cwd's own folder before the launch removes the guess: the first lookup finds it.
 *
 * Nothing is deleted. A transcript found elsewhere is copied (with its sidecar folder of subagent
 * transcripts, when there is one); the source stays where it was.
 */
export function placeTranscript(cwd: string, sessionId: string, root: string): Placement {
  const here = join(root, projectFolder(cwd), `${sessionId}.jsonl`);
  try { if (statSync(here).size > 0) return { status: 'here' }; } catch { /* not here */ }
  const [from] = findTranscripts(sessionId, root).filter((p) => p !== here);
  if (!from) return { status: 'missing' };
  mkdirSync(join(root, projectFolder(cwd)), { recursive: true });
  copyFileSync(from, here);
  const sidecar = from.replace(/\.jsonl$/, '');
  if (existsSync(sidecar) && statSync(sidecar).isDirectory() && !existsSync(here.replace(/\.jsonl$/, ''))) {
    try { cpSync(sidecar, here.replace(/\.jsonl$/, ''), { recursive: true }); } catch { /* the conversation itself is what matters */ }
  }
  return { status: 'copied', from };
}

/** The line the chat hears when a session's conversation is gone from disk and a fresh one starts under the same id. */
export const LOST_SESSION_LINE = 'The previous conversation of this session was not found on disk, so this is a fresh start. /resume lists older sessions.';
