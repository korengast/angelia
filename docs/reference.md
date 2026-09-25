# Reference

Everything the README leaves out: each feature in full, setting up by hand, the instance folder, and every file Angelia keeps. For the security model, see [security.md](security.md).

## Features in detail

- **Profile = directory.** Anything your agent honours in a project (instruction files, settings, MCP servers, hooks) works unchanged. No personas live in Angelia.
- **Three CLIs behind one seam.** `backend: claude-code | grok | codex` per profile. `model`, `effort` and `permission_mode` are translated to each CLI's own flags. Switching a profile's CLI starts a fresh session; a session never moves between CLIs.
- **One session per chat**, resumed across restarts and idle periods. `/new` on one chat never touches another; `/resume` lists and switches between past sessions.
- **Group gating.** Reply only when mentioned or replied to, only to allowed senders, never to a chat that is not in the table. Unknown chats are dropped silently.
- **A new chat onboards itself.** With `defaults.unmatched: onboard`, an owner's first message in a chat the table does not know (in a group, one that mentions the bot or replies to it) makes a profile for it: a folder named after the group, a starter `CLAUDE.md`, a profile and a route written into `routing.yaml` (with a backup, and rolled back if the result would not load), capabilities compiled, live at once with no restart. That first turn carries an onboarding prompt, so its agent asks what the chat is for and writes its own instructions and memory. The prompt ships as `prompts/onboarding.md`; `onboard.prompt` points at your own copy. Anyone else who adds the bot to a group gets nothing, and chats listed in `onboard.skip` (served by another gateway, or archived) are never onboarded. `angelia profile add <platform:chat>` does the same by hand, before anyone writes in the chat; the daemon picks it up at the next restart. `angelia guide onboard` has the settings.
- **Permission relay.** When the agent wants to run something under a cautious profile, the chat receives `🔐 Bash: rm -rf build` and an owner answers `yes 6b480a6f` or `no 6b480a6f`. Unanswered prompts are denied after ten minutes.
- **Two ways to host the agent.** By default each session is a headless CLI process: permission prompts arrive as JSON and the screen does not exist. `tui: true` on a Claude Code profile runs the same CLI as a real interactive session in tmux instead — Angelia types the turn into the pane and a Stop hook hands the answer back. That session registers with Remote Control, so the chat appears in the Claude app and can be continued from the phone; it also outlives a daemon restart, keeps MCP servers warm between turns, and treats slash commands exactly as a terminal does. Trade-offs in [ADR 0008](decisions/0008-tui-host-mode.md).
- **Files in.** A photo or document sent to a routed chat lands in `<profile>/.inbox/` and the agent gets a `[file: path]` line. A voice note gets `[voice note: path]` and the agent transcribes it itself by running `angelia transcribe <path>`, which prints the text — one transcriber for every profile, on whisper's accurate model rather than its fastest (measured on Hebrew), and it detects the language by itself. The agent runs it; the daemon never does. For a spoken reply the other way, `angelia speak "<text>"` prints an audio file made with the voice built into the machine — no provider, no key, offline — with the system's Hebrew voice for Hebrew text and its default voice otherwise, and the agent attaches it with `angelia send-media`. Both commands are a default, not a rule: setup asks how this install should hear and speak, and a hosted API, another tool or neither is a valid answer — whatever you name is what the instruction file will say. Angelia runs no model of its own, not even for speech.
- **Files out.** `angelia send-media <platform:chat> <absolute path> [caption]` attaches an image, a video, a voice note or a document. The kind is read from the extension; audio is converted to ogg/opus with ffmpeg when it is on PATH, so it arrives as a real voice bubble on both platforms. Every path is checked once, wherever the request came from: absolute only, symlinks resolved, a real file, inside the platform's size limit, and never from a credential location (`/etc`, `~/.ssh`, `.env`, key and token files, shell history, the instance's own secrets and logs). The check covers attachments only: an agent that can read a file can still quote it in its reply. A profile with `media_tags: true` also honours a `MEDIA:<absolute path>` line in the agent's own reply; it is off by default, so a model that quotes such a line in prose cannot send a file nobody asked for.
- **Streaming delivery.** Progress lines while the agent works, then the answer, chunked to platform limits and paced (`max_out_per_min`, per platform). Progress never holds the answer: lines that pile up go out as one message, and one slot a minute is always kept for the answer and for permission prompts.
- **`angelia restart`.** Stops the daemon and starts a new one in its own session, with the config it was last started with; under the LaunchAgent it reloads the job instead, so a rewritten plist takes effect. It refuses when it is run by the daemon's own agent — a routed chat restarting its own gateway is how the gateway stays down — and `--force` says you accept losing that turn's reply. From a chat, an owner sends `/restart`: the router loads the routing table first and refuses a broken one, answers, then runs the restart detached in its own session so stopping the daemon cannot kill it, and the new daemon posts "back up" into the chat that asked. `/sh angelia restart` is refused for exactly the reason `/restart` exists.
- **Router commands** `/new` `/stop` `/status` `/resume` `/model` `/effort` `/backend` `/sh` `/restart` `/help`, answered without spending a token, and registered in Telegram's command menu. `/model` and `/effort` alone show the one in use and what the CLI offers: Codex and Grok Build are asked for their model lists (Codex also gives each model's effort levels, and a level or a model it does not offer is refused), Claude Code's aliases are listed. With a value they override the profile for the current session only. `/backend` alone shows the profile's CLI and the ones installed; `/backend <cli>` (owners only) moves the profile to that CLI the way onboarding writes the table: the table is backed up and edited in place, `model`, `effort`, `bin` (and `tui` when leaving Claude Code) are taken off because they belonged to the old CLI, the profile is compiled for the new one, and a failure puts the old table back. Every chat on that profile starts a fresh session on the new CLI at its next message.
- **A loopback API for your own scripts.** `angelia send <platform:chat> <text>` posts a line into a routed chat (a `MEDIA:<absolute path>` line in that text attaches the file); `angelia send-media` attaches one directly; `angelia turn <platform:chat> <text>` types a prompt into that chat's session and the answer lands in the chat. Both are how a cron job talks to an assistant without a gateway of its own. They talk to the daemon over a Unix socket, `~/.angelia/api.sock` (mode 600), never a network port. From your terminal they use the owner token in `~/.angelia/api.token`; an agent uses its own, which works only for its own chat.
- **Scheduled jobs, run by the operating system.** A profile lists its jobs in `angelia-jobs.yaml` in its own folder (a cron schedule or an interval, and a turn, a message or a command). `angelia jobs install` turns each into a LaunchAgent that calls `angelia jobs run`; the daemon itself still wakes nothing up. A timer runs the job as it was installed, and refuses, in the chat, a job whose definition, or a script in its profile folder that it runs, changed since. `angelia guide jobs` has the format.
- **One transcript format for every backend.** `angelia export <platform:chat>` prints the chat's turns as JSONL (time, role, text, tools used), read from the files Claude Code, grok and Codex already keep. `--all` covers every session the chat has had; tool output is left out unless you add `--tools`.
- **Subscription-safe.** API-key variables are stripped from the agent's environment, so a chat cannot quietly move you from your subscription to a per-token bill. In the default mode a Claude Code session that would still bill an API key (a stored key, a key helper) is refused. A `tui: true` session is checked before it starts for a key helper in any settings file it reads and for the CLI version; a key stored with `/login` is not visible from outside there.

