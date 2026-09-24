import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkArgs, COMMANDS, usageLines } from '../src/cli/cli-args.js';

test('--help on a subcommand is help, never the command (workspace sync --help saved and pushed)', () => {
  const r = checkArgs('workspace', ['sync', '--help']);
  assert.ok('help' in r);
  assert.match(r.text, /^usage: angelia workspace sync \[--quiet\]$/m);
  for (const cmd of Object.keys(COMMANDS)) assert.ok('help' in checkArgs(cmd, ['-h']), cmd);
});

test('a flag the command does not know is refused, with the usage', () => {
  const r = checkArgs('workspace', ['sync', '--dry-run']);
  assert.ok('error' in r);
  assert.match(r.error, /unknown flag --dry-run for angelia workspace/);
  assert.ok('error' in checkArgs('update', ['--yes']));
  assert.ok('error' in checkArgs('status', ['--json']));
});

test('the flags each command reads pass, and a value is not read as a flag', () => {
  assert.deepEqual(checkArgs('workspace', ['sync', '--quiet']), { ok: true });
  assert.deepEqual(checkArgs('jobs', ['run', 'p', 'j', '--hash', 'abc', '--config', '/t.yaml']), { ok: true });
  assert.deepEqual(checkArgs('restart', ['--from-daemon', '/t.yaml']), { ok: true });
  assert.deepEqual(checkArgs('send-media', ['whatsapp:1', '/a.pdf', '--name', '--odd name.pdf']), { ok: true });
  assert.deepEqual(checkArgs('send-media', ['whatsapp:1', '/a.jpg', '--caption', '--help me', '--no-voice']), { ok: true });
  assert.deepEqual(checkArgs('transcribe', ['/a.ogg', '--language', 'he']), { ok: true });
});

test('send and turn carry free text: only a leading --help is help', () => {
  assert.ok('help' in checkArgs('send', ['--help']));
  assert.deepEqual(checkArgs('send', ['whatsapp:1', '--quiet', 'is', 'broken']), { ok: true });
  assert.deepEqual(checkArgs('turn', ['whatsapp:1', '-']), { ok: true });
});

test('every flag a command reads in its own parser is in the table', () => {
  // The parsers read flags by literal: a flag missing here would be refused before it could work.
  const read: Record<string, string> = {
    workspace: 'src/cli/cli.ts', restart: 'src/daemon/restart.ts', service: 'src/daemon/service.ts', compile: 'src/capabilities/cli.ts',
    jobs: 'src/jobs/jobs-cli.ts', update: 'src/daemon/update.ts', 'send-media': 'src/daemon/api/client.ts',
    transcribe: 'src/voice/transcribe.ts', speak: 'src/voice/speak.ts',
  };
  for (const [cmd, file] of Object.entries(read)) {
    const src = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
    const used = [...src.matchAll(/(?:===|includes\(|indexOf\()\s*'(--[a-z-]+)'/g)].map((m) => m[1]);
    for (const f of used) if (cmd !== 'workspace' || f === '--quiet') assert.ok(f in (COMMANDS[cmd].flags ?? {}), `${cmd} reads ${f}`);
  }
});

test('the top-level help lists each line once', () => {
  const lines = usageLines();
  assert.equal(new Set(lines).size, lines.length);
  assert.ok(lines.some((l) => l.trim().startsWith('workspace sync')));
});

test('the real CLI: workspace sync --help prints usage and exits 0 without syncing', () => {
  const state = mkdtempSync(join(tmpdir(), 'angelia-cli-'));
  const env = { ...process.env, ANGELIA_STATE_DIR: state };
  const cli = join(import.meta.dirname, '..', 'src', 'cli', 'cli.ts');
  const help = spawnSync(process.execPath, ['--import', 'tsx', cli, 'workspace', 'sync', '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: angelia workspace sync/);
  assert.doesNotMatch(help.stdout, /saved|pushed|nothing to save/);
  const bad = spawnSync(process.execPath, ['--import', 'tsx', cli, 'workspace', 'sync', '--bogus'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown flag --bogus/);
});
