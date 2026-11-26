import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText } from '../src/core/types.js';
import { boxHoldsOnly } from '../src/brain/tmux.js';

// The prompt key miss of 0.4.4 (2026-11-26): text left in the input box with the cursor at its start.
// Ctrl-U deletes from the cursor back to the line's start, so it deleted nothing; the paste went in
// before the old text, Enter sent both as one prompt, and the Stop hook keyed that prompt as none
// Angelia typed: the turn dropped its own answer. Measured on claude 2.1.332 (tests/live-key-miss.mts):
// a line left that way is stored after the pasted block, a chip left that way as a second
// `<pasted_content>` block with the same id. The pane here is a stub of Claude Code's input editor:
// a text and a cursor, Ctrl-U and Ctrl-K as its program text has them, a multi-line paste as a chip,
// Enter writes the prompt the way 2.1.332 stores it. The Stop hook and its key are the real scripts.
const here = dirname(fileURLToPath(import.meta.url));
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-keymiss-'));
process.env.ANGELIA_TMUX_SOCKET = `angelia-test-keymiss-${process.pid}`;
const { Config } = await import('../src/instance/config/schema.js');
const { KEY_KEPT_LINE, KEY_MISS_LINE, promptKey, TuiBrain } = await import('../src/brain/tui.js');
const { promptKey: hookKey } = await import('../scripts/turn-origin.mjs');
const { ROW, jsonl, until } = await import('./tui-stub.js');

const idle = readFileSync(join(here, 'fixtures', 'pane-idle.txt'), 'utf8');
const HOOK = fileURLToPath(new URL('../scripts/tui-stop-hook.mjs', import.meta.url));
const ID = '37b5';
const head = '[telegram dm 1001 · Owner (1001)]';
const label = "Replying to (quoted by the sender's app; author not verified):";
/** The customer's shapes: a quote block whose reply is one dot, and a plain numbered list. */
const QUOTE_DOT = [head, label, '> Here is what I found:', '> ', '> - the first point', '', '.'].join('\n');
const LIST = [head, '', '1. first item', '2. second item'].join('\n');
const POSTED = '[Posted in this chat since your last turn by Angelia, not written by you.]\n[26 Nov 12:20 · job digest] the digest ran\n> line two of it';

/** Claude Code's input box as a text and a cursor. A multi-line paste is a chip, its text kept aside. */
class Editor {
  text = '';
  cur = 0;
  chips = new Map<number, string>();
  n = 0;
  /** Keys do nothing (a box that cannot be cleared: no stub of a real one, the check before Enter's case). */
  stuck = false;
  key(k: string): void {
    if (this.stuck) return;
    const t = this.text, c = this.cur;
    const sol = t.lastIndexOf('\n', c - 1) + 1, eol = t.indexOf('\n', c) < 0 ? t.length : t.indexOf('\n', c);
    // deleteToLineStart / deleteToLineEnd of 2.1.332: the line break right at the cursor first.
    if (k === 'C-u') { const from = c > 0 && t[c - 1] === '\n' ? c - 1 : sol; this.text = t.slice(0, from) + t.slice(c); this.cur = from; }
    else if (k === 'C-k') { const to = t[c] === '\n' ? c + 1 : eol; this.text = t.slice(0, c) + t.slice(to); }
    else if (k === 'C-a') this.cur = sol;
    else if (k === 'Up') this.cur = Math.max(0, t.lastIndexOf('\n', sol - 2) + 1);
  }
  insert(s: string): void {
    const put = s.includes('\n') ? `[Pasted text #${++this.n} +${s.split('\n').length - 1} lines]` : s;
    if (s.includes('\n')) this.chips.set(this.n, s);
    this.text = this.text.slice(0, this.cur) + put + this.text.slice(this.cur);
    this.cur += put.length;
  }
  /** What Enter sends, as 2.1.332 stores it: each chip as a tagged block. */
  submit(): string {
    const out = this.text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (_m, n) => `\n\n<pasted_content id="${ID}">\n${this.chips.get(Number(n))}\n</pasted_content id="${ID}">\n`);
    this.text = ''; this.cur = 0;
    return out;
  }
  screen(): string {
    if (!this.text) return idle;
    return idle.replace(/❯\s+Try "refactor <filepath>"/, `❯ ${this.text.split('\n').join('\n  ')}`);
  }
}

/** A TuiBrain whose pane is the Editor. At each Enter the prompt row is written as stored, and `turn`
 *  says what the session does then (the answer and its Stop marker by default). */
