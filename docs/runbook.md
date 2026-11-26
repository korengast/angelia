# Runbook

How to run one Angelia instance day to day, and what to do when it misbehaves. The README says what
Angelia is; this says what to type. Paths are the defaults (`~/.angelia`, `ANGELIA_STATE_DIR` moves it).

## Install and first run

```bash
curl -fsSL <the install.sh in the repository> | sh   # Node 22.23.4+, 24.22.1+ or 26.12.1+, git; the README has the exact line
angelia init                    # bot token, which CLI, first directory, pair a chat
angelia service install         # macOS: a LaunchAgent that starts at login and returns after a crash
angelia status                  # instance paths, daemon pid, each platform's state, warm sessions
```

Without the service: `angelia daemon` in a terminal you keep open (it reads `~/.angelia/env` itself),
or `angelia restart`, which starts it detached.

## Every day

| I want to | Command |
|---|---|
| see what is running | `angelia status`; in a chat, `/status` |
| validate the table after an edit | `angelia check-config` |
| apply an edited table | `/restart` in a chat you own, or `angelia restart` from a terminal |
| update the code | `angelia update` (`--check` only lists), then `/restart` |
| see or add profiles | `angelia profiles`, `angelia profile add <platform:chat> [name]` |
| post into a chat from a script | `angelia send <platform:chat> [--source <label>] <text>`, `angelia send-media <platform:chat> </abs/path> [caption]`; the chat's agent reads it at its next turn as its own |
| run a prompt in a chat's session | `angelia turn <platform:chat> <text>` |
| scheduled work | `angelia-jobs.yaml` in the profile folder, then `angelia jobs install` |
| read a chat's history | `angelia export <platform:chat> [--all] [--tools]` |
| see trouble before the chats do | `angelia health [--days N]`; `angelia health --alert` from a daily job (see "Watching for trouble") |
| try tmux mode on the installed Claude Code | `angelia canary`; `angelia canary --if-new-build` from a daily job |
| link or unlink WhatsApp | `angelia pair`, `angelia unpair` |
| version-control the profiles | `angelia workspace sync` (put it in a job to run it nightly) |
| the manual an agent reads | `angelia guide [topic]` |

The daemon reads the table only at start. Every edit needs a restart; `/restart` checks the table
first and refuses a broken one.

## Where to look