## Your CLI brings the capabilities

Angelia carries things between a chat and an agent: messages, files, voice notes, the agent's permission questions, and scheduled turns. That is all it does. Everything the agent can *do* — browse, read email, fill a cart, look something up, remember — comes from the CLI you already run and what you give it: skills, MCP servers, connectors, instruction files.

So a good personal assistant is mostly a well set-up CLI, and Angelia helps with that rather than doing it itself:

- **Per-profile capabilities.** Declare a skill, an MCP server, a command or a folder once in the table, give it to the profiles that should have it, and `angelia compile` writes it into each profile's own CLI settings, denies included. On Grok Build an allowed MCP server still has to be added once with `grok mcp add`. See [Skills, scripts and tools](#skills-scripts-and-tools).
- **Starter skills.** `angelia init` copies two into your workspace, as gentle suggestions you can edit or ignore: `checkout` (build the cart, hand you a checkout link to pay on your phone) and `mfa` (where one-time codes usually are, and asking before using one). Nothing is granted until you give a skill to a profile.
- **Voice, built in.** `angelia transcribe` and `angelia speak` are the one thing that ships as code, because every chat gets voice notes. They are still run by the agent, never by the daemon; `src/voice/README.md` has the details.
- **A manual for the agent.** `angelia guide` tells an agent how the instance is laid out before it changes anything.

