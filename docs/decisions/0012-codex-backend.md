# ADR 0012 — Codex as a backend, held by its own sandbox

Status: accepted 2026-09-25.

ADR 0006 asks three facts of any new backend. Measured on 2026-09-25 against codex-cli 0.157.0
(`gpt-6-luna`, a ChatGPT login), through `codex app-server`, the JSON-RPC protocol Codex's own IDE
clients use (types from `codex app-server generate-ts`).

## The three facts

- **Resume by id.** `thread/start` returns the id Codex mints (UUIDv7), so the session row is
  renamed as for grok. `thread/resume` with that id in a new process continues the conversation,
  with no replay of old items.
- **Permission prompt without a TTY.** Codex sends `item/commandExecution/requestApproval` and
  `item/fileChange/requestApproval` to the client and waits for `accept` or `decline`. After a
  decline the model reports that nothing ran.
- **Multi-turn process.** One `turn/start` per turn, ended by `turn/completed` (status completed,
  failed or interrupted). Four to thirteen seconds a turn.

## The sandbox does what pi needed a gate for

Codex runs every command inside an OS sandbox (Seatbelt on macOS, bubblewrap on Linux) shaped by a
permission profile: filesystem entries `read`, `write` or `deny`, deny winning, network off unless
enabled, Unix sockets only when allowlisted. Measured with `codex sandbox`: a `deny` entry blocked a
read directly, through a shell and through a symlink, a listing and a write; without it the same
read went through.

So Angelia writes no gate of its own (the lesson of the paused pi backend, ADR 0011). The daemon
passes the profile on the app-server's command line with `-c`, where the agent cannot edit it:

- `default_permissions="angelia"`, extending `:workspace` (`:read-only` in plan mode).
- The rules compile wrote to `.claude/settings.json` (the launch guard checks them before every
  start): a path with a Read rule is denied, one with only an Edit rule (the launch files) is
  read-only, and add_dirs, `_common/` and directory capabilities are writable. A rule with a glob
  inside the path is not passed and is logged; compile writes none.
