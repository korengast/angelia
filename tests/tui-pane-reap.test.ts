import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-tui.sh');
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
const hasLsof = (() => { try { execFileSync('lsof', ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return (e as { status?: number }).status !== undefined; } })();

// Own socket and own state dir before tui.js reads them at import, so nothing here can touch a live Angelia.
const socket = `angelia-test-panereap-${process.pid}`;
process.env.ANGELIA_TMUX_SOCKET = socket;
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-panereap-'));
// A brain's transcripts, too: the parked-pane tests write their own.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'angelia-panereap-claude-'));
const tmux = (...a: string[]) => execFileSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' }).trim();
const names = () => { try { return tmux('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean).sort(); } catch { return []; } };
const HOUR = 3600_000;

test('a build is read from a versions folder, and builds compare by number', async () => {
  const { buildIn, paneEndReason } = await import('../src/brain/tui.js');
  assert.equal(buildIn('/Users/example/.local/share/claude/versions/2.1.287'), '2.1.287');
  assert.equal(buildIn('/opt/claude/versions/2.1.310/claude --resume x'), '2.1.310');
  assert.equal(buildIn('/Users/example/.local/bin/claude --resume x'), null, 'the link shows no build');
  assert.equal(buildIn('/x/claude/versions/2.1.310-beta'), null);
  assert.equal(buildIn('/Users/example/.pyenv/versions/1.2.3/bin/python -m server'), null, 'an MCP server\'s runtime is no Claude build');
  const at = (hoursAgo: number) => ({ activity: (Date.now() - hoursAgo * HOUR) / 1000, now: Date.now(), idleHours: 12 });
  assert.equal(paneEndReason({ ...at(13.5), running: null, installed: null }), 'idle 13h');
  assert.equal(paneEndReason({ ...at(2), running: null, installed: null }), null);
  assert.equal(paneEndReason({ ...at(2), running: '2.1.287', installed: '2.1.310' }), 'old build 2.1.287 -> 2.1.310');
  assert.equal(paneEndReason({ ...at(2), running: '2.1.99', installed: '2.1.100' }), 'old build 2.1.99 -> 2.1.100', 'not by text: "99" > "100"');
  assert.equal(paneEndReason({ ...at(2), running: '2.1.310', installed: '2.1.310' }), null);
  assert.equal(paneEndReason({ ...at(2), running: '2.1.311', installed: '2.1.310' }), null, 'newer than installed: kept');
  assert.equal(paneEndReason({ ...at(2), running: '2.1.287', installed: null }), null, 'the installed build unknown: only the idle rule');
  assert.equal(paneEndReason({ activity: 0, now: Date.now(), idleHours: 12, running: null, installed: null }), null, 'no activity read: not taken for ancient');
});

test('the build a process runs is read through the link it was started by (a native install)', { skip: !hasLsof && 'no lsof', timeout: 20_000 }, async (t) => {
  const { paneBuild } = await import('../src/brain/tui.js');
  // Like ~/.local/bin/claude -> ~/.local/share/claude/versions/<x.y.z>: the command line names only the link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-build-')));
  const exe = join(root, 'claude', 'versions', '2.1.287');
  mkdirSync(dirname(exe), { recursive: true }); mkdirSync(join(root, 'bin'));
  // Linux: the runner's copied sleep exits 1 at once (seen in CI), so a copy of node waits there instead.
  const linux = process.platform === 'linux';
  copyFileSync(linux ? process.execPath : '/bin/sleep', exe);
  execFileSync('chmod', ['+x', exe]);
  // macOS kills a copy of a system binary that keeps Apple's signature: sign it for this machine.
  if (process.platform === 'darwin') execFileSync('codesign', ['--force', '-s', '-', exe], { stdio: 'ignore' });
  symlinkSync(exe, join(root, 'bin', 'claude'));
  // The build is read from /proc/<pid>/exe on Linux, lsof elsewhere: the file the link points to.
  const child = spawn(join(root, 'bin', 'claude'), linux ? ['-e', 'setTimeout(() => {}, 30000)'] : ['30'], { stdio: 'ignore' });
  const plain = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); plain.kill('SIGKILL'); });
  await new Promise((r) => setTimeout(r, 300));
  const seen = (): string => {
    let ps = ''; let exe = '';
    try { ps = execFileSync('ps', ['-o', 'pid=,ppid=,args=', '-p', String(child.pid)], { encoding: 'utf8' }); } catch (e) { ps = `ps failed: ${(e as Error).message}`; }
    if (process.platform === 'linux') { try { exe = execFileSync('readlink', [`/proc/${child.pid}/exe`], { encoding: 'utf8' }); } catch (e) { exe = `readlink failed: ${(e as Error).message}`; } }
    return `exit ${child.exitCode} signal ${child.signalCode}; ps: ${ps.trim()}; exe: ${exe.trim()}`;
  };
  assert.equal(await paneBuild(child.pid!), '2.1.287', seen());
  assert.equal(await paneBuild(process.pid), '2.1.287', 'or a process it started');
  assert.equal(await paneBuild(plain.pid!), null, 'nothing from a versions folder');
});

test('idle time is the window\'s last input or output as tmux reports it, not the session\'s creation', { skip: !hasTmux && 'no tmux', timeout: 20_000 }, async (t) => {
  const { paneActivity } = await import('../src/brain/tui.js');
  t.after(() => { try { tmux('kill-server'); } catch { /* already gone */ } });
  // Output two seconds in, then typed keys a second later; neither moves session_activity on tmux 3.7c.
  tmux('new-session', '-d', '-s', 'angelia-x-actv0001', 'sh', '-c', 'sleep 2; echo out; cat');
  const made = Number(tmux('list-sessions', '-F', '#{session_created}'));
  await new Promise((r) => setTimeout(r, 2600));
  const out = (await paneActivity(process.env))!.get('angelia-x-actv0001')!;
  assert.ok(out.activity >= made + 2, `pane output counts: made ${made}, activity ${out.activity}`);
  assert.ok(out.pid > 0);
  await new Promise((r) => setTimeout(r, 1100));
  tmux('send-keys', '-t', 'angelia-x-actv0001', 'x');
  await new Promise((r) => setTimeout(r, 300));
  const typed = (await paneActivity(process.env))!.get('angelia-x-actv0001')!;
  assert.ok(typed.activity > out.activity, `typed keys count: ${out.activity} -> ${typed.activity}`);
});

test('the pane reap ends a pane idle for hours or on an older build, never a busy one, one with a dialog, or one a chat took meanwhile', { skip: !hasTmux && 'no tmux', timeout: 30_000 }, async (t) => {
  const { reapPanes } = await import('../src/brain/tui.js');
  t.after(() => { try { tmux('kill-server'); } catch { /* already gone */ } });
  const pane = (name: string, frame = 'pane-idle.txt') => tmux('new-session', '-d', '-s', name, '-x', '220', '-y', '50', 'env', `FAKE_TUI_FRAME=${frame}`, FAKE);
  pane('angelia-x-idle0001');
  pane('angelia-x-busy0002', 'pane-busy.txt');
  pane('angelia-x-dlog0003', 'pane-permission.txt');
  pane('angelia-x-took0004');
  pane('angelia-x-notlist5');
  await new Promise((r) => setTimeout(r, 500));
  const listed = ['angelia-x-idle0001', 'angelia-x-busy0002', 'angelia-x-dlog0003', 'angelia-x-took0004', 'angelia-x-missing6'].map((name) => ({ name, key: `k-${name}`, bin: FAKE }));
  const asked: string[] = [];
  // Thirteen hours on: every listed pane is past twelve.
  const late = await reapPanes(listed, process.env, { idleHours: 12, now: Date.now() + 13 * HOUR, mayEnd: (p) => { asked.push(p.name); return p.name !== 'angelia-x-took0004'; } });
  assert.deepEqual(late, [{ name: 'angelia-x-idle0001', key: 'k-angelia-x-idle0001', why: 'idle 13h' }]);
  assert.deepEqual(asked, ['angelia-x-idle0001', 'angelia-x-took0004'], 'asked only for idle panes, at the kill');
  assert.deepEqual(names(), ['angelia-x-busy0002', 'angelia-x-dlog0003', 'angelia-x-notlist5', 'angelia-x-took0004']);

  // Now, fresh: only an older build goes; an unreadable one stays.
  pane('angelia-x-old00007');
  pane('angelia-x-unkn0008');
  pane('angelia-x-same0009');
  await new Promise((r) => setTimeout(r, 500));
  const pid = (n: string) => Number(tmux('list-panes', '-t', n, '-F', '#{pane_pid}'));
  const builds = new Map([[pid('angelia-x-old00007'), '2.1.287'], [pid('angelia-x-same0009'), '2.1.310']]);
  let versions = 0;
  const fresh = await reapPanes(['angelia-x-old00007', 'angelia-x-unkn0008', 'angelia-x-same0009'].map((name) => ({ name, key: name, bin: FAKE })), process.env, {
    idleHours: 12, mayEnd: () => true, build: async (p) => builds.get(p) ?? null, installed: async () => { versions++; return '2.1.310'; },
  });
  assert.deepEqual(fresh, [{ name: 'angelia-x-old00007', key: 'angelia-x-old00007', why: 'old build 2.1.287 -> 2.1.310' }]);
  assert.equal(versions, 1, 'claude --version once per sweep');
  assert.ok(names().includes('angelia-x-unkn0008') && names().includes('angelia-x-same0009'));
});

test('a parked pane past the idle hours is ended through the orchestrator, and the next message resumes the conversation', { skip: !hasTmux && 'no tmux', timeout: 60_000 }, async (t) => {
  const { reapPanes } = await import('../src/brain/tui.js');
  const { Orchestrator } = await import('../src/core/orchestrator.js');
  const { transcriptPath } = await import('../src/brain/transcripts.js');
  const { ROW, jsonl } = await import('./tui-stub.js');
  t.after(() => { try { tmux('kill-server'); } catch { /* already gone */ } });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-panereap-cwd-')));
  const cfg = Config.parse({ profiles: { a: { cwd, tui: true } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const o = new Orchestrator(cfg, { telegram: { send: async () => {} } }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-panereap-orch-')), bins: { 'claude-code': FAKE } });
  t.after(() => o.shutdown());
  const key = 'telegram:1';
  const oo = o as any;
  const row = o.map.ensureActive(key, 'hello', 'claude-code');
  o.map.recordTurn(key, row.id, 'hello', 'claude-code'); // a conversation to resume
  const first = await oo.brainFor(key, 'a');
  assert.equal(await first.ready, null);
  const name = first.name as string;
  assert.deepEqual(o.idlePanes(), [], 'a pane a brain holds is not the pane reap\'s');

  await oo.dropBrain(key, false); // the idle reap parks it
  const file = transcriptPath(cwd, row.id);
  assert.deepEqual(o.idlePanes(), [{ name, key, bin: FAKE, transcript: file }]);
  // A task the brain never saw start (one from before a restart) keeps the parked pane.
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, jsonl([ROW.prompt('hello'), ...ROW.background('toolu_sh')]));
  assert.equal(o.mayEndPane(o.idlePanes()[0]), false);
  assert.deepEqual(await reapPanes(o.idlePanes(), process.env, { idleHours: 12, now: Date.now() + 13 * HOUR, mayEnd: (p) => o.mayEndPane(p) }), [], 'a background shell open: kept');
  appendFileSync(file, jsonl([{ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><tool-use-id>toolu_sh</tool-use-id></task-notification>' }]));
  assert.equal(o.mayEndPane(o.idlePanes()[0]), true);
  const ended = await reapPanes(o.idlePanes(), process.env, { idleHours: 12, now: Date.now() + 13 * HOUR, mayEnd: (p) => o.mayEndPane(p) });
  assert.deepEqual(ended.map((p) => p.why), ['idle 13h']);
  for (const p of ended) o.paneEnded(p);
  assert.ok(!names().includes(name));
  assert.equal(oo.parked.size, 0, 'the parked brain went with its pane');
  assert.deepEqual(await reapPanes(o.idlePanes(), process.env, { idleHours: 12, now: Date.now() + 13 * HOUR, mayEnd: (p) => o.mayEndPane(p) }), [], 'nothing left to end: the chat\'s session has no pane until its next message');

  // The next message: a new brain, a new pane, the same conversation.
  const next = await oo.brainFor(key, 'a');
  assert.notEqual(next, first);
  assert.equal(await next.ready, null);
  assert.match(tmux('list-panes', '-t', name, '-F', '#{pane_start_command}'), new RegExp(`--resume ${row.id}`));
  assert.equal(o.mayEndPane({ name, key }), false, 'a chat a brain holds is never ended');
});

test('a pane that lists a teammate is kept, idle or old', { skip: !hasTmux && 'no tmux', timeout: 30_000 }, async (t) => {
  const { reapPanes } = await import('../src/brain/tui.js');
  const { listsTeammates } = await import('../src/brain/tmux.js');
  const frame = (n: string) => readFileSync(join(here, 'fixtures', n), 'utf8');
  assert.equal(listsTeammates(frame('pane-busy-teammates.txt')), true);
  assert.equal(listsTeammates(frame('pane-busy-teammates-4.txt')), true);
  assert.equal(listsTeammates(frame('pane-idle.txt')), false);
  t.after(() => { try { tmux('kill-server'); } catch { /* already gone */ } });
  // The idle screen with a teammate's row under the box.
  const file = join(process.env.ANGELIA_STATE_DIR!, 'idle-teammate.txt');
  writeFileSync(file, `${frame('pane-idle.txt').replace(/\n+$/, '')}\n\n  ⏺ main\n  ◯ probe  Slow no-op      21s · ↓ 87.0k tokens\n`);
  tmux('new-session', '-d', '-s', 'angelia-x-mate0010', '-x', '220', '-y', '50', `cat '${file}'; sleep 60`);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(await reapPanes([{ name: 'angelia-x-mate0010', key: 'k' }], process.env, { idleHours: 12, now: Date.now() + 13 * HOUR, mayEnd: () => true }), []);
});

test('a pane let go of with a teammate open is not the pane reap\'s', async () => {
  const { Orchestrator } = await import('../src/core/orchestrator.js');
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-panereap-cwd-')));
  const cfg = Config.parse({ profiles: { a: { cwd, tui: true } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }] });
  const o = new Orchestrator(cfg, { telegram: { send: async () => {} } }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-panereap-orch-')), bins: { 'claude-code': FAKE } });
  const oo = o as any;
  const stub = (mates: number) => ({ name: 'angelia-a-x', alive: true, openTaskCount: () => mates, release: async () => {}, stop: async () => {} });
  oo.brains.set('telegram:1', stub(1));
  await oo.dropBrain('telegram:1', false);
  assert.deepEqual(o.idlePanes(), []);
  assert.equal(o.idlePanes(Date.now() + 13 * HOUR).length, 1, 'a teammate past its longest time holds nothing');
  oo.brains.set('telegram:1', stub(0));
  await oo.dropBrain('telegram:1', false);
  assert.equal(o.idlePanes().length, 1);
});

test('the open tasks a transcript leaves: a background shell or subagent with no end read, younger than the longest a teammate is kept', async () => {
  const { openTasksInTranscript } = await import('../src/brain/tui.js');
  const { ROW, jsonl } = await import('./tui-stub.js');
  const dir = mkdtempSync(join(tmpdir(), 'angelia-opentasks-'));
  const file = join(dir, 's.jsonl');
  assert.equal(openTasksInTranscript(file), null, 'no file: nobody can tell');
  const end = (id: string) => ({ type: 'queue-operation', operation: 'enqueue', content: `<task-notification><tool-use-id>${id}</tool-use-id></task-notification>` });
  const agent = (id: string) => [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { prompt: 'p', run_in_background: true } }] } },
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'launched' }] }, toolUseResult: { status: 'async_launched' } },
  ];
  writeFileSync(file, jsonl([ROW.prompt('hi'), ...ROW.background('toolu_sh'), ...agent('toolu_ag'), ROW.call('toolu_fg'), ROW.result('toolu_fg')]));
  assert.equal(openTasksInTranscript(file), 2, 'a shell and a subagent open; a foreground call is no task');
  appendFileSync(file, jsonl([end('toolu_sh')]));
  assert.equal(openTasksInTranscript(file), 1, 'the file grew: read again');
  appendFileSync(file, jsonl([end('toolu_ag')]));
  assert.equal(openTasksInTranscript(file), 0);
  // Only the file's end is read: a start before it is not seen.
  const big = join(dir, 'big.jsonl');
  writeFileSync(big, jsonl(ROW.background('toolu_early')) + `${JSON.stringify({ pad: 'x'.repeat(9 * 1024 * 1024) })}\n` + jsonl(ROW.background('toolu_late')));
  assert.equal(openTasksInTranscript(big), 1);
  // A start older than the longest time holds nothing, by its row's own time.
  const old = new Date(Date.now() - 13 * HOUR).toISOString();
  writeFileSync(join(dir, 'old.jsonl'), jsonl(ROW.background('toolu_old').map((r) => ({ ...r, timestamp: old }))));
  assert.equal(openTasksInTranscript(join(dir, 'old.jsonl')), 0);
});

