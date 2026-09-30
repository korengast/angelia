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
 * When nobody reads the chat (no turn from it, a turn sent to the background, a daemon that stopped)
 * or no answer comes, it steps aside and prints nothing: Claude opens its own dialog in the pane and
 * the Claude app, as in a terminal. With no marker in the environment the session belongs to whoever
 * started it by hand, and the hook does nothing at all.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const marker = process.env.ANGELIA_TUI_MARKER;
if (!marker) process.exit(0);

// The folder, the file names and STALE_MS are the daemon's too (src/brain/tui-permissions.ts);
// tests/tui-permissions.test.ts runs this script against it.
const dir = join(dirname(marker), 'permissions');
const STALE_MS = 30_000;
// After the daemon's own ten-minute deny, and inside Claude's timeout for this hook (hookSettings).
const GIVE_UP_MS = 11 * 60_000;

const live = () => {
  try { return Date.now() - Number(JSON.parse(readFileSync(join(dir, 'relay.json'), 'utf8')).at) < STALE_MS; } catch { return false; }
};

let payload = {};
try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
if (payload.hook_event_name !== 'PermissionRequest' || !live()) process.exit(0);

const id = randomUUID();
const request = join(dir, `${id}.request.json`);
const answer = join(dir, `${id}.answer.json`);
const leave = () => { rmSync(request, { force: true }); rmSync(answer, { force: true }); };
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { leave(); process.exit(0); });

try {
  writeFileSync(`${request}.tmp`, JSON.stringify({ id, tool_name: payload.tool_name ?? '', tool_input: payload.tool_input ?? {}, at: Date.now() }), { mode: 0o600 });
  renameSync(`${request}.tmp`, request);
} catch { process.exit(0); }

const started = Date.now();
function wait() {
  let said;
  try { said = JSON.parse(readFileSync(answer, 'utf8')); } catch { said = undefined; }
  if (said) {
    leave();
    const decision = said.allow === true ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from chat' };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
    return;
  }
  if (!live() || Date.now() - started > GIVE_UP_MS) { leave(); return; }
  setTimeout(wait, 250);
}
wait();
