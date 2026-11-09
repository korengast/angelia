import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseDocument, YAMLMap } from 'yaml';
import { loadConfig } from './config/load.js';
import type { Config } from './config/schema.js';
import { backupConfig } from './init.js';
import { planProfile } from '../capabilities/compile.js';
import type { BackendName } from '../brain/brain.js';
import { INSTANCE_DIR } from './instance.js';
import { beyond, tablePath, pendingRefusal, writeAccepted } from './accepted.js';

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

/** What /backend changed: the fields it took off the profile, the ones it put back from the profile's
 *  `backends:` record of the new CLI, and the compile's notes. */
export interface Switched { removed: string[]; restored: string[]; notes: string[] }

/**
 * `/backend <cli>`: one profile moves to another CLI, the way onboarding writes the table. The table
 * is edited in place (the owner's layout kept), loaded again, and the profile compiled for the new
 * CLI before anything runs on it; any failure puts the old table back. `model`, `effort` and `bin`
 * are taken off: a Claude model name is no Codex model, and the old CLI's path runs the old CLI.
 * `tui: true` goes too when leaving Claude Code, where it is the only CLI that reads it. What comes off is
 * kept under `backends: <old cli>:` in the profile, and a switch back to that CLI puts it on again; the
 * entry is then spent. What is on the profile at switch time wins over an older entry for the same CLI:
 * the owner may have changed a field by hand since the last switch.
 */
export function switchBackend(o: SwitchOpts): Switched {
  // Built on the table as it stands, so that table must be the accepted one (accepted.ts).
  const state = o.instance ?? INSTANCE_DIR;
  const pending = pendingRefusal(loadConfig(o.table), state);
  if (pending) throw new Error(`not switching: ${pending}`);
  const doc = parseDocument(readFileSync(o.table, 'utf8'));
  const node = doc.getIn(['profiles', o.profile], true);
  if (!(node instanceof YAMLMap)) throw new Error(`no profile ${o.profile} in ${o.table}`);
  const from = String(node.get('backend') ?? 'claude-code');
  const removed: string[] = [];
  const kept: Record<string, unknown> = {};
  for (const f of [...CLI_FIELDS, ...(o.backend !== 'claude-code' ? ['tui'] as const : [])]) {
    if (node.has(f)) { removed.push(`${f}: ${String(node.get(f))}`); kept[f] = node.get(f); node.delete(f); }
  }
  if (Object.keys(kept).length) node.setIn(['backends', from], doc.createNode(kept));
  else if (node.get('backends') instanceof YAMLMap) node.deleteIn(['backends', from]);
  const restored: string[] = [];
  const saved = node.getIn(['backends', o.backend]);
  if (saved instanceof YAMLMap) {
    for (const f of [...CLI_FIELDS, ...(o.backend === 'claude-code' ? ['tui'] as const : [])]) {
      if (saved.has(f) && !node.has(f)) { node.set(f, saved.get(f)); restored.push(`${f}: ${String(saved.get(f))}`); }
    }
    node.deleteIn(['backends', o.backend]);
  }
  const backends = node.get('backends');
  if (backends instanceof YAMLMap && !backends.items.length) node.delete('backends');
  node.set('backend', o.backend);

  const backup = backupConfig(o.table, o.now);
  writeFileSync(o.table, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  let fresh: Config;
  try { fresh = loadConfig(o.table); } catch (e) { copyFileSync(backup, o.table); throw e; }
  const extra = beyond(state, fresh, ['backend', 'tui', 'backends', ...CLI_FIELDS].map((f) => tablePath('profiles', o.profile, f)));
  if (extra.length) { copyFileSync(backup, o.table); throw new Error(`not switching: the routing table changed while it was written (${extra.join('; ')})`); }
  let notes: string[];
  try {
    const plan = planProfile(fresh, o.profile, { self: o.self, stateDir: o.instance });
    if (plan.conflicts.length) throw new Error(`capabilities for ${o.profile}: ${plan.conflicts.join('; ')}`);
    plan.apply();
    notes = plan.notes;
  } catch (e) { copyFileSync(backup, o.table); throw e; }
  writeAccepted(fresh, state);
  o.cfg.profiles[o.profile] = fresh.profiles[o.profile];
  return { removed, restored, notes };
}
