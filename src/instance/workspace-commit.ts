import { isAbsolute, relative, resolve, sep } from 'node:path';
import { git, isRepo, pushWorkspace } from './instance.js';
import { secretFindings } from './secrets.js';

export { secretFindings } from './secrets.js';

/**
 * `angelia workspace commit -m <message> [paths]`: one agent's change, under its own message, and
 * only after the gates pass. `workspace sync` saves everything under a dated message, checked only for
 * secrets; it suits a nightly job, not an agent that just changed the table.
 *
 * The gates see what is staged. A failed gate unstages it and commits nothing: the files stay as
 * they are on disk, for the agent to fix and try again.
 */

/** A check before a commit: the reason it failed, or nothing. `files`: what the commit holds, relative to the workspace. */
export interface Gate { name: string; check(files: string[]): string | undefined }


export interface CommitOptions {
  workspace: string;
  message: string;
  /** Files or folders to commit, relative to `cwd`. None: every change in the workspace. */
  paths?: string[];
  cwd?: string;
  push?: boolean;
  gates?: Gate[];
  run?: (args: string[], cwd: string) => string;
}

export function commitWorkspace(o: CommitOptions): string {
  const run = o.run ?? git;
  const ws = resolve(o.workspace);
  if (!o.message.trim()) throw new Error('a commit needs a message: angelia workspace commit -m "<what changed and why>" [paths]');
  if (!isRepo(ws)) throw new Error(`${ws} is not a git repo; angelia init makes one`);
  const specs = (o.paths ?? []).map((p) => {
    const rel = relative(ws, resolve(o.cwd ?? process.cwd(), p));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error(`${p} is outside the workspace (${ws})`);
    return rel || '.';
  });

  // Start from a clean index, so the commit holds this change and nothing another process staged.
  run(['reset', '-q'], ws);
  run(['add', '-A', '--', ...(specs.length ? specs : ['.'])], ws);
  const files = run(['diff', '--cached', '--name-only'], ws).split('\n').filter(Boolean);
  if (!files.length) return 'nothing to commit';

  const failed: string[] = [];
  const leaks = secretFindings(run(['diff', '--cached', '-U0', '--no-color'], ws));
  if (leaks.length) failed.push(`secret scan: ${leaks.join('; ')}`);
  for (const g of o.gates ?? []) {
    let why: string | undefined;
    try { why = g.check(files); } catch (e) { why = (e as Error).message; }
    if (why) failed.push(`${g.name}: ${why}`);
  }
  if (failed.length) {
    run(['reset', '-q'], ws);
    throw new Error(`nothing committed, the files are unstaged and unchanged.\n${failed.map((f) => `gate failed: ${f}`).join('\n')}`);
  }

  run(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', o.message.trim()], ws);
  const sha = run(['rev-parse', '--short', 'HEAD'], ws).trim();
  const done = `committed ${sha}: ${files.length} file${files.length > 1 ? 's' : ''}`;
  if (o.push === false) return done;
  const pushed = pushWorkspace(ws, run);
  return pushed === 'no remote' ? `${done}, no remote to push to` : [done, pushed].filter(Boolean).join(', ');
}
