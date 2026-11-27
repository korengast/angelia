import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Config } from '../src/instance/config/schema.js';
import { tmp } from './tmp.js';

test('a pane on another tmux server: every tmux call names it, and so does the line that says where to look; the default stays angelia', async (t) => {
  // The module reads the default socket's name at import: a test runner that set one would move it.
  delete process.env.ANGELIA_TMUX_SOCKET;
  const { screenOnlyLine, TuiBrain } = await import('../src/brain/tui.js');
  // A pretend tmux first on the server's PATH, which writes down how it was called. No real tmux is
  // on this PATH, so no real server, Angelia's least of all, is ever asked anything.
  const dir = tmp(t, 'angelia-tuisocket-');
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'tmux'), `#!/bin/sh\necho "$*" >> "${calls}"\n`, { mode: 0o755 });
  const hostEnv = { PATH: `${dir}:/usr/bin:/bin` };
  const profile = Config.parse({ profiles: { x: { cwd: dir, tui: true } }, routes: [] }).profiles.x;
  const session = { id: crypto.randomUUID(), started: false };
  const own = new TuiBrain(profile, session, { hostEnv, stateDir: dir, tmuxSocket: 'angelia-canary-1' });
  const usual = new TuiBrain(profile, session, { hostEnv, stateDir: dir });
  await (own as any).tm(['has-session', '-t', own.name]);
  await (own as any).capture(30);
  await (usual as any).tm(['has-session', '-t', usual.name]);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
    `-L angelia-canary-1 has-session -t ${own.name}`,
    `-L angelia-canary-1 capture-pane -p -t =${own.name}: -S -30`,
    `-L angelia has-session -t ${usual.name}`,
  ]);
  assert.equal((own as any).socket, 'angelia-canary-1');
  assert.equal((usual as any).socket, 'angelia');
  assert.match(screenOnlyLine('pane-1', 'angelia-canary-1'), /\(tmux -L angelia-canary-1 attach -t '=pane-1'\)/);
  assert.match(screenOnlyLine('pane-1'), /\(tmux -L angelia attach -t '=pane-1'\)/);
  // A dialog the screen names: a teammate's, by its agent.
  assert.match(screenOnlyLine('pane-1', 'angelia', { tool: 'Bash command', from: 'the restart-relay agent' }), /^A permission waits: Bash command from the restart-relay agent\. It did not come through Angelia/);
  // The start's own failure text is built from the same name.
  assert.ok(readFileSync(join(import.meta.dirname, '..', 'src', 'brain', 'tui.ts'), 'utf8').includes("(look with: tmux -L ${this.socket} attach -t '=${this.name}')"));
});
