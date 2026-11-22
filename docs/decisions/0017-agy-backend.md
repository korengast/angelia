# ADR 0017 — agy again, over ACP, held by Angelia's gate and a macOS sandbox

Status: accepted 2026-11-21. Supersedes the agy half of ADR 0007. Sections A-J are the T0 measurements; "Built" at the end records what the build changed after them.

ADR 0007 removed agy because headless `agy -p` could not deny a single tool and its MCP servers were
machine-wide. `agy acp` (the Agent Client Protocol server agy ships for Zed and JetBrains) changes
both. Everything below was measured on this Mac on 2026-11-21 against **agy 1.5.14** (the initialize
reply: `"agentInfo":{"name":"Antigravity ACP Server","version":"1.5.14"}`; the brief said 1.5.11, agy
updated itself during the day), with the owner's Google login (tier `g1-pro-tier`, Google AI Pro).

Method: a scratch ACP client (`tools/probes/agy/acp.py`), a stdio MCP echo server
(`tools/probes/agy/mcp_echo.py`) and one runner (`tools/probes/agy/probe_t0.py <test>`: modes, settings,
instr, sessions, model, after, image, perf, tools2, sub). Every agy ran as
`/usr/bin/sandbox-exec -p <profile> agy acp --gemini-dir <scratch>/gdir --log-file <scratch>/<tag>-agy.log`,
with the profile from `sandboxProfile()` (`tools/probes/agy/profile.ts --pty`). the owner's `~/.gemini` was never
written. Every log is a JSON line per ACP message.

## A. Sandbox: agy runs under sandbox-exec, and the kernel holds

Profile: `sandboxProfile(['Read(<ws>/secret.txt)'], home, { writable: [ws, gdir, cache], noLaunch: true,
open: [/dev/ptmx literal rw, /dev/ttys prefix rw] })`, plus pi's temp folders (`/private/tmp`, `$TMPDIR`).

- initialize, session/new and a prompt work inside it: "Reply with the single word: pong" -> `pong`.
  The Google login (Keychain), the network and agy's helper processes need nothing opened.
- **One thing had to be opened: the PTY.** Without it every `run_command` fails with
  `Command failed to run: failed to create PTY: operation not permitted.` Opening `/dev/ptmx` (literal)
  and `/dev/ttys*` (prefix) for read+write fixes it (`profile.ts --pty`). Nothing else was needed.
- Denied file via the file tool: `read_file` -> status failed, `failed to access file: stat <ws>/secret.txt:
  operation not permitted`. agy did not ask first (reads inside the workspace never ask), so only the
  kernel stopped it.
- Denied file via the shell (permission approved, so the command really ran): `cat secret.txt; echo rc=$?`
  -> `cat: secret.txt: Operation not permitted` / `rc=1`. `cat notes.txt` in the same session -> `hello`.
- Write outside writable: `write_file ~/.agy-spike-outside.txt` (approved) -> `open ...: operation
  not permitted`; shell `echo hi > ~/.agy-spike-outside2.txt` (approved) -> `zsh:1: operation not
  permitted`, `rc=1`. Neither file exists afterwards. Writes inside ws (`write_file`, then `edit_file`) work.
- agy's own conversation store, `brain/` artifacts and its bundled MCP launcher all live under
  `--gemini-dir`, so that folder must be writable.

So the owner's decision 1 (ship without a sandbox) is not needed: read rules inside the folder can be enforced.

## B. Tool inventory

The agent's own list (asked without tools; MCP servers given): `read_file` (Path, StartLine, EndLine,
ByteOffset), `run_command` (CommandLine, IsDaemon, WaitMsBeforeAsync, toolSummary; in auto mode also
BypassSandbox), `write_file` (Path, Content, Overwrite, Append, ArtifactMetadata), `edit_file` (Path, Target,
Replacement, ArtifactMetadata), `search_web` (query, domain), `manage_task`, `send_message`, `schedule`
(CronExpression, DurationSeconds, Prompt, ...), `invoke_subagent` (Prompt, Model, Role, TypeName, Workspace),
`define_subagent`, `manage_subagents`, `run_workflow` (Script, ScriptPath, Args, Cwd), `swarm`,
`ask_question`, `call_mcp_tool` (ServerName, ToolName, Arguments), `list_resources`, `read_resource`, and one
`mcp_<server>_<tool>` per eagerly loaded MCP tool. **No browser tool and no URL reader** in ACP with this
config (asked to fetch `https://example.com` without the shell, the agent answered `NOTOOL`).