test('after a restart, a pane whose transcript shows a task open is kept, and one whose transcript cannot be read; with every task over it ends', { skip: !hasTmux && 'no tmux', timeout: 30_000 }, async (t) => {
  const { reapPanes } = await import('../src/brain/tui.js');
  const { remoteControlName } = await import('../src/brain/argv.js');
  const { Orchestrator } = await import('../src/core/orchestrator.js');
  const { projectFolder } = await import('../src/brain/transcripts.js');
  const { ROW, jsonl } = await import('./tui-stub.js');
  t.after(() => { try { tmux('kill-server'); } catch { /* already gone */ } });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-panereap-cwd-')));
  const root = mkdtempSync(join(tmpdir(), 'angelia-panereap-projects-'));
  const cfg = Config.parse({ profiles: { a: { cwd, tui: true } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const logs: string[] = [];
  // A new daemon: the chat's active session has a pane, and no brain of this daemon knows it.
  const o = new Orchestrator(cfg, { telegram: { send: async () => {} } }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-panereap-orch-')), bins: { 'claude-code': FAKE }, transcripts: root, log: (l: string) => logs.push(l) });
  t.after(() => o.shutdown());
  const key = 'telegram:1';
  const row = o.map.ensureActive(key, 'hello', 'claude-code');
  o.map.recordTurn(key, row.id, 'hello', 'claude-code');
  const name = remoteControlName(cfg.profiles.a, { id: row.id, started: row.started });
  tmux('new-session', '-d', '-s', name, '-x', '220', '-y', '50', 'env', 'FAKE_TUI_FRAME=pane-idle.txt', FAKE);
  await new Promise((r) => setTimeout(r, 500));
  const file = join(root, projectFolder(cwd), `${row.id}.jsonl`);
  const listed = o.idlePanes();
  assert.deepEqual(listed.map((p) => [p.name, p.transcript]), [[name, file]]);
  const sweep = () => reapPanes(o.idlePanes(), process.env, { idleHours: 12, now: Date.now() + 13 * HOUR, mayEnd: (p) => o.mayEndPane(p) });

  assert.deepEqual(await sweep(), [], 'no transcript: kept');
  assert.equal(o.mayEndPane(o.idlePanes()[0], Date.now() + 13 * HOUR), true, 'unreadable past the longest a task is held: ended');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, jsonl([ROW.prompt('hello'), ...ROW.background('toolu_sh')]));
  assert.deepEqual(await sweep(), [], 'a background shell open: kept');
  assert.deepEqual(await sweep(), []);
  assert.equal(logs.filter((l) => l.includes(`pane ${name}`) && l.includes('1 background task(s) open')).length, 1, 'logged once');
  assert.ok(names().includes(name));
  appendFileSync(file, jsonl([{ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><tool-use-id>toolu_sh</tool-use-id></task-notification>' }]));
  assert.deepEqual((await sweep()).map((p) => p.why), ['idle 13h'], 'its task over: ended');
  assert.ok(!names().includes(name));
});
