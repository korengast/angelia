import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { matchRoute } from '../core/router/match.js';
import { parseSessionKey } from '../core/types.js';
import { configPath, INSTANCE_DIR } from '../instance/instance.js';
import { loadConfig } from '../instance/config/load.js';
import type { Config } from '../instance/config/schema.js';

/**
 * `angelia health`: trouble counted from the daemon's log, per profile and day. Reads only: the two
 * log files (daemon.log.1, daemon.log), as a stream, and the routing table for which chat is which
 * profile. Nothing here asks the daemon anything, so it works while the daemon is down.
 *
 * What is counted is what the daemon already writes, by the start of the line. The texts are the
 * daemon's own (core/orchestrator.ts, brain/tui.ts, daemon/daemon.ts, the adapters): a line reworded
 * there must be reworded here, and tests/health.test.ts holds the two together.
 */

/** Counted per chat, and so per profile. */
export const COUNTERS = ['turns', 'noAnswer', 'failed', 'stalled', 'errors', 'deliverFailed', 'quietEnds', 'quietEmpty', 'heldOpen', 'freshRetries', 'autoDenied'] as const;
export type Counter = (typeof COUNTERS)[number];
/** Counted for the daemon as a whole: its lines name no chat. */
export const DAEMON_COUNTERS = ['starts', 'whatsappDrops', 'sendRetries'] as const;
export type DaemonCounter = (typeof DAEMON_COUNTERS)[number];

/** A column's head in the table. `turns` are tmux-mode turns only: see TURNS_NOTE. */
const LABEL: Record<Counter, string> = {
  turns: 'tmux turns', noAnswer: 'no answer', failed: 'failed', stalled: 'stalled', errors: 'errors', deliverFailed: 'deliver failed',
  quietEnds: 'quiet ends', quietEmpty: 'quiet, empty', heldOpen: 'held open', freshRetries: 'fresh retries', autoDenied: 'auto-denied',
};
const DAEMON_LABEL: Record<DaemonCounter, [one: string, many: string]> = {
  // `send failed, again in N s`: the daemon tries the same send again, so each line is a retry, not a lost message.
  starts: ['daemon start', 'daemon starts'], whatsappDrops: ['WhatsApp drop', 'WhatsApp drops'], sendRetries: ['send retry', 'send retries'],
};

/** The log has one line per turn in tmux mode only (`tmux: turn ended by …`); a print-mode turn writes
 *  none, so there is no total of all turns to set the trouble against. */
export const TURNS_NOTE = 'tmux turns: turns that ended in tmux mode. A print-mode turn writes no line in the log, so it is not counted.';

/** `--alert` speaks when one profile reaches one of these in the window. */
export const ALERT_NO_ANSWER = 2;
export const ALERT_FAILED = 3;
export const ALERT_STALLED = 1;
export const ALERT_QUIET_EMPTY = 2;
const ALERTS: [Counter, number, (n: number) => string][] = [
  ['noAnswer', ALERT_NO_ANSWER, (n) => `${n} turn${n === 1 ? '' : 's'} ended without an answer`],
  ['failed', ALERT_FAILED, (n) => `${n} turn${n === 1 ? '' : 's'} failed`],
  ['stalled', ALERT_STALLED, (n) => `${n} turn${n === 1 ? '' : 's'} stalled`],
  ['quietEmpty', ALERT_QUIET_EMPTY, (n) => `${n} tmux turn${n === 1 ? '' : 's'} ended by the quiet pane with no answer`],
];

export const MAX_DAYS = 30;
/** How long after a quiet-pane end with no turn in its transcript a `no answer` line for the same chat
 *  still belongs to it. The daemon writes the two within the same second. */
const NO_ANSWER_PAIR_MS = 30_000;
/** How long after a `turn failed` line a retry line for the same chat still takes that failure back.
 *  The daemon writes the two one after the other (orchestrator.ts, runTurn). */
const RETRY_PAIR_MS = 5_000;
/** The row of a tmux line that names no chat (a log from before the daemon added `key=` to them). */
export const NO_CHAT_ROW = 'tmux';

