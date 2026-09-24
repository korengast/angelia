# Investigation notes — policy router for Claude Code (2026-09-13)

> Historical: the measurements that started the project. Several conclusions changed since (a tmux
> host mode exists, voice notes are transcribed by the agent, pairing defaults to QR); the README and
> `docs/decisions/` are current.

Machine: macOS, Claude Code **2.1.270**, Node 26.4.0, a subscription (OAuth) seat.
Spike logs: `docs/spikes/`.

## Positioning

Angelia is a policy router between chat platforms and a **local coding agent**. Claude Code is the v1 backend because its streaming JSON protocol gives warm caches and structured permission prompts; the router itself is agent-agnostic (routing, sessions, gating, delivery) and Codex/OpenCode are the planned second backends. Two user outcomes: continue working with your familiar agent from WhatsApp/Telegram, and run that agent as a 24/7 personal assistant with one profile directory per topic.

## Why we still build (one paragraph)

Official Channels (research preview) inject messages into **one running session in one cwd**; the
`--channels` allowlist is Anthropic-curated (Telegram, Discord, iMessage, fakechat) and every
WhatsApp channel that exists today (crisandrews/claude-whatsapp 13★ MIT, rich627/whatsapp-claude-plugin
Apache-2.0) must be started with `--dangerously-load-development-channels`, one WhatsApp **number per
session/folder**, and cannot route one number's groups to different cwds or different Claude
sessions. Running N Channel processes does not fix it either: one Telegram bot token cannot be
long-polled by N processes (409 conflict) and one WhatsApp linked device cannot be opened by N
Baileys sockets (440 conflict). So "one number/bot, one group = one profile directory = one Claude
session" is not buildable on Channels without a router in front. That router is the product. It
owns adapters, route table, session map and delivery, and nothing else.

## A. Process model — measured (haiku, tiny CLAUDE.md, this machine)

| Mode | turn 1 | turn 2 | turn 3 | cache_read / total (t3) | permission path |
|---|---|---|---|---|---|
| A1 `claude -p --resume` spawn per msg | 5.6 s | 5.4 s | 5.0 s | 25 863 / 25 967 (99.6 %) | none in print (`--permission-prompts none` = auto-deny) |
| A2 long-lived `-p --input-format stream-json` | 4.9 s | 1.9 s | 1.2 s | 25 749 / 26 025 (98.9 %) | **`control_request` / `can_use_tool` on stdout, answered on stdin** (spike verified: Bash prompt relayed and allowed) |
| A2 after **10.5-min idle gap** | | | 2.0 s | 25 815 / 25 924 | same |
| A3 tmux TUI (an interactive session in a pane) | | | | 84 187 read / 3 794 create per call | phone via Remote Control |
| A4 Channels | n/a: one cwd per process, WA not on allowlist | | | | relay via channel |
| A5 Agent SDK | same protocol as A2 with a dependency | | | | SDK host |

Facts that overturn part of §3 of the brief:

- **Cache across spawns is fine.** `--resume` per message hit 99 % cache. The real cost of A1 is
  ~3.5 s process start per turn, not the cache.
- **`--append-system-prompt` with a per-turn envelope did NOT bust the cache on 2.1.270**
  (cache_create 103 / 92 tokens on turns 2–3, same as envelope-in-user-text). Keep the envelope in
  user text anyway: it lands in the transcript and needs no flag.
- **A2 exposes permission prompts as JSON.** With `--permission-prompt-tool stdio` the CLI writes
  `{"type":"control_request","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{…},
  "permission_suggestions":[…]}}` and waits for `{"type":"control_response",…,"behavior":"allow"}`.
  The router can relay that to the chat as "yes/no <id>" with no TUI scraping and no Remote Control.
- Hebrew multi-line in a JSON user message: no issue (t2 of spike A2).
- `system/init` event carries `apiKeySource` (`"none"` = OAuth seat) and `claude_code_version`:
  free billing check and version pin at process start.

(2026-09-19: A3 is back as an opt-in host mode per profile, `tui: true` — see
`decisions/0008-tui-host-mode.md`. The line below still describes print mode exactly.)

What A2 loses versus A3: the session is not mirrored in the Claude app (no Remote Control in
print mode), no `AskUserQuestion`/plan-mode dialogs (they are disabled under `-p`), and
`--chrome`/MCP servers restart when the process is reaped. What A2 removes: tmux, `capture-pane`
prompt-marker parsing, the Stop-hook flush race, the first-start CLAUDE.md-import dialog (print
mode does not show it; the key still gets pre-set as belt and braces), the "waiting for approval"
45-s heuristic.

