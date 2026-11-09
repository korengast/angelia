import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../src/instance/config/schema.js';
import { jobHash, jobLabel, readJobs, JOBS_FILE } from '../src/jobs/jobs.js';
import { runAndReport } from '../src/jobs/jobs-cli.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'angelia-once-'));
const AT = '2030-06-01 09:00';
const moment = new Date(2030, 5, 1, 9, 0);
const plus = (ms: number) => new Date(moment.getTime() + ms);
const H = 3600_000;

function rig(yaml: string) {
  const cwd = tmp();
  const state = tmp();
  writeFileSync(join(cwd, JOBS_FILE), yaml);
  const cfg = Config.parse({ profiles: { p: { cwd } }, routes: [{ platform: 'whatsapp', chat: 'g@g.us', profile: 'p' }] });
  return { cwd, state, cfg };
}

/** One record of everything a run does, in order: deliveries, unloads, and what jobs.log held at the unload. */
function run(r: ReturnType<typeof rig>, fail?: (text: string) => boolean) {
  const events: string[] = [];
  const log = () => (existsSync(join(r.state, 'jobs.log')) ? readFileSync(join(r.state, 'jobs.log'), 'utf8') : '');
  return {
    events,
    log,
    go: (job: string, hash: string | undefined, now: Date) => runAndReport(r.cfg, 'p', job, hash, {
      stateDir: r.state, now,
      deliver: async (kind, key, text) => { events.push(`${kind} ${key} ${text}`); if (fail?.(text)) throw new Error('the daemon did not answer'); },
      unload: (label) => events.push(`unload ${label} after log: ${log().trim().split('\n').pop()}`),
    }),
  };
}

const hashOf = (r: ReturnType<typeof rig>, job: string) => jobHash(readJobs(r.cfg, 'p').jobs[job]!);

test('a one-time timer removes itself after its run, last, and only from a timer', async () => {
  const r = rig(`jobs:\n  once: {at: "${AT}", send: hi}\n  tick: {every: 1h, send: tock}\n`);
  const x = run(r);
  assert.equal(await x.go('once', hashOf(r, 'once'), plus(5_000)), 'sent to whatsapp:g@g.us');
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
  assert.match(await x.go('once', hashOf(r, 'once'), plus(-365 * 24 * H)), /^early: job p\/once is due at 2030-06-01 09:00, not before/);
  assert.deepEqual(x.events, [], 'no chat line, no unload');
  assert.match(x.log(), /p\/once early: /);
  await assert.rejects(x.go('once', undefined, plus(-H)), /due at 2030-06-01 09:00, not before/, 'by hand it is refused and said');
  assert.deepEqual(x.events, []);
  assert.equal(await x.go('once', hashOf(r, 'once'), plus(-30_000)), 'sent to whatsapp:g@g.us', 'a timer 30 s early is not refused');
});

test('after its moment the timer goes in every outcome: a failure, a refusal, a missed time', async () => {
  const r = rig(`jobs:\n  once: {at: "${AT}", send: hi}\n`);
  const label = jobLabel('p', 'once');
  const x = run(r, (t) => t === 'hi');
  const hash = hashOf(r, 'once');
  await assert.rejects(x.go('once', hash, plus(5_000)), /did not answer/);
  assert.deepEqual(x.events.map((e) => e.replace(/ after log: .*/, '')), ['send whatsapp:g@g.us hi', 'send whatsapp:g@g.us Scheduled job once did not run: the daemon did not answer', `unload ${label}`]);
  assert.match(x.events[2]!, /error: the daemon did not answer$/);

  const y = run(r);
  await assert.rejects(y.go('once', 'not-the-hash', plus(5_000)), /changed since it was installed/);
  assert.match(y.events[0]!, /Scheduled job once did not run: .*changed since/);
  assert.equal(y.events[1]?.startsWith(`unload ${label}`), true, 'a refused run after its moment removes the timer too');

  const z = run(r);
  await assert.rejects(z.go('once', hash, plus(13 * H)), /more than 12 h after that/);
  assert.deepEqual(z.events.map((e) => e.replace(/ after log: .*/, '')), [
    'send whatsapp:g@g.us Scheduled job once missed its time, 2030-06-01 09:00: the Mac was asleep, off or logged out then, so it does not run.',
    `unload ${label}`,
  ]);
  assert.match(z.log(), /p\/once missed: /);
  assert.equal(await z.go('once', undefined, plus(13 * H)), 'sent to whatsapp:g@g.us', 'by hand a missed job still runs');
  assert.equal(await run(r).go('once', hash, plus(11 * H)), 'sent to whatsapp:g@g.us', 'within the grace a late fire (a wake) runs');
});

test('a job file edited during a run that worked posts no failure line', async () => {
  const r = rig(`jobs:\n  once: {at: "${AT}", send: hi}\n`);
  const events: string[] = [];
  const line = await runAndReport(r.cfg, 'p', 'once', hashOf(r, 'once'), {
    stateDir: r.state, now: plus(1_000),
    deliver: async (_k, _c, text) => { events.push(text); writeFileSync(join(r.cfg.profiles.p!.cwd, JOBS_FILE), 'jobs: [broken'); },
    unload: (l) => events.push(`unload ${l}`),
  });
  assert.equal(line, 'sent to whatsapp:g@g.us');
  assert.deepEqual(events, ['hi', `unload ${jobLabel('p', 'once')}`]);
});
