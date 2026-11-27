import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { drawnPaste, idleWith } from './tui-stub.js';

const here = dirname(fileURLToPath(import.meta.url));
const frame = (name: string) => readFileSync(join(here, 'fixtures', `pane-${name}.txt`), 'utf8');
/** The busy pane with its spinner clock at `n` seconds: a working CLI redraws it every second. */
const busyAt = (n: number) => frame('busy').replace('✽ Actioning…', `✽ Actioning… (${n}s)`);

// Own state dir before tui.js reads it at import, so nothing here can touch a live Angelia.
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-tuinottyped-'));

async function brainWith(opts: Record<string, unknown> = {}) {
  const { TuiBrain } = await import('../src/brain/tui.js');
  const cwd = mkdtempSync(join(tmpdir(), 'angelia-tuinottyped-cwd-'));
  const profile = Config.parse({ profiles: { x: { cwd, tui: true } }, routes: [] }).profiles.x;
  const brain = new TuiBrain(profile, { id: '12121212-3434-5656-7878-909090909090', started: true }, { bin: '/bin/false', promptTimeoutMs: 1500, ...opts });
  const b = brain as any;
  b.ready = Promise.resolve(null);
  b.up = true;
  mkdirSync(b.dir, { recursive: true });
  const keys: string[][] = [];
  b.sessionAlive = async () => true;
  b.tm = async (a: string[]) => { keys.push(a); return { code: 0, out: '' }; };
  return { brain, b, keys, dir: b.dir as string };
}

async function run(brain: { turn(t: string): AsyncGenerator<unknown> }, text = 'hello') {
  const events: any[] = [];
  for await (const e of brain.turn(text)) events.push(e);
  return events;
}

test('tmux mode: a pane busy with work of its own past the prompt wait gives the message back, and says to keep the session', { timeout: 15_000 }, async () => {
  const { brain, b, keys } = await brainWith();
  let n = 0;
  b.capture = async () => busyAt(n++);
  const events = await run(brain);
  const r = events.at(-1);
  assert.equal(r.kind, 'result');
  assert.equal(r.isError, true);
  assert.equal(r.keep, true, 'a live pane that works is kept');
  assert.match(r.reason, /busy/);
  assert.ok(!keys.some((a) => a[0] === 'kill-session'), 'the pane is not ended');
  assert.ok(!keys.some((a) => a[0] === 'paste-buffer'), 'nothing typed into a busy pane');
  assert.equal(brain.alive, true);
});

test('tmux mode: a permission dialog that holds the pane past the wait: kept, and the reason names the dialog; no key reaches it', { timeout: 15_000 }, async () => {
  const { brain, b, keys } = await brainWith();
  b.capture = async () => frame('permission');
  const events = await run(brain);
  const r = events.at(-1);
  assert.equal(r.keep, true);
  assert.match(r.reason, /dialog/);
  assert.ok(!keys.some((a) => a[0] === 'send-keys' || a[0] === 'paste-buffer'), 'no key typed into the dialog');
});

test('tmux mode: a screen with no input box that is not a permission dialog (a stuck login or menu) is not kept, even moving, even with background work (L5)', { timeout: 15_000 }, async () => {
  const { brain, b } = await brainWith();
  let n = 0;
  b.capture = async () => `Select login method:\n\n ❯ 1. Claude account with subscription\n   2. Anthropic Console account\n\n Waiting ${n++}s…\n`;
  b.ours.add('toolu_bg1');
  const r = (await run(brain)).at(-1);
  assert.equal(r.kind, 'result');
  assert.equal(r.isError, true);
  assert.notEqual(r.keep, true, 'ended, to start fresh');
});

test('tmux mode: a frozen pane where a turn of this chat started background work is kept too: its agents may still run', { timeout: 15_000 }, async () => {
  const { brain, b } = await brainWith();
  b.capture = async () => frame('busy');
  // A turn of this chat started a background agent in the pane.
  b.ours.add('toolu_bg1');
  const r = (await run(brain)).at(-1);
  assert.equal(r.keep, true);
});

test('tmux mode: a frozen pane with nothing open and no dialog is not kept (a hung CLI gets a fresh pane, as before)', { timeout: 15_000 }, async () => {
  const { brain, b } = await brainWith();
  b.capture = async () => frame('busy');
  const r = (await run(brain)).at(-1);
  assert.equal(r.kind, 'result');
  assert.equal(r.isError, true);
  assert.notEqual(r.keep, true);
});

test('tmux mode: a pane whose process is gone is an exit, never kept', { timeout: 15_000 }, async () => {
  const { brain, b } = await brainWith();
  b.capture = async () => '';
  b.sessionAlive = async () => { b.up = false; return false; };
  const r = (await run(brain)).at(-1);
  assert.deepEqual(r, { kind: 'result', text: '', isError: true, reason: 'exit' });
});

test('tmux mode: a paste that never shows in the box is tried again, and the turn goes on when the second one lands', { timeout: 15_000 }, async () => {
  const { brain, b, keys, dir } = await brainWith({ landMs: 600 });
  const landed = idleWith(drawnPaste('line one\nline two\nline three'));
  let pastes = 0, entered = false;
  b.capture = async () => (pastes >= 2 && !entered ? landed : frame('idle'));
  b.tm = async (a: string[]) => {
    keys.push(a);
    if (a[0] === 'paste-buffer') pastes++;
    if (a[0] === 'send-keys' && a.includes('Enter')) {
      entered = true;
      writeFileSync(join(dir, 'turn.json'), JSON.stringify({ text: 'the answer', at: Date.now() + 1 }));
    }
    return { code: 0, out: '' };
  };
  const events = await run(brain, 'line one\nline two\nline three');
  assert.equal(pastes, 2, 'pasted once more after the first never showed');
  assert.deepEqual(events.at(-1), { kind: 'result', text: 'the answer', isError: false });
});
