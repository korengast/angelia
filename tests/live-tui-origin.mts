/**
 * Live check of what the Stop hook says started a turn (scripts/turn-origin.mjs), on a real `claude`
 * in a throwaway tmux pane: its own tmux socket, its own state folder, a scratch folder as cwd, the
 * cheapest model. Not part of `npm test`: it needs a logged-in Claude Code and costs a few calls.
 *
 *   npx tsx tests/live-tui-origin.mts
 *
 * 1. A typed turn: its marker says `prompt`, with `prompt_at` between the turn's Enter and its end.
 * 2. A turn that starts a background shell command and ends. When the command ends, Claude Code wakes
 *    the agent with a task notification: that turn's marker says `notification`, and the brain emits
 *    its answer as `unasked` (`self`).
 *
 * 3. With LIVE_CRON=1: a prompt the session schedules for itself every minute; the turn it starts
 *    says `notification` too.
 *
 * Only the marker is read (what the hook wrote), never the transcript. LIVE_ROWS=1 has the hook add
 * the shape of the transcript's last rows to the marker (types and flags, no words): the way to see
 * how a new Claude Code writes what starts a turn. Prints what it saw; exits 1 when a check fails.
 * LIVE_KEEP=1 leaves the pane up.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socket = `angelia-live-origin-${process.pid}`;
process.env.ANGELIA_TMUX_SOCKET = socket;
// The hook then adds the shape of the transcript's last rows to its marker (names and flags only).
if (process.env.LIVE_ROWS) process.env.ANGELIA_TUI_ORIGIN_DEBUG = '1';
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-live-origin-state-'));
const cwd = join(mkdtempSync(join(tmpdir(), 'angelia-live-origin-')), 'late-origin-live');
mkdirSync(cwd);

const { TuiBrain } = await import('../src/brain/tui.js');
const { TMUX_SOCKET } = await import('../src/brain/tmux.js');
if (TMUX_SOCKET !== socket || TMUX_SOCKET === 'angelia') throw new Error('refusing to run on the live tmux socket');

const b = new TuiBrain(
  { cwd, permission_mode: 'bypassPermissions', add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60,
    chrome: false, backend: 'claude-code', tui: true, model: process.env.LIVE_MODEL ?? 'claude-haiku-4-5-20251001' } as never,
  { id: crypto.randomUUID(), started: false },
  { idlePollMs: 300 },
);
// Every marker the brain reads, as the hook wrote it, without the answer's words.
const markers: Record<string, unknown>[] = [];
const bb = b as any;
const read = bb.readMarker.bind(bb);
bb.readMarker = () => {
  const m = read();
  if (m && !markers.some((x) => x.at === m.at)) { const { text, transcript_path: _t, session_id: _s, ...rest } = m; markers.push({ ...rest, chars: String(text ?? '').length }); }
  return m;
};
const logs: string[] = [];
b.on('log', (l: string) => { logs.push(l); console.log('log |', l); });
const unasked: { answer: string; text: string }[] = [];
b.on('unasked', (a: { answer: string; text: string }) => { unasked.push(a); console.log('unasked |', a.answer, JSON.stringify(a.text).slice(0, 80)); });

const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(ok ? 'ok   |' : 'FAIL |', what); if (!ok) failures.push(what); };
const until = async (ok: () => boolean, ms: number) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 250)); return ok(); };

async function turn(text: string) {
  const sentBefore = Date.now();
  let result: any;
  for await (const e of b.turn(text)) {
    if (e.kind === 'permission') b.answerPermission(e.id, true);
    else if (e.kind === 'result') result = e;
    console.log(e.kind, '|', JSON.stringify((e as { text?: string }).text ?? '').slice(0, 80));
  }
  return { result, sentBefore, endedAt: Date.now() };
}

try {
  b.start();
  console.log('tmux socket', socket, 'session', b.name, 'cwd', cwd);

  const t1 = await turn('Reply with exactly this and nothing else: ok');
  check(t1.result?.isError === false && /ok/i.test(t1.result.text), 'turn 1 answered');
  const m1 = markers.at(-1);
  console.log('marker 1 |', JSON.stringify(m1));
  check(m1?.origin === 'prompt', `a typed turn's marker says prompt (said: ${String(m1?.origin)}; ${String(m1?.origin_why)})`);
  check(typeof m1?.prompt_at === 'number' && m1.prompt_at >= t1.sentBefore - 1000 && m1.prompt_at <= t1.endedAt, `prompt_at lies inside the turn (${String(m1?.prompt_at)} in ${t1.sentBefore}..${t1.endedAt})`);

  const before = markers.length;
  const t2 = await turn('Use the Bash tool once, with run_in_background set to true, to run: sleep 25 && echo finished. Do not wait for it. Then reply with exactly: started. Later, when you are told that the background command has completed, reply with exactly: BACKGROUND-DONE');
  check(t2.result?.isError === false, 'turn 2 answered');
  console.log('marker 2 |', JSON.stringify(markers.at(-1)));
  check(markers.length > before && markers.at(-1)?.origin === 'prompt', 'turn 2, typed, says prompt too');
  // Not a check: a slow turn can outlast the command, whose end is then answered right after the turn.
  console.log('note |', `background commands open after the turn: ${b.backgroundTasks().length}`);

  const n = markers.length;
  const woke = await until(() => markers.length > n, 120_000);
  check(woke, 'a Stop marker came between turns, after the command ended');
  const m3 = markers.at(-1);
  console.log('marker 3 |', JSON.stringify(m3));
  check(m3?.origin === 'notification', `the turn a task notification started says notification (said: ${String(m3?.origin)}; ${String(m3?.origin_why)})`);
  await until(() => unasked.length > 0, 3000);
  check(unasked.length === 1 && unasked[0].answer === 'self', `its answer is emitted once as a self-started answer (${unasked.length})`);
  check(b.backgroundTasks().length === 0, 'the background command is closed');

  // A scheduled prompt of the session (it takes up to a minute more). LIVE_CRON=1.
  if (process.env.LIVE_CRON) {
    const t3 = await turn('Use the CronCreate tool (load it with ToolSearch if it is not loaded) to schedule a recurring prompt with the cron expression "* * * * *" (every minute), not durable. The prompt is: Reply with exactly: CRON-FIRED. Then reply with exactly: scheduled');
    console.log('cron turn |', t3.result?.isError, JSON.stringify(markers.at(-1)));
    const c = markers.length;
    const fired = await until(() => markers.length > c, 200_000);
    console.log('cron marker |', fired ? JSON.stringify(markers.at(-1), null, 1) : 'none in 200 s');
    console.log('cron unasked |', unasked.length - 1);
    check(fired && markers.at(-1)?.origin === 'notification', `a scheduled prompt's turn says notification (said: ${String(markers.at(-1)?.origin)}; ${String(markers.at(-1)?.origin_why)})`);
    check(unasked.length === 2 && unasked[1].answer === 'self', 'and its answer is emitted as a self-started answer');
  }
} finally {
  if (!process.env.LIVE_KEEP) {
    await b.stop().catch(() => {});
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