function rig(t: { after(fn: () => unknown): void }, opts: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'angelia-keymiss-rig-'));
  const cwd = join(root, 'km');
  mkdirSync(cwd);
  const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
  const brain = new TuiBrain(profile, { id: crypto.randomUUID(), started: true }, { bin: '/bin/false', quietMs: 300, quietTextMs: 700, quietOpenMs: 900, idlePollMs: 40, landMs: 1200, promptTimeoutMs: 4000, ...opts });
  const b = brain as any;
  mkdirSync(b.dir, { recursive: true });
  b.transcript = join(root, 'transcript.jsonl');
  writeFileSync(b.transcript, jsonl([ROW.prompt('an earlier message', Date.now() - 60_000), ROW.text('An earlier answer.'), ROW.over()]));
  const ed = new Editor();
  const logs: string[] = [], stored: string[] = [], keysSent: string[] = [];
  let buffer = '', enters = 0;
  const stop = (text: string) => execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: b.transcript, session_id: b.session.id, last_assistant_message: text }),
    env: { ...process.env, ANGELIA_TUI_MARKER: join(b.dir, 'turn.json') },
  });
  const rows = (...r: object[]) => appendFileSync(b.transcript, jsonl(r));
  const s = {
    ed, logs, stored, keysSent, stop, rows, brain,
    /** What the session does at Enter, with the prompt as stored. */
    turn: (prompt: string) => { rows(ROW.prompt(prompt), ROW.text('The answer.')); stop('The answer.'); },
    get enters() { return enters; },
    async say(text: string, flags?: { peer?: boolean }) {
      let result: any;
      for await (const e of brain.turn(text, flags)) if (e.kind === 'result') result = e;
      return result;
    },
  };
  b.on('log', (l: string) => logs.push(l));
  b.ready = Promise.resolve(null);
  b.up = true;
  b.capture = async () => ed.screen();
  b.sessionAlive = async () => true;
  b.tm = async (a: string[]) => {
    if (a[0] === 'load-buffer') buffer = readFileSync(a[a.length - 1], 'utf8');
    else if (a[0] === 'paste-buffer') ed.insert(buffer);
    else if (a[0] === 'send-keys') {
      for (const k of a.slice(3)) {
        keysSent.push(k);
        if (k === 'Enter') { const p = ed.submit(); if (p) { enters++; stored.push(p); s.turn(p); } }
        else ed.key(k);
      }
    }
    return { code: 0, out: '', err: '' };
  };
  t.after(() => brain.stop().catch(() => {}));
  return s;
}

describe('the input box held text before a paste: what Enter sends is the message alone', { concurrency: true }, () => {
  const cases: [string, (e: Editor) => void, string][] = [
    ['a line, the cursor at its start', (e) => { e.insert('half typed words'); e.key('C-a'); }, QUOTE_DOT],
    ['a chip, the cursor at its start', (e) => { e.insert(`${head}\n\nan earlier message\nthat was cut before its Enter`); e.key('C-a'); }, QUOTE_DOT],
    ['three lines, the cursor at the start of the middle one', (e) => { e.insert('one'); e.text += '\ntwo\nthree'; e.cur = 4; }, LIST],
    ['a line, the cursor at its end (as before)', (e) => { e.insert('half typed words'); }, `${POSTED}\n\n${QUOTE_DOT}`],
  ];
  for (const [name, leave, text] of cases) {
    test(name, { timeout: 15_000 }, async (t) => {
      const s = rig(t);
      leave(s.ed);
      const r = await s.say(text);
      assert.equal(r?.isError, false, JSON.stringify(r));
      assert.equal(r.text, 'The answer.', 'the turn ended by its own marker, with its answer');
      assert.equal(s.stored.length, 1);
      assert.equal(hookKey(s.stored[0]), promptKey(cleanText(text)), 'the hook\'s key of the stored prompt is the key of what was typed');
      assert.equal((s.brain as any).typedKey, hookKey(s.stored[0]));
      assert.ok(!s.logs.some((l) => l.startsWith(KEY_MISS_LINE) || l.startsWith(KEY_KEPT_LINE)), s.logs.join('\n'));
      assert.ok(s.logs.some((l) => /the input box held text before a paste; cleared: /.test(l)), s.logs.join('\n'));
    });
  }

  test('Ctrl-U alone, as before the fix, leaves a line whose cursor is at its start: the stub shows the miss it made', () => {
    const e = new Editor();
    e.insert('half typed words'); e.key('C-a');
    e.key('C-u');
    assert.equal(e.text, 'half typed words');
    e.insert(QUOTE_DOT);
    const p = e.submit();
    assert.notEqual(hookKey(p), promptKey(QUOTE_DOT));
    assert.match(p, new RegExp(`</pasted_content id="${ID}">\\n+half typed words$`), 'stored as 2.1.332 stored it live: the old line after the pasted block');
  });

  test('a box that cannot be cleared: no Enter is pressed, and the message goes back to the chat', { timeout: 20_000 }, async (t) => {
    const s = rig(t);
    s.ed.insert('half typed words'); s.ed.key('C-a');
    s.ed.stuck = true;
    // The paste still lands (tmux types it): only the keys do nothing.
    const insert = s.ed.insert.bind(s.ed);
    s.ed.insert = (x: string) => { s.ed.cur = 0; insert(x); };
    const r = await s.say(QUOTE_DOT);
    assert.equal(s.enters, 0, 'nothing was sent');
    assert.equal(r?.isError, true);
    assert.equal(r?.keep, true, 'the pane is kept');
    assert.ok(!s.keysSent.includes('Enter'), 'no Enter on a box that holds more than the message');
    assert.ok(s.logs.some((l) => /the input box held text before a paste; it did not change/.test(l)), s.logs.join('\n'));
    assert.ok(s.logs.some((l) => /the input box held other text with the pasted message \(attempt 1\)/.test(l)), s.logs.join('\n'));
  });
});

