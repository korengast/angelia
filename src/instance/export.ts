import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config/schema.js';
import type { SessionMapFile } from '../core/types.js';
import { sessionKey } from '../core/types.js';
import { transcriptPath } from '../brain/tui.js';

/**
 * `angelia export <platform:chat>`: a chat's turns as JSONL, one shape whatever the backend, so a
 * tool that reads conversations (memory, review, self-improvement) reads every profile the same way.
 *
 * Read from the files each CLI already writes; Angelia keeps no transcript of its own:
 * - Claude Code: ~/.claude/projects/<cwd with every non-alphanumeric as ->/<session>.jsonl (transcriptPath)
 * - grok:        ~/.grok/sessions/<cwd, URL-encoded>/<session>/chat_history.jsonl (grok 1.0.40),
 *                with each prompt's time from rewind_points.jsonl in the same folder.
 * - pi:          ~/.pi/agent/sessions/--<cwd, / as ->--/<time>_<session>.jsonl (pi 0.86.1)
 * - Codex:       $CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<thread>.jsonl (codex-cli 0.157.0)
 * Text only by default: what was said, and the names of the tools used. Tool output (file contents,
 * command output, search results) is left out unless asked for, since it is large and may hold
 * whatever the tools read.
 */

export interface Row {
  ts: string | null;
  chat: string;
  profile: string;
  backend: string;
  session: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  tools?: string[];
}

export interface ExportOpts { all?: boolean; session?: string; tools?: boolean; home?: string }

/** The same rule the tui host reads live sessions with: a cwd behind a symlink is resolved first. */
export const claudeTranscript = (cwd: string, id: string, home = homedir()): string => transcriptPath(cwd, id, home);

export const grokSessionDir = (cwd: string, id: string, home = homedir()): string =>
  join(home, '.grok', 'sessions', encodeURIComponent(cwd), id);

