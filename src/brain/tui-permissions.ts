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
 * The hook relays while a turn from the chat is being read, which `beat` says on every poll, and
 * between the chat's turns while the daemon holds the pane (`beat` with `idle`): then the hook adds
 * what started the turn that asks (turnOrigin, as the Stop hook reads it), and the daemon either
 * takes the request (a turn the agent started by itself: the profile's `permissions` decide) or tells
 * the hook to step aside (`pass`: a turn a person typed in the Claude app or the pane). With no
 * heartbeat at all it steps aside at once, and Claude opens its own dialog in the pane and the app.
 */

/** A heartbeat older than this means nobody reads the chat. The hook has the same number. Only a
 *  daemon that died or stopped for a restart leaves one to go stale (every other end of a turn removes
 *  it at once); the hook then waits a minute more for the next daemon's (its RESTART_WAIT_MS). */
export const RELAY_STALE_MS = 30_000;
/** How often the heartbeat is written while a turn is read from the chat: on a timer of its own, so a
 *  reader waiting on a slow chat send does not look like a daemon that stopped. */
export const RELAY_BEAT_MS = 1000;
/** How long a dialog must stay on the pane, with no request from the hook, before the chat hears of it. */
export const SCREEN_ONLY_MS = 1500;

const REQUEST = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.request\.json$/;

/** What started the turn a request between turns comes from, as the hook read it from the transcript
 *  (scripts/turn-origin.mjs): `origin` notification, prompt or unknown, for a typed turn the key of
 *  its last typed prompt and how many there were, and for a notification the tool-use ids of the
 *  tasks whose end started it (`ids`) and the teammates whose message did (`teammates`), only when
 *  each row that started it names one. */
/** `promptKeys`: the keys of the prompts typed into the turn (the last 20; `prompts` counts them all);
 *  `promptAt`: when the last was written; `openedBy`: what opened the turn (`prompt`, `notification`,
 *  `other`); `joined`: the rows nobody typed that joined a typed turn (the last 20; `joins` counts them
 *  all), each its kind (`notification`, `scheduled`, `other`) and the task ids and teammates it names. */
export interface RequestOrigin { origin: string; why?: string; promptKey?: string; prompts?: number; promptKeys?: string[]; promptAt?: number; openedBy?: string; ids?: string[]; teammates?: string[]; joins?: number; joined?: JoinedRow[] }
/** One row nobody typed in a typed turn (RequestOrigin.joined). */
export interface JoinedRow { kind: string; ids?: string[]; teammates?: string[] }

/** `at`: when the hook wrote it, by the hook's clock (it gives up HOOK_GIVE_UP_MS after). `origin`:
 *  what started the turn that asks (the hook writes it on every request; one with none is of an older hook). */
export interface RelayedRequest { id: string; tool: string; input: unknown; at?: number; origin?: RequestOrigin }

/** How long the hook waits for an answer once it wrote its request (scripts/tui-permission-hook.mjs,
 *  GIVE_UP_MS). A request offered again after a restart has only what is left of it. */
export const HOOK_GIVE_UP_MS = 11 * 60_000;

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

  /** While a turn is read from the chat, every RELAY_BEAT_MS. `idle`: between the chat's turns, while
   *  the daemon holds the pane: the hook then says what started the turn that asks. */
  beat(now = Date.now(), idle = false): void { this.put('relay.json', idle ? { at: now, idle: true } : { at: now }); }

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
      let row: { tool_name?: unknown; tool_input?: unknown; at?: unknown; origin?: unknown };
      try { row = JSON.parse(readFileSync(join(this.dir, name), 'utf8')); } catch { continue; }
      this.seen.add(id);
      this.open.add(id);
      const origin = originOf(row.origin);
      out.push({ id, tool: typeof row.tool_name === 'string' && row.tool_name ? row.tool_name : '?', input: row.tool_input, at: Number(row.at) || 0, ...(origin ? { origin } : {}) });
    }
    return out.sort((a, b) => a.at - b.at).map(({ at, ...r }) => ({ ...r, ...(at ? { at } : {}) }));
  }

  /** A hook waits on a request now, taken or not: Claude Code draws its own dialog while the hook
   *  runs (measured on claude 2.1.332), so Enter must not be pressed for a message into the turn. */
  waiting(): boolean {
    try { return readdirSync(this.dir).some((n) => REQUEST.test(n)); } catch { return false; }
  }

  /** Requests given to the chat whose hook no longer waits: answered in the pane or the app, or it stepped aside. */
  gone(): string[] {
    const out = [...this.open].filter((id) => !existsSync(join(this.dir, `${id}.request.json`)));
    for (const id of out) this.open.delete(id);
    return out;
  }

  /** The owner's answer, for the hook waiting on this request and no other. False when no hook waits
   *  for it any more, though the last poll had not seen it go: nothing is left behind for nobody. */
  answer(id: string, allow: boolean, message?: string): boolean {
    if (!this.open.delete(id)) return false;
    const request = join(this.dir, `${id}.request.json`);
    if (!existsSync(request)) return false;
    this.put(`${id}.answer.json`, !allow && message ? { allow, message } : { allow });
    // The hook can step aside between the check and the write; then its answer file goes too.
    if (existsSync(request)) return true;
    rmSync(join(this.dir, `${id}.answer.json`), { force: true });
    return false;
  }

  /** Not the chat's to answer (a turn a person typed, between the chat's turns): the hook steps aside
   *  and Claude asks in its own dialog, as with no daemon. False when no hook waits for it any more. */
  pass(id: string): boolean {
    if (!this.open.delete(id)) return false;
    const request = join(this.dir, `${id}.request.json`);
    if (!existsSync(request)) return false;
    this.put(`${id}.answer.json`, { pass: true });
    return true;
  }

  private put(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, join(this.dir, name));
  }
}

