import type { Ask } from '../instance/init.js';

/** What the built-in transcriber needs installed. Here, not in transcribe.ts: setup is loaded by the
 *  daemon (onboarding), and the daemon must never load the transcriber. */
export const WHISPER_INSTALL = 'brew install openai-whisper ffmpeg';

/** The two commands a profile's instruction file will name, or '' for "this install does not do that". */
export interface VoiceTools { transcribe: string; speak: string }

/** The questions setup can ask here: a slice of the wizard's own Ask. */
export type VoiceAsk = Pick<Ask, 'say' | 'choose' | 'text'>;

/**
 * The built-in pair, by command rather than by install path: an instruction file that names a path
 * breaks the day the package moves, and `angelia` is on PATH wherever it is installed.
 */
export function builtinVoiceTools(): VoiceTools {
  return { transcribe: 'angelia transcribe', speak: 'angelia speak' };
}

/**
 * Hearing and speaking are model work, so Angelia never does either — it only tells the agent which
 * command to run. Which command is the operator's choice, not ours: the built-in pair is a default
 * that works out of the box, and anyone who prefers a hosted API, a different voice or nothing at
 * all says so here. Asking is the whole point; a default nobody chose is how one person's
 * preference ends up hard-coded for everybody.
 */
export async function voiceQuestions(ask: VoiceAsk, hasBin: (bin: string) => boolean): Promise<VoiceTools> {
  const has = hasBin;
  const builtin = builtinVoiceTools();
  const ready = has('whisper') && has('ffmpeg');

  ask.say('A voice note reaches the agent as an audio file it cannot hear, so something has to turn it into text.');
  if (!ready) ask.say(`Note: ${[!has('whisper') && 'whisper', !has('ffmpeg') && 'ffmpeg'].filter(Boolean).join(' and ')} not installed. The built-in choice needs: ${WHISPER_INSTALL}`);
  const inKind = await ask.choose('How should voice notes be transcribed?', [
    { key: 'builtin', label: 'the transcriber that ships with Angelia — local whisper, free, offline, accurate in any language' },
    { key: 'own', label: 'a command of my own (a hosted API, another tool)' },
    { key: 'none', label: 'no transcription — the agent just gets the file' },
  ], ready ? 'builtin' : 'own');
  const transcribe = inKind === 'builtin' ? builtin.transcribe
    : inKind === 'own' ? (await ask.text('Command that takes an audio file path and prints the text')).trim()
    : '';

  ask.say('The other direction: when the agent should answer with a voice note, something has to make the audio.');
  const sayable = has('say');
  if (!sayable) ask.say('Note: the built-in system voice (`say`) is macOS only and was not found here.');
  const outKind = await ask.choose('How should a spoken reply be made?', [
    { key: 'builtin', label: 'the voice built into this machine — free, offline, no provider, plain-sounding' },
    { key: 'own', label: 'a command of my own (a hosted voice, a better model)' },
    { key: 'none', label: 'no spoken replies' },
  ], sayable ? 'builtin' : 'none');
  const speak = outKind === 'builtin' ? builtin.speak
    : outKind === 'own' ? (await ask.text('Command that takes text and prints the path of an audio file')).trim()
    : '';

  return { transcribe, speak };
}

/** What a starter instruction file says about voice. Only what this install actually has is described. */
export function voiceLines(voice: VoiceTools): string[] {
  const out = [voice.transcribe
    ? `A voice note arrives as \`[voice note: path]\`: transcribe it yourself before answering by running \`${voice.transcribe} <path>\`, which prints the text. Answer the transcribed request; do not describe the transcription step.`
    : 'A voice note arrives as `[voice note: path]`. This install has no transcriber, so say plainly that you cannot hear it and ask for the request in text.'];
  if (voice.speak) out.push(`To answer with a voice note instead of text, run \`${voice.speak} "<what to say>"\`: it prints the path of an audio file. Then attach that file with \`angelia send-media\`.`);
  return out;
}