/** pi's session file: the folder is the cwd without its leading slash, every / \\ : as -, between `--`. */
export function piSessionFile(cwd: string, id: string, home = homedir()): string | undefined {
  // pi names the folder after the cwd it runs in, which a symlinked profile folder resolves to.
  let realCwd = cwd;
  try { realCwd = realpathSync(cwd); } catch { /* a folder gone since: the name as configured */ }
  for (const c of [...new Set([realCwd, cwd])]) {
    const dir = join(home, '.pi', 'agent', 'sessions', `--${c.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    const hit = names.filter((n) => n.endsWith(`_${id}.jsonl`)).sort().pop();
    if (hit) return join(dir, hit);
  }
  return undefined;
}

function lines(path: string): any[] {
  if (!existsSync(path)) return [];
  const out: any[] = [];
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* a line being written */ }
  }
  return out;
}

const blocks = (c: unknown): any[] => (Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : []);
const textOf = (c: unknown): string => blocks(c).filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n').trim();
const toolText = (c: unknown): string => (typeof c === 'string' ? c : blocks(c).map((b) => (b?.type === 'text' ? b.text : '')).join('\n')).trim();

type Base = Pick<Row, 'chat' | 'profile' | 'backend' | 'session'>;

export function claudeRows(path: string, base: Base, tools = false): Row[] {
  const out: Row[] = [];
  for (const d of lines(path)) {
    if (d.isSidechain || d.isMeta || (d.type !== 'user' && d.type !== 'assistant')) continue;
    const m = d.message ?? {};
    const ts = d.timestamp ?? null;
    if (d.type === 'user') {
      const results = blocks(m.content).filter((b) => b?.type === 'tool_result');
      if (results.length) { if (tools) for (const r of results) out.push({ ...base, ts, role: 'tool', text: toolText(r.content) }); continue; }
      const text = textOf(m.content);
      if (text) out.push({ ...base, ts, role: 'user', text });
      continue;
    }
    const text = textOf(m.content);
    const used = blocks(m.content).filter((b) => b?.type === 'tool_use').map((b) => String(b.name));
    if (!text && !used.length) continue; // thinking only
    out.push({ ...base, ts, role: 'assistant', text, ...(used.length ? { tools: used } : {}) });
  }
  return out;
}

export function grokRows(dir: string, base: Base, tools = false): Row[] {
  const times = new Map<number, string>();
  for (const r of lines(join(dir, 'rewind_points.jsonl'))) if (typeof r.prompt_index === 'number') times.set(r.prompt_index, r.created_at);
  const out: Row[] = [];
  let ts: string | null = null;
  for (const d of lines(join(dir, 'chat_history.jsonl'))) {
    if (d.type === 'user') {
      // Only real prompts carry a prompt_index; the rest are grok's own preamble and reminders.
      if (d.synthetic_reason || typeof d.prompt_index !== 'number') continue;
      ts = times.get(d.prompt_index) ?? ts;
      const text = textOf(d.content).replace(/^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/, '$1');
      if (text) out.push({ ...base, ts, role: 'user', text });
    } else if (d.type === 'assistant') {
      const text = typeof d.content === 'string' ? d.content.trim() : textOf(d.content);
      const used = (Array.isArray(d.tool_calls) ? d.tool_calls : []).map((c: any) => String(c.name ?? c.function?.name ?? 'tool'));
      if (text || used.length) out.push({ ...base, ts, role: 'assistant', text, ...(used.length ? { tools: used } : {}) });
    } else if (d.type === 'tool_result' && tools) {
      out.push({ ...base, ts, role: 'tool', text: toolText(d.content) });
    }
  }
  return out;
}

/** Codex's rollout file for a thread: named after it, under a folder per day. */
export function codexSessionFile(id: string, home = homedir()): string | undefined {
  const root = join(process.env.CODEX_HOME ?? join(home, '.codex'), 'sessions');
  const walk = (dir: string, depth: number): string | undefined => {
    let names: string[];
    try { names = readdirSync(dir).sort().reverse(); } catch { return undefined; }
    for (const n of names) {
      if (depth === 3) { if (n.endsWith(`-${id}.jsonl`)) return join(dir, n); continue; }
      const hit = walk(join(dir, n), depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(root, 0);
}

/** A Codex rollout: the user's and the agent's messages (the injected instructions and environment
 *  blocks are left out), with the tools each agent step used. */
export function codexRows(path: string | undefined, base: Base, tools = false): Row[] {
  const out: Row[] = [];
  if (!path) return out;
  let used: string[] = [];
  for (const d of lines(path)) {
    if (d.type !== 'response_item') continue;
    const p = d.payload ?? {};
    const ts = d.timestamp ?? null;
    if (p.type === 'message' && p.role === 'user') {
      const text = blocks(p.content).filter((b) => b?.type === 'input_text').map((b) => String(b.text ?? '')).filter((t) => !/^(# AGENTS\.md instructions|<environment_context>|<user_instructions>)/.test(t)).join('\n').trim();
      if (text) out.push({ ...base, ts, role: 'user', text });
    } else if (p.type === 'message' && p.role === 'assistant') {
      const text = blocks(p.content).filter((b) => b?.type === 'output_text').map((b) => String(b.text ?? '')).join('\n').trim();
      if (text || used.length) out.push({ ...base, ts, role: 'assistant', text, ...(used.length ? { tools: used } : {}) });
      used = [];
    } else if (/^(function_call|custom_tool_call|local_shell_call)$/.test(p.type)) used.push(String(p.name ?? p.type));
    else if (tools && /_output$/.test(String(p.type))) out.push({ ...base, ts, role: 'tool', text: typeof p.output === 'string' ? p.output : toolText(p.output) });
  }
  return out;
}

export function piRows(path: string | undefined, base: Base, tools = false): Row[] {
  const out: Row[] = [];
  if (!path) return out;
  for (const d of lines(path)) {
    if (d.type !== 'message') continue;
    const m = d.message ?? {};
    const ts = d.timestamp ?? null;
    if (m.role === 'user') { const text = textOf(m.content); if (text) out.push({ ...base, ts, role: 'user', text }); }
    else if (m.role === 'assistant') {
      const text = textOf(m.content);
      const used = blocks(m.content).filter((b) => b?.type === 'toolCall').map((b) => String(b.name));
      if (text || used.length) out.push({ ...base, ts, role: 'assistant', text, ...(used.length ? { tools: used } : {}) });
    } else if (m.role === 'toolResult' && tools) out.push({ ...base, ts, role: 'tool', text: toolText(m.content) });
  }
  return out;
}

/** The rows of one chat: its active session, one named session, or every session it has had. */
export function exportChat(cfg: Config, sessions: SessionMapFile, chat: string, o: ExportOpts = {}): Row[] {
  const route = cfg.routes.find((r) => sessionKey(r) === chat);
  if (!route) throw new Error(`no route for ${chat}; angelia profiles lists the chats`);
  const p = cfg.profiles[route.profile];
  const c = sessions.chats[chat];
  const ids = o.session ? [o.session] : o.all ? (c?.history ?? []).map((h) => h.id) : c?.active ? [c.active] : [];
  if (o.session && !c?.history.some((h) => h.id === o.session)) throw new Error(`${chat} has no session ${o.session}`);
  const out: Row[] = [];
  for (const id of ids) {
    const row = c?.history.find((h) => h.id === id);
    const backend = row?.backend ?? p.backend;
    const base = { chat, profile: route.profile, backend, session: id };
    if (backend === 'grok') out.push(...grokRows(grokSessionDir(p.cwd, id, o.home), base, o.tools));
    else if (backend === 'codex') out.push(...codexRows(codexSessionFile(id, o.home), base, o.tools));
    else if (backend === 'pi') out.push(...piRows(piSessionFile(p.cwd, id, o.home), base, o.tools));
    else if (backend === 'claude-code') out.push(...claudeRows(claudeTranscript(p.cwd, id, o.home), base, o.tools));
    // A session from a backend Angelia does not run has no reader: skipped, not guessed at.
  }
  return out;
}
