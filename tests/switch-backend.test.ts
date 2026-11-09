import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { loadConfig } from '../src/instance/config/load.js';
import { tableChanges, tablePath, writeAccepted } from '../src/instance/accepted.js';
import { switchBackend } from '../src/instance/switch-backend.js';

/** A table with one profile under `name`, accepted as it stands. */
function setup(name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'switch-'));
  const path = join(dir, 'routing.yaml');
  writeFileSync(path, `profiles:\n  ${JSON.stringify(name)}: {cwd: ${dir}, model: some-model}\nroutes:\n  - {platform: telegram, chat: 1, profile: ${JSON.stringify(name)}}\ntelegram: {}\n`);
  const instance = join(dir, 'instance');
  const cfg = loadConfig(path);
  writeAccepted(cfg, instance);
  return { path, cfg, instance };
}

for (const name of ['עוזרת-בריאות-שיר', "it's", 'a/b']) {
  test(`/backend switches a profile named ${JSON.stringify(name)} without counting its own change as someone else's`, () => {
    const s = setup(name);
    switchBackend({ table: s.path, cfg: s.cfg, profile: name, backend: 'pi', instance: s.instance });
    assert.match(readFileSync(s.path, 'utf8'), /backend: pi/);
  });
}

test('tablePath writes each part as the change list writes it', () => {
  const was = loadConfig(setup('x').path);
  const now = structuredClone(was);
  now.profiles["it's"] = { ...was.profiles.x };
  now.profiles['עוזרת'] = { ...was.profiles.x };
  const lines = tableChanges(was, now);
  assert.ok(lines.some((l) => l.startsWith(`${tablePath('profiles', "it's")}: `)), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith(`${tablePath('profiles', 'עוזרת')}: `)), 'Hebrew is shown as it is');
  assert.equal(tablePath('profiles', 'a\nb'), 'profiles."a\\nb"', 'a line break is never shown raw');
  assert.equal(tablePath('profiles', 'a‏b'), 'profiles."a‏b"', 'nor a bidi mark');
});

test('/backend keeps the old CLI\'s model, effort and bin under backends:, and a switch back puts them on again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'switch-'));
  const path = join(dir, 'routing.yaml');
  writeFileSync(path, `profiles:\n  a:\n    cwd: ${dir}\n    model: claude-opus-5-5\n    effort: high\n    bin: /Users/example/bin/claude\n    tui: true\nroutes:\n  - {platform: telegram, chat: 1, profile: a}\ntelegram: {}\n`);
  const instance = join(dir, 'instance');
  const cfg = loadConfig(path);
  writeAccepted(cfg, instance);
  const away = switchBackend({ table: path, cfg, profile: 'a', backend: 'pi', instance });
  assert.deepEqual(away.removed, ['model: claude-opus-5-5', 'effort: high', 'bin: /Users/example/bin/claude', 'tui: true']);
  assert.deepEqual(away.restored, []);
  let text = readFileSync(path, 'utf8');
  assert.match(text, /backend: pi/);
  assert.doesNotMatch(text, /^    model:/m);
  assert.deepEqual(cfg.profiles.a.backends, { 'claude-code': { model: 'claude-opus-5-5', effort: 'high', bin: '/Users/example/bin/claude', tui: true } });
  assert.equal(cfg.profiles.a.model, undefined);
  // The owner picks a pi model by hand meanwhile: it is pi's, and goes under backends.pi on the way back.
  writeFileSync(path, text.replace('backend: pi', 'backend: pi\n    model: anthropic/claude-sonnet-5-5'));
  writeAccepted(loadConfig(path), instance);
  const back = switchBackend({ table: path, cfg, profile: 'a', backend: 'claude-code', instance });
  assert.deepEqual(back.removed, ['model: anthropic/claude-sonnet-5-5']);
  assert.deepEqual(back.restored, ['model: claude-opus-5-5', 'effort: high', 'bin: /Users/example/bin/claude', 'tui: true']);
  text = readFileSync(path, 'utf8');
  assert.match(text, /backend: claude-code/);
  assert.equal(cfg.profiles.a.model, 'claude-opus-5-5');
  assert.equal(cfg.profiles.a.effort, 'high');
  assert.equal(cfg.profiles.a.bin, '/Users/example/bin/claude');
  assert.equal(cfg.profiles.a.tui, true);
  assert.deepEqual(cfg.profiles.a.backends, { pi: { model: 'anthropic/claude-sonnet-5-5' } }, 'the spent entry is gone, pi\'s is kept');
  // Back to pi: its model returns, and the claude-code entry is written fresh from the profile as it is now.
  const again = switchBackend({ table: path, cfg, profile: 'a', backend: 'pi', instance });
  assert.deepEqual(again.restored, ['model: anthropic/claude-sonnet-5-5']);
  assert.equal(cfg.profiles.a.model, 'anthropic/claude-sonnet-5-5');
  assert.deepEqual(Object.keys(cfg.profiles.a.backends ?? {}), ['claude-code']);
  assert.equal(loadConfig(path).profiles.a.model, 'anthropic/claude-sonnet-5-5', 'the table loads: check-config accepts backends:');
});

test('/backend with nothing to keep writes no backends: key, and a profile with none switches as before', () => {
  const s = setup('plain');
  writeFileSync(s.path, readFileSync(s.path, 'utf8').replace(', model: some-model', ''));
  const cfg = loadConfig(s.path);
  writeAccepted(cfg, s.instance);
  const r = switchBackend({ table: s.path, cfg, profile: 'plain', backend: 'codex', instance: s.instance });
  assert.deepEqual(r, { removed: [], restored: [], notes: r.notes });
  assert.doesNotMatch(readFileSync(s.path, 'utf8'), /backends:/);
});

test('/backend looks for a CLI through the bin kept under backends:, so a CLI reachable only that way counts as installed', async () => {
  const { backendBin } = await import('../src/core/orchestrator.js');
  const here = dirname(fileURLToPath(import.meta.url));
  const p = Config.parse({ profiles: { a: { cwd: here, bin: '/opt/claude-x', backends: { codex: { bin: '/opt/codex-x', model: 'gpt-5.5' } } } }, routes: [] }).profiles.a;
  assert.equal(backendBin(p, 'claude-code'), '/opt/claude-x', 'its own CLI: the profile bin');
  assert.equal(backendBin(p, 'codex'), '/opt/codex-x', 'the kept bin of the CLI it is going back to');
  assert.equal(backendBin(p, 'pi'), 'pi', 'nothing kept: the default name, never the current bin');
});
