# ADR 0001 — Process model: long-lived print-mode process per session (A2)

Status: accepted 2026-09-13; amended 2026-09-19 by ADR 0008, which brings A3 back as an opt-in host mode per profile (`tui: true`) because the Claude-app mirror became a requirement. Print mode remains the default. Evidence: `docs/spikes/README.md`. Scope: the Claude Code backend, v1's only one. The `Brain` interface (start, turn → progress | permission | result, stop) is backend-neutral so Codex/OpenCode can be added per profile without touching routing, sessions or delivery.

Chosen: one `claude -p --input-format stream-json --output-format stream-json --verbose
--permission-prompt-tool stdio` process per active session key, cwd = profile directory.
Turns ~1.2–2 s after the first; cache survives idle gaps (10.5 min measured); permission prompts
arrive as `control_request` JSON and are relayed to the chat.

Rejected:
- A1 spawn per message: works (99 % cache) but +3.5 s per turn and no permission path. Kept as rollback.
- A3 tmux TUI: pane scraping is version-coupled, Stop-hook flush race, CLAUDE.md-import dialog,
  tmux as a dependency. Its only unique value (Claude-app mirror) is not a v1 requirement.
- A4 Channels: one cwd per process, WhatsApp needs the development flag, one bot token / one WA
  device cannot be shared by N processes.
- A5 Agent SDK: same wire protocol as A2 plus a dependency and a second package to pin.
