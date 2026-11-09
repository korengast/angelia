import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../src/instance/config/schema.js';
import { buildJobPlist, jobHash, jobLabel, jobPlistPath, logJob, readJobs, JOBS_FILE } from '../src/jobs/jobs.js';
import { installTimers, jobsState, runAndReport } from '../src/jobs/jobs-cli.js';
import { jobsView, lastRuns } from '../src/jobs/jobs-view.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'angelia-once-'));
const AT = '2030-06-01 09:00';
const moment = new Date(2030, 5, 1, 9, 0);
const plus = (ms: number) => new Date(moment.getTime() + ms);
const H = 3600_000;

function rig(yaml: string, routes = [{ platform: 'whatsapp', chat: 'g@g.us', profile: 'p' }]) {
  const cwd = tmp();
  const state = tmp();
  writeFileSync(join(cwd, JOBS_FILE), yaml);
  const cfg = Config.parse({ profiles: { p: { cwd } }, routes });
  return { cwd, state, cfg };
}

/** One record of everything a run does, in order: deliveries, unloads, and what jobs.log held at the unload. */
function run(r: ReturnType<typeof rig>, fail?: (text: string) => boolean) {
  const events: string[] = [];
  const log = () => (existsSync(join(r.state, 'jobs.log')) ? readFileSync(join(r.state, 'jobs.log'), 'utf8') : '');
  return {
    events,
    log,
    /** `once`: the date a one-time job's timer carries (--once). */
    go: (job: string, hash: string | undefined, now: Date, once?: string) => runAndReport(r.cfg, 'p', job, hash, {
      stateDir: r.state, now, once,
      deliver: async (kind, key, text) => { events.push(`${kind} ${key} ${text}`); if (fail?.(text)) throw new Error('the daemon did not answer'); },
      unload: (label) => events.push(`unload ${label} after log: ${log().trim().split('\n').pop()}`),
    }),
  };
}

const hashOf = (r: ReturnType<typeof rig>, job: string) => jobHash(readJobs(r.cfg, 'p').jobs[job]!);

test('a one-time timer removes itself after its run, last, and only from a timer', async () => {
  const r = rig(`jobs:\n  once: {at: "${AT}", send: hi}\n  tick: {every: 1h, send: tock}\n`);
  const x = run(r);
  assert.equal(await x.go('once', hashOf(r, 'once'), plus(5_000), AT), 'sent to whatsapp:g@g.us');
  assert.deepEqual(x.events, ['send whatsapp:g@g.us hi', `unload ${jobLabel('p', 'once')} after log: ${x.log().trim().split('\n').pop()}`]);
  assert.match(x.events[1]!, /p\/once sent to whatsapp:g@g.us$/, 'the log line is written before the unload');
  x.events.length = 0;
  await x.go('once', undefined, plus(5_000));
  await x.go('tick', hashOf(r, 'tick'), plus(5_000));
  assert.deepEqual(x.events, ['send whatsapp:g@g.us hi', 'send whatsapp:g@g.us tock'], 'by hand, or not an at: job: no unload');
});

test('a timer that fires before the date: logged only, timer kept; a minute early still runs', async () => {
  const r = rig(`jobs:\n  once: {at: "${AT}", send: hi}\n`);
  const x = run(r);
  assert.match(await x.go('once', hashOf(r, 'once'), plus(-365 * 24 * H), AT), /^early: job p\/once is due at 2030-06-01 09:00, not before/);
  assert.deepEqual(x.events, [], 'no chat line, no unload');
  assert.match(x.log(), /p\/once early: /);
  await assert.rejects(x.go('once', undefined, plus(-H)), /due at 2030-06-01 09:00, not before/, 'by hand it is refused and said');
  assert.deepEqual(x.events, []);
  assert.equal(await x.go('once', hashOf(r, 'once'), plus(-30_000), AT), 'sent to whatsapp:g@g.us', 'a timer 30 s early is not refused');
});

