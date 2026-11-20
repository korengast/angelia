import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';

// Own state dir before tui.js reads it at import, so nothing here can touch a live Angelia.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-tuiquiet-'));

const here = dirname(fileURLToPath(import.meta.url));
const frame = (name: string) => readFileSync(join(here, 'fixtures', `pane-${name}.txt`), 'utf8');

// Rows shaped as the readers in src/brain take them from a session's transcript. Content made up.
const R = {
  prompt: (text: string) => ({ type: 'user', message: { role: 'user', content: text } }),
  text: (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  thinking: () => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'A thought.', signature: 's' }] } }),
  call: (id: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 600' } }] } }),
  result: (id: string) => ({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok', is_error: false }] }, toolUseResult: { stdout: 'ok' } }),
  // "No" in Claude Code's own dialog, in the two shapes paneVerdict reads.
  rejected: (id: string) => ({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'x', is_error: true }] }, toolUseResult: 'User rejected tool use' }),
  refused: (id: string) => ({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: "The user doesn't want to proceed with this tool use.", is_error: true }] } }),
  command: (name: string) => ({ type: 'user', message: { role: 'user', content: `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args></command-args>` } }),
  stdout: (text: string) => ({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } }),
  meta: (text: string) => ({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } }),
  interrupted: () => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
  apiError: (text: string) => ({ type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] } }),
  feedback: () => ({ type: 'user', message: { role: 'user', content: 'Stop hook feedback:\n[node hook.mjs]: write the answer again, shorter.' } }),
  system: () => ({ type: 'system', subtype: 'turn_duration', durationMs: 5 }),
};
const jsonl = (rows: object[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');

/** The waits of the quiet path, short: 12 s, 90 s and 3 min in the daemon. */
const FAST = { quietMs: 1000, quietTextMs: 4000, quietOpenMs: 6000 };
/** The log line of a turn the transcript holds open on an idle-looking pane. */
const HELD = 'transcript shows the turn open';

interface Step { when: number | 'held'; rows?: object[]; marker?: string }
interface Stub { waits?: Partial<typeof FAST>; pane?: (n: number) => string; before?: object[]; follow?: boolean }

/** A turn on a stubbed pane that reads idle from Enter on, as a screen the busy check misreads does.
 *  `steps`: what is written to the transcript, and the Stop hook's marker: so many ms after Enter, or
 *  once the reader has logged that it holds the turn open (`held`), which no clock decides.
 *  `ms` in the result counts from Enter. `follow`: no message is typed; a turn that runs already (`before`) is taken back, as /resume does. */
async function turnWith(text: string, steps: Step[], stub: Stub = {}) {
  const { TuiBrain } = await import('../src/brain/tui.js');
  const cwd = mkdtempSync(join(tmpdir(), 'angelia-tuiquiet-cwd-'));
  const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
  const brain = new TuiBrain(profile, { id: crypto.randomUUID(), started: true }, { bin: '/bin/false', ...FAST, ...stub.waits });
  const b = brain as any;
  b.ready = Promise.resolve(null);
  b.up = true;
  mkdirSync(b.dir, { recursive: true });
  // Its own transcript in the temp folder, never under the real ~/.claude.
  b.transcript = join(cwd, 'transcript.jsonl');
  writeFileSync(b.transcript, jsonl(stub.before ?? [R.prompt('an earlier message'), R.text('An earlier answer.')]));
  const timers: NodeJS.Timeout[] = [];
  const run = (s: Step) => {
    if (s.rows) appendFileSync(b.transcript, jsonl(s.rows));
    if (s.marker !== undefined) writeFileSync(join(b.dir, 'turn.json'), JSON.stringify({ text: s.marker, at: Date.now() }));
  };
  const logs: string[] = [];
  brain.on('log', (l: string) => {
    logs.push(l);
    // A little after the line: the reader is past the poll that logged it.
    if (l.includes(HELD)) for (const s of steps) if (s.when === 'held') timers.push(setTimeout(() => run(s), 300));
  });
  let entered = false, looks = 0, enteredAt = 0;
  const start = () => { entered = true; enteredAt = Date.now(); for (const s of steps) if (typeof s.when === 'number') timers.push(setTimeout(() => run(s), s.when)); };
  const landed = frame('idle').replace(/❯\s+Try "refactor <filepath>"/, '❯ [Pasted text #1 +2 lines]');
  b.capture = async () => (entered ? (stub.pane?.(++looks) ?? frame('idle')) : landed);
  b.sessionAlive = async () => true;
  b.tm = async (a: string[]) => { if (a[0] === 'send-keys' && a.includes('Enter') && !entered) start(); return { code: 0, out: '' }; };
  const events: any[] = [];
  try {
    if (stub.follow) { b.turnSentAt = Date.now() - 60_000; start(); for await (const e of brain.follow()) events.push(e); }
    else for await (const e of brain.turn(text)) events.push(e);
  } finally { for (const t of timers) clearTimeout(t); }
  const ms = Date.now() - enteredAt; // from Enter: typing the message takes seconds of its own
  await new Promise((r) => setTimeout(r, 200)); // a kept screen is written just after the result
  /** The screen kept under `name` in the pane's folder, or null. */
  const kept = (name: string): string | null => (existsSync(join(b.dir, name)) ? readFileSync(join(b.dir, name), 'utf8') : null);
  return { events, logs, ms, kept };
}
const results = (events: any[]) => events.filter((e) => e.kind === 'result');
const ENDED_QUIET = (how: string, chars: number) => new RegExp(`^tmux: turn ended by the quiet pane \\(no Stop marker; transcript ${how}\\) after \\d+ s, answer ${chars} chars pane=\\S+$`);

test('transcript rows say where a turn stands: the last row that counts decides', async () => {
  const { turnRows } = await import('../src/brain/tui.js');
  const at = (...rows: object[]) => turnRows(jsonl(rows));
  assert.equal(at(), 'none');
  assert.equal(at(R.system()), 'none', 'bookkeeping is no turn');
  assert.equal(at(R.prompt('hi')), 'open', 'the model owes an answer');
  assert.equal(at(R.prompt('hi'), R.thinking()), 'open');
  assert.equal(at(R.prompt('hi'), R.thinking(), R.text('Looking.')), 'said', 'the answer, or text before a tool call not written yet');
  assert.equal(at(R.prompt('hi'), R.thinking(), R.text('Looking.'), R.call('t1')), 'open', 'a tool runs');
  assert.equal(at(R.prompt('hi'), R.text('Looking.'), R.thinking()), 'open', 'thinking after text: the model is at work again');
  assert.equal(at(R.prompt('hi'), R.call('t1'), R.result('t1')), 'open', 'the tool is back, the model owes an answer');
  assert.equal(at(R.prompt('hi'), R.call('t1'), R.result('t1'), R.text('Done.')), 'said');
  assert.equal(at(R.prompt('hi'), R.text('Done.'), R.system(), R.meta('a note Claude Code wrote')), 'said', 'bookkeeping after the answer changes nothing');
  assert.equal(at(R.prompt('hi'), R.text('Done.'), R.prompt('<task-notification>\n<task-id>b1</task-id>\n</task-notification>')), 'open', 'a task ended: the model answers that');
  // A Stop hook sent the answer back: the model owes it again.
  assert.equal(at(R.prompt('hi'), R.text('Done.'), R.feedback()), 'open');
  // A row may hold several blocks: they are read in order.
  const blocks = (...b: object[]) => ({ type: 'assistant', message: { role: 'assistant', content: b } });
  assert.equal(at(R.prompt('hi'), blocks({ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} })), 'open');
  assert.equal(at(R.prompt('hi'), blocks({ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Done.' })), 'said');
  assert.equal(at(R.prompt('hi'), { type: 'user', message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: 'x' }, { type: 'text', text: 'a note' }] } }), 'open');
  // The CLI's own row for a failed API call or a usage limit: nothing follows it.
  assert.equal(at(R.prompt('hi'), R.text('Looking.'), R.apiError('API Error: 500')), 'error');
  assert.equal(at(R.prompt('hi'), R.apiError("You've reached your usage limit.")), 'error');
  assert.equal(at(R.prompt('hi'), { type: 'assistant', error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 429' }] } }), 'error');
  // A slash command the CLI ran itself is no turn, with or without its output row, wherever its caveat is.
  assert.equal(at(R.command('/model')), 'command');
  assert.equal(at(R.meta('<local-command-caveat>Caveat</local-command-caveat>'), R.command('/model'), R.stdout('Set model to x')), 'none');
  assert.equal(at(R.command('/model'), R.meta('<local-command-caveat>Caveat</local-command-caveat>'), R.stdout('Set model to x')), 'none');
  // One that makes a prompt for the model (a skill): the meta row after it is that prompt, and the
  // turn is open before the model's first row. Thinking keeps it so.
  assert.equal(at(R.command('/review'), R.meta('The skill text.')), 'open');
  assert.equal(at(R.command('/review'), R.meta('The skill text.'), R.thinking()), 'open');
  assert.equal(at(R.command('/review'), R.meta('The skill text.'), R.thinking(), R.text('Reviewed.')), 'said');
  // A command typed while a turn runs does not close it.
  assert.equal(at(R.prompt('hi'), R.call('t1'), R.command('/model'), R.stdout('Set model to x')), 'open');
  // Cut short: Esc, or "No" in Claude Code's own dialog. No Stop hook runs after either.
  assert.equal(at(R.prompt('hi'), R.call('t1'), R.interrupted()), 'none');
  assert.equal(at(R.prompt('hi'), R.call('t1'), { type: 'user', message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: 'x', is_error: true }, { type: 'text', text: '[Request interrupted by user for tool use]' }] } }), 'none');
  assert.equal(at(R.prompt('hi'), R.call('t1'), R.rejected('t1')), 'none');
  assert.equal(at(R.prompt('hi'), R.call('t1'), R.refused('t1')), 'none');
  // A subagent's rows are not this session's turn.
  assert.equal(at(R.prompt('hi'), R.text('Done.'), { ...R.call('t9'), isSidechain: true }), 'said');
  // Read in pieces, as the poll reads the file: the state carries over, and half a row is no row.
  assert.equal(turnRows(jsonl([R.text('Done.')]), turnRows(jsonl([R.prompt('hi'), R.call('t1')]))), 'said');
  assert.equal(turnRows(jsonl([R.meta('The skill text.')]), turnRows(jsonl([R.command('/review')]))), 'open');
  assert.equal(turnRows('{"type":"assistant","message":{"content":[{"type":"te', 'open'), 'open');
});

// Each turn here waits on the quiet path on purpose, so they run side by side.
describe('tmux mode: an idle-looking pane and the turn\'s transcript', { concurrency: true }, () => {
  test('a tool still running (a call with no result) is not the end of the turn: the answer comes with the Stop marker', { timeout: 30_000 }, async () => {
    const { events, logs, kept } = await turnWith('run the long check', [
      { when: 100, rows: [R.prompt('run the long check'), R.thinking(), R.text('Starting the check.'), R.call('t1')] },
      { when: 'held', rows: [R.result('t1'), R.text('The check passed.')], marker: 'The check passed.' },
    ]);
    assert.deepEqual(results(events), [{ kind: 'result', text: 'The check passed.', isError: false }], 'one result, the real answer, never an empty one before it');
    assert.deepEqual(events.filter((e) => e.kind === 'progress'), [{ kind: 'progress', text: 'Starting the check.' }]);
    assert.equal(logs.filter((l) => l.includes(HELD)).length, 1, 'said once in the log');
    assert.match(kept('idle-open.txt') ?? '', /the pane read idle while the transcript showed the turn open\n[\s\S]*❯/, 'with the screen that read as idle kept');
    // How it ended: the path, the time and the answer's length, never its words.
    assert.match(logs.at(-1)!, /^tmux: turn ended by the Stop marker after \d+ s, answer 17 chars pane=\S+$/);
    assert.ok(!logs.some((l) => l.includes('The check passed')));
    assert.equal(kept('quiet-empty.txt'), null);
  });

  test('a tool result as the last row (the model owes its answer) is not the end of the turn', { timeout: 30_000 }, async () => {
    const { events } = await turnWith('read the page', [
      { when: 100, rows: [R.prompt('read the page'), R.call('t1'), R.result('t1')] },
      { when: 'held', rows: [R.thinking(), R.text('The page says hello.')], marker: 'The page says hello.' },
    ]);
    assert.deepEqual(results(events), [{ kind: 'result', text: 'The page says hello.', isError: false }]);
  });

  test('the prompt as the last row (long thinking, a slow API) is not the end of the turn', { timeout: 30_000 }, async () => {
    const { events } = await turnWith('think hard', [
      { when: 100, rows: [R.prompt('think hard')] },
      { when: 'held', rows: [R.thinking(), R.text('Forty-two.')], marker: 'Forty-two.' },
    ]);
    assert.deepEqual(results(events), [{ kind: 'result', text: 'Forty-two.', isError: false }]);
  });

  test('a slash command the CLI answers itself still ends by the quiet pane after the short wait, with no answer text', { timeout: 30_000 }, async () => {
    // One that writes its rows, one that writes only its own row, and one that writes nothing at all.
    const slow = { quietTextMs: 60_000, quietOpenMs: 60_000 };
    const [model, cost, clear] = await Promise.all([
      turnWith('/model', [{ when: 100, rows: [R.command('/model'), R.stdout('Set model to x')] }], { waits: slow }),
      turnWith('/cost', [{ when: 100, rows: [R.command('/cost')] }], { waits: slow }),
      turnWith('/clear', [], { waits: slow }),
    ]);
    for (const t of [model, cost, clear]) {
      assert.deepEqual(t.events, [{ kind: 'result', text: '', isError: false }]);
      assert.ok(t.ms < 30_000, `the short wait, not a long one: ${t.ms} ms`);
      assert.match(t.logs.at(-1)!, ENDED_QUIET(t === cost ? 'has a slash command only' : 'has no turn', 0));
      assert.equal(t.kept('quiet-empty.txt'), null, 'expected of a slash command: no screen kept');
    }
  });

  test('a slash command that starts a turn of the model (a skill) is open while the model works: its answer is delivered', { timeout: 30_000 }, async () => {
    // The command's row, the skill's text as a meta row, then thinking: no text yet, and a pane that reads idle.
    const { events, logs } = await turnWith('/review', [
      { when: 100, rows: [R.command('/review'), R.meta('Review the changes on this branch.'), R.thinking()] },
      { when: 'held', rows: [R.call('t1'), R.result('t1'), R.text('Two findings.')], marker: 'Two findings.' },
    ]);
    assert.deepEqual(results(events), [{ kind: 'result', text: 'Two findings.', isError: false }], 'never an empty result, which the chat would get as "/review done."');
    assert.equal(logs.filter((l) => l.includes(HELD)).length, 1);
  });

  test('text as the last row is not the end yet: a tool call written later, and the turn goes on to its answer', { timeout: 30_000 }, async () => {
    // The call's row is written when its input is whole; a large file takes longer than the short wait.
    const { events, logs } = await turnWith('write the report', [
      { when: 100, rows: [R.prompt('write the report'), R.text('Writing the report now.')] },
      { when: 3000, rows: [R.call('t1'), R.result('t1'), R.text('The report is written.')], marker: 'The report is written.' },
    ], { waits: { quietTextMs: 20_000 } });
    assert.deepEqual(results(events), [{ kind: 'result', text: 'The report is written.', isError: false }], 'never the first text as the answer');
    assert.deepEqual(events.filter((e) => e.kind === 'progress'), [{ kind: 'progress', text: 'Writing the report now.' }]);
    assert.match(logs.at(-1)!, /^tmux: turn ended by the Stop marker after \d+ s, answer 22 chars pane=\S+$/);
  });

  test('the Stop hook failed: the last text is still delivered as the answer, after the longer wait, counted from the last row of any kind', { timeout: 30_000 }, async () => {
    // A bookkeeping row 2.5 s in starts the 2 s wait again: without it the turn would end before 4 s.
    const { events, ms, logs, kept } = await turnWith('what is new?', [
      { when: 100, rows: [R.prompt('what is new?'), R.call('t1'), R.result('t1'), R.text('Nothing is new.')] },
      { when: 2500, rows: [R.system()] },
    ], { waits: { quietTextMs: 2000 } });
    assert.deepEqual(events, [{ kind: 'result', text: 'Nothing is new.', isError: false }]);
    assert.ok(ms > 2500 + 2000, `after the longer wait from the last row: ${ms} ms`);
    assert.match(logs.at(-1)!, ENDED_QUIET('ends with text', 15));
    assert.ok(!logs.some((l) => l.includes('Nothing is new')), 'the log never holds the answer');
    assert.equal(kept('quiet-empty.txt'), null);
  });

  test('the CLI\'s own error row as the last row (a usage limit) ends the turn after the short wait, not the longer one for text', { timeout: 30_000 }, async () => {
    const LIMIT = "You've reached your usage limit. Switch to another model.";
    const { events, ms, logs } = await turnWith('what is new?', [
      { when: 100, rows: [R.prompt('what is new?'), R.text('Looking.'), R.apiError(LIMIT)] },
    ], { waits: { quietTextMs: 60_000, quietOpenMs: 60_000 } });
    assert.deepEqual(results(events), [{ kind: 'result', text: LIMIT, isError: false }]);
    assert.ok(ms < 30_000, `the short wait: ${ms} ms`);
    assert.match(logs.at(-1)!, ENDED_QUIET('ends with an error row of the CLI', LIMIT.length));
  });

  test('a running turn taken back (/resume) is held by the rows written before, though none is shown again', { timeout: 30_000 }, async () => {
    // The turn so far, written while the session was in the background: a tool runs.
    const { events, logs } = await turnWith('', [
      { when: 'held', rows: [R.result('t1'), R.text('The check passed.')], marker: 'The check passed.' },
    ], { follow: true, before: [R.prompt('run the long check'), R.text('Starting the check.'), R.call('t1')] });
    assert.deepEqual(events, [{ kind: 'result', text: 'The check passed.', isError: false }], 'the answer, and no old line as progress');
    assert.equal(logs.filter((l) => l.includes(HELD)).length, 1);
  });

  test('a message that leaves no row in the transcript ends by the quiet pane as before, and the screen it ended on is kept', { timeout: 30_000 }, async () => {
    const { events, logs, kept } = await turnWith('hello there', []);
    assert.deepEqual(events, [{ kind: 'result', text: '', isError: false }]);
    // A turn that ends with nothing for the chat: the log says how, and the screen is there to read.
    assert.match(logs.at(-1)!, ENDED_QUIET('has no turn', 0));
    assert.match(kept('quiet-empty.txt') ?? '', /^\S+ the turn ended by the quiet pane \(no Stop marker; transcript has no turn\) with no answer\n[\s\S]*❯/);
  });

  test('a turn cut short (Esc, or "No" in Claude Code\'s own dialog) ends after the short wait, though its tool call has no result', { timeout: 30_000 }, async () => {
    // No Stop hook runs after either, so nothing else would end the turn.
    const slow = { quietTextMs: 60_000, quietOpenMs: 60_000 };
    const [esc, no] = await Promise.all([
      turnWith('run it', [{ when: 100, rows: [R.prompt('run it'), R.call('t1'), R.interrupted()] }], { waits: slow }),
      turnWith('run it', [{ when: 100, rows: [R.prompt('run it'), R.call('t1'), R.rejected('t1')] }], { waits: slow }),
    ]);
    for (const t of [esc, no]) {
      assert.deepEqual(t.events, [{ kind: 'result', text: '', isError: false }]);
      assert.ok(t.ms < 30_000, `the short wait: ${t.ms} ms`);
      assert.match(t.logs.at(-1)!, ENDED_QUIET('has no turn', 0));
      assert.ok(!t.logs.some((l) => l.includes(HELD)));
    }
  });

  test('an open turn with no new row and nothing moving above the input box ends after the long bound; rows under the box do not count', { timeout: 30_000 }, async () => {
    // A shape of row the reader does not know left the turn open, or it ended with no hook and no
    // closing row. A teammate's clock under the box ticks at every look.
    const idle = frame('idle');
    const ticking = (n: number) => `${idle.trimEnd()}\n\n  ⏺ main\n  ◯ helper  Some other work${' '.repeat(60)}${n}s · ↓ 1.0k tokens\n`;
    const { events, ms, logs, kept } = await turnWith('run it', [{ when: 100, rows: [R.prompt('run it'), R.call('t1')] }], { waits: { quietOpenMs: 3000 }, pane: ticking });
    assert.deepEqual(events, [{ kind: 'result', text: '', isError: false }]);
    assert.ok(ms > 3000, `after the bound: ${ms} ms`);
    assert.equal(logs.filter((l) => l.includes(HELD)).length, 1, 'held first');
    assert.match(logs.at(-1)!, ENDED_QUIET('open, no new row and nothing moving above the input box for \\d+ s', 0));
    assert.match(kept('quiet-empty.txt') ?? '', /transcript open, no new row and nothing moving above the input box/);
    assert.ok(kept('idle-open.txt'));
  });

  test('an open turn whose screen keeps moving above the input box is never ended by the bound', { timeout: 30_000 }, async () => {
    // A working CLI redraws a clock above the box every second, in a row the busy check may not know.
    const idle = frame('idle');
    const rule = idle.indexOf('─'.repeat(20));
    const working = (n: number) => `${idle.slice(0, rule)}  a row of a kind not known yet, ${n}s\n\n${idle.slice(rule)}`;
    const { events, ms, logs } = await turnWith('run it', [
      { when: 100, rows: [R.prompt('run it'), R.call('t1')] },
      { when: 5000, rows: [R.result('t1'), R.text('It ran.')], marker: 'It ran.' },
    ], { waits: { quietOpenMs: 1500 }, pane: working });
    assert.deepEqual(results(events), [{ kind: 'result', text: 'It ran.', isError: false }], 'the answer, more than three bounds later');
    assert.ok(ms > 4500, `${ms} ms`);
    assert.match(logs.at(-1)!, /^tmux: turn ended by the Stop marker /);
  });
});
