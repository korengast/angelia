#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for Angelia's tui-mode sessions. No model, no network, no decision:
 * it never prints, so Claude goes on exactly as without it, and it always exits 0.
 *
 * It is the other half of a lock (src/brain/tui.ts, absorb). Claude Code draws its permission dialog
 * while the PermissionRequest hook runs, and an Enter typed then answers it with its first choice,
 * "Yes". The PermissionRequest of a call always comes after that call's PreToolUse (measured on claude
 * 2.1.332: about 0.1 s after it ends, for the session's own calls and a subagent's alike), and while a
 * PreToolUse hook runs no dialog is drawn. So:
 *
 * - this hook writes a mark of its own in `pretool/` (its pid) first thing, then waits while
 *   `absorb.lock` is there (fresh: at most LOCK_STALE_MS old; a lock left by a daemon that died holds
 *   nothing), then writes when it ended (`pretool/last.json`) and takes its mark away;
 * - the daemon, before it presses Enter for a chat message typed into a running turn, writes the lock
 *   first, then looks for a mark of a hook still alive or a PreToolUse that ended a moment ago, and
 *   presses Enter only when there is neither; it takes the lock away once Claude Code took the message.
 *
 * Both write before they read, so one of them always sees the other. The payload on stdin is not
 * read: nothing in it is needed, and a stdin left open must not hold the call. The wait is a timer,
 * so a signal ends the hook at once and its mark goes with it (a mark of a hook that died anyway is
 * known by its pid). With no marker in the environment the session belongs to whoever started it by
 * hand, and the hook does nothing at all.
 */
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const marker = process.env.ANGELIA_TUI_MARKER;
if (!marker) process.exit(0);

// The names and LOCK_STALE_MS are the daemon's too (src/brain/tui.ts); tests/tui-midturn-review.test.ts runs this script.
const base = dirname(marker);
const dir = join(base, 'pretool');
const lock = join(base, 'absorb.lock');
const LOCK_STALE_MS = 8000;
/** Longest wait, inside Claude's timeout for this hook (hookSettings). */
const WAIT_MAX_MS = 15_000;

const mine = join(dir, `${process.pid}.in`);
const leave = () => { try { rmSync(mine, { force: true }); } catch { /* gone */ } };
process.on('exit', leave);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0));

try {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(mine, String(Date.now()), { mode: 0o600 });
} catch { process.exit(0); }

const held = () => { try { return Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS; } catch { return false; } };
const until = Date.now() + WAIT_MAX_MS;
const done = () => {
  try {
    writeFileSync(join(dir, `last.json.${process.pid}`), JSON.stringify({ at: Date.now() }), { mode: 0o600 });
    renameSync(join(dir, `last.json.${process.pid}`), join(dir, 'last.json'));
  } catch { /* the daemon then waits for the next one */ }
  process.exit(0);
};
const tick = () => { if (held() && Date.now() < until) setTimeout(tick, 25); else done(); };
tick();
