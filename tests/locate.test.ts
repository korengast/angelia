import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { cliWarnings, locateBin, pathWithBins } from '../src/brain/locate.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

function exe(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
}

test('locateBin: PATH first, then the install folders a daemon PATH may lack; a path is taken as given', () => {
  const home = mkdtempSync(join(tmpdir(), 'angelia-home-'));
  const onPath = mkdtempSync(join(tmpdir(), 'angelia-path-'));
  const local = exe(join(home, '.local', 'bin', 'claude'));
  // The 2026-09-21 outage: a PATH without ~/.local/bin.
  assert.equal(locateBin('claude', { PATH: '/usr/bin:/bin' }, home), local);
  const first = exe(join(onPath, 'claude'));
  assert.equal(locateBin('claude', { PATH: onPath }, home), first);
  assert.equal(locateBin('nope-no-such-cli', { PATH: onPath }, home), undefined);
  assert.equal(locateBin('~/.local/bin/claude', {}, home), local);
  assert.equal(locateBin(join(home, 'missing'), {}, home), undefined);
  writeFileSync(join(onPath, 'angelia-test-cli'), 'not executable');
  assert.equal(locateBin('angelia-test-cli', { PATH: onPath }, home), undefined);
});

test('cliWarnings names the profile and the fix; pathWithBins adds only folders PATH lacks', () => {
  const home = mkdtempSync(join(tmpdir(), 'angelia-home-'));
  exe(join(home, '.local', 'bin', 'claude'));
  const cfg = Config.parse({
    profiles: { a: { cwd: here }, g: { cwd: here, backend: 'grok', bin: 'angelia-test-grok' }, x: { cwd: here, bin: join(home, 'gone') } },
    routes: [],
  });
  const w = cliWarnings(cfg, { PATH: '/usr/bin' }, home);
  assert.equal(w.length, 2);
  assert.match(w[0], /^profiles\.g\.bin: angelia-test-grok is not an executable file/);
  assert.match(w[1], /^profiles\.x\.bin: .*gone is not an executable file/);
  const p = pathWithBins(cfg, { PATH: '/usr/bin' }, home);
  assert.deepEqual(p.added, [join(home, '.local', 'bin')]);
  assert.equal(p.path, `/usr/bin:${join(home, '.local', 'bin')}`);
  assert.deepEqual(pathWithBins(cfg, { PATH: `/usr/bin:${join(home, '.local', 'bin')}` }, home).added, []);
});

test('a chat whose CLI is missing hears so plainly, and nothing is spawned', async (t) => {
  const cfg = Config.parse({
    profiles: { a: { cwd: here, bin: join(here, 'no-such-claude') } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'a' }],
    defaults: { max_out_per_min: 1000 },
  });
  const sent: string[] = [];
  const logs: string[] = [];
  const sender = { send: async (_c: string, text: string) => { sent.push(text); } };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-orch-')), log: (l) => logs.push(l) });
  t.after(() => o.shutdown());
  const i: Inbound = { platform: 'telegram', chat: '1', sender: 'u1', senderName: 'Owner', text: 'hello', isGroup: false, mentioned: false, media: [] };
  await o.handle(i);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /no-such-claude\) is not installed where Angelia can find it/);
  assert.ok(logs.some((l) => /turn failed key=telegram:1 reason=.*no-such-claude not found/.test(l)));
  assert.equal(o.status().filter((s) => s.alive).length, 0);
});
