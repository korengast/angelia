import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrammyError } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { CONFLICT, REVOKED, TelegramAdapter } from '../src/adapters/telegram/adapter.js';

/**
 * What happens when Telegram polling fails. grammY's bot.start() rejects on a 401 or a 409 and
 * retries everything else by itself; the adapter must catch that rejection, say it in its state,
 * and poll again unless the token is gone. The Bot API is faked at the transformer seam as in
 * telegram.test.ts, bot.start is replaced where a test scripts its outcome, and no test waits a
 * real second: the pause between retries is injected.
 */
const ME: UserFromGetMe = { id: 42, is_bot: true, first_name: 'Angelia', username: 'Angelia_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };

const conflict = () => new GrammyError("Call to 'getUpdates' failed!", { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' }, 'getUpdates', {});
const revoked = () => new GrammyError("Call to 'getUpdates' failed!", { ok: false, error_code: 401, description: 'Unauthorized' }, 'getUpdates', {});

type StartOpts = { onStart?: (me: UserFromGetMe) => unknown };
/** One scripted run of bot.start: it gets the adapter's options and the adapter under test. */
type Run = (o: StartOpts, tg: TelegramAdapter) => Promise<void>;

/** Never settles until the adapter stops: a run that is polling, or a pause nobody cuts short. */
const untilStopped = (signal: AbortSignal) => new Promise<void>((done) => signal.addEventListener('abort', () => done(), { once: true }));

function rig(opts: { runs?: Run[]; wait?: (ms: number, signal: AbortSignal) => Promise<void>; api?: (method: string, signal?: AbortSignal) => unknown; now?: () => number } = {}) {
  const logs: string[] = [];
  const waits: number[] = [];
  let starts = 0;
  const tg = new TelegramAdapter({
    token: '000:fake', botInfo: ME, inboxFor: () => undefined, onInbound: () => {}, log: (l) => logs.push(l),
    wait: async (ms, signal) => { waits.push(ms); if (opts.wait) await opts.wait(ms, signal); },
    now: opts.now ?? (() => 0),
  });
  tg.bot.api.config.use(async (_prev, method, _payload, signal) => {
    const res = opts.api?.(method, signal);
    if (res) return (await Promise.resolve(res)) as never;
    if (method === 'getMe') return { ok: true, result: ME } as never;
    if (method === 'getUpdates') return { ok: true, result: [] } as never;
    return { ok: true, result: true } as never;
  });
  if (opts.runs) {
    const runs = opts.runs;
    // A run past the end of the script parks, as a healthy poll would, so no test can spin.
    tg.bot.start = (async (o: StartOpts) => { const run = runs[starts++]; await (run ? run(o, tg) : new Promise(() => {})); }) as typeof tg.bot.start;
  }
  const failures = () => logs.filter((l) => l !== logs[0]);
  return { tg, logs, waits, starts: () => starts, failures };
}

/** Let the loop run to its next pause. */
const settle = () => new Promise((r) => setImmediate(r));

/** A run that reaches polling and gets one getUpdates answered, through the transformer chain, then keeps going. */
const healthy: Run = async (o, tg) => { await o.onStart?.(ME); await tg.bot.api.getUpdates(); await new Promise(() => {}); };

test('a 409 gives the conflict state and one log line; polling is tried again, and its first answer says polling again', async () => {
  const { tg, logs, starts, failures } = rig({ runs: [async () => { throw conflict(); }, healthy] });
  await tg.start();
  await settle();
  assert.equal(tg.state, 'polling');
  assert.equal(starts(), 2, 'bot.start called again after the conflict');
  assert.deepEqual(failures(), [`telegram: ${CONFLICT}`, 'telegram: polling again'], logs.join('\n'));
});

test('409 after 409: the pauses are 5, 10, 20, 40, 60, 60 s, and the conflict is logged once', async () => {
  const runs: Run[] = Array.from({ length: 6 }, () => async () => { throw conflict(); });
  const { tg, waits, starts, failures } = rig({ runs });
  await tg.start();
  await settle();
  assert.deepEqual(waits, [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  assert.equal(starts(), 7);
  assert.equal(tg.state, CONFLICT);
  assert.deepEqual(failures(), [`telegram: ${CONFLICT}`]);
});

test('a 401 stops polling for good: no second start, no retry pause, no rejection escapes', async () => {
  const escaped: unknown[] = [];
  const catcher = (r: unknown) => escaped.push(r);
  process.on('unhandledRejection', catcher);
  try {
    const { tg, waits, starts, failures } = rig({ runs: [async () => { throw revoked(); }] });
    await tg.start();
    await tg.polled();
    await settle();
    assert.equal(tg.state, REVOKED);
    assert.match(tg.state, /^stopped: .*\(401\).*~\/\.angelia\/env.*\/restart/);
    assert.equal(starts(), 1);
    assert.deepEqual(waits, []);
    assert.deepEqual(failures(), [`telegram: ${REVOKED}`]);
  } finally { process.off('unhandledRejection', catcher); }
  assert.deepEqual(escaped, []);
});

test('stop() during the pause after a conflict ends the loop at once: no further start', async () => {
  const { tg, waits, starts } = rig({ runs: [async () => { throw conflict(); }], wait: (_ms, signal) => untilStopped(signal) });
  await tg.start();
  await settle();
  assert.deepEqual(waits, [5_000], 'parked in the pause');
  await tg.stop();
  await tg.polled();
  assert.equal(starts(), 1);
  assert.equal(tg.state, 'stopped');
});

test('polling that ends because stop() was called is not a failure, whether bot.start resolves or rejects', async () => {
  for (const ending of ['resolves', 'rejects'] as const) {
    let finish!: () => void;
    const { tg, starts, failures } = rig({ runs: [(o) => { void o.onStart?.(ME); return new Promise<void>((res, rej) => { finish = ending === 'resolves' ? res : () => rej(new Error('Aborted delay')); }); }] });
    // grammY ends a running bot.start from inside bot.stop(); here the fake does the same.
    tg.bot.stop = (async () => { finish(); }) as typeof tg.bot.stop;
    await tg.start();
    await settle();
    assert.equal(tg.state, 'polling');
    await tg.stop();
    await tg.polled();
    await settle();
    assert.equal(tg.state, 'stopped', ending);
    assert.equal(starts(), 1, ending);
    assert.deepEqual(failures(), [], ending);
  }
});

test('an unknown error is logged by name and retried with the same backoff', async () => {
  const boom = async () => { throw new Error('boom'); };
  const { tg, waits, starts, failures } = rig({ runs: [boom, boom, healthy] });
  await tg.start();
  await settle();
  assert.deepEqual(waits, [5_000, 10_000]);
  assert.equal(starts(), 3);
  assert.equal(tg.state, 'polling');
  assert.deepEqual(failures(), ['telegram: error: boom; retrying', 'telegram: polling again']);
});

test('against real grammY: getUpdates answering 409 twice, then working, logs one conflict and one recovery', async () => {
  // grammY calls onStart before its first getUpdates, and the 409 comes on that getUpdates. A state
  // set by onStart alone would flip to polling and back on every retry and log both each time.
  let gets = 0;
  const { tg, waits, failures } = rig({
    api: (method, signal) => {
      // bot.stop() confirms the offset with a getUpdates of its own, without a signal: the default answer.
      if (method !== 'getUpdates' || !signal) return undefined;
      gets++;
      if (gets <= 2) return { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' };
      if (gets === 3) return { ok: true, result: [] };
      return untilStopped(signal).then(() => { throw new Error('Aborted'); });
    },
  });
  await tg.start();
  for (let i = 0; i < 20 && gets < 4; i++) await settle();
  assert.equal(tg.state, 'polling');
  assert.deepEqual(waits, [5_000, 10_000]);
  assert.deepEqual(failures(), [`telegram: ${CONFLICT}`, 'telegram: polling again']);
  await tg.stop();
  await tg.polled();
  assert.equal(tg.state, 'stopped');
  assert.deepEqual(failures(), [`telegram: ${CONFLICT}`, 'telegram: polling again'], 'the shutdown adds no failure');
});

test('the getUpdates grammY sends while stopping is not read as polling again', async () => {
  const { tg, failures } = rig({ runs: [async () => { throw conflict(); }], wait: (_ms, signal) => untilStopped(signal) });
  await tg.start();
  await settle();
  await tg.stop();
  await tg.bot.api.getUpdates({ offset: 1, limit: 1 });
  assert.equal(tg.state, 'stopped');
  assert.deepEqual(failures(), [`telegram: ${CONFLICT}`]);
});

test('the pauses start again from 5 s only once polling has held for 5 minutes', async () => {
  let clock = 0;
  const lost = async () => { throw conflict(); };
  const backFor = (ms: number): Run => async (o, tg) => { await o.onStart?.(ME); await tg.bot.api.getUpdates(); clock += ms; throw conflict(); };
  const { tg, waits, failures } = rig({ runs: [lost, lost, backFor(60_000), backFor(5 * 60_000)], now: () => clock });
  await tg.start();
  await settle();
  assert.deepEqual(waits, [5_000, 10_000, 20_000, 5_000], 'a minute of polling is not enough to reset; five minutes is');
  assert.deepEqual(failures(), [`telegram: ${CONFLICT}`, 'telegram: polling again', `telegram: ${CONFLICT}`, 'telegram: polling again', `telegram: ${CONFLICT}`]);
});

test('polling that held five minutes from the clock\'s very first tick still resets the pauses', async () => {
  let clock = 0;
  const lost = async () => { throw conflict(); };
  const backFor = (ms: number): Run => async (o, tg) => { await o.onStart?.(ME); await tg.bot.api.getUpdates(); clock += ms; throw conflict(); };
  const { tg, waits } = rig({ runs: [lost, backFor(5 * 60_000)], now: () => clock });
  await tg.start();
  await settle();
  assert.deepEqual(waits, [5_000, 5_000]);
});

test('against real grammY, two pollers trading the token: the pauses still grow to a minute', async () => {
  // The other poller ends ours with a 409, we end theirs on our retry and get one answer, and so on.
  let gets = 0;
  const { tg, waits } = rig({
    api: (method, signal) => {
      if (method !== 'getUpdates' || !signal) return undefined;
      gets++;
      if (gets > 14) return untilStopped(signal).then(() => { throw new Error('Aborted'); });
      return gets % 2 ? { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' } : { ok: true, result: [] };
    },
  });
  await tg.start();
  for (let i = 0; i < 100 && gets <= 14; i++) await settle();
  assert.deepEqual(waits, [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  await tg.stop();
});

test('a token already revoked at boot: start() returns with the stopped state instead of throwing, and nothing polls', async () => {
  const { tg, starts, logs } = rig({ runs: [], api: (method) => method === 'getMe' ? { ok: false, error_code: 401, description: 'Unauthorized' } : undefined });
  await tg.start();
  await tg.polled();
  assert.equal(tg.state, REVOKED);
  assert.equal(starts(), 0);
  assert.deepEqual(logs, [`telegram: ${REVOKED}`]);
  await tg.stop();
  assert.equal(tg.state, 'stopped');
});

test('a token that is not a token at all (404 at boot) also stops Telegram only', async () => {
  const { tg, starts } = rig({ runs: [], api: (method) => method === 'getMe' ? { ok: false, error_code: 404, description: 'Not Found' } : undefined });
  await tg.start();
  assert.equal(tg.state, 'stopped: Telegram refused the bot token (404: Not Found). Check it in ~/.angelia/env and /restart');
  assert.equal(starts(), 0);
});

test('a 429 at boot is a rate limit, not a refused token: it throws as before', async () => {
  const { tg } = rig({ runs: [], api: (method) => method === 'getMe' ? { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5', parameters: { retry_after: 5 } } : undefined });
  await assert.rejects(() => tg.start(), /429/);
  assert.equal(tg.state, 'starting');
});
