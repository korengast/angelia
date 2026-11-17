#!/usr/bin/env node
// Stands in for claude 2.1.326 started with --add-dir: one "Adding a new directory" dialog per folder,
// "No, exit" preselected, and keys dropped until the dialog has had a second with no key (as the real
// one behaves: Down and Enter sent at once, or every 300 ms from the start, never get through). Down moves the cursor; Enter on yes goes to the next folder, then an idle prompt; Enter on
// no only shows a hint. It asks about the --add-dir folders, or about the one in ./adddir-ask.txt.
// With ./trust-first.txt it first shows the folder-trust dialog (which takes keys at once), and once
// that is answered its frame scrolls into tmux's history, where a capture still finds it above the
// add-dir dialog. With ./adddir-quoted.txt it asks nothing and shows the idle prompt under a resumed
// conversation that quotes the start dialogs. Every key it gets is logged to ./keys.log.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--version') { console.log('2.1.326 (Claude Code)'); process.exit(0); }
const here = dirname(fileURLToPath(import.meta.url));
const dirs = existsSync('adddir-quoted.txt') ? [] : existsSync('adddir-ask.txt') ? [readFileSync('adddir-ask.txt', 'utf8').trim()]
  : process.argv.flatMap((a, i) => (process.argv[i - 1] === '--add-dir' ? [a] : []));
let yes = false;
let hint = false;
let shownAt = 0;
// Redrawn in place, line by line, as Claude Code's screen is: a full clear would push the old frame
// into tmux's history, where a capture still finds it.
const frame = (text) => process.stdout.write(`\x1b[H${Array.from({ length: 49 }, (_, i) => `${text.split('\n')[i] ?? ''}\x1b[K`).join('\r\n')}`);
const draw = () => frame(` Adding a new directory:\n\n ${dirs[0]}\n\n This session hasn't worked here before. Is this a directory you created or one you trust?\n\n`
  + `${yes ? '  ' : ' ❯'} No, exit\n${yes ? ' ❯' : '  '} Yes, add it\n\n ${hint ? 'Esc to exit · To add it, press ↓ to Yes, then Enter' : 'Enter to confirm · Esc to cancel'}`);
const next = () => {
  if (!dirs.length) {
    const quoted = existsSync('adddir-quoted.txt') ? readFileSync('adddir-quoted.txt', 'utf8') : '';
    frame(quoted + readFileSync(join(here, 'fixtures', 'pane-idle.txt'), 'utf8').split('\n').filter((l) => l.trim()).join('\n'));
    return;
  }
  yes = false; hint = false; shownAt = Date.now(); draw();
};
let trust = existsSync('trust-first.txt') ? { yes: false } : null;
// Rows 21 on, so the answered frame lands in the last 40 lines of history once it scrolls off.
const drawTrust = () => frame(`${'\n'.repeat(20)} Accessing workspace:\n\n ${process.cwd()}\n\n Quick safety check: Is this a project you created or one you trust?\n\n`
  + `${trust.yes ? '  ' : ' ❯'} No, exit\n${trust.yes ? ' ❯' : '  '} Yes, I trust this folder\n\n Enter to confirm · Esc to cancel`);
if (trust) drawTrust(); else next();
process.stdin.setRawMode(true);
process.stdin.on('data', (b) => {
  appendFileSync('keys.log', `${JSON.stringify(b.toString())}\n`);
  if (trust) {
    const k = b.toString();
    if (k.includes('\x1b[B') || k.includes('\x1bOB')) { trust.yes = !trust.yes; drawTrust(); return; }
    if (k.includes('\r') && trust.yes) { trust = null; process.stdout.write(`\x1b[50;1H${'\n'.repeat(50)}`); next(); }
    return;
  }
  if (!dirs.length) return;
  if (Date.now() - shownAt < 1000) { shownAt = Date.now(); return; }
  const k = b.toString();
  if (k.includes('\x1b[B') || k.includes('\x1bOB')) { yes = !yes; draw(); return; }
  if (k.includes('\r')) {
    if (!yes) { hint = true; draw(); return; }
    dirs.shift();
    next();
  }
});
setTimeout(() => process.exit(0), 600_000);
