/**
 * Live check: the answer to a named teammate's message reaches the chat (scripts/turn-origin.mjs,
 * TuiBrain.takeIdle). A real `claude` in a throwaway tmux pane: its own tmux server, its own state
 * folder, a scratch folder as cwd, the cheapest model. Not part of `npm test`: it needs a logged-in
 * Claude Code and costs a few calls.
 *
 *   npx tsx tests/live-tui-teammate.mts
 *
 * A chat turn spawns a background teammate with a name and a 20 s task. Its report to the lead
 * (SendMessage) starts a turn by itself: the hook says `notification` and names the teammate, and its
 * answer goes to the stub chat (`unasked`, `self`). The teammate's idle note after it is not a typed
 * prompt either. Only the marker is read (what the hook wrote), never the transcript.
 *
 * ANGELIA_TMUX_SOCKET picks the tmux server (default angelia-live-teammate-<pid>); LIVE_MODEL the
 * model (default haiku). LIVE_KEEP=1 leaves the pane up. Exits 1 when a check fails.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socket = process.env.ANGELIA_TMUX_SOCKET && process.env.ANGELIA_TMUX_SOCKET !== 'angelia' ? process.env.ANGELIA_TMUX_SOCKET : `angelia-live-teammate-${process.pid}`;
process.env.ANGELIA_TMUX_SOCKET = socket;
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-live-teammate-state-'));
const cwd = join(mkdtempSync(join(tmpdir(), 'angelia-live-teammate-')), 'teammate-live');
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
const markers: Record<string, unknown>[] = [];
const bb = b as any;
const read = bb.readMarker.bind(bb);
bb.readMarker = () => {
  const m = read();
  if (m && !markers.some((x) => x.at === m.at)) { const { text, transcript_path: _t, session_id: _s, ...rest } = m; markers.push({ ...rest, chars: String(text ?? '').length }); }
  return m;
};
b.on('log', (l: string) => console.log('log |', l));
/** The stub chat: what the brain hands on between turns. */
const chat: { answer: string; text: string }[] = [];
b.on('unasked', (a: { answer: string; text: string }) => { chat.push(a); console.log('chat |', a.answer, JSON.stringify(a.text).slice(0, 100)); });

const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(ok ? 'ok   |' : 'FAIL |', what); if (!ok) failures.push(what); };
const until = async (ok: () => boolean, ms: number) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 250)); return ok(); };

try {
  b.start();
  console.log('tmux socket', socket, 'session', b.name, 'cwd', cwd);
  let result: any;
  for await (const e of b.turn('Use the Agent tool to spawn a background teammate: set the name parameter to "scout" and run_in_background to true. Its task: use the Bash tool to run `sleep 20`, then use SendMessage to send the team lead the report "SCOUT-DONE: the sleep finished". After spawning it, reply with exactly: spawned. Later, when the scout reports, reply with exactly: GOT-SCOUT-REPORT. If you only get a note that a teammate is idle, reply with exactly: [SILENT]')) {
    if (e.kind === 'permission') b.answerPermission(e.id, true);
    else if (e.kind === 'result') result = e;
  }
  check(result?.isError === false && /spawned/i.test(result.text), `the chat turn answered (${JSON.stringify(result?.text ?? '').slice(0, 40)})`);
  check(markers.at(-1)?.origin === 'prompt', 'the chat turn says prompt');

  const n = markers.length;
  check(await until(() => markers.slice(n).some((m) => Array.isArray(m.origin_teammates)), 150_000), 'a turn the teammate\'s message started came between turns');
  const m = markers.slice(n).find((x) => Array.isArray(x.origin_teammates));
  console.log('marker |', JSON.stringify(m));
  check(m?.origin === 'notification' && (m.origin_teammates as string[]).includes('scout'), `its marker says notification and names the scout (${String(m?.origin)}; ${String(m?.origin_why)})`);
  check(await until(() => chat.some((a) => a.answer === 'self' && /GOT-SCOUT-REPORT/.test(a.text)), 10_000), 'its answer reached the stub chat');
  // The idle note, if it comes in time: a turn of the chat's work too, never read as typed.
  await until(() => markers.slice(n).some((x) => x.origin_idle === true), 20_000);
  const idle = markers.slice(n).find((x) => x.origin_idle === true);
  console.log('idle marker |', idle ? JSON.stringify(idle) : 'none in 20 s');
  if (idle) check(idle.origin === 'notification', 'the idle note\'s turn says notification');
  check(!markers.slice(n).some((x) => x.origin === 'prompt'), 'no turn after the chat\'s own was read as typed');
  console.log('chat got |', JSON.stringify(chat.map((a) => a.text)));
} finally {
  if (!process.env.LIVE_KEEP) {
    await b.stop().catch(() => {});
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
