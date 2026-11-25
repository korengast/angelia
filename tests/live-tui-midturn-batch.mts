/**
 * Live check that no Enter of a message typed into a running turn ever lands on a permission dialog
 * (review finding H1), on a real `claude` in a throwaway tmux pane: its own tmux socket and state
 * folder, a scratch cwd, the cheapest model, acceptEdits (so calls ask; never bypassPermissions).
 * Not part of `npm test`: it needs a logged-in Claude Code and costs a few calls.
 *
 *   npx tsx tests/live-tui-midturn-batch.mts
 *
 * The model makes two Bash calls in ONE message: `sleep 20`, then `ls -la /tmp`. Both ask. The chat
 * (this script) allows the sleep at once, and answers the `ls` dialog only after LS_HOLD_MS, with no.
 * Meanwhile a new message is offered every 1.5 s. Checks: at least one message went into the turn;
 * every answer from the chat reached a hook that still waited (an Enter on the dialog would have
 * answered it first, "Yes"); no request was answered in the pane; `ls` never ran (its answer was no).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socket = `angelia-live-midbatch-${process.pid}`;
process.env.ANGELIA_TMUX_SOCKET = socket;
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-live-midbatch-state-'));
const cwd = join(mkdtempSync(join(tmpdir(), 'angelia-live-midbatch-')), 'midbatch-live');
mkdirSync(cwd);
const LS_HOLD_MS = 12_000;

const { TuiBrain } = await import('../src/brain/tui.js');
const { TMUX_SOCKET } = await import('../src/brain/tmux.js');
if (TMUX_SOCKET !== socket || TMUX_SOCKET === 'angelia') throw new Error('refusing to run on the live tmux socket');

const b = new TuiBrain(
  { cwd, permission_mode: 'acceptEdits', add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60,
    chrome: false, backend: 'claude-code', tui: true, model: process.env.LIVE_MODEL ?? 'haiku' } as never,
  { id: crypto.randomUUID(), started: false },
  { idlePollMs: 300 },
);
const t0 = Date.now();
const s = () => ((Date.now() - t0) / 1000).toFixed(1);
b.on('log', (l: string) => console.log(s(), 'log |', l));
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(ok ? 'ok   |' : 'FAIL |', what); if (!ok) failures.push(what); };

b.start();
console.log('pane', b.name, 'socket', socket);
const offered: Promise<boolean>[] = [];
const words = ['APPLE', 'BERRY', 'CHERRY', 'DATE', 'ELDER', 'FIG', 'GRAPE', 'HONEY', 'IRIS', 'JADE', 'KIWI', 'LIME'];
const offer = setInterval(() => {
  if (b.turnSentAt === undefined || offered.length >= words.length) return;
  const w = words[offered.length];
  console.log(s(), 'offering', w);
  const p = b.absorb(`[Live test · Owner]\n\nNote word: ${w}.`);
  void p.then((ok) => console.log(s(), 'absorb', w, '->', ok));
  offered.push(p);
}, 1500);
const answers: { what: string; reached: boolean }[] = [];
const paneAnswered: string[] = [];
let answer = '';
const first = '[Live test · Owner]\n\nIn ONE single message, make two Bash tool calls at once (parallel): first `sleep 20`, second `ls -la /tmp`. Then say "done" and list every "Note word" you got from me during this turn.';
for await (const e of b.turn(first)) {
  if (e.kind === 'permission') {
    const what = e.preview;
    console.log(s(), 'PERMISSION', e.tool, '|', what);
    if (/sleep/.test(what)) answers.push({ what: 'sleep', reached: b.answerPermission(e.id, true) });
    else setTimeout(() => { const reached = b.answerPermission(e.id, false); answers.push({ what: 'ls', reached }); console.log(s(), 'answered ls with no; the hook still waited:', reached); }, LS_HOLD_MS);
  } else if (e.kind === 'permission-answered') { paneAnswered.push(String(e.id)); console.log(s(), 'ANSWERED IN THE PANE', e.id, e.allow); }
  else if (e.kind === 'result') { answer = e.text; console.log(s(), 'result', e.isError ? `error ${e.reason}` : '', JSON.stringify(e.text).slice(0, 300)); }
  else console.log(s(), e.kind, JSON.stringify((e as { text?: string }).text ?? '').slice(0, 120));
}
clearInterval(offer);
const results = await Promise.all(offered);
const taken = results.filter(Boolean).length;
console.log('offered', results.length, 'taken', taken);
check(answers.some((a) => a.what === 'ls'), 'the ls dialog came and was answered from the chat');
check(answers.every((a) => a.reached), 'every chat answer reached a hook that still waited: no Enter answered a dialog');
check(paneAnswered.length === 0, 'no request was answered in the pane');
check(!/(^|\n)total \d+/.test(answer), 'ls did not run (it was refused)');
check(taken >= 1, `at least one message went into the turn (${taken})`);
check(words.slice(0, taken).some((w) => answer.includes(w)), 'the answer names a word typed into the turn');
if (!process.env.LIVE_KEEP) await b.stop();
console.log(failures.length ? `FAILED: ${failures.join('; ')}` : 'all checks passed', `(${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(failures.length ? 1 : 0);
