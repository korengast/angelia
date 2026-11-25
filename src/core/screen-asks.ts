import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PERMISSION_MARKER, paneHasBox, permissionDialog, tmux, TMUX_SOCKET } from '../brain/tmux.js';
import { redactLog } from '../daemon/redact.js';

/**
 * A permission dialog open in a chat's tmux pane that no request from the permission hook accounts
 * for: the hook stepped aside (a daemon that stopped and did not come back in time, a hook that gave up),
 * or Claude asks something the hook never sees. Nobody in the chat knew of it: the turn failed after
 * ten minutes and the next messages bounced, "a dialog is open" (2026-11-25). Now the chat hears of it
 * once the dialog has stood ORPHAN_MS with no hook request beside it, while no turn of the chat is
 * being read (a turn's own reader says so itself, tui.ts screenOnlyLine).
 *
 * Only an alarm. Only the screen says what such a dialog asks, and a command can draw anything there
 * (a dialog of its own above the real one, a command cut to what fits), so the chat is never asked to
 * answer it and no key is pressed: it is answered in the Claude app or in the pane.
 */
export const ORPHAN_MS = 20_000;
/** How often the daemon reads the panes for such a dialog. */
export const SCAN_MS = 10_000;
/** The most of the tool and of the command line the chat is shown. */
const TOOL_MAX = 40;
const PREVIEW_MAX = 160;

/** A chat's pane: its tmux name and its private folder (brain/tui.ts, `dir`). */
export interface DialogPane { key: string; name: string; dir?: string }
export interface ScreenAlarm { key: string; name: string; tool: string; preview: string; at: number }

export function screenAlarmLine(a: Pick<ScreenAlarm, 'name' | 'tool' | 'preview'>, socket = TMUX_SOCKET): string {
  return `A permission dialog waits in this chat's session and did not come through the chat (${shown(a.tool, TOOL_MAX)}: ${shown(a.preview, PREVIEW_MAX)}, as the screen draws it). The chat cannot answer it: answer it in the Claude app, or in the pane (tmux -L ${socket} attach -t ${a.name}); /stop ends the turn.`;
}

/** Short, and with anything shaped like a credential masked: the line goes to a chat. */
function shown(text: string, max: number): string {
  const p = redactLog(text);
  return p.length > max ? `${p.slice(0, max - 1)}…` : p;
}

/** The pane's private folder, as TuiBrain makes it (with no stateDir of its own). */
export function paneDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.ANGELIA_STATE_DIR ?? join(homedir(), '.angelia'), 'tui', name);
}

/** A hook waits on a request of this pane: the dialog is the relay's, not an orphan. */
function hookWaiting(dir: string): boolean {
  try { return readdirSync(join(dir, 'permissions')).some((n) => n.endsWith('.request.json')); } catch { return false; }
}

/**
 * The dialog the pane has open now, or null. Stricter than permissionDialog: no input box on the
 * screen (an agent's answer that quotes or ends with the question sits above the box), the option rows
 * right under the question, and nothing after them but option rows and the dialog's own foot, so the
 * question is the last thing drawn.
 */
export function openDialog(pane: string): { tool: string; preview: string } | null {
  if (paneHasBox(pane)) return null;
  const d = permissionDialog(pane);
  if (!d) return null;
  const lines = pane.replace(/\n+$/, '').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(PERMISSION_MARKER)) { at = i; break; }
  if (at < 0 || !/^\s*❯\s*1\.\s*\S/.test(lines[at + 1] ?? '')) return null;
  const option = /^\s*(❯\s*)?\d+\.\s/;
  const foot = /^\s*(Esc to cancel|Tab to amend|ctrl\+e to explain)|^\s*$/i;
  for (const l of lines.slice(at + 2)) if (!option.test(l) && !foot.test(l)) return null;
  return d;
}

export interface ScreenAsksHost {
  /** Every chat pane to look at now. */
  panes(): DialogPane[];
  /** Tell the chat of a dialog (screenAlarmLine). Rejects when the line did not go out. */
  tell(a: ScreenAlarm): Promise<void>;
  log(line: string): void;
  /** The tmux server's environment (never an agent's). */
  env(): NodeJS.ProcessEnv;
  socket?: string;
  now?: () => number;
  orphanMs?: number;
}

export class ScreenAsks {
  /** The dialog each pane showed at the last look, and since when. */
  private seen = new Map<string, { dialog: string; since: number }>();
  /** The dialog each pane's chat was told of, by pane: told once while it stays open. */
  private told = new Map<string, string>();
  private scanning = false;

  constructor(private readonly h: ScreenAsksHost) {}

  private async capture(name: string): Promise<string | null> {
    const r = await tmux(['capture-pane', '-p', '-t', name, '-S', '-30'], { env: this.h.env(), ...(this.h.socket ? { socket: this.h.socket } : {}) });
    return r.code === 0 ? r.out : null;
  }

  /** One look at every pane. A dialog that stood ORPHAN_MS with no hook request beside it is told, once;
   *  a line that could not be posted is tried again at the next look. */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const now = this.h.now?.() ?? Date.now();
      const looked = new Set<string>();
      for (const p of this.h.panes()) {
        looked.add(p.name);
        const pane = await this.capture(p.name);
        const d = pane === null ? null : openDialog(pane);
        const sig = d ? `${d.tool}\n${d.preview}` : null;
        // Answered in the pane or the app, or another dialog now: told of no longer.
        if (this.told.get(p.name) !== sig) this.told.delete(p.name);
        if (!d || !sig || hookWaiting(p.dir ?? paneDir(p.name))) { this.seen.delete(p.name); continue; }
        const s = this.seen.get(p.name);
        if (!s || s.dialog !== sig) { this.seen.set(p.name, { dialog: sig, since: now }); continue; }
        if (now - s.since < (this.h.orphanMs ?? ORPHAN_MS) || this.told.has(p.name)) continue;
        try {
          await this.h.tell({ key: p.key, name: p.name, tool: d.tool, preview: d.preview, at: now });
          this.told.set(p.name, sig);
          this.h.log(`permission dialog with no relay key=${p.key} pane=${p.name} open ${Math.round((now - s.since) / 1000)} s: told to the chat`);
        } catch (e) { this.h.log(`permission dialog line failed key=${p.key} ${(e as Error).message}`); }
      }
      for (const n of this.seen.keys()) if (!looked.has(n)) this.seen.delete(n);
      for (const n of this.told.keys()) if (!looked.has(n)) this.told.delete(n);
    } finally { this.scanning = false; }
  }
}
