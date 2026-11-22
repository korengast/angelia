// The chat surfaces of an agy profile: /backend, /model and /effort, angelia ask,
// /history and export, send-media, and the wizard's login check. Everything through the fake agy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import type { Inbound } from '../src/core/types.js';
import { AGY_LACKS, AGY_TOKEN_NOTE } from '../src/core/orchestrator.js';
import { agyCatalogFromIds } from '../src/brain/catalog.js';
import { AskError } from '../src/brain/ask.js';
import { agyReplay } from '../src/brain/agy-history.js';
import { agyResolveModel } from '../src/brain/agy.js';
import { agyLoginProblem } from '../src/brain/agy-login.js';
import { agyExportRows, exportChat } from '../src/instance/export.js';
import { resolveMedia } from '../src/core/deliver/media.js';
import { agentDenyRules } from '../src/capabilities/compile.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGY = join(here, 'fake-agy.mjs');
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'angelia-agy-surf-')));

function setup(profile: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const cfg = Config.parse({
    profiles: { a: { cwd: scratch(), backend: 'agy', sandbox: false, answer_from: ['b'], ...profile }, b: { cwd: here } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'a' }, { platform: 'telegram', chat: 2, profile: 'b' }], defaults: { max_out_per_min: 1000 },
  });
  const sent: string[] = [];
  const asked: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } } }, {
    stateDir: scratch(), bins: { agy: FAKE_AGY, 'claude-code': join(here, 'fake-claude.mjs') },
    catalog: async (b) => { asked.push(b); return { models: [], efforts: ['low'], anyModel: true }; },
    ...extra,
  });
  const dm = (text: string): Inbound => ({ platform: 'telegram', chat: '1', sender: 'u1', text, isGroup: false, mentioned: false, media: [] });
  return { o, cfg, sent, asked, dm };
}

test('/backend lists agy; switching to it says what agy lacks next to Claude Code', async (t) => {
  const calls: string[] = [];
  const { o, sent, dm } = setup({ backend: 'claude-code' }, {
    switchBackend: (p: string, b: string) => { calls.push(`${p}->${b}`); return { removed: [], restored: [], notes: [] }; },
  });
  t.after(() => o.shutdown());
  await o.handle(dm('/backend'));
  assert.match(sent.at(-1)!, /• agy \(Antigravity\)\n/);
  await o.handle(dm('/backend agy'));
  assert.deepEqual(calls, ['a->agy']);
  assert.match(sent.at(-1)!, /^Profile a now runs on Antigravity\./);
  assert.ok(sent.at(-1)!.includes(AGY_LACKS));
  assert.ok(sent.at(-1)!.includes(AGY_TOKEN_NOTE), 'the sign-in token limit is said');
  for (const w of ['tmux mode', 'chrome: true', 'prompt cache', 'subagents']) assert.ok(AGY_LACKS.includes(w), w);
});

test('/model and /effort on agy: the running session\'s own list, no `agy models` run; a full id names its effort', async (t) => {
  const { o, sent, asked, dm } = setup();
  t.after(() => o.shutdown());
  await o.handle(dm('hi'));
  await o.handle(dm('/model'));
  assert.deepEqual(asked, [], 'the live session listed its models');
  assert.match(sent.at(-1)!, /Antigravity models:\n• gemini-4-hydrogen \(default\)\n• gemini-4-neon\n• gemini-3\.8-flash\n• gemini-9\nThe models this agy session listed\./);
  await o.handle(dm('/model gemini-7'));
  assert.match(sent.at(-1)!, /^Antigravity has no model gemini-7\. Choose one of: gemini-4-hydrogen, gemini-4-neon/);
  await o.handle(dm('/model gemini-4-neon-low'));
  assert.equal(sent.at(-1), 'model set to gemini-4-neon at effort low for this session.');
  assert.deepEqual([o.map.getActive('telegram:1')!.model, o.map.getActive('telegram:1')!.effort], ['gemini-4-neon', 'low'], 'the suffix given is kept as the effort');
  await o.handle(dm('/model gemini-4-neon-high'));
  assert.equal(sent.at(-1), 'model set to gemini-4-neon at effort high for this session.');
  await o.handle(dm('/effort max'));
  assert.equal(sent.at(-1), 'effort for gemini-4-neon is one of low, medium, high, xhigh, or default.');
  await o.handle(dm('/effort xhigh'));
  assert.equal(sent.at(-1), 'effort set to xhigh for this session.');
  const row = o.map.getActive('telegram:1')!;
  assert.deepEqual([row.model, row.effort], ['gemini-4-neon', 'xhigh']);
  // No live session now (dropped by /effort): the session's list is kept, still no `agy models`.
  await o.handle(dm('/model'));
  assert.match(sent.at(-1)!, /^Model: gemini-4-neon \(this session\)/);
  assert.deepEqual(asked, []);
  // A model chosen without an effort runs: agy is set to its high id (agy lists no bare ids).
  await o.handle(dm('/effort default'));
  await o.handle(dm('/model gemini-9'));
  await o.handle(dm('hi'));
  assert.doesNotMatch(sent.at(-1)!, /Something broke|has no model/);
  assert.equal(agyResolveModel('gemini-9', ['gemini-9-low', 'gemini-9-high']), 'gemini-9-high');
  assert.equal(agyResolveModel('m', ['m-low']), 'm-low');
  assert.equal(agyResolveModel('m-xhigh', ['m-xhigh']), 'm-xhigh');
  assert.equal(agyResolveModel('claude-x', ['claude-x']), 'claude-x');
  assert.equal(agyResolveModel('nope', ['m-high']), undefined);
  assert.equal(agyResolveModel('any', []), 'any');
  assert.deepEqual(agyCatalogFromIds(['m-low', 'm-high', 'plain']).models.map((m) => [m.id, m.efforts]), [['m', ['low', 'high']], ['plain', undefined]]);
});

