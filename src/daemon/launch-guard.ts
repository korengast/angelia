import { homedir } from 'node:os';
import type { Config } from '../instance/config/schema.js';
import { floorMissing, launchCheck, refreshFloor } from '../capabilities/compile.js';

/**
 * The daemon's launch guard: why a profile's agent may not start, empty when it may. Fails closed.
 *
 * `start` is a real start (a session, an `angelia ask` copy). Only then the floor rules the profile's
 * settings lack are added first (refreshFloor: a new entry in the state folder, a profile added), and
 * the start is refused when that fails or when any rule of the floor is still missing after it (review
 * fixes H1, M1): an agent never starts without every current floor deny rule, whatever it did to the
 * files in its own folder. Without `start` it is a question (can this chat's agent start?), which
 * writes nothing (L3) and answers with launchCheck alone, what was compiled.
 */
export function makeLaunchGuard(cfg: Config, stateDir: string, log: (line: string) => void, home = homedir()): (name: string, start?: boolean) => string[] {
  return (name, start = false) => {
    try {
      let floor: string[] | undefined;
      if (start) {
        try {
          // A short wait for the compile lock: it blocks the daemon's event loop (review fix N3).
          const r = refreshFloor(cfg, name, stateDir, home, { waitMs: 200 });
          const { added, dropped } = r;
          floor = r.floor;
          if (added.length) log(`launch guard: ${name}: ${added.length} deny rule(s) added from the floor, such as ${added[0]}`);
          if (dropped.length) log(`launch guard: ${name}: ${dropped.length} deny rule(s) dropped for state entries that are gone, such as ${dropped[0]}`);
        } catch (e) {
          log(`launch guard: ${name}: the floor rules could not be added: ${(e as Error).message}`);
          return [`its deny rules could not be brought up to date (${(e as Error).message})`];
        }
      }
      const refused = launchCheck(cfg, name, stateDir, home);
      if (refused.length || !start) return refused;
      // Against the floor the refresh just wrote from (review fix L1): an entry made in the state folder
      // since (a .lock, a .tmp, a backup) must not refuse this start; the next start adds its rule.
      const missing = floorMissing(cfg, name, stateDir, home, floor);
      if (missing.length) log(`launch guard: ${name}: ${missing.length} floor deny rule(s) missing after the refresh, such as ${missing[0]}`);
      return missing.length ? [`${missing.length} of the deny rules every agent must have are missing from its settings, such as ${missing[0]}`] : [];
    } catch (e) {
      log(`launch check ${name}: ${(e as Error).message}`);
      return [`the check failed: ${(e as Error).message}`];
    }
  };
}
