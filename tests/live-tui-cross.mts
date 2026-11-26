/**
 * Live check: a message from another Claude session (SendMessage to a local session, found with
 * ListAgents) starts a turn in the receiving pane; what the hooks read of it, and where a permission
 * of such a turn and of a subagent in a chat turn goes. Two real `claude` sessions in throwaway tmux
 * panes on their own tmux server, their own state folder, scratch folders as cwd, the cheapest model,
 * permission_mode default. Not part of `npm test`: it needs a logged-in Claude Code and costs a few calls.
 *
 *   npx tsx tests/live-tui-cross.mts
 *
 * 1. A chat turn of the receiver runs a subagent whose Bash call asks: made while the turn runs, the
 *    request is that turn's (a `permission` event of the turn); the model may send the subagent to the
 *    background, and then it asks between turns.
 * 2. The sender's chat turn sends the receiver a message naming it exactly (ListAgents, SendMessage).
 *    The receiver's turn it starts is measured: its Stop marker's `origin_rows` (ANGELIA_TUI_ORIGIN_DEBUG
 *    =keys: field names, tags and attribute names, never words), and what turn-origin made of it. It
 *    must never read as a teammate's message nor as a typed prompt.
 * 3. That message asks for a Bash call: its request between turns is tied to nothing (`work: none`).
 * 4. Mid-turn (fix-044e): the receiver's chat turn runs a long Bash call while the sender's message comes.
 *    The rows it writes into the running turn are measured (rowShapes, field names only), and what the
 *    hook makes of the turn (requestOrigin: `joins`, `joined`). A request made after the message joined
 *    is not that chat turn's: it goes the between-turns way (`self-permission`, `work: none`).
 *
 * The sessions are named fx-cross-*: SendMessage is told the receiver's exact name, so no other session
 * on the machine is messaged. ANGELIA_TMUX_SOCKET picks the tmux server (default
 * angelia-live-cross-<pid>); LIVE_MODEL the model (default haiku). LIVE_KEEP=1 leaves the panes up.
 * Exits 1 when a check fails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socket = process.env.ANGELIA_TMUX_SOCKET && process.env.ANGELIA_TMUX_SOCKET !== 'angelia' ? process.env.ANGELIA_TMUX_SOCKET : `angelia-live-cross-${process.pid}`;
process.env.ANGELIA_TMUX_SOCKET = socket;
process.env.ANGELIA_TUI_ORIGIN_DEBUG = 'keys';
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-live-cross-state-'));
const root = mkdtempSync(join(tmpdir(), 'angelia-live-cross-'));
const recvDir = join(root, 'recv'), sendDir = join(root, 'send');
mkdirSync(recvDir); mkdirSync(sendDir);

const { TuiBrain } = await import('../src/brain/tui.js');
// @ts-expect-error: a plain script, no types
const { requestOrigin, rowShapes } = await import('../scripts/turn-origin.mjs');
const { TMUX_SOCKET } = await import('../src/brain/tmux.js');
if (TMUX_SOCKET !== socket || TMUX_SOCKET === 'angelia') throw new Error('refusing to run on the live tmux socket');

const t0 = Date.now();
const s = () => ((Date.now() - t0) / 1000).toFixed(1);
const profile = (cwd: string) => ({ cwd, permission_mode: 'default', add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60,
  chrome: false, backend: 'claude-code', tui: true, session_prefix: 'fx-cross', model: process.env.LIVE_MODEL ?? 'haiku' }) as never;
// The receiver goes by its pane's name in the session list too (`-n`; Remote Control alone lists it
// under a title of its own): a wrapper in a folder of its own passes it.
const recvSession = { id: crypto.randomUUID(), started: false };
const recvName = (await import('../src/brain/argv.js')).remoteControlName(profile(recvDir), recvSession);
const bin = join(mkdtempSync(join(tmpdir(), 'angelia-live-cross-bin-')), 'claude-named');
writeFileSync(bin, `#!/bin/sh\nexec claude -n '${recvName}' "$@"\n`, { mode: 0o700 });
const recv = new TuiBrain(profile(recvDir), recvSession, { idlePollMs: 300, bin });
const send = new TuiBrain(profile(sendDir), { id: crypto.randomUUID(), started: false }, { idlePollMs: 300 });

const markers: Record<string, unknown>[] = [];
const rb = recv as any;
const read = rb.readMarker.bind(rb);
rb.readMarker = () => {
  const m = read();
  if (m && !markers.some((x) => x.at === m.at)) { const { text, transcript_path: _t, session_id: _s, ...rest } = m; markers.push({ ...rest, chars: String(text ?? '').length }); }
  return m;
};
const recvLog: string[] = [];
recv.on('log', (l: string) => { recvLog.push(l); if (/permission|turn ended|between turns|self-started|unasked/.test(l)) console.log(s(), 'recv log |', l.slice(0, 220)); });
const unasked: { answer: string; text: string }[] = [];
recv.on('unasked', (a: { answer: string; text: string }) => { unasked.push(a); console.log(s(), 'recv unasked |', a.answer, JSON.stringify(a.text).slice(0, 100)); });
const selfAsks: { id: string; tool: string; work: string; preview?: string }[] = [];
recv.on('self-permission', (e: { id: string; tool: string; work: string; preview?: string }) => {
  selfAsks.push(e);
  console.log(s(), 'recv self-permission |', e.tool, e.work, JSON.stringify(e.preview ?? '').slice(0, 120));
  recv.answerPermission(e.id, true);
});

const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(ok ? 'ok   |' : 'FAIL |', what); if (!ok) failures.push(what); };
const until = async (ok: () => boolean, ms: number) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 250)); return ok(); };
/** One chat turn: every permission it asks is approved; the events it yielded. */
async function turn(b: InstanceType<typeof TuiBrain>, text: string) {
  const asked: { tool: string; preview?: string }[] = [];
  let result: any;
  for await (const e of b.turn(text)) {
    if (e.kind === 'permission') { asked.push({ tool: e.tool, preview: e.preview }); console.log(s(), 'turn permission |', e.tool, JSON.stringify(e.preview ?? '').slice(0, 120)); b.answerPermission(e.id, true); }
    else if (e.kind === 'result') result = e;
  }
  return { asked, result };
}

