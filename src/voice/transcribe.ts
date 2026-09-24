import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { WHISPER_INSTALL } from './setup.js';

/**
 * `angelia transcribe <audio>`: transcribe one voice note and print the text. Nothing else.
 *
 * Every routed chat that can receive a voice note needs this, and each group's instruction file
 * used to carry its own whisper line — which is how `--model base` ended up everywhere. Measured on
 * a two-second Hebrew note: `base` returned a sentence of the right length with the wrong words,
 * while `large-v3-turbo` returned it exactly and detected the language on its own. So the model is
 * the setting that matters, it belongs in one place, and this is that place.
 *
 * The agent runs it, the same way it would run whisper by hand; the daemon never does. Angelia
 * routes files and runs no model, not even for speech (tests/voice/boundary.test.ts holds that line).
 *
 * Exit 0 and the transcript on stdout; exit 2 and one line on stderr when it cannot.
 */

export const USAGE = 'usage: angelia transcribe <audio file> [--language he] [--model large-v3-turbo]';

/** The default is the smallest model that is reliably right, not the fastest. About a minute per note on CPU. */
export const DEFAULT_MODEL = process.env.ANGELIA_WHISPER_MODEL || 'large-v3-turbo';

export interface TranscribeOptions { file: string; model: string; language: string }

export function parseArgs(argv: string[]): TranscribeOptions {
  const out: TranscribeOptions = { file: '', model: DEFAULT_MODEL, language: '' };
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n];
    if (a === '--model') out.model = argv[++n] ?? '';
    else if (a === '--language' || a === '--lang') out.language = argv[++n] ?? '';
    else if (!out.file) out.file = a;
  }
  return out;
}

/** Language is left to whisper unless the caller knows it: large-v3-turbo detects Hebrew correctly by itself. */
export function whisperArgs({ file, model, language }: TranscribeOptions, outDir: string): string[] {
  return [file, '--model', model, '--output_format', 'txt', '--output_dir', outDir,
    ...(language ? ['--language', language] : [])];
}

/** The command itself. Returns the exit code; prints the text or one line of why not. */
export function transcribe(argv: string[]): number {
  const opts = parseArgs(argv);
  if (!opts.file) { console.error(USAGE); return 2; }
  if (!existsSync(opts.file)) { console.error(`no such file: ${opts.file}`); return 2; }
  const dir = mkdtempSync(join(tmpdir(), 'angelia-stt-'));
  try {
    const r = spawnSync('whisper', whisperArgs(opts, dir), { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') { console.error(`whisper is not installed: ${WHISPER_INSTALL}`); return 2; }
    if (r.status !== 0) { console.error(`whisper failed: ${(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`}`); return 2; }
    // whisper names the output after the input file, so take whatever .txt it left.
    const want = basename(opts.file, extname(opts.file)) + '.txt';
    const found = readdirSync(dir).includes(want) ? want : readdirSync(dir).find((f) => f.endsWith('.txt'));
    if (!found) { console.error('whisper produced no transcript'); return 2; }
    const text = readFileSync(join(dir, found), 'utf8').trim();
    if (!text) { console.error('the recording transcribed to nothing'); return 2; }
    console.log(text);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
