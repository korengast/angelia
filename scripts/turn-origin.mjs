import { createHash } from 'node:crypto';

/**
 * What started the turn a Stop event ends, read from the session's transcript (JSONL). The daemon
 * decides with it what to do with an answer nobody asked it for (src/brain/tui.ts, takeIdle):
 *
 * - `notification`: Claude Code woke the agent by itself, with a row it queued: the end of a background
 *   task, or a prompt the session scheduled for itself. Nobody typed it. `origin_ids`: the tool-use
 *   ids the tasks' ends name, only when every such row names one (a scheduled prompt names none);
 *   the daemon delivers only the end of tasks its own turns started.
 * - `prompt`: also `prompt_key` (promptKey of the last typed prompt) and `prompts` (how many): the
 *   daemon sends a late answer only of a turn whose one typed prompt is what it typed.
 * - `prompt`: a person typed it, in the Claude app, over Remote Control or in the pane. Angelia's own
 *   turns read the same: it types the chat's message into the pane.
 * - `unknown`: no row that starts a turn was found, or one of a kind this file does not know.
 *
 * Measured on Claude Code 2.1.329 in a live pane (tests/live-tui-origin.mts, 2026-11-20):
 * - A typed message is a user row with `origin.kind: human`.
 * - The end of a background task is a user row with `origin.kind: task-notification`, whose text
 *   opens with the tag `<task-notification>`.
 * - A scheduled prompt of the session (CronCreate) is a `system` row with subtype
 *   `scheduled_task_fire`, then the prompt as a meta user row with no origin.
 * - A turn that ended has a `system` row with subtype `turn_duration` after its last row. The Stop
 *   hook runs before that row is written, and can run before the turn's last assistant rows are.
 * Read from the 2.1.330 program text, not measured live: a prompt typed while a turn runs is an
 * `attachment` row of type `queued_command`, with `prompt` and `origin`. A person's unless its
 * origin is a notification kind known here; any other kind (a plugin's note, a forward) is unknown.
 * `human` always wins: a person who types a tag typed it. A row with no `origin` is read by its text
 * alone, but only in a transcript where no row says where it came from (an older CLI): where others
 * do, a row that says nothing and opens with a task's tag is unknown. A row whose `origin.kind` is
 * something else and whose text opens with no known tag is `unknown`, and the kind is in the why.
 * Not measured: a teammate's or an agent's message, `unknown` until it is.
 *
 * A turn may have several such rows (a prompt typed while a task's end is answered, a second task that
 * ends meanwhile). One typed prompt among them makes the whole turn `prompt`: its answer may speak to
 * what the person typed, and that never leaves the app.
 *
 * Where a turn begins is read off the rows as src/brain/tui.ts (turnRows) reads them: a row that
 * starts a turn opens a new one when the rows before it are closed (the assistant's text was last, or
 * the CLI's error row, or the turn was cut), and joins the open one otherwise (a tool was running, the
 * model owed its answer). Rows that count are the session's own user and assistant rows; a subagent's
 * (isSidechain) and the bookkeeping between them are skipped.
 */

/** The one row Claude Code queues by itself that this file calls a notification: a background task ended. */
const QUEUED = /^\s*<(task-notification)\b/;
/** Other rows Claude Code writes as a user message that nobody typed, and no kind this file delivers.
 *  A teammate's or another agent's message is one until its row is measured. */
const WRAPPED = /^\s*<(teammate-message|agent-message|cross-session-message|system-reminder)\b/;
/** `origin.kind` of a queued row this file calls a notification. */
const NOTIFICATION_KINDS = new Set(['task-notification']);
/** A tool-use id in a task's end, as background.ts reads it; the daemon ties the turn to its own work by it. */
const TOOL_USE_ID = /<tool-use-id>\s*([A-Za-z0-9_-]{1,100})\s*<\/tool-use-id>/g;
/** Kept per turn: a turn that names more is not tied to anything. */
const IDS_MAX = 20;
/** A row any newer CLI stamps with where it came from. JSON escapes quotes inside a string, so this
 *  never matches words of the conversation. */