try {
  recv.start(); send.start();
  console.log('tmux socket', socket, 'receiver', recv.name, 'sender', send.name);
  if (!recv.name.startsWith('fx-cross-') || !send.name.startsWith('fx-cross-')) throw new Error('unexpected session names');

  // 1. A subagent's request in a chat turn is the turn's.
  const one = await turn(recv, `Use the Agent tool with subagent_type general-purpose and run_in_background set to false (wait for it to finish) and this task: "Use the Bash tool to run exactly: touch ${join(recvDir, 'sub.txt')} && echo SUB-OK". After it returns, reply with exactly: SUB-DONE.`);
  console.log(s(), 'turn 1 |', JSON.stringify(one.result?.text ?? '').slice(0, 80));
  await until(() => existsSync(join(recvDir, 'sub.txt')) || recvLog.some((l) => /not relayed/.test(l)), 30_000);
  // While the chat turn runs, the subagent's request is the turn's (its hook reads the lead's
  // transcript). The model may send the subagent to the background instead: then its request comes
  // between turns, and only how it went is told.
  const early = selfAsks.length;
  if (one.asked.length) check(early === 0, 'a request made while the chat turn ran came as that turn\'s own');
  else console.log('note | no request while the chat turn ran (the subagent went to the background):', early ? `asked between turns, work ${selfAsks[0].work}` : recvLog.some((l) => /not relayed/.test(l)) ? 'the hook stepped aside (the transcript still showed the chat\'s typed turn)' : 'none seen');
  // A dialog left open by a request the hook stepped aside for would hold the receiver: Esc closes it.
  if (!existsSync(join(recvDir, 'sub.txt'))) { execFileSync('tmux', ['-L', socket, 'send-keys', '-t', recv.name, 'Escape']); await new Promise((r) => setTimeout(r, 3000)); }

  // 2. The sender messages the receiver by its exact name.
  await new Promise((r) => setTimeout(r, 5000));
  const n = markers.length, u = unasked.length;
  const target = join(recvDir, 'cross.txt');
  // The receiver's listing comes in once its Remote Control is up; the sender pages through the list.
  await new Promise((r) => setTimeout(r, 20_000));
  const two = await turn(send, `Load the ListAgents and SendMessage tools with ToolSearch if they are not loaded. Call ListAgents, and call it again with the cursor its last line gives until there are no more pages. Look for the row whose name is exactly "${recv.name}" (as printed, without any [ref]). If it is there, call SendMessage once with "to" set to exactly that name as the row prints it and this message: "Hello from the sender session. Please use the Bash tool to run exactly: touch ${target} && echo CROSS-OK, then reply with exactly: PONG". Never send a message to any other name. Then reply with exactly SENT and the kind label of that row, or NOT-FOUND and how many rows you saw if no row has that exact name.`);
  console.log(s(), 'sender |', JSON.stringify(two.result?.text ?? '').slice(0, 120));
  check(/SENT/.test(two.result?.text ?? ''), 'the sender sent the message');
  check(await until(() => markers.slice(n).some((m) => m.origin !== undefined), 150_000), 'the message started a turn in the receiver');
  await until(() => existsSync(target), 60_000);
  await new Promise((r) => setTimeout(r, 3000));
  for (const m of markers.slice(n)) console.log('marker |', JSON.stringify(m));
  const m = markers.slice(n).find((x) => /cross-session/.test(String(x.origin_why))) ?? markers.slice(n).find((x) => x.origin !== undefined);
  check(m?.origin !== 'prompt', `that turn does not read as typed (${String(m?.origin)}; ${String(m?.origin_why)})`);
  check(!markers.slice(n).some((x) => Array.isArray(x.origin_teammates)), 'no turn of it names a teammate');
  // 3. Its request between turns.
  console.log('self asks |', JSON.stringify(selfAsks.slice(early).map((a) => ({ tool: a.tool, work: a.work }))));
  if (selfAsks.length > early) check(selfAsks.slice(early).every((a) => a.work === 'none'), 'its request is tied to nothing (work none)');
  else console.log('note | the receiver made no request in that turn (it may have refused the other session\'s ask)');
  // The end of step 1's subagent, if it went to the background, may come in this window: it is the
  // chat's own task, and its answer (SUB-DONE) is delivered. Only another answer counts here.
  check(!unasked.slice(u).some((a) => a.answer === 'self' && !/SUB-DONE/.test(a.text)), 'its answer was not delivered as the chat\'s');

  // 4. The same message, into a chat turn that runs.
  await new Promise((r) => setTimeout(r, 5000));
  const k = selfAsks.length;
  const target2 = join(recvDir, 'cross2.txt');
  const transcript = String(rb.transcript);
  // Each opening tag: the enqueue, then the row for the model.
  const crossTags = () => readFileSync(transcript, 'utf8').split('<cross-session-message from=').length;
  const crossAt = crossTags();
  // Not `sleep`: Claude Code blocks a long foreground sleep (measured on 2.1.332), and the turn would end at once.
  const long = turn(recv, 'Use the Bash tool in the foreground (not in the background) to run exactly: ping -c 100 -i 1 127.0.0.1 > /dev/null; echo LONG-OK. Then do what any message you got meanwhile asks, and reply with exactly: LONG-DONE.');
  check(await until(() => /"tool_use"[^\n]*ping -c 100/.test(readFileSync(transcript, 'utf8')), 60_000), 'the receiver\'s chat turn started its long call');
  const four = await turn(send, `Call ListAgents again (page with the cursor until there are no more pages). If a row's name is exactly "${recv.name}", call SendMessage once with "to" set to exactly that name and this message: "Hello again from the sender session. Please use the Bash tool to run exactly: touch ${target2} && echo CROSS2-OK". Never send a message to any other name. Then reply with exactly SENT, or NOT-FOUND.`);
  console.log(s(), 'sender 4 |', JSON.stringify(four.result?.text ?? '').slice(0, 120));
  check(/SENT/.test(four.result?.text ?? ''), 'the sender sent the mid-turn message');
  check(await until(() => crossTags() > crossAt, 120_000), 'the message reached the receiver\'s transcript');
  // Queued first (an enqueue); written as a row for the model at the next tool boundary, while the turn runs.
  check(await until(() => crossTags() > crossAt + 1, 150_000), 'the message was handed to the model');
  // Rows only once they are in the file: what the running turn holds now, and the hook's reading of it.
  const mid = readFileSync(transcript, 'utf8');
  console.log('mid-turn rows |\n  ' + rowShapes(mid, 12, { keys: true }).join('\n  '));
  const o = requestOrigin(mid);
  console.log('mid-turn origin |', JSON.stringify({ origin: o.origin, why: o.origin_why, opened_by: o.opened_by, prompts: o.prompts, joins: o.joins, joined: o.joined }));
  const res = await long;
  console.log(s(), 'turn 4 |', JSON.stringify(res.result?.text ?? '').slice(0, 80));
  console.log('turn 4 rows |\n  ' + rowShapes(readFileSync(transcript, 'utf8'), 24).join('\n  '));
  const late = res.asked.filter((a) => /cross2/.test(String(a.preview ?? '')));
  check(late.length === 0, 'a request for the message\'s ask never came as the chat turn\'s own');
  const ask4 = selfAsks.slice(k).filter((a) => /cross2/.test(String(a.preview ?? '')));
  console.log('self asks 4 |', JSON.stringify(selfAsks.slice(k).map((a) => ({ tool: a.tool, work: a.work }))));
  if (ask4.length) check(ask4.every((a) => a.work === 'none'), 'it went the between-turns way, tied to nothing');
  else console.log('note | no request for the message\'s ask in that turn (the model may not have acted on it, or it came after the turn)');
} finally {
  if (!process.env.LIVE_KEEP) {
    await recv.stop().catch(() => {});
    await send.stop().catch(() => {});
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed', `(${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(failures.length ? 1 : 0);
