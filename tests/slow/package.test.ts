import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package as a stranger gets it: `npm pack`, then a global install into an empty prefix, with
 * an empty npm cache and no way to reach git over SSH. Nothing in the checkout's node_modules can
 * help, because a tarball carries no lockfile and no node_modules of its own - except what it
 * bundles on purpose.
 *
 * This exists because the first version of this check ran inside the checkout, with install
 * scripts switched off, and so passed while the real install failed: npm cloned the Baileys fork
 * and ran its `prepare` build, which cannot compile outside that repo's own dev setup. See
 * docs/decisions/0009-bundle-baileys.md.
 *
 * Slow (a pack, a build, a registry install) and it needs the npm registry, so it has its own
 * timeout. It runs nothing that touches a real instance: the state directory is a temp dir, and
 * the one command that could restart a daemon is invoked in the mode where it refuses.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd = repo): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 240_000 });
}

test('the packed package installs from nothing and runs what the chats call', { timeout: 300_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'angelia-pack-'));
  try {
    const prefix = join(tmp, 'prefix');
    const state = join(tmp, 'state');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_SSH_COMMAND: '/usr/bin/false', // an SSH key must never be what makes this work
      GIT_TERMINAL_PROMPT: '0',
      npm_config_cache: join(tmp, 'cache'), // nothing cached from an earlier install can help
      ANGELIA_STATE_DIR: state,
    };
    for (const k of Object.keys(env)) if (k.startsWith('ANGELIA_') && k !== 'ANGELIA_STATE_DIR') delete env[k];

    const pack = run('npm', ['pack', '--pack-destination', tmp, '--silent'], env);
    assert.equal(pack.status, 0, `npm pack failed:\n${pack.stderr}`);
    const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'))!;
    assert.ok(tgz, 'a tarball');

    // As install.sh and update do it: no dependency runs an install script.
    const install = run('npm', ['install', '--global', '--ignore-scripts', '--prefix', prefix, join(tmp, tgz), '--no-audit', '--no-fund'], env, tmp);
    assert.equal(install.status, 0, `global install failed:\n${install.stderr.split('\n').filter((l) => /error/.test(l)).slice(0, 12).join('\n')}`);

    const pkg = join(prefix, 'lib', 'node_modules', 'angelia-gateway');
    const bin = join(prefix, 'bin', 'angelia');
    assert.ok(existsSync(bin), 'the angelia command is on the prefix');
    // Baileys came out of the bundle, already built, not from a clone.
    assert.ok(existsSync(join(pkg, 'node_modules', 'baileys', 'lib', 'index.js')), 'bundled, built baileys');
    // Every dependency rides in the tarball at the version the repo locked, not the newest one its
    // range allows on the day of the install.
    const locked = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')).packages as Record<string, { version: string }>;
    for (const dep of ['grammy', 'yaml', 'zod', 'pino']) {
      const got = JSON.parse(readFileSync(join(pkg, 'node_modules', dep, 'package.json'), 'utf8')).version;
      assert.equal(got, locked[`node_modules/${dep}`].version, `${dep} as locked`);
    }

    // The build stamp rides along, so `angelia update` can say what changed; tools/ does not.
    const stamp = JSON.parse(readFileSync(join(pkg, 'dist', 'build.json'), 'utf8'));
    assert.match(stamp.commit, /^[0-9a-f]{40}$/);
    assert.ok(!existsSync(join(pkg, 'tools')), 'the stamp script stays out of the package');
    // An installed copy is not a checkout, so update does not refuse it on that ground.
    const upd = run(bin, ['update', '--from', join(tmp, 'no-such-source')], env);
    assert.notEqual(upd.status, 0);
    assert.doesNotMatch(upd.stdout + upd.stderr, /runs from a checkout/);

    const help = run(bin, ['--help'], env);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^usage: angelia/);

    // A sample table whose directories exist, the way a real instance's do.
    const cwd = join(tmp, 'profiles', 'main');
    mkdirSync(cwd, { recursive: true });
    const table = join(tmp, 'routing.yaml');
    writeFileSync(table, `profiles:\n  main: { cwd: ${JSON.stringify(cwd)}, permission_mode: acceptEdits }\nroutes:\n  - { platform: telegram, chat: 1, profile: main }\ntelegram: {}\n`);
    const check = run(bin, ['check-config', table], env);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /ok: 1 profiles, 1 routes/);
    assert.ok(check.stdout.includes(`table    ${table}`) || check.stdout.includes('routing.yaml'), 'names the table it checked');
    assert.doesNotMatch(check.stdout, /not created yet/);

    // The starter skills ship, so init can copy them into a new workspace.
    for (const name of ['checkout', 'mfa']) assert.ok(existsSync(join(pkg, 'capabilities', 'skills', name, 'SKILL.md')), name);
    // What the groups' instruction files call, present in the installed copy and reachable.
    for (const cmd of ['transcribe', 'speak']) {
      const r = run(bin, [cmd], env);
      assert.equal(r.status, 2, `angelia ${cmd} with no arguments should print its usage`);
      assert.match(r.stderr, new RegExp(`usage: angelia ${cmd}`));
    }
    for (const cmd of ['send', 'send-media']) {
      const r = run(bin, [cmd, 'whatsapp:1@g.us', cmd === 'send' ? 'hi' : '/etc/hosts'], env);
      assert.match(r.stdout + r.stderr, /no api token: is the daemon running\?/, `${cmd} reaches its own code`);
    }
    // restart exists, and refuses when run as a chat's agent - which is how this proves it without
    // any chance of restarting anything.
    const restart = run(bin, ['restart'], { ...env, ANGELIA_SESSION_KEY: 'test:0' });
    assert.notEqual(restart.status, 0);
    assert.match(restart.stdout + restart.stderr, /running as the agent of test:0/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