test('after its moment the timer goes in every outcome: a failure, a refusal, a missed time', async () => {
  const r = rig(`jobs:\n  once: {at: "${AT}", send: hi}\n`);
  const label = jobLabel('p', 'once');
  const x = run(r, (t) => t === 'hi');
  const hash = hashOf(r, 'once');
  await assert.rejects(x.go('once', hash, plus(5_000), AT), /did not answer/);
  assert.deepEqual(x.events.map((e) => e.replace(/ after log: .*/, '')), ['send whatsapp:g@g.us hi', 'send whatsapp:g@g.us Scheduled job once did not run: the daemon did not answer', `unload ${label}`]);
  assert.match(x.events[2]!, /error: the daemon did not answer$/);

  const y = run(r);
  await assert.rejects(y.go('once', 'not-the-hash', plus(5_000), AT), /changed since it was installed/);
  assert.match(y.events[0]!, /Scheduled job once did not run: .*changed since/);
  assert.equal(y.events[1]?.startsWith(`unload ${label}`), true, 'a refused run after its moment removes the timer too');

  const z = run(r);
  await assert.rejects(z.go('once', hash, plus(13 * H), AT), /more than 12 h after that/);
  assert.deepEqual(z.events.map((e) => e.replace(/ after log: .*/, '')), [
    'send whatsapp:g@g.us Scheduled job once missed its time, 2030-06-01 09:00: the Mac was asleep, off or logged out then, so it does not run.',
    `unload ${label}`,
  ]);
  assert.match(z.log(), /p\/once missed: /);
  assert.equal(await z.go('once', undefined, plus(13 * H)), 'sent to whatsapp:g@g.us', 'by hand a missed job still runs');
  assert.equal(await run(r).go('once', hash, plus(11 * H), AT), 'sent to whatsapp:g@g.us', 'within the grace a late fire (a wake) runs');
});

test('a job file edited during a run that worked posts no failure line', async () => {
  const r = rig(`jobs:\n  once: {at: "${AT}", send: hi}\n`);
  const events: string[] = [];
  const line = await runAndReport(r.cfg, 'p', 'once', hashOf(r, 'once'), {
    stateDir: r.state, now: plus(1_000), once: AT,
    deliver: async (_k, _c, text) => { events.push(text); writeFileSync(join(r.cfg.profiles.p!.cwd, JOBS_FILE), 'jobs: [broken'); },
    unload: (l) => events.push(`unload ${l}`),
  });
  assert.equal(line, 'sent to whatsapp:g@g.us');
  assert.deepEqual(events, ['hi', `unload ${jobLabel('p', 'once')}`]);
});

test('install skips a past one-time job, removes a timer left for it, and the list says done or passed', () => {
  const r = rig([
    'jobs:',
    `  ran: {at: "${AT}", send: a}`,
    `  missed: {at: "${AT}", send: b}`,
    '  later: {at: "2031-01-01 08:00", send: c}',
    `  off: {at: "${AT}", send: d, enabled: false}`,
  ].join('\n'));
  const home = tmp();
  const table = join(r.state, 'routing.yaml');
  const jobs = readJobs(r.cfg, 'p').jobs;
  const left = jobLabel('p', 'missed');
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(jobPlistPath(left, home), buildJobPlist({ label: left, node: '/n', entry: '/e', profile: 'p', job: 'missed', hash: jobHash(jobs.missed!), config: table, stateDir: r.state, path: '/usr/bin', home, cwd: r.cfg.profiles.p!.cwd, j: jobs.missed! }));
  writeFileSync(join(r.state, 'jobs.log'), [
    '2030-05-01T07:00:00.000Z p/ran early: job p/ran is due at 2030-06-01 09:00, not before',
    `${plus(2_000).toISOString()} p/ran sent to whatsapp:g@g.us`,
    `${plus(2_000).toISOString()} p/missed error: the daemon did not answer`,
  ].join('\n') + '\n');
  const at = { stateDir: r.state, home, now: plus(24 * H) };

  const before = jobsState(r.cfg, table, ['p'], at);
  // The state column of `angelia jobs`: after a name of 18 and a when of 22, 13 wide.
  const state = (lines: string[], name: string) => lines.find((l) => l.startsWith(`  ${name} `))?.slice(44, 57).trim();
  assert.deepEqual(['ran', 'missed', 'later', 'off'].map((n) => state(before.lines, n)), ['done', 'passed', 'not installed', 'disabled']);
  assert.equal(before.drift, 2, 'the later job is not installed, and a timer is left for a past one');

  const calls: string[] = [];
  const out = installTimers(r.cfg, table, ['p'], at, { load: (l) => calls.push(`load ${l}`), unload: (l) => calls.push(`unload ${l}`), loaded: () => false });
  assert.deepEqual(calls, [`unload ${left}`, `load ${jobLabel('p', 'later')}`]);
  assert.deepEqual(out, [
    `removed ${left}: at ${AT} has passed, and it did not run (missed)`,
    // 'ran' had no timer left: nothing to say, the list shows it.
    `installed ${jobLabel('p', 'later')}: at 2031-01-01 08:00 → whatsapp:g@g.us, send "c"`,
    'Timers match the job files.',
  ]);
  const later = readFileSync(jobPlistPath(jobLabel('p', 'later'), home), 'utf8');
  assert.match(later, /<key>Month<\/key><integer>1<\/integer><key>Day<\/key><integer>1<\/integer><key>Hour<\/key><integer>8<\/integer>/);
  assert.match(later, /<string>--hash<\/string>\s*<string>[0-9a-f]+<\/string>\s*<string>--once<\/string>\s*<string>2031-01-01 08:00<\/string>/, 'the timer carries its date');

  const v = jobsView(r.cfg, 'p', r.state, home, plus(24 * H));
  assert.deepEqual(v.jobs.map((j) => [j.name, j.state]), [['ran', 'done'], ['missed', 'passed'], ['later', undefined], ['off', undefined]]);
  assert.equal(jobsView(r.cfg, 'p', r.state, home, plus(-H)).jobs[0]?.state, undefined, 'before its moment it has no state');
});