/** The hook's `origin` field, kept only in its own shape: plain words, keys, a time, a count. */
function originOf(v: unknown): RequestOrigin | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { origin?: unknown; origin_why?: unknown; prompt_key?: unknown; prompts?: unknown; prompt_keys?: unknown; prompt_at?: unknown; opened_by?: unknown; origin_ids?: unknown; origin_teammates?: unknown; joins?: unknown; joined?: unknown };
  const keys = Array.isArray(o.prompt_keys) && o.prompt_keys.length <= 20 && o.prompt_keys.every((k) => typeof k === 'string' && /^[0-9a-f]{1,128}$/.test(k)) ? o.prompt_keys as string[] : undefined;
  if (typeof o.origin !== 'string' || !/^[a-z]{1,20}$/.test(o.origin)) return undefined;
  return {
    origin: o.origin,
    ...(typeof o.origin_why === 'string' ? { why: o.origin_why.replace(/[^\w <>(),-]/g, '').slice(0, 120) } : {}),
    ...(typeof o.prompt_key === 'string' && o.prompt_key.length <= 128 ? { promptKey: o.prompt_key } : {}),
    ...(typeof o.prompts === 'number' && Number.isInteger(o.prompts) ? { prompts: o.prompts } : {}),
    ...(keys ? { promptKeys: keys } : {}),
    ...(typeof o.prompt_at === 'number' && Number.isFinite(o.prompt_at) ? { promptAt: o.prompt_at } : {}),
    ...(typeof o.opened_by === 'string' && /^[a-z]{1,20}$/.test(o.opened_by) ? { openedBy: o.opened_by } : {}),
    ...(words(o.origin_ids) ? { ids: words(o.origin_ids) } : {}),
    ...(words(o.origin_teammates) ? { teammates: words(o.origin_teammates) } : {}),
    ...(typeof o.joins === 'number' && Number.isInteger(o.joins) && o.joins >= 0 ? { joins: o.joins } : {}),
    ...(Array.isArray(o.joined) && o.joined.length <= 20 ? { joined: o.joined.map(joinedOf) } : {}),
  };
}

/** One entry of the hook's `joined`, in its own shape; anything else reads `other` (ties nothing). */
function joinedOf(v: unknown): JoinedRow {
  const j = v && typeof v === 'object' ? v as { kind?: unknown; ids?: unknown; teammates?: unknown } : {};
  const ids = words(j.ids), mates = words(j.teammates);
  if (typeof j.kind !== 'string' || !/^[a-z]{1,20}$/.test(j.kind)) return { kind: 'other' };
  // A list that is there but not in its shape: the row is not known for anyone's work.
  if ((j.ids !== undefined && !ids) || (j.teammates !== undefined && !mates)) return { kind: 'other' };
  return { kind: j.kind, ...(ids ? { ids } : {}), ...(mates ? { teammates: mates } : {}) };
}

/** A list of ids or names as the hook writes them (turn-origin.mjs: TOOL_USE_ID, TEAMMATE_ID): plain
 *  words, at most 20. Anything else is no list, and ties the request to nothing. */
function words(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || !v.length || v.length > 20) return undefined;
  return v.every((x) => typeof x === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(x)) ? v as string[] : undefined;
}

/** What Claude Code writes as the result of a tool use a person refused in its dialog (No or Esc).
 *  Seen on 2.1.287: `toolUseResult` is this string, and the tool_result has `is_error: true`. */
export const REJECTED = 'User rejected tool use';

/**
 * How a request answered in Claude's own dialog went, read from a slice of the transcript: the last
 * call of `tool` with exactly `input`, then its result. False: refused. True: it ran (any other
 * result). 'running': the call is there with no result yet; a refusal is written at once, so after a
 * moment this means it was allowed. Undefined: no such call in the slice.
 */
export function paneVerdict(chunk: string, tool: string, input: unknown): boolean | 'running' | undefined {
  const want = canonical(input);
  let call: string | undefined;
  let verdict: boolean | undefined;
  for (const line of chunk.split('\n')) {
    let row: { type?: string; toolUseResult?: unknown; message?: { content?: unknown } };
    try { row = JSON.parse(line); } catch { continue; }
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
      if (row.type === 'assistant' && b?.type === 'tool_use' && b.name === tool && canonical(b.input) === want) { call = b.id; verdict = undefined; }
      else if (row.type === 'user' && b?.type === 'tool_result' && call && b.tool_use_id === call) {
        verdict = !(row.toolUseResult === REJECTED || (b.is_error === true && (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')).startsWith("The user doesn't want to proceed")));
      }
    }
  }
  if (!call) return undefined;
  return verdict ?? 'running';
}

/** JSON with keys in order, so two spellings of one input compare equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** The chat's view of a request: its tool and its whole input, cut the way print mode cuts it. */
export function relayedPermission(r: RelayedRequest): Extract<BrainEvent, { kind: 'permission' }> {
  return { kind: 'permission', id: r.id, tool: r.tool, ...permissionPreview(r.input), request: { tool: r.tool, input: r.input } };
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