test('angelia ask: an agy profile is refused with a 501 that says why', async (t) => {
  const { o } = setup();
  t.after(() => o.shutdown());
  await assert.rejects(o.ask('telegram:1', 'what is new?', 'telegram:2'), (e: AskError) => e.status === 501 && /cannot answer here now/.test(e.message));
});

test('/history: an agy session is replayed with session/load; not started has nothing; export takes the same rows', async (t) => {
  const { o, cfg, dm } = setup();
  t.after(() => o.shutdown());
  const fresh = await o.historyOf('telegram:1');
  assert.equal(fresh?.session, null);
  await o.handle(dm('hi'));
  const h = await o.historyOf('telegram:1');
  assert.equal(h?.supported, true);
  assert.deepEqual(h?.items.map((i) => [i.role, i.text]), [['user', 'earlier question'], ['assistant', 'replayed history']]);
  const id = o.map.getActive('telegram:1')!.id;
  // The reader alone, and export through it.
  const direct = await agyReplay(cfg.profiles.a, id, { stateDir: scratch(), profileName: 'a', bin: FAKE_AGY });
  assert.equal(direct?.items.length, 2);
  const sessions = { chats: { 'telegram:1': { active: id, history: [{ id, started: true, backend: 'agy' }] } } } as any;
  const warned: string[] = [];
  const agy = await agyExportRows(cfg, sessions, 'telegram:1', { stateDir: scratch(), bin: FAKE_AGY, warn: (l) => warned.push(l) });
  const rows = exportChat(cfg, sessions, 'telegram:1', { agy });
  assert.deepEqual(rows.map((r) => [r.backend, r.role, r.text]), [['agy', 'user', 'earlier question'], ['agy', 'assistant', 'replayed history']]);
  const none = await agyExportRows(cfg, sessions, 'telegram:1', { stateDir: scratch(), replay: async () => undefined, warn: (l) => warned.push(l) });
  assert.equal(none.size, 0);
  assert.deepEqual(warned, [`agy did not replay session ${id}`]);
  // What agy would load that Angelia did not give it stops the replay as it stops a chat's start.
  writeFileSync(join(cfg.profiles.a.cwd, 'AGENTS.md'), 'planted');
  await assert.rejects(agyReplay(cfg.profiles.a, id, { stateDir: scratch(), profileName: 'a', bin: FAKE_AGY }), /agy not started: .*AGENTS\.md/);
  warned.length = 0;
  assert.equal((await agyExportRows(cfg, sessions, 'telegram:1', { stateDir: scratch(), bin: FAKE_AGY, warn: (l) => warned.push(l) })).size, 0);
  assert.match(warned[0], /agy did not replay session .*: agy not started/);
});

test('send-media from an agy profile: its deny rules bind the path (the floor\'s ~/.ssh), a file in its folder goes', () => {
  const state = scratch(), cwd = scratch();
  const cfg = Config.parse({ profiles: { a: { cwd, backend: 'agy' } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }] });
  const deny = agentDenyRules(cfg, 'a', state);
  assert.ok(deny.some((r) => r.startsWith(`Read(${join(homedir(), '.ssh')}`)), 'the floor is in the rules');
  const f = join(cwd, 'out.txt'); writeFileSync(f, 'x');
  assert.equal(resolveMedia({ path: f }, 'telegram', { stateDir: state, deny }).path, f);
  const fakeHome = scratch(); mkdirSync(join(fakeHome, '.ssh')); writeFileSync(join(fakeHome, '.ssh', 'id'), 'k');
  assert.throws(() => resolveMedia({ path: join(fakeHome, '.ssh', 'id') }, 'telegram', { home: fakeHome, stateDir: state, deny }));
});

test('wizard login check: agy signed in is fine; not signed in says so', async () => {
  assert.equal(await agyLoginProblem(FAKE_AGY), undefined);
  assert.equal(await agyLoginProblem(FAKE_AGY, { env: { ...process.env, FAKE_AGY_NO_AUTH: '1' } }), 'agy is not signed in');
  assert.match((await agyLoginProblem('/nonexistent/agy'))!, /^agy did not start/);
});
