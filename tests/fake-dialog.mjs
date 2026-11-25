#!/usr/bin/env node
// Stands in for a claude pane that shows a permission dialog and nothing else: draws FAKE_FRAME, then
// writes each key that reaches it, as hex, one read per line, to FAKE_KEYS. So a test sees exactly
// which key Angelia pressed in the pane, and that none was pressed.
import { appendFileSync, readFileSync } from 'node:fs';

process.stdout.write(readFileSync(process.env.FAKE_FRAME, 'utf8'));
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (b) => appendFileSync(process.env.FAKE_KEYS, `${b.toString('hex')}\n`));
