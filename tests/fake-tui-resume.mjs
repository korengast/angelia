#!/usr/bin/env node
// Stands in for claude started with --resume on a long idle session: the "Resume this conversation?"
// dialog, then an idle prompt. As the add-dir dialog does, it drops keys until it has stood a second.
// ./resume-mode.txt: "esc" (default: the foot says Esc resumes, cursor on the new conversation),
// "enter" (no such hint, cursor on the new conversation), "stuck" (no hint, the cursor never moves) or
// "idle" (a prompt first; the idle form, "Esc to dismiss", opens when ./open-now appears). After the
// dialog, pasted text shows in the input box and Enter empties it.
// Every key it gets is logged to ./keys.log; the choice goes to ./choice.txt.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--version') { console.log('2.1.332 (Claude Code)'); process.exit(0); }
const here = dirname(fileURLToPath(import.meta.url));
const mode = existsSync('resume-mode.txt') ? readFileSync('resume-mode.txt', 'utf8').trim() : 'esc';
const frame = (text) => process.stdout.write(`\x1b[H${Array.from({ length: 49 }, (_, i) => `${text.split('\n')[i] ?? ''}\x1b[K`).join('\r\n')}`);
const prompt = (typed = '') => {
  const lines = readFileSync(join(here, 'fixtures', 'pane-idle.txt'), 'utf8').split('\n').filter((l) => l.trim());
  const at = lines.findLastIndex((l) => l.startsWith('❯'));
  if (typed) lines[at] = `❯ ${typed}`;
  else lines[at] = '❯ ';
  frame(lines.join('\n'));
};
let row = 1;
let open = mode !== 'idle';
let shownAt = Date.now();
const draw = () => frame(mode === 'idle' ? readFileSync(join(here, 'fixtures', 'pane-resume-idle.txt'), 'utf8')
  : ` Resume this conversation?\n\n This conversation has been inactive for 1h 15m and is 279.5k tokens long.\n\n`
  + ` ${row === 0 ? '❯' : ' '} 1. Resume\n ${row === 1 ? '❯' : ' '} 2. Start a new conversation\n\n Enter to confirm${mode === 'esc' ? ' · Esc to resume' : ''}`);
const close = (choice) => {
  open = false;
  writeFileSync('choice.txt', choice);
  prompt();
};
if (open) draw(); else prompt();
setInterval(() => {
  if (!existsSync('open-now')) return;
  rmSync('open-now');
  open = true;
  shownAt = Date.now();
  draw();
}, 100);
process.stdin.setRawMode(true);
process.stdin.on('data', (b) => {
  const k = b.toString();
  appendFileSync('keys.log', `${JSON.stringify(k)}\n`);
  if (!open) {
    if (k === '\r' || k.includes('\x0b')) prompt();
    else if (!k.startsWith('\x1b') || k.startsWith('\x1b[200~')) prompt(k.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', ''));
    return;
  }
  if (Date.now() - shownAt < 1000) return;
  if (k === '\x1b') { if (mode === 'esc' || mode === 'idle') close('resume'); return; }
  if (k === '\x1b[A' || k === '\x1bOA') { if (mode !== 'stuck') { row = 0; draw(); } return; }
  if (k.includes('\r')) close(row === 0 ? 'resume' : 'new');
});
setTimeout(() => process.exit(0), 600_000);