const STAMPED = /"origin":\s*\{\s*"kind"/;
const COMMAND_ROW = /^\s*<command-(name|message|args)>/;
const LOCAL_ROW = /^\s*<local-command-[a-z]+>/;
const INTERRUPTED = '[Request interrupted by user';
const REJECTED = 'User rejected tool use';
const HOOK_FEEDBACK = 'Stop hook feedback:';
/** `origin.kind` of a row a person typed. */
const HUMAN = 'human';
/** Subtypes of `system` rows: a turn ended; a scheduled prompt of the session fired. */
const TURN_OVER = 'turn_duration';
const SCHEDULED = 'scheduled_task_fire';
/** The attachment row of a prompt queued while a turn ran. */
const QUEUED_COMMAND = 'queued_command';

/** The tool-use ids a task's end names, at most IDS_MAX (more: none, so nothing is tied). */
function idsOf(text) {
  const ids = [...new Set([...String(text).matchAll(TOOL_USE_ID)].map((m) => m[1]))];
  return ids.length <= IDS_MAX ? ids : [];
}

/** Claude Code 2.1.330 writes a pasted text of more than one line into the transcript inside
 *  `<pasted_content id="<4 hex>">` and `</pasted_content id="<4 hex>">` (measured live, the form read
 *  from its program text). The key leaves the tags out, on both sides. */
const PASTED_TAG = /<\/?pasted_content id="[0-9a-f]{4}">/g;

/**
 * The key of a typed prompt, compared with the one the daemon computes for what it typed
 * (src/brain/tui.ts, promptKey): the paste tags left out (PASTED_TAG), the text in Unicode NFC, every run of white space one space, trimmed,
 * then SHA-256, the first 32 hex digits. Never the words.
 */
export function promptKey(text) {
  return createHash('sha256').update(String(text ?? '').replace(PASTED_TAG, ' ').normalize('NFC').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('\n');
}

function refused(row, block) {
  if (row.toolUseResult === REJECTED) return true;
  const c = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
  return block.is_error === true && c.startsWith("The user doesn't want to proceed");
}

/** The row's own word for where it came from (`origin.kind`), when it is a plain identifier. */
function saidOrigin(row) {
  const k = row?.origin?.kind;
  return typeof k === 'string' && /^[a-z0-9_-]{1,40}$/i.test(k) ? k : undefined;
}

/**
 * The rows that started the last turn of `raw`, oldest first: `kind`, the tag of a queued row, and
 * when the row was written (ms, from its timestamp; undefined when it has none).
 */
export function turnStarters(raw) {
  /** none: nothing open. command: a slash command's row, which the CLI may answer itself. open: a
   *  tool runs or the model owes an answer. said: the assistant's text was last. error: the CLI's
   *  row for a failed API call was last. */
  let state = 'none';
  let starters = [];
  /** The rows that started the turn a `turn_duration` row closed: a hook that sends the answer back
   *  (the language check) opens that same turn again. */
  let closedTurn = [];
  /** The API message the last assistant row was part of (one answer of the model is several rows). */
  let lastMessage;
  const text0 = String(raw ?? '');
  // This CLI says where its rows come from: a row that says nothing is not taken for a task's end by its tag.
  const stamped = STAMPED.test(text0);
  /** One row that may start a turn, pushed where the turn stands. */
  const push = (starter, command = false) => {
    const closed = state === 'none' || state === 'said' || state === 'error';
    if (closed) starters = [];
    starters.push(starter);
    // A command typed while a turn runs does not close it.
    state = command && closed ? 'command' : command ? state : 'open';
  };
  for (const line of text0.split('\n')) {
    // Most rows are bookkeeping.
    if (!line.includes('"user"') && !line.includes('"assistant"') && !line.includes(TURN_OVER) && !line.includes(SCHEDULED) && !line.includes(QUEUED_COMMAND)) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || row.isSidechain === true) continue;
    if (row.type === 'system') {
      // The turn is over. What comes next starts a new one; with no row that starts one, nothing
      // here says what did (the rows of the turn that ended must not speak for it).
      if (row.subtype === TURN_OVER) { closedTurn = starters; starters = []; state = 'none'; }
      else if (row.subtype === SCHEDULED) {
        const at = Date.parse(String(row.timestamp ?? ''));
        if (state === 'none' || state === 'said' || state === 'error') starters = [];
        starters.push({ kind: 'notification', tag: 'scheduled-prompt', ...(Number.isNaN(at) ? {} : { at }) });
        state = 'open';
      }
      continue;
    }
    if (row.type === 'attachment') {
      // A prompt that came while a turn ran (Claude Code 2.1.330, read from its program text): an
      // attachment row of type queued_command, with the prompt and its origin. A person's unless the
      // origin is a notification kind known here; a kind not known here is not delivered.
      const a = row.attachment;
      if (!a || typeof a !== 'object' || a.type !== QUEUED_COMMAND) continue;
      const text = userText(a.prompt);
      const said = saidOrigin(a);
      const at = Date.parse(String(a.timestamp ?? row.timestamp ?? ''));
      const when = Number.isNaN(at) ? {} : { at };
      const queued = QUEUED.exec(text);
      if (said && NOTIFICATION_KINDS.has(said)) push({ kind: 'notification', tag: queued ? queued[1] : said, ids: idsOf(text), ...when, said, queuedCommand: true });
      else if (said && said !== HUMAN) push({ kind: 'other', ...when, said, queuedCommand: true });
      else push({ kind: 'prompt', key: promptKey(text), ...when, ...(said ? { said } : {}), queuedCommand: true });
      continue;
    }
    const content = row.message?.content;
    if (row.type === 'assistant') {
      if (row.isApiErrorMessage === true || (typeof row.error === 'string' && row.error)) { state = 'error'; continue; }
      // The model answers again after a closed turn, and no row in between opened one: something this
      // file does not see started it. Then the rows of the turn before say nothing about this one.
      // (A second net under `turn_duration`, for a transcript that has no such row.)
      const id = typeof row.message?.id === 'string' && row.message.id ? row.message.id : undefined;
      if (id && lastMessage && id !== lastMessage && (state === 'said' || state === 'error')) starters = [{ kind: 'other', unseen: true }];
      if (id) lastMessage = id;
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === 'text') { if (String(b.text ?? '').trim()) state = 'said'; }
        else if (b?.type === 'tool_use' || b?.type === 'thinking' || b?.type === 'redacted_thinking') state = 'open';
      }
      continue;
    }
    if (row.type !== 'user' || row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) continue;
    const text = userText(content);
    const blocks = Array.isArray(content) ? content : [];
    const queued = QUEUED.exec(text);
    const said = saidOrigin(row);
    // A note Claude Code wrote for the model. Right after a slash command it is the prompt the command
    // made (a skill's text): the command's row already counts as what started the turn. A note that
    // says of itself that something other than a person sent it is read on, as a row that may start a turn.
    if (row.isMeta === true && !queued && !(said && said !== HUMAN)) { if (state === 'command' && !LOCAL_ROW.test(text)) state = 'open'; continue; }
    const results = blocks.filter((b) => b?.type === 'tool_result');
    // Cut short (Esc, a "No" in Claude Code's own dialog): the turn is over, and no Stop comes for it.
    if (text.trimStart().startsWith(INTERRUPTED) || results.some((b) => refused(row, b))) { state = 'none'; starters = []; continue; }
    if (results.length) { state = 'open'; continue; }
    // The CLI answered a slash command itself: that was no turn.
    if (LOCAL_ROW.test(text)) { if (state === 'command') { state = 'none'; starters = []; } continue; }
    // A hook sent the answer back (the language check): the same turn goes on.
    if (text.trimStart().startsWith(HOOK_FEEDBACK)) { if (!starters.length) starters = closedTurn; state = 'open'; continue; }
    if (!text.trim() && !blocks.length) continue;
    const at = Date.parse(String(row.timestamp ?? ''));
    const wrapped = WRAPPED.exec(text);
    // A person typed it, whatever it looks like; else a queued row by its tag (on a CLI that stamps its
    // rows, only one that says it is a notification); else a row the CLI says nobody typed, of a kind
    // not known here; else a prompt.
    const kind = said === HUMAN ? 'prompt'
      : queued && (said ? NOTIFICATION_KINDS.has(said) : !stamped) ? 'notification'
        : queued || wrapped || said ? 'other' : 'prompt';
    push({
      kind,
      ...(kind === 'prompt' ? { key: promptKey(text) } : queued ? { tag: queued[1] } : wrapped ? { tag: wrapped[1] } : {}),
      ...(kind === 'notification' ? { ids: idsOf(text) } : {}),
      ...(Number.isNaN(at) ? {} : { at }),
      ...(said ? { said } : {}),
    }, COMMAND_ROW.test(text));
  }
  return starters;
}