describe('a key miss: the line says what differs, and the net keeps an answer that is the message\'s', { concurrency: true }, () => {
  test('the stored prompt starts with the typed message and holds more: the answer is delivered, with a line', { timeout: 15_000 }, async (t) => {
    const s = rig(t);
    // Something added to the prompt after it left the box (no case known now; the shape the old leftover made).
    s.turn = (p) => { s.rows(ROW.prompt(`${p}\n\nhalf typed words`), ROW.text('The answer.')); s.stop('The answer.'); };
    const r = await s.say(QUOTE_DOT);
    assert.equal(r?.text, 'The answer.', s.logs.join('\n'));
    const line = s.logs.find((l) => l.startsWith(KEY_KEPT_LINE));
    assert.ok(line, s.logs.join('\n'));
    const typed = promptKey(QUOTE_DOT).slice(0, 8), stored = hookKey(`${s.stored[0]}\n\nhalf typed words`).slice(0, 8);
    assert.match(line!, new RegExp(`^${KEY_KEPT_LINE} prompts=1 chars=11 typed=${typed}/\\d+ hook=${stored}/\\d+ by=turn: `));
    assert.ok(!s.logs.some((l) => l.startsWith(KEY_MISS_LINE)));
    assert.ok(!line!.includes('half'), 'no words in the line');
  });

  /** The turn's prompt is stored as `other` makes it, with an answer not to be delivered; once its
   *  marker is dropped, the prompt as typed runs and answers. */
  const swapped = (s: ReturnType<typeof rig>, other: (p: string) => string) => (p: string) => {
    s.rows(ROW.prompt(other(p)), ROW.text('Not for the chat.'));
    s.stop('Not for the chat.');
    const b = s.brain as any;
    void until(() => { try { readFileSync(b.markerPath); return false; } catch { return true; } }, 10_000).then(() => { s.rows(ROW.prompt(p), ROW.text('The answer.')); s.stop('The answer.'); });
  };

  for (const [name, other] of [['before', (p: string) => `half typed words\n\n${p}`], ['after', (p: string) => `${p}\n\nhalf typed words`]] as const) {
    test(`a long message with leftover text ${name} it: delivered`, { timeout: 15_000 }, async (t) => {
      const s = rig(t);
      s.turn = (p) => { s.rows(ROW.prompt(other(p)), ROW.text('The answer.')); s.stop('The answer.'); };
      const r = await s.say(QUOTE_DOT);
      assert.equal(r?.text, 'The answer.', s.logs.join('\n'));
      assert.ok(s.logs.some((l) => l.startsWith(KEY_KEPT_LINE)), s.logs.join('\n'));
    });
  }

  const long = 'please read the report and tell me what it says';
  const dropped: [string, string, (p: string) => string, { peer?: boolean }?][] = [
    ['"ok" inside "look at the logs"', 'ok', () => 'look at the logs'],
    ['a short message at the start of another prompt', 'ok', () => 'ok, now look at the logs'],
    ['a peer\'s turn', long, (p) => `${p}\n\nhalf typed words`, { peer: true }],
    ['leftover text on both sides, the message in the middle', long, (p) => `half typed\n\n${p}\n\nwords`],
    ['leftover text inside the message', long, (p) => p.replace('report', 'report half typed words')],
  ];
  for (const [name, text, other, flags] of dropped) {
    test(`not delivered: ${name}`, { timeout: 15_000 }, async (t) => {
      const s = rig(t);
      s.turn = swapped(s, other);
      const r = await s.say(text, flags);
      assert.equal(r?.text, 'The answer.', s.logs.join('\n'));
      assert.ok(s.logs.some((l) => l.startsWith(KEY_MISS_LINE)), s.logs.join('\n'));
      assert.ok(!s.logs.some((l) => l.startsWith(KEY_KEPT_LINE)), s.logs.join('\n'));
    });
  }

  test('another prompt, written after the Enter (a person\'s): dropped as before, the line with both keys and lengths, and the turn waits for its own', { timeout: 15_000 }, async (t) => {
    const s = rig(t);
    s.turn = (p) => {
      s.rows(ROW.prompt('typed in the app'), ROW.text('For the app only.'));
      s.stop('For the app only.');
      const b = s.brain as any;
      void until(() => { try { readFileSync(b.markerPath); return false; } catch { return true; } }, 10_000).then(() => { s.rows(ROW.prompt(p), ROW.text('The answer.')); s.stop('The answer.'); });
    };
    const r = await s.say(QUOTE_DOT);
    assert.equal(r?.text, 'The answer.');
    const line = s.logs.find((l) => l.startsWith(KEY_MISS_LINE));
    assert.match(line ?? '', new RegExp(`^${KEY_MISS_LINE} prompts=1 chars=17 typed=${promptKey(QUOTE_DOT).slice(0, 8)}/${cleanText(QUOTE_DOT).replace(/\s+/g, ' ').trim().length} hook=${hookKey('typed in the app').slice(0, 8)}/16 by=turn pane=\\S+$`), s.logs.join('\n'));
    assert.ok(!s.logs.some((l) => l.startsWith(KEY_KEPT_LINE)));
  });

  test('a person\'s prompt that holds the message whole but was written before the Enter is never kept', async () => {
    const s = rig({ after: () => {} });
    const b = s.brain as any;
    const sentAt = Date.now();
    b.typedBy = 'turn'; b.typedForm = cleanText(QUOTE_DOT).replace(/\s+/g, ' ').trim(); b.from = 0;
    s.rows(ROW.prompt(`${QUOTE_DOT} and mine`, sentAt - 500));
    const m = { at: Date.now(), origin: 'prompt', prompts: 1, prompt_key: hookKey(`${QUOTE_DOT} and mine`), prompt_at: sentAt - 500 };
    assert.equal(b.keptOnMiss(m, sentAt), false, 'written before the Enter');
    assert.equal(b.keptOnMiss({ ...m, prompt_at: sentAt + 100 }, sentAt), true, 'the same, after it');
    b.typedBy = 'follow';
    assert.equal(b.keptOnMiss({ ...m, prompt_at: sentAt + 100 }, sentAt), false, 'never for a follow');
    await b.stop();
  });
});

