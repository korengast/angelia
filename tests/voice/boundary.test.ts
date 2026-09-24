import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Voice is one module, src/voice/, and the line around it is a rule of the product: Angelia routes
 * files and runs no model, not even for speech. The agent runs `angelia transcribe` and
 * `angelia speak`; the daemon only converts audio into a voice bubble on the way out (opus.ts).
 * These tests hold that line, so a later convenience cannot quietly cross it.
 */
const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });
}

/** Relative imports of a file (static and dynamic), resolved to .ts paths under src. */
function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from\s+|import\()\s*'(\.{1,2}\/[^']+)\.js'/g)].map((m) => resolve(dirname(file), m[1] + '.ts'));
}

const MODEL_WORK = [join(src, 'voice', 'transcribe.ts'), join(src, 'voice', 'speak.ts')];

test('the daemon never reaches transcribe or speak: nothing it loads imports them', () => {
  const seen = new Set<string>();
  const walk = (f: string) => { if (seen.has(f)) return; seen.add(f); for (const i of imports(f)) walk(i); };
  walk(join(src, 'daemon', 'daemon.ts'));
  for (const m of MODEL_WORK) assert.equal(seen.has(m), false, `the daemon's import graph reaches ${relative(src, m)}`);
  assert.ok(seen.has(join(src, 'voice', 'opus.ts')), 'the daemon still converts voice replies (voice/opus.ts)');
});

test('only the CLI runs transcribe and speak', () => {
  for (const f of files(src)) {
    if (f.startsWith(join(src, 'voice'))) continue;
    for (const m of MODEL_WORK) if (imports(f).includes(m)) assert.equal(relative(src, f), join('cli', 'cli.ts'), `${relative(src, f)} imports ${relative(src, m)}`);
  }
});

test('the voice module reaches out of its folder only for the media kinds and the wizard\'s Ask type', () => {
  const allowed = new Set([join(src, 'core', 'deliver', 'media.ts'), join(src, 'instance', 'init.ts')]);
  for (const f of files(join(src, 'voice'))) {
    for (const i of imports(f)) if (!i.startsWith(join(src, 'voice'))) assert.ok(allowed.has(i), `${relative(src, f)} imports ${relative(src, i)}`);
  }
});
