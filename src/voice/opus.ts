import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { isOpus } from '../core/deliver/media.js';

const run = promisify(execFile);

export interface Converted {
  path: string;
  /** Call when the file has been sent. No-op when nothing was converted. */
  cleanup(): void;
}

/**
 * Both platforms only render a voice bubble for ogg/opus: WhatsApp needs it for `ptt`, Telegram
 * for `sendVoice`. A wav from a text-to-speech script is not that, so convert with ffmpeg when it
 * is on PATH. Without ffmpeg the original comes back and the caller falls back to a plain file —
 * a worse bubble is better than no message.
 */
/** ffmpeg's arguments for a voice bubble: mono 48 kHz Opus in Ogg, what both platforms show as one. */
export function opusArgs(src: string, out: string): string[] {
  return ['-y', '-i', src, '-ar', '48000', '-ac', '1', '-c:a', 'libopus', out];
}

export const FFMPEG_MS = 60_000;

export async function asVoice(path: string): Promise<Converted> {
  if (isOpus(path)) return { path, cleanup: () => {} };
  const dir = mkdtempSync(join(tmpdir(), 'angelia-voice-'));
  const out = join(dir, `${randomBytes(6).toString('hex')}.ogg`);
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone already */ } };
  try {
    await run('ffmpeg', opusArgs(path, out), { timeout: FFMPEG_MS });
    return { path: out, cleanup };
  } catch {
    cleanup();
    return { path, cleanup: () => {} };
  }
}
