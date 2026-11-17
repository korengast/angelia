import { execFile } from 'node:child_process';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

export interface TmuxResult { code: number; out: string; err: string }

export function tmux(args: string[], opts: { bin?: string; socket?: string; env?: NodeJS.ProcessEnv } = {}): Promise<TmuxResult> {
  return new Promise((resolve) => {
    execFile(opts.bin ?? 'tmux', ['-L', opts.socket ?? TMUX_SOCKET, ...args], { env: opts.env, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const code = err ? Number((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
      resolve({ code, out: stdout ?? '', err: stderr ?? '' });
    });
  });
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
const BUSY_RE = /^\S{1,2} \S+…/;
const DONE_RE = /^\S{1,2} \S+ for \S+.* · done/;
/** The spinner is always drawn just above the input box, so only the foot of the pane counts.
 *  Further up it would be scrollback — an old assistant line ending in "…" would otherwise read
 *  as a turn that never finishes, and nothing could ever be typed again. */
const TAIL_LINES = 14;
/** Claude collapses a long paste into a chip like `[Pasted text +12 lines]`. */
export const PASTED_MARKER = '[Pasted text';

export function paneBusy(pane: string): boolean {
  let busy = false;
  for (const line of pane.split('\n').slice(-TAIL_LINES)) {
    if (DONE_RE.test(line)) busy = false;
    else if (BUSY_RE.test(line)) busy = true;
  }
  return busy;
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
export function permissionDialog(pane: string): { tool: string; preview: string } | null {
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
  return { tool: body[0].slice(0, 40), preview: (body.slice(1).join(' · ') || body[0]).slice(0, 300) };
}

/** A directory Claude Code has not been run in before opens a trust dialog before the first
 *  prompt, with "No, exit" preselected. Print mode never shows it. */
export const TRUST_MARKER = 'trust this folder';

/** The trust dialog is the open start dialog (see startDialog): its yes row is the last anchor on
 *  screen, with "No, exit" next to it. A trust frame left in the history above a later dialog is not
 *  open, so Enter goes to neither by mistake. */
export function trustDialogOpen(pane: string): boolean {
  const d = startDialog(pane, TRUST_MARKER);
  return !!d && d.lines.slice(Math.max(0, d.at - 3), d.at + 4).some((l) => l.includes('No, exit'));
}

/** The open trust dialog's cursor is on the "yes" row, so Enter accepts and nothing else. */
export function trustAccepted(pane: string): boolean {
  const d = startDialog(pane, TRUST_MARKER);
  return !!d && d.lines[d.at].includes('❯');
}

/** A folder whose CLAUDE.md imports a file outside it (every profile does: the shared doctrine in
 *  `_shared/`) opens a second dialog on first run, "Allow external CLAUDE.md file imports?", with
 *  "No, disable external imports" preselected. Measured on claude 2.1.278: a profile in a folder
 *  Claude has not seen before sits on this screen until it is answered. */
export const IMPORTS_MARKER = 'Allow external CLAUDE.md file imports?';

export function importsDialogOpen(pane: string): boolean {
  const d = startDialog(pane, IMPORTS_MARKER);
  return !!d && d.lines.slice(d.at + 1).some((l) => l.includes('disable external imports'));
}

/** The cursor is on "Yes, allow external imports" of the open dialog, so Enter accepts and nothing else. */
export function importsAccepted(pane: string): boolean {
  const d = startDialog(pane, IMPORTS_MARKER);
  return !!d && d.lines.slice(d.at + 1).some((l) => l.includes('❯') && l.includes('allow external imports'));
}

/** A folder passed with `--add-dir` that Claude Code has not worked in opens its own dialog before
 *  the first prompt, "Adding a new directory:" with the folder on the next line and "No, exit"
 *  preselected. New in claude 2.1.326 (2026-11-16): every new session of a profile with add_dirs sat
 *  on it until the start timed out, so those chats got no answer. */
export const ADD_DIR_MARKER = 'Adding a new directory:';

/** The lines that find each start dialog: the add-dir and imports titles, and the trust dialog's yes
 *  row (its title has changed between versions: "Accessing workspace:" on 2.1.326). */
const START_ANCHORS = [TRUST_MARKER, IMPORTS_MARKER, ADD_DIR_MARKER];

/** The open start dialog found by `marker`: its lines and the anchor's index, or null when another
 *  start dialog, or none, is the one open. The dialog is drawn at the foot of the screen, so the last
 *  anchor of any start dialog is the live one; an earlier one is history (a resumed conversation that
 *  quotes the dialog, or the frame of a dialog already answered). A screen with an input box below
 *  the anchor is past every dialog: the quote is in the conversation above the prompt. */
function startDialog(pane: string, marker: string): { lines: string[]; at: number } | null {
  const lines = pane.replace(/\n+$/, '').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (START_ANCHORS.some((m) => lines[i].includes(m))) at = i;
  if (at < 0 || !lines[at].includes(marker)) return null;
  if (inputBoxStrict(lines.slice(at + 1).join('\n')) !== null) return null;
  return { lines, at };
}

/** The folder the add-dir dialog asks about, or null when that dialog is not open. Both answers must
 *  be drawn below its title: one line that merely names the dialog is not the dialog. */
export function addDirDialog(pane: string): string | null {
  const d = startDialog(pane, ADD_DIR_MARKER);
  if (!d) return null;
  const { lines, at } = d;
  const below = lines.slice(at + 1);
  if (!below.some((l) => l.includes('No, exit')) || !below.some((l) => l.includes('Yes, add it'))) return null;
  // The folder is on the title's line or on the first line below it that has text: the real frame
  // puts a blank line between (2.1.326), and a bordered frame draws │ on each side.
  const text = (l: string) => l.replace(/[│┃║]/g, '').trim();
  const inline = text(lines[at].slice(lines[at].indexOf(ADD_DIR_MARKER) + ADD_DIR_MARKER.length));
  let first = at;
  if (!inline) { first = lines.findIndex((l, i) => i > at && i < at + 4 && text(l)); if (first < 0) return ''; }
  // A folder longer than the pane wraps onto the next lines, and the wrap adds no character: read on
  // to the next blank line (or the answers), or a listed folder would match the head of a longer one.
  let dir = inline || text(lines[first]);
  for (let i = first + 1; i < lines.length; i++) {
    const more = lines[i].replace(/[│┃║]/g, '').trimEnd();
    if (!more.trim() || more.includes('No, exit') || more.includes('Yes, add it')) break;
    dir += lines[i].trimStart().startsWith('│') ? more.trim() : more;
  }
  return dir;
}

/** The cursor is on "Yes, add it" of the open add-dir dialog, so Enter accepts and nothing else. */
export function addDirAccepted(pane: string): boolean {
  const d = startDialog(pane, ADD_DIR_MARKER);
  return !!d && d.lines.slice(d.at + 1).some((l) => l.includes('❯') && l.includes('Yes, add it'));
}

/** The pasted text (or its collapsed chip) is in the input box, so Enter submits that and
 *  nothing else. Never press Enter without this. */
export function pasteLanded(pane: string, text: string): boolean {
  const box = inputBox(pane);
  if (box.includes(PASTED_MARKER)) return true;
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
  o: { tries?: number; polls?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const { tries = 3, polls = 6, pollMs = 250 } = o;
  const nap = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let t = 0; t < tries; t++) {
    await enter();
    for (let p = 0; p < polls; p++) {
      await nap(pollMs);
      const pane = await capture();
      if (!pane) return false; // the pane is gone
      if (paneBusy(pane) || permissionDialog(pane) || !pasteLanded(pane, text)) return true;
    }
  }
  return false;
}

/** A rule may carry the session's name near its right end once the session is named
 *  (`───── trip-planning ─`, measured 2026-09-21); without it a named session's box is never
 *  found and every paste is judged not landed. */
const RULE_RE = /^\s*─{10,}(\s+\S.{0,80}?\s+─+)?\s*$/;

/** The input box only: the lines between the last two horizontal rules. Everything above them is
 *  the conversation, where every submitted prompt is echoed with the same `❯`, so a match there
 *  proves nothing about what Enter would submit. Without two rules, the last three lines. */
export function inputBox(pane: string): string {
  return inputBoxStrict(pane) ?? pane.replace(/\n+$/, '').split('\n').slice(-3).join('\n');
}

/** The input box, or null when the screen has none: between the last two rules, or, in the older
 *  drawing, inside the last `╭…╰` frame. A dialog draws neither. */
function inputBoxStrict(pane: string): string | null {
  const lines = pane.replace(/\n+$/, '').split('\n');
  const rules = lines.flatMap((l, i) => (RULE_RE.test(l) ? [i] : []));
  if (rules.length >= 2) return lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).join('\n');
  const bottom = lastLine(lines, /^\s*╰/, lines.length);
  const top = bottom > 0 ? lastLine(lines, /^\s*╭/, bottom) : -1;
  return top >= 0 ? lines.slice(top + 1, bottom).join('\n') : null;
}

function lastLine(lines: string[], re: RegExp, before: number): number {
  for (let i = before - 1; i >= 0; i--) if (re.test(lines[i])) return i;
  return -1;
}
