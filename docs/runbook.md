# Runbook

How to run one Angelia instance day to day, and what to do when it misbehaves. The README says what
Angelia is; this says what to type. Paths are the defaults (`~/.angelia`, `ANGELIA_STATE_DIR` moves it).

## Install and first run

```bash
curl -fsSL <the install.sh in the repository> | sh   # Node 22+, git; the README has the exact line
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
| post into a chat from a script | `angelia send <platform:chat> <text>`, `angelia send-media <platform:chat> </abs/path> [caption]` |
| run a prompt in a chat's session | `angelia turn <platform:chat> <text>` |
| scheduled work | `angelia-jobs.yaml` in the profile folder, then `angelia jobs install` |
| read a chat's history | `angelia export <platform:chat> [--all] [--tools]` |
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
| the daemon's own stdout and stderr | `~/.angelia/daemon.out` |
| what the service does | `angelia service status`; `launchctl print gui/$(id -u)/angelia.daemon` |
| a job timer's output | `~/.angelia/jobs.log`, `~/.angelia/jobs.out` |
| a tui pane that will not answer | `tmux -L angelia ls`, then `tmux -L angelia attach -t <name>` (detach with `C-b d`) |
| the agent's own transcript | `~/.claude/projects/<cwd with non-alphanumerics as ->/<session>.jsonl` |

The first thing to read when a chat says "Something broke on my side" is the `turn failed` line in
`daemon.log`. It carries the reason: the CLI not found, a session that did not resume, a pane that
never reached a prompt. The chat line carries the same reason.

## Known failures and their fixes

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

**Telegram: nothing arrives from a group.** Make the bot a group admin: Telegram's privacy mode hides
plain @mentions from bots otherwise.

**`/restart` says the routing table does not load.** Fix what `angelia check-config` names, then
`/restart` again. Nothing was stopped.

**`angelia restart` refuses: "running as the agent of ...".** You are inside a routed chat's
agent. Restart from a terminal of your own, or send `/restart` in the chat: the router runs it
detached so stopping the daemon cannot kill the restart.

**"another angelia daemon is running (pid N)".** `angelia status` shows it. If the pid is dead the
file is stale: `rm ~/.angelia/daemon.pid`, then start again.

**A job timer says the job changed since it was installed.** The plist pins a hash of the job.
`angelia jobs install <profile>` takes the new definition; `angelia jobs` lists what is out of step.

**Usage limit.** The chat hears the CLI's own limit line plus how to switch: `/model sonnet` for
this session only; `/model default` once the limit resets.

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
```

Every installed copy checks the next release against the `allowed_signers` it was installed with,
so a new key reaches users only through a release signed with the old one that ships both.

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
