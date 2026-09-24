# ADR 0008 — Host mode per profile: print mode by default, a tmux TUI when the chat must live in the Claude app

Status: accepted 2026-09-19. Amends ADR 0001, which rejected A3 (tmux TUI) on the grounds that
"its only unique value (Claude-app mirror) is not a v1 requirement". It is a requirement now:
every routed chat should be visible and continuable from the Claude app, the way the gateway
Angelia replaces did it.

## The measurement that forced the choice

`--remote-control` only registers an interactive session. Measured on claude 2.1.278: under `-p`
the flag is accepted and then ignored — the session record in `~/.claude/sessions/<pid>.json`
shows `entrypoint: sdk-cli`, a derived name rather than the one passed, and no bridge id, while a
session started as a terminal `cli` in the same directory has a bridge id and appears in the app.
No flag, setting or environment variable changes that. A print-mode session cannot reach the app.

## Decision

Keep both, chosen per profile with `tui: true` (Claude Code only; print mode stays the default).

- **Print mode (ADR 0001).** `claude -p` over stream-json. Permission prompts arrive as JSON and
  are relayed to the chat; nothing is read off a screen.
- **TUI mode.** The same CLI as a real interactive session in a tmux pane on Angelia's own socket
  (`tmux -L angelia`). Angelia types the turn into the pane; a Stop hook writes the turn's answer
  to a file; the daemon polls that file and delivers it. Progress lines come from the session
  transcript, not from the screen.

## What TUI mode buys

Remote Control, so the chat is in the Claude app and can be continued from the phone. Sessions on
a separate tmux server outlive the daemon: a restart (or a crash before the launchd unit exists)
reattaches instead of resuming, so nothing is lost and the app entry never blinks. MCP servers stay
warm between turns, background tasks outlive a turn, and slash commands behave as in a terminal.

## What it costs, and what is done about each

- **The pane is a screen, not a protocol.** Markers are version-coupled. Mitigation: every pane
  rule is a pure function tested against real captured frames (`tests/fixtures/pane-*.txt`), so a
  CLI redraw breaks a test rather than a group.
- **Pasting into the wrong thing.** Mitigation: paste only at an idle prompt (no spinner, no
  dialog), then confirm the text is in the box before pressing Enter, and clear the box rather than
  submit blind.
- **Permission prompts are read from the box.** The dialog is parsed from the rule above it, not
  from the transcript, and a chat "yes" presses `1` while "no" presses Esc — verified live: a
  command outside the working directory was refused from the chat and never ran. This is the
  weakest seam in TUI mode; print mode's channel remains the stronger one, which is why it stays
  the default.
- **No Stop event for a CLI-handled message.** `/compact` ends without one. Mitigation: an idle
  pane with nothing new in the transcript for 12 s ends the turn with whatever text the transcript
  holds (empty for `/compact`, which the router confirms itself).
- **The trust dialog.** A directory Claude Code has not seen opens "Is this a project you trust?"
  with "No, exit" preselected; print mode never shows it. Angelia moves the cursor, checks it is on
  the yes row, and presses Enter — routing.yaml already declared that directory and its permission
  mode, so this is not a new decision being made on the user's behalf.
- **tmux becomes a dependency** for profiles that opt in. Print mode still needs nothing.

## Open

Turns typed by the user in the Claude app are not delivered to the chat (the gateway did deliver
them). Nothing forwards them today, and a private message typed in the app should probably not
land in a group by surprise; decide deliberately rather than inherit it.