| What | Where |
|---|---|
| ids, counts, turn failures, restarts | `~/.angelia/daemon.log`, then `daemon.log.1` (no message text except a dying CLI's last error line) |
| the screen of a tmux pane that never reached a prompt | `~/.angelia/tui/<pane>/screen.txt` |
| how a tmux turn ended, and the screen of one that ended with no answer | `tmux: turn ended by …` in `daemon.log`; `~/.angelia/tui/<pane>/quiet-empty.txt`, `idle-open.txt` |
| the screens of a canary that failed, and the last build that passed | `~/.angelia/tui/canary/<time>/`; `~/.angelia/canary.json` |
| an answer sent with no message waiting for it (tmux), or held back | `late answer delivered`, `self-started answer delivered`, `... not delivered ... reason=`, `tmux: a turn ended between turns and its answer is not delivered: <why>` in `daemon.log` |
| the daemon's own stdout and stderr | `~/.angelia/daemon.out` |
| what the service does | `angelia service status`; `launchctl print gui/$(id -u)/angelia.daemon` (macOS), `systemctl --user status angelia` (Linux) |
| a job timer's output | `~/.angelia/jobs.log`, `~/.angelia/jobs.out` |
| a tui pane that will not answer | `tmux -L angelia ls`, then `tmux -L angelia attach -t <name>` (detach with `C-b d`) |
| the agent's own transcript | `~/.claude/projects/<cwd with non-alphanumerics as ->/<session>.jsonl` |

The first thing to read when a chat says "Something broke on my side" is the `turn failed` line in
`daemon.log`. It carries the reason: the CLI not found, a session that did not resume, a pane that
never reached a prompt. The chat line carries the same reason.

## Watching for trouble

Two commands tell you of trouble before a chat does. Both are plain commands with no daemon part:
put them in jobs, and the chat of the job's profile gets a line only when there is something to say.

**`angelia health [--days N] [--json] [--alert]`** counts trouble in `daemon.log`, per profile and
day: turns that ended with no answer, failed, stalled or threw, answers that could not be delivered,
tmux turns that ended by the quiet pane (all of them, and the ones with no answer for a message),
panes that read idle with the turn open, API errors, retries with a fresh session, permissions
auto-denied, markers a tmux turn dropped on a prompt key miss (`tmux: marker dropped, prompt key
miss:`), and for the daemon as a whole its starts, WhatsApp drops and send retries (each `send
failed, again in N s` line is one more try of a send, not a lost message). A failure that the daemon
tried again (an API error, a first turn that died) is not counted as failed: only the end of the
retry is. The window is the last 24 hours, or the last N days (at most 30), split by your local
calendar day; when the log holds less than that, the first line says where the log starts. A chat is shown as its
profile; a chat no route names is shown by the first eight characters of its id. It reads the log
only, so it works with the daemon down. `tmux turns` is the count of turns that ended in tmux mode;
a print-mode turn writes no line in the log, so there is no total of all turns.

`--alert` prints nothing when every profile is within the limits, else one line for a chat. The
limits, per profile in the window: 2 turns with no answer, 3 failed turns (a turn stopped with
`/stop` is not one), 1 stalled turn, 2 tmux turns that the quiet pane ended with no answer, 1 prompt key miss. A key
miss means the Stop hook read the typed prompt differently from what Angelia typed, so that turn
dropped its own answer; when a new Claude Code stores a prompt another way, every turn of several
lines does so. `angelia canary` checks for it (its multi-line paste check).

**`angelia canary [--if-new-build] [--json]`** tries tmux mode for real on the Claude Code build
installed now. tmux mode reads Claude Code's screen and transcript, and a new build can change
either. The canary starts Claude Code in a tmux server of its own (`angelia-canary-<pid>`, not the
`angelia` one), in a folder of its own in the system temp folder, with the cheapest model, and checks:

1. `start`: the pane reaches a prompt (the trust dialog and the add-dir dialog are answered).
2. `pong`: a one-word turn is answered, and ends by the Stop marker.
3. `tool run`: a turn with one 20 s shell command is not cut. The command comes to the canary as a
   permission request through the relay hook, as it would come to a chat, and the canary allows it;
   then the screens read while it runs must read busy, and the answer must come by the Stop marker.
   One screen that does not read busy passes (a frame caught half drawn) and is kept; two in a row
   fail the check.
4. `idle after`: the pane then reads idle.
5. `slash command`: `/clear`, which Claude Code answers itself, ends by the quiet pane soon after
   its 12 s wait.

The pane is held as a chat's pane is. Its permission mode is `default`, not bypass: the canary says
yes to one request only, its own command to the letter (`touch canary-started && sleep 20 && touch
canary-finished`), and no to any other, which also fails the check and names what was asked. It is
started with no MCP server, yours included (`--strict-mcp-config` with an empty list, as a profile
that is given none). What still loads is what loads in every pane: your own hooks, settings and
`CLAUDE.md` in `~/.claude`. When your settings already allow the command, Claude Code does not ask,
and the check's line says "not asked".

It prints one line per check and a verdict with the Claude Code version, and exits 0 (passed), 1 (a
check failed) or 2 (it could not run, or could not judge the build; see below). It takes one to
three minutes and costs a few model calls on your Claude plan each time (two short turns on the
cheapest model). The pane, its tmux server, the temp folder and the session's transcript are removed
at the end, also when it is stopped (Ctrl-C, a closed terminal, a job's time limit). What a run that
was killed outright left behind is removed by the next run that starts a pane (a run with
`--if-new-build` on a build that already passed starts none): the tmux servers and temp folders named
`angelia-canary-<pid>` whose process is gone. Two things stay: the session shows in the Claude app
while the canary runs (the pane is started as a chat's pane is, with Remote Control), and Claude
Code keeps one line per temp folder in its own `~/.claude.json`.

`--if-new-build` runs the checks only when `claude --version` is not the build that last passed
(`~/.angelia/canary.json`), and then says one line: `Claude Code 2.1.330: tmux mode canary passed
(5 of 5).` or `... FAILED: <check>: <what>. Screens: <folder>.` On the build that passed it prints
nothing. A build that failed, or one it could not judge, is tried again at the next run.

As jobs, in `angelia-jobs.yaml` of a profile of your own that has `shell: true` and whose agent is
not sandboxed (a sandboxed profile's job writes only in the agent's folders, and the canary keeps its
state and its screens in `~/.angelia`):

```yaml
jobs:
  health-alert:
    schedule: "0 8 * * *"
    run: angelia health --alert
  claude-canary:
    schedule: "30 7 * * *"
    run: angelia canary --if-new-build
```

Then `angelia jobs install <profile>`. A canary that fails exits 1, so its line reaches the chat as
the job's failure line: `Scheduled job claude-canary failed (exit 1): Claude Code 2.1.330: tmux mode
canary FAILED: ...`. The same for exit 2: `... could not judge this build: ...` or `angelia canary
could not run: ...`.

Claude Code updates itself in the background, so by default a new build is in use before the canary
sees it: panes on an older build are ended when idle and start again on the new one. To try a build
before the chats use it, turn the background update off: set `DISABLE_AUTOUPDATER` to `"1"` in the
`env` key of `~/.claude/settings.json`. Then update by hand at a quiet hour (`claude update`), run
`angelia canary`, and go back if it fails (below).

## Known failures and their fixes

**"tmux mode canary FAILED".** The Claude Code build installed now does something tmux mode does not
read right. Until it is fixed, chats on tmux profiles may get no answer or a cut one. Do this:

1. Read the screens. The line names the folder (`~/.angelia/tui/canary/<time>/`): one file per
   failed check with the screen it failed on, `tool-run-not-busy.txt` (the first screen that did not
   read busy while the command ran; kept on a pass too, when it was the only one), `final.txt` (the
   last screen, when the pane was still up), the pane's own `pane-screen.txt`,
   `pane-idle-open.txt`, `pane-quiet-empty.txt` or `pane-paste-failed.txt` when it kept one, and
   `brain.log` (what tmux mode logged; no message text). `start` failed: a new dialog before the
   prompt. `tool run` failed with screens that did not read busy: the spinner row or the rows under
   the input box changed. `tool run` failed with a permission request that got a no: the model asked
   to run something other than the canary's command, and the line names it. `slash command` did not end: the command opens a panel now.
2. Keep the build that passed. `~/.angelia/canary.json` names it under `passed`. Install it again:
   `curl -fsSL https://claude.ai/install.sh | bash -s <version>`, and set `DISABLE_AUTOUPDATER` to
   `"1"` in the `env` key of `~/.claude/settings.json` so the new one does not come back. A pane
   that runs now keeps the new build until it is ended: when the chats are quiet, run
   `tmux -L angelia kill-server` (every pane resumes on its next message, on the build you installed).
3. Run `angelia canary` again. Passed: the chats are safe on this build. Report the failing screen
   (it shows the temp folder's path and your plan's name, no chat) so the reader can be fixed; after
   `angelia update` brings the fix, take `DISABLE_AUTOUPDATER` out, `claude update`, and run the
   canary once more.

A check can also fail for a reason of the hour: the model answered slowly (`the turn did not end in
180 s`). Run it again before you change a build.

**"tmux mode canary could not judge this build".** Exit 2. A turn ended with the plan's usage limit
a failed API call or a lost login, which says nothing about the build: any build ends such a turn
the same way. The line says which. Nothing is recorded, no screen is kept, and the next run tries
again; with `--if-new-build` that is the next day's job. For a lost login run `claude` and `/login`.

**`angelia canary could not run`.** Exit 2, with the reason: tmux is not installed, `claude` is not
on PATH or in the usual install folders, `claude auth status` says it is not logged in (run `claude`
and `/login`), or the state folder cannot be written (a job of a sandboxed profile: move the job to
a profile that is not). It is checked before any model call. Nothing was tried and nothing is
recorded.


**"This chat's agent (claude) is not installed where Angelia can find it."** The CLI is not on the
daemon's PATH. `angelia service install` rewrites the plist with a PATH that includes the folder of
every CLI the table names; or set `bin:` on the profile to the full path.

**Every chat fails after a profile folder moved.** Claude Code keys transcripts and folder trust by
working directory. The daemon copies a session's transcript under the new folder
before `--resume` and presses the trust and external-imports dialogs a new folder opens. If it still
fails: `/new` in the chat starts a fresh session; `tmux -L angelia attach -t <name>` shows a pane
that is stuck on a dialog. Treat a folder move as a migration, not a rename.

**"the session never reached a prompt".** A tui pane sat on a dialog for 90 s. The daemon keeps the
screen it saw in `~/.angelia/tui/<session>/screen.txt` and logs that path. Attach to the pane and
answer it once; the next launch is clean.

**"The agent ended its turn without an answer."** The turn ended and the agent wrote nothing for the
chat. The log has `no answer key=<chat>` for each such line. For a tui profile, find the line
`tmux: turn ended by ...` of the same chat (`key=`) near it: it says how the turn ended. By the Stop
marker: the agent itself said nothing. By the quiet pane with no Stop marker: the pane read idle and
no Stop hook answered. That is right for a slash command the CLI answers itself and for a turn cut
short (Esc, or "No" in Claude Code's own dialog). The line also says what the transcript showed:

- `has no turn`, `has a slash command only`: ended after 12 s of an idle pane.
- `ends with text`: ended after 90 s of an idle pane with no new transcript row; that text is the answer.
  This line on every turn means the Stop hook does not run (hooks turned off, or the hook script
  fails); each answer then comes 90 s late.
- `open, no new row and nothing moving above the input box`: a tool ran or the model owed an answer,
  and then nothing changed for 3 minutes. Before that the daemon waits for the Stop marker and logs
  `the pane reads idle ... but its transcript shows the turn open` once.
- `ends with an error row of the CLI`: the last row is Claude Code's own line for a failed API call
  or a usage limit; ended after 12 s of an idle pane, with that line as the answer.

A turn that ended on the quiet pane with no answer keeps the screen it ended on in
`~/.angelia/tui/<pane>/quiet-empty.txt`. `idle-open.txt` is the screen of the last turn whose pane
read idle while its transcript showed the turn open. Read them to see what the pane showed then.

When the Stop marker of such a turn comes after all, its answer is sent then: `late answer delivered
key=<chat> chars=<n>` in the log. Not when the chat already has those words, not once someone
typed another turn in the Claude app in between, and not when the turn's typed prompt is not the
one Angelia typed (someone typed into it): `late, but the prompt the hook read is not the one
Angelia typed`.

**A message from the agent that nobody asked for (tui profiles).** A background task or a subagent
that a turn of the chat started ended, or a teammate such a turn spawned (the Agent tool with a
name) sent the agent a message; Claude Code woke the agent, and Angelia sent what the agent said: `self-started answer delivered key=<chat> chars=<n>`. At most 6 an hour per chat for tasks' ends, and
30 an hour for teammates' messages (counted apart; a teammate's idle note is among them); then the
chat hears once that more are held back (`reason=hourly-limit`), and those are not kept. To stop a
loop, `/stop` or `/new` in the chat ends the session and its tasks. The count is kept in the
daemon's memory, so a restart starts it again; a Stop marker on disk when the daemon restarts is
not read by the new one (its reader starts at the chat's next turn), so that answer stays in the
Claude app: lost to the chat, never sent twice. A restarted daemon also does not know which tasks
the chat's turns started before it: the end of such a task is not sent (`the work it reports was
not started by a turn of this chat`).

**The agent finished background work and the chat heard nothing (tui profiles).** Look for
`tmux: a turn ended between turns and its answer is not delivered: <why>` with the chat's `key=`:

- `a person typed it in the Claude app or the pane`: the turn was typed there, or someone typed into
  it; it stays in the app.
- `nothing ties it to work a turn of this chat started`, or `the work it reports was not started by
  a turn of this chat`: the turn was woken by something that names no task a turn of the chat
  started: a task the owner started in the app, a prompt the session scheduled for itself, or a
  task started while nobody read the session. It stays in the app.
- `the teammate that sent it was not started by a turn of this chat`: a named teammate's message
  woke the session, and the teammate was spawned in the app (or a teammate of the same name was
  spawned there later), or while nobody read the session. A teammate a turn of the chat spawned is
  the chat's: the answer to its message is sent, as a task's end is.
- `a teammate's idle note, and [SILENT]`: a teammate of the chat's stopped, and the agent had
  nothing to add.
- `what started it is not known (...)`: the Stop hook could not tell what started the turn
  (another agent's or session's message is one, until its row is measured); a kind
  of row it does not know is named in the brackets. Such an answer is never sent: the agent posts
  it with `angelia send`. A new Claude Code may write its rows another way: `LIVE_ROWS=1 npx tsx
  tests/live-tui-origin.mts` in the source tree runs a scratch session and prints the shape of the
  rows (types and flags, no words), which `scripts/turn-origin.mjs` reads.
- `it ended before this session was read`, or no line at all: nobody was reading the session.
  Angelia reads it between turns from the chat's last turn until `defaults.idle_exit_minutes` (30)
  pass with no message and no turn woken by the end of the chat's own work (each one starts the
  time again) and no background task or teammate still running (12 hours at most per task); `reap key=<chat>` in
  the log is where the reading stopped; not after a daemon restart
  until the chat's next message. The answer is in the Claude app and in the session: ask the agent.
- `no text`, `[SILENT]`, `an API error of the CLI`, `a usage limit of the CLI`: nothing to send.


**"This chat's agent was not started: ...".** The launch check refused. "Its profile was never
compiled": run `angelia compile <profile> --write` once. "N of its protections were changed outside
Angelia": a deny rule the last compile wrote is gone from `.claude/settings.json`, or the sandbox
was turned off; `angelia compile <profile> --write` restores them, and `git diff` in the workspace
shows who took them out. A settings file that no longer parses is named too: fix it by hand, then
compile.

**WhatsApp: `logged out`.** The phone removed the linked device. `angelia unpair` (forgets the
credentials), then `angelia pair` and scan the QR again.

**WhatsApp: `conflict (440)`.** Another client holds this session (a second Angelia, or another
client linked with the same credentials). Stop the other one; the daemon backs off and reconnects by itself.

**WhatsApp: `not connected for 5 min; ending the socket and opening again`.** Paired, and the link
neither opened nor closed for five minutes: the daemon ends the socket and opens a new one by itself.
A second line, `still not connected after opening again; a fresh process is needed`, means that did
not help either. Under the LaunchAgent the daemon then exits and launchd starts a fresh one; started
by hand, restart it (`angelia restart`). A chat whose message was being answered at that moment hears
"Angelia restarted while working on your message. Send it again." from the new daemon.

**A restart while a tmux turn runs.** The shutdown writes the turn to `adopt-turns.json` in the state
folder instead of the cut list, and leaves the pane's last heartbeat (`tui/<pane>/permissions/relay.json`)
to grow old. The new daemon logs `restart: turn adopted key=...`, reads the turn again, offers the
requests that were waiting, and delivers the answer; a pane that is gone logs `restart: turn not
adopted` and its chat gets the "send it again" line. Chat messages that waited behind the turn go with it
and run after it as turns of their own (nothing more is typed into an adopted turn), a message that comes
in while the daemon stops too; one from the desk app does not. Other turns waiting behind it (`angelia
turn`, a job's or another profile's turn, a /resume) are dropped, with one log line (`shutdown: ... not
chat messages ... dropped`, or `an injected turn waiting behind the chat's messages dropped`). The stop
waits up to 10 s for a message being typed into a turn, so it goes as typed into it, never twice. An
adoption gives up after 5 s (`tmux did not answer`), and every tmux call after 30 s. A permission hook asked in the gap waits up to 60 s for a fresh heartbeat; every
other pane's old heartbeat is removed at the start, so its hook steps aside at once. `angelia restart`
from a chat's agent asks the daemon with the agent's own token: the daemon logs `restart: deferred
until the turn of ...` and goes once that turn is over. The request is kept only in the daemon's memory.
This guards against a mistake, not against the agent: the command knows it runs as an agent only by the
`ANGELIA_SESSION_KEY` and `ANGELIA_API_TOKEN` in its environment. With the key removed (`env -u
ANGELIA_SESSION_KEY angelia restart`, outside print mode's process chain), with `--from-daemon`, or with
`--force` and no token, it restarts at once, as the old refusal allowed too; with the token removed and no
`--force` it is refused as before; `--force` with both set is still deferred while that chat's turn runs. An agent can stop its own
daemon in other ways as well (it runs as your user). What makes that harmless for a tmux turn is the adoption above, not this check.

**`a permission between turns, in a turn the agent started by itself (...), tied to the chat's work`.**
The end of a background task or a teammate's message woke the agent after the chat's turn ended, that
work was started in a turn of this chat, and its next tool call asked. The words in brackets say what
started that turn (`<task-notification>`, `<teammate-message>`). The next line says what the profile's
`permissions` did: `permission auto-approved ... (between turns, ...)`, `permission auto-denied ...`, or
`permission asked ...`, and then the chat has the request under "The agent woke up by itself ... and
asks:". `tied to a peer's work`: another profile's turn (`angelia turn` with its token) started that
work; it is refused at once by a refuse rule but never approved at once (`... a peer's work is never
auto-approved`), as in a peer's own turn. `in a turn nothing ties to the chat's work (...)`: a
scheduled prompt, another session's message, a turn the hook could not place (`no row that starts a
turn`, `no row that starts it`), a teammate that ended (its end was read), or a
request with no origin (an older hook). Such a turn may be the owner's own in the Claude app, so the levels
act on it at once neither way: it is always asked, under "A turn Angelia did not type in this session
asks ...". Up to 0.4.3 no request between turns reached the chat: the hook stepped aside. No
such line, and Claude's own dialog in the pane: the daemon had let the pane go (idle, or a restart since
the chat's last message), so nobody read it between turns; the screen notice below still comes.
`... in a turn a person typed (...): not relayed, Claude asks in its own dialog`: someone typed that
turn in the Claude app or the pane, so it is theirs; the hook stepped aside on purpose.
`a permission while a chat turn is read, not of that turn, in ...`: the hook says what started the turn
on every request, and a chat turn's reader keeps only a request of a turn the chat's own prompt opened
and that holds no prompt but the chat's (what it typed, messages typed into it). Anything else went as
a request between turns does (the same words follow): a turn Claude Code ran before the chat's message
(a task's end or another session's message queued first, which the message may have joined), a
person's turn, or a request written under the last idle beat. Up to 0.4.3 the turn's reader sent every
request the levels' way.

**`permission dialog with no relay key=...`.** A dialog in a chat's pane that no hook request accounts
for stood 20 s while no turn of that chat was read (a turn a person typed, the hook stepped aside, or gave up after 11
minutes, or Claude Code's own safety check that no hook sees, such as a teammate's "Dangerous rm
operation"): the chat got one line, "A permission waits: Bash command from the restart-relay agent
(...)", with where to answer it (the Claude app, or the pane's `tmux attach` command). One line per
dialog; inside a turn of the chat the turn's reader says the same within seconds. The chat cannot
answer it; nothing presses a key in the pane. Up to 0.4.3 a dialog whose options wrapped (an 80-column
terminal attached to the pane, a long folder in "don't ask again for ... in `<folder>`") was not read as
open, so no line came.

**Telegram: nothing arrives from a group.** Make the bot a group admin: Telegram's privacy mode hides
plain @mentions from bots otherwise.

**`angelia status` says telegram: conflict.** Another process is polling the same bot token (a
second daemon, a test script, the same token on another machine). Stop it; Angelia polls again by
itself within a minute and logs "telegram: polling again".

**telegram: stopped: ... (401).** Telegram no longer accepts the bot token: it was revoked or
replaced in @BotFather. Put the new token in `~/.angelia/env`, then `/restart`. WhatsApp keeps
working meanwhile.

**`/restart` says the routing table does not load.** Fix what `angelia check-config` names, then
`/restart` again. Nothing was stopped.

**`angelia restart` refuses: "running as the agent of ...".** You are inside a routed chat's
agent. Restart from a terminal of your own, or send `/restart` in the chat: the router runs it
detached so stopping the daemon cannot kill the restart.

**"another angelia daemon is running (pid N)".** `angelia status` shows it. If the pid is dead the
file is stale: `rm ~/.angelia/daemon.pid`, then start again.

**A job timer says the job changed since it was installed.** The plist pins a hash of the job.
`angelia jobs install <profile>` takes the new definition; `angelia jobs` lists what is out of step.

**API error.** The turn runs once more after one minute (`api error key=…, the same turn again in
60 s` in `daemon.log`). A second error ends the turn: for a lost login the chat is told to run `claude`
and `/login` on this machine.

**The agent repeats what a job already posted, or does not know of it.** What a `send:` job, a
`run:` job's output or `angelia send` posts into a chat is kept (`~/.angelia/app-notes.json`) and
read by the chat's agent at its next turn, before the message, as data (`job <name>`, `owner`,
`profile <name>`, `angelia`). A line from another profile is given only when the chat's profile
lists it in `accept_from`. It sees them once; a turn cut by a restart loses
them. `angelia export <platform:chat>` shows them with a `source` field. A script that posts with
the owner's token names itself with `--source`.

**Usage limit.** The chat hears the CLI's own limit line plus how to switch: `/model sonnet` for
this session only; `/model default` once the limit resets.

## Linux server over Tailscale

Run these once on a fresh Ubuntu 22.04+ VPS before a release, reaching it with `tailscale ssh`. Angelia needs no inbound port; Tailscale is only your way in.

1. **Install the service.** `angelia service install`, then `systemctl --user is-active angelia`. Success: `active`, and `angelia service status` says "loaded yes". If it printed a `sudo loginctl enable-linger $USER` line, run it, then check `loginctl show-user $USER -p Linger` says `Linger=yes`.
2. **Reboot with nobody logged in.** `sudo reboot`, wait, then from a new `tailscale ssh` session: `angelia service status` and `tail ~/.angelia/daemon.log`. Success: the daemon is up with a start time after the boot, and a chat message gets an answer.
3. **`/restart` from a chat.** Open a TUI pane first (`tmux -L angelia ls`), send `/restart`. Success: the same panes are still listed afterwards, and the chat hears "back up". Ubuntu's apt tmux is older than 3.7, so `angelia check-config` and `daemon.log` show a tmux version warning: expected, not a failure.
4. **`angelia update`, then `/restart`.** Success: `angelia --version` shows the new version, and after the restart the chat hears "back up" with the new version in `daemon.log`.
5. **`/restart` with a `$` in the config path.** `mkdir -p '/tmp/a$b' && cp ~/.angelia/workspace/routing.yaml '/tmp/a$b/'`, then `angelia service install '/tmp/a$b/routing.yaml'` and `/restart` from a chat. Success: the chat hears "back up" and `systemctl --user show angelia -p ExecStart` names `/tmp/a$b/routing.yaml`. This checks the `$` escaping on the `systemd-run` side, which no test measures. Install the service on your real table again afterwards.
6. **A link as `.inbox` is refused.** In a profile folder, `rm -rf .inbox && ln -s /etc .inbox`, then send the chat a file. Success: the file is not saved, nothing lands in `/etc`, and the agent never sees it. Remove the link afterwards.

## Backup and move

The instance is one folder. `~/.angelia/workspace` is a git repo; push it to a private remote
(`angelia init` offers one). The rest (`env`, `wa/`, `sessions.json`) is credentials
and state: copy the folder as a whole to move to another Mac, never into git.

## Cutting a release

The release key signs tags and nothing else. Keep it off the machine that runs Angelia, behind a
passphrase or a hardware key, so no agent there can use it.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/angelia-release -C "angelia release"      # once; set a passphrase
printf '%s namespaces="git" %s\n' "<login>@users.noreply.github.com" "$(cat ~/.ssh/angelia-release.pub)" > allowed_signers
# paste the same line between the quotes of SIGNERS='' in install.sh; npm test checks the two match
git -c gpg.format=ssh -c user.signingkey=~/.ssh/angelia-release.pub tag -s vX.Y.Z -m "Angelia X.Y.Z"
git push origin vX.Y.Z
git show vX.Y.Z:install.sh > /tmp/install.sh                                # the tag's own copy
gh release create vX.Y.Z --verify-tag --title "Angelia X.Y.Z" --notes "..." /tmp/install.sh
```

The site's `/install` redirects to the `install.sh` attached to the release named in `package.json`
(GitHub counts its downloads), so bump the version, cut the release, then push the site.

Every installed copy checks the next release against the `allowed_signers` it was installed with,
so a new key reaches users only through a release signed with the old one that ships both.

### Releasing without anyone at the keyboard

`.github/workflows/release.yml` signs and publishes a release with a second key that lives only in
the repository's `release` environment on GitHub. Set up once: an environment named `release` with
a wait timer (60 minutes here) and only `main` allowed to deploy; two environment secrets,
`RELEASE_SIGNING_KEY` (an ed25519 key without a passphrase, its public half in `allowed_signers`)
and `RELEASE_DEPLOY_KEY` (a write deploy key); and deploy keys allowed to bypass the rulesets that
guard `main` and `v*` tags. Then, for each release:

```bash
git push origin <commit>:refs/heads/release/X.Y.Z     # the release commit, on top of main
gh workflow run release.yml -f version=X.Y.Z -f commit=<full commit id>
gh run cancel <run id>                                 # to stop it during the wait
```

The workflow checks the commit (on top of `main`, version in `package.json`, tag still free), runs
the whole suite on macOS, waits, then signs the tag, pushes `main` and the tag together, and makes
the GitHub release with the tag's `install.sh` and the commit message as notes, then publishes the same
tarball `install.sh` builds to npm as `angelia-gateway` (trusted publishing: no npm token is stored;
the package's npm settings trust this repository's `release.yml` in the `release` environment). If
that last step fails, the release is out without npm: publish that tag's tarball by hand
(`npm ci --ignore-scripts && npm run build && npm pack --ignore-scripts`, then `npm publish <tgz>`). The
tarball holds no native binaries (sharp and the other platform packages are installed on the user's
machine), so it does not matter which OS builds it. The very first publish was by hand, since npm
lets a package trust a workflow only once the package exists. Know what it trades:
whoever can push to `main` and start workflows can release, so the signature says the release came
from this repository's workflow, not that a person approved it. The wait is the time to stop it.

## Uninstall

```bash
angelia unpair               # first: logs the linked device out, so the phone stops listing it
angelia service uninstall    # stops the daemon and removes the LaunchAgent
angelia jobs remove <profile>   # per profile, or delete ~/Library/LaunchAgents/angelia.job.*.plist
tmux -L angelia kill-server  # the tmux-hosted sessions, if any profile used tui: true
npm rm -g angelia-gateway
rm -rf ~/.angelia            # the instance, including the WhatsApp login
```

Also, by hand: a profile folder you pointed outside `~/.angelia` stays where it is (its
`.claude/settings.json` and `.claude/angelia-compiled.json` are Angelia's), and the bot itself
lives on in Telegram until you send `/deletebot` to @BotFather.
