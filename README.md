# Angelia

**Your coding agent. Your personal assistant.**

Angelia turns the coding agent CLI you already know and trust into the brain of your personal assistant. You reach it from WhatsApp or Telegram. It runs on your own machine, with your files, your tools and the subscription you already pay for.

> **You:** What did the plumber quote? Put it in the house budget.<br>
> **Agent:** $1,850 for the boiler, from the PDF you sent on the 12th. Adding it now.<br>
> **Agent:** 🔐 Bash: `python3 scripts/budget.py add "Boiler" 1850`. Reply `yes 6b480a6f` or `no 6b480a6f`<br>
> **You:** yes 6b480a6f<br>
> **Agent:** Added. House costs this month: $4,210 of $5,000.

Nothing in that chat was Angelia's own intelligence. The agent read the PDF, knew the budget script and asked before running it. Angelia carried the messages.

> In Greek myth Hermes carried the words of the gods. His daughter **Angelia** (Ἀγγελία, *message, tidings*) inherited only the message itself: not the wisdom in it, not the decision behind it, just the promise that what was said in one place would arrive whole in another. That is the entire ambition of this project.

**Status: alpha.** Telegram and WhatsApp both run end to end, groups included, every day. macOS only for now. Two CLIs are supported today and three more are coming: see [Backends](#backends).

Website: [useangelia.com](https://useangelia.com)

## Why

**A personal assistant made of the agent you already trust.** Give each part of your life its own chat and its own folder: the house, money, the kids' school, a side project. Each one gets its own instructions and its own memory, and they all run on one subscription. Your CLI already reads files, runs programs, browses and follows instructions. Angelia gives it a phone number, a schedule and a place for each topic.

**Keep working away from the desk.** Ask why the build failed from the train. Approve the fix from the couch. The agent works on your machine, with the project files, MCP servers and permission rules you set up. Nothing moves to the cloud.

## How it works

Four words, and one file that ties them together.

- **Profile.** A folder where your agent works: its instruction file, its memory, its settings. The agent opens in that folder exactly as it would in your terminal.
- **Route.** One line that sends one chat to one profile.
- **Session.** Every chat keeps its own conversation with the agent, across restarts. `/new` starts a fresh one.
- **Owner.** The people who may approve what the agent wants to run and use the chat's commands. In a direct chat, that is you.

```yaml
profiles:
  coding: { cwd: ~/.angelia/workspace/profiles/coding, permission_mode: acceptEdits, add_dirs: [~/code] }
  house:  { cwd: ~/.angelia/workspace/profiles/house,  permission_mode: acceptEdits }

routes:
  - { platform: telegram, chat: 111111111,      profile: coding }
  - { platform: telegram, chat: -1001234567890, profile: house, owners: [111111111], allow_from: [111111111, 333333333] }

telegram: { token_env: TELEGRAM_BOT_TOKEN }
```

The setup wizard writes this file for you. With onboarding on, a new chat adds its own profile and route the first time you mention the bot there.

## Quick start

You need:

1. **A Mac with Node 22 or newer** (`node --version`) and **git** (it comes with the Xcode command line tools).
2. **A supported coding agent CLI**, installed and signed in to your own account. Versions are in [Backends](#backends).
3. **A Telegram bot.** Open [@BotFather](https://t.me/BotFather), send `/newbot` and keep the token ready. The wizard asks for it and stores it on your disk, never in a chat.

Then:

```bash
curl -fsSL https://raw.githubusercontent.com/korengast/angelia/v0.1.0/install.sh | sh
angelia service install   # start now, at every login, and again after a crash
```

The installer checks Node, installs the newest release after checking its signature, and runs `angelia init`. Releases are signed with one SSH key, fingerprint `SHA256:74hZgwt/ABiUQz6C9A1r7hpHZtCRq1KfC1KvvCR1ys0`; the script carries it, and `angelia update` checks every later release against it. The wizard asks for the bot token and which CLI to use, makes your first profile, and pairs the chat when you send the bot a message.

Send *"what is in this folder?"* to your bot. The agent answers from the profile's folder. `/help` lists the chat commands. `angelia status` shows what is running.

Optional:

- **Voice notes:** `brew install openai-whisper ffmpeg`. The agent transcribes a voice note itself on your machine, and can answer with one.
- **The CLI's full screen** (`tui: true` on a Claude Code profile, so the chat also shows up in the Claude app): `brew install tmux`, 3.7 or newer.

## WhatsApp

Add `whatsapp: { auth_dir: ~/.angelia/wa }` to the table and run `angelia pair`. It opens a local page with a QR code. On the phone that owns the number, choose *Linked devices > Link a device* and scan it.

**Use a second, established number, not your personal one.** Angelia ignores what its own account sends, so on your personal number it would not hear you, and it would answer as you. Its link can also read every chat on that account. And WhatsApp bans newly created numbers that start acting like robots, often within hours. An old spare SIM, or a number you have had for a while, is right.

## What it does

- **One chat, one folder, one session.** Instruction files, settings, MCP servers and hooks in the folder work unchanged.
- **Quiet in groups.** It answers only when mentioned or replied to, and only the people you allow. A chat that is not in the table gets no reply at all.
- **You approve risky steps.** Before a command the profile does not allow on its own, the chat shows it and waits for an owner's `yes`. No answer in ten minutes means no.
- **Voice notes, photos and files,** both ways. Speech is turned into text and back on your machine.
- **New chat, new assistant.** Mention the bot in a new group and it sets up its own folder, then asks what the group is for.
- **Scheduled check-ins.** A morning summary, a weekly report. Your operating system runs the timer; the answer lands in the chat.
- **Scriptable.** `angelia send` posts to a chat from any script. `angelia turn` asks that chat's agent.
- **Assistants that ask each other.** One profile can put a question to another, labelled as coming from that profile, never from you.
- **Per-profile tools.** Give a skill, an MCP server or a folder to the profiles that should have it. `angelia compile` writes it into each CLI's own settings, with the deny rules.
- **No surprise bills.** API keys are kept out of the agent's environment, so no chat can move you from your subscription to per-token billing.

Every feature in full, setting up by hand, the instance folder and the files Angelia keeps: [docs/reference.md](docs/reference.md). Day-to-day commands and known failures: [docs/runbook.md](docs/runbook.md). `angelia guide` prints the manual your agent reads before it changes the setup.

## Security in one minute

An assistant that can read your files can be talked into reading them aloud. Read [docs/security.md](docs/security.md) before you give the bot to anyone but yourself. The short version:

- Only chats in the table reach the agent. In a group, only the owners are heard unless you name others.
- Only owners approve commands, change the session or restart. A group member's typed "yes" is refused.
- What the agent may do is its CLI's own permission mode. For a profile other people talk to, keep a cautious mode, or set `sandbox: true`.
- Every profile is compiled with deny rules for the bot token, the WhatsApp login, your SSH and cloud credentials, and every other profile's folder. A profile whose rules were loosened is not started.
- Prompt injection is not solved: a web page or a forwarded message can still talk the agent into anything its permission mode allows.

## Backends

| CLI | `backend:` | Status | Needs |
|---|---|---|---|
| Claude Code | `claude-code` (default) | supported | 2.1.270 or newer, signed in to claude.ai |
| Grok Build | `grok` | supported | 1.0.13 or newer, `grok login` |
| Codex, pi, OpenCode | | coming soon | |

Each chat keeps one warm process: one to two seconds a turn on Claude Code, three to six on Grok Build. Permission prompts reach the chat on both. Every CLI plugs into the same small interface in `src/brain/`, and nothing else in Angelia knows which one is running. Details: [docs/reference.md](docs/reference.md#backends-in-detail).

## FAQ

**What does it cost?** Angelia is free and MIT-licensed. You pay only for your CLI's own subscription. Telegram bots and linked WhatsApp devices are free.

**Does anything go through an Angelia server?** No. There is no Angelia server, no account, no telemetry and no update check. Each turn goes to your CLI's model provider under that CLI's terms. Telegram keeps bot messages on its servers; WhatsApp messages are end-to-end encrypted to the linked device.

**Does my computer have to stay on?** Yes. The agent runs on it. A Mac mini or an always-on laptop is the usual home.

**Linux? Windows?** Not yet. The daemon is plain Node, but the service, the timers and the built-in voice use macOS today. Linux with a systemd unit is next.

**Can other people in a group use it?** Yes, if you list them in `allow_from`. They can talk to the agent; they cannot approve its commands. Give such a profile a cautious permission mode.

**How do I update?** `angelia update` installs the newest signed release and never touches your profiles. Then send `/restart` in a chat, or run `angelia restart`.

**How do I remove it completely?**

```bash
angelia unpair                     # first, if you linked WhatsApp: logs that device out
angelia service uninstall          # stops the daemon
angelia jobs remove <profile>      # once for each profile that has scheduled jobs
tmux -L angelia kill-server        # only if you used tui: true
npm rm -g angelia-gateway
rm -rf ~/.angelia                  # your profiles too: back up ~/.angelia/workspace first if you want them
```

Your CLI keeps its own conversation history in its own folders, and your Telegram bot stays with BotFather until you delete it there.

## Non-goals

Angelia is not an agent and will not become one. No second model, no skills system, no memory framework, no scheduler in the daemon, no plugin marketplace. Knowledge belongs in the profile's instruction file. Scheduled work belongs to the operating system, which `angelia jobs` only sets up. No payments: the agent sends you a checkout link and you pay on your phone.

## Roadmap

Codex, pi and OpenCode backends. Linux with a systemd unit. `/profile` to switch which assistant answers a chat.

## License

MIT
