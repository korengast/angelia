import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Config } from '../src/instance/config/schema.js';
import { ALERT_FAILED, ALERT_KEY_MISS, ALERT_NO_ANSWER, ALERT_QUIET_EMPTY, ALERT_STALLED, alertLine, HealthCount, health, healthText, rowOf, shortKey } from '../src/daemon/health.js';
import { KEY_KEPT_LINE, KEY_MISS_LINE } from '../src/brain/tui.js';
import { tmp } from './tmp.js';

// Days are the owner's local days. One zone for the file, so a count lands on the same day wherever
// the tests run; the test of the local-day split sets its own.
process.env.TZ = 'UTC';

// Placeholder chats: two routed, one that no route names.
const FAMILY = 'whatsapp:120363000000000001@g.us', WORK = 'telegram:-1000000000001', STRAY = 'whatsapp:120363000000000009@g.us';
const cfg = Config.parse({
  profiles: { family: { cwd: '/p/family' }, work: { cwd: '/p/work' } },
  routes: [{ platform: 'whatsapp', chat: '120363000000000001@g.us', profile: 'family' }, { platform: 'telegram', chat: -1000000000001, profile: 'work' }],
});

const NOW = new Date('2030-03-10T12:00:00.000Z');
const at = (day: string, time: string, text: string) => `${day}T${time}.000Z ${text}`;
const D = '2030-03-10', D1 = '2030-03-09';
const ended = (how: string, chars: number, key: string, pane = 'angelia-x-00000000') => `tmux: turn ended by ${how} after 14 s, answer ${chars} chars pane=${pane} key=${key}`;
const QUIET = (stood: string) => `the quiet pane (no Stop marker; transcript ${stood})`;

function logWith(t: { after(fn: () => unknown): void }, lines: string[], older: string[] = []): string {
  const dir = tmp(t, 'angelia-health-');
  writeFileSync(join(dir, 'daemon.log'), lines.map((l) => `${l}\n`).join(''));
  if (older.length) writeFileSync(join(dir, 'daemon.log.1'), older.map((l) => `${l}\n`).join(''));
  // Written "now" by the test's clock: a file last written before the window is not opened.
  for (const f of ['daemon.log', ...(older.length ? ['daemon.log.1'] : [])]) utimesSync(join(dir, f), NOW, NOW);
  return dir;
}

