import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseDocument, YAMLMap } from 'yaml';
import { loadConfig } from './config/load.js';
import type { Config } from './config/schema.js';
import { backupConfig } from './init.js';
import { planProfile } from '../capabilities/compile.js';
import type { BackendName } from '../brain/brain.js';

/** Fields that belong to one CLI and mean nothing, or something wrong, to another. */
const CLI_FIELDS = ['model', 'effort', 'bin'] as const;

export interface SwitchOpts {
  table: string;
  /** The daemon's live config: the changed profile replaces the old one in it. */
  cfg: Config;
  profile: string;
  backend: BackendName;
  instance?: string;
  self?: (profile: string) => string;
  now?: Date;
}

/** What /backend changed: the fields it took off the profile, and the compile's notes. */
export interface Switched { removed: string[]; notes: string[] }

/**
 * `/backend <cli>`: one profile moves to another CLI, the way onboarding writes the table. The table
 * is edited in place (the owner's layout kept), loaded again, and the profile compiled for the new
 * CLI before anything runs on it; any failure puts the old table back. `model`, `effort` and `bin`
 * are taken off: a Claude model name is no Codex model, and the old CLI's path runs the old CLI.
 * `tui: true` goes too when leaving Claude Code, where it is the only CLI that reads it.
 */
export function switchBackend(o: SwitchOpts): Switched {
  const doc = parseDocument(readFileSync(o.table, 'utf8'));
  const node = doc.getIn(['profiles', o.profile], true);
  if (!(node instanceof YAMLMap)) throw new Error(`no profile ${o.profile} in ${o.table}`);
  const removed: string[] = [];
  for (const f of [...CLI_FIELDS, ...(o.backend !== 'claude-code' ? ['tui'] as const : [])]) {
    if (node.has(f)) { removed.push(`${f}: ${String(node.get(f))}`); node.delete(f); }
  }
  node.set('backend', o.backend);

  const backup = backupConfig(o.table, o.now);
  writeFileSync(o.table, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  let fresh: Config;
  try { fresh = loadConfig(o.table); } catch (e) { copyFileSync(backup, o.table); throw e; }
  let notes: string[];
  try {
    const plan = planProfile(fresh, o.profile, { self: o.self, stateDir: o.instance });
    if (plan.conflicts.length) throw new Error(`capabilities for ${o.profile}: ${plan.conflicts.join('; ')}`);
    plan.apply();
    notes = plan.notes;
  } catch (e) { copyFileSync(backup, o.table); throw e; }
  o.cfg.profiles[o.profile] = fresh.profiles[o.profile];
  return { removed, notes };
}
