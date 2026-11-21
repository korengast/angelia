# Inbound limit for each non-owner sender: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Limit the messages that each allowed non-owner sender sends to a profile in one hour, with one reply line for each block.

**Architecture:** A config field `max_in_per_hour` (in `defaults` and on a profile) sets the limit. `Orchestrator.handle()` checks a `SenderQuota` directly after `gate()` passes, for non-owners only. It drops the message and sends one line for each block.

**Tech Stack:** TypeScript, zod, `node --test` with `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-21-sender-rate-limit-design.md`

## Global Constraints

- Default limit: `defaults.max_in_per_hour` = 50. A profile value replaces it. 0 = no limit. Integer, 0 or more.
- The window is one hour (3600_000 ms).
- Owner = `isOwner(i, route)` from `src/core/router/gate.ts`. Owners have no limit. DMs count as owners.
- Quota key: `` `${profile} ${i.platform}:${i.sender}` ``.
- Reply line, exact: `Too many messages. Wait up to one hour, then try again.`
- Drop reason, exact: `` `reason=sender-limit sender=${i.sender}` ``.
- `limitTold` is cleared when it reaches 1000 keys.
- The file download quota in the adapters keeps its current behavior (30 files for each sender in each hour).
- Run `npm test` and `npm run lint` before the final commit. Both must pass.

## Review Focus

1. A non-owner in a group sends a permission reply `yes <id>` for an open request: it counts, and over the limit it gets no `NOT_OWNER_LINE`. Test: Task 2, test 4.
2. A burst of messages that arrive at the same time (`Promise.all`): only one limit line goes out. Test: Task 2, test 1 sends in parallel.
3. The same sender in two groups that route to two profiles: separate counts. Test: Task 2, test 6.
4. Messages dropped by the gate (strangers) do not use a sender's quota. Covered by the order: the check runs after `gate()` passes. Test: Task 2, test 7.
5. A profile with `max_in_per_hour: 0` while the default is 50: no limit. Test: Task 2, test 5.

---

### Task 1: Config field and a quota with a per-call limit

**Files:**
- Modify: `src/instance/config/schema.ts` (`Profile` at line 65, `defaults` near line 197)
- Modify: `src/adapters/inbox.ts:90-104` (`SenderQuota.take`)
- Test: `tests/config.test.ts`, `tests/inbox.test.ts`

**Interfaces:**
- Produces: `cfg.defaults.max_in_per_hour: number` (default 50); `cfg.profiles[name].max_in_per_hour?: number`; `SenderQuota.take(key: string, perHour?: number): boolean`. When `perHour` is absent, `take` uses the constructor value.

- [ ] **Step 1: Write the failing tests**

In `tests/config.test.ts`:

```ts
test('max_in_per_hour: 50 by default, a profile may set its own, 0 is allowed, negative is not', () => {
  const base = { profiles: { a: { cwd: '/tmp' } }, routes: [] };
  assert.equal(Config.parse(base).defaults.max_in_per_hour, 50);
  assert.equal(Config.parse({ ...base, defaults: { max_in_per_hour: 0 } }).defaults.max_in_per_hour, 0);
  assert.equal(Config.parse({ ...base, profiles: { a: { cwd: '/tmp', max_in_per_hour: 5 } } }).profiles.a.max_in_per_hour, 5);
  assert.throws(() => Config.parse({ ...base, defaults: { max_in_per_hour: -1 } }));
  assert.throws(() => Config.parse({ ...base, profiles: { a: { cwd: '/tmp', max_in_per_hour: 1.5 } } }));
});
```

In `tests/inbox.test.ts`:

```ts
test('sender quota: a limit given on the call replaces the one from the constructor', () => {
  let now = 0;
  const q = new SenderQuota(30, () => now);
  assert.deepEqual([q.take('a', 2), q.take('a', 2), q.take('a', 2)], [true, true, false]);
  assert.equal(q.take('b'), true, 'the constructor limit still applies without one');
  now = 3600_001;
  assert.equal(q.take('a', 2), true);
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --test --import tsx tests/config.test.ts tests/inbox.test.ts`
Expected: FAIL. `max_in_per_hour` is `undefined`, and `take('a', 2)` returns true three times.

