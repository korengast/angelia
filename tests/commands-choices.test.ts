import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { parseCommand } from '../src/core/commands.js';
import { parseCodexModels, parseGrokModels, parsePiModels, effortsFor, type Catalog } from '../src/brain/catalog.js';
import { limitHint } from '../src/core/deliver/text.js';
import { switchBackend } from '../src/instance/switch-backend.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

test('the CLIs\' own model lists read as a catalog', () => {
  assert.deepEqual(parseGrokModels('You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  - grok-4.7\n  * grok-4.6 (default)\n  - grok-4.5\n'),
    [{ id: 'grok-4.7' }, { id: 'grok-4.6', isDefault: true }, { id: 'grok-4.5' }]);
  // Shape of codex-cli 0.157.0 model/list, 2026-09-25.
  const codex = parseCodexModels({ data: [
    { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'max' }], defaultReasoningEffort: 'medium' },
    { id: 'secret-preview', hidden: true },
    { id: 'gpt-5.5', supportedReasoningEfforts: ['low', 'high'] },
  ] });
  assert.deepEqual(codex.map((m) => m.id), ['gpt-6-luna', 'gpt-5.5']);
  // Shape of pi 0.86.1 --list-models: only models it has a login or key for; named provider/model.
  assert.deepEqual(parsePiModels('provider      model                       context  max-out  thinking  images\nxai           grok-4.7                    500K     500K     yes       yes   \nopenai-codex  gpt-5.3-codex-spark         128K     128K     yes       no    \n'),
    [{ id: 'xai/grok-4.7' }, { id: 'openai-codex/gpt-5.3-codex-spark' }]);
  assert.deepEqual(parsePiModels('No models available. Use /login or set an API key environment variable.\n'), []);
  assert.match(limitHint('pi'), /\/model provider\/model/);
  const c: Catalog = { models: codex, efforts: ['low'], anyModel: false };
  assert.deepEqual(effortsFor(c, undefined), { levels: ['low', 'medium', 'max'], defaultLevel: 'medium' });
  assert.deepEqual(effortsFor(c, 'gpt-5.5'), { levels: ['low', 'high'] });
  assert.deepEqual(effortsFor(c, 'unknown'), { levels: ['low'] });
  assert.deepEqual(parseCommand('/backend codex'), { name: 'backend', value: 'codex' });
  assert.deepEqual(parseCommand('/backend'), { name: 'backend', value: undefined });
});

const codexCatalog: Catalog = { models: [
  { id: 'gpt-6-luna', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
], efforts: ['low', 'medium', 'high', 'xhigh'], anyModel: false };

function setup(profile: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-choices-'));
  const cfg = Config.parse({ profiles: { a: { cwd: here, ...profile } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }, { platform: 'telegram', chat: 2, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [];
  const asked: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } } }, {
    stateDir: dir, bins: { 'claude-code': join(here, 'fake-claude.mjs'), codex: join(here, 'fake-codex.mjs'), grok: join(here, 'fake-grok.mjs'), pi: join(here, 'fake-pi.mjs') },
    catalog: async (b) => { asked.push(b); return b === 'codex' ? codexCatalog : { models: [], efforts: ['low'], anyModel: true }; },
    ...extra,
  });
  const dm = (text: string, sender = 'u1'): Inbound => ({ platform: 'telegram', chat: '1', sender, text, isGroup: false, mentioned: false, media: [] });
  return { o, cfg, sent, asked, dm };
}

test('/model and /effort show the value now and the choices of the CLI, and refuse what it does not offer', async (t) => {
  const { o, sent, asked, dm } = setup({ backend: 'codex' });
  t.after(() => o.shutdown());
  await o.handle(dm('/model'));
  assert.equal(sent.at(-1), "Model: Codex's default, gpt-6-luna\n\nCodex models:\n• gpt-6-luna (default)\n• gpt-5.5\n\nSet for this session: /model <name>. Back to the profile's: /model default");
  await o.handle(dm('/model gpt-6'));
  assert.equal(sent.at(-1), 'Codex has no model gpt-6. Choose one of: gpt-6-luna, gpt-5.5.');
  await o.handle(dm('/effort'));
  assert.match(sent.at(-1)!, /^Effort: the default, medium\nLevels for gpt-6-luna: low, medium \(default\), high, xhigh, max\n/);
  await o.handle(dm('/model gpt-5.5'));
  assert.equal(sent.at(-1), 'model set to gpt-5.5 for this session.');
  await o.handle(dm('/model'));
  assert.match(sent.at(-1)!, /^Model: gpt-5\.5 \(this session\)/);
  // The levels follow the model: gpt-5.5 has no max.
  await o.handle(dm('/effort max'));
  assert.equal(sent.at(-1), 'effort for gpt-5.5 is one of low, medium, high, xhigh, or default.');
  await o.handle(dm('/effort XHIGH'));
  assert.equal(sent.at(-1), 'effort set to xhigh for this session.');
  // Asked once, then reused.
  assert.equal(asked.length, 1);
});

