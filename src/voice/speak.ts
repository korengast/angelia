import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FFMPEG_MS, opusArgs } from './opus.js';

/**
 * `angelia speak "<text>"`: turn text into a voice file and print its path. Nothing else.
 *
 * The counterpart to transcribe, and the same reasoning: a spoken reply is something every routed
 * chat may need, so it is one command with one set of defaults rather than a line each group
 * invents. It uses the voice that ships with macOS — no provider, no API key, no cost, works
 * offline — and picks a Hebrew voice by itself when the text is Hebrew, because the system default
 * reads Hebrew letters as gibberish.
 *
 * The agent runs it and then attaches the file with `angelia send-media`; the daemon never does.
 *
 * Prints the path on stdout; exit 2 and one line on stderr when it cannot.
 */

export const USAGE = 'usage: angelia speak "text" [--voice Carmit] [--rate 180] [--out /path/reply.ogg]';

/** macOS ships one Hebrew voice. Without it, Hebrew text is read letter-salad by an English voice. */
export const HEBREW_VOICE = 'Carmit';

export interface SpeakOptions { text: string; voice: string; out: string; rate: string }

export function isHebrew(text: string): boolean {
  return /[֐-׿]/.test(text);
}

/** The voice the caller asked for, else one that can actually pronounce the text, else the system default. */
export function pickVoice(text: string, asked: string, available: string[] | null = null): string {
  if (asked) return asked;
  if (!isHebrew(text)) return '';
  if (available && !available.includes(HEBREW_VOICE)) return '';
  return HEBREW_VOICE;
}

export function parseArgs(argv: string[]): SpeakOptions {
  const out: SpeakOptions = { text: '', voice: '', out: '', rate: '' };
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n];
    if (a === '--voice') out.voice = argv[++n] ?? '';
    else if (a === '--out') out.out = argv[++n] ?? '';
    else if (a === '--rate') out.rate = argv[++n] ?? '';
    else if (!out.text) out.text = a;
  }
  return out;
}

export function sayArgs({ text, voice, rate }: Pick<SpeakOptions, 'text' | 'voice' | 'rate'>, wav: string): string[] {
  return [...(voice ? ['-v', voice] : []), ...(rate ? ['-r', rate] : []),
    '-o', wav, '--data-format=LEI16@22050', text];
}

/** Voices this machine actually has, so a missing Hebrew voice degrades instead of reading salad. */
function installedVoices(): string[] | null {
  const r = spawnSync('say', ['-v', '?'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  // "Carmit              he_IL    # שלום…" — the name runs up to the first run of spaces, and some
  // voices have two-word names, so do not split on single spaces.
  return r.stdout.split('\n').map((l) => /^(.+?)\s{2,}/.exec(l.trimEnd())?.[1].trim()).filter((v): v is string => !!v);
}

/** The command itself. Returns the exit code; prints the file's path or one line of why not. */
export function speak(argv: string[]): number {
  const opts = parseArgs(argv);
  if (!opts.text.trim()) { console.error(USAGE); return 2; }

  const probe = spawnSync('say', ['-v', '?'], { stdio: 'ignore' });
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') { console.error('no `say` on this machine: the built-in voice is macOS only'); return 2; }

  const dir = mkdtempSync(join(tmpdir(), 'angelia-tts-'));
  try {
    const voice = pickVoice(opts.text, opts.voice, installedVoices());
    if (isHebrew(opts.text) && !voice) console.error('note: no Hebrew voice installed; the default voice will read it badly');
    const wav = join(dir, 'reply.wav');
    const said = spawnSync('say', sayArgs({ ...opts, voice }, wav), { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 120_000 });
    if (said.status !== 0 || !existsSync(wav)) { console.error(`say failed: ${(said.stderr || '').trim().split('\n').pop() || `exit ${said.status}`}`); return 2; }

    // ogg/opus is what both chat platforms render as a voice bubble. Without ffmpeg the wav is
    // still usable: `angelia send-media` converts it on the way out (voice/opus.ts).
    const ogg = join(dir, 'reply.ogg');
    const conv = spawnSync('ffmpeg', opusArgs(wav, ogg), { stdio: 'ignore', timeout: FFMPEG_MS });
    const made = conv.status === 0 && existsSync(ogg) ? ogg : wav;

    const dest = opts.out || join(tmpdir(), `angelia-reply-${Date.now()}${made.endsWith('.ogg') ? '.ogg' : '.wav'}`);
    // rename fails across filesystems, and the temp dir often is one.
    try { renameSync(made, dest); } catch { copyFileSync(made, dest); }
    console.log(dest);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
