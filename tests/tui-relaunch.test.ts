import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-tui.sh');
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

test('a pane that outlived a restart is relaunched only when its launch changed and it is idle', { skip: !hasTmux && 'no tmux', timeout: 60_000 }, async (t) => {
  // Own socket and own state dir, so nothing here can touch a live Angelia.
  const socket = `angelia-test-${process.pid}`;
  const state = mkdtempSync(join(tmpdir(), 'angelia-tuirl-'));
  process.env.ANGELIA_TMUX_SOCKET = socket;
  process.env.ANGELIA_STATE_DIR = state;
  const { TuiBrain } = await import('../src/brain/tui.js');
  const tmux = (...a: string[]) => execFileSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' }).trim();
  t.after(() => { try { tmux('kill-server'); } catch { /* already gone */ } });

  const cwd = mkdtempSync(join(tmpdir(), 'angelia-tuirl-cwd-'));
  const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
  const session = { id: '11111111-2222-3333-4444-555555555555', started: true };
  const brain = (system: string) => new TuiBrain(profile, session, { bin: FAKE, system });
  const ready = async (b: InstanceType<typeof TuiBrain>) => { b.start(); return (b as any).ready as Promise<string | null>; };
  const panePid = (name: string) => tmux('list-panes', '-t', name, '-F', '#{pane_pid}');

  const first = brain('v1');
  assert.equal(await ready(first), null);
  const pid1 = panePid(first.name);
  const fp = join(state, 'tui', first.name, 'launch.sha256');
  assert.ok(existsSync(fp));

  // Same launch after a "restart": reattached, not relaunched.
  assert.equal(await ready(brain('v1')), null);
  assert.equal(panePid(first.name), pid1);

  // New self prompt, idle pane: relaunched, resumed, fingerprint updated.
  const second = brain('v2');
  assert.equal(await ready(second), null);
  const pid2 = panePid(first.name);
  assert.notEqual(pid2, pid1);
  assert.equal(readFileSync(fp, 'utf8'), (second as any).fingerprint(true));
  assert.match(tmux('list-panes', '-t', first.name, '-F', '#{pane_start_command}'), /--resume 11111111-2222-3333-4444-555555555555/);

  // A compile that changes the profile's denies: relaunched too, since Claude reads settings at launch.
  const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
  md(join(cwd, '.claude'), { recursive: true });
  wf(join(cwd, '.claude', 'angelia-compiled.json'), JSON.stringify({ version: 1, deny: ['Read(~/.angelia/env)'], additionalDirectories: [], mcpServers: [], mcpStrict: false }));
  assert.equal(await ready(brain('v2')), null);
  const pid3 = panePid(first.name);
  assert.notEqual(pid3, pid2);

  // A pane from before fingerprints, in the middle of a turn: left alone.
  tmux('kill-session', '-t', first.name);
  tmux('new-session', '-d', '-s', first.name, '-x', '220', '-y', '50', 'env', 'FAKE_TUI_FRAME=pane-busy.txt', FAKE);
  const busyPid = panePid(first.name);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await ready(brain('v3')), null);
  assert.equal(panePid(first.name), busyPid);
});
