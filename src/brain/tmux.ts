import { execFile } from 'node:child_process';

/** Angelia's own tmux server. Sessions on this socket outlive the daemon, so a restart — or the
 *  crash the launchd unit is meant to catch — leaves every agent exactly where it was, and nothing
 *  else on the machine shares the socket. ANGELIA_TMUX_SOCKET moves it (tests). */
export const TMUX_SOCKET = process.env.ANGELIA_TMUX_SOCKET ?? 'angelia';

export interface TmuxResult { code: number; out: string; err: string }

export function tmux(args: string[], opts: { bin?: string; socket?: string; env?: NodeJS.ProcessEnv } = {}): Promise<TmuxResult> {
  return new Promise((resolve) => {
    execFile(opts.bin ?? 'tmux', ['-L', opts.socket ?? TMUX_SOCKET, ...args], { env: opts.env, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const code = err ? Number((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
      resolve({ code, out: stdout ?? '', err: stderr ?? '' });
    });
  });
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
 *  a full-width rule, title first, then the command and why it is being run:
 *
 *      ──────────────────────────────────────────
 *       Bash command
 *
 *         touch /Users/example/probe.txt
 *         Create probe file outside working directory
 *
 *       Do you want to proceed?
 *       ❯ 1. Yes
 *
 *  so everything between that rule and the question is the dialog, and the transcript above it is
 *  not. Measured on claude 2.1.278; the fixture is in tests/fixtures. */
export function permissionDialog(pane: string): { tool: string; preview: string } | null {
  const raw = pane.split('\n');
  // The last one: the dialog is drawn at the foot of the screen, and the agent's own output above it
  // may quote the question, which would otherwise be read as the prompt.
  const at = lastLine(raw, new RegExp(PERMISSION_MARKER.replace(/[?]/g, '\\?')), raw.length);
  if (at < 0) return null;
  let top = -1;
  for (let i = at - 1; i >= 0 && i >= at - 16; i--) if (/^[\s│]*[─━╭]{8,}/.test(raw[i])) { top = i; break; }
  const body = raw.slice(top >= 0 ? top + 1 : Math.max(0, at - 6), at).map(clean).filter(Boolean);
  if (!body.length) return { tool: 'tool', preview: 'a permission prompt is open' };
  return { tool: body[0].slice(0, 40), preview: (body.slice(1).join(' · ') || body[0]).slice(0, 300) };
}

/** A directory Claude Code has not been run in before opens a trust dialog before the first
 *  prompt, with "No, exit" preselected. Print mode never shows it. */
export const TRUST_MARKER = 'trust this folder';

export function trustDialogOpen(pane: string): boolean {
  return pane.includes(TRUST_MARKER) && pane.includes('No, exit');
}

/** The trust dialog's cursor is on the "yes" row, so Enter accepts and nothing else. */
export function trustAccepted(pane: string): boolean {
  return pane.split('\n').some((l) => l.includes('❯') && l.includes(TRUST_MARKER));
}

/** A folder whose CLAUDE.md imports a file outside it (every profile does: the shared doctrine in
 *  `_shared/`) opens a second dialog on first run, "Allow external CLAUDE.md file imports?", with
 *  "No, disable external imports" preselected. Measured on claude 2.1.278: a profile in a folder
 *  Claude has not seen before sits on this screen until it is answered. */
export const IMPORTS_MARKER = 'Allow external CLAUDE.md file imports?';

export function importsDialogOpen(pane: string): boolean {
  return pane.includes(IMPORTS_MARKER) && pane.includes('disable external imports');
}

/** The cursor is on "Yes, allow external imports", so Enter accepts and nothing else. */
export function importsAccepted(pane: string): boolean {
  return pane.split('\n').some((l) => l.includes('❯') && l.includes('allow external imports'));
}

/** The pasted text (or its collapsed chip) is in the input box, so Enter submits that and
 *  nothing else. Never press Enter without this. */
export function pasteLanded(pane: string, text: string): boolean {
  const box = inputBox(pane);
  if (box.includes(PASTED_MARKER)) return true;
  const head = text.split(/\s+/).join(' ').slice(0, 24);
  return head.length > 0 && box.split(/\s+/).join(' ').includes(head);
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
