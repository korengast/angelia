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
 * With no marker in the environment the session belongs to whoever started it by hand, so the
 * hook does nothing at all.
 */
import { readFileSync, writeFileSync } from 'node:fs';

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

try {
  writeFileSync(marker, JSON.stringify({ text, transcript_path: transcript, session_id: payload.session_id ?? '', at: Date.now() }));
} catch { /* the daemon falls back to its own timeout */ }
process.exit(0);