test('the timer knows it is one-time from its own date, whatever the file says by the fire', async () => {
  const yaml = `jobs:\n  once: {at: "${AT}", send: hi}\n`;
  const label = jobLabel('p', 'once');
  const r = rig(yaml);
  const hash = hashOf(r, 'once');
  const strip = (e: string[]) => e.map((x) => x.replace(/ after log: .*/, ''));

  writeFileSync(join(r.cwd, JOBS_FILE), 'jobs: [broken');
  const x = run(r);
  await assert.rejects(x.go('once', hash, plus(5_000), AT));
  assert.equal(strip(x.events).length, 2);
  assert.match(x.events[0]!, /^send whatsapp:g@g.us Scheduled job once did not run: /, 'with no job to read, said in the profile\'s one chat');
  assert.equal(strip(x.events)[1], `unload ${label}`, 'a file that broke still lets the timer go');

  const two = rig('jobs: [broken', [{ platform: 'whatsapp', chat: 'a@g.us', profile: 'p' }, { platform: 'telegram', chat: '5', profile: 'p' }]);
  const y = run(two);
  await assert.rejects(y.go('once', hash, plus(5_000), AT));
  assert.deepEqual(strip(y.events), [`unload ${label}`], 'two chats and no job to say which: log only');

  writeFileSync(join(r.cwd, JOBS_FILE), 'jobs:\n  once: {schedule: "0 9 * * *", send: hi}\n');
  const z = run(r);
  await assert.rejects(z.go('once', hash, plus(5_000), AT), /changed since it was installed/);
  assert.equal(strip(z.events)[1], `unload ${label}`, 'at: edited to schedule: without install: the old timer still goes');

  // A year-early fire is checked against the timer's date before the file: quiet, and the timer kept.
  writeFileSync(join(r.cwd, JOBS_FILE), 'jobs:\n  once: {at: "2030-06-01 09:00", send: "something else"}\n');
  const w = run(r);
  assert.match(await w.go('once', hash, plus(-365 * 24 * H), AT), /^early: /);
  assert.deepEqual(w.events, []);
});

test('done survives jobs.log growing, and a Hebrew or dotted profile name is read from it', async () => {
  const r = rig(`jobs:\n  once: {at: "${AT}", send: hi}\n`);
  const home = tmp();
  const table = join(r.state, 'routing.yaml');
  await run(r).go('once', hashOf(r, 'once'), plus(5_000), AT);
  assert.ok(existsSync(join(r.state, 'jobs-once.json')));
  const filler = `${plus(H).toISOString()} other/tick sent to whatsapp:x@g.us ${'x'.repeat(200)}\n`;
  appendFileSync(join(r.state, 'jobs.log'), filler.repeat(Math.ceil((600 * 1024) / filler.length)));
  assert.equal(lastRuns(r.state).get('p/once'), undefined, 'the run line is past the tail read');
  const at = { stateDir: r.state, home, now: plus(24 * H) };
  assert.match(jobsState(r.cfg, table, ['p'], at).lines.find((l) => l.startsWith('  once '))!, / done /);
  assert.equal(jobsView(r.cfg, 'p', r.state, home, plus(24 * H)).jobs[0]?.state, 'done');

  const state = tmp();
  logJob(state, 'עוזר-בית/morning sent to whatsapp:g@g.us');
  logJob(state, 'home.v2/tick ran, nothing to send');
  assert.deepEqual([...lastRuns(state).keys()], ['home.v2/tick', 'עוזר-בית/morning']);
});

test('a line break in a log line cannot add a run that never happened', () => {
  const state = tmp();
  logJob(state, `p/once error: boom\n${plus(1_000).toISOString()} p/once sent to whatsapp:g@g.us\r\nend`);
  const text = readFileSync(join(state, 'jobs.log'), 'utf8');
  assert.equal(text.trim().split('\n').length, 1);
  assert.deepEqual(lastRuns(state).get('p/once')?.map((x) => x.result.slice(0, 11)), ['error: boom']);
});