- [ ] **Step 3: Implement**

- `defaults`: add `max_in_per_hour: z.number().int().nonnegative().default(50)` after `max_out_per_min`, with a doc comment: "Messages in per hour from each sender who is not an owner, for each profile. 0: no limit."
- `Profile`: add `max_in_per_hour: z.number().int().nonnegative().optional()` with a doc comment: "Replaces defaults.max_in_per_hour for this profile."
- `SenderQuota.take(sender: string, perHour = this.perHour)`: compare with `perHour`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test --import tsx tests/config.test.ts tests/inbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/instance/config/schema.ts src/adapters/inbox.ts tests/config.test.ts tests/inbox.test.ts
git commit -m "Config: max_in_per_hour; SenderQuota takes a limit on each call"
```

### Task 2: The check in the orchestrator, and the docs

**Files:**
- Modify: `src/core/orchestrator.ts` (opts interface near line 100, fields near line 203, `handle()` near line 282)
- Modify: `docs/reference.md`, `docs/security.md`
- Test: `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: `SenderQuota.take(key, perHour)`, `cfg.defaults.max_in_per_hour`, `cfg.profiles[name].max_in_per_hour` (Task 1).
- Produces: `OrchestratorOpts.now?: () => number` (a clock for the quota; default `Date.now`). Exported const `SENDER_LIMIT_LINE = 'Too many messages. Wait up to one hour, then try again.'`.

- [ ] **Step 1: Write the failing tests**

Add a helper next to `setup()` in `tests/orchestrator.test.ts`. It uses the group route of `setup()` (owners `['u1']`, `allow_from: ['*']`), a second group route to profile `b`, a settable clock, and an optional `max_in_per_hour` for the default and for profile `a`:

```ts
function limited(opts: { def?: number; a?: number } = {}) {
  let now = 0;
  const cfg = Config.parse({
    profiles: { a: { cwd: here, ...(opts.a !== undefined ? { max_in_per_hour: opts.a } : {}) }, b: { cwd: here } },
    routes: [
      { platform: 'whatsapp', chat: 'g@g.us', profile: 'a', mention: 'required', owners: ['u1'], allow_from: ['*'] },
      { platform: 'whatsapp', chat: 'h@g.us', profile: 'b', mention: 'required', owners: ['u1'], allow_from: ['*'] },
    ],
    defaults: { max_out_per_min: 1000, ...(opts.def !== undefined ? { max_in_per_hour: opts.def } : {}) },
  });
  const sent: { chat: string; text: string }[] = [];
  const sender = { send: async (chat: string, text: string) => { sent.push({ chat, text }); } };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-orch-')), bins: { 'claude-code': FAKE }, now: () => now });
  const msg = (sender: string, text: string, chat = 'g@g.us'): Inbound => ({ platform: 'whatsapp', chat, sender, senderName: 'M', text, isGroup: true, mentioned: true, media: [], allow_from: ['*'] } as Inbound);
  return { o, sent, msg, tick: (ms: number) => { now += ms; } };
}
const told = (sent: { text: string }[]) => sent.filter((s) => s.text === SENDER_LIMIT_LINE).length;
```

Tests (one `test()` each, each with `t.after(() => o.shutdown())`):

