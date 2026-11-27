import { execFile } from 'node:child_process';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inServiceCgroup } from '../daemon/systemd.js';

/** Angelia's own tmux server. Sessions on this socket outlive the daemon, so a restart — or the
 *  crash the launchd unit is meant to catch — leaves every agent exactly where it was, and nothing
 *  else on the machine shares the socket. ANGELIA_TMUX_SOCKET moves it (tests). */
export const TMUX_SOCKET = process.env.ANGELIA_TMUX_SOCKET ?? 'angelia';

/** Where that server's socket is: tmux puts `-L <name>` in `$TMUX_TMPDIR` (or /tmp)/tmux-<uid>/. */
export function tmuxSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.TMUX_TMPDIR || '/tmp';
  let base = dir;
  try { base = realpathSync(dir); } catch { /* not there: tmux makes it */ }
  return join(base, `tmux-${process.getuid?.() ?? 0}`, TMUX_SOCKET);
}

/** A tmux target for exactly this session. A bare name is a prefix match: with only `foo-12` there,
 *  `-t foo-1` reaches it (has-session answers 0, kill-session ends it). `=name` is exact but a session
 *  target only (capture-pane, send-keys, paste-buffer and set-option -w refuse it); `=name:` is exact
 *  for every command Angelia sends. Measured on tmux 3.7c with sessions foo-1 and foo-12 (2026-11-26). */
export const exact = (name: string): string => `=${name}:`;

/** `timedOut`: the client was killed at its time limit: the server may well be fine (a loaded machine). */
export interface TmuxResult { code: number; out: string; err: string; timedOut?: boolean }

/** The longest one tmux client call may take (tmux(), `timeoutMs`). */
export const TMUX_TIMEOUT_MS = 30_000;

/** The call run in a transient scope of its own: under systemd the service's KillMode kills every
 *  process in its cgroup, and the tmux server must outlive the daemon. */
export function scopedArgv(bin: string, args: string[]): [string, string[]] {
  return ['systemd-run', ['--user', '--scope', '--collect', '--quiet', '--description=angelia tmux', bin, ...args]];
}

/** `scope`: the call may start the server, so in angelia.service it goes through `systemd-run --scope`.
 *  When systemd-run is missing or fails (no user bus, a daemon in some other unit), the plain call
 *  runs once instead: tmux's own errors never start with "Failed to". `inService` overrides the cgroup check (tests). */
export function tmux(args: string[], opts: { bin?: string; socket?: string; env?: NodeJS.ProcessEnv; scope?: boolean; inService?: boolean; timeoutMs?: number } = {}): Promise<TmuxResult> {
  const full = ['-L', opts.socket ?? TMUX_SOCKET, ...args];
  const run = (bin: string, argv: string[]): Promise<TmuxResult & { missing?: boolean }> => new Promise((resolve) => {
    // A tmux server that does not answer must not hold a caller for ever (a restart's adoption runs before
    // the daemon listens): every call is a short one, so past TMUX_TIMEOUT_MS the client is killed and the
    // call fails.
    execFile(bin, argv, { env: opts.env, maxBuffer: 8 << 20, timeout: opts.timeoutMs ?? TMUX_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({ code: e ? Number(e.code ?? 1) : 0, out: stdout ?? '', err: stderr ?? '', missing: e?.code === 'ENOENT', ...((e as { killed?: boolean } | null)?.killed ? { timedOut: true } : {}) });
    });
  });
  const plain = (): Promise<TmuxResult> => run(opts.bin ?? 'tmux', full);
  if (!(opts.scope && (opts.inService ?? inServiceCgroup()))) return plain();
  return run(...scopedArgv(opts.bin ?? 'tmux', full)).then((r) => (r.missing || (r.code !== 0 && r.err.startsWith('Failed to')) ? plain() : r));
}

/** Put `text` in the named paste buffer. Through a file, never on the command line: tmux refuses a
 *  command longer than about 16 KB ("command too long"), so `set-buffer` silently dropped every long
 *  message and the turn failed with the pane untouched (measured on tmux 3.7c, 2026-09-30). The file
 *  is this user's only and goes as soon as the server has read it. */