test('the lines the daemon writes are counted per profile and day, by the routing table', async (t) => {
  const stateDir = logWith(t, [
    at(D, '08:00:00', 'daemon up pid=1 profiles=2 routes=2 tg=polling wa=connecting'),
    at(D, '08:00:01', 'whatsapp: closed code=428 reconnect_in=2000ms'),
    at(D, '08:00:02', 'send failed, again in 5 s: whatsapp: not connected'),
    at(D, '08:00:03', 'phone: send failed: message too large for a phone'), // the phone link's own line: not counted
    at(D, '09:00:00', ended('the Stop marker', 120, FAMILY)),
    at(D, '09:10:00', ended('the Stop marker', 0, FAMILY)),
    at(D, '09:10:00', `no answer key=${FAMILY}`),
    at(D, '09:20:00', `turn failed key=${FAMILY} reason=exit`),
    at(D, '09:21:00', `turn failed key=${FAMILY} reason=stopped by the user`), // /stop: not a failure
    at(D, '09:22:00', `injected turn failed key=${FAMILY}: boom`),
    at(D, '09:30:00', `turn stalled key=${WORK} after 30 min without output`),
    at(D, '09:31:00', `turn error key=${WORK} something threw`),
    at(D, '09:32:00', `deliver failed key=${WORK} whatsapp: not connected`),
    at(D, '09:33:00', `api error key=${WORK}, the same turn again in 60 s`),
    at(D, '09:34:00', `retry with fresh session key=${WORK}`),
    at(D, '09:35:00', `permission auto-denied key=${WORK} tool=Bash`),
    at(D, '09:36:00', `permission auto-denied 10 times key=${WORK}: turn stopped`),
    at(D, '09:37:00', `permission auto-deny failed key=${WORK} tool=Bash: no hook waits for it`), // not a denial
    at(D, '09:40:00', `tmux: the pane reads idle 40 s into the turn, but its transcript shows the turn open; waiting for the Stop marker (screen kept in idle-open.txt) pane=angelia-x-00000000 key=${WORK}`),
    at(D, '09:50:00', `turn failed key=${STRAY} reason=exit`),
    at(D, '09:51:00', 'tmux: turn ended by the Stop marker after 3 s, answer 9 chars pane=angelia-y-11111111'), // no key: an older log
    'a line with no time of its own: no answer key=' + FAMILY,
  ]);
  const r = await health({ stateDir, cfg, now: NOW });
  assert.deepEqual(r.byDay[D].profiles, {
    family: { turns: 2, noAnswer: 1, failed: 2 },
    work: { stalled: 1, errors: 1, deliverFailed: 1, apiErrors: 1, freshRetries: 1, autoDenied: 2, heldOpen: 1 },
    'whatsapp:12036300…': { failed: 1 },
    tmux: { turns: 1 },
  });
  assert.deepEqual(r.byDay[D].daemon, { starts: 1, whatsappDrops: 1, sendRetries: 1 });
  assert.deepEqual(r.totals, r.byDay[D]);
  assert.equal(r.alert, 'Angelia health, last 24 h: work 1 turn stalled. See: angelia health', 'one no-answer and two failures are within the limits; one stall is not');

  const text = healthText(r);
  assert.match(text, /^Angelia health, last 24 h$/m);
  assert.match(text, /^  profile +tmux turns +no answer +failed +stalled/m);
  assert.match(text, /^  family +2 +1 +2 +\. /m, 'a zero is a dot, and only columns that counted something are shown');
  assert.doesNotMatch(text, /quiet/, 'a column nothing counted in is left out');
  assert.match(text, /^  daemon: 1 daemon start, 1 WhatsApp drop, 1 send retry$/m);
  assert.match(text, /A print-mode turn writes no line/);
  // A chat id is never printed whole: a routed chat is its profile, any other is cut as the log cuts one.
  for (const out of [text, JSON.stringify(r)]) for (const key of [FAMILY, WORK, STRAY]) assert.ok(!out.includes(key.split(':')[1]), key);
});

test('the window is the last N days, split by day, and the older log file is read too', async (t) => {
  const stateDir = logWith(t, [
    at(D1, '13:00:00', `no answer key=${FAMILY}`),
    at(D, '11:00:00', `no answer key=${FAMILY}`),
    at(D, '12:30:00', `no answer key=${FAMILY}`), // after "now": a clock that moved; not in the window
  ], [
    at('2030-03-01', '10:00:00', `no answer key=${FAMILY}`),
    at(D1, '11:00:00', `no answer key=${FAMILY}`), // 25 h ago
  ]);
  const day = await health({ stateDir, cfg, now: NOW });
  assert.deepEqual(day.byDay, { [D1]: { profiles: { family: { noAnswer: 1 } }, daemon: {} }, [D]: { profiles: { family: { noAnswer: 1 } }, daemon: {} } });
  assert.equal(day.logs.length, 2);
  const ten = await health({ stateDir, cfg, now: NOW, days: 10 });
  assert.deepEqual(Object.keys(ten.byDay), ['2030-03-01', D1, D]);
  assert.equal(ten.totals.profiles.family.noAnswer, 4);
  assert.match(healthText(ten), /^Angelia health, last 10 days$/m);
  for (const days of [0, 31, 1.5, Number.NaN]) await assert.rejects(health({ stateDir, cfg, now: NOW, days }), /--days takes a whole number from 1 to 30/);
});