- Network on, through Codex's network proxy (`features.network_proxy=true`, every web domain
  allowed), and only Angelia's API socket in the socket list. A review measured that with network
  on and the proxy off every Unix socket on the machine answers (Angelia's tmux server included);
  with the proxy on, only a listed socket does, and HTTPS still works. `angelia send-media` and
  `angelia turn` need that one socket.
- The network is web only: through the proxy, HTTP and HTTPS work; SSH, raw DNS, binding a port
  and connecting to a local one do not (measured). `allow_local_binding` would give ports back but
  opens every local listener, so it stays off; the agent is told.
- Package caches (npm, uv, pip, XDG) point at the profile's own folder under Angelia's state
  (`cache/codex/<hash of the name>`), writable to that profile alone; the other profiles' caches
  are denied to it (measured: own read and write work, another's read, write and listing do not). Not `~/.npm`, whose `_npx`
  holds code run later outside the sandbox, and not temp, which every sandboxed profile may write:
  a review planted code in another profile's npx cache there.
- A user-level Codex MCP server the profile does not get is switched off
  (`mcp_servers.<name>.enabled=false`); compile records it as an `mcp__<name>` deny.
- For Codex, compile also makes `.codex/` and `.agents/` read-only in the profile folder, links
  allowed skills into `.agents/skills` (where Codex looks), and `~/.codex/auth.json` joins every
  profile's floor. Codex's `:workspace` keeps a `.git` at the top of a writable folder read-only,
  so the agent cannot commit there; it is told so.
- At every start Angelia checks what Codex applied: the thread must report the `angelia` permission
  profile (not full access) and approvals going to the user. `approvalsReviewer: "user"` is pinned,
  since a Codex config can route approvals to a Codex model reviewer. A `[permissions.angelia]`
    table set by any Codex config layer other than Angelia's own flags (the owner's, a trusted
  project's, the system's) would merge with Angelia's and reopen what it closes, so after
  `initialize` Angelia reads Codex's merged config with its layers (`config/read`) and refuses the
  start if one does (a layer Codex does not apply is skipped), or if any MCP server it would load is
  not one the last compile gave the profile (recorded in its compiled record); every TOML spelling
  and a trusted project's config count. A
  denied server whose name `-c` cannot address refuses too.
- The launch guard records the backend and whether a Codex profile was compiled sandboxed; another
  backend, or `sandbox: false` in the table since then, refuses the start until a compile accepts it.

The system temp folders stay writable: that is Codex's `:workspace`.

## Modes

An approval in Codex always asks for more than its sandbox gives; inside it, commands run without
asking. So default and acceptEdits map to `on-request` (ask only for more; the permission line offers
add_dirs instead), bypassPermissions to `never` (never asks, never widens), plan to `never` with the
read-only profile. `sandbox: false` on a profile gives full access (`danger-full-access`) and passes
no permission profile.

A yes never lifts the sandbox. Measured on 0.157.0 (the first real chat test, 2026-09-25): with any
deny entry in the permission profile, and the floor always has some, Codex calls the denials
"non-escalatable" and runs an approved "outside the sandbox" command inside the whole sandbox
anyway, so the owner's yes did nothing. What works is asking for a folder: in default and
acceptEdits Angelia turns on `features.exec_permission_approvals` (a command carries
`additionalPermissions`, shown in the permission line once `initialize` opts into the experimental
API) and `features.request_permissions_tool` (`item/permissions/requestApproval`, relayed to the chat
as "more access, this turn"; a yes grants exactly what was asked, scope turn, a no grants nothing).
Measured through the orchestrator on real Codex: yes wrote the file, no left nothing, and a yes for
another profile's folder still failed, since a deny entry beats a grant. Both features are marked
"under development" in Codex; a Codex without them keeps the old behaviour, approvals that do nothing.

The owner's rule for the agent (2026-09-25): when the sandbox stops something, it says so and suggests
adding the folder to add_dirs. `developerInstructions` carries Angelia's self prompt and a note with
the writable folders, the profile's name for the compile command, and that suggestion. In default
and acceptEdits the note also lets the agent ask for access to the exact folder for the turn, and says
a command fully outside the sandbox does not work: a review measured that without such a line Codex
never asked, so those modes acted like bypass.
Measured after: a blocked write produced the prompt in the chat, and a decline kept it blocked.
`sandbox: false` counts as running unasked for the open-group check, whatever the mode.

## Other facts

- Codex reads AGENTS.md; `project_doc_fallback_filenames=["CLAUDE.md"]` makes it read the profile's
  CLAUDE.md (listed in `instructionSources`).
- Without a profile model, the one `model/list` marks as default: `~/.codex/config.toml` on this Mac
  named a model the ChatGPT login refuses (400).
- `/compact` is `thread/compact/start`. The rollout file (`$CODEX_HOME/sessions/<y>/<m>/<d>/rollout-*-<thread>.jsonl`)
  feeds `angelia export`.
- OPENAI_API_KEY, OPENAI_BASE_URL and CODEX_API_KEY join the variables no agent gets.
- The app-server protocol is marked experimental: below 0.157.0 the backend refuses with that reason.
- Only a missing thread ("no rollout found") starts fresh on resume; a thread another client holds
  is an error, so /resume can still reach it. A failed turn's message is the chat's text too, so a
  usage limit reads as one (with the /model hint).
- `angelia` commands inside the sandbox cannot stat other profiles' folders: there (Codex sets
  `CODEX_SANDBOX`), the table loader takes a folder it may not look at as present, and a daemon pid
  it may not signal as alive. Outside the sandbox both stay errors: a pid reused by another user's
  process must not keep Angelia from starting.
- Not measured: Linux (bubblewrap). Other profiles' transcripts under `~/.codex/sessions` (and
  Claude's under `~/.claude/projects`) stay readable, as for every backend today.
- The `-c` key form `filesystem."<path>"="deny"` keeps the quotes and fails; the inline table value
  (`filesystem={"<path>"="deny"}`) works.
