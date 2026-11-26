#!/usr/bin/env node
/**
 * Claude Code Stop hook for Angelia's tui-mode sessions. No model, no network, always exit 0:
 * a hook that throws would freeze the agent.
 *
 * At the end of every turn Claude hands this script a JSON payload on stdin. It writes the turn's
 * final answer to the file named by ANGELIA_TUI_MARKER, and the daemon — which is polling that
 * file — delivers it to the chat. Unlike the gateway this replaces, the hook itself sends nothing:
 * delivery, chunking and the session map stay in one place.
 *
 * The marker also says what started the turn (turn-origin.mjs): `origin`, `origin_why`, `prompt_at`,
 * `prompt_key`, `prompts`, `origin_ids`. The daemon reads those for a turn it did not type itself: the
 * end of a background task that a turn of the chat started wakes the agent, and its answer reaches the
 * chat; a turn a person typed in the Claude app never does.
 *
 * With no marker in the environment the session belongs to whoever started it by hand, so the
 * hook does nothing at all.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rowShapes, turnOrigin } from './turn-origin.mjs';

const marker = process.env.ANGELIA_TUI_MARKER;
if (!marker) process.exit(0);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let payload = {};
try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { payload = {}; }
if ((payload.hook_event_name ?? 'Stop') !== 'Stop') process.exit(0);

/** The turn's answer: assistant text written after the last tool call or user message. Text that a
 *  tool call follows is a progress line, not the answer, and the daemon already showed it. */
function finalText(path) {
  let trailing = [];
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return ''; }
  for (const line of raw.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const content = row?.message?.content;
    if (row.type === 'user') trailing = [];
    else if (row.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && String(b.text ?? '').trim()) trailing.push(String(b.text).trim());
        else if (b?.type === 'tool_use') trailing = [];
      }
    }
  }
  return trailing.join('\n\n').trim();
}

const transcript = String(payload.transcript_path ?? '');
let text = String(payload.last_assistant_message ?? '').trim();
// Stop can fire a beat before the last row is flushed to the transcript.
for (let i = 0; i < 40 && !text && transcript; i++) {
  text = finalText(transcript);
  if (!text) sleep(250);
}

const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

try {
  // What started the turn, for the daemon's reader between turns. A transcript that cannot be read
  // or parsed says `unknown`, which is never delivered; the marker is written either way.
  let origin = { origin: 'unknown', origin_why: 'no transcript' };
  try { if (transcript) origin = turnOrigin(read(transcript)); } catch { origin = { origin: 'unknown', origin_why: 'the transcript could not be read' }; }
  // For measuring a new Claude Code: the shape of the last rows, names and flags only (rowShapes).
  if (process.env.ANGELIA_TUI_ORIGIN_DEBUG && transcript) { try { origin = { ...origin, origin_rows: process.env.ANGELIA_TUI_ORIGIN_DEBUG === 'keys' ? rowShapes(read(transcript), 40, { keys: true }) : rowShapes(read(transcript)) }; } catch { /* a measurement only */ } }
  // Written whole, then moved into place: the daemon reads this file between turns too, at any moment.
  writeFileSync(`${marker}.tmp`, JSON.stringify({ text, transcript_path: transcript, session_id: payload.session_id ?? '', at: Date.now(), ...origin }));
  renameSync(`${marker}.tmp`, marker);
} catch { /* the daemon falls back to its own timeout */ }
process.exit(0);
