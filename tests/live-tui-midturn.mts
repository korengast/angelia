/**
 * Live check of a chat message typed into a running turn (TuiBrain.absorb), on a real `claude` in a
 * throwaway tmux pane: its own tmux socket, its own state folder, a scratch folder as cwd, the
 * cheapest model. Not part of `npm test`: it needs a logged-in Claude Code and costs a few calls.
 *
 *   npx tsx tests/live-tui-midturn.mts
 *
 * The turn runs `sleep` three times, one call at a time. Once the first call has run a moment, a
 * second message (a secret word) is typed into the turn. Checks: absorb says it was taken, the turn's
 * one answer has the word (the model read it inside the same turn), one Stop marker for the turn, and
 * nothing comes after it. LIVE_KEEP=1 leaves the pane up. Exits 1 when a check fails.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socket = `angelia-live-midturn-${process.pid}`;
process.env.ANGELIA_TMUX_SOCKET = socket;
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-live-midturn-state-'));
const cwd = join(mkdtempSync(join(tmpdir(), 'angelia-live-midturn-')), 'midturn-live');
mkdirSync(cwd);

const { TuiBrain } = await import('../src/brain/tui.js');
const { TMUX_SOCKET } = await import('../src/brain/tmux.js');
if (TMUX_SOCKET !== socket || TMUX_SOCKET === 'angelia') throw new Error('refusing to run on the live tmux socket');

const b = new TuiBrain(
  { cwd, permission_mode: 'bypassPermissions', add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60,
    chrome: false, backend: 'claude-code', tui: true, model: process.env.LIVE_MODEL ?? 'haiku' } as never,
  { id: crypto.randomUUID(), started: false },
  { idlePollMs: 300 },
);
const markers: number[] = [];
const bb = b as any;
const read = bb.readMarker.bind(bb);
bb.readMarker = () => { const m = read(); if (m && !markers.includes(m.at)) markers.push(m.at); return m; };
b.on('log', (l: string) => console.log('log |', l));
const unasked: string[] = [];
b.on('unasked', (a: { answer: string; text: string }) => { unasked.push(a.answer); console.log('unasked |', a.answer, JSON.stringify(a.text).slice(0, 120)); });
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(ok ? 'ok   |' : 'FAIL |', what); if (!ok) failures.push(what); };

b.start();
console.log('pane', b.name, 'socket', socket);
const t0 = Date.now();
let answer = '';
let absorbed: Promise<boolean> | undefined;
// Offered as soon as the turn is typed in: absorb waits for a tool call that has run a moment.
const offer = setInterval(() => {
  if (b.turnSentAt === undefined || absorbed) return;
  clearInterval(offer);
  console.log(((Date.now() - t0) / 1000).toFixed(1), 'offering the second message');
  absorbed = b.absorb('[Live test · Owner]\n\nSecond message: the secret word is PINEAPPLE.');
  void absorbed.then((ok) => console.log(((Date.now() - t0) / 1000).toFixed(1), 'absorb ->', ok));
}, 200);
const first = '[Live test · Owner]\n\nRun the shell command `sleep 12` three times with the Bash tool, one call at a time (three separate calls, never in the background). After the third, say "done", and repeat word for word any other message you got from me during this turn.';
for await (const e of b.turn(first)) {
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  if (e.kind === 'result') { answer = e.text; console.log(s, 'result', e.isError ? `error ${e.reason}` : '', JSON.stringify(e.text).slice(0, 300)); }
  else console.log(s, e.kind, JSON.stringify((e as { text?: string }).text ?? '').slice(0, 120));
}
clearInterval(offer);
const ok = await (absorbed ?? Promise.resolve(false));
check(ok, 'the second message was typed into the running turn');
check(/PINEAPPLE/.test(answer), 'the turn\'s one answer has the secret word: the model read it inside the same turn');
check(markers.length === 1, `one Stop marker for the turn (saw ${markers.length})`);
await new Promise((r) => setTimeout(r, 8000));
check(markers.length === 1 && unasked.length === 0, 'no second turn after it');
if (!process.env.LIVE_KEEP) await b.stop();
console.log(failures.length ? `FAILED: ${failures.join('; ')}` : 'all checks passed', `(${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(failures.length ? 1 : 0);