test('a failure the daemon tried again is not a failed turn: only the retry\'s own end counts', async (t) => {
  const fresh = (time: string, key: string) => [at(D, time, `turn failed key=${key} reason=exit`), at(D, time, `retry with fresh session key=${key}`)];
  const apiError = (time: string, key: string) => [at(D, time, `turn failed key=${key} reason=api-error: API Error: 500`), at(D, time, `api error key=${key}, the same turn again in 60 s`)];
  const stateDir = logWith(t, [
    // Three hiccups, each answered on the second try: the daemon logs the failure, then the retry.
    ...apiError('09:00:00', FAMILY), ...apiError('10:00:00', FAMILY), ...fresh('11:00:00', FAMILY),
    // The retry failed too: that is the turn's end, counted once.
    ...fresh('09:00:00', WORK), at(D, '09:01:01', `turn failed key=${WORK} reason=exit`),
    // A retry line with no failure just before it (another chat's, or long ago) takes nothing back.
    at(D, '09:30:00', `turn failed key=${STRAY} reason=exit`), at(D, '09:40:00', `retry with fresh session key=${STRAY}`),
  ]);
  const r = await health({ stateDir, cfg, now: NOW });
  assert.deepEqual(r.totals.profiles, {
    family: { apiErrors: 2, freshRetries: 1 },
    work: { freshRetries: 1, failed: 1 },
    'whatsapp:12036300…': { failed: 1, freshRetries: 1 },
  });
  assert.equal(r.alert, null);
  assert.doesNotMatch(healthText(r), /^  family .*\bfailed\b/m);
});

test('a day is the owner\'s local day, and a window longer than the log says where the log starts', async (t) => {
  const stateDir = logWith(t, [at(D, '10:30:00', `no answer key=${FAMILY}`), at(D, '11:30:00', `no answer key=${FAMILY}`)]);
  process.env.TZ = 'Pacific/Auckland'; // UTC+13 in March: 10:30 UTC is 23:30 there, 11:30 UTC is the next day
  t.after(() => { process.env.TZ = 'UTC'; });
  const r = await health({ stateDir, cfg, now: NOW, days: 3 });
  assert.deepEqual(Object.keys(r.byDay), ['2030-03-10', '2030-03-11']);
  assert.equal(r.logStart, '2030-03-10T10:30:00.000Z');
  assert.match(healthText(r), /^The log starts 2030-03-10 23:30: nothing before that is counted\.$/m);
  process.env.TZ = 'UTC';
  assert.deepEqual(Object.keys((await health({ stateDir, cfg, now: NOW })).byDay), ['2030-03-10']);
  // A log that reaches back past the window's start says nothing: in the file read, or in the older one.
  const long = logWith(t, [at('2030-03-01', '10:00:00', 'reap key=' + FAMILY), at(D, '11:00:00', `no answer key=${FAMILY}`)]);
  assert.equal((await health({ stateDir: long, cfg, now: NOW })).logStart, null);
  const rotated = logWith(t, [at(D, '11:00:00', `no answer key=${FAMILY}`)], [at('2030-03-01', '10:00:00', 'reap key=' + FAMILY)]);
  utimesSync(join(rotated, 'daemon.log.1'), new Date('2030-03-01T10:00:00Z'), new Date('2030-03-01T10:00:00Z'));
  const rr = await health({ stateDir: rotated, cfg, now: NOW });
  assert.equal(rr.logStart, null);
  assert.equal(rr.logs.length, 1, 'the older file was last written before the window: not opened');
  assert.doesNotMatch(healthText(rr), /The log starts/);
});

test('no log, or nothing counted, is said in words', async (t) => {
  assert.match(healthText(await health({ stateDir: tmp(t, 'angelia-health-'), cfg, now: NOW })), /No daemon log written in this window\./);
  const quiet = logWith(t, [at(D, '09:00:00', 'reap key=' + FAMILY)]);
  const r = await health({ stateDir: quiet, cfg, now: NOW });
  assert.match(healthText(r), /Nothing counted in the daemon log for this window\./);
  assert.equal(r.alert, null);
});

