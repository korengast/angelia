/**
 * Live check that the Stop hook's key of the typed prompt (scripts/turn-origin.mjs, promptKey) is the
 * key of what TuiBrain typed (tui.ts), on a real `claude` in a throwaway pane named as the canary's
 * (its own tmux server and temp folder; removed with the canary's own sweep). Cheapest model. Not part
 * of `npm test`: it needs a logged-in Claude Code and costs a few calls.
 *
 *   npx tsx tests/live-prompt-key.mts
 *
 * Prints per message: how the turn ended, whether the answer came, and whether the keys match. Never
 * prints the conversation or the transcript.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECORD } from '../src/capabilities/compile.js';
import { Config } from '../src/instance/config/schema.js';
import { childEnv } from '../src/brain/argv.js';
import { canaryModel, sweepOrphans } from '../src/brain/canary.js';
import { DEFAULT_BIN, locateBin } from '../src/brain/locate.js';
import { promptKey, TuiBrain } from '../src/brain/tui.js';
import { cleanText } from '../src/core/types.js';

if (process.env.LIVE_ROWS) process.env.ANGELIA_TUI_ORIGIN_DEBUG = '1';
const root = mkdtempSync(join(tmpdir(), `angelia-canary-${process.pid}-`));
const cwd = join(root, 'canary'), stateDir = join(root, 'state');
const socket = `angelia-canary-${process.pid}`;
for (const d of [cwd, stateDir, join(cwd, '.claude')]) mkdirSync(d, { mode: 0o700 });
writeFileSync(join(cwd, RECORD), JSON.stringify({ version: 1, backend: 'claude-code', links: {}, mcpServers: [], mcpStrict: true, deny: [], additionalDirectories: [], blockLines: [], compiledAt: new Date().toISOString() }));
writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
const profile = Config.parse({ profiles: { canary: { cwd, tui: true, permission_mode: 'default', model: await canaryModel() } }, routes: [] }).profiles.canary;
const bin = locateBin(DEFAULT_BIN['claude-code']) ?? 'claude';
const b = new TuiBrain(profile, { id: randomUUID(), started: false }, { bin, tmuxSocket: socket, stateDir });
const bb = b as any;
const logs: string[] = [];
b.on('log', (l: string) => logs.push(l));
const seen: Record<string, unknown>[] = [];
const read = bb.readMarker.bind(bb);
bb.readMarker = () => { const m = read(); if (m && !seen.some((x) => x.at === m.at)) seen.push({ at: m.at, origin: m.origin, prompts: m.prompts, prompt_key: m.prompt_key, rows: m.origin_rows, chars: String(m.text ?? '').length }); return m; };

const long = [
  'שורה ראשונה בעברית עם אימוג׳י 🎉 ומילים נוספות.',
  'Line two in English,\twith a tab inside.',
  '',
  ...Array.from({ length: 40 }, (_, i) => `שורה ${i + 3}: lorem ipsum טקסט מעורב mixed text ✅ number ${i} — and more words to fill the line.`),
  '',
  'Reply with exactly: ok',
].join('\n');
const envelope = [
  '[telegram group Test · Owner (u1) · 2026-11-21 10:00]',
  'Replying to (quoted by the sender\'s app; author not verified):',
  '> the quoted first line',
  '> and a second quoted line',
  '',
  'Reply with exactly: ok',
].join('\n');
const msgs: [string, string][] = [['a short English', 'Reply with exactly: ok'], ['b long, Hebrew, emoji, tab, blank line', long], ['c envelope with quoted lines', envelope]];

let failed = 0;
try {
  b.start();
  for (const [name, text] of msgs) {
    const from = logs.length, marks = seen.length;
    let result: any;
    for await (const e of b.turn(text)) if (e.kind === 'result') result = e;
    const ended = logs.slice(from).find((l) => l.startsWith('tmux: turn ended by')) ?? '(no end line)';
    const m = seen.slice(marks).at(-1);
    const typed = promptKey(cleanText(text));
    const match = m?.prompt_key === typed;
    const ok = /by the Stop marker after/.test(ended) && result?.isError === false && /ok/i.test(String(result?.text)) && match;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} | ${name} (${text.length} chars) | ${ended.replace(/ pane=.*/, '')} | answer ${result?.isError ? 'error' : JSON.stringify(String(result?.text ?? '').slice(0, 20))} | marker origin=${String(m?.origin)} prompts=${String(m?.prompts)} key ${match ? 'matches' : `MISSES (hook ${String(m?.prompt_key)}, typed ${typed})`}`);
    if (process.env.LIVE_ROWS && m?.rows) console.log('     rows |', JSON.stringify(m.rows));
    for (const l of logs.slice(from)) if (!l.startsWith('tmux: turn ended by')) console.log('     log |', l.replace(/ pane=.*/, ''));
  }
} finally {
  await b.stop().catch(() => {});
  // The canary's own cleanup: its tmux server, its temp folder and its session's transcript folder.
  const gone = await sweepOrphans(childEnv(process.env), { alive: (pid) => pid !== process.pid && (() => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } })() });
  console.log('cleanup |', gone.join(', ') || 'nothing found');
}
process.exit(failed ? 1 : 0);
