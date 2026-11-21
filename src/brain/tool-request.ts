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
