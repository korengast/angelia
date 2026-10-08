import { resolve } from 'node:path';
import { loadConfig } from './config/load.js';
import { configPath, INSTANCE_DIR } from './instance.js';
import { changesHash, readAccepted, tableChanges, writeAccepted } from './accepted.js';

/**
 * angelia accept [--check] [--expect <fingerprint>] [--config <routing.yaml>]
 * Take the routing table as it stands as the accepted one (instance/accepted.ts): the daemon runs on
 * it from its next start. --check lists the changes since the last accepted table and the fingerprint
 * of that list, and changes nothing. --expect accepts only when the changes are still that list (what
 * /restart confirm passes, so an edit made after the owner looked is not taken with it).
 */
export async function acceptCommand(argv: string[]): Promise<void> {
  const at = argv.indexOf('--config');
  const cfg = loadConfig(resolve(configPath(at >= 0 ? argv[at + 1] : undefined)));
  const acc = readAccepted(INSTANCE_DIR);
  const lines = acc ? tableChanges(acc, cfg) : [];
  if (argv.includes('--check')) {
    for (const l of lines) console.log(`change: ${l}`);
    console.log(lines.length ? `${lines.length} change(s) not accepted yet (fingerprint ${changesHash(lines)})` : 'nothing new to accept');
    return;
  }
  const ex = argv.indexOf('--expect');
  if (ex >= 0 && argv[ex + 1] !== changesHash(lines)) throw new Error('the routing table changed again since the list you saw; send /restart to see the new list');
  for (const l of lines) console.log(`accepted: ${l}`);
  writeAccepted(cfg, INSTANCE_DIR);
  console.log(lines.length || !acc ? 'Accepted. The daemon runs on this table from its next start (/restart).' : 'Nothing new to accept.');
}