export type Counts = Partial<Record<Counter, number>>;
export type DaemonCounts = Partial<Record<DaemonCounter, number>>;
export interface HealthDay { profiles: Record<string, Counts>; daemon: DaemonCounts }
export interface HealthReport {
  /** The window, as ISO times. */
  since: string;
  until: string;
  days: number;
  /** The log files read, oldest first. */
  logs: string[];
  /** The time of the log's first line, when that is inside the window: the log holds less than was
   *  asked for. Null when the log reaches back to the window's start, or there is none. */
  logStart: string | null;
  /** Local calendar days, oldest first. Only what was counted: a zero is left out. */
  byDay: Record<string, HealthDay>;
  totals: HealthDay;
  /** The one line `--alert` prints, or null when every profile is within the limits. */
  alert: string | null;
  limits: { noAnswer: number; failed: number; stalled: number; quietEmpty: number };
  note: string;
}

/** A chat id as the log's own lines cut it (whatsapp/adapter.ts): the first eight characters. */
export function shortKey(key: string): string {
  const { platform, chat } = parseSessionKey(key);
  return `${platform}:${chat.length > 8 ? `${chat.slice(0, 8)}…` : chat}`;
}

/** The table row a session key is counted under: its profile by the routing table, else the chat, cut. */
export function rowOf(key: string, cfg?: Config): string {
  const at = parseSessionKey(key);
  return (cfg && matchRoute(cfg, at)?.profile) ?? shortKey(key);
}

const TURN_ENDED = /^tmux: turn ended by (.*) after \d+ s, answer (\d+) chars pane=\S+(?: key=(\S+))?$/;
const QUIET = 'the quiet pane';
/** `key=<platform:chat>`, without the `:` or `,` some lines put right after it. */
const keyOf = (text: string): string | undefined => /(?:^| )key=(\S+?)[:,]?(?: |$)/.exec(text)?.[1];