`session/request_permission` carries `toolCall.name`, `title`, `kind`, `rawInput` (the args above) and
`options` that were always exactly `allow_once` / `reject_once` in every run: **`allow_always` never appeared,
and no tool call was ever asked twice** (counted over all logs).

| tool | kind | asks in default mode |
|---|---|---|
| read_file inside the workspace (and inside `--gemini-dir`) | read | never |
| read_file outside (`/etc/hosts`) | read | yes |
| write_file, edit_file (inside or outside) | edit | yes |
| run_command | execute | yes, every command |
| `mcp_<server>_<tool>` | other | yes |
| call_mcp_tool | execute | yes |
| search_web | search | never |
| invoke_subagent | other | never (the subagent's own tools: see H) |

## C. Modes

session/new lists `default`, `accept-edits`, `auto`, `plan`; `session/set_mode {sessionId, modeId}` returns `{}`.
- `plan`: asked to write plan.txt, the agent wrote `implementation_plan.md` under `<gdir>/antigravity-cli/brain/<sid>/`
  (no ask) and asked for approval in text; the workspace was not touched. This is the model obeying the mode, not
  a block Angelia can rely on.
- `accept-edits`: `write_file` inside the workspace ran with no ask; the write outside still asked; `ls` still asked.
- `auto`: `ls` and `rm -f inside.txt` both ran **with no ask** — first in agy's own terminal sandbox, then again
  with `BypassSandbox: true` after its reviewer approved. Angelia must never select auto.
- `default`: every write and command asks.
- `agy acp --mode plan` and `agy acp --settings {}` both exit 1: `flags provided but not defined`.
- settings.json in `<gdir>/antigravity-cli/settings.json` with `allow: command(ls)`, `deny: command(cat)`,
  `read_file(<ws>/notes.txt)`: `ls` still asked, `cat notes.txt` asked and ran when approved, read_file read
  notes.txt. **ACP honours no allow/deny rule.** The gate is Angelia's.

## D. MCP

- `session/new` `mcpServers: [{name, command, args, env: []}]` (ACP stdio shape) works: the server is started
  (`server/discover`, `initialize`, `tools/list`), its tool appears as `mcp_<name>_<tool>` and asks permission.
- **Other sources also load, and must be kept empty by Angelia:**
  - `<gdir>/config/mcp_config.json` (`{"mcpServers":{name:{command,args}}}`): loaded lazily, reached through
    `call_mcp_tool` after the agent reads `<gdir>/antigravity-cli/mcp/<name>/<tool>.json`; asks permission.
  - `<cwd>/.agents/mcp_config.json`: the server process **was started** in every session in that workspace
    (3 starts in mcp.log), though the agent did not list it. A profile folder with this file runs its command.
- the owner's own servers in `~/.gemini/config/mcp_config.json` (notebooks, visualization, context, data-agent-kit)
  did **not** load with `--gemini-dir` (not in any tool list; no process).
- Plugins: `<gdir>/config/config.json` gets `{"plugins":{"swarm":{"enabled":true}}}` on first start; built-in
  skills/plugins are copied to `<gdir>/antigravity-cli/builtin/`. `--include-default-customizations` (default
  true) is the flag that controls them. `~/.agents` does not exist on this Mac; not tested.

## E. Instructions and skills

Measured by markers (a no-tool turn asked to quote every line with MARKER):
- Read: `<gdir>/GEMINI.md` and `<gdir>/config/GEMINI.md` (as `user_global` rules), `<cwd>/AGENTS.md`,
  `<cwd>/GEMINI.md`, **and `AGENTS.md` in the parent folder** of cwd.
- Imports: `@[inc](inc.md)` (Markdown-link form) is expanded; bare `@inc2.md` is **not**; bare `@big.md`
  (240 KB) in GEMINI.md was not either. Size limit not measured (moot: Angelia expands imports itself).
- Skills: `<cwd>/.agents/skills/<name>/SKILL.md` and `<gdir>/config/skills/<name>/SKILL.md` both load, next to
  built-ins (agy-customizations, antigravity-guide, run-workflow, swarm_monitor). Frontmatter `name` +
  `description` as in Claude's SKILL.md; without `name` the folder name is used (changelog 1.5.10).

## F. Sessions

- initialize advertises `loadSession` and `sessionCapabilities: resume, close, load, list, additionalDirectories`.
- session id = a UUID agy mints in session/new; conversations are `<gdir>/antigravity-cli/conversations/<id>.db`,
  so `--gemini-dir` keeps them per profile.
- New process, `session/resume {sessionId, cwd, mcpServers}`: 2.2 s, 2 updates (commands, title), **no replay**;
  the next turn remembered KIWI. `session/load` (same args): 3.8 s, replays the old user/agent chunks (7 updates);
  also remembered.
- `session/close {sessionId}` -> `{}`; a prompt afterwards -> `-32602 Session not found`.
- `session/list {cwd}` lists sessions with id, cwd, title, updatedAt.

## G. Model and effort

- session/new returns `models.availableModels` (ids such as `gemini-4-hydrogen-high`, `-xhigh`, `-medium`,
  `-low`; neon, argon, 3.8 flash, Claude Opus/Sonnet 5.5, gpt-oss) and `currentModelId: gemini-4-neon-high`.
  A `model` field in session/new is ignored.
- `session/set_model {sessionId, modelId: 'gemini-4-hydrogen-high'}` -> `{}` (log: `Switching model ... to:
  Gemini 4 Hydrogen (High)`). An unknown id -> `-32602 Unknown model ID: gemini-9-nope`.
- Effort is also `configOptions` `thought_level` (low/medium/high/xhigh):
  `session/set_config_option {sessionId, configId: 'thought_level', value: 'low'}` switched the model to Hydrogen
  (Low). So the id suffix and thought_level are the same setting; set_model with the suffixed id is enough.

## H. After-turn updates

A turn that started `sleep 25; echo BGDONE` in the background ended with `started`. With no prompt open, 25 s
later the client got the `tool_call_update` (completed) and a new agent message: "The background command
finished (exit code 0) with output: BGDONE". So agy wakes itself; Angelia must deliver such updates (and answer
permission requests) between turns. A subagent started with `invoke_subagent` is killed by closing the session
(the tools2 run closed before it wrote).

