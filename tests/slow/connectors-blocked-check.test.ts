import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECORD } from '../../src/capabilities/compile.js';
import { ClaudeBrain } from '../../src/brain/claude.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { Config } from '../../src/instance/config/schema.js';

// The print-mode blocked-connector check with real timers (moved from tests/connectors-all-check.test.ts:
// together they run past the fast suite's 20 s per-file limit on a CI runner).

const GMAIL = 'https://gmailmcp.googleapis.com/*';
const DRIVE = 'https://drivemcp.googleapis.com/*';

/** A print-mode claude: prints `warn` on stderr in two chunks (a line cut in the middle), at once or
 *  (`late`) after its first answer; answers each turn. */
function fakeClaude(dir: string, warn: string, late = false): string {
  const f = join(dir, `claude-${late ? 'late' : 'now'}-${warn ? 'warn' : 'quiet'}.mjs`);
  writeFileSync(f, `#!/usr/bin/env node
const w = ${JSON.stringify(warn ? warn + '\n' : '')};
setTimeout(() => { process.stderr.write(w.slice(0, 20)); setTimeout(() => process.stderr.write(w.slice(20)), 20); }, ${late ? 200 : 0});
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (m.type !== 'user') continue;
  setTimeout(() => {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', apiKeySource: 'none', claude_code_version: '2.1.332' }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fine' }));
  }, 80); } });
`, { mode: 0o755 });
  // The first run of a new program can take seconds on macOS: pay for it here, not inside the check's time.
  spawnSync(f, { input: '', timeout: 20_000 });
  return f;
}

/** The check's own timer never fires in these tests: each one is run by hand, once the stderr it
 *  must count has been read (events, not wall time: a loaded run took longer than any fixed wait). */
const NEVER_MS = 600_000;

/** Resolves once the brain has counted `names` blocked connectors from the child's stderr, or the
 *  stderr ended: looked at now and at each chunk, after the brain's own listener (added first, at the
 *  spawn) has read it. */
function counted(b: unknown, names: number): Promise<void> {
  const x = b as { blocked: string[]; child: import('node:child_process').ChildProcess };
  return new Promise((done) => {
    const check = () => { if (x.blocked.length >= names) done(); };
    x.child.stderr!.on('data', () => setImmediate(check));
    x.child.stderr!.on('end', () => done());
    check();
  });
}

/** The check the timer would make, now. */
const checkNow = (b: unknown) => (b as { checkBlocked(): void }).checkBlocked();

test('print mode: a start that names fewer connectors as blocked than it drops warns once, in the log, after the connector list had its time', { timeout: 40_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-blocked-')));
  const profile = Config.parse({ profiles: { x: { cwd: dir } }, routes: [] }).profiles.x;
  const ONE = 'Warning: claude.ai MCP server blocked by enterprise policy: claude.ai Gmail';
  const run = async (denied: string[], warn: string, late = false) => {
    const b = new ClaudeBrain(profile, { id: '11111111-2222-3333-4444-555555555555', started: false }, { bin: fakeClaude(dir, warn, late), blockedCheckMs: NEVER_MS, mcp: { args: [], settings: { deniedMcpServers: denied.map((serverUrl) => ({ serverUrl })) } } });
    const logs: string[] = [], short: string[] = [];
    b.on('log', (l: string) => logs.push(l));
    b.on('connectors-short', (t: string) => short.push(t));
    b.start();
    // One timer per start, set at the spawn: not one per turn.
    assert.ok((b as unknown as { blockedTimer?: unknown }).blockedTimer, 'the check is armed at the start');
    for (let i = 0; i < 2; i++) for await (const _ of b.turn('hi')) { /* drain */ }
    if (warn) await counted(b, 1);
    checkNow(b);
    await b.stop();
    return { logs, short };
  };
  const ok = await run([GMAIL], ONE);
  assert.deepEqual(ok.short, [], 'one dropped, one named: all is well');
  const miss = await run([GMAIL, DRIVE], ONE);
  assert.equal(miss.short.length, 1, 'once per start, not per turn');
  assert.match(miss.short[0], /dropped 2 connectors by address, but Claude Code named 1 as blocked \(claude\.ai Gmail\)/);
  assert.ok(miss.logs.some((l) => l.startsWith('warning: connectors: all: this start dropped 2')), miss.logs.join('\n'));
  assert.ok(!miss.short[0].includes('googleapis'), 'no address in the warning');
  const none = await run([GMAIL], '');
  assert.match(none.short[0] ?? '', /named 0 as blocked:/);
  // The warning after the first answer (Claude Code does not wait for the connector list): still counted.
  const late = await run([GMAIL], ONE, true);
  assert.deepEqual(late.short, [], 'the count waits for the list, not for the first result');
  // A child gone before the check says nothing: its exit disarms the timer, and the check itself is quiet.
  const b = new ClaudeBrain(profile, { id: '11111111-2222-3333-4444-555555555556', started: false }, { bin: fakeClaude(dir, ''), blockedCheckMs: NEVER_MS, mcp: { args: [], settings: { deniedMcpServers: [{ serverUrl: GMAIL }] } } });
  const short: string[] = [];
  b.on('connectors-short', (t: string) => short.push(t));
  b.start();
  await b.stop();
  checkNow(b);
  assert.deepEqual(short, []);
});

test('the orchestrator tells the owner once per profile, in a direct chat of the owner, however many starts fall short', { timeout: 40_000 }, async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-blocked-orch-')));
  const cwd = join(dir, 'a');
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  // No guard (no launchGuard in this rig): the launch comes from the record, as for a test or the canary.
  writeFileSync(join(cwd, RECORD), JSON.stringify({ version: 1, connectors: [], connectorsAll: true, connectorsDenied: [GMAIL, DRIVE], mcpOwn: [], mcpDeny: [] }));
  const cfg = Config.parse({ profiles: { a: { cwd } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a', owners: ['1'] }], defaults: { max_out_per_min: 1000 } });
  const sent: { chat: string; text: string }[] = [];
  let told: () => void = () => {};
  const o = new Orchestrator(cfg, { telegram: { send: async (chat: string, text: string) => { sent.push({ chat, text }); if (text.includes('named 1 as blocked')) told(); } } } as any, { stateDir: join(dir, 'state'), blockedCheckMs: NEVER_MS, bins: { 'claude-code': fakeClaude(dir, 'Warning: claude.ai MCP server blocked by enterprise policy: claude.ai Gmail') } });
  t.after(() => o.shutdown());
  const msg = (text: string) => o.handle({ platform: 'telegram', chat: '1', sender: '1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [] });
  const brain = () => (o as unknown as { brains: Map<string, unknown> }).brains.get('telegram:1');
  // Each start: its warning read, then the check; the first one's notice sent before the second start.
  const first = new Promise<void>((r) => { told = r; });
  await msg('hi');
  await counted(brain(), 1);
  checkNow(brain());
  await first;
  await msg('/new');
  await msg('hi again');
  await counted(brain(), 1);
  checkNow(brain());
  // The second notice would be sent as the first was (connectorsShort): give its send the same turn.
  await new Promise((r) => setImmediate(r));
  const all = sent.filter((x) => x.text.includes('named 1 as blocked'));
  assert.equal(all.length, 1, JSON.stringify(sent));
  assert.equal(all[0].chat, '1');
  assert.match(all[0].text, /Check the addresses with: angelia check-config/);
});
