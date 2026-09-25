# ADR 0011 — pi as a backend

Status: accepted 2026-09-25.

ADR 0006 asks three facts of any new backend. All three were measured on 2026-09-25 against pi
0.86.1 in RPC mode, with `xai/grok-4.3`.

## The three facts

- **Resume by id.** `--session-id <id>` creates the session under that exact id when it is missing
  and resumes it when it exists. Angelia mints the id, as it does for Claude Code, so no row rename.
  A resume replays nothing (grok's ACP `session/load` replays the whole history).
- **Permission prompt without a TTY.** pi has none, by design. An extension's `tool_call` hook can
  block a call, and `ctx.ui.confirm()` becomes an `extension_ui_request` on stdout in RPC mode,
  answered with `extension_ui_response {id, confirmed}`. Angelia ships that extension
  (`src/brain/pi-gate.ts`) and loads it with `-e`; the chat relay is the one the other backends use.
- **Multi-turn process.** `pi --mode rpc` takes one `{type:"prompt"}` line per turn; `agent_settled`
  ends a turn. One to four seconds a turn on this machine.

## What else was measured

- `--append-system-prompt` is honoured in RPC mode, so the self prompt goes on argv, as for Claude.
- pi reads CLAUDE.md and AGENTS.md from the folder and its parents, trust or not.
- Sessions live in `~/.pi/agent/sessions/--<cwd>--/<time>_<id>.jsonl`, looked up per folder. The
  same id from another folder starts an empty session and prints "No project session found" on
  stderr; PiBrain turns that into the lost-session line.
- A provider error arrives as an assistant `message_end` with `stopReason: "error"`.
- pi's RPC records are split on `\n` only: its docs warn that Node's readline also splits on
  U+2028 and U+2029, which are valid inside a JSON string.
- A Claude subscription used through pi now fails: Anthropic answers that third-party apps draw from
  extra usage.

## The gate

The permission mode, the deny rules and the extra folders reach the gate in `ANGELIA_PI_POLICY`: the
rules `angelia compile` writes to `.claude/settings.json` (the launch guard checks them before every
start), in grok's `/abs` form, and its additionalDirectories (`_common/`, directory capabilities),
with the owner's own `settings.local.json` merged in. Without a valid policy no tool runs. The gate
also turns on pi's own `grep`, `find` and `ls` tools (off by default in pi 0.86.1), so the model
does not search through the shell, which would ask the owner every time.

- Paths are read the way pi's tools read them (a leading `@`, `file://`, `~`, Unicode spaces, and
  for `read` its fallback spellings: NFD, a curly apostrophe, a narrow space before AM/PM), resolved
  one component at a time as the OS does (a relative link against its real folder, dangling links
  followed), and compared by file identity, device and inode. Text is compared, folded the way APFS
  folds names (`ſ` is `s`, `ß` is `ss`), only for paths that do not exist yet.
- Read tools (`read`, `grep`, `find`, `ls`) run unless a denied path is the target, or, for a
  `grep` walk, lies under it; a `find` over such a folder lists only names and asks instead.
- `edit` and `write`: bypass runs them, acceptEdits runs them inside the profile's folders, the rest ask.
- `bash`: bypass runs it, acceptEdits runs only a short list of commands (`ls`, `cat`, `head`,
  `wc`, `echo`, …) with nothing a shell expands and every path inside the profile's folders; the
  rest ask. The command's words are read as a shell would (quotes, `$'..'` escapes and backslashes
  resolved, `~` and `$HOME` expanded only where bash expands them); one that reaches a Read-denied
  path is refused, as is a path glued to an option (`-f/path`) and a glob whose segments could match
  the names down to one, as bash matches (a leading wildcard skips dot names). Glob syntax the gate
  does not model (nested braces, ranges, classes) counts as reaching. A heredoc body is text unless
  it goes to a shell or an interpreter, which runs it: then it is checked like the command. A command
  with more than 400 path-like words asks (is refused under bypass). One that builds the path itself
  gets through: not a sandbox. No command runs longer than 600 s; pi's own bash has no limit.
- Known limits, on purpose: a rule on a folder does not follow a hard link to a file inside it
  placed elsewhere (making one needs the shell, which asks outside bypass); and under bypass a
  shell command may still write into `.pi/`, as it may run anything. Bypass is for folders with
  nothing to protect.
- plan: `--tools read,grep,find,ls` on argv, and the gate refuses anything else.
- A tool some other extension added asks, except under bypass.
- A refusal tells the model it did not run: in the first probe, the model reported a denied command
  as done.

A fresh-context review on 2026-09-25 found the first version of the gate compared paths as text and
let several read-only commands write or run code. A second one found the fix still compared text:
a relative link under a linked folder, `ſ`/`ß` spellings and the read tool's fallbacks got past it.
A normal-use QA pass and a code review on the same day added the search tools, `/compact`, the
extra folders, the heredoc and glued-option rules, a linear glob matcher in place of regexes the
model could make slow, the fail-closed policy, the version check and per-decision caching.
The rules above are the result, each bypass with a test.

## Consequences

- `backend: pi` in the table; `src/brain/pi.ts`, `piArgv`, the gate, `piRows` for export.
- A compiled profile's skills go to pi as `--skill <path>`; pi ignores Claude's skills folder.
- No MCP and no sandbox on pi: compile says so in a note.
- For pi, compile also denies edits to `.pi/` and `.agents/` in the profile folder: pi loads code
  and settings from there on the next start. pi's and grok's login files are in every profile's floor.
- A prompt pi takes without starting a run (an extension command such as `/llama`) would never
  settle: PiBrain asks `get_state` a second after pi accepted it and ends the turn with whatever
  the command said. `/compact` goes to pi's own compact command, not to the model.
- pi older than 0.80.4 (the first with `agent_settled`) is refused with that reason.
- `PI_CODING_AGENT_DIR` moves pi's logins and sessions; the floor and export assume the default.
- The user's own pi extensions still load. A folder's `.pi/` resources load only once the owner has
  trusted the folder in pi; Angelia never passes `--approve`.