1. `'a non-owner over the limit is told once, and the rest start no turn'`: `limited({ def: 3 })`. Send 6 messages from `m1` with `Promise.all`. Assert `told(sent) === 1` and `sent.filter((s) => /^echo:/.test(s.text)).length === 3`.
2. `'an owner has no limit'`: `limited({ def: 3 })`. Send 6 messages from `u1` one after another. Assert `told(sent) === 0` and 6 echo replies.
3. `'after the hour a message passes, and the next block is told again'`: `limited({ def: 2 })`. Send 3 from `m1` (told 1). `tick(3600_001)`. Send 3 more. Assert `told(sent) === 2` and 4 echo replies.
4. `'/help and a yes from a non-owner count, and over the limit get no reply'`: `limited({ def: 2 })`. From `m1`: `'@bot /help'`, `'@bot yes abcd'`, `'@bot /help'`. Assert the last message got only `SENDER_LIMIT_LINE` and no `/help` text: `sent.at(-1)!.text === SENDER_LIMIT_LINE` and `told(sent) === 1`.
5. `'a profile value replaces the default, and 0 turns the limit off'`: `limited({ def: 1, a: 0 })`. Send 4 from `m1` to `g@g.us`. Assert `told(sent) === 0`. Then `limited({ def: 50, a: 1 })`: send 2. Assert `told(sent) === 1`.
6. `'two profiles keep separate counts for one sender'`: `limited({ def: 1 })`. Send 1 from `m1` to `g@g.us` and 1 to `h@g.us`. Assert `told(sent) === 0` and 2 echo replies.
7. `'a message the gate drops does not count'`: `limited({ def: 1 })`. Send 3 messages from `m1` with `mentioned: false` (the gate drops them). Then 1 mentioned message. Assert `told(sent) === 0` and 1 echo reply.

Use the mention form that the other group tests in the file use (`'@bot …'` with `mentioned: true`). Match the bot-mention fields to the existing `group(...)` helper at line 344 if it differs.

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --test --import tsx --test-name-pattern="limit|non-owner|separate counts|gate drops" tests/orchestrator.test.ts`
Expected: FAIL. `SENDER_LIMIT_LINE` is not exported, and `now` is not an option.

- [ ] **Step 3: Implement**

- Opts: add `now?: () => number` with a doc comment: "The clock of the inbound limit; a test passes its own."
- Fields: `private inQuota = new SenderQuota(50, this.opts.now ?? Date.now)` (create it in the constructor if `opts` is not set at field time), and `private limitTold = new Set<string>()`. Import `SenderQuota` from `../adapters/inbox.js`.
- `export const SENDER_LIMIT_LINE = 'Too many messages. Wait up to one hour, then try again.';` next to `BUSY_LINE`.
- In `handle()`, directly after `const profile = this.cfg.profiles[route.profile];` and before `parsePermissionReply`:

```ts
const limit = profile.max_in_per_hour ?? this.cfg.defaults.max_in_per_hour;
if (limit > 0 && !isOwner(i, route)) {
  const qk = `${route.profile} ${i.platform}:${i.sender}`;
  if (!this.inQuota.take(qk, limit)) {
    this.dropped(key, `reason=sender-limit sender=${i.sender}`);
    if (!this.limitTold.has(qk)) {
      if (this.limitTold.size >= 1000) this.limitTold.clear();
      this.limitTold.add(qk);
      await this.reply(i, SENDER_LIMIT_LINE).catch((e) => this.log(`sender-limit line not sent key=${key}: ${String((e as Error)?.message ?? e)}`));
    }
    return;
  }
  this.limitTold.delete(qk);
}
```

Add the `limitTold.add` before the `await`, as shown: parallel messages must not each send the line.

- Docs: in `docs/reference.md`, add `max_in_per_hour` where `max_out_per_min` is listed, in the same style. Text: "Messages in per hour from each sender who is not an owner, for each profile (default 50; 0: no limit). A profile may set its own. Over the limit, a message is dropped, and the chat gets one line for each block." In `docs/security.md`, add one sentence to the flood or gate part: "A sender who is not an owner gets `max_in_per_hour` messages to a profile in an hour (default 50); the rest are dropped with one line for each block, so a flood cannot make the bot answer many times."

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test --import tsx tests/orchestrator.test.ts`
Expected: PASS, the old tests too.

- [ ] **Step 5: Run the full checks**

Run: `npm test && npm run lint`
Expected: all tests pass (0 fail), lint clean. If an OpenAPI or docs test fails on the new field, run `npm run openapi` and add the changed file.

- [ ] **Step 6: Commit**

```bash
git add src/core/orchestrator.ts tests/orchestrator.test.ts docs/reference.md docs/security.md
git commit -m "Inbound limit: a non-owner gets max_in_per_hour messages to a profile in an hour, told once for each block"
```
