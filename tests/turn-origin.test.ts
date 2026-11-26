import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error: a plain script, no types
import { promptForm, promptKey, rowShapes, turnOrigin, turnStarters } from '../scripts/turn-origin.mjs';
import { promptKey as daemonKey } from '../src/brain/tui.js';

const HOOK = fileURLToPath(new URL('../scripts/tui-stop-hook.mjs', import.meta.url));
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

// Rows as the readers in src/brain take them. `origin.kind` on a user row was measured on Claude Code
// 2.1.329 (tests/live-tui-origin.mts): `human` for a typed message, `task-notification` for the end of
// a background task, whose text opens with the tag. Content made up.
const NOTE = '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Background command "Build" completed (exit code 0)</summary>\n</task-notification>';
const R = {
  typed: (text: string, s = 0) => ({ type: 'user', timestamp: iso(s), origin: { kind: 'human' }, message: { role: 'user', content: text } }),
  /** A user row of a CLI that writes no `origin`. */
  bare: (text: string, s = 0) => ({ type: 'user', timestamp: iso(s), message: { role: 'user', content: text } }),
  note: (s = 0) => ({ type: 'user', timestamp: iso(s), origin: { kind: 'task-notification' }, message: { role: 'user', content: NOTE } }),
  queued: () => ({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(0), content: NOTE }),
  text: (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  thinking: () => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] } }),
  call: (id: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } }),
  result: (id: string) => ({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok' }] }, toolUseResult: { stdout: 'ok' } }),
  rejected: (id: string) => ({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'x', is_error: true }] }, toolUseResult: 'User rejected tool use' }),
  interrupted: () => ({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
  toolInterrupted: () => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
  command: (name: string, s = 0) => ({ type: 'user', timestamp: iso(s), origin: { kind: 'human' }, message: { role: 'user', content: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args></command-args>` } }),
  stdout: (text: string) => ({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } }),
  meta: (text: string) => ({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } }),
  feedback: () => ({ type: 'user', message: { role: 'user', content: 'Stop hook feedback:\n[node hook.mjs]: Angelia language check: write the answer again.' } }),
  /** Written after a turn's last row, once its Stop hooks ran (measured live). */
  over: () => ({ type: 'system', subtype: 'turn_duration', durationMs: 5 }),
  /** A prompt the session scheduled for itself fires: this row, then the prompt as a meta row (measured live). */
  fired: (s = 0) => ({ type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(s) }),
  apiError: (text: string) => ({ type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text }] } }),
};
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const origin = (...rows: object[]) => turnOrigin(jsonl(rows));
/** What the hook says of a turn whose one typed prompt is `text`. */
const typedOne = (text: string) => ({ prompt_key: promptKey(text), prompt_len: promptForm(text).length, prompts: 1 });

test('a typed message starts a prompt turn, and says when it was typed', () => {
  assert.deepEqual(origin(R.typed('hello', 5), R.text('Hi.')), { origin: 'prompt', origin_why: 'a typed prompt (origin human)', prompt_at: T0 + 5000, ...typedOne('hello') });
  // A CLI that writes no origin on its rows: read by the text alone.
  assert.deepEqual(origin(R.bare('hello', 5), R.text('Hi.')), { origin: 'prompt', origin_why: 'a typed prompt', prompt_at: T0 + 5000, ...typedOne('hello') });
  // Only the last turn counts: the one before it ended with the assistant's text.
  assert.equal(origin(R.typed('one', 1), R.text('One.'), R.typed('two', 9), R.call('t1'), R.result('t1'), R.text('Two.')).prompt_at, T0 + 9000);
  // No timestamp on the row: no prompt_at, and the daemon then delivers nothing late.
  assert.deepEqual(origin({ type: 'user', message: { content: 'hello' } }, R.text('Hi.')), { origin: 'prompt', origin_why: 'a typed prompt', ...typedOne('hello') });
});

test('the end of a background task starts a notification turn: by the row\'s origin and its tag', () => {
  const before = [R.typed('start the build', 1), R.call('t1'), R.result('t1'), R.text('Started.')];
  assert.deepEqual(origin(...before, R.queued(), R.note(60), R.text('The build passed.')), { origin: 'notification', origin_why: '<task-notification> (origin task-notification)', origin_ids: ['toolu_1'] });
  // The tag alone, on a CLI that writes no origin.
  assert.deepEqual(origin(R.bare('start the build', 1), R.call('t1'), R.result('t1'), R.text('Started.'), R.bare(NOTE, 60), R.text('The build passed.')), { origin: 'notification', origin_why: '<task-notification>', origin_ids: ['toolu_1'] });
  // On a CLI that stamps its rows, a row that opens with the tag and says nothing of where it came from is no task's end.
  assert.deepEqual(origin(...before, R.bare(NOTE, 60), R.text('The build passed.')), { origin: 'unknown', origin_why: '<task-notification>' });
  // A task's end that names no tool-use id ties the turn to nothing.
  assert.equal('origin_ids' in origin(...before, { ...R.note(60), message: { role: 'user', content: '<task-notification>\n<status>completed</status>\n</task-notification>' } }), false);
  // Two tasks' ends in one turn: both ids.
  assert.deepEqual(origin(...before, R.note(60), R.call('t2'), R.result('t2'), { ...R.note(70), message: { role: 'user', content: NOTE.replace('toolu_1', 'toolu_2') } }, R.text('Both.')).origin_ids, ['toolu_1', 'toolu_2']);
  // The queue's own bookkeeping row is not what starts the turn: with no user row there is nothing to go by.
  assert.equal(origin(R.queued()).origin, 'unknown');
  // A second task that ends while the first one's end is answered: still nobody typed anything.
  assert.equal(origin(...before, R.note(60), R.call('t2'), R.result('t2'), R.note(70), R.text('Both passed.')).origin, 'notification');
  // An agent's message: how Claude Code marks its row is not measured, so unknown.
  assert.equal(origin(...before, R.bare('<agent-message from="worker">done</agent-message>', 60), R.text('Done.')).origin, 'unknown');
});

// A named teammate's message to the lead, as claude 2.1.332 writes it (measured live,
// tests/live-tui-teammate.mts): a user row with no origin, the line, then the tag.
const MATE = (name: string, body: string) => `Another Claude session sent a message:\n<teammate-message teammate_id="${name}" color="blue" summary="Report">\n${body}\n</teammate-message>\n\nThis came from another Claude session — not typed by your user.`;
const IDLE_NOTE = (name: string) => `{"type":"idle_notification","from":"${name}","timestamp":"2026-11-25T15:03:00.343Z","idleReason":"available"}`;
const mate = (text: string, s = 60) => ({ type: 'user', timestamp: iso(s), rowSource: 'recorded', message: { role: 'user', content: text } });

test('a teammate\'s message starts a notification turn that names the teammate; its idle note says so', () => {
  const before = [R.typed('send a scout', 1), R.call('t1'), R.result('t1'), R.text('spawned')];
  assert.deepEqual(origin(...before, mate(MATE('scout', 'SCOUT-DONE')), R.text('The scout is done.')),
    { origin: 'notification', origin_why: '<teammate-message>', origin_teammates: ['scout'] });
  assert.deepEqual(origin(...before, mate(MATE('scout', IDLE_NOTE('scout'))), R.text('[SILENT]')),
    { origin: 'notification', origin_why: '<teammate-message> (idle)', origin_teammates: ['scout'], origin_idle: true });
  // Two teammates in one turn, one only idle: both named, and the turn is not idle only.
  assert.deepEqual(origin(...before, mate(MATE('scout', 'done') + '\n' + MATE('reviewer@session-1', IDLE_NOTE('reviewer'))), R.text('Both.')),
    { origin: 'notification', origin_why: '<teammate-message>', origin_teammates: ['scout', 'reviewer@session-1'] });
  // A teammate's message and a task's end in one turn: both tie it.
  assert.deepEqual(origin(...before, mate(MATE('scout', 'done')), R.call('t2'), R.result('t2'), R.note(70), R.text('Both.')),
    { origin: 'notification', origin_why: '<teammate-message>, <task-notification> (origin task-notification)', origin_ids: ['toolu_1'], origin_teammates: ['scout'] });
  // The tag with no line before it, or the row with no `rowSource: recorded`: no teammate's message as
  // 2.1.332 writes one, so not known.
  assert.deepEqual(origin(...before, mate('<teammate-message teammate_id="scout">\ndone\n</teammate-message>'), R.text('Done.')), { origin: 'unknown', origin_why: '<teammate-message>' });
  const { rowSource: _r, ...unsourced } = mate(MATE('scout', 'done'));
  assert.deepEqual(origin(...before, unsourced, R.text('Done.')), { origin: 'unknown', origin_why: '<teammate-message>' });
  assert.equal(origin(...before, { ...mate(MATE('scout', 'done')), rowSource: 'typed' }, R.text('Done.')).origin, 'unknown');
  // A name that is no plain word ties the turn to nothing; so does a prompt the session scheduled beside it.
  assert.deepEqual(origin(...before, mate(MATE('a b', 'x')), R.text('X.')), { origin: 'notification', origin_why: '<teammate-message>' });
  // One message of several with no plain name, or with no id at all, or a tag that does not close: no names at all.
  assert.deepEqual(origin(...before, mate(MATE('scout', 'x') + '\n' + MATE('a b', 'y')), R.text('X.')), { origin: 'notification', origin_why: '<teammate-message>' });
  assert.deepEqual(origin(...before, mate(MATE('scout', 'x') + '\n<teammate-message color="red">\ny\n</teammate-message>'), R.text('X.')), { origin: 'notification', origin_why: '<teammate-message>' });
  assert.deepEqual(origin(...before, mate(MATE('scout', 'x') + '\n<teammate-message teammate_id="reviewer">\nnever closed'), R.text('X.')), { origin: 'notification', origin_why: '<teammate-message>' });
  assert.equal('origin_teammates' in origin(...before, mate(MATE('scout', 'x')), R.fired(70), R.meta('Check the mail.'), R.text('X.')), false);
  // Typed by a person (the row says so): a prompt, whatever it looks like.
  assert.equal(origin(...before, R.typed(MATE('scout', 'done'), 60), R.text('That is no teammate.')).origin, 'prompt');
  // A person typed into the teammate's turn: theirs.
  assert.equal(origin(...before, mate(MATE('scout', 'done')), R.typed('and the docs?', 65), R.text('Docs too.')).origin, 'prompt');
  // A CLI that says of no row where it came from: a person may have typed it, so not known.
  assert.deepEqual(origin(R.bare('send a scout', 1), R.text('spawned'), R.bare(MATE('scout', 'done'), 60), R.text('Done.')), { origin: 'unknown', origin_why: '<teammate-message>' });
  // Queued while a turn ran: an attachment row with no origin.
  assert.deepEqual(origin(...before, { type: 'attachment', timestamp: iso(60), rowSource: 'recorded', attachment: { type: 'queued_command', prompt: MATE('scout', 'done') } }, R.text('Done.')),
    { origin: 'notification', origin_why: '<teammate-message>', origin_teammates: ['scout'] });
  // Without `rowSource: recorded` such a queued row is no teammate's: read as a person's prompt.
  assert.equal(origin(...before, { type: 'attachment', timestamp: iso(60), attachment: { type: 'queued_command', prompt: MATE('scout', 'done') } }, R.text('Done.')).origin, 'prompt');
});

test('a person who typed anything into the turn makes it a prompt turn', () => {
  const before = [R.typed('start the build', 1), R.call('t1'), R.result('t1'), R.text('Started.')];
  // The task ended while a typed turn ran, and its end was told to the model in that same turn.
  assert.deepEqual(origin(R.typed('what is in this folder?', 30), R.call('t1'), R.result('t1'), R.note(40), R.text('Three files. And the build passed.')),
    { origin: 'prompt', origin_why: 'a typed prompt (origin human), <task-notification> (origin task-notification)', prompt_at: T0 + 30_000, ...typedOne('what is in this folder?') });
  // The owner typed in the app while the agent was answering a task's end.
  assert.deepEqual(origin(...before, R.note(60), R.call('t2'), R.result('t2'), R.typed('also check the logs', 65), R.text('Passed, and the logs are clean.')),
    { origin: 'prompt', origin_why: '<task-notification> (origin task-notification), a typed prompt (origin human)', prompt_at: T0 + 65_000, ...typedOne('also check the logs') });
  // The tag, typed by a person: the row says who wrote it.
  assert.equal(origin(...before, R.typed(NOTE, 60), R.text('That is not a real notification.')).origin, 'prompt');
  // A typed turn that ended with no text at all stays open as far as the rows say: the next row joins it.
  assert.equal(origin(R.typed('think', 1), R.thinking(), R.note(60), R.text('The build passed.')).origin, 'prompt');
});

test('what does not start a turn, or ends one: hook feedback, slash commands, a cut turn, a subagent\'s rows', () => {
  // The language check sent the answer back: the same turn, still the person's.
  assert.equal(origin(R.typed('שלום', 3), R.text('Hello.'), R.feedback(), R.text('שלום.')).prompt_at, T0 + 3000);
  assert.equal(origin(R.typed('x', 1), R.text('X.'), R.note(60), R.text('Passed.'), R.feedback(), R.text('עבר.')).origin, 'notification');
  // A slash command the CLI answered itself was no turn: the task's end after it starts one.
  assert.equal(origin(R.command('/model', 5), R.stdout('Set model to x'), R.note(60), R.text('Passed.')).origin, 'notification');
  // One that made a prompt for the model (a skill) is a turn someone typed.
  assert.deepEqual(origin(R.command('/review', 5), R.meta('The skill text.'), R.thinking(), R.text('Reviewed.')), { origin: 'prompt', origin_why: 'a typed prompt (origin human)', prompt_at: T0 + 5000, ...typedOne(R.command('/review').message.content) });
  // Cut short with Esc, or by a "No" in Claude Code's own dialog, which writes the interrupt row after
  // the refusal (2.1.332 checks for that row after a refused call): over, with no Stop of its own.
  assert.equal(origin(R.typed('run it', 1), R.call('t1'), R.interrupted(), R.note(60), R.text('Passed.')).origin, 'notification');
  assert.equal(origin(R.typed('run it', 1), R.call('t1'), R.rejected('t1'), R.toolInterrupted(), R.note(60), R.text('Passed.')).origin, 'notification');
  // A refusal with no interrupt row after it is a "No" with words for the model: the turn goes on, and
  // it is still the person's (it read as `unknown` once, and its next request was approved by the levels).
  assert.deepEqual(origin(R.typed('run it', 1), R.call('t1'), R.rejected('t1'), R.call('t2')), { origin: 'prompt', origin_why: 'a typed prompt (origin human)', prompt_at: T0 + 1000, ...typedOne('run it') });
  // So is a tool's error that only reads like a refusal: a model can shape its text.
  assert.equal(origin(R.typed('run it', 1), R.call('t1'), { type: 'user', message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: "The user doesn't want to proceed", is_error: true }] } }, R.call('t2')).origin, 'prompt');
  // After the CLI's error row the turn is over too.
  assert.equal(origin(R.typed('hi', 1), R.apiError('API Error: 500'), R.note(60), R.text('Passed.')).origin, 'notification');
  // A subagent's rows are not this session's.
  assert.equal(origin(R.typed('x', 1), R.text('X.'), R.note(60), { ...R.typed('a prompt for the subagent', 61), isSidechain: true }, R.text('Passed.')).origin, 'notification');
  // A note Claude Code wrote for the model in the middle of a turn changes nothing.
  assert.equal(origin(R.typed('x', 1), R.text('X.'), R.note(60), R.meta('<system-reminder>a reminder</system-reminder>'), R.text('Passed.')).origin, 'notification');
});

test('unknown: no row that starts a turn, a kind not known here, or a row nobody typed with no known tag', () => {
  assert.deepEqual(turnOrigin(''), { origin: 'unknown', origin_why: 'no row that starts a turn' });
  assert.deepEqual(turnOrigin('not json\n{"type":"user"'), { origin: 'unknown', origin_why: 'no row that starts a turn' });
  assert.deepEqual(origin(R.typed('x', 1), R.text('X.'), R.bare('<cross-session-message from="other">hello</cross-session-message>', 9), R.text('Hello.')),
    { origin: 'unknown', origin_why: '<cross-session-message>' });
  // Claude Code says nobody typed it, with a word this file does not know: said in the why, never delivered.
  assert.deepEqual(origin(R.typed('x', 1), R.text('X.'), { type: 'user', timestamp: iso(9), origin: { kind: 'some-new-kind' }, message: { content: 'Check the mail.' } }, R.text('No mail.')),
    { origin: 'unknown', origin_why: 'a row nobody typed (origin some-new-kind)' });
  // The why never carries the conversation: an origin that is no plain word is left out.
  assert.equal(origin({ type: 'user', origin: { kind: 'two words; and more' }, message: { content: 'hello' } }).origin_why, 'a typed prompt');
  assert.deepEqual(turnStarters(jsonl([R.typed('x', 1), R.text('X.'), R.note(60)])), [{ kind: 'notification', tag: 'task-notification', ids: ['toolu_1'], at: T0 + 60_000, said: 'task-notification' }]);
});

test('a prompt the session scheduled for itself starts a notification turn; the row that ends a turn closes it', () => {
  const before = [R.typed('check the mail every hour', 1), R.call('t1'), R.result('t1'), R.text('Scheduled.'), R.over()];
  // As measured: the queue's rows, the fire, the prompt as a note for the model, and at Stop time
  // not always the answer's own rows yet.
  const fire = [R.queued(), R.fired(3600), R.meta('Check the mail.')];
  assert.deepEqual(origin(...before, ...fire), { origin: 'notification', origin_why: 'a scheduled prompt' });
  assert.deepEqual(origin(...before, ...fire, R.text('No mail.')), { origin: 'notification', origin_why: 'a scheduled prompt' });
  // A person typed into that turn: theirs.
  assert.equal(origin(...before, ...fire, R.call('t2'), R.result('t2'), R.typed('and the calendar?', 3605), R.text('No mail, no events.')).prompt_at, T0 + 3605_000);
  // It fired while a typed turn ran and was told to the model in it: the typed turn's.
  assert.equal(origin(R.typed('what is in this folder?', 30), R.call('t1'), R.result('t1'), R.fired(40), R.meta('Check the mail.'), R.text('Three files. No mail.')).origin, 'prompt');

  // After the row that ends a turn, the rows of that turn say nothing about the next one: a turn
  // with no row that starts it is unknown, not a copy of the one before.
  assert.deepEqual(origin(R.typed('x', 1), R.text('X.'), R.over()), { origin: 'unknown', origin_why: 'no row that starts a turn' });
  assert.equal(origin(R.typed('x', 1), R.text('X.'), R.over(), R.note(60), R.text('Passed.'), R.over(), R.meta('a note of a kind not known here')).origin, 'unknown');
  // A turn that ended with no text closes too: the task's end after it is a turn of its own.
  assert.equal(origin(R.typed('think', 1), R.thinking(), R.over(), R.note(60), R.text('The build passed.')).origin, 'notification');
  // The language check sent the answer back after the turn was written as ended: the same turn again.
  assert.equal(origin(R.typed('x', 1), R.text('X.'), R.over(), R.note(60), R.text('Passed.'), R.over(), R.feedback(), R.text('עבר.')).origin, 'notification');
  assert.equal(origin(R.typed('שלום', 7), R.text('Hello.'), R.over(), R.feedback(), R.text('שלום.')).prompt_at, T0 + 7000);
});

test('the shape of the last rows, for measuring a new Claude Code: names from fixed lists and flags, never the words', () => {
  const rows = [
    R.typed('a secret question', 1),
    { type: 'assistant', message: { id: 'msg_01secretidWXYZ', role: 'assistant', content: [{ type: 'thinking', thinking: 'a secret thought' }] } },
    { type: 'assistant', message: { id: 'msg_01secretidWXYZ', role: 'assistant', content: [{ type: 'text', text: 'A secret answer.' }] } },
    R.over(), R.queued(), { type: 'queue-operation', operation: 'dequeue' }, R.note(60), R.fired(70), R.meta('<system-reminder>secret</system-reminder>'),
    { type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'secret output' }] } },
    { type: 'assistant', message: { id: 'msg_02other', role: 'assistant', content: [{ type: 'text', text: 'More.' }] } },
  ];
  const shapes = rowShapes(jsonl(rows) + 'not json\n');
  assert.deepEqual(shapes, [
    'user origin=human [string]', 'assistant msg=1 [thinking]', 'assistant msg=1 [text]', 'system turn_duration', 'queue-operation enqueue [string<task-notification>]', 'queue-operation dequeue',
    'user origin=task-notification [string<task-notification>]', 'system scheduled_task_fire', 'user meta [text<system-reminder>]', 'user sidechain [tool_result]', 'assistant msg=2 [text]', 'not-json',
  ]);
  assert.equal(rowShapes(jsonl(rows), 2).length, 2, 'the last rows only');

  // Whatever a person or a tool puts where a name is expected, no word of it comes out: a tag or a
  // block type outside the fixed lists reads `other`, a field that is no short identifier is left out,
  // and nothing of an id is copied.
  const hostile = [
    { type: 'user', origin: { kind: 'secretword and more' }, subtype: 'x'.repeat(33), message: { content: '<secretword-hunter-two> the rest' } },
    { type: 'user', message: { content: [{ type: 'text', text: '<secretword>' }, { type: 'secretword', text: 'x' }, { type: 'text', text: 'no tag secretword' }] } },
    { type: 'secretword with spaces', message: { id: 'secretword-id', content: 'secretword' } },
    { type: 'assistant', subtype: 'secretword', operation: 'secret word', message: { id: 'secretword-id-2', content: [{ type: 'tool_use', name: 'secretword', input: { command: 'secretword' } }] } },
  ];
  const out = rowShapes(jsonl(hostile));
  assert.deepEqual(out, ['user [string<other>]', 'user [text<other>,other,text]', '? msg=1 [string]', 'assistant secretword msg=2 [tool_use]']);
  // A queued prompt and a paste of several lines (2.1.330): the attachment's type and origin, the paste's tag.
  assert.deepEqual(rowShapes(jsonl([{ type: 'attachment', attachment: { type: 'queued_command', prompt: 'secret', origin: { kind: 'human' } } }, R.typed('<pasted_content id="3f0a">\nsecret\n</pasted_content id="3f0a">\n', 1)])),
    ['attachment queued_command attachment-origin=human', 'user origin=human [string<pasted_content>]']);
  // The one place a row's own value comes through is a field of Claude Code's that is one short
  // identifier (here `subtype`); never content, a tag, a block type, an id, or anything with a space.
  assert.ok(!out.slice(0, 3).join(' ').includes('secret'));
  for (const shape of [...shapes, ...out]) assert.match(shape, /^[A-Za-z0-9_?-]{1,32}( [A-Za-z0-9_=-]{1,40})*( \[[a-z_<>,-]+\])?$/);
});

test('a turn with no row that starts it says nothing by the turn before it, with or without the row that ends a turn', () => {
  // One answer of the model is several rows of one API message; a new message right after a closed
  // turn, with no row between them that opened one, is a turn something unseen started.
  const said = (id: string, text: string) => ({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
  const used = (id: string, call: string) => ({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'tool_use', id: call, name: 'Bash', input: {} }] } });
  // A transcript with no `turn_duration` rows: the model answering again right after a closed turn.
  assert.deepEqual(origin(R.typed('schedule it', 1), said('m1', 'Scheduled.'), said('m2', 'The scheduled check ran.')), { origin: 'unknown', origin_why: 'no row that starts it' });
  assert.equal(origin(R.typed('x', 1), said('m1', 'X.'), R.note(60), said('m2', 'Passed.'), said('m3', 'The scheduled check ran.')).origin, 'unknown', 'nor as the task\'s end before it');
  // The rows of one message, and a message after a tool result or a typed row, are the same turn or a seen one.
  assert.equal(origin(R.typed('x', 1), said('m1', 'Looking.'), used('m1', 't1'), R.result('t1'), said('m2', 'Found it.')).origin, 'prompt');
  assert.equal(origin(R.typed('x', 1), said('m1', 'X.'), R.note(60), said('m2', 'Passed.')).origin, 'notification');
  assert.equal(origin(R.typed('x', 1), said('m1', 'X.'), R.feedback(), said('m2', 'X again.')).origin, 'prompt', 'the hook sent the answer back');
  // A note Claude Code wrote for the model that says of itself that no person sent it may start a turn:
  // of a kind not known here, so never delivered, and named in the why.
  assert.deepEqual(origin(R.typed('x', 1), said('m1', 'X.'), { type: 'user', isMeta: true, origin: { kind: 'some-new-kind' }, message: { content: [{ type: 'text', text: 'Check the mail.' }] } }, said('m2', 'No mail.')),
    { origin: 'unknown', origin_why: 'a row nobody typed (origin some-new-kind)' });
});

function session(rows: object[]) {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-origin-'));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, jsonl(rows));
  return { dir, transcript, marker: join(dir, 'turn.json') };
}
const stop = (s: { transcript: string; marker: string }, last: string) => {
  execFileSync(process.execPath, [HOOK, '--guard'], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: s.transcript, session_id: 's1', last_assistant_message: last }), env: { ...process.env, ANGELIA_TUI_MARKER: s.marker } });
  return JSON.parse(readFileSync(s.marker, 'utf8'));
};

test('the Stop hook writes what started the turn into its marker, whole', () => {
  const typed = session([R.typed('hello', 5), R.text('Hi.')]);
  const a = stop(typed, 'Hi.');
  assert.deepEqual({ ...a, at: 0 }, { text: 'Hi.', transcript_path: typed.transcript, session_id: 's1', at: 0, origin: 'prompt', origin_why: 'a typed prompt (origin human)', prompt_at: T0 + 5000, ...typedOne('hello') });
  assert.ok(Math.abs(a.at - Date.now()) < 10_000);
  assert.equal(existsSync(`${typed.marker}.tmp`), false, 'written beside the marker and moved into place');

  const woke = session([R.typed('start the build', 1), R.call('t1'), R.result('t1'), R.text('Started.'), R.over(), R.queued(), R.note(60), R.text('The build passed.')]);
  const b = stop(woke, 'The build passed.');
  assert.equal(b.origin, 'notification');
  assert.equal(b.text, 'The build passed.');
  assert.equal('prompt_at' in b, false);
  assert.equal('origin_rows' in b, false, 'the rows\' shape only when asked for');
  const shaped = JSON.parse((() => {
    execFileSync(process.execPath, [HOOK, '--guard'], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: woke.transcript, last_assistant_message: 'The build passed.' }), env: { ...process.env, ANGELIA_TUI_MARKER: woke.marker, ANGELIA_TUI_ORIGIN_DEBUG: '1' } });
    return readFileSync(woke.marker, 'utf8');
  })());
  assert.deepEqual(shaped.origin_rows.slice(-2), ['user origin=task-notification [string<task-notification>]', 'assistant [text]']);

  // No transcript to read: the marker is still written, and says so.
  const none = session([]);
  const c = stop({ transcript: join(none.dir, 'missing.jsonl'), marker: none.marker }, 'An answer.');
  assert.deepEqual([c.text, c.origin, c.origin_why], ['An answer.', 'unknown', 'no row that starts a turn']);
});

test('a prompt typed while a turn ran (a queued_command attachment, 2.1.330) is a typed prompt; a notification kind is not', () => {
  const Q = (prompt: unknown, kind?: string, s = 0) => ({ type: 'attachment', timestamp: iso(s), attachment: { type: 'queued_command', prompt, ...(kind ? { origin: { kind } } : {}) } });
  const before = [R.typed('start the build', 1), R.call('t1'), R.result('t1'), R.text('Started.'), R.over()];
  // The owner typed into a turn a task's end started: the turn is theirs.
  assert.deepEqual(origin(...before, R.note(60), R.call('t2'), Q('and the logs?', 'human', 65), R.result('t2'), R.text('Passed. Logs clean.')),
    { origin: 'prompt', origin_why: '<task-notification> (origin task-notification), a prompt typed while the turn ran (origin human)', prompt_at: T0 + 65_000, ...typedOne('and the logs?') });
  // Typed into a turn Angelia typed: two prompts, so the turn's one prompt is not Angelia's alone.
  const two = origin(R.typed('run the check', 1), R.call('t1'), Q([{ type: 'text', text: 'delete the logs too' }], 'human', 5), R.result('t1'), R.text('Done.'));
  assert.deepEqual([two.origin, two.prompts, two.prompt_key], ['prompt', 2, promptKey('delete the logs too')]);
  // No origin at all: taken as typed.
  assert.equal(origin(...before, R.note(60), R.call('t2'), Q('hm'), R.text('Ok.')).origin, 'prompt');
  // A task's end queued as an attachment: a notification, with its id.
  assert.deepEqual(origin(...before, Q(NOTE, 'task-notification', 60), R.text('Passed.')), { origin: 'notification', origin_why: '<task-notification> (origin task-notification)', origin_ids: ['toolu_1'] });
  // A kind not known here (a plugin's note, an unclassified forward): not delivered.
  assert.deepEqual(origin(...before, Q('a note', 'plugin', 60), R.text('Noted.')), { origin: 'unknown', origin_why: 'a queued row nobody typed (origin plugin)' });
  // Other attachments are bookkeeping.
  assert.equal(origin(...before, R.note(60), { type: 'attachment', attachment: { type: 'file', content: 'x' } }, R.text('Passed.')).origin, 'notification');
});

test('the key of a typed prompt is the same in the hook and in the daemon, and says no words', () => {
  for (const t of ['hello', '  two\n\nlines\t here ', 'שלום עולם', 'Cafe\u0301']) assert.equal(promptKey(t), daemonKey(t));
  assert.equal(promptKey('a  b\n'), promptKey('a b'));
  assert.notEqual(promptKey('a b'), promptKey('a c'));
  assert.match(promptKey('hello'), /^[0-9a-f]{32}$/);
  // A paste of several lines, as Claude Code 2.1.330 writes it into the transcript (measured live with
  // tests/live-prompt-key.mts: the row was 58 and 61 characters longer than the typed text).
  const typed = '[telegram group Test · Owner (u1) · 2026-11-21 10:00]\n> a quoted line\n\nשלום 🎉\tok';
  const row = `<pasted_content id="3f0a">\n${typed}\n</pasted_content id="3f0a">\n`;
  assert.equal(origin(R.typed(row, 5), R.text('ok')).prompt_key, daemonKey(typed));
  assert.equal(origin(R.typed(`see below\n\n${row}`, 5), R.text('ok')).prompt_key, daemonKey(`see below\n${typed}`));
});
