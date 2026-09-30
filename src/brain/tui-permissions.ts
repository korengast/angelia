import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEvent } from '../core/types.js';
import { permissionPreview } from './brain.js';

/**
 * How a tmux-mode permission request reaches the chat: through Claude Code's PermissionRequest hook
 * (scripts/tui-permission-hook.mjs), never off the screen. The hook writes the request Claude made, its
 * tool and exact input, into the pane's private folder and waits; the daemon relays it to the chat and
 * writes the owner's answer beside it under the same id; the hook hands that to Claude as the decision.
 * A dialog on the screen is text a command can shape (a line of `─` in a command reads as the dialog's
 * top edge), and a key press answers whichever dialog is open by then; neither is used to approve.
 *
 * The hook relays only while a turn from the chat is being read, which `beat` says on every poll.
 * Otherwise it steps aside at once, and Claude opens its own dialog in the pane and the Claude app.
 */

/** A heartbeat older than this means nobody reads the chat. The hook has the same number. Only a
 *  daemon that died leaves one to go stale (every other end of a turn removes it at once), so this is
 *  how long a hook waits after a crash, and how long a stalled daemon may stall. */
export const RELAY_STALE_MS = 30_000;
/** How often the heartbeat is written while a turn is read from the chat: on a timer of its own, so a
 *  reader waiting on a slow chat send does not look like a daemon that stopped. */
export const RELAY_BEAT_MS = 1000;
/** How long a dialog must stay on the pane, with no request from the hook, before the chat hears of it. */
export const SCREEN_ONLY_MS = 1500;

const REQUEST = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.request\.json$/;

export interface RelayedRequest { id: string; tool: string; input: unknown }

export class PermissionRelay {
  /** Given to the chat and not answered from it. */
  private open = new Set<string>();
  private seen = new Set<string>();

  constructor(readonly dir: string) {}

  /** An empty folder at each launch: nothing an earlier pane left is taken for a request. */
  reset(): void {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.open.clear();
    this.seen.clear();
  }

  /** While a turn is read from the chat, every RELAY_BEAT_MS. */
  beat(now = Date.now()): void { this.put('relay.json', { at: now }); }

  /** Nobody reads the chat now: a hook waiting, or asking next, lets Claude open its own dialog. */
  quiet(): void { rmSync(join(this.dir, 'relay.json'), { force: true }); }

  /** Requests the hook wrote since the last call, oldest first. */
  take(): RelayedRequest[] {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return []; }
    const present = new Set(names);
    for (const id of this.seen) if (!present.has(`${id}.request.json`)) this.seen.delete(id);
    const out: (RelayedRequest & { at: number })[] = [];
    for (const name of names) {
      const id = REQUEST.exec(name)?.[1];
      if (!id || this.seen.has(id)) continue;
      let row: { tool_name?: unknown; tool_input?: unknown; at?: unknown };
      try { row = JSON.parse(readFileSync(join(this.dir, name), 'utf8')); } catch { continue; }
      this.seen.add(id);
      this.open.add(id);
      out.push({ id, tool: typeof row.tool_name === 'string' && row.tool_name ? row.tool_name : '?', input: row.tool_input, at: Number(row.at) || 0 });
    }
    return out.sort((a, b) => a.at - b.at).map(({ id, tool, input }) => ({ id, tool, input }));
  }

  /** Requests given to the chat whose hook no longer waits: answered in the pane or the app, or it stepped aside. */
  gone(): string[] {
    const out = [...this.open].filter((id) => !existsSync(join(this.dir, `${id}.request.json`)));
    for (const id of out) this.open.delete(id);
    return out;
  }

  /** The owner's answer, for the hook waiting on this request and no other. False when no hook waits
   *  for it any more, though the last poll had not seen it go: nothing is left behind for nobody. */
  answer(id: string, allow: boolean): boolean {
    if (!this.open.delete(id)) return false;
    const request = join(this.dir, `${id}.request.json`);
    if (!existsSync(request)) return false;
    this.put(`${id}.answer.json`, { allow });
    // The hook can step aside between the check and the write; then its answer file goes too.
    if (existsSync(request)) return true;
    rmSync(join(this.dir, `${id}.answer.json`), { force: true });
    return false;
  }

  private put(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, join(this.dir, name));
  }
}

/** The chat's view of a request: its tool and its whole input, cut the way print mode cuts it. */
export function relayedPermission(r: RelayedRequest): Extract<BrainEvent, { kind: 'permission' }> {
  return { kind: 'permission', id: r.id, tool: r.tool, ...permissionPreview(r.input) };
}

/**
 * A permission dialog on the pane that no request from the hook accounts for, such as one left open
 * while nobody read the chat. Only the screen says what it asks, so the chat is told that it is open and
 * where to answer it, and is never asked to. Once per dialog, after it has stayed up SCREEN_ONLY_MS with
 * the hook quiet: the hook's request can land a poll after its dialog.
 */
export class ScreenDialogs {
  private asked: string | null = null;
  private since = 0;
  private told = false;

  /** `dialog`: what the pane shows, or null. `hookBusy`: a relayed request is open, or was a moment
   *  ago. True when the chat is to be told now. */
  see(dialog: string | null, hookBusy: boolean, now = Date.now()): boolean {
    if (dialog !== this.asked) { this.asked = dialog; this.since = now; this.told = false; }
    if (!dialog || this.told) return false;
    if (hookBusy) { this.since = now; return false; }
    if (now - this.since < SCREEN_ONLY_MS) return false;
    return (this.told = true);
  }
}
