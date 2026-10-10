import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
