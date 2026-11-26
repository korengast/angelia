# Reference

Everything the README leaves out: each feature in full, setting up by hand, the instance folder, and every file Angelia keeps. For the security model, see [security.md](security.md).

## Features in detail

- **Profile = directory.** Anything your agent honours in a project (instruction files, settings, MCP servers, hooks) works unchanged. No personas live in Angelia.
- **Three CLIs behind one seam.** `backend: claude-code | grok | codex` per profile. `model`, `effort` and `permission_mode` are translated to each CLI's own flags. Switching a profile's CLI starts a fresh session; a session never moves between CLIs.
- **One session per chat**, resumed across restarts and idle periods. `/new` on one chat never touches another; `/resume` lists and switches between past sessions.
- **Group gating.** Reply only when mentioned or replied to, only to allowed senders, never to a chat that is not in the table. Unknown chats are dropped silently.
- **A new chat onboards itself.** With `defaults.unmatched: onboard`, an owner's first message in a chat the table does not know (in a group, one that mentions the bot or replies to it, unless `onboard.mention` is `any`) makes a profile for it: a folder named after the group, a starter `CLAUDE.md`, a profile and a route written into `routing.yaml` (with a backup, and rolled back if the result would not load), capabilities compiled, live at once with no restart. That first turn carries an onboarding prompt, so its agent asks what the chat is for and writes its own instructions and memory. The prompt ships as `prompts/onboarding.md`; `onboard.prompt` points at your own copy. Anyone else who adds the bot to a group gets nothing, and chats listed in `onboard.skip` (served by another gateway, or archived) are never onboarded. `angelia profile add <platform:chat>` does the same by hand, before anyone writes in the chat; the daemon picks it up at the next restart. `angelia guide onboard` has the settings.
- **Set up first, connect a group later.** A profile you have set up already (its entry in `routing.yaml`, its folder and `CLAUDE.md`) can take a new chat with no onboarding. `angelia profile connect <profile> whatsapp|telegram [--hours N] [--allow <ids>] [--owners <ids>] [--mention required|any]` arms it for the next new chat on that platform. Then an owner adds the bot to the group: the chat is routed to the armed profile at once, before anyone writes, with nothing posted there and no turn (WhatsApp's participant-add notification, Telegram's `my_chat_member`). Messages sent meanwhile wait for the route. If that event does not name an owner (a join by an invite link names none; an approved join request names the admin who approved it), an owner's first message in the chat does the same (in a group it must mention the bot, whatever the mention setting: that setting is for the messages after), and gets its answer with a short note to the agent, not the onboarding prompt. The route is built from the `onboard:` block as onboarding builds it: `--allow` replaces its `allow_from`, `--owners` adds to its owners, and the mention setting is `--mention`, else `onboard.connect_mention`, which is `required` by default: in a connected chat the agent answers only when mentioned (`onboard.mention` is for onboarding only). Only the `onboard:` block's owners use an arm. The profile is compiled again; its folder and instruction file stay as they are. The chat gets its own session. It works whatever `defaults.unmatched` says, needs the `onboard:` block, and is opt-in: with nothing armed, a new chat goes as before. An arm holds for 24 hours (1 to 168 with `--hours`), is used once, and one profile at a time per platform (a new arm replaces the old one, and says so). `angelia profile connect` lists the arms, `angelia profiles` shows them too, and `--cancel whatsapp|telegram` takes one back. `angelia profile connect <profile> whatsapp:<id>` routes a chat whose id you know now; the daemon picks it up at the next restart. An add older than the arm (a replay after a reconnect) does not use it, on WhatsApp and on Telegram, by the time the platform gives the add (a minute of slack for clocks); a WhatsApp add that arrives while the connection catches up after a reconnect is not used either. A bind that fails posts nothing in a group and one fixed line in a DM. The daemon log says `connect-armed`, `connected key=... profile=...` (with `on=join` for the event) and `connect failed ...`.
- **Permission relay.** When the agent wants to run something under a cautious profile, the chat receives `🔐 Bash: rm -rf build` and, under it, `Reply "yes" or "no". (request 6b480a6f)`. An owner answers `yes` or `no` (`y`, `n`, `כן` and `לא` too). `yes 6b480a6f` and `no 6b480a6f` name the request and work in every case. The word alone is taken only where it can be meant for nothing else:
  - *A reply to the request's own message* (a swipe-reply) answers that request, also with several open. The request is found by the id of the message replied to, never by the quoted text. A reply to the line of a request that is over is told "too late"; a reply to any other message (a person's, the agent's own question) is a message for the agent.
  - *With no reply*, in a private chat, or when the message mentions the bot (`@bot yes`; another person's mention beside it makes it a message). In a group a plain `yes` is a message, never an answer: there, reply to the request or mention the bot. It answers the one open request when that request was in the chat three seconds before the word was sent. The word's time is the platform's own for the message; the request's is the platform's on Telegram (whole seconds on both sides, so three to five in practice) and this machine's clock on WhatsApp, which does not say when it took the line; sooner, or with no time on the message, the chat is asked to read the request and answer again. With several open, Angelia lists them and asks which. The chat is told what the word was taken for (`Allowed: Bash: rm -rf build (request 6b480a6f)`).
  - *Not for three minutes after a request of that chat ended with no answer from the chat* (it timed out, was answered in the app or the pane, or its turn ended): a `yes` typed for it on a phone that was offline arrives late, and nothing on the message tells. In that time a bare word answers nothing and is not passed to the agent; the chat is told to reply to the request, use its id, or its button. A request that was open beside the one that ended, or was asked within those three minutes, takes no bare word for as long as it waits: the late word could arrive at any time.
  - A bare word from anyone who is no owner is a message, as any other text.
  - Unanswered requests are denied after ten minutes.
- **Buttons on Telegram.** There the request also has Yes and No buttons under it (not in a channel). A press by an owner answers the request that message was sent for, three seconds after it appeared at the earliest; anyone else's press is told so and answers nothing. The buttons go once the request is answered, timed out or its turn ended; typing works as on WhatsApp.
- **Permission levels.** `permission_mode` decides which actions the CLI asks about at all; `permissions` on the profile decides what Angelia does with each request it asks: refuse it at once (the agent hears "Not permitted" and says so in its own words), ask the chat (yes or no, an owner's answer only, as above), or approve it at once (nothing is posted). It is a default and three lists of rules that beat it, checked in this order: `refuse`, then `ask`, then `approve`; the first list with a matching rule decides. `permissions: ask` alone is the default. The five levels:

  | Level | In the table |
  |---|---|
  | refuse all | `permissions: refuse` |
  | refuse some | `permissions: { default: ask, refuse: [Bash(rm *), Bash(git push *)] }` |
  | ask all | `permissions: ask` (the default) |
  | ask some | `permissions: { default: ask, approve: [Bash(git status), Bash(git log *)] }` |
  | approve all | `permissions: approve` |

  Rules are Claude Code's own [permission rule syntax](https://code.claude.com/docs/en/iam), fixed patterns matched in code, never judged by a model: `Bash(npm run test:*)`, `Bash(git * main)`, `Read(~/.ssh/**)`, `Edit(src/**)`, `Read(//etc/**)` (an absolute path), `WebFetch(domain:example.com)`, `mcp__server`, `mcp__server__tool`, `Agent(Explore)`. A rule the matcher cannot check (a specifier on `Glob`, a negated path) fails the load. Where a case is unclear it leans the safe way. A shell approve rule passes only a plain line: words of letters, digits and `_ . / : @ % + = , ~ -`, or quoted strings with no `$`, backtick or backslash inside, joined by `&&`, `||` or `|`, with every part matched by an approve rule and no `VAR=` in front (git's `-c`, `--config-env` and `--exec-path` never pass). Anything else (`;`, `&`, a redirection, `#`, `$(…)`, a glob, braces, a newline, a tab) is asked, whatever the rules say; so is a line over 8 KB. An approve rule covers every argument the command takes, including the ones that write files or run programs: `Bash(git log *)` passes `git log --output=~/.zshrc`, `Bash(git grep *)` passes `git grep -O<program>`, and `find`, `rg --pre`, `sort -o` and `tar` can do the same. Approve only commands whose every option you accept, or name the arguments in the rule. A rule holds at most 8 `*`; a line Angelia cannot read within 50 ms is asked (refused when the default is refuse). A shell refuse or ask rule matches if any part of the line does, read several ways: after `&&`, `;`, `|`, a comment mark, inside `$(…)`, `{ … }`, `if`/`then`/`do`, behind `sudo`, `env`, `timeout`, `nice`, `xargs` or `bash -c '…'`, inside `eval` and `find -exec`, git past `-C` and `-c`, with quotes and backslashes taken out of the name (`\rm`, `"rm"`). That is best effort: a variable (`X=rm; $X x`) or another language (`python3 -c …`) is not seen, and a Read rule does not see `cat` in a shell command. A hard limit belongs in the profile's `deny` rules or the sandbox, which the CLI or the operating system enforces. Path rules match a path as the disk resolves it (a link that points out of an approved folder is not approved), every path of the request (NotebookEdit's notebook, a Grep or LS path, a Glob pattern's folders before its first wildcard; an approve never passes a Glob pattern with `..`). `x/**` covers the folder `x` itself. A relative path rule with a slash, such as `secrets/**`, refuses at any depth but approves only under the profile's folder; a bare name such as `Edit(*.md)` matches at any depth under it, the profile's own CLAUDE.md files too. A domain rule refuses its subdomains too and approves only the host itself. `mcp__server` approves only that server's tools, not `mcp__server__x__y`. The older `permission_prompts: chat | deny` still works as `ask | refuse`; both set and disagreeing fail the load. Every request Angelia refuses or approves by itself is a line in `daemon.log` with the rule that decided (`by=refuse: Bash(rm *)`, `by=default approve`). A turn is stopped after 10 refusals; after 50 approvals the rest of that turn is asked.
  - *Between turns (tmux mode).* The levels also decide the requests of a turn the agent starts by itself in the chat's pane after the chat's turn ended, when that turn is tied to the chat's own work: the end of a background task, or a teammate's message, that a turn of this chat started (or the chat's own message that Claude Code runs as a turn of its own). Refuse and approve act at once, with the same log line and `(between turns, a turn the agent started by itself)` after it; ask posts the request in the chat under one line, "The agent woke up by itself (a background task ended, or a message came) and asks:", and only an owner answers it, as in a turn. Work a peer's turn started (another profile's, with its token) is refused at once but never approved at once: it is asked, as in a peer's turn. A teammate ties a turn only while the chat's session still has it open (spawned in the chat's turn, not ended). A turn nothing ties to the chat's work (a prompt the session scheduled, another session's message, a turn the hook cannot place, which may be the owner's own in the Claude app) is always asked, whatever the levels say, under "A turn Angelia did not type in this session asks (the agent woke by itself, or someone typed in the Claude app):". The caps count per such turn; past 10 refusals the session is stopped. A turn a person typed in the Claude app, over Remote Control or in the pane is theirs, as before: the hook steps aside, Claude asks in its own dialog in the app and the pane, and the chat is told about 20 seconds later that a dialog waits (the screen notice below), but cannot answer it. The same holds for a request that comes while a chat turn is read but is not of that turn: the hook says what started the turn on every request, and the chat turn takes only those of a turn its own message opened with no other prompt in it (a turn Claude Code ran first, such as a task's end or another session's message queued before the chat's message, goes the way above). This holds while Angelia reads the session between turns (from the chat's last turn until `defaults.idle_exit_minutes` pass, as for the answers below); after that, or after a daemon restart until the chat's next message, the hook steps aside for every turn and only the screen notice is left.
  - *Per backend.* Claude Code (print mode and the tmux hook) gives the tool and its whole input, so every rule can be checked. pi gives shell commands and file paths, after its own gate has decided the request needs asking. Codex and Grok Build give only shell commands; a Codex file change, terminal input or request for more access carries nothing a rule can name. On a request with nothing to check, no rule matches and the default decides, except that `approve` with refuse or ask rules asks instead. `check-config` names each rule a profile's backend cannot check. In tmux mode a dialog that did not come through the hook is never approved or refused by Angelia.
  - *Safety.* Any approve, `default: approve` or a single approve rule, on a group where people other than the owners talk to the agent fails the load: any of them could have the agent do what an approve passes, with no owner asked. The ways out: list only owners in `allow_from`, or set `unsafe_ok: true` on the profile. A sandbox does not count here, unlike for `bypassPermissions`: under a sandbox the requests still asked are mostly the ways out of it (a Codex request for more access, a command run outside the sandbox). A turn another profile asked for (`accept_from`, `angelia turn` with its token) is never approved by the levels: its requests are asked. The owner's own jobs keep their approvals. With `bypassPermissions` nothing is asked, so `permissions` decides nothing, and `check-config` says so.
- **Two ways to host the agent.** By default each session is a headless CLI process: permission prompts arrive as JSON and the screen does not exist. `tui: true` on a Claude Code profile runs the same CLI as a real interactive session in tmux instead — Angelia types the turn into the pane and a Stop hook hands the answer back. That session registers with Remote Control, so the chat appears in the Claude app and can be continued from the phone; it also outlives a daemon restart, keeps MCP servers warm between turns, and treats slash commands exactly as a terminal does. A pane Angelia reads no more (after `idle_exit_minutes`, or a restart) is ended once it sat idle for `defaults.pane_idle_hours` (default 12), or as soon as it is idle when it runs an older Claude Code than the one installed; the next message resumes the conversation (if Claude Code then asks "Resume this conversation?" because the session is long and was idle, Angelia chooses Resume, never a new conversation; it also answers that dialog on a running idle pane). A pane that is mid-turn, shows a dialog or still has a background task or a teammate open is kept. Its permission prompts reach the chat through Claude Code's own permission hook, as the exact request print mode shows, and an answer goes to that request alone. A daemon restart in the middle of a turn does not cut it: the new daemon reads the turn again for its chat (its answer, its progress, its permission requests, the ones that were waiting offered again), and a hook asked while no daemon runs waits up to a minute for the next one before it lets Claude open its own dialog. Between the chat's turns the hook relays too: a request of a turn the agent started by itself goes the profile's way (Permission levels, *Between turns*). A dialog that did not come through the hook (one in a turn a person typed, or one left open while nobody read the chat) is answered in the Claude app or in the pane: the chat is told once it has stood about 20 seconds that it waits, and where to answer it, but cannot answer it, since only the screen says what it asks. That holds in a narrow pane too (a small terminal attached to it), where the dialog's long options wrap. Two answers reach the chat with no message waiting for them. A late one: a turn Angelia closed without the Stop hook's answer (the chat was told "ended its turn without an answer", or got only its last line), whose answer comes after all; it is sent when it comes, unless the chat already has those words. And one to a turn the agent started by itself: a background task or a subagent that a turn of the chat started ended (or a teammate such a turn spawned sent its message), Claude Code woke the agent, and what the agent then says is sent to the chat as its message, at most 6 an hour per chat for tasks' ends and 30 for teammates' messages (a teammate's idle note counts in neither); past that the chat is told once that more are held back, and those are not kept. An empty answer or `[SILENT]` sends nothing. The Stop hook says what started each turn, which tasks' ends, and a key of the typed prompt; only a turn Claude Code queued for the end of a task a turn of the chat started counts, and a late answer only when its prompt is the one Angelia typed: a turn typed in the Claude app, over Remote Control or in the pane never reaches the chat, nor does a turn someone typed into while it ran, the end of a task the owner started in the app, a prompt the session scheduled for itself, a message of a teammate the owner spawned in the app, or a turn the hook cannot place. Both only while the chat's session is warm: Angelia reads a session between turns from the chat's last turn until `defaults.idle_exit_minutes` (default 30) pass with no message and no turn woken by the end of the chat's own work; after that, and after a daemon restart, until the chat's next message, what the session says by itself stays in the Claude app. A message that comes while a turn runs is typed into that turn, as a person types into a busy Claude Code: the agent reads it, under the same header line, when its running tool call returns, and the turn's one answer answers both (no extra line in the chat). That happens only at a safe moment: while one of the agent's own tool calls runs, with no permission request open, no subagent and no question or plan approval at work, and the input box empty on screen; the Enter is pressed under a lock that Angelia's PreToolUse hook honours, so the permission dialog of a tool call cannot open under it. A dialog no tool call's check raises (the sandbox's network prompt, an MCP server's own request) has only the screen check. A pane whose merged settings or enabled plugins add another PreToolUse hook takes no messages into its turns, and `/status` says so. Until then the message waits; if the turn ends first, it runs as a turn of its own. Commands such as `/stop` are never typed in, and `/stop` or `/new` drops a message still waiting, as it drops queued ones. Only the chat's own turns take messages: a job's, a watch's or an `angelia turn` turn never does. When Claude Code runs messages it got too late as the next turn by itself, that turn is read as the chat's (its permission requests, progress lines and answer). If the turn fails after it took a message, the message runs again as a turn of its own. `midturn: false` on a profile keeps every message waiting for the turn to end, and leaves out the PreToolUse hook, which otherwise runs before every tool call. A restart that adopts the running turn takes them along: the messages typed into it are answered by its answer in the next daemon, and one still waiting for its moment runs after the turn, as queued messages do; with a turn that is not adopted, a waiting one is dropped and the log counts it. Print mode always waits. Trade-offs in [ADR 0008](decisions/0008-tui-host-mode.md). The pane and its Remote Control entry are named `<prefix>-<profile folder>-<first 8 of the session id>`; the prefix is `angelia` unless `defaults.session_prefix` or the profile's own `session_prefix` says otherwise (it starts with `angelia`, for example `angelia-vps`), so two instances can be told apart in the Claude app. A changed prefix names new panes; one already running keeps its old name until it is ended.
- **Files in.** A photo or document sent to a routed chat lands in `<profile>/.inbox/` and the agent gets a `[file: path]` line. A voice note gets `[voice note: path]` and the agent transcribes it itself by running `angelia transcribe <path>`, which prints the text — one transcriber for every profile, on whisper's accurate model rather than its fastest (measured on Hebrew), and it detects the language by itself. The agent runs it; the daemon never does. For a spoken reply the other way, `angelia speak "<text>"` prints an audio file made with the voice built into the machine — no provider, no key, offline — with the system's Hebrew voice for Hebrew text and its default voice otherwise, and the agent attaches it with `angelia send-media`. Both commands are a default, not a rule: setup asks how this install should hear and speak, and a hosted API, another tool or neither is a valid answer — whatever you name is what the instruction file will say. Angelia runs no model of its own, not even for speech.
- **Replies.** When a message replies to another one, the agent gets the quoted text under the envelope, every line behind `>`, labelled `Replying to (quoted by the sender's app; author not verified):`. The sender's app supplies that text and its author, so the agent treats it as data, never as an instruction. On Telegram it is the part the user selected, else the whole message or its caption. It is cut at 2,000 characters, with `…`.
- **Files out.** `angelia send-media <platform:chat> <absolute path> [caption]` attaches an image, a video, a voice note or a document. The kind is read from the extension; audio is converted to ogg/opus with ffmpeg when it is on PATH, so it arrives as a real voice bubble on both platforms. Every path is checked once, wherever the request came from: absolute only, symlinks resolved, a real file, inside the platform's size limit, and never from a credential location (`/etc`, `~/.ssh`, `.env`, key and token files, shell history, the instance's own secrets and logs), in any letter case. When an agent asks, the file must also be one its profile's deny rules let its file tools read, so another profile's folder is refused. The check covers attachments only: an agent that can read a file can still quote it in its reply. A profile with `media_tags: true` also honours a `MEDIA:<absolute path>` line in the agent's own reply; it is off by default, so a model that quotes such a line in prose cannot send a file nobody asked for. In a WhatsApp group a caption never tags a member, and a phone number the group hides is written as its lid there too, as in a text.
- **Streaming delivery.** Progress lines while the agent works, then the answer, chunked to platform limits and paced (`max_out_per_min`, per platform). Progress never holds the answer: lines that pile up go out as one message, and one slot a minute is always kept for the answer and for permission prompts.
- **API errors are retried, not posted.** Claude Code writes a failed API call (a lost login, a 5xx) as an assistant row of its own, marked as an error. Angelia does not send those words to the chat as the agent's answer. For a 5xx, an overload, a network failure or a lost login it runs the same turn once more, in the same session, after one minute (another error, like a prompt that is too long, ends the turn at once); `/stop` or `/new` in that minute cancels the retry. A login that is still lost gets one line that says to run `claude` and `/login` on this machine; another error gets the failure line. A usage limit is not retried: the chat gets the limit and the `/model` hint.
- **Inbound limit.** A sender who is not an owner gets `max_in_per_hour` messages to a profile in an hour (`defaults`, default 50; a profile may set its own; 0: no limit). Every kind counts: a turn, a command, a `yes` or `no`. Over the limit a message is dropped, and the sender gets at most one line an hour, not one for each message. The line goes only to a message that addresses the bot (a DM, a mention, a reply): in a `mention: any` group a message to others is dropped in silence. The count is per sender, not per chat: in an `allow_from: ["*"]` group, N accounts get N times the limit. A message with no sender (a Telegram channel post) is not counted.
- **`angelia restart`.** Stops the daemon and starts a new one in its own session, with the config it was last started with; under the LaunchAgent it reloads the job instead, so a rewritten plist takes effect. Run by a chat's own agent while that chat has a turn running, it does not stop the daemon under that turn: it asks the daemon with the agent's own token (which names the chat), prints "Angelia restarts when this turn ends", and the daemon restarts once that turn has ended and its answer is in the chat (waiting up to 10 minutes for other chats' turns), says so in that chat, and posts "back up" there when it is (`--force` changes nothing here). With no turn running in that chat, or no daemon, it refuses, as before, unless `--force`. From a chat, an owner sends `/restart`: the router loads the routing table first and refuses a broken one; when the table changed since the owner last accepted it (docs/security.md), it lists the changes and waits for `/restart confirm`; then it answers, then runs the restart detached in its own session so stopping the daemon cannot kill it, and the new daemon posts "back up" into the chat that asked. `/sh angelia restart` is refused for exactly the reason `/restart` exists.
- **Router commands** `/new` `/stop` `/status` `/resume` `/model` `/effort` `/backend` `/sh` `/restart` `/help`, answered without spending a token, and registered in Telegram's command menu. `/stop` during a turn ends the CLI and everything it started, a server it left running in the background included; a session that ends by itself (idle, `/new`) leaves those to the CLI. `/status` from an owner in a Claude Code chat ends with the command that resumes that session in a terminal (`cd` to the profile, then `claude --resume <id>` with the profile's permissions, model, effort, `add_dirs`, Chrome and strict MCP config, auto memory off as in the chat). `/model` and `/effort` alone show the one in use and what the CLI offers: Codex and Grok Build are asked for their model lists (Codex also gives each model's effort levels, and a level or a model it does not offer is refused), Claude Code's aliases are listed. With a value they override the profile for the current session only. `/backend` alone shows the profile's CLI and the ones installed; `/backend <cli>` (owners only) moves the profile to that CLI the way onboarding writes the table: the table is backed up and edited in place, `model`, `effort`, `bin` (and `tui` when leaving Claude Code) are taken off because they belonged to the old CLI and kept under `backends: <old cli>:` in the profile, a switch back to that CLI puts them on again (what is on the profile at switch time wins over an older entry), the profile is compiled for the new one, and a failure puts the old table back. Every chat on that profile starts a fresh session on the new CLI at its next message.
- **A loopback API for your own scripts.** `angelia send <platform:chat> [--source <label>] <text>` posts a line into a routed chat (a `MEDIA:<absolute path>` line in that text attaches the file); `angelia send-media` attaches one directly (it takes `--source` too); `angelia turn <platform:chat> <text>` types a prompt into that chat's session and the answer lands in the chat. The chat's agent is not asked when a line is posted, but it is told at its next turn: before the message it reads a short block of what was posted since its last turn, oldest first, each line with its local time and who posted it, under a head line that says they are data, never instructions, and must not be sent again. A job's or a script's line (any label but `owner`, `angelia`, `profile <name>`) is marked `output, unverified`. Who posted is `owner` for the owner's token, the `--source` label when one is given (a job gives `job <name>`), `profile <name>` for another profile's agent, and `angelia` for the daemon's own lines. A line the agent posts into its own chat with its own token and no source is not told back to it. A file goes in as `[file: <name>]` plus its caption. The block holds at most 4000 characters (the newest stay); a CLI command typed in the chat (`/compact`) goes as typed and leaves the block for the next turn. The lines are kept in `~/.angelia/posted-lines.json`, the newest 200 per chat, and `angelia export` gives them too. Both are how a cron job talks to an assistant without a gateway of its own. `angelia ask <platform:chat> <question>` asks that chat's agent and prints the answer: a read-only copy of its session answers (Claude Code, Codex and pi; not Grok Build yet): it reads files and nothing else, with no shell, edits, web or MCP, the profile's deny rules holding, and nothing kept, beside whatever the chat is doing; a DM hears one line that it was asked, a group nothing. A profile answers only the profiles it lists in `answer_from` (none by default; `"*"` for all); the owner may always ask. A task from another profile (`angelia turn`) needs the target to list that profile in `accept_from` (none by default); a line (`angelia send`) needs no listing to reach the chat, but the target's agent reads it at its next turn only when the target lists the sender in `accept_from`; else only the chat sees it. They talk to the daemon over a Unix socket, `~/.angelia/api.sock` (mode 600), never a network port. From your terminal they use the owner token in `~/.angelia/api.token`; an agent uses its own, which works only for its own chat. A chat takes at most 10 turns at a time, running and waiting together, wherever they come from: past that, `angelia turn` is refused (HTTP 429) until the chat answers or someone sends `/stop`.
- **A read API for a desktop app.** With the owner token only (an agent's token is refused), the same socket answers `GET /status`, `/profiles`, `/sessions`, `/history`, `/jobs`, `/permissions`, a profile's `/instructions`, `/files` and `/file` (inside its folder only; credential files, links out and what the profile's own deny rules cover are never shown), its `/memory` (its memory folder and the files its instructions import with `@`), `/skills` and `/skill` (from the table, its folder, and the CLI's own skills folder), and `/capabilities` (what each is, never its arguments, environment or secret paths), and a live event stream, `GET /events` (progress, permission requests, answers). `/history` reads each CLI's own record: Claude Code and pi from their session files, Codex through its app-server (`thread/turns/list`), Grok Build by having grok replay the session (a few seconds; kept until the chat's next turn ends). A turn sent with `POST /turn` and `reply: "caller"` answers the caller only, never the chat. `GET /healthz` says `api: 1` and the features it has. The contract, which routes are stable and what may change, and the OpenAPI document: [api.md](api.md) (`angelia api spec` prints the document).
- **Scheduled jobs, run by the operating system.** A profile lists its jobs in `angelia-jobs.yaml` in its own folder (a cron schedule, an interval or a one-time `at:` date and time, and a turn, a message or a command). A one-time job's timer removes itself once it fires, whether the run worked or not. A Mac asleep at that time runs it at the wake if that is within 12 hours; later, the job does not run and the chat gets one line that it was missed. A Mac off or logged out at that time does not run it at all (launchd makes up a missed time only after sleep). The timer carries the date itself (`--once`), so it still removes itself when the file broke or changed before the fire. After its time `angelia jobs` lists it as `done` (it ran; noted in `jobs-once.jsonl` in the state folder, so a long jobs.log does not lose it) or `passed`, and install skips it and removes a timer left for it. `angelia jobs install` turns each into a LaunchAgent that calls `angelia jobs run`; the daemon itself still wakes nothing up. A timer runs the job as it was installed, and refuses, in the chat, a job whose definition, or a script in its profile folder that it names, changed since. That pin cannot cover what a script loads (a module next to it, a Makefile), so on a profile whose agent is sandboxed (`sandbox: true` on Claude Code, Codex and pi by default) a `run:` job runs in the same macOS sandbox: the agent's deny rules, writes only in its own folders. A command's output reaches the chat with the chat's own token, so its `MEDIA:` lines are held to the profile's rules. `angelia guide jobs` has the format.
- **One transcript format for every backend.** `angelia export <platform:chat>` prints the chat's turns as JSONL (time, role, text, tools used), read from the files Claude Code, grok and Codex already keep. `--all` covers every session the chat has had; tool output is left out unless you add `--tools`. The lines posted into the chat past the agent are among the rows too, in their place by time, with a `source` field saying who posted.
- **Trouble counted, and tmux mode tried on each new Claude Code.** `angelia health [--days N] [--json] [--alert]` reads `daemon.log` (and `daemon.log.1`) and counts, per profile and calendar day over the last 24 hours or N days (at most 30): turns with no answer, failed (not one stopped with `/stop`, and not a failure the daemon tried again: the retry's own end counts), stalled, thrown, answers not delivered, tmux turns ended by the quiet pane (all, and those with no answer for a message), panes that read idle with the turn open, API errors, fresh-session retries, auto-denied permissions, prompt key misses (a marker dropped, or its answer kept by the net), and the daemon's own starts, WhatsApp drops and send retries. A window longer than the log says where the log starts. A routed chat is shown as its profile, any other by the first eight characters of its id; only columns that counted something are printed. The log has one line per turn in tmux mode only, so `tmux turns` is not a total of all turns. `--alert` is for a daily `run:` job: no output within the limits (per profile: 2 turns with no answer, 3 failed, 1 stalled, 2 quiet-pane ends with no answer, 1 prompt key miss), else one line for the chat. `angelia canary [--if-new-build] [--json]` starts the installed Claude Code in a tmux server and a temp folder of its own, on the cheapest model, in permission mode `default` and with no MCP server (the owner's hooks, settings and `CLAUDE.md` load as in any pane), and checks the start (with its dialogs), a one-word turn ended by the Stop marker, a turn pasted as a chat turn is (several lines, Hebrew, a quoted line) ended by the Stop marker with the hook's key of its prompt matching what was typed, a 20 s shell command that reaches the canary as a permission request through the relay hook (it allows that exact command and refuses any other) and during which the screens must read busy (one that does not is kept and passes, two in a row fail), the idle screen after it, and `/clear` ended by the quiet pane; exit 0 passed, 1 failed, 2 could not run (no tmux, no CLI, not logged in, a state folder it cannot write) or could not judge the build (the plan's limit, a failed API call or a lost login: nothing recorded, the next run tries again). Each run costs a few model calls on the owner's plan (three short turns). `--if-new-build` runs only when `claude --version` is not the build that last passed (`canary.json` in the state folder) and prints one line, on standard error with exit 1 or 2 for a failure or no verdict so a job posts it; failed screens are kept under `tui/canary/<time>/`. See the [runbook](runbook.md), "Watching for trouble".
- **Subscription-safe.** API-key variables are stripped from the agent's environment, so a chat cannot quietly move you from your subscription to a per-token bill. In the default mode a Claude Code session that would still bill an API key (a stored key, a key helper) is refused. A `tui: true` session is checked before it starts for a key helper in any settings file it reads and for the CLI version; a key stored with `/login` is not visible from outside there.

## Your CLI brings the capabilities

Angelia carries things between a chat and an agent: messages, files, voice notes, the agent's permission questions, and scheduled turns. That is all it does. Everything the agent can *do* — browse, read email, fill a cart, look something up, remember — comes from the CLI you already run and what you give it: skills, MCP servers, connectors, instruction files.

So a good personal assistant is mostly a well set-up CLI, and Angelia helps with that rather than doing it itself:

- **Per-profile capabilities.** Declare a skill, an MCP server, a command, a folder or a Claude app connector once in the table, give it to the profiles that should have it, and `angelia compile` writes it into each profile's own CLI settings, denies included. On Grok Build an allowed MCP server still has to be added once with `grok mcp add`. See [Skills, scripts and tools](#skills-scripts-and-tools) and [Claude app connectors](#claude-app-connectors).
- **Starter skills.** `angelia init` copies two into your workspace, as gentle suggestions you can edit or ignore: `checkout` (build the cart, hand you a checkout link to pay on your phone) and `mfa` (where one-time codes usually are, and asking before using one). Nothing is granted until you give a skill to a profile.
- **Voice, built in.** `angelia transcribe` and `angelia speak` are the one thing that ships as code, because every chat gets voice notes. They are still run by the agent, never by the daemon; `src/voice/README.md` has the details.
- **A manual for the agent.** `angelia guide` tells an agent how the instance is laid out before it changes anything.

## Backends in detail

| Backend | `backend:` | How | Permission prompts | Resume |
|---|---|---|---|---|
| Claude Code | `claude-code` (default) | one long-lived `claude -p` process per session over its streaming JSON protocol: warm prompt cache | relayed to the chat (a typed yes from an owner) | `--resume` with the id Angelia mints |
| Grok Build | `grok` | one long-lived `grok agent stdio` process per session over ACP (JSON-RPC on stdio) | relayed to the chat (a typed yes from an owner) | `session/load` with the id grok mints |
| Codex | `codex` | one long-lived `codex app-server` process per session over JSON-RPC on stdio, inside Codex's own OS sandbox with the profile's rules | asked in the chat only for more access than the sandbox gives, such as one more folder for that turn (never in bypass and plan) | `thread/resume` with the id Codex mints |
| pi | `pi` | one long-lived `pi --mode rpc` process per session; Angelia's gate extension holds the profile's rules, and every shell command and file read or write runs in a macOS sandbox made from them (ADR 0011) | relayed to the chat (a typed yes from an owner) | `--session-id` with the id Angelia mints |
| Antigravity CLI | `agy` | one long-lived `agy acp` process per session over ACP, with its own `--gemini-dir` in the state folder (never `~/.gemini`). The whole process runs in a macOS sandbox made from the profile's rules, and Angelia's gate (pi's rules engine) answers each permission request agy sends (ADR 0017) | relayed to the chat (a typed yes from an owner) when the rules do not decide | `session/resume` with the id agy mints (no replay) |
| OpenCode | coming soon | same `Brain` interface | | |

Antigravity CLI (`agy`, 1.5.14 or newer) was a backend until 2026-09-21 and is one again from 0.4.0 ([ADR 0017](decisions/0017-agy-backend.md)). Headless `agy -p` could not deny a single tool, and its MCP servers were machine-wide ([ADR 0007](decisions/0007-agy-and-grok-backends.md)). `agy acp`, its Agent Client Protocol server, changes both: every write, edit, shell command and MCP call is a permission request that Angelia answers, and MCP servers are given per session. agy itself honours no allow or deny rule over ACP, so Angelia holds them: the gate decides each request, and the sandbox holds the deny rules for every file read and every program agy runs, reads inside the profile folder included (agy never asks before those). Angelia never selects agy's `auto` mode, which runs commands unasked. `plan` and `bypassPermissions` are held by the gate: agy's own plan mode is advice to the model only. Before each start Angelia writes `GEMINI.md` in the profile folder from `CLAUDE.md`, with its `@` imports expanded (agy expands only the Markdown-link form); edit `CLAUDE.md`, never `GEMINI.md`. agy refuses to start beside a hand-written `GEMINI.md` or `AGENTS.md`, one in a folder above the profile, a `.agents/mcp_config.json`, or a `.agents/skills` folder (in the profile folder or an `add_dirs` folder), since agy would load them on its own. An agy profile's floor closes your whole `~/.gemini`; a profile on another backend keeps it open, so it can run your own `agy` as a tool. Every profile is denied the agy folders in the state folder. Its login is its own: run `agy` once and sign in with Google.

### What works on each backend

Claude Code is the reference backend. This table says what agy does with each feature, so a profile can be moved with open eyes. **CC only** marks what only Claude Code has.

| Feature | Claude Code | agy |
|---|---|---|
| Permission relay | yes: the CLI asks, Angelia relays | yes: every write, edit, command and MCP call asks; Angelia's gate decides or relays. Reads inside the profile folder and web search never ask |
| Deny rules for reads | the CLI's own rules; with `sandbox: true` the OS holds them for every program | the macOS sandbox, for the file tool and every program; reads outside the folder also pass the gate |
| Deny rules for writes | the CLI's own rules; with `sandbox: true` writes only in the profile's folders | the gate for each request, and the sandbox: writes only in the folder, `add_dirs`, `_common`, agy's own folder, the cache and temp |
| Deny rules for commands | the CLI's own `Bash(...)` rules | the gate, with the same `Bash(...)` rules (pi's rules engine); the sandbox holds what a command reaches |
| MCP per profile | yes, compiled settings with a strict MCP config | yes, the table's servers in `session/new` and `session/resume`; a `.agents/mcp_config.json` stops the start |
| Skills | yes, `.claude/skills` | yes, compile links them into agy's own folder (`config/skills`); agy's built-in skills load too |
| Instructions file | `CLAUDE.md` | a generated `GEMINI.md`, copied from `CLAUDE.md` with imports expanded, before every start |
| Resume | `--resume` | `session/resume`, no replay |
| `/model` | yes, Claude Code's aliases | yes, the list `agy models` gives; default `gemini-4-hydrogen` |
| `/effort` | yes | yes: `low`, `medium`, `high`, `xhigh`, as the model id's suffix |
| tmux mode (`tui: true`) | yes | no (**CC only**) |
| `chrome: true` | yes | no (**CC only**); agy has no browser tool and no URL reader over ACP |
| Web search | `WebSearch` asks unless an allow rule passes it, and a deny rule refuses it | `search_web` never asks, in any mode, plan included: the gate never sees it and no rule can stop it, so anything agy can read could leave in a search query |
| Background work after a turn | in tmux mode, the agent's wake-up reaches the chat | yes: a background command that ends wakes agy, and its message and permission requests reach the chat between turns; `/stop` and session end close the session, which ends that work |
| Subagents | yes, their permission requests reach the chat | partial on agy: starting one never asks. Angelia finds the subagent's session and gates its permission requests: during a turn they are asked in the chat, after the turn they are refused. A subagent Angelia cannot find gets one line in the chat, since nothing it asks can be approved. The generated `GEMINI.md` tells agy to do tool work itself, and every use is logged. Swarm, workflows and schedule never ask and are not gated |
| `angelia ask` | yes, a read-only copy | no: agy cannot copy a conversation, so a question would write into the chat's own session; refused with a clear reply |
| `angelia export` and `/history` | yes, from the session file | yes, agy replays the session (`session/load`) inside the same sandbox |
| Prompt cache | warm, one process per session | not measured |
| Latency | not measured here | measured on agy 1.5.14: start 1.6 s, a one-word turn 2-8 s, a tool turn 5-25 s; about 200 MB per process |

The backend is a single interface in `src/brain/`: start in a directory, send a turn, receive progress, permission requests and a result. Routing, sessions, gating and delivery never mention a specific agent.

## Setting things up by hand

`angelia init` asks which of two shapes you want. **Quick** is one chat and one folder. **Advanced** is several profiles, each with its own folder, permission mode and chats. It asks whether you write from Telegram, WhatsApp or both, links WhatsApp by QR when you pick it, and pairs each chat by the first message you send from it. For a Grok Build profile it marks the folder trusted in grok. Advanced also offers, default no, a profile that works on Angelia itself: it clones the source into `~/.angelia/projects/angelia`, and the profile reaches it through `add_dirs`. The daemon keeps running the installed package, never that clone. Both end with a plain `routing.yaml` in `~/.angelia/workspace` that you can edit by hand later; `angelia check-config` validates it and warns about risky combinations. A key it does not know is an error that names the key, so a misspelling never falls back to a default; the old `pay` and `approvals` keys are still accepted, with a warning to delete them.

To install without the script: `git clone --branch v0.3.2 https://github.com/korengast/angelia && cd angelia && npm ci --ignore-scripts && npm run build && npm i -g --ignore-scripts "$(npm pack --ignore-scripts | tail -1)"`, then `angelia init`. Without the service, `angelia daemon` runs it in the terminal; it reads `~/.angelia/env` itself.

The wizard only writes files you can write yourself.

1. **Profiles.** A directory per assistant with its instruction file: `CLAUDE.md`, for Claude Code, Grok Build and Codex alike. agy gets a generated `GEMINI.md` copy of it before each start: never edit that copy by hand. `~/.angelia/workspace/profiles/coding`, `…/family` — or any directory of your own, when the assistant's home is a project you already have. Grok Build needs one extra step before it reads that file: it loads project rules and `.claude/settings.json` only in a folder you have trusted once, with `grok --trust` in it. `angelia init`, onboarding and `/backend grok` do that step for you.
2. **Telegram.** Store the BotFather token in `~/.angelia/env` as `TELEGRAM_BOT_TOKEN=...`, mode 600. For groups, make the bot a group admin: Telegram's privacy mode otherwise hides plain @mentions from bots.
3. **The table.** Write `~/.angelia/workspace/routing.yaml` like the example above and validate it with `angelia check-config` (no path needed). Then `angelia compile <profile> --write` for each profile: it writes the deny rules into the profile's `.claude/settings.json`, and the daemon starts no agent for a profile that was never compiled. A Telegram DM's chat id is your numeric user id; a group's is its negative `-100…` id. Both appear in the daemon log the first time an unrouted chat writes in.
4. **WhatsApp.** Add a `whatsapp:` block, run `angelia accept` (`angelia pair` reads the accepted table), then `angelia pair`, then restart the daemon. Angelia links to the account as a companion device, like WhatsApp Web: `angelia pair` opens a local page with a live QR (also printed in the terminal); on the phone that owns the number choose Linked devices > Link a device and scan it. The page reports each stage, and a half-finished link is cleaned up and retried by itself. `pairing: code` (with `phone:` in E.164) exists, but WhatsApp currently rejects pairing codes from third-party clients, so QR is the default. If the phone asks to create a passkey, create it and scan again. Credentials live in `auth_dir`, mode 700. `angelia unpair` logs that one linked device out and deletes them; the phone and its other linked devices are untouched. Link a second, established number, not your personal one. Angelia ignores what the linked account itself sends, so on your own number it would not hear you and would answer as you, and it would decrypt every chat on that account. WhatsApp bans newly created numbers that start acting like robots, usually within hours. Group ids look like `1203630000…@g.us`; people appear either by phone number or by a `@lid` id, and `allow_from` / `owners` accept the phone number whenever WhatsApp has told us the mapping.

```yaml
whatsapp: { auth_dir: ~/.angelia/wa }
```

### Chrome for a Claude Code profile

`chrome: true` on a Claude Code profile launches the agent with the Claude in Chrome tools, which act inside your everyday browser with the sessions it already holds. Angelia only passes the flag; what the agent may do there is its permission mode and its instructions.

### Shell without the agent

With `shell: true` on a profile, `/sh <command>` runs that command in the profile directory with your login shell and returns the output, exit code and all. No agent, no tokens, and it works even while a turn is running. Multi-line scripts work too. `shell_timeout_seconds` (default 60) kills anything that hangs. Enable it only on profiles whose chats you alone can write to.

### Keeping it running

On macOS, `angelia service install` makes the daemon a LaunchAgent: it starts at login and comes back after a crash. The plist carries the PATH the CLIs need, worked out when it is written, and no secret; the daemon reads `~/.angelia/env` itself. If a daemon started by hand is running, install writes the service (on Linux it also enables the unit, so it starts at boot) and `angelia restart` (or `/restart` from a chat) moves it onto the service. `angelia service status` and `angelia service uninstall` do what they say. Elsewhere the daemon is a foreground process: keep it under your own supervisor. `~/.angelia/daemon.pid` stops a second copy from starting.

On Linux the service is **experimental**. It was built from the systemd documentation and sources and is tested with fakes. On Ubuntu 26.04 with systemd 259 it was measured for the service itself, a reboot with linger, and `/restart`; `angelia update`, a `$` in the config path and the `.inbox` link are not measured yet. The checks in `docs/runbook.md` ("Linux server over Tailscale") are what removes the word, and `docs/linux-server.md` walks a server from empty to running. `angelia init` offers the service on macOS only, so on Linux run `angelia service install` yourself. It writes the systemd user unit `~/.config/systemd/user/angelia.service` (always there, whatever `$XDG_CONFIG_HOME` says), then runs `systemctl --user daemon-reload`, `enable` and `start`. It refuses, with a plain message, where `systemctl --user` does not answer. The unit restarts the daemon after a failure (`Restart=on-failure`, `RestartSec=10`), gives a stop 20 s (`TimeoutStopSec=20`, as launchd's) and carries only `PATH`, `HOME`, `LANG` and `ANGELIA_STATE_DIR`. A user unit starts at boot only with linger on: install tries `loginctl enable-linger`, and if that is refused it prints `sudo loginctl enable-linger $USER` for you to run. `systemctl --user status angelia` shows the unit; `journalctl` is not used, the daemon's output is appended to `~/.angelia/daemon.out`. `angelia service status` reads "loaded yes" when the unit is active.

On Linux, `/restart` from a chat runs the restarter as its own transient unit (`systemd-run --user`) and the tmux server in its own scope, so TUI panes survive a restart. Where `systemd-run` is missing, `/restart` from the service's daemon refuses and the daemon keeps running: a restarter inside the service would be killed by its own stop, and nothing would start the daemon again. Run `angelia restart` from your own shell then. A tmux server started without `systemd-run` (missing, or no user bus) is a plain tmux call, and its panes may not survive a restart. The symlink guard walks paths through `/proc/self/fd`, so it needs `/proc`. Tailscale is for your own `tailscale ssh` into the box; Angelia opens no inbound port.

The deny floor keeps credentials away from the agent's file tools on both systems, including `~/.claude/.credentials.json`, `~/.local/share/keyrings`, the browser profiles, `~/.config/systemd/user` and `~/Library/LaunchAgents`. It binds the file tools only. A sandboxed profile holds it for every command too: on macOS, and on Linux only with the extra bwrap step in `docs/linux-server.md` and not in `bypassPermissions` (experimental). Without the sandbox, a Bash `cat ~/.claude/.credentials.json` still reads the file.

**Upgrading to the release with Linux support:** the deny floor grows on macOS too (`~/Library/LaunchAgents`, `~/.config/systemd/user`, browser profiles, keyrings, `~/.claude/.credentials.json`). `angelia check-config` warns for every existing profile until you run `angelia compile <profile> --write`. An agent that reads plists with the Read tool needs `~/Library/LaunchAgents` in its `add_dirs`. When git has no identity (no `user.name` or `user.email`; a fresh Linux account), the commits Angelia makes in the workspace are by `Angelia <angelia@localhost>`. Before, macOS used the account's name. An identity you set always wins.

`angelia update` installs the newest release of the repository named in the installed package (for a fork, pass `--from` with your fork) and lists the commits it brings. A release is a `vX.Y.Z` tag signed with a release key (the owner's, or the release workflow's, which lives only in the repository's `release` environment on GitHub); the key is checked against the `allowed_signers` file of the copy you already have, never the one that came with the download, and a copy without that file refuses to update. `install.sh` carries the same key and checks the first install the same way. An update whose history does not contain the installed commit (a rewritten repository, or an older release) is refused unless you add `--force`. It builds in a temp folder with no dependency install scripts and installs with `npm i -g`, so your instance, profiles and state are not touched. It never restarts the daemon: send `/restart` or run `angelia restart` when it suits you. A Node without the Node2Shell fix (CVE-2026-111497) gets a warning, not a refusal: the one `update` runs on, and after the install the one the service's plist starts, with what to do about it. `--check` only lists what would change; `--from <git URL or folder>` updates from somewhere else; `--head` installs the branch tip instead of a release, unsigned, for development. A checkout, or a global install linked to one, is refused: update those with git.

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

### Claude app connectors

The connectors of your claude.ai account (claude.ai Gmail, Google Calendar, Google Drive, and the
others you connect there) are a capability kind of their own, `connector`. Each one is named by the
address it serves from. `*` matches any text:

```yaml
capabilities:
  gmail:    { kind: connector, url: "https://gmailmcp.googleapis.com/*" }
  calendar: { kind: connector, url: "https://calendarmcp.googleapis.com/*" }
  drive:    { kind: connector, url: "https://drivemcp.googleapis.com/*" }
```

Give one to a profile as you give any capability (`capabilities:`, `defaults.capabilities`, `deny:`).
One grant is one host. The url must start with `https://`, name its host in full (no `*` there, no IP
address) and have a path; `*` is allowed in the path only. `?`, `#`, quotes and spaces are refused.

- **Deny by default.** A Claude Code profile loads only the connectors it was given. A profile that
  denies an MCP server loads none today (`--strict-mcp-config`), and keeps that exact launch when it
  is given no connector. A profile that denies no MCP server used to load every connector of the
  account. After its next compile it loads none it was not given, and its user-level MCP servers
  still load. The compile says so in its change list.
- **How it loads.** A profile given a connector starts without `--strict-mcp-config`. It loads its
  own `.mcp.json` with `--mcp-config`, and an allow list (`allowedMcpServers`) in its settings: its
  own servers by name, and each connector by its url. A remote (http or sse) server is on the list
  by its address as well: measured with Claude Code 2.1.332, once a url is on the list, a remote
  server passes by its address only. The list keeps the scheme, host and path of that address, with
  a `*` where a query or fragment was, so a key in the address (`?apiKey=...`) is not copied
  anywhere. A user and password before the host (`user:key@`) become `*@`. A key in the path is
  copied as it is: keep keys out of the path. When MCP is not strict for the profile, its user-level servers (from `~/.claude.json`,
  or `CLAUDE_CONFIG_DIR`) of the compile are on the list too. Compile again after you add one. MCP
  servers from a plugin are not on the list. A server name with a character other than letters,
  digits, `-` and `_` cannot be on the list (Claude Code drops it): in the profile's own `.mcp.json`
  it stops the compile; a user-level one is left off, and the compile says so.
- **Claude Code only.** grok, agy, Codex and pi get nothing; the compile says so in one line.
- **Where they load.** In the profile's own chats. `angelia ask` loads none.
- **The login.** Connectors load only when Claude Code is signed in with a claude.ai account. With
  `CLAUDE_CODE_OAUTH_TOKEN` they do not load; the compile names it when the agent's environment or a
  capability sets it. An API key or a cloud provider never reaches an agent (Angelia removes those
  variables).
- **What the agent cannot change.** The last compile keeps the launch in the state folder, out of
  the agent's reach, and the daemon builds the list from that copy, not from the record in the
  profile's folder. Before each start the daemon also refuses the start when the record is missing,
  lacks its connectors list, or differs from the copy, and when a strict profile's `.mcp.json` is
  gone. A checkout or a backup that brings back an older record therefore refuses the start until
  you compile again. On a profile given a connector, the launch refuses a `.mcp.json` that names a
  server the last compile did not: Claude Code would hold the session on an approval dialog for it.
  Such a profile must not hold `allowedMcpServers` in its own `.claude/settings.json` or
  `settings.local.json`: Claude Code adds such a list to Angelia's. The compile and the launch
  refuse it, and the launch also refuses a `settings.local.json` that cannot be read. A profile
  compiled before this version has no such copy: `check-config` names it, and `angelia compile
  --write <profile>` adds it. Until then a record of it that names connectors is refused. The
  `/status` terminal line passes the list as a file in the state folder, so it names no address.
- **What it does not hold.** The list binds the agent's own Claude Code session. An agent with a
  shell outside a sandbox can run plain `claude`, which loads every connector of your account. Keep
  the shell asking, or set `sandbox: true`, on a profile that should not reach them.
- **The warning.** At each start of a profile given a connector, Claude Code prints "Warning:
  claude.ai MCP servers blocked by enterprise policy: ..." with the connectors left out ("MCP server
  blocked" when it is one). That is the allow list, or the deny list of `connectors: all`, at work.
  Angelia never posts it to the chat or reads it as a failure.
- **The first turn of a new session.** Claude Code gets the account's connector list when it starts,
  and does not wait for it before the first turn. In print mode the first message goes in at once,
  so that turn often has no connector tools. The next turn of the same session has them. Measured
  with Claude Code 2.1.332: turn 1 had no Gmail tools in 27 of 50 new sessions; turn 2 had them in
  21 of 26. When that request fails (two tries of 5 seconds each), the session has no connector
  until it ends; `/new` starts a new one. `CLAUDE_CODE_MCP_CONNECTOR_PREWAIT_MS` and
  `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` do not change this (the first one works only in a cloud
  session). In tmux mode Angelia pastes the first message only when the pane is ready, so the list
  has more time to arrive; this is not measured.

Each granted connector gets a line in the profile's CLAUDE.md, for example
`- gmail: Gmail through the Claude app connector (tools mcp__claude_ai_Gmail__*); needs a claude.ai login.`

#### Every connector of the account (`connectors: all`)

`connectors: all` gives a Claude Code profile every connector of your claude.ai account, and a
profile drops one by its capability name. Set it for the whole instance under `defaults`, or per
profile (the profile's own wins). `granted`, the default, is the deny-by-default mode above.

```yaml
capabilities:
  gmail: { kind: connector, url: "https://gmailmcp.googleapis.com/*" }
defaults:
  connectors: all
profiles:
  money-saver: { cwd: ..., deny: [gmail] }   # every connector but Gmail
```

- **Later connectors too.** The table needs no list of the account's connectors: Claude Code gets
  that list from claude.ai at each start. A connector you add in the Claude app reaches every profile
  in this mode at its next start, with no compile. `check-config` names each such profile.
- **Dropping one.** A connector capability the profile denies (its `deny:`, or `defaults.deny` it
  does not lift) or lists under `except:` is dropped, unless its own `capabilities:` gives it back.
  Only a connector that is a capability in the table can be dropped: add one for it first.
- **How it loads.** No allow list. The launch passes `deniedMcpServers` in `--settings`, with each
  dropped connector by its url. The settings go by a file in the state folder, never on the command
  line, and the record in the profile's folder holds each dropped url as a hash only, made with a
  key in the state folder: the agent does not learn the address of what it is kept from, and cannot
  test a guess against the record. Measured with Claude Code 2.1.332: with that list and no allow list,
  every connector of the account loads but the dropped ones, and the profile's own `.mcp.json`
  servers (through `--mcp-config`) and user-level servers still load. A deny by a connector's name
  ("claude.ai Gmail") does nothing, so the url is used.
- **A wrong address fails open.** The url is the only thing that keeps a dropped connector out. A
  typo, or a connector whose address the Claude app changed, matches nothing, and that connector
  loads; granted mode fails closed instead. So the compile and `check-config` give a note for each
  dropped connector, naming its capability (the url is in your routing table). And 30 seconds after each print-mode start, the daemon
  counts the connectors Claude Code's stderr warning named as blocked (it does not wait for the
  account's connector list before the first turn): when they are fewer than the ones dropped, the log
  gets a warning, and you hear it once in a direct chat of yours with the profile (until the daemon restarts; with
  no such chat, only the log has it). The
  signal can be wrong: a dropped connector your account does not have (never connected, or
  disconnected) is no line either, nor is any connector when the list did not load; and one url that
  matches two connectors gives two names. A tmux pane has no stderr, and its screen shows no such
  warning (measured with Claude Code 2.1.332). So after a tmux-mode start the daemon runs
  `claude mcp list` twice in the profile's folder, with the profile's deny list and without it (no
  model call, about 12 seconds; it health-checks each MCP server, as a start does): the connectors
  only the second run lists are the blocked ones, and the same warning follows. This runs once per
  profile and deny list while the daemon runs; a run that failed or fell short runs again at the next
  pane start. You hear it once per profile and set of blocked connectors, after the notice was sent.
- **What the agent cannot change.** The daemon builds the deny list from the copy in the state
  folder, as for granted connectors, and refuses the start when the record in the profile's folder
  differs from it. Measured with Claude Code 2.1.332: deny lists of all settings files are merged,
  and a deny wins over every allow list. So a `deniedMcpServers: []` or an `allowedMcpServers` in the
  profile's own `.claude/` settings takes nothing back. An `allowedMcpServers` there only narrows what
  loads, so the compile names it and the launch does not refuse it.
- **A strict profile.** `--strict-mcp-config` drops every connector, so a profile that denies an MCP
  server does not use it in this mode. Its user-level servers (from `~/.claude.json`, or
  `CLAUDE_CONFIG_DIR`, and that file's servers for this folder) are on the deny list by name, as the
  compile found them. Measured with Claude Code 2.1.332: `claude mcp add --scope local` in a folder
  inside a git repo writes under the repo root's real path (the main checkout's, from a worktree),
  not under the folder. So Angelia reads the folder, its real path and its git roots. A user-level
  server added after the compile stops the start until you compile again, since nothing else keeps it
  out. The agent reads the config file of the daemon's `CLAUDE_CONFIG_DIR` (or `~/.claude.json`):
  when that is not the file the compile read (kept in the state folder), the start is refused, so
  compile in the daemon's environment. Measured with Claude Code 2.1.332: `claude mcp list` in a
  folder also lists the servers of a `.mcp.json` in each folder above it ("Pending approval"). So
  their servers go on the deny list by name too, and a server added there after the compile, or such
  a file that cannot be read, stops the start. A server name with a character other than letters, digits,
  `-` and `_` cannot be on the list, so it stops the compile. MCP servers from a plugin are not kept
  out.
- **The rest is as for granted connectors.** Claude Code only (other CLIs get nothing); `angelia ask` loads none; connectors need a claude.ai login; the list binds the
  agent's own session only. The profile's CLAUDE.md gets one line: every connector of the account
  loads, but the dropped ones.

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
| `~/.angelia/canary.json`, `~/.angelia/tui/canary/<time>/` | `angelia canary`: the Claude Code build that last passed and the last run; the screens of a run that failed |
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
