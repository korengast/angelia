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
| how a tmux turn ended, and the screen of one that ended with no answer | `tmux: turn ended by …` in `daemon.log`; `~/.angelia/tui/<pane>/quiet-empty.txt`, `idle-open.txt` |
| the daemon's own stdout and stderr | `~/.angelia/daemon.out` |
| what the service does | `angelia service status`; `launchctl print gui/$(id -u)/angelia.daemon` (macOS), `systemctl --user status angelia` (Linux) |
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

**"The agent ended its turn without an answer."** The turn ended and the agent wrote nothing for the
chat. The log has `no answer key=<chat>` for each such line. For a tui profile, find the line
`tmux: turn ended by ...` of the same chat (`key=`) near it: it says how the turn ended. By the Stop
marker: the agent itself said nothing. By the quiet pane with no Stop marker: the pane read idle and
no Stop hook answered. That is right for a slash command the CLI answers itself and for a turn cut
short (Esc, or "No" in Claude Code's own dialog). The line also says what the transcript showed:

- `has no turn`, `has a slash command only`: ended after 12 s of an idle pane.
- `ends with text`: ended after 90 s of an idle pane with no new transcript row; that text is the answer.
- `open, no new row and nothing moving above the input box`: a tool ran or the model owed an answer,
  and then nothing changed for 3 minutes. Before that the daemon waits for the Stop marker and logs
  `the pane reads idle ... but its transcript shows the turn open` once.
- `ends with an error row of the CLI`: the last row is Claude Code's own line for a failed API call
  or a usage limit; ended after 12 s of an idle pane, with that line as the answer.

A turn that ended on the quiet pane with no answer keeps the screen it ended on in
`~/.angelia/tui/<pane>/quiet-empty.txt`. `idle-open.txt` is the screen of the last turn whose pane
read idle while its transcript showed the turn open. Read them to see what the pane showed then.

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
