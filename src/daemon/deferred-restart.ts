/**
 * `angelia restart` run by a chat's own agent, inside its turn. Stopping the daemon then would cut the
 * very turn that asked: its answer never reaches the chat, and in tmux mode its next tool call met a
 * permission dialog nobody could answer (2026-11-25). So the command asks the daemon over its API, with
 * the agent's own token (`POST /restart-after-turn`): the daemon names the chat by the token, never by
 * what the caller says, and holds the restart only while that chat has a turn running. It restarts once
 * that turn is over, after waiting up to OTHERS_WAIT_MS for the turns of other chats. With no turn
 * running there, the command goes the old way (refused unless --force). An owner's /restart and a
 * terminal `angelia restart` restart at once, as before.
 *
 * The request lives in the daemon's memory only: a daemon that stops for any other reason has done
 * what was asked, and the next one knows nothing of it.
 */
export const DEFERRED_LINE = 'Angelia restarts when this turn ends.';
/** Said in the chat right before the deferred restart goes. */
export const DEFERRED_GO_LINE = 'Restarting Angelia now, as this chat\'s agent asked.';
/** How long the restart waits for other chats' turns once the asking chat's turn is over. */
export const OTHERS_WAIT_MS = 10 * 60_000;

export interface DeferredHost {
  /** The chats with a turn running now. */
  running(): string[];
  /** Turns running and waiting for a chat, held messages included (KeyedQueue.queued). */
  queued?(key: string): number;
  /** Restart now, for this chat (launchChatRestart: the chat hears when the daemon is back). */
  launch(key: string): void;
  log(line: string): void;
  now?: () => number;
  othersWaitMs?: number;
}

/** One request; when its own chat's turn was seen over (`ownAt`), and when that chat had nothing more
 *  queued either, or waited OTHERS_WAIT_MS for it (`readyAt`). */
interface Request { key: string; at: number; ownAt?: number; readyAt?: number; waitTold?: boolean }

/** The daemon's side: `request` from the API, `tick` on a timer and at every turn's end. */
export class DeferredRestart {
  private req?: Request;
  private gone = false;

  constructor(private readonly h: DeferredHost) {}

  private now(): number { return this.h.now?.() ?? Date.now(); }

  /** The chat `key` asks (by its agent's token). False when it has no turn running: nothing to wait for. */
  request(key: string): boolean {
    if (this.gone || !this.h.running().includes(key)) return false;
    // One restart covers every ask: the first one's chat is told when it goes.
    if (!this.req) {
      this.req = { key, at: this.now() };
      this.h.log(`restart: deferred until the turn of ${key} ends`);
    }
    return true;
  }

  get pending(): string | undefined { return this.req?.key; }

  tick(ended?: string): void {
    const r = this.req;
    if (this.gone || !r) return;
    const now = this.now();
    const running = this.h.running();
    const limit = this.h.othersWaitMs ?? OTHERS_WAIT_MS;
    if (r.ownAt === undefined) {
      if (ended !== r.key && running.includes(r.key)) return;
      r.ownAt = now;
      this.h.log(`restart: the turn of ${r.key} that asked for a restart is over`);
    }
    if (r.readyAt === undefined) {
      // What the chat sent behind the asking turn runs first (a while at most): it would be cut, or
      // carried to the next daemon only if a tmux turn of it runs when the restart goes.
      const behind = this.h.queued?.(r.key) ?? 0;
      if (behind > 0 && now - r.ownAt < limit) return;
      r.readyAt = now;
    }
    // Every turn running now, the asking chat's next one too: the restart would cut it.
    if (running.length && now - r.readyAt < limit) {
      if (!r.waitTold) { r.waitTold = true; this.h.log(`restart: deferred, waiting up to ${Math.round(limit / 60_000)} min for ${running.length} running turn(s): ${running.join(', ')}`); }
      return;
    }
    this.req = undefined;
    this.gone = true;
    this.h.log(`restart: deferred restart asked by ${r.key} goes now${running.length ? ` (${running.length} turn(s) still running)` : ''}`);
    this.h.launch(r.key);
  }

  /** The launched restart failed: this daemon runs on, and a later request may go. */
  failed(): void { this.gone = false; }
}
