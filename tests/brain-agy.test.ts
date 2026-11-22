import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Config } from '../src/instance/config/schema.js';
import { createBrain, type Brain } from '../src/brain/index.js';
import { AgyBrain } from '../src/brain/agy.js';
import type { GateDecision, Msg } from '../src/brain/acp.js';
import { AGY_DEFAULT_MODEL, agyArgv, agyModel } from '../src/brain/argv.js';
import { agyGeminiDir } from '../src/brain/cache.js';
import { DEFAULT_BIN } from '../src/brain/locate.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import type { BrainEvent, Inbound } from '../src/core/types.js';

// A sandboxed fake agy must not get the owner's real sign-in copied into a scratch folder.
AgyBrain.readLogin = () => undefined;

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGY = join(here, 'fake-agy.mjs');
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'angelia-agy-')));
// A folder of its own: AgyBrain writes GEMINI.md into the profile's folder before agy starts.
const base = { cwd: scratch(), add_dirs: [] as string[], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'agy' as const, permission_mode: 'acceptEdits' as const, sandbox: false };

const made: Brain[] = [];
process.on('exit', () => made.forEach((b) => b.kill()));
function make(o: { started?: boolean; id?: string; env?: NodeJS.ProcessEnv; model?: string; effort?: 'low' | 'max'; geminiDir?: string } = {}) {
  const p = { ...base, ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}) };
  const b = createBrain(p, { id: o.id ?? 'sess-1', started: !!o.started }, { bin: FAKE_AGY, permissionTimeoutMs: 200, stateDir: scratch(), geminiDir: o.geminiDir ?? scratch(), env: { ...process.env, ...o.env } });
  made.push(b); b.start();
  return b;
}
async function collect(b: Brain, text: string, allow = true): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of b.turn(text)) { out.push(e); if (e.kind === 'permission') b.answerPermission(e.id.slice(0, 8), allow); }
  return out;
}
const logged = (file: string) => readFileSync(file, 'utf8').trim().split('\n');

test('agy: config, factory, default binary and argv', () => {
  const cfg = Config.parse({ profiles: { a: { cwd: here, backend: 'agy' } }, routes: [] });
  assert.equal(cfg.profiles.a.backend, 'agy');
  assert.equal(DEFAULT_BIN.agy, 'agy');
  assert.ok(createBrain(base, { id: 'x', started: false }, { bin: 'true', geminiDir: scratch() }) instanceof AgyBrain);
  assert.deepEqual(agyArgv(base, '/s/agy/p'), ['agy', 'acp', '--gemini-dir', '/s/agy/p']);
  assert.deepEqual(agyArgv({ ...base, add_dirs: ['/x', '/y z'] }, '/g', '/bin/agy'), ['/bin/agy', 'acp', '--gemini-dir', '/g', '--add-dir', '/x', '--add-dir', '/y z']);
  assert.ok(!agyArgv({ ...base, permission_mode: 'bypassPermissions' }, '/g').includes('--dangerously-skip-permissions'), 'never skips permissions, even in bypass');
});

test('agy: the model is the default unless the profile names one; effort is the id suffix', () => {
  assert.equal(AGY_DEFAULT_MODEL, 'gemini-4-hydrogen-high');
  assert.equal(agyModel(base), 'gemini-4-hydrogen-high');
  assert.equal(agyModel({ ...base, effort: 'low' }), 'gemini-4-hydrogen-low');
  assert.equal(agyModel({ ...base, model: 'gemini-3.8-flash-high', effort: 'medium' }), 'gemini-3.8-flash-medium');
  assert.equal(agyModel({ ...base, model: 'gemini-4-neon', effort: 'max' }), 'gemini-4-neon-xhigh');
  assert.equal(agyModel({ ...base, model: 'gemini-pro-orchestrator-neon' }), 'gemini-pro-orchestrator-neon');
});

test('agy: the gemini dir is per profile in the state folder, private, never ~/.gemini', () => {
  const state = scratch();
  const a = agyGeminiDir(state, 'family'), b = agyGeminiDir(state, 'work');
  assert.notEqual(a, b);
  assert.ok(a.startsWith(join(state, 'agy') + '/'));
  assert.equal(statSync(a).mode & 0o777, 0o700);
  const brain = createBrain(base, { id: 'x', started: false }, { bin: 'true', apiSocket: join(state, 'api.sock'), profileName: 'family' }) as AgyBrain;
  assert.equal(brain.geminiDir, a);
});

