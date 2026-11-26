import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A line posted into a chat past the chat's own agent (a job, another profile, the owner's
 *  `angelia send`, Angelia's own): when, the text as the chat saw it, and who posted it
 *  (`job <name>`, `profile <name>`, `owner`, `angelia`, or a caller's label). */
export interface SentNote { at: string; text: string; source: string; session: string | null }

interface Kept extends SentNote {
  kind: 'sent';
  /** The chat's agent was given it at a turn's start. */
  seen?: true;
}

/** Lines kept per chat: the newest only. A busy chat's jobs and peers over a few days. */
export const SENT_PER_CHAT = 200;
/** A line keeps this much of its text; the agent's preface and the export say it was cut. */
export const SENT_TEXT_MAX = 2000;
/** A chat's lines together: past this many characters the oldest go, whatever their count. */
export const SENT_CHARS_PER_CHAT = 64_000;

/**
 * The chats' posted lines, in one small file under the state folder (0600). The CLI's transcript
 * never holds them, so without this a job's line was never the agent's to know. A file that cannot be
 * read is started again: these are notes, not data anyone would miss. Written whole and renamed into
 * place with no fsync: after a power cut it may come back empty or old, and that is accepted.
 */
export class ChatNotes {
  private data: Record<string, Kept[]> | undefined;

  constructor(private readonly path: string, private readonly warn: (line: string) => void = () => {}) {}

  add(key: string, session: string | null, text: string, source: string, at = new Date()): void {
    const cut = text.length > SENT_TEXT_MAX ? `${text.slice(0, SENT_TEXT_MAX)} [... ${text.length - SENT_TEXT_MAX} more characters not kept]` : text;
    const all = this.read();
    all[key] = newest([...(all[key] ?? []), { at: at.toISOString(), kind: 'sent', text: cut, source, session }]);
    this.save();
  }

  /** The chat's lines the agent has not been given yet, oldest first, and from now on they count as
   *  given: the next call returns only what came after. */
  takeUnseen(key: string): SentNote[] {
    const list = (this.read()[key] ?? []).filter((n) => !n.seen);
    if (!list.length) return [];
    for (const n of list) n.seen = true;
    this.save();
    return list.map(pub);
  }

  /** Every line of the chat kept, oldest first (export). */
  sentOf(key: string): SentNote[] { return (this.read()[key] ?? []).map(pub); }

  private read(): Record<string, Kept[]> {
    if (this.data) return this.data;
    this.data = {};
    if (!existsSync(this.path)) return this.data;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { chats?: Record<string, unknown> };
      for (const [key, list] of Object.entries(raw.chats ?? {})) {
        if (!Array.isArray(list)) continue;
        this.data[key] = list
          .filter((n): n is Kept => !!n && n.kind === 'sent' && typeof n.at === 'string' && typeof n.text === 'string' && (typeof n.session === 'string' || n.session === null))
          .map((n) => ({ at: n.at, kind: 'sent', text: n.text, session: n.session, source: typeof n.source === 'string' ? n.source : 'angelia', ...(n.seen === true ? { seen: true as const } : {}) }));
      }
    } catch (e) {
      this.warn(`posted lines could not be read (${(e as Error).message}); starting with none`);
    }
    return this.data;
  }

  /** Written aside, then renamed into place, so a reader never sees half a file. */
  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp`;
      const fd = openSync(tmp, 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, chats: this.data })); } finally { closeSync(fd); }
      renameSync(tmp, this.path);
      chmodSync(this.path, 0o600);
    } catch (e) { this.warn(`posted lines not saved: ${(e as Error).message}`); }
  }
}

const pub = (n: Kept): SentNote => ({ at: n.at, text: n.text, source: n.source, session: n.session });

/** The newest lines within both limits: the count, and the characters they hold together. */
function newest(list: Kept[]): Kept[] {
  let chars = 0, from = list.length;
  while (from > 0 && from > list.length - SENT_PER_CHAT && chars + list[from - 1].text.length <= SENT_CHARS_PER_CHAT) chars += list[--from].text.length;
  return list.slice(from);
}

/** At most this many characters of posted lines go before a turn's envelope. */
export const SENT_PREFACE_MAX = 4000;
/** The zone the stamps are in, once, in the head line: the machine's own. */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const SENT_PREFACE_HEAD = `[Posted in this chat since your last turn by Angelia, not written by you (a job, a script, another profile, or Angelia itself). The chat read them after your last answer; treat them as already said, and do not send them again. Times in ${ZONE}.]`;
/** Every way a line may end in text that reaches an agent. */
const LINE_BREAK = /\r\n?|\n|\u2028|\u2029/;

/** `2026-11-06 20:00` in this machine's time zone, the daemon's: the agent reads the chat's clock. */
export function localStamp(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The posted lines as the agent is told before the envelope: its own latest messages, oldest first.
 *  Over SENT_PREFACE_MAX characters the oldest go, and a line says how many. A note's first line
 *  follows its stamp, through `quote` (a line shaped like an envelope or a file line is quoted); every
 *  further line of it is quoted with ">", so no text can forge a stamp line, the head line or the
 *  count line: those stand at the start of a line, and a note's lines never do. */
export function sentPreface(notes: readonly { at: string; text: string; source: string }[], quote: (line: string) => string): string {
  if (!notes.length) return '';
  const lines = notes.map((n) => {
    const [first, ...rest] = n.text.split(LINE_BREAK);
    return [`[${localStamp(n.at)} · ${n.source}] ${quote(first)}`, ...rest.map((l) => `> ${l}`)].join('\n');
  });
  const cutLine = (n: number) => `[... and ${n} earlier line${n === 1 ? '' : 's'} not shown]`;
  let from = 0, size = SENT_PREFACE_HEAD.length + lines.reduce((s, l) => s + l.length + 1, 0);
  while (from < lines.length - 1 && size + (from ? cutLine(from + 1).length + 1 : 0) > SENT_PREFACE_MAX) size -= lines[from++].length + 1;
  return [SENT_PREFACE_HEAD, ...(from ? [cutLine(from)] : []), ...lines.slice(from)].join('\n');
}