## Backends in detail

| Backend | `backend:` | How | Permission prompts | Resume |
|---|---|---|---|---|
| Claude Code | `claude-code` (default) | one long-lived `claude -p` process per session over its streaming JSON protocol: warm prompt cache | relayed to the chat (a typed yes from an owner) | `--resume` with the id Angelia mints |
| Grok Build | `grok` | one long-lived `grok agent stdio` process per session over ACP (JSON-RPC on stdio) | relayed to the chat (a typed yes from an owner) | `session/load` with the id grok mints |
| Codex | `codex` | one long-lived `codex app-server` process per session over JSON-RPC on stdio, inside Codex's own OS sandbox with the profile's rules | asked in the chat only for more access than the sandbox gives, such as one more folder for that turn (never in bypass and plan) | `thread/resume` with the id Codex mints |
| pi, OpenCode | coming soon | same `Brain` interface | | |

Antigravity CLI (`agy`) was a backend until 2026-09-21. It was removed because headless agy cannot deny a single tool and has no per-folder MCP setting, so a profile on it could be given nothing narrower than everything. An agent can still call `agy` as a tool.

The backend is a single interface in `src/brain/`: start in a directory, send a turn, receive progress, permission requests and a result. Routing, sessions, gating and delivery never mention a specific agent.

## Setting things up by hand

`angelia init` asks which of two shapes you want. **Quick** is one chat and one folder. **Advanced** is several profiles, each with its own folder, permission mode and chats. Both end with a plain `routing.yaml` in `~/.angelia/workspace` that you can edit by hand later; `angelia check-config` validates it and warns about risky combinations.

To install without the script: `git clone --branch v0.2.1 https://github.com/korengast/angelia && cd angelia && npm ci --ignore-scripts && npm run build && npm i -g --ignore-scripts "$(npm pack --ignore-scripts | tail -1)"`, then `angelia init`. Without the service, `angelia daemon` runs it in the terminal; it reads `~/.angelia/env` itself.

The wizard only writes files you can write yourself.

1. **Profiles.** A directory per assistant with its instruction file: `CLAUDE.md`, for Claude Code, Grok Build and Codex alike. `~/.angelia/workspace/profiles/coding`, `…/family` — or any directory of your own, when the assistant's home is a project you already have. Grok Build needs one extra step before it reads that file: it loads project rules and `.claude/settings.json` only in a folder you have trusted once, with `grok --trust` in it.
2. **Telegram.** Store the BotFather token in `~/.angelia/env` as `TELEGRAM_BOT_TOKEN=...`, mode 600. For groups, make the bot a group admin: Telegram's privacy mode otherwise hides plain @mentions from bots.
3. **The table.** Write `~/.angelia/workspace/routing.yaml` like the example above and validate it with `angelia check-config` (no path needed). Then `angelia compile <profile> --write` for each profile: it writes the deny rules into the profile's `.claude/settings.json`, and the daemon starts no agent for a profile that was never compiled. A Telegram DM's chat id is your numeric user id; a group's is its negative `-100…` id. Both appear in the daemon log the first time an unrouted chat writes in.
4. **WhatsApp.** Add a `whatsapp:` block and run `angelia pair`. Angelia links to the account as a companion device, like WhatsApp Web: `angelia pair` opens a local page with a live QR (also printed in the terminal); on the phone that owns the number choose Linked devices > Link a device and scan it. The page reports each stage, and a half-finished link is cleaned up and retried by itself. `pairing: code` (with `phone:` in E.164) exists, but WhatsApp currently rejects pairing codes from third-party clients, so QR is the default. If the phone asks to create a passkey, create it and scan again. Credentials live in `auth_dir`, mode 700. `angelia unpair` logs that one linked device out and deletes them; the phone and its other linked devices are untouched. Link a second, established number, not your personal one. Angelia ignores what the linked account itself sends, so on your own number it would not hear you and would answer as you, and it would decrypt every chat on that account. WhatsApp bans newly created numbers that start acting like robots, usually within hours. Group ids look like `1203630000…@g.us`; people appear either by phone number or by a `@lid` id, and `allow_from` / `owners` accept the phone number whenever WhatsApp has told us the mapping.

