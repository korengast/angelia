import { relative, resolve, sep } from 'node:path';
import { loadConfig } from './config/load.js';
import type { Config } from './config/schema.js';
import { compileDrift } from '../capabilities/cli.js';
import { readRecord } from '../capabilities/compile.js';
import { jobsState } from '../jobs/jobs-cli.js';
import type { Gate } from './workspace-commit.js';

/**
 * What `workspace commit` checks besides secrets: the table loads, and the profiles the commit
 * touches match it, compiled files and job timers both. The same things an owner checks by hand
 * after a change; a commit is the moment a mismatch would otherwise become the recorded state.
 *
 * Only the profiles the commit touches: an Angelia update that adds a compiled setting puts every
 * profile out of date until each is recompiled, and one agent's notes must not wait for that. A
 * commit of the table, or of what several profiles share, checks them all.
 */
export function workspaceGates(table: string, workspace: string): Gate[] {
  const path = resolve(table);
  let cfg: Config | undefined;
  return [
    { name: 'check-config', check: () => { cfg = loadConfig(path); return undefined; } },
    {
      name: 'compile --check',
      check: (files) => {
        if (!cfg) return undefined; // the table did not load: check-config already said why
        // Never compiled: skipped, as compile --check skips them. (An empty list would mean all.)
        const names = touched(cfg, path, workspace, files).filter((n) => readRecord(resolve(cfg!.profiles[n].cwd)));
        if (!names.length) return undefined;
        const drift = compileDrift(cfg, path, names);
        return drift ? drift.trim().split('\n').pop() : undefined;
      },
    },
    {
      name: 'jobs',
      check: (files) => {
        if (!cfg || process.platform !== 'darwin') return undefined; // timers are launchd's, macOS only
        const names = touched(cfg, path, workspace, files);
        if (!names.length) return undefined;
        const { drift } = jobsState(cfg, path, names);
        return drift ? `${drift} job timer${drift > 1 ? 's' : ''} out of step with the job files; angelia jobs shows which, angelia jobs install fixes it` : undefined;
      },
    },
  ];
}

/** The profiles a commit of `files` touches: all of them when the table or anything shared is in it,
 *  otherwise the ones whose folder holds one of the files. */
export function touched(cfg: Config, table: string, workspace: string, files: string[]): string[] {
  const ws = resolve(workspace);
  const abs = files.map((f) => resolve(ws, f));
  const shared = abs.some((f) => f === resolve(table) || !relative(ws, f).startsWith('profiles' + sep));
  if (shared) return Object.keys(cfg.profiles);
  return Object.keys(cfg.profiles).filter((n) => {
    const cwd = resolve(cfg.profiles[n].cwd);
    return abs.some((f) => f === cwd || f.startsWith(cwd + sep));
  });
}
