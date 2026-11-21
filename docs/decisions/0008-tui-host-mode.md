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
- **Permission prompts.** At first the dialog was parsed from the rule above it and a chat "yes"
  pressed `1`. A review found both weak: a command can draw a rule of its own, so the chat saw a
  harmless tail of it, and a key answers whichever dialog is open when it lands. Since 0.3.1 a
  PermissionRequest hook carries each request to the chat as the tool and its exact input, as print
  mode relays it, waits, and hands the owner's answer back to Claude as its decision, keyed to that
  request; no key is pressed. It relays only while a turn from the chat is being read, and steps
  aside otherwise, so the Claude app and the pane ask as they always did. A dialog the hook did not
  relay (one left open while nobody read the chat) is announced, and never answered from the chat.
- **No Stop event for a CLI-handled message.** `/compact` ends without one. Mitigation: an idle
  pane with nothing new in the transcript for 12 s ends the turn with whatever text the transcript
  holds (empty for `/compact`, which the router confirms itself). Since 2026-11-20 the wait depends
  on the turn's transcript rows: 12 s when they show no turn or a command the CLI ran itself, 90 s
  when the last row is the assistant's text, and 3 minutes with no new row and nothing moving above
  the input box when they show the turn open (a tool runs, or the model owes an answer).
- **The trust dialog.** A directory Claude Code has not seen opens "Is this a project you trust?"
  with "No, exit" preselected; print mode never shows it. Angelia moves the cursor, checks it is on
  the yes row, and presses Enter — routing.yaml already declared that directory and its permission
  mode, so this is not a new decision being made on the user's behalf.
- **tmux becomes a dependency** for profiles that opt in. Print mode still needs nothing.

- **Answers nobody is waiting for.** Text reached the chat only while Angelia read a turn it had
  typed. A turn it closed without the Stop marker could answer later, and a background task's end
  wakes the agent with nobody reading: both answers stayed in the Claude app (2026-11-20).
  Mitigation: the Stop hook writes into its marker what started the turn, read from the transcript
  (`scripts/turn-origin.mjs`; the row's `origin.kind` and its tag, and the `system` rows of a
  scheduled prompt and of a turn's end, measured on Claude Code 2.1.329; a prompt typed while a
  turn runs, a `queued_command` attachment row, read from the 2.1.330 program text), the tool-use
  ids of a task's end, and a key (a hash) of the typed prompt. The daemon reads the marker between
  turns while the daemon holds the session. A late answer of its own turn is sent when the turn's one
  typed prompt has the key of what Angelia typed; the answer to a task's end only when each task
  it names was started in a turn Angelia typed, at most 6 an hour per chat. A turn a person typed
  or typed into, a prompt the session scheduled, a teammate's message, or a turn the hook cannot
  place, is not.

## Open

Turns typed by the user in the Claude app are not delivered to the chat (the gateway did deliver
them). Nothing forwards them today, and a private message typed in the app should probably not
land in a group by surprise; decide deliberately rather than inherit it.

A session is read between turns only while the daemon holds it (`idle_exit_minutes` after the chat's
last turn or the last turn woken by the end of the chat's own work). After a daemon restart, or once the pane is
parked, what the agent says by itself stays in the session until the chat's next message, and is
not sent then. A teammate's or another agent's message is `unknown` until its row is measured. A
prompt the session scheduled names no task: the row that fires it was not seen to carry an id that
ties it to the turn that scheduled it, so its answer stays in the app. The text the agent writes in
a turn the CLI started while one of Angelia's waited to be taken is read as that turn's progress;
only its last text is held back.