```yaml
whatsapp: { auth_dir: ~/.angelia/wa }
```

### Chrome for a Claude Code profile

`chrome: true` on a Claude Code profile launches the agent with the Claude in Chrome tools, which act inside your everyday browser with the sessions it already holds. Angelia only passes the flag; what the agent may do there is its permission mode and its instructions.

### Shell without the agent

With `shell: true` on a profile, `/sh <command>` runs that command in the profile directory with your login shell and returns the output, exit code and all. No agent, no tokens, and it works even while a turn is running. Multi-line scripts work too. `shell_timeout_seconds` (default 60) kills anything that hangs. Enable it only on profiles whose chats you alone can write to.

### Keeping it running

On macOS, `angelia service install` makes the daemon a LaunchAgent: it starts at login and comes back after a crash. The plist carries the PATH the CLIs need, worked out when it is written, and no secret; the daemon reads `~/.angelia/env` itself. If a daemon started by hand is running, `angelia restart` (or `/restart` from a chat) moves it onto the service. `angelia service status` and `angelia service uninstall` do what they say. Elsewhere the daemon is a foreground process: keep it under systemd or your own supervisor. `~/.angelia/daemon.pid` stops a second copy from starting.

`angelia update` installs the newest release of the repository named in the installed package (for a fork, pass `--from` with your fork) and lists the commits it brings. A release is a `vX.Y.Z` tag signed with the release key; the key is checked against the `allowed_signers` file of the copy you already have, never the one that came with the download, and a copy without that file refuses to update. `install.sh` carries the same key and checks the first install the same way. An update whose history does not contain the installed commit (a rewritten repository, or an older release) is refused unless you add `--force`. It builds in a temp folder with no dependency install scripts and installs with `npm i -g`, so your instance, profiles and state are not touched. It never restarts the daemon: send `/restart` or run `angelia restart` when it suits you. `--check` only lists what would change; `--from <git URL or folder>` updates from somewhere else; `--head` installs the branch tip instead of a release, unsigned, for development. A checkout, or a global install linked to one, is refused: update those with git.

## The instance

`~/.angelia/` is not scratch space. It is your assistant, made concrete, and it has exactly one
boundary inside it:

```
~/.angelia/
  workspace/            the brain. A git repo, and the only thing git ever sees.
    routing.yaml        the table
    profiles/<name>/    one assistant: instructions, memory/, prompts/, docs/, scripts/
    _shared/            doctrine several profiles import
    _common/            files profiles share while working together
    _capabilities/      shared by several profiles: skills/<name>/, tools/<name>/
    .gitignore          generated: .state/, .inbox/, and anything key-shaped
  env  wa/  sessions.json  api.token  api.sock  daemon.log  tui/  compiled/
                        credentials and moving parts. Never in git.
```

An agent saves its own change with `angelia workspace commit -m "<message>" [path...]`. Before
committing it scans the added lines for key- and token-shaped values, loads the table, and checks
that compiled profiles and job timers still match their files. Any failure commits nothing. 
`angelia workspace sync` saves whatever is left under a dated message; run it from a job if you want
it nightly. `angelia guide commit`
has the permission rules that make the checked command the only way a profile commits.