export async function loadBuffer(name: string, text: string, dir: string, run: (args: string[]) => Promise<TmuxResult>): Promise<TmuxResult> {
  const file = join(dir, 'paste.txt');
  // A fresh file every time: `wx` never follows a link left in its place, and 0o600 applies only
  // when the file is created, so one left over from a crash must not decide who can read it.
  rmSync(file, { force: true });
  writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
  try {
    return await run(['load-buffer', '-b', name, file]);
  } finally {
    rmSync(file, { force: true });
  }
}

/** Pane markers, all measured against the Claude Code terminal.
 *
 *  The idle input line is a bare prompt — capture-pane strips trailing spaces, so match the start.
 *  A running turn shows a spinner row such as `✻ Wibbling… (2m 2s · ↓ 8k tokens)`; when the turn
 *  ends the same row is redrawn as `✻ Crunched for 14s · done`. Older rows linger in scrollback,
 *  so the last spinner row seen decides. */
const PROMPT_MARKERS = ['\n❯', '\n> ', '│ >'];
export const PERMISSION_MARKER = 'Do you want to proceed?';
/** The glyphs the spinner cycles through; its "done" row keeps one of them. Any one or two
 *  characters used to count, which was loose both ways: a row such as "∴ Thinking…" or "! ls…" at the
 *  left edge read as a turn that never ends, and a spinner of several words read as idle. The
 *  one-word shape is measured (the fixtures); several words, as in "✻ Compacting conversation… (12s)",
 *  are allowed for but not measured on a live pane. `*` stands in for `✳` where the terminal is not
 *  a Mac's (Linux), from Claude Code's source as remembered, not measured: without it one frame in
 *  six of a working pane would read idle there.
 *
 *  The done row is the verb, "for", and a time ("for 14s", "for 1m 2s"). What follows the time varies
 *  ("· done", "· 1 shell still running…"), so it is not asked for: a done row that ends in "…" would
 *  otherwise read as a turn that never ends. A spinner text such as "Searching for 2 patterns…" has
 *  no time unit after the number and stays a spinner. */
const SPIN = '[·✢✳✶✻✽*]';
const BUSY_RE = new RegExp(`^${SPIN} [^…]{1,60}…`);
const DONE_RE = new RegExp(`^${SPIN} \\S+ for \\d+[smh]( |$)`);
/** The spinner is always drawn just above the input box, so only the foot of the pane counts.
 *  Further up it would be scrollback — an old assistant line ending in "…" would otherwise read
 *  as a turn that never finishes, and nothing could ever be typed again. Used when the screen has
 *  no input box to measure from. */
const TAIL_LINES = 14;
/** How many rows above the input box may hold the spinner. Claude Code draws rows between the two
 *  (a tip, a progress bar, the task list), and rows under the box that grow with the work: two
 *  status rows, then one row per running teammate (measured on claude 2.1.329, fixture
 *  pane-busy-teammates.txt, one teammate: read as busy from the screen's end too). Counted from the
 *  screen's end, as TAIL_LINES is, three more teammate rows push the spinner out of sight and a
 *  working pane reads as idle (pane-busy-teammates-4.txt: the same capture with three rows added by
 *  hand). So the box is the anchor, and what is under it is never read. */
const ABOVE_BOX = 16;
/** Claude collapses a long paste into a chip like `[Pasted text #4 +5 lines]`. */
export const PASTED_MARKER = '[Pasted text';
/** A chip as drawn: its number, and the paste's line breaks (none drawn for a paste of one line).
 *  Older versions drew no number. */