/**
 * `origin`, why (fixed words and tag names only, never the conversation), and for a turn a person
 * typed into, `prompt_at`: when the last typed row was written (ms).
 */
export function turnOrigin(raw) {
  const starters = turnStarters(raw);
  if (!starters.length) return { origin: 'unknown', origin_why: 'no row that starts a turn' };
  const told = (s) => `${s.kind === 'prompt' ? (s.queuedCommand ? 'a prompt typed while the turn ran' : 'a typed prompt') : s.tag === 'scheduled-prompt' ? 'a scheduled prompt' : s.tag ? `<${s.tag}>` : s.unseen ? 'no row that starts it' : s.queuedCommand ? 'a queued row nobody typed' : 'a row nobody typed'}${s.said ? ` (origin ${s.said})` : ''}`;
  const why = [...new Set(starters.map(told))].join(', ');
  const typed = starters.filter((s) => s.kind === 'prompt');
  if (typed.length) {
    const last = typed[typed.length - 1];
    // `prompt_key` and `prompts`: the daemon sends a late answer only of a turn whose one typed prompt is its own.
    return { origin: 'prompt', origin_why: why, ...(last.at === undefined ? {} : { prompt_at: last.at }), prompt_key: last.key, prompts: typed.length };
  }
  if (starters.some((s) => s.kind === 'other')) return { origin: 'unknown', origin_why: why };
  // `origin_ids`: the tool-use ids of the tasks whose end started the turn, only when each row that
  // started it names one (a scheduled prompt names none). The daemon sends the answer only when it
  // started each of those tasks in a turn of its own.
  const tied = starters.every((s) => s.ids?.length);
  return { origin: 'notification', origin_why: why, ...(tied ? { origin_ids: [...new Set(starters.flatMap((s) => s.ids))].slice(0, IDS_MAX) } : {}) };
}