test('a quiet-pane end with no answer counts as one only when it was a message, not a slash command', async (t) => {
  const stateDir = logWith(t, [
    // /clear: the CLI answered it itself, and the daemon says "/clear done." - no `no answer` line.
    at(D, '09:00:00', ended(QUIET('has no turn'), 0, FAMILY)),
    at(D, '09:01:00', ended(QUIET('has a slash command only'), 0, FAMILY)),
    // A message whose turn ended the same way: the chat was told the agent gave no answer.
    at(D, '09:02:00', ended(QUIET('has no turn'), 0, FAMILY)),
    at(D, '09:02:00', `no answer key=${FAMILY}`),
    // A turn cut while the transcript showed it open: counted whatever the daemon said next.
    at(D, '09:03:00', ended(QUIET('open, no new row and nothing moving above the input box for 181 s'), 0, FAMILY)),
    // An answer after all (the Stop hook failed, the transcript had the text).
    at(D, '09:04:00', ended(QUIET('ends with text'), 40, FAMILY)),
    // A `no answer` long after a quiet end is another turn's (one that ended by the Stop marker, in print mode).
    at(D, '09:06:00', ended(QUIET('has no turn'), 0, WORK)),
    at(D, '09:08:00', `no answer key=${WORK}`),
  ]);
  const r = await health({ stateDir, cfg, now: NOW });
  assert.deepEqual(r.totals.profiles.family, { turns: 5, quietEnds: 5, quietEmpty: 2, noAnswer: 1 });
  assert.deepEqual(r.totals.profiles.work, { turns: 1, quietEnds: 1, noAnswer: 1 });
});

