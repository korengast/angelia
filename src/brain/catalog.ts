import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendName } from './brain.js';

/**
 * What a backend offers for /model and /effort, asked of the CLI itself where it can say. Read-only,
 * no session and no turn: Codex answers `model/list` (models and each one's effort levels), grok
 * prints `grok models`. Claude Code has no such listing, so its aliases and its --effort levels are
 * written down here, from `claude --help` (2.1.x, 2026-09-25).
 */
export interface ModelInfo { id: string; name?: string; efforts?: string[]; defaultEffort?: string; isDefault?: boolean }
export interface Catalog {
  models: ModelInfo[];
  /** Levels for a model that does not list its own. */
  efforts: string[];
  /** A name outside `models` is still taken (Claude Code accepts any full model name). */
  anyModel: boolean;
  /** A line about the list, such as where a full name can be found. */
  note?: string;
}

export const LABELS: Record<BackendName, string> = { 'claude-code': 'Claude Code', grok: 'Grok Build', codex: 'Codex', pi: 'pi' };

const CLAUDE: Catalog = {
  models: [{ id: 'fable' }, { id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  anyModel: true,
  note: 'Each alias is the latest model of that name; a full name such as claude-opus-5-5 works too.',
};

/** grok's levels, measured over ACP (session/new, 2026-09-25): every current model has low..high, most also xhigh. */
const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

/** `grok models`: "  - name" per model, "  * name (default)" for the default. */
export function parseGrokModels(text: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*([-*])\s+(\S+)(\s+\(default\))?\s*$/.exec(line);
    if (m) out.push({ id: m[2], ...(m[1] === '*' || m[3] ? { isDefault: true } : {}) });
  }
  return out;
}

/** Codex's `model/list` result, hidden models left out. */
export function parseCodexModels(result: { data?: unknown[] }): ModelInfo[] {
  return (result.data ?? []).flatMap((x) => {
    const m = x as Record<string, any>;
    if (m.hidden || typeof m.id !== 'string') return [];
    const efforts = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((e: any) => String(e?.reasoningEffort ?? e)) : undefined;
    return [{ id: m.id, ...(m.displayName ? { name: String(m.displayName) } : {}), ...(efforts?.length ? { efforts } : {}), ...(m.defaultReasoningEffort ? { defaultEffort: String(m.defaultReasoningEffort) } : {}), ...(m.isDefault ? { isDefault: true } : {}) }];
  });
}

function grokModels(bin: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ModelInfo[]> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['models'], { env, timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
      const models = parseGrokModels(stdout ?? '');
      if (models.length) resolve(models); else reject(err ?? new Error('grok models listed nothing'));
    });
  });
}

/** A short-lived `codex app-server` in an empty folder: initialize, model/list, gone. No thread is made. */
function codexModels(bin: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ModelInfo[]> {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-codex-models-'));
  return new Promise<ModelInfo[]>((resolve, reject) => {
    const c = spawn(bin, ['app-server'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const done = (e: Error | null, v?: ModelInfo[]) => { clearTimeout(t); c.kill(); rmSync(dir, { recursive: true, force: true }); if (e) reject(e); else resolve(v!); };
    const t = setTimeout(() => done(new Error('codex did not list its models in time')), timeoutMs);
    c.on('error', (e) => done(e));
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (s: string) => {
      buf += s;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        let m: any; try { m = JSON.parse(buf.slice(0, i)); } catch { m = null; }
        buf = buf.slice(i + 1);
        if (m?.id === 1) { c.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n' + JSON.stringify({ id: 2, method: 'model/list', params: {} }) + '\n'); }
        else if (m?.id === 2) { if (m.error) done(new Error(String(m.error.message ?? 'model/list failed'))); else done(null, parseCodexModels(m.result ?? {})); }
      }
    });
    c.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'angelia', title: 'Angelia', version: '0' }, capabilities: null } }) + '\n');
  });
}

/** The backend's catalog. A CLI that cannot be asked gives an empty model list, and nothing is refused on it. */
export async function catalog(backend: BackendName, bin: string | undefined, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<Catalog> {
  if (backend === 'claude-code') return CLAUDE;
  if (backend === 'grok') {
    const models = bin ? await grokModels(bin, env, timeoutMs).catch(() => []) : [];
    return { models, efforts: GROK_EFFORTS, anyModel: !models.length };
  }
  if (backend === 'codex') {
    const models = bin ? await codexModels(bin, env, timeoutMs).catch(() => []) : [];
    return { models, efforts: ['low', 'medium', 'high', 'xhigh'], anyModel: !models.length, ...(models.length ? {} : { note: 'Codex did not list its models just now.' }) };
  }
  return { models: [], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], anyModel: true };
}

/** The effort levels that fit a model: its own list when the catalog has one, else the backend's. */
export function effortsFor(c: Catalog, model: string | undefined): { levels: string[]; defaultLevel?: string } {
  const m = model ? c.models.find((x) => x.id === model) : c.models.find((x) => x.isDefault);
  return { levels: m?.efforts ?? c.efforts, ...(m?.defaultEffort ? { defaultLevel: m.defaultEffort } : {}) };
}
