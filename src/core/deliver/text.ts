export const FAILURE_LINE = 'Something broke on my side. Try again, or /new.';

/** The failure line with the reason the daemon logged, so the chat can tell a lost login from a
 *  dead pane without a terminal. The home folder is written as `~`: the reason often names the
 *  profile's cwd, and a group has members who are not the owner. For the same members, a group
 *  never sees the last line of the agent's error output ("exit: …"), which can quote anything. */
export function failureLine(reason?: string, home?: string, group = false): string {
  let r = (reason ?? '').trim().replace(/\s+/g, ' ');
  if (group && r.startsWith('exit:')) r = 'exit';
  if (!r || r === 'exception') return FAILURE_LINE;
  const said = r === 'exit' ? 'the agent exited without answering' : r;
  const tidy = home ? said.split(home).join('~') : said;
  return `Something broke on my side (${tidy.slice(0, 300)}). Try again, or /new.`;
}
export const PERMISSION_TIMEOUT_LINE = 'No answer to the permission request in time, so it was denied.';
export const UNMATCHED_LINE = '[Angelia] This chat is not routed to a profile.';
export const NOT_OWNER_LINE = 'Only an owner of this chat can do that.';

export function permissionLine(id: string, tool: string, preview: string): string {
  const short = id.slice(0, 8);
  return `🔐 ${tool}: ${preview}\nReply "yes ${short}" or "no ${short}".`;
}

export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([0-9a-f-]{5,40})\s*$/i;

export function parsePermissionReply(text: string): { id: string; allow: boolean } | null {
  const m = PERMISSION_REPLY_RE.exec(text);
  if (!m) return null;
  return { id: m[2], allow: /^y/i.test(m[1]) };
}

/**
 * A CLI that ran out of its usage allowance answers with one short line ("You've reached your Fable
 * limit…"). Kept short on purpose: a long agent reply that merely talks about limits is not one.
 */
const LIMIT = /(reached|hit|exceeded) (your|the) [\w .-]{0,40}limit|usage limit|out of (usage|credits)|quota (exceeded|exhausted)|rate[ _-]?limit(ed)?\b|model_requires_usage_credits/i;

export function isLimitText(text: string): boolean {
  return text.length > 0 && text.length <= 400 && LIMIT.test(text);
}

/** What to add under a limit message: how to keep going on another model now. */
export function limitHint(backend: string): string {
  return backend === 'claude-code'
    ? 'To keep going now, switch model for this session: send /model opus (or /model sonnet). /model default goes back once the limit resets.'
    : 'To keep going now, switch model for this session: send /model <name>. /model default goes back once the limit resets.';
}
