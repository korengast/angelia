import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const frame = (name: string) => readFileSync(join(here, 'fixtures', `pane-${name}.txt`), 'utf8');

test('tmux mode: a turn typed in the Claude app while the chat\'s message waits is never posted as the chat\'s answer', { timeout: 30_000 }, async () => {
  // Own state dir before tui.js reads it at import, so nothing here can touch a live Angelia.
  process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-tuibusy-'));
  const { TuiBrain, BUSY_PANE_LINE } = await import('../src/brain/tui.js');
  const cwd = mkdtempSync(join(tmpdir(), 'angelia-tuibusy-cwd-'));
  const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
  const brain = new TuiBrain(profile, { id: '55555555-6666-7777-8888-999999999999', started: true }, { bin: '/bin/false' });
  const b = brain as any;
  b.ready = Promise.resolve(null);
  b.up = true;
  mkdirSync(b.dir, { recursive: true });
  const marker = (text: string) => writeFileSync(join(b.dir, 'turn.json'), JSON.stringify({ text, at: Date.now() }));
  // The pane: busy with the app's turn for three looks, which then ends with its own Stop marker;
  // idle; the pasted text lands; after Enter the chat's turn answers with a marker of its own.
  let looks = 0, entered = false;
  const landed = frame('idle').replace(/❯\s+Try "refactor <filepath>"/, '❯ [Pasted text #1 +2 lines]');
  b.capture = async () => {
    looks++;
    if (looks <= 3) return frame('busy');
    if (looks === 4) { marker('the app turn\'s answer'); return frame('idle'); }
    return entered ? frame('idle') : landed;
  };
  b.sessionAlive = async () => true;
  b.tm = async (a: string[]) => {
    if (a[0] === 'send-keys' && a.includes('Enter')) { entered = true; setTimeout(() => marker('the chat\'s answer'), 2000); }
    return { code: 0, out: '' };
  };
  const events = [];
  for await (const e of brain.turn('what is in this folder?')) events.push(e);
  assert.deepEqual(events[0], { kind: 'notice', text: BUSY_PANE_LINE });
  assert.deepEqual(events.at(-1), { kind: 'result', text: 'the chat\'s answer', isError: false });
  assert.ok(!events.some((e) => JSON.stringify(e).includes('the app turn')));
});