One instance, one folder: back it up, move it to another Mac, or delete it. Almost: the CLIs keep
their conversations in their own folders (`~/.claude/projects`), LaunchAgents live in
`~/Library/LaunchAgents`, running sessions live on Angelia's tmux server, and a profile you pointed at
a folder outside the instance stays where it is. `angelia init` builds this, offers to `git init` the workspace, and — only if `gh` is
already signed in — offers a private remote. It never runs git above the workspace, because that
is where the token and the WhatsApp login live.

Every subcommand resolves the same table: `ANGELIA_CONFIG` when set, else the workspace copy, else
`./routing.yaml` in a checkout. `angelia status` prints which it found.

### Skills, scripts and tools

What a profile may use is declared once, under `capabilities:` in the table, and compiled into each
profile's folder by `angelia compile <profile> --write`. Where the files go:

- A skill is a capability. Its folder lives in `workspace/_capabilities/skills/<name>/`, and the
  table names it relative to the workspace (`path: _capabilities/skills/<name>`), so it is in git and
  moves with the instance. `check-config` warns about a skill kept anywhere else.
- A script one profile uses lives in that profile's `scripts/`, next to its `angelia-jobs.yaml`. It
  is not a capability.
- A script several profiles use is a capability: inside the skill that documents it, or a `command`
  whose file is in `_capabilities/tools/<name>/`.
- Tokens, logins and the data a script reads stay outside git. A capability lists such files under
  `secrets:`, and a profile denied the capability is denied those files as well.

`angelia guide capabilities` has the details and examples.

### What every agent knows about Angelia

Each agent carries a short self prompt, about a hundred words: which profile it is, that Angelia routes
and runs no model, where the instance and workspace are, and to run `angelia guide` before changing the
setup. It is product text, so it changes only when Angelia does. Claude Code gets it at launch
(`--append-system-prompt`). grok cannot take it that way, so Angelia keeps it between two
`angelia:self` markers in its CLAUDE.md and rewrites only that block at daemon start.
grok reads that file only in a folder it trusts.

`angelia guide [topic]` is the manual behind it: layout, profiles, routing, onboard, capabilities, jobs, commit, doctrine, commands.
`angelia profiles` lists the profiles and the chats routed to each; `--json` gives the same for a script, with each chat's session ids. Replacing the self prompt is
possible but discouraged: put your own text in `workspace/_shared/angelia-self.md`, and `status` and
`check-config` will warn that it no longer follows upgrades.

## Files

| Path | Purpose |
|---|---|
| `~/.angelia/workspace/` | the git repo: the table, the profiles, shared doctrine, capabilities |
| `~/.angelia/workspace/routing.yaml` | the table |
| `~/.angelia/env` | the bot token, mode 600 |
| `~/.angelia/sessions.json` | chat → agent session id, with history for `/resume` (the first line of a chat's first message is kept as a label) |
| `~/.angelia/daemon.log` | ids and counts, never tokens (see Logs above for the one place message text can appear) |
| `~/.angelia/api.token` | the owner's token for the local API (`angelia send`, `angelia turn`, jobs), mode 600; agents get their own, one chat each |
| `~/.angelia/api.sock` | the local API's Unix socket, mode 600 |
| `<profile>/.inbox/` | files received in that chat, for the agent to read |
| `~/.angelia/tui/<session>/` | tui-mode profiles only: the Stop-hook settings and the turn handover file |
| `~/.angelia/compiled/` | what the last compile wrote for each profile; the launch check reads it |
| [`docs/runbook.md`](runbook.md) | day-to-day commands, where to look, known failures and their fixes |
| `docs/decisions/`, `docs/investigation.md` | design decisions and the measurements behind them |
| `routing.example.yaml` | the example table in this repo. Your own lives in your workspace, and never here |

## What is yours and what is Angelia's

Angelia is a general tool. Nothing about one person's setup belongs in this repository: no chat
ids, no phone numbers, no home paths, no instruction files for your own assistants. Everything
that makes an install *yours* lives in `~/.angelia/` — the workspace for the table and what each
assistant knows, the parent directory for the credentials and the state. That separation is the reason you can pull a new version without touching your
setup, and the reason this repository can be public while your assistant is not.
