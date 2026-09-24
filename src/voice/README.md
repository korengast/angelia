# voice

Everything Angelia does with voice, in one folder. The rule that shapes it: Angelia routes files
and runs no model, not even for speech.

| File | What | Who runs it |
|---|---|---|
| `transcribe.ts` | `angelia transcribe <audio>`: local whisper (`large-v3-turbo`), prints the text | the agent |
| `speak.ts` | `angelia speak "<text>"`: the machine's own voice (`say`), picks Hebrew by itself, prints an audio path | the agent |
| `opus.ts` | converts audio to ogg/opus so both platforms show a voice bubble | the daemon, on the way out |
| `setup.ts` | the wizard's voice questions and the lines a starter instruction file gets | `angelia init`, onboarding |

A voice note arrives in the chat as `[voice note: path]`; the agent transcribes it itself. To answer
by voice, the agent runs `angelia speak` and attaches the file with `angelia send-media`.

The built-in pair is a default, not a rule: setup asks, and a hosted API, another tool or nothing is
a valid answer. Instruction files name the command (`angelia transcribe`), never an install path.

`tests/voice/boundary.test.ts` holds the line: the daemon's import graph never reaches
`transcribe.ts` or `speak.ts`, only the CLI runs them, and this folder reaches outside itself only
for the media kinds and the wizard's `Ask` type.