test('--alert: silent within the limits, one plain line past one', async (t) => {
  assert.deepEqual([ALERT_NO_ANSWER, ALERT_FAILED, ALERT_STALLED, ALERT_QUIET_EMPTY], [2, 3, 1, 2]);
  const within = { profiles: { family: { noAnswer: 1, failed: 2, quietEmpty: 1, deliverFailed: 9 } }, daemon: { starts: 9, whatsappDrops: 99, sendRetries: 99 } };
  assert.equal(alertLine(within, 1), null);
  const over = { profiles: { work: { stalled: 1 }, family: { noAnswer: 7, failed: 3 }, quiet: { quietEmpty: 2 }, fine: { failed: 2 } }, daemon: {} };
  assert.equal(alertLine(over, 1), 'Angelia health, last 24 h: family 7 turns ended without an answer, 3 turns failed; quiet 2 tmux turns ended by the quiet pane with no answer; work 1 turn stalled. See: angelia health');
  assert.match(alertLine(over, 7)!, /^Angelia health, last 7 days: .*See: angelia health --days 7$/);
  assert.ok(!alertLine(over, 1)!.includes('\n'));

  // The real command, as a job runs it: empty output posts nothing, any output is posted (jobs.ts, runJob).
  const cli = join(import.meta.dirname, '..', 'src', 'cli', 'cli.ts');
  const run = (stateDir: string, ...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', cli, 'health', ...args], { env: { ...process.env, ANGELIA_STATE_DIR: stateDir, ANGELIA_CONFIG: join(stateDir, 'none.yaml') }, encoding: 'utf8' });
  const stamp = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  const calm = tmp(t, 'angelia-health-'), loud = tmp(t, 'angelia-health-');
  writeFileSync(join(calm, 'daemon.log'), `${stamp(2)} no answer key=${FAMILY}\n`);
  writeFileSync(join(loud, 'daemon.log'), `${stamp(30)} no answer key=${FAMILY}\n${stamp(3)} no answer key=${FAMILY}\n${stamp(2)} no answer key=${FAMILY}\n`);
  const silent = run(calm, '--alert');
  assert.equal(silent.status, 0, silent.stderr);
  assert.equal(silent.stdout, '');
  const said = run(loud, '--alert');
  assert.equal(said.status, 0, said.stderr);
  // No routing table here: the chat is named by its id, cut.
  assert.equal(said.stdout, 'Angelia health, last 24 h: whatsapp:12036300… 2 turns ended without an answer. See: angelia health\n');
  assert.equal(run(loud, '--days', '40').status, 1);
  assert.equal(run(loud, '--verbose').status, 2, 'a flag it does not know is refused before it runs');
});

test('a chat is named by its profile, any other by its id cut short', () => {
  assert.equal(rowOf(FAMILY, cfg), 'family');
  assert.equal(rowOf(`${WORK}:7`, cfg), 'work', 'a topic of a routed chat');
  assert.equal(rowOf(STRAY, cfg), 'whatsapp:12036300…');
  assert.equal(rowOf(FAMILY), 'whatsapp:12036300…', 'no table: every chat is cut');
  assert.equal(shortKey('telegram:42'), 'telegram:42');
});

test('every text counted is one the daemon still writes', () => {
  // The counts read the log by the start of each line. A line reworded in the daemon must be reworded
  // in health.ts too; this fails first.
  const src = (f: string) => readFileSync(join(import.meta.dirname, '..', 'src', f), 'utf8');
  const orchestrator = src('core/orchestrator.ts'), tui = src('brain/tui.ts');
  for (const text of ['`no answer key=${key}`', '`turn failed key=${key} reason=', "'stopped by the user'", '`turn stalled key=${key} ', '`turn error key=${key} ', '`deliver failed key=${key} ',
    '`retry with fresh session key=${key}`', '`permission auto-denied key=${key} ', '`permission auto-denied ${AUTO_DENY_MAX} times key=${key}', '`injected turn failed key=${key}',
    // A brain's own lines get the chat added: that is where a tmux line's `key=` comes from.
    "b.on('log', (line: string) => this.log(`${line} key=${key}`))"]) assert.ok(orchestrator.includes(text), text);
  for (const text of ['`tmux: turn ended by ${how} after ${Math.round((Date.now() - sentAt) / 1000)} s, answer ${answer.length} chars pane=${this.name}`', '`the quiet pane (no Stop marker; transcript ${stood})`',
    "none: 'has no turn', command: 'has a slash command only'", 'but its transcript shows the turn open;', '`tmux: the pane reads idle ']) assert.ok(tui.includes(text), text);
  assert.ok(src('daemon/daemon.ts').includes('logLine(`daemon up pid='));
  assert.ok(src('adapters/whatsapp/adapter.ts').includes('`whatsapp: closed code='));
  assert.ok(src('core/orchestrator.ts').includes('`send failed, again in '));
});

test('a marker dropped on a prompt key miss is counted per profile and day, and one is enough for --alert', () => {
  const c = new HealthCount();
  const ms = Date.parse('2026-11-21T08:00:00.000Z');
  // As the orchestrator writes the brain's line: the chat's key at the end.
  c.line(ms, `${KEY_MISS_LINE} prompts=1 chars=17 pane=angelia-x-00000000 key=telegram:1`);
  c.line(ms + 1000, `${KEY_MISS_LINE} prompts=1 chars=4 pane=angelia-x-00000000 key=telegram:1`);
  c.line(ms + 2000, `${KEY_MISS_LINE} prompts=1 chars=4 pane=angelia-x-00000000`); // no chat: not counted
  // A miss the net kept (its answer delivered) is a miss too: the prompt was not what was typed.
  c.line(ms + 3000, `${KEY_KEPT_LINE} prompts=1 chars=4 typed=0a1b2c3d/120 hook=4e5f6a7b/137 by=turn: the turn's one typed prompt holds the typed message whole, so its answer is delivered pane=angelia-x-00000000 key=telegram:1`);
  assert.deepEqual(c.totals.profiles, { 'telegram:1': { keyMiss: 3 } });
  assert.equal(ALERT_KEY_MISS, 1);
  assert.equal(alertLine({ profiles: { family: { keyMiss: 1 } }, daemon: {} }, 1), 'Angelia health, last 24 h: family 1 tmux turn had a prompt key miss. See: angelia health');
});