test('/backend shows the CLIs, switches the profile for every chat on it, and is for owners', async (t) => {
  const calls: string[] = [];
  const { o, cfg, sent, dm } = setup({ backend: 'claude-code', model: 'opus' }, {
    switchBackend: (p: string, b: string) => { calls.push(`${p}->${b}`); cfg.profiles[p] = { ...cfg.profiles[p], backend: b as any, model: undefined }; return { removed: ['model: opus'], notes: [] }; },
  });
  t.after(() => o.shutdown());
  await o.handle(dm('/backend'));
  assert.equal(sent.at(-1), 'Backend of profile a: claude-code (Claude Code)\n\n• claude-code (Claude Code) — now\n• grok (Grok Build)\n• codex (Codex)\n• pi (pi)\n\nSwitch: /backend <name>. It changes the profile for all 2 chats that use it and starts a fresh session.');
  await o.handle(dm('/backend gemini'));
  assert.equal(sent.at(-1), 'No backend gemini. Choose one of: claude-code, grok, codex, pi.');
  await o.handle(dm('/backend claude-code'));
  assert.equal(sent.at(-1), 'Profile a already runs on Claude Code.');
  await o.handle(dm('hi'));
  const before = o.map.getActive('telegram:1')!.id;
  await o.handle(dm('/backend Codex'));
  assert.deepEqual(calls, ['a->codex']);
  assert.match(sent.at(-1)!, /^Profile a now runs on Codex\. New session [0-9a-f]{8} started\.\nTaken off the profile, they belonged to Claude Code: model: opus\.\n1 other chat on this profile switches? at their next message\./);
  assert.notEqual(o.map.getActive('telegram:1')!.id, before);
  await o.handle(dm('hi'));
  assert.match(sent.at(-1)!, /echo: /, 'the next message runs on the new CLI');
  assert.equal(o.map.getActive('telegram:1')!.backend, 'codex');
  // The other chat chose a model for a session it has not used yet: that choice was for Codex.
  o.map.ensureActive('telegram:2');
  o.map.setOverride('telegram:2', { model: 'gpt-5.5', effort: 'xhigh' });
  await o.handle(dm('/backend pi'));
  assert.deepEqual(calls, ['a->codex', 'a->pi']);
  assert.equal(o.map.getActive('telegram:2')?.model, undefined);
  assert.equal(o.map.getActive('telegram:2')?.effort, undefined);
  assert.match(sent.at(-1)!, /^Profile a now runs on pi\. New session [0-9a-f]{8} started\.\n.*Pick a model with \/model: pi's own default/s);
});

test('/backend: a daemon that cannot write the table says so and changes nothing; a non-owner is refused', async (t) => {
  const b = setup({ backend: 'codex' });
  t.after(() => b.o.shutdown());
  await b.o.handle(b.dm('/backend claude-code'));
  assert.match(b.sent.at(-1)!, /^This daemon cannot change the routing table/);
  assert.equal(b.cfg.profiles.a.backend, 'codex');
  const g = Config.parse({ profiles: { a: { cwd: here } }, routes: [{ platform: 'telegram', chat: -5, profile: 'a', owners: ['boss'], allow_from: ['*'], mention: 'any' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [];
  const o = new Orchestrator(g, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } } }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-choices-')), switchBackend: () => { throw new Error('must not run'); } });
  t.after(() => o.shutdown());
  await o.handle({ platform: 'telegram', chat: '-5', sender: 'guest', text: '/backend codex', isGroup: true, mentioned: true, media: [] });
  assert.match(sent.at(-1)!, /owner/i);
});

test('switchBackend: the table keeps its layout, loses what belonged to the old CLI, is compiled, and comes back on a failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-switch-'));
  const cwd = join(dir, 'p'); mkdirSync(cwd);
  const table = join(dir, 'routing.yaml');
  const text = `# my table\ntelegram: { token_env: QA_TG }\nprofiles:\n  a:\n    cwd: ${cwd}   # keep me\n    model: claude-opus-5-5\n    effort: high\n    tui: true\n    permission_mode: acceptEdits\nroutes:\n  - { platform: telegram, chat: 1, profile: a }\n`;
  writeFileSync(table, text);
  const cfg = Config.parse({ profiles: { a: { cwd } }, routes: [] });
  const r = switchBackend({ table, cfg, profile: 'a', backend: 'codex', instance: dir });
  assert.deepEqual(r.removed, ['model: claude-opus-5-5', 'effort: high', 'tui: true']);
  const now = readFileSync(table, 'utf8');
  assert.match(now, /^# my table\n/); assert.match(now, /# keep me/); assert.match(now, /backend: codex/);
  assert.doesNotMatch(now, /model:|effort:|tui:/);
  assert.equal(cfg.profiles.a.backend, 'codex');
  assert.ok(readdirSync(dir).some((f) => f.startsWith('routing.yaml.') && f.endsWith('.bak')), 'a backup is made');
  assert.ok(readdirSync(join(dir, 'compiled')).length, 'the profile is compiled for the new CLI');
  // The switch builds on the table as it stands: an edit nobody accepted stops it, untouched.
  const switched = readFileSync(table, 'utf8');
  writeFileSync(table, switched.replace('permission_mode: acceptEdits', 'permission_mode: acceptEdits\n    shell: true'));
  assert.throws(() => switchBackend({ table, cfg, profile: 'a', backend: 'pi', instance: dir }), /not switching: the routing table has 1 change/);
  assert.equal(cfg.profiles.a.backend, 'codex');
  writeFileSync(table, switched);
  // A table that would not load after the switch (bypass on a folder with a .env) is put back as it was.
  writeFileSync(join(cwd, '.env'), 'X=1\n');
  writeFileSync(table, now.replace('permission_mode: acceptEdits', 'permission_mode: bypassPermissions'));
  const before = readFileSync(table, 'utf8');
  assert.throws(() => switchBackend({ table, cfg, profile: 'a', backend: 'pi', instance: dir }), /bypassPermissions on a directory containing \.env/);
  assert.equal(readFileSync(table, 'utf8'), before);
  assert.equal(cfg.profiles.a.backend, 'codex');
});
