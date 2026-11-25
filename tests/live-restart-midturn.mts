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
 * delivered the answer with the word. LIVE_KEEP=1 leaves the pane up. Exits 1 when a check fails.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socket = `angelia-live-restart-midturn-${process.pid}`;
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
const lost = await (two.o as any).restoreTurns();
check(Array.isArray(lost) && lost.length === 0, 'the next daemon adopted the turn (no cut line)');
const got = await until(() => two.sent.some((l) => /MANGO/.test(l)), 120_000);
check(got, 'the turn\'s answer, with the second message\'s word, reached the chat from the new daemon');
check(!oldSaid.some((l) => /done|MANGO/i.test(l)), 'the old daemon sent no answer');
two.stop();
await two.o.shutdown();
if (!process.env.LIVE_KEEP) { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ } }
console.log(failures.length ? `FAILED: ${failures.join('; ')}` : 'all checks passed', `(${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(failures.length ? 1 : 0);
