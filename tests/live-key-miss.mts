/**
 * Live check of the prompt key miss of 0.4.4 (2026-11-26): text left in the input box before a paste.
 * Ctrl-U deletes from the cursor back to the line's start, so text whose cursor was at its start stayed;
 * the paste went in before it, Enter sent both, and the Stop hook keyed that prompt as none Angelia
 * typed: the turn dropped its own answer and the quiet pane ended it with none (measured on 2.1.332
 * before the fix: a line and a chip left that way both missed). Each case leaves the box in one state,
 * then types a message of the customer's shapes (Angelia's quote block with a last line ".", a plain
 * numbered list, a posted-lines block) through TuiBrain.turn, Angelia's own typing path. Then a long
 * message (a chip, or a box drawn with its middle cut), and the first message into a pane resumed fresh
 * (a restart). A real `claude` in a throwaway pane, its own tmux server (ANGELIA_TMUX_SOCKET, default
 * angelia-live-km-<pid>) and temp folders, the cheapest model. Not part of `npm test`: it needs a
 * logged-in Claude Code and costs a few calls.
 *
 *   ANGELIA_TMUX_SOCKET=km-test npx tsx tests/live-key-miss.mts
 *
 * Per message: how the turn ended, the answer's length, the typed key, the hook's key and the key of
 * the prompt the transcript stores (their first 8 hex digits), and any key miss line. Never the words.
 * LIVE_DUMP=<file> writes, per message, what was typed and what the transcript stores (JSON lines),
 * and the screen before each Enter (<file>.screens). LIVE_ONLY=<case,...> runs some. Exits 1 when a
 * check fails.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RECORD } from '../src/capabilities/compile.js';
import { Config } from '../src/instance/config/schema.js';
import { DEFAULT_BIN, locateBin } from '../src/brain/locate.js';
import { KEY_KEPT_LINE, KEY_MISS_LINE, promptKey, TuiBrain } from '../src/brain/tui.js';
import { cleanText } from '../src/core/types.js';
import { SENT_PREFACE_HEAD } from '../src/core/session/notes.js';

const socket = process.env.ANGELIA_TMUX_SOCKET && process.env.ANGELIA_TMUX_SOCKET !== 'angelia' ? process.env.ANGELIA_TMUX_SOCKET : `angelia-live-km-${process.pid}`;
if (socket === 'angelia' || socket.startsWith('angelia-canary')) throw new Error('refusing to run on the live or the canary tmux socket');
const root = mkdtempSync(join(tmpdir(), 'angelia-live-km-'));
const cwd = join(root, 'km'), stateDir = join(root, 'state');
for (const d of [cwd, stateDir, join(cwd, '.claude')]) mkdirSync(d, { mode: 0o700 });
writeFileSync(join(cwd, RECORD), JSON.stringify({ version: 1, backend: 'claude-code', links: {}, mcpServers: [], mcpStrict: true, deny: [], additionalDirectories: [], blockLines: [], compiledAt: new Date().toISOString() }));
writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
const profile = Config.parse({ profiles: { km: { cwd, tui: true, permission_mode: 'default', model: process.env.LIVE_MODEL ?? 'haiku' } }, routes: [] }).profiles.km;
const bin = locateBin(DEFAULT_BIN['claude-code']) ?? 'claude';
const id = randomUUID();
const dump = process.env.LIVE_DUMP;
const t0 = Date.now();
const s = () => ((Date.now() - t0) / 1000).toFixed(1);

function rig(started: boolean) {
  const b = new TuiBrain(profile, { id, started }, { bin, tmuxSocket: socket, stateDir, promptTimeoutMs: 60_000 });
  const bb = b as any;
  const logs: string[] = [];
  b.on('log', (l: string) => { logs.push(l); if (process.env.LIVE_VERBOSE) console.log(s(), 'log |', l.slice(0, 200)); });
  const seen: Record<string, unknown>[] = [];
  const read = bb.readMarker.bind(bb);
  bb.readMarker = () => { const m = read(); if (m && !seen.some((x) => x.at === m.at)) seen.push({ at: m.at, origin: m.origin, prompts: m.prompts, prompt_key: m.prompt_key, prompt_len: m.prompt_len }); return m; };
  const tm = bb.tm.bind(bb);
  bb.tm = async (a: string[], o?: unknown) => {
    if (a[0] === 'send-keys' && a.at(-1) === 'Enter' && dump) appendFileSync(`${dump}.screens`, `--- ${s()} before Enter\n${(await tm(['capture-pane', '-p', '-t', bb.name, '-S', '-12'])).out}\n`);
    return tm(a, o);
  };
  return { b, bb, logs, seen };
}
const tmux = (...a: string[]) => execFileSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const head = '[telegram dm 1001 · Owner (1001)]';
const label = "Replying to (quoted by the sender's app; author not verified):";
const posted = `${SENT_PREFACE_HEAD}\n[26 Nov 12:20 · job digest] the digest ran\n> line two of it`;
const quoteDot = [head, label, '> Here is what I found:', '> ', '> - the first point', '', '.'].join('\n');
const list = [head, '', '1. first item, reply ok', '2. second item'].join('\n');
const long = [head, '', ...Array.from({ length: 80 }, (_, i) => `${i + 1}. a line of a long list, number ${i + 1}, to make the paste long`), '', 'Reply with exactly: ok'].join('\n');

let failed = 0;
async function one(r: ReturnType<typeof rig>, name: string, text: string, before?: () => Promise<void>) {
  const from = r.logs.length, marks = r.seen.length;
  if (before) await before();
  const typedKey = promptKey(cleanText(text));
  let result: any;
  for await (const e of r.b.turn(text)) if (e.kind === 'result') result = e;
  const lines = r.logs.slice(from);
  const miss = lines.find((l) => l.startsWith(KEY_MISS_LINE) || l.startsWith(KEY_KEPT_LINE));
  const ended = lines.find((l) => l.startsWith('tmux: turn ended by')) ?? '(no end line)';
  const held = lines.find((l) => l.startsWith('tmux: the input box held text'));
  const m = r.seen.slice(marks);
  const rows = readFileSync(r.bb.transcript, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const row = rows.filter((x) => x?.type === 'user' && x?.origin?.kind === 'human').at(-1);
  const stored = typeof row?.message?.content === 'string' ? row.message.content : JSON.stringify(row?.message?.content ?? '');
  const ok = !miss && /by the Stop marker after/.test(ended) && result?.isError === false && String(result?.text ?? '').trim().length > 0 && m.some((x) => x.prompt_key === typedKey) && promptKey(stored) === typedKey;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} | ${name} | ${ended.replace(/ pane=.*/, '').replace('tmux: turn ended by ', '')} | answer ${result?.isError ? `error (${result.reason})` : `${String(result?.text ?? '').length} chars`} | typed ${typedKey.slice(0, 8)} hook ${m.map((x) => `${String(x.prompt_key).slice(0, 8)}/${String(x.prompts)}`).join(',') || '-'} stored ${promptKey(stored).slice(0, 8)}${held ? ` | ${held.replace(/: \d+ chars.*/, '').replace('tmux: the input box ', 'box ')}` : ''}${miss ? ` | ${miss.replace(/ pane=.*/, '')}` : ''}`);
  if (dump) appendFileSync(dump, JSON.stringify({ name, ok, typed: text, typedKey, markers: m, storedKey: promptKey(stored), stored, logs: lines }) + '\n');
}

const only = process.env.LIVE_ONLY?.split(',');
const want = (n: string) => !only || only.includes(n);
try {
  let r = rig(false);
  r.b.start();
  const key = (...k: string[]) => tmux('send-keys', '-t', r.bb.name, ...k);
  const typeIn = (t: string) => tmux('send-keys', '-t', r.bb.name, '-l', t);
  const pasteIn = (t: string) => { writeFileSync(join(root, 'p.txt'), t); tmux('load-buffer', '-b', 'km-x', join(root, 'p.txt')); tmux('paste-buffer', '-p', '-d', '-b', 'km-x', '-t', r.bb.name); };
  await one(r, 'first message, empty box', `${head}\n\nReply with exactly: ok`);
  if (want('line-home')) await one(r, 'a line left, cursor at its start', quoteDot, async () => { typeIn('half typed words'); await sleep(500); key('C-a'); await sleep(800); });
  if (want('chip-home')) await one(r, 'a chip left, cursor at its start', quoteDot, async () => { pasteIn(`${head}\n\nan earlier message\nthat was cut before its Enter`); await sleep(1200); key('C-a'); await sleep(800); });
  if (want('lines-mid')) await one(r, 'three lines left, cursor on the middle one', list, async () => { typeIn('first line'); key('C-j'); typeIn('second line'); key('C-j'); typeIn('third line'); await sleep(500); key('Up'); key('C-a'); await sleep(800); });
  if (want('line-end')) await one(r, 'a line left, cursor at its end', `${posted}\n\n${quoteDot}`, async () => { typeIn('half typed words'); await sleep(800); });
  if (want('long')) await one(r, 'a long message (80 lines)', long);
  if (want('restart')) {
    await r.b.stop();
    r = rig(true);
    r.b.start();
    await one(r, 'first message into a pane resumed fresh, posted lines', `${posted}\n\n${quoteDot}`);
    await one(r, 'the next one, posted lines and a list', `${posted}\n\n${list}`);
  }
  await r.b.stop().catch(() => {});
} finally {
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
