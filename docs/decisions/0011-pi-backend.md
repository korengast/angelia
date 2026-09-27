# ADR 0011 — pi as a backend

Status: accepted 2026-09-25; the shell check replaced by the OS sandbox 2026-09-27.

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
- A Claude subscription used through pi draws on extra usage, and fails without it: Anthropic answers
  that third-party apps draw from extra usage.

## The gate and the sandbox

Revised 2026-09-27. The first gate (2026-09-25) also read each shell command for denied paths. Five
review rounds each found a new spelling, and every fix added parser code that opened new gaps: a text
check of a shell command never converges. It is gone. The deny rules are now held in two places,
each of which can be complete.

**pi's file tools, by the gate.** The permission mode, the deny rules and the extra folders reach
the gate in `ANGELIA_PI_POLICY`: the rules `angelia compile` writes to `.claude/settings.json` (the
launch guard checks them before every start), in grok's `/abs` form, and its additionalDirectories
(`_common/`, directory capabilities), with the owner's own `settings.local.json` merged in. Without a
valid policy no tool runs. The gate also turns on pi's own `grep`, `find` and `ls` tools (off by
default in pi 0.86.1), so the model does not search through the shell.

- Paths are read the way pi's tools read them (a leading `@`, `file://`, `~`, Unicode spaces, and
  for `read` its fallback spellings: NFD, a curly apostrophe, a narrow space before AM/PM), resolved
  one component at a time as the OS does (a relative link against its real folder, dangling links
  followed), and compared by file identity, device and inode. Text is compared, folded the way APFS
  folds names (`ſ` is `s`, `ß` is `ss`), only for paths that do not exist yet.
- Read tools (`read`, `grep`, `find`, `ls`) run unless a denied path is the target, or, for a
  `grep` walk, lies under it; a `find` over such a folder lists only names and asks instead.
