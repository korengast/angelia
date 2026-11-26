/**
 * Live check: a permission request in a turn the agent starts by itself, between the chat's turns,
 * goes the profile's way (`permissions`), as one in a chat turn does. A real `claude` in a throwaway
 * tmux pane under a real Orchestrator: its own tmux server, its own state folder, a scratch folder as
 * cwd, the cheapest model, permission_mode default (every Bash call asks). Not part of `npm test`: it
 * needs a logged-in Claude Code and costs a few calls.
 *
 *   LIVE_POLICY=approve npx tsx tests/live-tui-between.mts
 *   LIVE_POLICY=ask npx tsx tests/live-tui-between.mts
 *
 * A chat turn starts `sleep 20` in the background and ends. The task's end wakes the agent by itself; its next Bash call (`cd <cwd> && git add ... && git
 * commit`, the cd+git shape of the report) asks for a permission between turns. approve: it is
 * approved at once ("permission auto-approved ... between turns" in the log) and the command runs.
 * ask: the stub chat gets the request line, the owner's "yes <id>" answers it, and the command runs.
 * Then a person types into the pane, narrowed to 80 columns: that turn is theirs, so the hook steps
 * aside and Claude asks in its own dialog (its options wrap); the chat is told of that dialog once
 * (the screen notice, core/screen-asks.ts), and no key is pressed.
 *
 * ANGELIA_TMUX_SOCKET picks the tmux server (default angelia-live-between-<pid>); LIVE_MODEL the model
 * (default haiku). LIVE_KEEP=1 leaves the pane up. Exits 1 when a check fails.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socket = process.env.ANGELIA_TMUX_SOCKET && process.env.ANGELIA_TMUX_SOCKET !== 'angelia' ? process.env.ANGELIA_TMUX_SOCKET : `angelia-live-between-${process.pid}`;
process.env.ANGELIA_TMUX_SOCKET = socket;
const state = mkdtempSync(join(tmpdir(), 'angelia-live-between-state-'));
process.env.ANGELIA_STATE_DIR = state;
const cwd = join(mkdtempSync(join(tmpdir(), 'angelia-live-between-')), 'between-live');
mkdirSync(cwd);
execFileSync('git', ['init', '-q', cwd]);
execFileSync('git', ['-C', cwd, 'config', 'user.email', 'live@example.invalid']);
execFileSync('git', ['-C', cwd, 'config', 'user.name', 'Live check']);
writeFileSync(join(cwd, 'note.txt'), 'between\n');
const policy = process.env.LIVE_POLICY === 'ask' ? 'ask' : 'approve';

const { Config } = await import('../src/instance/config/schema.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { TMUX_SOCKET } = await import('../src/brain/tmux.js');
if (TMUX_SOCKET !== socket || TMUX_SOCKET === 'angelia') throw new Error('refusing to run on the live tmux socket');

const t0 = Date.now();
const s = () => ((Date.now() - t0) / 1000).toFixed(1);
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(ok ? 'ok   |' : 'FAIL |', what); if (!ok) failures.push(what); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms: number) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await sleep(250); return f(); };
const msg = (text: string) => ({ platform: 'whatsapp' as const, chat: 'g@g.us', sender: 'boss', senderName: 'Owner', text, isGroup: true, mentioned: true, media: [], at: Date.now() });

// The chat turn's `sleep` asks nothing in Claude Code 2.1.332 (a read-only command); were it to ask, the
// rule approves it. The request between turns goes by `policy`.
const cfg = Config.parse({
  profiles: { a: { cwd, tui: true, model: process.env.LIVE_MODEL ?? 'haiku', permission_mode: 'default', permissions: { default: policy, approve: ['Bash(sleep *)'] } } },
  routes: [{ platform: 'whatsapp', chat: 'g@g.us', profile: 'a', mention: 'any', owners: ['boss'], allow_from: ['boss'] }],
  defaults: { max_out_per_min: 1000 },
});
const sent: string[] = [], log: string[] = [];
const o = new Orchestrator(cfg, { whatsapp: { send: async (_c: string, text: string) => { sent.push(text); console.log(s(), 'sent |', JSON.stringify(text).slice(0, 220)); } } },
  { stateDir: state, bareAnswerMinMs: 0, log: (l) => { log.push(l); if (/permission|turn ended|between turns|dialog|self-started|background/.test(l)) console.log(s(), 'log  |', l.slice(0, 220)); } });
const scan = setInterval(() => void o.scanDialogs().catch(() => {}), 2000);
scan.unref();
const pane = () => { try { return execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', (o as any).brains.get('whatsapp:g@g.us')?.name ?? '', '-S', '-30'], { encoding: 'utf8' }); } catch { return ''; } };

try {
  void o.handle(msg('Use the Bash tool to run `sleep 20` with run_in_background set to true. Then reply with exactly: started. Do not wait for it. Later, when that background command completes, use the Bash tool to run exactly `cd ' + cwd + ' && git add note.txt && git commit -q -m between && git log --oneline | wc -l` (one call, as written), and then reply with exactly: BETWEEN-DONE followed by what it printed.'));
  // Its words vary with the model ("started", "Waiting for the sleep..."): any answer ends it.
  check(await until(() => log.some((l) => /turn ended by the Stop marker/.test(l)) && sent.length > 0, 120_000), 'the chat turn ended and answered');
  if (policy === 'approve') {
    check(await until(() => log.some((l) => /permission auto-approved .*between turns/.test(l)), 120_000), 'the request between turns was approved by the profile\'s level (log line)');
  } else {
    const line = await until(() => sent.some((l) => /\(request [0-9a-z-]+\)/.test(l) && /git commit/.test(l)), 120_000);
    check(line, 'the stub chat got the request between turns');
    const id = /\(request ([0-9a-z-]+)\)/.exec(sent.find((l) => /\(request [0-9a-z-]+\)/.test(l) && /git commit/.test(l)) ?? '')?.[1];
    if (id) { console.log(s(), 'owner answers yes to', id); await o.handle(msg(`yes ${id}`)); }
  }
  check(await until(() => sent.some((l) => /BETWEEN-DONE/.test(l)), 90_000), 'the command ran and its answer reached the chat');
  check(!sent.some((l) => /did not come through/.test(l)), 'no screen-only line for a request that came through');

  // A person types into the pane, narrowed to 80 columns as a small terminal attached to it would: that
  // turn is theirs, so the hook steps aside and Claude asks in its own dialog, whose options wrap. The
  // chat is told of that dialog once, and nothing presses a key.
  const name = (o as any).brains.get('whatsapp:g@g.us')?.name as string;
  execFileSync('tmux', ['-L', socket, 'resize-window', '-t', name, '-x', '80', '-y', '40']);
  const m = log.length, k = sent.length;
  execFileSync('tmux', ['-L', socket, 'send-keys', '-t', name, '-l', `Use the Bash tool to run exactly: cd ${cwd} && git commit --allow-empty -q -m typed`]);
  await sleep(500);
  execFileSync('tmux', ['-L', socket, 'send-keys', '-t', name, 'Enter']);
  check(await until(() => log.slice(m).some((l) => /in a turn a person typed .*not relayed/.test(l)), 90_000), 'a request in a turn a person typed is not relayed (the hook steps aside)');
  check(await until(() => sent.slice(k).some((l) => l.startsWith('A permission waits: Bash command')), 60_000), 'the chat is told of the dialog only the screen shows');
  await sleep(15_000);
  check(sent.slice(k).filter((l) => l.startsWith('A permission waits')).length === 1, 'told once');
  check(/Do you want to proceed\?/.test(pane()), 'the dialog is still open: no key was pressed');
  console.log('pane |', pane().split('\n').slice(-14).join('\n       '));
} finally {
  clearInterval(scan);
  await o.shutdown().catch(() => {});
  if (!process.env.LIVE_KEEP) { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ } }
}
console.log(failures.length ? `FAILED: ${failures.join('; ')}` : 'all checks passed', `(${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(failures.length ? 1 : 0);
