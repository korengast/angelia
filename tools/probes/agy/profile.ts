// Print the sandbox profile pi's gate would make for agy:
//   node_modules/.bin/tsx tools/probes/agy/profile.ts [--pty] <ws> <gdir> <cache> [deny...]
// --pty opens /dev/ptmx and /dev/ttys* for writing: agy's run_command needs a PTY (measured 2026-11-21).
import { sandboxProfile } from '../../../src/brain/pi-gate.ts';
let args = process.argv.slice(2);
const pty = args[0] === '--pty';
if (pty) args = args.slice(1);
const [ws, gdir, cache, ...deny] = args;
const open = pty ? [{ path: '/dev/ptmx', match: 'literal' as const, write: true }, { path: '/dev/ttys', match: 'prefix' as const, write: true }] : [];
process.stdout.write(sandboxProfile(deny, undefined, { writable: [ws, gdir, cache], noLaunch: true, open }) + '\n');