**Decision: A2.** A1 is the rollback (same argv minus `--input-format`, one spawn per turn,
`--permission-prompts none` so nothing hangs). Stopping an A2 child: close stdin first (graceful),
SIGTERM after 5 s (exit 143, turn lost). `--add-dir` grants file access only; it never loads that
directory's CLAUDE.md, so a profile is exactly its cwd.
A3 stays a documented option for a profile that needs the Claude-app mirror, not v1.

## B. WhatsApp

- Library: **Baileys** `@whiskeysockets/baileys` 7.0.0-rc14 (MIT, npm). Both existing Claude
  WhatsApp channels and an earlier local bridge use it. whatsapp-web.js needs a Chromium; whatsmeow
  is Go (second runtime); Evolution API is a server product (Docker, multi-tenant) on top of
  Baileys; WhatsApp Cloud API is a business number, not "my number and my groups".
- Pairing: **pairing code** (`sock.requestPairingCode(phone)`), QR fallback in the terminal.
  rich627 notes `requestPairingCode` can hang; wrap in a 20-s timeout. Print only to the daemon's
  stdout, never to a chat, never to a log file.
- Identity: Baileys 7 hands out `@lid` participant ids alongside `@s.whatsapp.net`; the same person
  arrives as either. Use `key.participantAlt` (groups) / `key.remoteJidAlt` (DMs) and
  `sock.signalRepository.lidMapping.getPNForLID/getLIDForPN` (baileys.wiki/concepts/jids); fall back
  to the `lid-mapping-*.json` files in the auth dir (an earlier bridge's allowlist). Allowlist entries
  are phone numbers; matching expands each to its lid when known.
- Mention: `contextInfo.mentionedJid` contains our own jid (phone or lid form) when @mentioned; a
  reply-to one of our messages (`contextInfo.participant` == us) also counts. Both plugins do this.
- Disconnects: `loggedOut` (401) → stop, tell the owner to re-pair; `515` → reconnect at once;
  `428`/others → backoff 1 s·n up to 30 s; **440** = another socket holds the same creds → backoff,
  announce once per 6 h, pidfile lock so two daemons cannot start.
- Ban policy (community reports 2025-2026, no Meta numbers): bans are permanent; triggers are
  cold outreach, bursts, odd hours, new IPs. Rate guidance in use is 10-12 msgs/min with 1-5 s
  randomised delays (Baileys discussion 2357, baileys-antiban). **Fresh numbers get banned within
  hours** (Baileys issue 935); aged numbers with a real contact graph are the safer choice, so the
  spike ran on an established number, not a throwaway. Policy: reply only in a chat where an allowed
  inbound just arrived, mention-required in groups, ceiling **10 msgs/min**, 1.5-4 s randomised gap
  between chunks, presence `composing` first, no proactive sends in v1, upstream Baileys only
  (an "anti-ban" fork exfiltrated creds in April 2026).
- Media: inbound image/doc/voice → `downloadMediaMessage` into `<cwd>/.inbox/<id>.<ext>`, path in
  the envelope. Voice: file only, no STT. Outbound files: v1.1 (needs a reply protocol; see F).

## C. Telegram

grammY 1.46 (MIT), long polling (home daemon, no public URL), `getUpdates` allows one consumer per
token. Plain text (no parse_mode) split at 4 000 chars on paragraph boundaries, code fences closed
and reopened across chunks. Session key includes `message_thread_id` for forum topics. Groups:
under BotFather privacy mode plain @mentions are **not reliably delivered** (openclaw issue
28085, a public bot-framework issue); only `/cmd@bot`, replies to the bot and service messages are. So
the runbook makes the bot a **group admin** (admins receive everything) or disables privacy mode
and re-adds the bot; angelia then applies `mention: required` itself. Telegram's own limit is
20 msgs/min per group. Allowlist by
numeric user id, gate on `from.id` not `chat.id` (official plugin's rule). `getFile` limit 20 MB.

## D. Routing / profiles

`routing.yaml` at repo root is the whole mental model (see file). Match keys: `platform`, `chat`,
optional `thread`. Profile fields: `cwd`, `permission_mode`, `model`, `effort`, `add_dirs`. Route
fields: `profile`, `mention` (`required` | `any`, default `required` for groups, ignored for DMs),
`allow_from` (senders; empty = anyone in that chat). Unmatched → `drop` (default) or `reply` with
one fixed line. Two chats may share one profile: same cwd, separate session ids. `/profile` is v2.

## E. Session mux

`~/.angelia/sessions.json`: `{ "<platform>:<chat>[:<thread>]": { active, history:[…] } }`. One
daemon process owns all sessions; a per-key async queue serialises turns; a pidfile prevents a
second daemon (flock across processes is therefore unnecessary — the pidfile is the flock). First
turn `--session-id`, later `--resume`, never both. Lost transcript → one retry with a fresh id, then
one line to the chat. Idle process reaped after `idle_exit_minutes`; next message respawns with
`--resume` (cache still hits, see A1).

## F. Delivery

Progress: an `assistant` text block is forwarded only after a later event (tool_use) arrives; the
`result` event is the answer, sent once, skipped if identical to the last progress line. Empty
result → silent. Non-zero exit / crash / timeout → one fixed line, no paths. `/stop` → SIGINT the
child, then kill after 5 s; the session id survives. Permission relay: "🔐 <tool> <preview>
reply `yes abcde` / `no abcde`"; unanswered for 10 min → deny.

## G. Security

Strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_*` from
the child env; assert `apiKeySource == "none"` on the init event or refuse to serve the profile.
`bypassPermissions` is per profile, never default; the loader refuses it when the cwd contains
`.env` or `secrets/` unless `unsafe_ok: true` is set on the profile. Pairing codes and QR go to the
daemon's stdout only. Logs contain ids and counts, never text.

## H. Ops

launchd `~/Library/LaunchAgents/com.angelia.daemon.plist` (`KeepAlive`, `RunAtLoad`), systemd user
unit equivalent. Daemon restart kills its child `claude` processes (they are children; no tmux);
sessions come back with `--resume` at ~5 s cost. `angelia status` prints WA connection state, TG
polling state, live sessions, queue depths. Pin: `claude >= 2.1.270`, checked from
`claude_code_version` in the init event.

## I. Prior art (cloned and read, 2026-09-13)

| Repo | Stars / license / last push | Model | Steal | Missing for us |
|---|---|---|---|---|
| Escoto/RustifyMyClaw | 8 / Apache-2.0 / 2026-04-16 | Rust, `claude -p` (+`-c` continue) per message, `workspaces[]` YAML with per-workspace channels | `workspaces: [{name, directory, backend, channels:[{kind, token, allowed_users}]}]` shape; `output.max_message_chars`; `limits` | no WA groups, `-c` is cwd-based not keyed, no mention, no session map |
| maxz712/miniclaw | 1 / Apache-2.0 / 2026-04-05 | Python, `claude --session-id X -p` per message, `agents.*.session_per: channel` | `session_per` idea, `command_prefix` | WA is Cloud API only, one workspace, `--system-prompt` per agent (persona in router = anti-pattern) |
| kirilly/telegram-bridge | 1 / MIT / 2026-06-14 | TS, Channels MCP server, also parks Claude in tmux and reads the pane | tmux-pane "is Claude idle" check is the same trap we are leaving | TG only, one session |
| crisandrews/claude-whatsapp | 13 / MIT / 2026-08-21 | TS, Baileys, Channels plugin (dev flag), 52 tools, SQLite FTS, permission relay by `yes <id>` or 👍 | `access.json` (`dmPolicy`, `groups.{requireMention, allowFrom}`, `mentionPatterns`), inbound debouncing, single-instance pidfile, 440 handling, `.inbox/` media | one number per folder/session; no profile-per-group |
| rich627/whatsapp-claude-plugin | 89 / Apache-2.0 / 2026-09-02, 17.8 k LOC | TS, Baileys 7.0.0-rc9 (+patch), Channels plugin (dev flag), per-group `config.md` personality | pairing-code flow with timeout, LID↔phone resolution, `requireMention` wizard default | per-group "personality" is a prompt in one session, not a cwd; needs dev flag |
| anthropics/claude-plugins-official telegram | official | Bun MCP channel, `~/.claude/channels/telegram/access.json` | the access.json schema verbatim (see D), gate on sender id, `replyToMode`, `textChunkLimit`, `chunkMode` | one session |
| An earlier local bridge | — | WA → skip agent → tmux TUI per group + Stop hook | session map with history and labels, `/new /resume /status /model /effort`, billing env strip, typing keepalive, envelope shape, failure table | tied to one setup |