Subagents are not gated: `invoke_subagent` itself never asks. In the `sub` run, the subagent called `write_file`
(agy log 18:49:37, `Monitor agy_tool_safety ... unsupported_tool: write_file`). Then for 86 s nothing reached the
client: no `request_permission`, no update, no file. **A subagent's permission request is never surfaced over
ACP, and the subagent hangs.** This fails closed (nothing ungated ran, and the outer sandbox covers subagents
because they run in the same process tree), but the work is lost and a wake-up may never come.

## I. Images, refused turns

- An image block `{type:'image', mimeType:'image/png', data:<base64>}` after the text: a 16x16 red PNG -> `Red`.
- A turn whose only tool was rejected (`ls -la`, reject_once) ends `end_turn` with **empty text**; the same after a
  rejected write in accept-edits. Angelia adds the fallback line.

## J. Latency, memory, exit

- init + session/new: 1.6 s. Five one-word turns: 3.4, 7.6, 3.6, 2.3, 4.9 s. Tool turns 5-25 s.
- RSS: agy 194 MB plus one MCP child 10 MB (205 MB total).
- stderr: 0 lines (logs go to `--log-file`).
- stdin close: exits 0 in 0.3-3 s; no agy process was left.

## Consequences for the build

- **argv:** `/usr/bin/sandbox-exec -p <profile> agy acp --gemini-dir <state>/agy/<profile>` plus `--add-dir <d>`
  per add_dir (agyArgv). No `--log-file`: the probes used one, the build does not, and agy writes nothing to stderr. Never `--dangerously-skip-permissions`; never `--mode`/`--settings` (not
  defined for acp).
- **Sandbox options:** `sandboxProfile(policy.deny, home, { writable: [cwd, ...add_dirs, _common, gemini-dir, cache],
  noLaunch: true, sockets: policy.sockets, open: [{path:'/dev/ptmx', match:'literal', write:true},
  {path:'/dev/ttys', match:'prefix', write:true}] })`, temp folders included.
- **Gate map** (answer each `session/request_permission` from decide(); relay `ask`):
  `read_file` -> `Read(Path)`; `write_file`, `edit_file` -> `Edit(Path)`; `run_command` -> `Bash(CommandLine)`;
  `mcp_<server>_<tool>` -> `mcp__<server>__<tool>`; `call_mcp_tool` -> `mcp__<ServerName>__<ToolName>`; anything
  else (other kinds) -> ask. Answer with `allow_once` or `reject_once` only. Reads inside cwd and `search_web`
  never reach the gate: the sandbox carries Read rules.
