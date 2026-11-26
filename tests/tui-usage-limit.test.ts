import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { isLimitText } from '../src/core/deliver/text.js';

const here = dirname(fileURLToPath(import.meta.url));
const frame = (name: string) => readFileSync(join(here, 'fixtures', `pane-${name}.txt`), 'utf8');
const row = (text: string, extra: object = {}) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });

/** A turn on a stubbed pane: after Enter, `rows` go into the transcript and the Stop hook's marker
 *  says `said` (or no marker: the quiet path ends the turn). */
async function turnWith(rows: string[], said: string | null) {
  process.env.ANGELIA_STATE_DIR ??= mkdtempSync(join(tmpdir(), 'angelia-tuilimit-'));
  const { TuiBrain } = await import('../src/brain/tui.js');
  const cwd = mkdtempSync(join(tmpdir(), 'angelia-tuilimit-cwd-'));
  const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
  // The short wait of the quiet path, shortened (12 s in the daemon); the waits for a last row of text
  // (90 s) and for an open turn (3 minutes) stay as they are, so only the short one can end the turn here.
  const brain = new TuiBrain(profile, { id: crypto.randomUUID(), started: true }, { bin: '/bin/false', quietMs: 1000 });
  const b = brain as any;
  b.ready = Promise.resolve(null);
  b.up = true;
  mkdirSync(b.dir, { recursive: true });
  // Its own transcript in the temp folder, never under the real ~/.claude.
  b.transcript = join(cwd, 'transcript.jsonl');
  writeFileSync(b.transcript, '');
  let entered = false;
  const landed = frame('idle').replace(/❯\s+Try "refactor <filepath>"/, '❯ [Pasted text #1 +2 lines]');
  b.capture = async () => (entered ? frame('idle') : landed);
  b.sessionAlive = async () => true;
  b.tm = async (a: string[]) => {
    if (a[0] === 'send-keys' && a.includes('Enter') && !entered) {
      entered = true;
      appendFileSync(b.transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
      setTimeout(() => {
        appendFileSync(b.transcript, rows.map((r) => `${r}\n`).join(''));
        if (said !== null) writeFileSync(join(b.dir, 'turn.json'), JSON.stringify({ text: said, at: Date.now() }));
      }, 800);
    }
    return { code: 0, out: '' };
  };
  const events = [];
  for await (const e of brain.turn('what is new?')) events.push(e);
  return events;
}

/** As Claude Code writes a usage limit (same shape as a failed API call: an assistant row of its own, marked). */
const LIMIT_TEXT = "You've reached your Fable limit. Switch to another model.";
const LIMIT = row(LIMIT_TEXT, { isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: LIMIT_TEXT }] } });

test('tmux mode: a usage-limit row ends the turn as print mode does (the limit as a plain result), with and without the Stop marker', { timeout: 60_000 }, async () => {
  // Print mode (claude.ts) yields the limit as `{ kind: 'result', text, isError: false }`; the orchestrator
  // then posts the text with the /model hint (isLimitText), and never takes it for a failure.
  const withMarker = await turnWith([LIMIT], LIMIT_TEXT);
  assert.deepEqual(withMarker.at(-1), { kind: 'result', text: LIMIT_TEXT, isError: false });
  assert.ok(!withMarker.some((e) => e.kind === 'progress'), 'the limit is the answer, not a progress line before it');
  const quiet = await turnWith([row('Looking.'), LIMIT], null);
  assert.deepEqual(quiet.at(-1), { kind: 'result', text: LIMIT_TEXT, isError: false });
  assert.deepEqual(quiet.filter((e) => e.kind === 'progress'), [{ kind: 'progress', text: 'Looking.' }]);
  assert.ok(isLimitText((quiet.at(-1) as { text: string }).text), 'the orchestrator takes it as a limit');
});

/** A failed API call as Claude Code writes it: an assistant row of its own, marked. */
const LOST_TEXT = 'Not logged in · Please run /login';
const LOST = row(LOST_TEXT, { isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: LOST_TEXT }] } });
const LOST_RESULT = { kind: 'result', text: LOST_TEXT, isError: true, reason: `api-error: ${LOST_TEXT}` };

test('transcript rows: a marked API error is its own event, never text; the same words in an answer are text', async () => {
  process.env.ANGELIA_STATE_DIR ??= mkdtempSync(join(tmpdir(), 'angelia-tuilimit-'));
  const { transcriptEvents } = await import('../src/brain/tui.js');
  assert.deepEqual(transcriptEvents([row('Checking.'), LOST].join('\n')), [{ kind: 'text', text: 'Checking.' }, { kind: 'api-error', text: LOST_TEXT }]);
  const sample = `If the CLI prints this:\n\`\`\`\n${LOST_TEXT}\n\`\`\`\nrun claude and type /login.`;
  assert.deepEqual(transcriptEvents(row(sample)), [{ kind: 'text', text: sample }]);
});

test('tmux mode: an API error row ends the turn as an error result, with and without the Stop marker', { timeout: 60_000 }, async () => {
  const withMarker = await turnWith([LOST], LOST_TEXT);
  assert.deepEqual(withMarker.at(-1), LOST_RESULT);
  assert.ok(!withMarker.some((e) => e.kind === 'progress'), 'nor a progress line');
  const quiet = await turnWith([row('Looking.'), LOST], null);
  assert.deepEqual(quiet.at(-1), LOST_RESULT);
  assert.deepEqual(quiet.filter((e) => e.kind === 'progress'), [{ kind: 'progress', text: 'Looking.' }], 'what the agent said before it is still shown');
});

test('tmux mode: an answer quoting "please run /login" in a code sample is delivered as the answer', { timeout: 30_000 }, async () => {
  const sample = `When it says this:\n\`\`\`\n${LOST_TEXT}\n\`\`\`\nrun claude, then /login.`;
  assert.deepEqual((await turnWith([row(sample)], sample)).at(-1), { kind: 'result', text: sample, isError: false });
});