/** The tags a text may open with that the shape names; any other reads `other`. */
const SHAPE_TAGS = new Set(['task-notification', 'teammate-message', 'agent-message', 'cross-session-message', 'system-reminder',
  'command-name', 'command-message', 'command-args', 'local-command-stdout', 'local-command-stderr', 'local-command-caveat', 'pasted_content']);
/** The content block types the shape names; any other reads `other`. */
const SHAPE_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'image', 'document']);

/**
 * The shape of the last `n` rows of a transcript, for finding out how a new Claude Code writes what
 * starts a turn. The hook adds it to the marker as `origin_rows` when ANGELIA_TUI_ORIGIN_DEBUG is set
 * in the pane's environment (tests/live-tui-origin.mts sets it).
 *
 * Never a word of the conversation. One row is made of these only:
 * - `type`, `subtype`, `operation`, `origin.kind`, and an attachment's `type` and `origin.kind`, each
 *   only when it is one plain identifier of at most 32 characters (letters, digits, `_`, `-`); these
 *   are Claude Code's own field values, and a new one is what this is for;
 * - the flags `meta` and `sidechain`;
 * - `msg=<n>`: which API message an assistant row is part of, numbered in the order seen here, so
 *   rows of one answer read alike; no part of the id itself;
 * - each content block's type, from a fixed list, else `other`; `string` for content that is a string;
 * - the tag a text opens with, from a fixed list, else `other`.
 */
export function rowShapes(raw, n = 14) {
  const word = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v) ? v : undefined);
  const tag = (t) => { const m = /^\s*<([a-z_-]+)/.exec(String(t ?? '')); return m ? `<${SHAPE_TAGS.has(m[1]) ? m[1] : 'other'}>` : ''; };
  const messages = new Map();
  const out = [];
  for (const line of String(raw ?? '').split('\n').filter(Boolean).slice(-n)) {
    let row;
    try { row = JSON.parse(line); } catch { out.push('not-json'); continue; }
    if (!row || typeof row !== 'object') { out.push('not-a-row'); continue; }
    const content = row.type === 'queue-operation' ? row.content : row.message?.content;
    const blocks = typeof content === 'string' ? [`string${tag(content)}`]
      : Array.isArray(content) ? content.map((b) => `${SHAPE_BLOCKS.has(b?.type) ? b.type : 'other'}${b?.type === 'text' ? tag(b.text) : ''}`) : [];
    const id = typeof row.message?.id === 'string' && row.message.id ? row.message.id : undefined;
    if (id && !messages.has(id)) messages.set(id, messages.size + 1);
    out.push([
      word(row.type) ?? '?', word(row.subtype), word(row.operation), word(row.attachment?.type),
      word(row.attachment?.origin?.kind) ? `attachment-origin=${word(row.attachment.origin.kind)}` : undefined,
      row.isMeta === true ? 'meta' : undefined, row.isSidechain === true ? 'sidechain' : undefined,
      word(row.origin?.kind) ? `origin=${word(row.origin.kind)}` : undefined,
      id ? `msg=${messages.get(id)}` : undefined,
      blocks.length ? `[${blocks.join(',')}]` : undefined,
    ].filter(Boolean).join(' '));
  }
  return out;
}