test('agy: handshake sets the model; a turn ignores thoughts and usage; progress flushes at a tool call', async () => {
  const log = join(scratch(), 'log'), argvLog = join(scratch(), 'argv'), gd = scratch();
  const b = make({ env: { FAKE_AGY_LOG: log, FAKE_AGY_ARGV_LOG: argvLog }, geminiDir: gd });
  assert.deepEqual(await collect(b, 'hello'), [{ kind: 'result', text: 'echo: hello', isError: false }]);
  assert.equal(b.version, '1.5.14');
  assert.match(b.backendSessionId!, /^[0-9a-f-]{36}$/);
  assert.deepEqual(logged(log), [`new ${b.backendSessionId}`, 'set_model gemini-4-hydrogen-high', 'set_mode accept-edits']);
  assert.deepEqual(JSON.parse(logged(argvLog)[0]), ['acp', '--gemini-dir', gd]);
  assert.deepEqual(await collect(b, 'MODEL?'), [{ kind: 'result', text: 'model gemini-4-hydrogen-high', isError: false }]);
  assert.deepEqual(await collect(b, 'PROGRESS'), [{ kind: 'progress', text: 'working on it' }, { kind: 'result', text: 'all done', isError: false }]);
  await b.stop();
  assert.equal(b.alive, false);
});

test('agy: a permission request is relayed; allowed runs; refused ends with a fixed line, not an empty answer', async () => {
  const b = make();
  const ev = await collect(b, 'PERM', true);
  assert.deepEqual(ev, [{ kind: 'permission', id: 'call_8204146495325518175', tool: 'run_command', preview: 'rm -rf /tmp/x', request: { tool: 'Bash', input: { command: 'rm -rf /tmp/x' } } }, { kind: 'result', text: 'tool allowed', isError: false }]);
  const no = await collect(b, 'PERM', false);
  assert.deepEqual(no[1], { kind: 'result', text: 'agy stopped after a refused action (run_command): it did not run.', isError: false });
  // Never answered: the timeout refuses it, and the chat still hears why the turn ended.
  const ev2: BrainEvent[] = [];
  for await (const e of b.turn('PERM')) ev2.push(e);
  assert.equal(ev2[0].kind, 'permission');
  assert.equal((ev2[1] as any).text, 'agy stopped after a refused action (run_command): it did not run.');
  // A refused action does not leak into the next turn.
  assert.deepEqual(await collect(b, 'plain'), [{ kind: 'result', text: 'echo: plain', isError: false }]);
  await b.stop();
});

test('agy: gate() decides before the chat is asked: allow answers at once, block refuses and is remembered', async () => {
  const seen: string[] = [];
  class Gated extends AgyBrain {
    decide: GateDecision = 'allow';
    protected override gate(tc: Msg, request: { tool: string } | undefined): GateDecision { seen.push(`${tc.name}:${request?.tool ?? '-'}`); return this.decide; }
  }
  const b = new Gated(base, { id: 's', started: false }, { bin: FAKE_AGY, permissionTimeoutMs: 200, geminiDir: scratch() });
  made.push(b); b.start();
  assert.deepEqual(await collect(b, 'TWICE'), [{ kind: 'result', text: 'both ran', isError: false }]);
  assert.deepEqual(seen, ['run_command:Bash', 'write_file:Write']);
  b.decide = 'block';
  assert.deepEqual(await collect(b, 'PERM'), [{ kind: 'result', text: 'agy stopped after a refused action (run_command): it did not run.', isError: false }]);
  assert.equal(b.blocked.length, 1);
  assert.equal(b.blocked[0].tool, 'run_command'); assert.equal(b.blocked[0].preview, 'rm -rf /tmp/x');
  assert.equal(b.pendingPermissionCount, 0);
  await b.stop();
});

test('agy: two requests in one turn; refusing the second names it', async () => {
  const b = make();
  const out: BrainEvent[] = [];
  let n = 0;
  for await (const e of b.turn('TWICE')) { out.push(e); if (e.kind === 'permission') b.answerPermission(e.id, n++ === 0); }
  assert.deepEqual(out.map((e) => e.kind), ['permission', 'permission', 'result']);
  assert.equal((out[1] as any).tool, 'write_file');
  assert.equal((out[2] as any).text, 'agy stopped after a refused action (write_file): it did not run.');
  await b.stop();
});

test('agy: resume uses session/resume with no replay, and sets the model again', async () => {
  const log = join(scratch(), 'log');
  const r = make({ started: true, id: 'agy-old', env: { FAKE_AGY_LOG: log }, model: 'gemini-3.8-flash-high', effort: 'low' });
  assert.deepEqual(await collect(r, 'back'), [{ kind: 'result', text: 'echo: back', isError: false }]);
  assert.equal(r.backendSessionId, 'agy-old');
  await r.stop();
  assert.deepEqual(logged(log), ['resume agy-old', 'set_model gemini-3.8-flash-low', 'set_mode accept-edits', `close agy-old`]);
  await r.stop();
});

