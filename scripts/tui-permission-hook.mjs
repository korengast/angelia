#!/usr/bin/env node
/**
 * Claude Code PermissionRequest hook for Angelia's tui-mode sessions. No model, no network, always
 * exit 0.
 *
 * Claude runs it when it is about to ask for a permission, with the request itself on stdin: the tool
 * and its exact input. While the daemon reads a chat's turn in this pane, the hook writes that request
 * into the pane's private folder, waits for the owner's answer under the same id, and hands it back to
 * Claude as the decision. So the chat approves the request Claude made, never a dialog read off the
 * screen, where a command can draw anything, and an answer reaches no request but its own.
 *
 * Every request says what started the turn that asks, read from the transcript as the Stop hook reads
 * it (turn-origin.mjs): a chat turn's reader keeps only its own turn's requests. Between the chat's
 * turns, while the daemon holds the pane, its heartbeat says so (`idle`), and the daemon decides by it. A turn the agent started by itself (a background task's
 * end, a teammate's or another session's message, a scheduled prompt) goes the profile's way, as a
 * chat turn does; for a turn a person typed in the Claude app or the pane the daemon says `pass`, and
 * the hook steps aside.
 *
 * When nobody reads the chat (the daemon let go of the pane, a turn sent to the background), a daemon that stopped
 * does not come back within a minute (a restart comes back sooner, and adopts the turn), or no answer
 * comes, it steps aside and prints nothing: Claude opens its own dialog in the pane and
 * the Claude app, as in a terminal. With no marker in the environment the session belongs to whoever
 * started it by hand, and the hook does nothing at all.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requestOrigin } from './turn-origin.mjs';

const marker = process.env.ANGELIA_TUI_MARKER;
if (!marker) process.exit(0);

// First of all, a mark that a permission is being asked, kept until this hook ends: Claude Code draws
// its dialog while this hook runs, and the daemon presses no Enter for a message typed into the turn
// while the mark is there (src/brain/tui.ts, pretoolBusy; a mark of a hook that died is known by its pid).
const asking = join(dirname(marker), 'pretool', `${process.pid}.perm`);
try {
  mkdirSync(dirname(asking), { recursive: true, mode: 0o700 });
  writeFileSync(asking, String(Date.now()), { mode: 0o600 });
  process.on('exit', () => { try { rmSync(asking, { force: true }); } catch { /* gone */ } });
} catch { /* the daemon's other checks stand */ }

// The folder, the file names and STALE_MS are the daemon's too (src/brain/tui-permissions.ts);
// tests/tui-permissions.test.ts runs this script against it.
const dir = join(dirname(marker), 'permissions');
const STALE_MS = 30_000;
// After the daemon's own ten-minute deny, and with RESTART_WAIT_MS inside Claude's timeout for this
// hook (hookSettings, 900 s).
const GIVE_UP_MS = 11 * 60_000;

// A heartbeat that grew old is a daemon that stopped without a word: a restart in progress (the old one
// leaves the file as it is, src/brain/tui.ts release), or a crash. The new daemon adopts the turn and
// beats again within seconds, so the hook waits this long for that before it steps aside: a restart
// never leaves a dialog in the pane that nobody can answer from the chat. No file at all is a daemon
// that said nobody reads the chat (the turn ended): it steps aside at once. The environment override is
// for the tests only; Claude's own environment is the pane's, which the agent cannot change.
const RESTART_WAIT_MS = Number(process.env.ANGELIA_RELAY_RESTART_WAIT_MS) || 60_000;

/** 'live', 'stale' (a beat too old, or a file that cannot be read now) or 'gone' (no file). */
const relay = () => {
  let at;
  try {
    const beat = JSON.parse(readFileSync(join(dir, 'relay.json'), 'utf8'));
    at = Number(beat.at);
  } catch (e) { return e?.code === 'ENOENT' ? 'gone' : 'stale'; }
  return Date.now() - at < STALE_MS ? 'live' : 'stale';
};
let staleSince = 0;
/** False once the hook is to step aside: nobody reads the chat, or the beat stayed old RESTART_WAIT_MS. */
const reading = () => {
  const s = relay();
  if (s === 'live') { staleSince = 0; return true; }
  if (s === 'gone') return false;
  if (!staleSince) staleSince = Date.now();
  return Date.now() - staleSince <= RESTART_WAIT_MS;
};
const live = () => relay() === 'live';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let payload = {};
try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
if (payload.hook_event_name !== 'PermissionRequest') process.exit(0);
// Not read now: wait for a daemon that comes back, or step aside.
while (!live()) {
  if (!reading()) process.exit(0);
  await sleep(250);
}

const id = randomUUID();
const request = join(dir, `${id}.request.json`);
const answer = join(dir, `${id}.answer.json`);
const leave = () => { rmSync(request, { force: true }); rmSync(answer, { force: true }); };
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { leave(); process.exit(0); });

/** What started the turn that asks, on every request: between turns, for the daemon to tell a turn
 *  the agent started by itself from one a person typed, and to tie it to the chat's own work (the task
 *  ids and teammate names, as the Stop hook gives them); while a chat turn is read, for the daemon to
 *  tell that turn's requests from those of a turn that runs before it (a task's end or a message
 *  Claude Code queued first) or was written under the last idle beat. Fixed words, ids, names, keys,
 *  a time and a count only, never the conversation. A transcript that cannot be read says `unknown`. */
function originNow() {
  const transcript = String(payload.transcript_path ?? '');
  try {
    return transcript ? requestOrigin(readFileSync(transcript, 'utf8')) : { origin: 'unknown', origin_why: 'no transcript' };
  } catch { return { origin: 'unknown', origin_why: 'the transcript could not be read' }; }
}

try {
  writeFileSync(`${request}.tmp`, JSON.stringify({ id, tool_name: payload.tool_name ?? '', tool_input: payload.tool_input ?? {}, at: Date.now(), origin: originNow() }), { mode: 0o600 });
  renameSync(`${request}.tmp`, request);
} catch { process.exit(0); }

const started = Date.now();
function wait() {
  let said;
  try { said = JSON.parse(readFileSync(answer, 'utf8')); } catch { said = undefined; }
  if (said) {
    leave();
    // Not the chat's to answer (a turn a person typed, between the chat's turns): Claude asks in its own dialog.
    if (said.pass === true) return;
    // The daemon names the refusal only for a profile that refuses without asking (permission_prompts: deny).
    const why = typeof said.message === 'string' && said.message ? said.message.slice(0, 500) : 'Denied from chat';
    const decision = said.allow === true ? { behavior: 'allow' } : { behavior: 'deny', message: why };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
    return;
  }
  // A restart keeps the request: the new daemon finds it in the folder and offers it to the chat again.
  if (!reading() || Date.now() - started > GIVE_UP_MS) { leave(); return; }
  setTimeout(wait, 250);
}
wait();