- `edit` and `write`: bypass runs them, acceptEdits runs them inside the profile's folders, the rest ask.
- The check comes before pi opens the file, in pi's own process: a command left running in the
  background could swap a checked file for a link to a denied one in between (the third review won
  that race 11 times in 4 seconds). So with the sandbox on, the gate replaces the disk access of
  `read`, `write` and `edit` (pi's documented `operations`) with programs run under the same
  sandbox-exec profile as a command: `cat`, `test`, `mkdir`, `sh -c 'cat > "$1"'`. The kernel then
  holds the rules at the open. An approved write or edit uses the approved profile, any other the
  unasked one. A pi whose package the gate cannot load runs none of the three.

**Every shell command, by the kernel.** The gate hands pi's bash tool
`exec /usr/bin/env ANGELIA_SANDBOX=pi /usr/bin/sandbox-exec -p '<profile>' "$0" -c '<command>'`:
the same command, in the same shell, inside macOS's sandbox (Seatbelt). The profile is made from the
same rules: everything allowed except what they deny. A Read rule closes reading (listing and stat
too), writing and connecting to a Unix socket under the path; an Edit rule closes every kind of
write. A rule path is given as written and as the OS resolves it; a rule with a glob becomes a regex
with ASCII case folded, and a glob it does not model (classes, nested braces, ranges, a brace group
holding a `/`, letters outside ASCII) closes the whole fixed folder. Angelia's own tmux socket is closed too: other
profiles' agents run there.

- Two profiles. A command that runs unasked (every one in bypass; in acceptEdits the short read-only
  list) may write only in the profile's folders (cwd, add_dirs, `_common/`, directory capabilities),
  its own cache folder (`cache/pi/<hash>` in Angelia's state; npm, pip, uv and XDG caches point
  there) and temp (`/tmp` and the user's own `$TMPDIR`, not the rest of `/var/folders`): the
  confinement Codex's sandbox and Claude Code's apply. A command the owner approved, having read it,
  may write elsewhere; the deny rules hold for both. In bypass the gate holds pi's `write` and `edit`
  to the same folders, or the file tool would be the way around. The other pi profiles' cache
  folders are closed to both layers. Measured in the confined profile: `cc`, `make`, `git commit`,
  `python3 -m venv` and `pip install`, `npm install` and `npx`, `curl -o` work.
- In the confined profile a command cannot write what git runs later, outside any sandbox, when
  someone runs git there: a repo's `.git/config`, its hooks and `info/attributes`, or a new `.git`
  (so `git init` and a `gitdir:` file are refused; commits work). Codex keeps `.git` read-only in its
  writable folders for the same reason. Still open, as for the other backends: `.envrc`, `package.json`
  scripts, Makefiles.
- The ssh agent's socket is closed and `SSH_AUTH_SOCK` is not passed: a key loaded in the agent would
  otherwise sign for a command that cannot read `~/.ssh`.
- The network is open. Claude Code's sandbox also limits the shell's hosts
  (`sandbox.network.allowedDomains`); pi's does not, and compile says so for a pi profile with
  `sandbox: true`.
- The kernel matches paths, so a folder above a rule could be renamed and the protected files read or
  changed under the new name (the second review showed it, for the parents of `~/.config/gh`, the
  state folder, a lone Read rule and the tmux socket). Every folder above a rule, and above a closed
  socket, cannot itself be renamed, removed or replaced; what is inside those folders stays usable.
- Measured 2026-09-27 on macOS 26 with pi 0.86.1 and 0.87.1: a denied file was refused in another
  case, through a symlink, a relative link and `..`, by a glob, in NFD, by `python3`, `node`, `bash
  -c` and `sh -c`; copying it, hard-linking it, moving it and writing into its folder were refused;
  an Edit-only launch file stayed readable, and writing, removing, renaming or chmod-ing it was
  refused; renaming a folder above a rule was refused. Starting the sandbox costs about 17 ms a command.
- pi keeps the model's own command in its session: the session file and the model's context never
  see the wrapper (measured on both versions).
- The profiles are made and tried at the first command and kept once they work (a failed try, such
  as a timeout on a busy machine, is tried again); a machine without `sandbox-exec` (not macOS)
  refuses every command with that reason. `sandbox: false` in the table runs commands without
  it; then the rules hold only the file tools. Turning it off needs a compile (the launch guard).
- What the sandbox does not stop: a command asking a program outside it to act for it (launchd, a
  terminal through Apple Events or the owner's own tmux, `open`, cfprefsd through `defaults write`,
  measured), which then reads or writes unsandboxed; and a hard link to a secret that existed before.
  So the confinement is a guard rail against a stray or careless write, not a wall against a model
  set on getting out. That is why no mode but bypass runs a command unasked, except the
  read-only list (`ls`, `cat`, `head`, `wc`, `echo`, …: nothing a shell expands, every path inside the
  profile's folders and outside every Read rule). Bypass is for folders and machines where that is
  acceptable. Programs that keep their login under the floor (gh, ssh keys, the login keychain for git
  over HTTPS, cloud CLIs) fail in the sandbox; the agent is told so. A command that starts its own
  sandbox (Codex, Claude Code with its sandbox) cannot nest it.
- A group open to every member on a bypass pi profile is still refused: through launchd or Apple
  Events a stranger's prompt could get a command run outside the sandbox.
- pi runs its `shellCommandPrefix` setting before the wrapper, outside the sandbox, and an owner's
  own extension that changes the bash command after the gate sees the wrapped one: both are the
  owner's configuration, and `~/.pi/agent/` and the profile's `.pi/` are closed to the agent. Compile
  warns when a prefix is set.
- ANGELIA_SANDBOX tells Angelia's own CLI, run inside, that an unreadable profile folder is the
  sandbox, not a broken table (as CODEX_SANDBOX does for Codex).
- pi's `shellPath` must be a POSIX shell (bash, zsh, sh): the wrapper uses `exec` and `"$0"`.
- plan: `--tools read,grep,find,ls` on argv, and the gate refuses anything else. A tool some other
  extension added asks, except under bypass. No command runs longer than 600 s; pi's own bash has no limit.
- A refusal tells the model it did not run: in the first probe, the model reported a denied command
  as done.

A fresh review on 2026-09-27 found the rename, a lone Read rule that only closed reading, the tmux
socket movable by rename, an acceptEdits read-only command on a denied path with the sandbox off, a
brace group holding `/`, and a rule path with a newline; all fixed, each with a test. It recommended
confining writes, as Codex and Claude Code do; done for unasked commands and bypass file writes. A
second review of the fixes, from the code (an automated safety classifier stopped its hands-on
tests), found temp too wide, other profiles' caches open, non-ASCII globs, and two wrong lines in the
agent's note; all fixed. Its hands-on list (ancestor spellings through /tmp, case and os.replace;
normal tools in the confined profile; helper daemons) was run by the author: the renames were refused,
the tools worked once npx could see the folder above its cache, and `defaults write` went through,
as named above. A hands-on red team by a reviewer in a terminal session is still to do.

A third review (2026-09-27, three fresh reviewers: security, simplicity, correctness) found the file
tools' race, the `.git` hooks, the ssh agent and the open network; all fixed or said above, with tests.

## Consequences

- `backend: pi` in the table; `src/brain/pi.ts`, `piArgv`, the gate, `piRows` for export.
- A compiled profile's skills go to pi as `--skill <path>`; pi ignores Claude's skills folder.
- No MCP on pi: compile says so in a note. Compile also says where the deny rules hold (the gate and
  the sandbox, or the gate alone with `sandbox: false`).
- For pi, compile also denies edits to `.pi/` and `.agents/` in the profile folder, and to pi's own
  folder in the home (`~/.pi/agent/`: global extensions, settings, trust decisions, packages): pi loads
  code and settings from there on the next start, so a write could switch the gate or the sandbox off.
  Reads of `~/.pi/agent/sessions/` are denied too: every folder's transcripts, the owner's own included. pi's and grok's login files are in every profile's floor.
- A prompt pi takes without starting a run (an extension command such as `/llama`) would never
  settle: PiBrain asks `get_state` a second after pi accepted it and ends the turn with whatever
  the command said. `/compact` goes to pi's own compact command, not to the model.
- pi older than 0.80.4 (the first with `agent_settled`) is refused with that reason.
- `PI_CODING_AGENT_DIR` moves pi's logins and sessions; the floor and export assume the default.
- The user's own pi extensions still load. A folder's `.pi/` resources load only once the owner has
  trusted the folder in pi; Angelia never passes `--approve`.
