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
- **Panes that never end.** The idle reap (`idle_exit_minutes`) only parks a pane, and the orphan
  sweep spares every parked pane and every chat's active session, so panes piled up: 19 of them on
  9 Claude Code builds, some idle three weeks, whose MCP servers filled swap (2026-10-24). Mitigation:
  a parked or active pane that no brain holds is ended once its tmux window saw no input or output
  for `pane_idle_hours` (default 12; tmux's `window_activity`, since `session_activity` stays at the
  time the session was made, measured on tmux 3.7c), or at once when it runs an older Claude Code than the one
  installed (the build read from its process, `…/claude/versions/<x.y.z>`; not read, only the hours
  count). Only a pane idle on screen goes, never mid-turn, with a dialog open or with a background
  task or teammate listed or open (after a restart, when no brain tracked the pane, the open tasks
  are read from the session's transcript, and a transcript that cannot be read keeps the pane), and the next message starts it again with `--resume`, so the conversation stays.
  The daemon log names each one and why.
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
  it names was started in a turn Angelia typed, at most 6 an hour per chat (`self_per_hour`; the rest are held and sent later as one
  message); the same for a named
  teammate's message (2.1.332: a user row with no origin, `rowSource: recorded`, the line "Another
  Claude session sent a message:", then `<teammate-message teammate_id="<name>">`) when that teammate
  was spawned in such a turn, or in a turn such a message started; 30 an hour, counted apart, a
  teammate's idle note among them. A turn a person typed or typed into, a prompt the
  session scheduled, a teammate the owner spawned, or a turn the hook cannot place, is not.

- **A message that comes while a turn runs.** It waited in Angelia's queue until the turn ended,
  and ran as a turn of its own; in a terminal, Claude Code queues what is typed meanwhile and gives
  it to the model inside the same turn (2026-11-25). Measured on 2.1.332: a message submitted while a
  tool call runs is written as `queue-operation` `enqueue`, then at the next tool boundary as a
  `queued_command` attachment row (the prompt, `origin.kind: human`), and the model reads it with the
  tool's result; one Stop. Submitted during the last model step, it runs as the next turn by itself
  (a second Stop, its prompt a plain user row; several such are joined into one prompt). Several are
  taken in order. The permission dialog is drawn while the PermissionRequest hook still runs, so an
  Enter at that moment answers it with its first choice, "Yes". Timing alone does not rule that out:
  the model may send several tool calls in one message, and the second call is checked only when the
  first one ends, which can be any moment (the review measured a dialog 26 s into a batch whose first
  call had run 25 s). So the Enter is made under a lock. Measured on 2.1.332: a tool call's
  PermissionRequest always follows its PreToolUse, about 0.1 s after that hook ends, for the session's
  own calls and a subagent's; and while a PreToolUse hook runs, no dialog is drawn (one held 20 s kept
  the screen clear for 20 s). Angelia's PreToolUse hook (scripts/tui-pretool-hook.mjs, only where
  `midturn` is on: it runs before every tool call) marks itself in flight, then waits while
  `absorb.lock` is there, then writes when it ended. Before Enter the daemon writes the lock, then
  requires: no hook in flight, none ended in the last 1.5 s, no request at the permission hook or in
  the chat, the transcript read to its end, a tool call of the session's own running for 3 s with no
  subagent at work and no call that asks the person by itself (AskUserQuestion, ExitPlanMode, any
  `mcp__` tool, which may open a form), and the screen busy with our text alone in its box and no
  dialog. Then Enter, if the lock is still under 3 s old (past 8 s the hook reads it as left over);
  the lock goes once Claude Code took the message. Both sides write before they read, so one always
  sees the other. Angelia's PermissionRequest hook marks itself first thing, and a live mark holds
  the Enter back too. A pane started before the hook (no mark of it since the turn began) is never
  typed into; the hook is not in the launch fingerprint, so an upgrade relaunches no idle pane (it
  gets the hook at its next launch). The lock is only Angelia's own hook: another PreToolUse hook in
  the settings Claude Code merges (the user's, the project's, its local one, managed settings, or a
  plugin they enable whose hooks file names one) runs beside it and can still be at work after it
  ended, so a pane with one takes no messages into its turns (logged once, said in /status). A plugin
  that registers its hooks from code cannot be read and is not seen.
  Mitigation (`midturn`, unset is on), the rest: the message is pasted with the same header line. It
  waits in the queue's own count, so /stop and /new (in the chat or the desk app) drop it as they
  drop a queued turn (and their reply counts it), shutdown drops it unsent, and a turn injected behind
  it is held in the same count; only a turn that came through the chat as its own takes messages (never a job's, a watch's,
  `angelia turn`'s, a peer's or the app's), and a turn injected meanwhile comes after them. The running turn's one answer goes to the chat, and
  replies to its first message. A turn Claude Code runs for messages the turn did not take is read as
  a turn of the chat's (permission relay, progress, typing, the answer), from its own prompt row on.
  A turn that fails after it took messages queues each again as a turn of its own, once. A restart
  that adopts the running turn (adopt-turns.json) takes along the messages typed into it (and the
  brain's record of them, so the next daemon reads the turn Claude Code runs for those it did not take)
  and those still waiting for their moment, which run after the turn as queued messages do; for a turn
  not adopted those are dropped, with a count in the log. The clients
  get a `turn` event per message typed into a turn, with `into` naming that turn. Left open: a dialog
  that no tool call's check raises (the sandbox's network prompt during a running command, an MCP
  server's own request), a PreToolUse hook a plugin registers from code, and a hook of the owner's
  that answers "ask" from elsewhere; the screen check is the only guard for those. Print mode also
  takes a stream-json message mid-turn (a `queued_command` row with no origin), but the model read it
  as text inside a tool result and did not act on it (haiku, 2026-11-25), so print mode keeps its
  queue.

## Open

Turns typed by the user in the Claude app are not delivered to the chat (the gateway did deliver
them). Nothing forwards them today, and a private message typed in the app should probably not
land in a group by surprise; decide deliberately rather than inherit it.

A session is read between turns only while the daemon holds it (`idle_exit_minutes` after the chat's
last turn or the last turn woken by the end of the chat's own work). After a daemon restart, or once the pane is
parked, what the agent says by itself stays in the session until the chat's next message, and is
not sent then. Another agent's or session's message is `unknown` until its row is measured. A
prompt the session scheduled names no task: the row that fires it was not seen to carry an id that
ties it to the turn that scheduled it, so its answer stays in the app. The text the agent writes in
a turn the CLI started while one of Angelia's waited to be taken is read as that turn's progress;
only its last text is held back.
