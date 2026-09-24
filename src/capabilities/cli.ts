import { resolve } from 'node:path';
import { loadConfig } from '../instance/config/load.js';
import type { Config } from '../instance/config/schema.js';
import { configPath, INSTANCE_DIR } from '../instance/instance.js';
import { selfPrompt } from '../daemon/self.js';
import { planProfile, planText, readRecord } from './compile.js';

/** The profiles whose compiled files no longer match the table (all compiled ones when none are
 *  named), as text; empty when every one matches. Profiles never compiled are skipped. A table with no
 *  capabilities is checked too: every profile still has its deny floor. */
export function compileDrift(cfg: Config, table: string, names: string[] = [], opts: { home?: string; stateDir?: string } = {}): string {
  const stateDir = opts.stateDir ?? INSTANCE_DIR;
  const self = (profile: string) => selfPrompt({ profile, table, instance: stateDir });
  const which = names.length ? names : Object.keys(cfg.profiles).filter((n) => readRecord(resolve(cfg.profiles[n].cwd)));
  const drift = which.map((n) => planProfile(cfg, n, { self, stateDir, home: opts.home })).filter((pl) => pl.changes.length || pl.conflicts.length);
  if (!drift.length) return '';
  return [...drift.map((pl) => planText(pl) + '\n'), `Out of date: ${drift.map((pl) => pl.profile).join(', ')}. Run angelia compile <profile> --write.`].join('\n');
}

/**
 * angelia compile [profile...] [--write] [--config <routing.yaml>]
 * Without --write it only prints. --write needs the profiles named: capabilities go live one chat
 * at a time, never as a side effect of compiling everything.
 * --check: a gate for a commit hook. Quiet and exit 0 when every compiled profile (or each one named)
 * matches the table; otherwise prints the drift and exits 1. Profiles never compiled are skipped.
 */
export async function compileCommand(argv: string[]): Promise<void> {
  const write = argv.includes('--write');
  const at = argv.indexOf('--config');
  const table = resolve(configPath(at >= 0 ? argv[at + 1] : undefined));
  const names = argv.filter((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1));
  const cfg = loadConfig(table);
  for (const n of names) if (!cfg.profiles[n]) throw new Error(`unknown profile "${n}"`);
  if (write && !names.length) throw new Error('--write needs the profile names: compile goes live one profile at a time');
  const self = (profile: string) => selfPrompt({ profile, table, instance: INSTANCE_DIR });
  if (argv.includes('--check')) {
    const drift = compileDrift(cfg, table, names);
    if (drift) { console.log(drift); process.exitCode = 1; }
    return;
  }
  const plans = (names.length ? names : Object.keys(cfg.profiles)).map((n) => planProfile(cfg, n, { self }));
  for (const pl of plans) console.log(planText(pl) + '\n');
  if (!write) { console.log('Nothing written. Add --write and the profile names to apply.'); return; }
  const blocked = plans.filter((pl) => pl.conflicts.length);
  if (blocked.length) throw new Error(`not written: conflicts in ${blocked.map((pl) => pl.profile).join(', ')}`);
  for (const pl of plans) pl.apply();
  console.log(`Written: ${plans.map((pl) => pl.profile).join(', ')}. A running session picks this up when it next starts; a tui pane relaunches by itself at the next restart.`);
}
