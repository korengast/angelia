import type { ToolRequest } from '../core/permission-rules.js';

/**
 * Each backend's permission request in Claude Code's naming (a tool and its input), so the profile's
 * permission rules (core/permission-rules.ts) can be checked on it. Undefined when the request does not
 * carry enough to name: then no rule matches and the profile's default decides. Claude Code needs no
 * mapping: its requests are already in this shape (claude.ts, tui-permissions.ts).
 */

type Msg = Record<string, unknown>;

/** pi's own tools (pi-gate.ts) under Claude Code's names. Input `path` is read by the matcher as is. */
const PI_TOOLS: Record<string, string> = { bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', grep: 'Grep', find: 'Glob', ls: 'LS' };

export function piRequest(tool: string, input: Msg): ToolRequest | undefined {
  const name = PI_TOOLS[tool];
  if (!name) return undefined;
  if (name === 'Bash') return typeof input.command === 'string' ? { tool: 'Bash', input: { command: input.command } } : undefined;
  return { tool: name, input: typeof input.path === 'string' ? { file_path: input.path } : {} };
}

/** Grok Build: only its shell tool carries the command as text; any other request is not named. */
export function grokRequest(toolCall: Msg): ToolRequest | undefined {
  const meta = (toolCall._meta as Msg | undefined)?.['x.ai/tool'] as Msg | undefined;
  const raw = toolCall.rawInput as Msg | undefined;
  const shell = meta?.name === 'run_terminal_command' || meta?.name === 'run_terminal_cmd' || (meta?.name === undefined && toolCall.kind === 'execute');
  if (!shell || typeof raw?.command !== 'string') return undefined;
  return { tool: 'Bash', input: { command: raw.command } };
}

/** One argv word as the shell would read it back. */
function quote(w: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

/** Codex: a command to run (a string, or argv in the older protocol). File changes, terminal input and
 *  requests for more access are not named: the default decides them. */
export function codexRequest(method: string, params: Msg): ToolRequest | undefined {
  if (method !== 'item/commandExecution/requestApproval' && method !== 'execCommandApproval') return undefined;
  if (params.kind === 'writeStdin') return undefined;
  const c = params.command;
  // argv of `bash -lc '<script>'`: the script is what runs. Quoted back into one line, a script with a
  // ' in it becomes '\'' pieces that the matcher's shell -c reading does not take apart.
  const script = Array.isArray(c) && c.length === 3 && /^(?:\S*\/)?(?:ba|z|da|k)?sh$/.test(String(c[0])) && /^-l?c$/.test(String(c[1])) ? String(c[2]) : undefined;
  const command = script ?? (Array.isArray(c) ? c.map((w) => quote(String(w))).join(' ') : typeof c === 'string' ? c : undefined);
  return command ? { tool: 'Bash', input: { command } } : undefined;
}

/** agy (Antigravity CLI, ADR 0017): its shell, file and MCP tools under Claude Code's names
 *  (`mcp_<server>_<tool>` and call_mcp_tool as `mcp__<server>__<tool>`, `servers` the profile's MCP
 *  server names, to read one with `_` in it whole). Any other tool is not named. */
export function agyRequest(toolCall: Msg, servers: string[] = []): ToolRequest | undefined {
  const raw = (toolCall.rawInput ?? {}) as Msg;
  const name = toolCall.name;
  if (name === 'run_command' || (name === undefined && toolCall.kind === 'execute')) return typeof raw.CommandLine === 'string' ? { tool: 'Bash', input: { command: raw.CommandLine } } : undefined;
  const path = typeof raw.Path === 'string' ? raw.Path : undefined;
  if (name === 'read_file') return { tool: 'Read', input: path ? { file_path: path } : {} };
  if (name === 'write_file') return { tool: 'Write', input: path ? { file_path: path } : {} };
  if (name === 'edit_file') return { tool: 'Edit', input: path ? { file_path: path } : {} };
  if (name === 'call_mcp_tool' && typeof raw.ServerName === 'string' && typeof raw.ToolName === 'string') return { tool: `mcp__${raw.ServerName}__${raw.ToolName}`, input: raw.Arguments ?? {} };
  const mcp = typeof name === 'string' ? agyMcpName(name, servers) : undefined;
  return mcp ? { tool: mcp, input: raw } : undefined;
}

/** Every reading of agy's `mcp_<server>_<tool>` in Claude Code's naming that the profile's servers
 *  leave open. One known server fits: that one. Two or more fit (servers `a` and `a_b`, tool
 *  `mcp_a_b_c`), or none: the name cannot tell which server holds the tool, so every split at a `_` is
 *  returned and a deny rule is checked against all of them (fails closed). */
export function agyMcpNames(name: string, servers: string[] = []): string[] {
  if (!name.startsWith('mcp_')) return [];
  const rest = name.slice(4);
  const fit = servers.filter((s) => rest.startsWith(`${s}_`) && rest.length > s.length + 1);
  if (fit.length === 1) return [`mcp__${fit[0]}__${rest.slice(fit[0].length + 1)}`];
  const out: string[] = [];
  for (let i = rest.indexOf('_'); i !== -1; i = rest.indexOf('_', i + 1)) if (i > 0 && i < rest.length - 1) out.push(`mcp__${rest.slice(0, i)}__${rest.slice(i + 1)}`);
  return out;
}

/** agy's `mcp_<server>_<tool>` in Claude Code's naming. The server is the longest known name that
 *  fits, so a server with `_` in its name is read whole; an unknown one ends at the first `_`. */
export function agyMcpName(name: string, servers: string[] = []): string | undefined {
  if (!name.startsWith('mcp_')) return undefined;
  const rest = name.slice(4);
  const known = servers.filter((s) => rest.startsWith(`${s}_`) && rest.length > s.length + 1).sort((a, b) => b.length - a.length)[0];
  const i = known ? known.length : rest.indexOf('_');
  return i > 0 && i < rest.length - 1 ? `mcp__${rest.slice(0, i)}__${rest.slice(i + 1)}` : undefined;
}