/** A local calendar day, `YYYY-MM-DD`: the owner's days, not UTC's. */
function dayOf(ms: number): string {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A local time to the minute, `YYYY-MM-DD HH:MM`. */
function localMinute(ms: number): string {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, '0');
  return `${dayOf(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Counts lines as they are fed in log order. Apart from the files, so a test can feed it lines. */
export class HealthCount {
  readonly byDay: Record<string, HealthDay> = {};
  readonly totals: HealthDay = { profiles: {}, daemon: {} };
  /** A quiet-pane end with no answer and no turn in the transcript, per chat: a slash command ends so
   *  too, and only the daemon's `no answer` line after it says it was a message. */
  private quiet = new Map<string, { at: number; day: string; row: string }>();
  /** The last `turn failed` of each chat. The daemon writes that line before it decides to try the
   *  turn again (a fresh session), so a retry line right after takes it back:
   *  a turn that was answered on its second try did not fail. A retry that fails too writes its own. */
  private failed = new Map<string, { at: number; day: string; row: string }>();

  constructor(private readonly cfg?: Config) {}

  private day(day: string): HealthDay { return (this.byDay[day] ??= { profiles: {}, daemon: {} }); }
  private add(day: string, row: string, c: Counter): void {
    for (const at of [this.day(day), this.totals]) { const r = (at.profiles[row] ??= {}); r[c] = (r[c] ?? 0) + 1; }
  }
  private sub(day: string, row: string, c: Counter): void {
    for (const at of [this.byDay[day], this.totals]) {
      const r = at?.profiles[row];
      if (!r?.[c]) continue;
      if (--r[c] === 0) delete r[c];
      if (!Object.keys(r).length) delete at.profiles[row];
    }
  }
  /** A retry line of chat `key`: the failure just before it was not the turn's end. */
  private retried(ms: number, key: string): void {
    const f = this.failed.get(key);
    if (f && ms - f.at <= RETRY_PAIR_MS) this.sub(f.day, f.row, 'failed');
    this.failed.delete(key);
  }
  private addDaemon(day: string, c: DaemonCounter): void {
    for (const at of [this.day(day), this.totals]) at.daemon[c] = (at.daemon[c] ?? 0) + 1;
  }

  /** One log line's text (after its time), written at `ms`. */
  line(ms: number, text: string): void {
    const day = dayOf(ms);
    if (text.startsWith('daemon up ')) return this.addDaemon(day, 'starts');
    if (text.startsWith('whatsapp: closed ')) return this.addDaemon(day, 'whatsappDrops');
    if (text.startsWith('send failed')) return this.addDaemon(day, 'sendRetries');
    if (text.startsWith('tmux: turn ended by ')) return this.turnEnded(ms, day, text);
    const key = keyOf(text);
    const row = key ? rowOf(key, this.cfg) : NO_CHAT_ROW;
    if (text.startsWith('tmux: the pane reads idle ') && text.includes('transcript shows the turn open')) return this.add(day, row, 'heldOpen');
    if (!key) return;
    if (text.startsWith('no answer key=')) {
      this.add(day, row, 'noAnswer');
      const q = this.quiet.get(key);
      if (q && ms - q.at <= NO_ANSWER_PAIR_MS) this.add(q.day, q.row, 'quietEmpty');
      this.quiet.delete(key);
    }
    // `stopped by the user` is /stop, /new or a model change: the turn was ended on purpose.
    else if (/^(?:injected )?turn failed key=/.test(text)) {
      if (text.includes(' reason=stopped by the user')) return;
      this.add(day, row, 'failed');
      this.failed.set(key, { at: ms, day, row });
    }
    else if (text.startsWith('turn stalled key=')) this.add(day, row, 'stalled');
    else if (text.startsWith('turn error key=')) this.add(day, row, 'errors');
    else if (text.startsWith('deliver failed key=')) this.add(day, row, 'deliverFailed');
    else if (text.startsWith('retry with fresh session key=')) { this.add(day, row, 'freshRetries'); this.retried(ms, key); }
    else if (text.startsWith('permission auto-denied ')) this.add(day, row, 'autoDenied');
  }

  /** `tmux: turn ended by <how> after N s, answer N chars pane=<pane> key=<chat>`: every tmux turn
   *  writes one, so they are the turn total too. The quiet pane is the end with no Stop marker. */
  private turnEnded(ms: number, day: string, text: string): void {
    const m = TURN_ENDED.exec(text);
    if (!m) return;
    const [, how, chars, key] = m;
    const row = key ? rowOf(key, this.cfg) : NO_CHAT_ROW;
    this.add(day, row, 'turns');
    if (key) this.quiet.delete(key);
    if (!how.startsWith(QUIET)) return;
    this.add(day, row, 'quietEnds');
    if (chars !== '0') return;
    // The transcript showed a turn (open, or text it then lost): cut with nothing for the chat.
    if (!/transcript has (no turn|a slash command only)\)/.test(how)) this.add(day, row, 'quietEmpty');
    else if (key) this.quiet.set(key, { at: ms, day, row });
  }
}

/** Feed `count` every line of `file` written from `since` to `until` (ISO times, which sort as text).
 *  Returns the time of the file's first line, or null for a file with none. */
async function readLog(file: string, since: string, until: string, count: HealthCount): Promise<string | null> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let first: string | null = null;
  for await (const line of rl) {
    // `2026-11-20T10:00:00.000Z text`: a line with no time of its own (the rest of a message that
    // held a line break) is not a line of the daemon's.
    if (line.length < 26 || line[10] !== 'T' || line[23] !== 'Z' || line[24] !== ' ') continue;
    const stamp = line.slice(0, 24);
    const inside = stamp >= since && stamp <= until;
    if (first !== null && !inside) continue;
    const ms = Date.parse(stamp);
    if (Number.isNaN(ms)) continue;
    first ??= stamp;
    if (inside) count.line(ms, line.slice(25));
  }
  return first;
}

/** The one line for a chat, or null when every profile is within the limits. */
export function alertLine(totals: HealthDay, days: number): string | null {
  const over: string[] = [];
  for (const [row, c] of Object.entries(totals.profiles).sort(([a], [b]) => a.localeCompare(b))) {
    const said = ALERTS.flatMap(([counter, limit, say]) => ((c[counter] ?? 0) >= limit ? [say(c[counter]!)] : []));
    if (said.length) over.push(`${row} ${said.join(', ')}`);
  }
  if (!over.length) return null;
  return `Angelia health, ${windowWords(days)}: ${over.join('; ')}. See: angelia health${days === 1 ? '' : ` --days ${days}`}`;
}

const windowWords = (days: number): string => (days === 1 ? 'last 24 h' : `last ${days} days`);

export async function health(o: { days?: number; stateDir?: string; cfg?: Config; now?: Date } = {}): Promise<HealthReport> {
  const days = o.days ?? 1;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`--days takes a whole number from 1 to ${MAX_DAYS}`);
  const now = o.now ?? new Date();
  const since = new Date(now.getTime() - days * 24 * 3600_000);
  const dir = o.stateDir ?? INSTANCE_DIR;
  const count = new HealthCount(o.cfg);
  const logs: string[] = [];
  // Where the log begins: the first line of the oldest file there is. Unset while unknown; null once a
  // file older than the window was passed over, since the log then reaches back past the window's start.
  let logStart: string | null | undefined;
  // The older file first, so lines come in the order they were written. One last written before the
  // window holds nothing of it and is not opened.
  for (const file of [join(dir, 'daemon.log.1'), join(dir, 'daemon.log')]) {
    let mtime: number;
    try { mtime = statSync(file).mtimeMs; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    if (mtime < since.getTime()) { logStart = null; continue; }
    const first = await readLog(file, since.toISOString(), now.toISOString(), count);
    if (logStart === undefined) logStart = first !== null && first > since.toISOString() ? first : null;
    logs.push(file);
  }
  const byDay = Object.fromEntries(Object.entries(count.byDay).sort(([a], [b]) => a.localeCompare(b)));
  return {
    since: since.toISOString(), until: now.toISOString(), days, logs, logStart: logStart ?? null, byDay, totals: count.totals,
    alert: alertLine(count.totals, days),
    limits: { noAnswer: ALERT_NO_ANSWER, failed: ALERT_FAILED, stalled: ALERT_STALLED, quietEmpty: ALERT_QUIET_EMPTY },
    note: TURNS_NOTE,
  };
}

function daemonWords(d: DaemonCounts): string {
  return DAEMON_COUNTERS.flatMap((c) => (d[c] ? [`${d[c]} ${DAEMON_LABEL[c][d[c] === 1 ? 0 : 1]}`] : [])).join(', ');
}

/** One table per day: profiles as rows, and only the columns that counted something that day. */
export function healthText(r: HealthReport): string {
  const out = [`Angelia health, ${windowWords(r.days)}`];
  // Asked for more than the log holds: the counts cover less time than the heading says.
  if (r.logStart) out.push(`The log starts ${localMinute(Date.parse(r.logStart))}: nothing before that is counted.`);
  if (!r.logs.length) out.push('', 'No daemon log written in this window.');
  else if (!Object.keys(r.byDay).length) out.push('', 'Nothing counted in the daemon log for this window.');
  for (const [day, d] of Object.entries(r.byDay)) {
    out.push('', day);
    const rows = Object.entries(d.profiles).sort(([a], [b]) => a.localeCompare(b));
    const cols = COUNTERS.filter((c) => rows.some(([, n]) => n[c]));
    if (cols.length) {
      const first = Math.max('profile'.length, ...rows.map(([name]) => name.length));
      const line = (name: string, cells: string[]) => `  ${name.padEnd(first)}  ${cells.map((c, i) => c.padStart(LABEL[cols[i]].length)).join('  ')}`;
      out.push(line('profile', cols.map((c) => LABEL[c])));
      for (const [name, n] of rows) out.push(line(name, cols.map((c) => String(n[c] ?? '.'))));
    }
    const daemon = daemonWords(d.daemon);
    if (daemon) out.push(`  daemon: ${daemon}`);
  }
  if (Object.values(r.byDay).some((d) => Object.values(d.profiles).some((n) => n.turns))) out.push('', TURNS_NOTE);
  return out.join('\n');
}

/** `angelia health [--days N] [--json] [--alert] [--config <routing.yaml>]`. With `--alert` it is made
 *  for a scheduled `run:` job, whose output is posted and whose silence posts nothing (jobs.ts,
 *  runJob): no output and exit 0 within the limits, else one plain line. */
export async function healthCommand(argv: string[]): Promise<void> {
  const value = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const days = argv.includes('--days') ? Number(value('--days')) : 1;
  // The table says which chat is which profile. Without one that loads, chats are named by their id, cut.
  let cfg: Config | undefined;
  try { cfg = loadConfig(configPath(value('--config'))); } catch (e) { if (value('--config')) throw e; }
  const r = await health({ days, cfg });
  if (argv.includes('--alert')) { if (r.alert) console.log(r.alert); return; }
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : healthText(r));
}