- **Modes:** default -> `default`; acceptEdits -> `accept-edits`; plan -> `plan` and the gate rejects every edit
  and command (agy's plan mode is advice only); bypass -> `default` with the gate allowing all but denies. Never `auto`.
- **MCP:** pass the profile's servers in session/new and session/resume as `{name, command, args, env:[{name,value}]}`.
  Write no `<gdir>/config/mcp_config.json`; the launch guard must refuse a `.agents/mcp_config.json` in cwd or
  an add_dir.
- **Instructions:** write the expanded CLAUDE.md as `<cwd>/GEMINI.md` (built: GEMINI.md, because Codex and pi read AGENTS.md), no `@` left in it; keep
  `<gdir>/GEMINI.md` and `<gdir>/config/GEMINI.md` absent; check that no AGENTS.md/GEMINI.md sits in the parent
  folders of a profile (agy reads at least one level up).
- **Skills:** copy or link the profile's skills to `<gdir>/config/skills/<name>/SKILL.md`; consider
  `--include-default-customizations=false` to drop the built-ins (not measured).
- **Resume:** store agy's session id; on a new process `session/resume {sessionId, cwd, mcpServers}`.
- **Model/effort:** after new/resume, `session/set_model {sessionId, modelId: <model>-<effort>}`, default
  `gemini-4-hydrogen-high`; check the id against `availableModels` first.
- **Subagents:** `invoke_subagent`, `define_subagent`, `swarm`, `run_workflow` and `schedule` never ask, so the
  gate cannot stop them, and a subagent's tool requests hang (H). Tell the agent in the instructions not to use
  them; detect them in `tool_call` updates and log them. Check again on every agy update.
- **Between turns:** keep reading the stream after `end_turn`; deliver after-turn messages and gate their permission
  requests; close the session (`session/close`) to stop background work.
- **Empty turn:** after `end_turn` with no text, add the fixed refused-tool line.

## Built (after the measurements)

- **Subagents:** since da93beb Angelia finds a subagent's conversation (`<gdir>/antigravity-cli/conversations/<child>.db`
  names the parent session) and resumes it in the same process; its permission requests then reach the gate. During a
  turn they are asked in the chat; between turns an "ask" is refused. A subagent not found in 10 s gets one line in
  the chat. The generated GEMINI.md tells agy not to use the tools that never ask. Swarm, workflows and schedule stay ungated.
- **Keychain:** closed (the fresh review measured the earlier read-only opening: every command agy ran could list the
  Claude Code and gh items with `security`). agy's keyring library starts `/usr/bin/security`; when that cannot save,
  agy keeps the same JSON in `<gdir>/antigravity-cli/antigravity-oauth-token` and signs in from it. So the daemon,
  outside the sandbox, copies the owner's sign-in (keychain service `gemini`) into that file before each start (only
  when missing or another sign-in), and the sandbox leaves `~/Library/Keychains` closed and refuses to start
  `/usr/bin/security`. Measured 2026-11-21: agy signs in; `security`, a compiled Security.framework helper, python
  ctypes and osascript find no item. What is left: commands agy runs can read agy's own sign-in file.
- **Gemini dir inputs:** the folder is opened again last for agy, so its rules files, MCP config, skills and
  `antigravity-cli/settings.json` are closed to writing after that rule (the sandbox takes the last match), and so is
  `antigravity-cli/builtin/` (measured 2026-11-21, agy 1.5.14: agy makes no such folder in its own gemini dir, starts
  and answers with it closed, and a command cannot create it).
- **~/.gemini:** the owner's whole `~/.gemini` is in an agy profile's floor (its agy has its own folder). A profile on
  another backend keeps it open, as before this backend, since it may run the owner's own agy as a tool. Every
  backend's floor closes `<state>/agy/**` (an agy profile: every other profile's folder there).
- **Bash rules:** pi's gate does not read `Bash(...)` deny rules; agy's gate matches them itself.
- **Model ids:** agy lists only ids with an effort suffix; a bare id gets `-high`.
- **Not supported on agy:** `angelia ask` (no conversation copy).
- **State folder:** closed by default for every backend (docs/security.md): all of `~/.angelia` but the open entries
  (STATE_OPEN: workspace, logs and status, the API socket, cache, agy, installed programs, `data`, `projects`) and what
  the profile is given. `data` and `projects` stay open because profiles read them today; per-profile data rules are a
  later change. A program opens its whole entry; any other named path opens only itself; the state folder named as a
  whole opens nothing (review 3).
- **Daemon reads:** every file the daemon reads from a place the agent can write (the sign-in copy, CLAUDE.md,
  GEMINI.md, the gemini dir config, settings files) is opened non-blocking and read only as a regular file, so a named
  pipe cannot hold the daemon; the agy sandbox also refuses to create one (review 3). A CLAUDE.md that leads to a
  file the profile may not read refuses the start. A link, pipe or empty folder at the sign-in copy is removed, then seeded.
