import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-tui-env.sh');
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();

test('tmux panes: no secret from a server an older daemon started, only their own capability secrets, none on a tmux command line', { skip: !hasTmux && 'no tmux', timeout: 60_000 }, async (t) => {
  // Own socket and own state dir, so nothing here can touch a live Angelia. Set before the import:
  // the socket name is read when the module loads.
  const socket = `angelia-envtest-${process.pid}`;
  const state = mkdtempSync(join(tmpdir(), 'angelia-tuienv-'));
  process.env.ANGELIA_TMUX_SOCKET = socket;
  process.env.ANGELIA_STATE_DIR = state;
  const { TuiBrain, scrubTmuxServer } = await import('../src/brain/tui.js');
  const { profileEnv, tableSecrets } = await import('../src/core/env.js');
  const { capabilityEnv } = await import('../src/capabilities/resolve.js');
  const tmux = (...a: string[]) => execFileSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' }).trim();
  t.after(() => { try { tmux('kill-server'); } catch { /* already gone */ } });

  // What an older daemon left behind: a server that started with every secret it held.
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'old', 'sleep 600'], {
    env: { ...process.env, TELEGRAM_BOT_TOKEN: 'canary-token', CANARY_BANK: 'canary-bank-old', CANARY_OTHER: 'canary-other' },
  });
  assert.match(tmux('show-environment', '-g'), /^CANARY_BANK=/m);

  const dirs = { money: mkdtempSync(join(tmpdir(), 'angelia-tuienv-money-')), family: mkdtempSync(join(tmpdir(), 'angelia-tuienv-family-')) };
  const cfg = Config.parse({
    capabilities: { bank: { kind: 'mcp', command: 'bank', env: ['CANARY_BANK'] } },
    profiles: { money: { cwd: dirs.money, tui: true, capabilities: ['bank'] }, family: { cwd: dirs.family, tui: true } },
    routes: [],
    telegram: { token_env: 'TELEGRAM_BOT_TOKEN' },
  });
  const secrets = { TELEGRAM_BOT_TOKEN: 'canary-token', CANARY_BANK: 'canary-bank', CANARY_OTHER: 'canary-other' };
  const launch = async (name: 'money' | 'family') => {
    const e = profileEnv(process.env, secrets, tableSecrets(cfg), capabilityEnv(cfg, name));
    const b = new TuiBrain(cfg.profiles[name], { id: `${name === 'money' ? 'aaaaaaaa' : 'bbbbbbbb'}-2222-3333-4444-555555555555`, started: false }, {
      bin: FAKE, env: e.env, hostEnv: profileEnv(process.env, secrets, tableSecrets(cfg)).env, granted: e.granted, withheld: e.withheld,
    });
    b.start();
    assert.equal(await (b as any).ready, null);
    return { b, seen: readFileSync(join(dirs[name], 'pane-env.txt'), 'utf8').trim().split('\n').filter(Boolean) };
  };

  // Before any clean-up: the pane's own unset list keeps the old server's secrets out.
  const money = await launch('money');
  assert.deepEqual(money.seen, ['CANARY_BANK=canary-bank'], 'its own login, the current value, nothing else');
  const family = await launch('family');
  assert.deepEqual(family.seen, [], 'the old server has the bank login; this pane does not');

  // The granted secret went through a file that is gone now, and never through tmux itself.
  assert.equal(existsSync(join(state, 'tui', money.b.name, 'env')), false);
  assert.doesNotMatch(tmux('show-environment', '-t', money.b.name), /canary-bank/);
  assert.doesNotMatch(tmux('list-panes', '-a', '-F', '#{pane_start_command}'), /canary-bank\b/);

  // The daemon's clean-up at start: names out of the server, reported by name only.
  assert.deepEqual(await scrubTmuxServer(['TELEGRAM_BOT_TOKEN', 'CANARY_BANK', 'CANARY_OTHER', 'ANTHROPIC_API_KEY']), ['CANARY_BANK', 'CANARY_OTHER', 'TELEGRAM_BOT_TOKEN']);
  assert.doesNotMatch(tmux('show-environment', '-g'), /^(CANARY_|TELEGRAM_BOT_TOKEN=)/m);
  assert.deepEqual(await scrubTmuxServer(['TELEGRAM_BOT_TOKEN']), [], 'nothing left to take out');
});
