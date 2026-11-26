/**
 * Live check of both 0.4.3 features together, on a real `claude` in a throwaway tmux pane: its own
 * tmux socket, its own state folder, a scratch folder as cwd, the cheapest model, acceptEdits (the
 * chat answers each permission request). Not part of `npm test`: it needs a logged-in Claude Code and
 * costs a few calls.
 *
 *   npx tsx tests/live-restart-midturn.mts
 *
 * A chat message starts a turn that runs `sleep 12` three times. A second message is typed into that turn while
 * the sleep runs (midturn). Then the daemon stops for a restart (cutTurns, shutdown) and a new one
 * starts on the same state (restoreTurns): it adopts the running turn (restart-relay), and the turn's
 * one answer, with the second message's word in it, reaches the chat from the new daemon. Checks: the
 * message went into the turn; the turn was adopted, not cut; the old daemon said nothing; the new one
 * delivered the answer with the word. ANGELIA_TMUX_SOCKET picks the tmux server (default
 * angelia-live-restart-midturn-<pid>). LIVE_KEEP=1 leaves the pane up. Exits 1 when a check fails.
 * On a failure it keeps what shows why (keep()): the pane's screen, the reader's state (rows, the
 * quiet-path end, the follow, the marker), the screens the reader kept (idle-open.txt, quiet-empty.txt),
 * the transcript's last rows by kind, and the whole log of both daemons, in <state>/failure/.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socket = process.env.ANGELIA_TMUX_SOCKET && process.env.ANGELIA_TMUX_SOCKET !== 'angelia' ? process.env.ANGELIA_TMUX_SOCKET : `angelia-live-restart-midturn-${process.pid}`;
process.env.ANGELIA_TMUX_SOCKET = socket;
const state = mkdtempSync(join(tmpdir(), 'angelia-live-rm-state-'));
process.env.ANGELIA_STATE_DIR = state;
const cwd = join(mkdtempSync(join(tmpdir(), 'angelia-live-rm-')), 'restart-midturn-live');
mkdirSync(cwd);

const { Config } = await import('../src/instance/config/schema.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { ADOPT_TURNS } = await import('../src/core/cut-turns.js');
const { TMUX_SOCKET } = await import('../src/brain/tmux.js');
if (TMUX_SOCKET !== socket || TMUX_SOCKET === 'angelia') throw new Error('refusing to run on the live tmux socket');

const t0 = Date.now();
const s = () => ((Date.now() - t0) / 1000).toFixed(1);
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(ok ? 'ok   |' : 'FAIL |', what); if (!ok) failures.push(what); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await sleep(250); return f(); };
const msg = (text: string) => ({ platform: 'whatsapp' as const, chat: 'g@g.us', sender: 'boss', senderName: 'Owner', text, isGroup: true, mentioned: true, media: [] });

function daemon(name: string) {
  const cfg = Config.parse({
    profiles: { a: { cwd, tui: true, model: process.env.LIVE_MODEL ?? 'haiku', permission_mode: 'acceptEdits' } },
    routes: [{ platform: 'whatsapp', chat: 'g@g.us', profile: 'a', mention: 'any', owners: ['boss'], allow_from: ['boss'] }],
    defaults: { max_out_per_min: 1000 },
  });
  const sent: string[] = [], log: string[] = [];
  const o = new Orchestrator(cfg, { whatsapp: { send: async (_c: string, text: string) => { sent.push(text); console.log(s(), `${name} sent |`, JSON.stringify(text).slice(0, 200)); } } },
    { stateDir: state, log: (l) => { log.push(l); if (/midturn|went into|restart:|adopt|turn ended|shutdown/.test(l)) console.log(s(), `${name} log |`, l.slice(0, 200)); } });
  // The chat's owner answers every permission request with yes, as a person would.
  const answered = new Set<string>();
  const timer = setInterval(() => {
    for (const line of sent) {
      const id = /\(request ([0-9a-z-]+)\)/.exec(line)?.[1];
      if (id && !answered.has(id)) { answered.add(id); console.log(s(), `${name} answers yes to`, id); void o.handle(msg(`yes ${id}`)); }
    }
  }, 500);
  timer.unref();
  return { o, sent, log, stop: () => clearInterval(timer) };
}

const one = daemon('old');
void one.o.handle(msg('Run the shell command `sleep 12` with the Bash tool three times, one call at a time, never in the background. Then say "done" and repeat word for word any other message you got from me during this turn.'));
// The sleep runs: the second message waits for its moment, then goes into the turn.
await sleep(8000);
void one.o.handle(msg('Second message: the secret word is MANGO.'));
const into = await until(() => one.log.some((l) => /message went into the running turn/.test(l)), 30_000);
check(into, 'the second message went into the running turn');
// A restart in the middle of the turn.
(one.o as any).cutTurns();
await one.o.shutdown();
one.stop();
check(existsSync(join(state, ADOPT_TURNS)), 'the running turn was kept for the next daemon');
const oldSaid = [...one.sent];

const two = daemon('new');

/** What shows why a run failed, before the daemon lets go of the pane: kept in <state>/failure/. */
async function keep(): Promise<void> {
  const out = join(state, 'failure');
  mkdirSync(out, { recursive: true });
  const tmux = (...a: string[]) => { try { return execFileSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' }); } catch (e) { return `(tmux ${a[0]} failed: ${(e as Error).message})`; } };
  const b = [...((two.o as any).brains as Map<string, any>).values()][0];
  const name: string = b?.name ?? tmux('list-sessions', '-F', '#{session_name}').split('\n')[0];
  writeFileSync(join(out, 'pane.txt'), tmux('capture-pane', '-p', '-t', name, '-S', '-80'));
  const st = b && {
    alive: b.alive, rows: b.rows, startState: b.startState, turnSentAt: b.turnSentAt, heldSince: b.heldSince, recording: b.recording,
    quietEnd: b.quietEnd && { ...b.quietEnd, said: String(b.quietEnd.said ?? '').slice(0, 200) }, following: b.following,
    absorbed: b.absorbed, unsure: [...(b.unsure?.values?.() ?? [])], tieKey: b.tieKey, restoredKeys: b.restoredKeys,
    openCalls: [...(b.openCalls?.values?.() ?? [])], at: b.at, from: b.from, transcript: b.transcript,
    marker: existsSync(b.markerPath) ? readFileSync(b.markerPath, 'utf8').slice(0, 2000) : null, now: Date.now(),
  };
  writeFileSync(join(out, 'state.json'), JSON.stringify(st ?? { brain: 'none' }, null, 2));
  const dir = join(state, 'tui', name);
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.txt')) : []) writeFileSync(join(out, `kept-${f}`), readFileSync(join(dir, f)));
  if (b?.transcript && existsSync(b.transcript)) {
    const rows = readFileSync(b.transcript, 'utf8').split('\n').filter(Boolean).slice(-40).map((l) => {
      try { const r = JSON.parse(l); const c = r.message?.content; return `${r.timestamp ?? ''} ${r.type}${r.operation ? `/${r.operation}` : ''}${r.attachment?.type ? `/${r.attachment.type}` : ''} ${Array.isArray(c) ? c.map((x: { type?: string }) => x.type).join(',') : typeof c === 'string' ? `text:${c.slice(0, 60)}` : ''}`; } catch { return '(not json)'; }
    });
    writeFileSync(join(out, 'transcript-tail.txt'), rows.join('\n') + '\n');
  }
  writeFileSync(join(out, 'log-old.txt'), one.log.join('\n') + '\n');
  writeFileSync(join(out, 'log-new.txt'), two.log.join('\n') + '\n');
  console.log(s(), 'kept for the failure:', out);
  console.log(readFileSync(join(out, 'pane.txt'), 'utf8').split('\n').filter((l) => l.trim()).slice(-25).join('\n'));
  console.log(JSON.stringify(st ?? {}, null, 1).slice(0, 3000));
}
const lost = await (two.o as any).restoreTurns();
check(Array.isArray(lost) && lost.length === 0, 'the next daemon adopted the turn (no cut line)');
const got = await until(() => two.sent.some((l) => /MANGO/.test(l)), 120_000);
check(got, 'the turn\'s answer, with the second message\'s word, reached the chat from the new daemon');
if (failures.length) await keep();
check(!oldSaid.some((l) => /done|MANGO/i.test(l)), 'the old daemon sent no answer');
two.stop();
await two.o.shutdown();
if (!process.env.LIVE_KEEP) { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ } }
console.log(failures.length ? `FAILED: ${failures.join('; ')}` : 'all checks passed', `(${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(failures.length ? 1 : 0);