const CHIP_RE = /\[Pasted text(?: #\d+)? ?(?:\+(\d+) lines?)?\]/g;
/** A paste of more characters than this, or of CHIP_BREAKS line breaks or more, is drawn as a chip
 *  (a pane of at least 12 rows; a shorter one collapses fewer breaks: chipFits). */
const CHIP_CHARS = 800;
const CHIP_BREAKS = 3;
/** A pane of fewer rows than this collapses fewer line breaks than CHIP_BREAKS (chipFits). */
export const SHORT_PANE_ROWS = 12;
/** A chip that is all the box holds. */
const LONE_CHIP_RE = /^\[Pasted text(?: #\d+)? ?(?:\+(\d+) lines?)?\]$/;

/** The length Claude Code measures against CHIP_CHARS: it turns each tab into 4 spaces first (measured
 *  on 2.1.332, 2026-11-27: one line of 740 characters with 20 tabs is drawn as text, 741 as a chip). */
const pastedLength = (text: string): number => text.length + 3 * (text.match(/\t/g)?.length ?? 0);

/** `chip` (a CHIP_RE match) can be the chip of a paste of `text`: its count is the text's line breaks,
 *  and the text is one Claude Code collapses. Measured on 2.1.332 (2026-11-27, a 220-column pane): 3
 *  breaks or more than 800 characters collapse, 2 breaks and 800 characters do not; the count is the
 *  breaks ("+5 lines" for 6 lines, "+1 lines" for one break); a paste of one line has none. Anything
 *  else is a chip of some other paste: a message pasted earlier and never cleared, someone's in the app.
 *  A short pane collapses less (measured the same day: at 11 rows 2 breaks, at 10 rows and under 1
 *  break; one line of up to 800 characters never, down to 6 rows), so on a pane of `rows` under
 *  SHORT_PANE_ROWS a chip `alone` in the box is taken on its count. A pane of unknown height is
 *  checked in full. A chip with no count is always of one line of more than 800 characters. */
function chipFits(chip: RegExpMatchArray, text: string, alone = false, rows?: number): boolean {
  const breaks = text.split('\n').length - 1;
  const long = pastedLength(text) > CHIP_CHARS;
  if (chip[1] === undefined) return breaks === 0 && long;
  if (Number(chip[1]) !== breaks) return false;
  return breaks >= CHIP_BREAKS || long || (alone && rows !== undefined && rows < SHORT_PANE_ROWS);
}

/** The box shows a chip that can be the paste of `text`. */
function chipOf(box: string, text: string): boolean {
  return [...box.matchAll(CHIP_RE)].some((m) => chipFits(m, text));
}

/** The box holds one chip and nothing else, and it can be the paste of `text` (chipFits, alone). */
function loneChipOf(pane: string, text: string, rows?: number): boolean | null {
  const chip = LONE_CHIP_RE.exec(boxText(pane));
  return chip ? chipFits(chip, text, true, rows) : null;
}

export function paneBusy(pane: string): boolean {
  const lines = pane.replace(/\n+$/, '').split('\n');
  const box = boxSpan(lines);
  // No box (a dialog, an older drawing cut off): the foot of the capture, as before.
  const foot = box ? lines.slice(Math.max(0, box.top - ABOVE_BOX), box.top) : pane.split('\n').slice(-TAIL_LINES);
  let busy = false;
  for (const line of foot) {
    if (DONE_RE.test(line)) busy = false;
    else if (BUSY_RE.test(line)) busy = true;
  }
  return busy;
}

/** A teammate's row in the list under the input box: `◯ <name>  <what it does>   21s · ↓ 87.0k tokens`
 *  (claude 2.1.329, fixture pane-busy-teammates.txt). */
const TEAMMATE_ROW = /^\s*◯\s+\S+\s{2,}.*\d+s\s+·\s+[↓↑]/;

/** True when the foot of the pane, under the input box, lists a teammate. */
export function listsTeammates(pane: string): boolean {
  const lines = pane.replace(/\n+$/, '').split('\n');
  const box = boxSpan(lines);
  return box !== null && lines.slice(box.bottom + 1).some((l) => TEAMMATE_ROW.test(l));
}

/** Safe to paste: the input box is on screen with its prompt, and no turn is running. Pasting into a
 *  dialog would answer it (Enter takes the highlighted option) and pasting mid-turn is dropped
 *  or queued, so both have to be excluded, not just waited out.
 *
 *  The prompt has to be inside the box. Every submitted message is echoed above it with the same
 *  `❯`, so a prompt anywhere in the capture proved nothing: with one earlier message in the
 *  scrollback, an open `/model` dialog (which replaces the box) read as idle, and the next chat
 *  message went into the dialog (measured on claude 2.1.280, fixture pane-model-dialog.txt). A
 *  permission dialog replaces the box too, so "Do you want to proceed?" printed by the agent in its
 *  answer no longer holds the pane busy. */
export function paneIdle(pane: string): boolean {
  if (!pane || paneBusy(pane)) return false;
  const box = inputBoxStrict(pane);
  return box !== null && PROMPT_MARKERS.some((m) => `\n${box}`.includes(m));
}

/** Safe to paste into a running turn: a turn runs, its input box is on screen with the prompt and
 *  holds nothing, and no dialog is open. Claude Code then queues what is submitted and gives it to the
 *  model at the next tool boundary of the same turn, or as the next turn when none comes (measured on
 *  claude 2.1.332, 2026-11-25: fixtures pane-busy-box-332 and pane-busy-queued-332). Never over text
 *  someone half typed in the box (pane-busy-halftyped-332): Enter would send theirs with ours. The
 *  hint "Press up to edit queued messages" is no text. A permission dialog replaces the box
 *  (pane-permission-332), so a capture with one is never safe; the caller still checks the
 *  transcript and the relay, since a dialog opened a moment ago may not be drawn yet. */
/** What sits in the input box: its lines without the prompt marker, or '' for an empty box or a
 *  screen with none. Claude Code's own hint in an empty box (`Try "write a test for <filepath>"`,
 *  `Press up to edit queued messages`) is not text that Enter would send, so it reads as empty. */
export function boxText(pane: string): string {
  const box = inputBoxStrict(pane);
  if (box === null) return '';
  const t = box.split('\n').map((l) => l.replace(/^\s*(❯|>)\s?/, '').trim()).join('\n').trim();
  if (t.startsWith('Try "') || t.startsWith('Press up to edit queued messages')) return '';
  return t;
}

export function paneMidTurn(pane: string, text?: string, rows?: number): boolean {
  if (!pane || !paneBusy(pane) || permissionDialog(pane)) return false;
  const box = inputBoxStrict(pane);
  if (box === null || !PROMPT_MARKERS.some((m) => `\n${box}`.includes(m))) return false;
  // With `text`: the same screen, with that text in the box and nothing else (right before its Enter).
  return text === undefined ? boxText(pane) === '' : boxHoldsOnly(pane, text, rows);
}

/** The box holds `text` and nothing else: its collapsed chip (one paste, of its shape: chipFits), or the
 *  text itself, as the box wraps it. Not text someone typed before or after it, and not a second chip
 *  or another paste's: Claude Code sends all of the box, so text left in it goes with the paste and the
 *  prompt it stores is not the one typed (a key miss: measured on 2.1.332, a line or a chip left with
 *  the cursor at its start). Every character is compared but space, `>` (the box draws a line's `>` as
 *  its prompt mark, which boxText takes off), and what a terminal may not give back as it was typed: an
 *  emoji's joiners and skin tones, a variation selector, a combining mark. A symbol or an emoji left in
 *  the box goes with the paste as a letter does (review-keymiss, 0.4.8). `rows`: the pane's height
 *  (chipFits), when known. */
export function boxHoldsOnly(pane: string, text: string, rows?: number): boolean {
  const lone = loneChipOf(pane, text, rows);
  if (lone !== null) return lone;
  const shown = boxText(pane);
  const flat = (s: string) => s.normalize('NFC').replace(/[\s>\p{M}\p{Cf}\u{1F3FB}-\u{1F3FF}]+/gu, '');
  const want = flat(text);
  if (!want) return false;
  // A long text drawn with its middle cut (`[...Truncated text #2 +40 lines...]`): the parts shown are
  // the text's, in order, from its start to its end.
  const parts = shown.split(/\[\.\.\.Truncated text #\d+ \+\d+ lines\.\.\.\]/).map(flat);
  if (parts.length === 1) return parts[0] === want;
  let at = 0;
  for (const [i, p] of parts.entries()) {
    const found = i === 0 ? (want.startsWith(p) ? 0 : -1) : i === parts.length - 1 ? (want.endsWith(p) && want.length - p.length >= at ? want.length - p.length : -1) : want.indexOf(p, at);
    if (found < 0) return false;
    at = found + p.length;
  }
  return true;
}

const clean = (l: string): string => l.replace(/[│╭╮╰╯┃]/g, ' ').replace(/\s+/g, ' ').trim();

/** The open permission dialog as a chat line, or null when none is open. The dialog is drawn under
 *  a full-width rule: the title, why the command runs, then the command between dashed rules:
 *
 *      ──────────────────────────────────────────
 *       Bash command
 *       Create frames-test.txt file
 *      ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *       touch frames-test.txt
 *      ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *       Do you want to proceed?
 *       ❯ 1. Yes
 *
 *  so everything between that rule and the question is the dialog, and the transcript above it is
 *  not; the dashed rules are drawing. Measured on claude 2.1.287 (2.1.278 had the command first and
 *  no dashed rules); the fixture is in tests/fixtures. */
export function permissionDialog(pane: string): { tool: string; preview: string; from?: string } | null {
  const raw = pane.split('\n');
  // The last one: the dialog is drawn at the foot of the screen, and the agent's own output above it
  // may quote the question, which would otherwise be read as the prompt.
  const at = lastLine(raw, new RegExp(PERMISSION_MARKER.replace(/[?]/g, '\\?')), raw.length);
  if (at < 0) return null;
  let top = -1;
  for (let i = at - 1; i >= 0 && i >= at - 16; i--) if (/^[\s│]*[─━╭]{8,}/.test(raw[i])) { top = i; break; }
  // 2.1.287 draws dashed rules (╌) above and below the command inside the box: drawing, not text.
  const body = raw.slice(top >= 0 ? top + 1 : Math.max(0, at - 6), at).map(clean).filter((l) => l && !/^[\s╌─━┄┈]+$/.test(l));
  if (!body.length) return { tool: 'tool', preview: 'a permission prompt is open' };
  // A teammate's request names it after the title: "Bash command · from the restart-relay agent"
  // (claude 2.1.332, seen in a chat's pane 2026-11-25).
  // Only that shape: a title with a "·" of its own says nothing of who asks.
  const asker = /^(.+?)\s*·\s*from\s+((?:the\s+)?[A-Za-z0-9_.-]{1,64}\s+agent)$/.exec(body[0]);
  const tool = (asker ? asker[1] : body[0]).slice(0, 40);
  return { tool, preview: (body.slice(1).join(' · ') || body[0]).slice(0, 300), ...(asker ? { from: asker[2].slice(0, 60) } : {}) };
}

/** A directory Claude Code has not been run in before opens a trust dialog before the first
 *  prompt, with "No, exit" preselected. Print mode never shows it. */
export const TRUST_MARKER = 'trust this folder';

/** The trust dialog is the open start dialog (see startDialog): its yes row is the last anchor on
 *  screen, with "No, exit" next to it. A trust frame left in the history above a later dialog is not
 *  open, so Enter goes to neither by mistake. */
export function trustDialogOpen(pane: string): boolean {
  const d = startDialog(pane, TRUST_MARKER, TRUST_ANSWERS);
  return !!d && d.lines.slice(Math.max(0, d.at - 3), d.at + 4).some((l) => l.includes('No, exit'));
}

/** The open trust dialog's cursor is on the "yes" row, so Enter accepts and nothing else. */
export function trustAccepted(pane: string): boolean {
  const d = startDialog(pane, TRUST_MARKER, TRUST_ANSWERS);
  return !!d && d.cursor === d.at;
}

/** A folder whose CLAUDE.md imports a file outside it (every profile does: the shared doctrine in
 *  `_shared/`) opens a second dialog on first run, "Allow external CLAUDE.md file imports?", with
 *  "No, disable external imports" preselected. Measured on claude 2.1.278: a profile in a folder
 *  Claude has not seen before sits on this screen until it is answered. */
export const IMPORTS_MARKER = 'Allow external CLAUDE.md file imports?';

export function importsDialogOpen(pane: string): boolean {
  const d = startDialog(pane, IMPORTS_MARKER, IMPORTS_ANSWERS);
  return !!d && d.lines.slice(d.at + 1).some((l) => l.includes('disable external imports'));
}

/** The cursor is on "Yes, allow external imports" of the open dialog, so Enter accepts and nothing else. */
export function importsAccepted(pane: string): boolean {
  const d = startDialog(pane, IMPORTS_MARKER, IMPORTS_ANSWERS);
  return !!d && d.lines[d.cursor].includes('allow external imports');
}

/** A folder passed with `--add-dir` that Claude Code has not worked in opens its own dialog before
 *  the first prompt, "Adding a new directory:" with the folder on the next line and "No, exit"
 *  preselected. New in claude 2.1.326 (2026-11-16): every new session of a profile with add_dirs sat
 *  on it until the start timed out, so those chats got no answer. */
export const ADD_DIR_MARKER = 'Adding a new directory:';

/** A long session resumed after an idle hour may open "Resume this conversation?" before the prompt,
 *  with "Resume" and "Start a new conversation" (a customer's pane on claude 2.1.329; the words and keys
 *  read in the 2.1.332 program text). Which row starts highlighted differs: "Resume", the new
 *  conversation, or none. A running idle session has a form of it too: no row numbers, and its foot says
 *  "Esc to dismiss" (program text; not seen on a screen). */
export const RESUME_MARKER = 'Resume this conversation?';

/** Each start dialog is found by one line (anchorOf): the resume, add-dir and imports titles, and the trust
 *  dialog's yes row (its title has changed between versions: "Accessing workspace:" on 2.1.326). Its
 *  answers are the rows the cursor may be on. */
const TRUST_ANSWERS = ['No, exit', TRUST_MARKER];
const IMPORTS_ANSWERS = ['disable external imports', 'allow external imports'];
const ADD_DIR_ANSWERS = ['No, exit', 'Yes, add it'];

/** Which start dialog `line` anchors, if any. A title must open its line (after the border and
 *  indent): a folder shown as "/x/Adding a new directory: /listed" names the dialog, it is not one. */
function anchorOf(line: string): string | null {
  const t = line.replace(/[│┃║]/g, '').trimStart();
  if (t.startsWith(ADD_DIR_MARKER)) return ADD_DIR_MARKER;
  if (t.startsWith(IMPORTS_MARKER)) return IMPORTS_MARKER;
  if (t.startsWith(RESUME_MARKER)) return RESUME_MARKER;
  return line.includes(TRUST_MARKER) ? TRUST_MARKER : null;
}

/** The open start dialog found by `marker`: its lines, the anchor's index and the cursor's line, or
 *  null when another start dialog, or none, is the one open. The dialog is drawn at the foot of the
 *  screen, so the last anchor of any start dialog is the live one; an earlier one is history (a
 *  resumed conversation that quotes the dialog, or the frame of a dialog already answered). A screen
 *  with an input box below the anchor is past every dialog: the quote is in the conversation above
 *  the prompt. And the last ❯ on screen must be one of this dialog's `answers`: under an answered
 *  frame another dialog (a permission prompt) holds the cursor, and Enter would answer that one. */
function startDialog(pane: string, marker: string, answers: string[]): { lines: string[]; at: number; cursor: number } | null {
  const lines = pane.replace(/\n+$/, '').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (anchorOf(lines[i])) at = i;
  if (at < 0 || anchorOf(lines[at]) !== marker) return null;
  if (inputBoxStrict(lines.slice(at + 1).join('\n')) !== null) return null;
  // The trust dialog's anchor is its yes row, with "No, exit" just above it; the others are titles.
  const cursor = lastLine(lines, /❯/, lines.length);
  if (cursor < (marker === TRUST_MARKER ? at - 3 : at + 1) || !answers.some((a) => lines[cursor].includes(a))) return null;
  return { lines, at, cursor };
}

/** An option row of the resume dialog, as drawn: maybe the cursor, maybe a number, then the label. */
const RESUME_ROW = /^(?:❯\s*)?(?:\d\.\s*)?Resume(?:\s{2,}.*)?$/;
const NEW_ROW = /^(?:❯\s*)?(?:\d\.\s*)?Start a new conversation(?:\s{2,}.*)?$/;

/** The open resume dialog, or null. It is the last start dialog on screen, with no input box below it,
 *  both options drawn under its title, and no cursor on any other row below it. `esc`: its foot says
 *  Esc resumes or dismisses. `onResume`: the cursor is on "Resume", so Enter resumes and nothing else. The numbers
 *  and times in its sentence are not read. */
export function resumeDialog(pane: string): { esc: boolean; onResume: boolean } | null {
  const lines = pane.replace(/\n+$/, '').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (anchorOf(lines[i])) at = i;
  if (at < 0 || anchorOf(lines[at]) !== RESUME_MARKER) return null;
  if (inputBoxStrict(lines.slice(at + 1).join('\n')) !== null) return null;
  const below = lines.slice(at + 1).map((l) => l.replace(/[│┃║]/g, '').trim());
  if (!below.some((l) => RESUME_ROW.test(l)) || !below.some((l) => NEW_ROW.test(l))) return null;
  const cursor = [...below].reverse().find((l) => l.includes('❯'));
  if (cursor !== undefined && !RESUME_ROW.test(cursor) && !NEW_ROW.test(cursor)) return null;
  return { esc: below.some((l) => l.includes('Esc to resume') || l.includes('Esc to dismiss')), onResume: cursor !== undefined && RESUME_ROW.test(cursor) };
}

/** The folder the add-dir dialog asks about, or null when that dialog is not open. Both answers must
 *  be drawn below its title: one line that merely names the dialog is not the dialog. */
export function addDirDialog(pane: string): string | null {
  const d = startDialog(pane, ADD_DIR_MARKER, ADD_DIR_ANSWERS);
  if (!d) return null;
  const { lines, at } = d;
  const below = lines.slice(at + 1);
  if (!below.some((l) => l.includes('No, exit')) || !below.some((l) => l.includes('Yes, add it'))) return null;
  // The folder is on the title's line or on the first line below it that has text: the real frame
  // puts a blank line between (2.1.326), and a bordered frame draws │ on each side.
  const strip = (l: string) => l.replace(/[│┃║]/g, '').trimEnd();
  const inline = strip(lines[at].slice(lines[at].indexOf(ADD_DIR_MARKER) + ADD_DIR_MARKER.length));
  let first = at;
  if (!inline.trim()) { first = lines.findIndex((l, i) => i > at && i < at + 4 && strip(l).trim()); if (first < 0) return ''; }
  const head = first === at ? inline : strip(lines[first]);
  // A folder longer than the pane wraps onto the next lines: claude 2.1.326 (Ink) wraps at column 219
  // of a 220-column pane and indents each continuation as far as the first line. Read on to the next
  // blank line (or the answers) and take that indent off, or a listed folder would match the head of
  // a longer one. A folder with a space at the wrap reads with a space too many: refused, never yes.
  const indent = head.length - head.trimStart().length;
  let dir = head.trim();
  for (let i = first + 1; i < lines.length; i++) {
    const more = strip(lines[i]);
    if (!more.trim() || more.includes('No, exit') || more.includes('Yes, add it')) break;
    dir += more.startsWith(' '.repeat(indent)) ? more.slice(indent) : more.trimStart();
  }
  return dir;
}

/** The cursor is on "Yes, add it" of the open add-dir dialog, so Enter accepts and nothing else. */
export function addDirAccepted(pane: string): boolean {
  const d = startDialog(pane, ADD_DIR_MARKER, ADD_DIR_ANSWERS);
  return !!d && d.lines[d.cursor].includes('Yes, add it');
}

/** The pasted text (or its collapsed chip) is in the input box, so Enter submits that and
 *  nothing else. Never press Enter without this. `rows`: the pane's height (chipFits), when known. */
export function pasteLanded(pane: string, text: string, rows?: number): boolean {
  const box = inputBox(pane);
  // A chip of another paste is not this one: an Enter on it would send that paste (review-keymiss).
  if (box.includes(PASTED_MARKER) && (loneChipOf(pane, text, rows) || chipOf(box, text))) return true;
  const head = text.split(/\s+/).join(' ').slice(0, 24);
  return head.length > 0 && box.split(/\s+/).join(' ').includes(head);
}

/**
 * Press Enter on a pasted message and make sure Claude took it. A Claude Code that is still starting can
 * drop that Enter and leave the text in the box with nothing running (seen on a fresh pane, 2.1.296,
 * master 2026-10-10). Taken means the box no longer holds the text, a turn runs, or a dialog opened.
 * Enter is pressed again only while the text still sits in an idle box with no dialog on screen: an
 * Enter that reached a dialog would answer it. False after `tries` presses: the caller clears the box
 * and says so, rather than wait on a turn that never started.
 */
export async function submitPasted(
  text: string,
  capture: () => Promise<string>,
  enter: () => Promise<unknown>,
  o: { tries?: number; polls?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; rows?: () => number | undefined } = {},
): Promise<boolean> {
  const { tries = 3, polls = 6, pollMs = 250 } = o;
  const nap = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let t = 0; t < tries; t++) {
    await enter();
    let last = '';
    for (let p = 0; p < polls; p++) {
      await nap(pollMs);
      const pane = await capture();
      if (!pane) return false; // the pane is gone
      if (paneBusy(pane) || permissionDialog(pane) || !pasteLanded(pane, text, o.rows?.())) return true;
      last = pane;
    }
    // Pressed again only while the box holds the text alone: text typed after it meanwhile, or a chip
    // pasted with it, would go with it (review-keymiss, 0.4.8).
    if (!boxHoldsOnly(last, text, o.rows?.())) return false;
  }
  return false;
}

/** A rule may carry the session's name near its right end once the session is named
 *  (`───── trip-planning ─`, measured 2026-09-21); without it a named session's box is never
 *  found and every paste is judged not landed. While Up calls back an earlier prompt, the top rule
 *  says so near its left end (`─── History 2/2 ─────`, measured on 2.1.332, 2026-11-27): without it
 *  that screen had no box, read as not idle, and the prompt in it was never cleared. */
const RULE_RE = /^\s*(?:─{10,}(\s+\S.{0,80}?\s+─+)?|─{3}\s+History\s+\d+\/\d+\s+─{10,})\s*$/;

/** The input box only: the lines between the last two horizontal rules. Everything above them is
 *  the conversation, where every submitted prompt is echoed with the same `❯`, so a match there
 *  proves nothing about what Enter would submit. Without two rules, the last three lines. */
export function inputBox(pane: string): string {
  return inputBoxStrict(pane) ?? pane.replace(/\n+$/, '').split('\n').slice(-3).join('\n');
}

/** The screen draws an input box: false for a dialog or a menu, which replaces it. */
export function paneHasBox(pane: string): boolean { return inputBoxStrict(pane) !== null; }

/** The input box, or null when the screen has none: between the last two rules, or, in the older
 *  drawing, inside the last `╭…╰` frame. A dialog draws neither. */
function inputBoxStrict(pane: string): string | null {
  const lines = pane.replace(/\n+$/, '').split('\n');
  const box = boxSpan(lines);
  return box ? lines.slice(box.top + 1, box.bottom).join('\n') : null;
}

/** The screen down to the input box's bottom border, without what is drawn under the box: the status
 *  rows and the list of teammates, whose clocks tick while the session itself stands still. The whole
 *  capture when the screen has no box. For telling whether the session's own part of the screen moved. */
export function paneAboveFoot(pane: string): string {
  const lines = pane.replace(/\n+$/, '').split('\n');
  const box = boxSpan(lines);
  return box ? lines.slice(0, box.bottom + 1).join('\n') : pane;
}

/** Where the input box is drawn: the lines of its top and bottom border, or null without a box. */
function boxSpan(lines: string[]): { top: number; bottom: number } | null {
  const rules = lines.flatMap((l, i) => (RULE_RE.test(l) ? [i] : []));
  if (rules.length >= 2) return { top: rules[rules.length - 2], bottom: rules[rules.length - 1] };
  const bottom = lastLine(lines, /^\s*╰/, lines.length);
  const top = bottom > 0 ? lastLine(lines, /^\s*╭/, bottom) : -1;
  return top >= 0 ? { top, bottom } : null;
}

function lastLine(lines: string[], re: RegExp, before: number): number {
  for (let i = before - 1; i >= 0; i--) if (re.test(lines[i])) return i;
  return -1;
}