describe('boxHoldsOnly: the message alone in the box', () => {
  const box = (inner: string) => idle.replace(/❯\s+Try "refactor <filepath>"/, `❯ ${inner}`);
  test('one chip, or the text as drawn (its > lines too); never a second chip or a line more', () => {
    assert.equal(boxHoldsOnly(box('[Pasted text #3 +6 lines]'), QUOTE_DOT), true);
    assert.equal(boxHoldsOnly(box('[Pasted text #3 +6 lines][Pasted text #2 +3 lines]'), QUOTE_DOT), false);
    assert.equal(boxHoldsOnly(box('[Pasted text #3 +6 lines]half typed words'), QUOTE_DOT), false);
    assert.equal(boxHoldsOnly(box('half typed words[Pasted text #3 +6 lines]'), QUOTE_DOT), false);
    const short = `${head}\n> quoted\nok`;
    assert.equal(boxHoldsOnly(box(short.split('\n').join('\n  ')), short), true, 'a > line drawn as the box draws it');
    assert.equal(boxHoldsOnly(box(`${short}\nmore`.split('\n').join('\n  ')), short), false);
    const emoji = `${head}\nthanks 👍🏽 and ❤️ שָׁלוֹם\nok`;
    assert.equal(boxHoldsOnly(box('[telegram dm 1001 · Owner (1001)]\n  thanks 👍 and ❤ שלום\n  ok'), emoji), true, 'an emoji or a mark the terminal draws another way');
  });
  test('a long text drawn with its middle cut', () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    assert.equal(boxHoldsOnly(box('line 0\n  line 1 [...Truncated text #2 +57 lines...]\n  line 59'), long), true);
    assert.equal(boxHoldsOnly(box('line 0\n  line 1 [...Truncated text #2 +57 lines...]\n  line 59 and more'), long), false);
    assert.equal(boxHoldsOnly(box('stray line 0 [...Truncated text #2 +57 lines...]\n  line 59'), long), false);
  });
});
