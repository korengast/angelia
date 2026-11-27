/**
 * Live check of the dead pane of 0.4.10 (a customer's server, 2026-11-27): a warm tmux chat whose
 * session is gone (killed, crashed) failed the next message with "Something broke on my side", since
 * the pane was launched only at the brain's start. A real `claude` in a throwaway pane under a real
 * Orchestrator: its own tmux server, its own state folder, a scratch folder as cwd, the cheapest model.
 * Not part of `npm test`: it needs a logged-in Claude Code and costs a few calls.
 *
 *   ANGELIA_TMUX_SOCKET=dead-test npx tsx tests/live-tui-dead-pane.mts
 *
 * One message warms the chat. Then `tmux kill-session` on its pane, and at once the next message: the
 * pane is launched again with --resume (log line), the message is answered in the same conversation
 * (it names a word from the first), and no failure line reaches the chat.
 *
 * ANGELIA_TMUX_SOCKET picks the tmux server (default angelia-live-dead-<pid>); LIVE_MODEL the model
 * (default haiku). LIVE_KEEP=1 leaves the pane up. Exits 1 when a check fails.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socket = process.env.ANGELIA_TMUX_SOCKET && process.env.ANGELIA_TMUX_SOCKET !== 'angelia' ? process.env.ANGELIA_TMUX_SOCKET : `angelia-live-dead-${process.pid}`;
process.env.ANGELIA_TMUX_SOCKET = socket;
const state = mkdtempSync(join(tmpdir(), 'angelia-live-dead-state-'));
process.env.ANGELIA_STATE_DIR = state;
const cwd = join(mkdtempSync(join(tmpdir(), 'angelia-live-dead-')), 'dead-live');
mkdirSync(cwd);

const { Config } = await import('../src/instance/config/schema.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { TMUX_SOCKET } = await import('../src/brain/tmux.js');
if (TMUX_SOCKET !== socket || TMUX_SOCKET === 'angelia' || socket.startsWith('angelia-canary')) throw new Error('refusing to run on the live or the canary tmux socket');

const t0 = Date.now();
const s = () => ((Date.now() - t0) / 1000).toFixed(1);
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(ok ? 'ok   |' : 'FAIL |', what); if (!ok) failures.push(what); };
const tmux = (...a: string[]) => execFileSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' }).trim();
const msg = (text: string) => ({ platform: 'telegram' as const, chat: '1', sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [], at: Date.now() });

const cfg = Config.parse({
  profiles: { a: { cwd, tui: true, model: process.env.LIVE_MODEL ?? 'haiku', permission_mode: 'default' } },
  routes: [{ platform: 'telegram', chat: 1, profile: 'a' }],
  defaults: { max_out_per_min: 1000 },
});
const sent: string[] = [], log: string[] = [];
const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); console.log(s(), 'sent |', JSON.stringify(text).slice(0, 160)); } } },
  { stateDir: state, bareAnswerMinMs: 0, log: (l) => { log.push(l); if (/tmux:|turn ended|launch|pane|retry/.test(l)) console.log(s(), 'log  |', l.slice(0, 200)); } });

try {
  await o.handle(msg('Remember the word PELICAN. Reply with exactly: noted.'));
  check(sent.length > 0 && !sent.some((l) => l.startsWith('Something broke')), 'the first message is answered');
  const name = (o as any).brains.get('telegram:1')?.name as string;
  const pid = tmux('list-panes', '-t', `=${name}:`, '-F', '#{pane_pid}');
  // The session goes, as a crash or a kill would end it; the next message comes at once.
  tmux('kill-session', '-t', `=${name}`);
  console.log(s(), 'killed', name);
  const k = sent.length;
  await o.handle(msg('What word did I ask you to remember? Reply with that word only.'));
  const after = sent.slice(k);
  check(!after.some((l) => l.startsWith('Something broke')), 'no failure line');
  check(after.some((l) => /pelican/i.test(l)), 'the message is answered, in the same conversation');
  check(log.some((l) => new RegExp(`tmux: the session of pane ${name} is gone before the message was typed; launched again \\(resume\\)`).test(l)), 'the pane was launched again, resumed (log line)');
  let pid2 = '';
  try { pid2 = tmux('list-panes', '-t', `=${name}:`, '-F', '#{pane_pid}'); } catch { /* gone */ }
  check(pid2 !== '' && pid2 !== pid, 'a new pane under the same name');
  check(/--resume/.test(tmux('list-panes', '-t', `=${name}:`, '-F', '#{pane_start_command}')), 'started with --resume');
} finally {
  await o.shutdown().catch(() => {});
  if (!process.env.LIVE_KEEP) { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ } }
}
console.log(failures.length ? `FAILED: ${failures.length}` : 'all checks passed');
process.exit(failures.length ? 1 : 0);
