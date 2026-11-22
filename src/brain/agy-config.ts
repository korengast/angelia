import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isInside, readPlainText } from '../core/paths.js';
import type { Profile } from '../instance/config/schema.js';
import { placedPermissions, readGuard, writePlain, type AgyMcpServer } from '../capabilities/compile.js';
import { AGY_INSTRUCTIONS, agyInstructionsText, agyLaunchProblems } from './agy-instructions.js';
import { parseRules, real } from './pi-gate.js';

/**
 * What AgyBrain gives agy at start, from the last compile (compile.ts keeps it in the state folder's
 * launch guard, out of the agent's reach): the generated instructions file and the MCP servers.
 */

/** One server as ACP's session/new takes it (stdio). */
export interface AcpMcpServer { name: string; command: string; args: string[]; env: { name: string; value: string }[] }

/** The compiled servers with their variables' values from `env`. A variable that is not set is
 *  left out, as Claude leaves an unset ${VAR} empty. */
export function acpMcpServers(servers: AgyMcpServer[], env: NodeJS.ProcessEnv = process.env): AcpMcpServer[] {
  return servers.map((s) => ({
    name: s.name, command: s.command, args: [...s.args],
    env: s.env.filter((k) => env[k] !== undefined).map((k) => ({ name: k, value: String(env[k]) })),
  }));
}

/** The profile's compiled servers for session/new and session/resume; none when it was never compiled
 *  (the launch guard refuses that one anyway). */
export function agyMcpServers(stateDir: string, name: string, env: NodeJS.ProcessEnv = process.env): AcpMcpServer[] {
  return acpMcpServers(readGuard(stateDir, name)?.agy?.mcpServers ?? [], env);
}

/**
 * Before agy starts: refuse what it would load that Angelia did not give it, then write
 * `<cwd>/GEMINI.md` from CLAUDE.md. An import the profile's Read rules deny (compiled, or in its
 * settings now) is left out. Throws with the reasons; the start then fails with them.
 */
export function prepareAgyStart(p: Profile, o: { stateDir: string; name: string; geminiDir: string; home?: string; stateOpen?: string[] }): void {
  const home = o.home ?? homedir();
  const guard = readGuard(o.stateDir, o.name);
  const problems = agyLaunchProblems(p.cwd, p.add_dirs, o.geminiDir, guard?.agy?.skills ?? [], home);
  if (problems.length) throw new Error(`agy not started: ${problems.join('; ')}`);
  const deny = [...new Set([...(guard?.deny ?? []), ...placedPermissions(p.cwd, home).deny])].filter((r) => r.startsWith('Read('));
  const rules = parseRules(deny, home);
  // The state folder is closed but for what the profile reaches (stateOpenPaths), a file made there
  // after the last compile too: an import from it is left out (red team round 2: secrets/x.env).
  const state = resolve(o.stateDir), open = o.stateOpen;
  const closedState = (x: string) => !!open && isInside(x, state, home) && x !== state && !open.some((d) => isInside(x, d, home));
  const readable = (abs: string) => { const r = real(abs); return !rules.some((x) => x.test(r) || x.test(abs)) && !closedState(r) && !closedState(resolve(abs)); };
  const claudeMd = join(p.cwd, 'CLAUDE.md');
  let text = '';
  // CLAUDE.md is the agent's to write: a link there to a file its Read rules deny would put that file's
  // text into GEMINI.md, and a named pipe would hold the daemon (review 3, M1). Both refuse the start.
  if (!readable(claudeMd)) throw new Error(`agy not started: ${claudeMd} leads to a file this profile may not read`);
  try { text = readPlainText(claudeMd); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EFTYPE') throw new Error(`agy not started: ${claudeMd} is not a plain file; make it one`);
    if (code !== 'ENOENT') throw e;
  }
  writePlain(p.cwd, join(p.cwd, AGY_INSTRUCTIONS), agyInstructionsText(claudeMd, text, { home, readable }));
}