test('agy: a failed resume falls back to session/load, whose replay is dropped; no resume capability goes to load at once', async () => {
  const log = join(scratch(), 'log');
  const r = make({ started: true, id: 'agy-old', env: { FAKE_AGY_LOG: log, FAKE_AGY_NO_RESUME: '1' } });
  assert.deepEqual(await collect(r, 'back'), [{ kind: 'result', text: 'echo: back', isError: false }]);
  assert.deepEqual(logged(log), ['resume agy-old', 'load agy-old', 'set_model gemini-4-hydrogen-high', 'set_mode accept-edits']);
  assert.equal((r as AgyBrain).replayedUpdates, 2);
  await r.stop();
  const log2 = join(scratch(), 'log');
  const l = make({ started: true, id: 'agy-old', env: { FAKE_AGY_LOG: log2, FAKE_AGY_NO_RESUME_CAP: '1' } });
  assert.deepEqual(await collect(l, 'back'), [{ kind: 'result', text: 'echo: back', isError: false }]);
  assert.deepEqual(logged(log2), ['load agy-old', 'set_model gemini-4-hydrogen-high', 'set_mode accept-edits']);
  await l.stop();
});

test('agy: a model agy does not list, or refuses, fails the turn with the reason; a crash says why from stderr', async () => {
  const log = join(scratch(), 'log');
  const u = make({ model: 'gemini-9-nope', env: { FAKE_AGY_LOG: log } });
  const ev0 = await collect(u, 'hi');
  assert.equal(ev0.length, 1);
  assert.equal((ev0[0] as any).isError, true);
  assert.match((ev0[0] as any).reason, /^handshake: agy has no model gemini-9-nope; set model in the routing table to one of: gemini-4-hydrogen-low, /);
  assert.ok(!logged(log).some((l) => l.startsWith('set_model')), 'agy is not asked for a model it does not list');
  await u.stop();
  const b = make({ model: 'gemini-9-high', env: { FAKE_AGY_BAD_MODEL: 'gemini-9-high' } });
  const ev = await collect(b, 'hi');
  assert.equal(ev.length, 1);
  assert.match((ev[0] as any).reason, /handshake: agy refused model gemini-9-high: unknown model gemini-9-high/);
  await b.stop();
  const c = make();
  assert.deepEqual(await collect(c, 'CRASH'), [{ kind: 'result', text: '', isError: true, reason: 'exit: agy: you are not logged in' }]);
});

test('agy: a CLI that never answers is stopped at the start timeout, with agy named', async (t) => {
  const was = AgyBrain.startTimeoutMs;
  AgyBrain.startTimeoutMs = 300;
  t.after(() => { AgyBrain.startTimeoutMs = was; });
  const b = make({ env: { FAKE_AGY_SILENT: '1' } });
  const ev = await collect(b, 'hi');
  assert.match((ev[0] as any).reason, /agy did not answer within 0 s of starting; check that `agy --version` runs/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.alive, false, 'stopped, so the next message starts fresh');
});

test('orchestrator: an agy profile answers, its minted id replaces the row id, and the next spawn resumes it', async (t) => {
  const state = scratch();
  const log = join(scratch(), 'log');
  process.env.FAKE_AGY_LOG = log;
  t.after(() => { delete process.env.FAKE_AGY_LOG; });
  // Sandboxed where sandbox-exec exists (macOS): the daemon's own launch, through the sandbox.
  const cfg = Config.parse({ profiles: { a: { cwd: scratch(), backend: 'agy', ...(process.platform === 'darwin' ? {} : { sandbox: false }) } },
    routes: [{ platform: 'telegram', chat: 2, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } }, whatsapp: { send: async () => {} } },
    { stateDir: state, bins: { agy: FAKE_AGY } });
  t.after(() => o.shutdown());
  const dm = (text: string): Inbound => ({ platform: 'telegram', chat: '2', sender: 'u1', text, isGroup: false, mentioned: false, media: [] });
  await o.handle(dm('hi'));
  assert.match(sent[0], /^echo: /);
  const row = o.map.getActive('telegram:2')!;
  assert.match(row.id, /^[0-9a-f-]{36}$/); assert.ok(row.started); assert.equal(row.backend, 'agy');
  await o.handle(dm('/stop'));
  await o.handle(dm('PROGRESS'));
  assert.equal(sent.at(-1), 'all done');
  assert.equal(o.map.getActive('telegram:2')!.id, row.id);
  assert.ok(logged(log).includes(`resume ${row.id}`));
  assert.ok(statSync(join(state, 'agy')).isDirectory(), 'its gemini dir is under the instance state folder');
});

test('agy: stop and kill end the commands agy ran in sessions of their own (red team round 2)', async () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const how of ['stop', 'kill'] as const) {
    const file = join(scratch(), 'child.pid');
    const b = make({ env: { FAKE_AGY_SESSION_CHILD: file } });
    await collect(b, 'hi');
    const pid = Number(readFileSync(file, 'utf8'));
    assert.ok(alive(pid), 'the command runs');
    if (how === 'stop') await b.stop(500); else b.kill();
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(pid), false, `${how}: the command's own session ended with agy`);
  }
});
