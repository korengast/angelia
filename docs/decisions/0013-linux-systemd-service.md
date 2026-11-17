# ADR 0013 — Linux: the daemon as a systemd user service

Status: accepted 2026-11-17. The systemd facts below were read from systemd.exec(5),
systemd.service(5) and the systemd sources (`src/run/run.c`, `src/shared/bus-unit-util.c`,
`src/core/dbus-execute.c`, v249 and v255), not yet measured on a running box. The checks in
`docs/runbook.md` ("Linux server over Tailscale") measure them; amend this record with what they show.

Scope: the daemon itself (start at boot, back after a crash, `/restart` and `angelia update` from a
chat, the same deny floor and symlink guard as on macOS). Jobs, voice replies, sandboxed profiles
and the pi backend stay macOS only.

## Chosen

- **A user unit, not a system one.** `~/.config/systemd/user/angelia.service`, run with
  `systemctl --user`, plus `loginctl enable-linger` once so it starts at boot without a login. This
  is the LaunchAgent's twin: the same user and home, and no root, so `/restart` and `update` still
  work from a chat. The path is always `~/.config`, never `$XDG_CONFIG_HOME`: the user manager, the
  restarter and the deny floor all look there.
- **One seam, two backends.** `service.ts` picks `launchd.ts` (the old code, moved unchanged) or
  `systemd.ts` behind one `ServiceBackend`. The unit carries the four values Angelia reads back
  (table, node, entry, state folder) in a `# angelia: {json}` comment line, so nothing parses
  systemd quoting, and no Mac install has to migrate.
- **Escaping, per directive** (systemd.exec(5)): `ExecStart=` words are quoted with `\`, `"`, `%`
  and `$` escaped (`$$`, because it expands `$VAR`). `Environment=` does no `$` expansion, so there
  only `\`, `"` and `%`. `WorkingDirectory=` and `append:` take only `%%`. A newline in any value is
  refused: systemd cannot express it.
- **Restart policy:** `Restart=on-failure`, `RestartSec=10` (launchd's KeepAlive without
  SuccessfulExit, ThrottleInterval 10), `TimeoutStopSec=20` (launchd's ExitTimeOut), output appended
  to `daemon.out`, not the journal.

## The cgroup problem

systemd's default `KillMode=control-group` kills every process the service started when it stops,
`setsid` or not. Under launchd two children outlive the daemon by design; under systemd both would die:

- **The `/restart` restarter** runs as a transient unit of its own: `systemd-run --user --wait
  --collect --unit=angelia-restart-<ts>`. Without a pty, `systemd-run` installs no SIGTERM handler,
  so the `--wait` client (still in the daemon's cgroup) dies by signal when the restart stops the
  service, while the transient unit lives on. A failed restart leaves the daemon up and the client
  exits with the restarter's own code (`ExecMainStatus`). So: exit by signal is a good restart, a
  non-zero code a failed one. `-p StandardOutput=append:…` goes over D-Bus as given, with no
  specifier expansion, so it is not `%`-escaped; the command words are `$`-escaped, since the
  manager expands `$VAR` in a transient service's command as in a unit file.
- **Angelia's tmux server** starts inside `systemd-run --user --scope --description="angelia tmux"`
  (only `new-session`, the call that may start it). The server's double fork stays in the scope.
  The description keeps the session key and the agent's argv out of the journal.

Both apply only to the daemon in `angelia.service`'s own cgroup (`/proc/self/cgroup` ends in
`/angelia.service`). Not `SYSTEMD_EXEC_PID`: it exists only from systemd 248, and below that the
restarter would run detached inside the service's cgroup and be killed by its own `stop`, leaving
the daemon down. The tmux server falls back to a plain tmux call when `systemd-run` is missing or fails (no
user bus): its panes may then not survive a restart. The restarter never falls back: inside the
service's cgroup a detached restarter would die by its own `stop`, so without `systemd-run` the
`/restart` fails with "systemd-run not found" and the daemon stays up. A non-zero exit of
`systemd-run` is a failed restart, reported to the chat.

## Rejected

- **`KillMode=process`.** One line, but systemd discourages it, and print-mode agents would be
  orphaned at every stop.
- **A system unit with `User=`.** Install, restart and update would need root, and `/restart` from a
  chat would need sudoers rules.
- **A JSON record beside the service file** (`service.json`, rendered into a plist or unit). It
  removes the plist regexes too, but every Mac install would need a two-step migration, and the
  record could disagree with the file the supervisor actually runs.

## Also needed on Linux

- **Symlink guard.** `O_NOFOLLOW_ANY` is macOS only. `openNoFollow` walks the path from `/`,
  opening each folder with `O_PATH | O_DIRECTORY | O_NOFOLLOW` (search permission only, so a
  parent of mode 0711 does not refuse the walk) through `/proc/self/fd/<dir>/<name>` (the
  effect of `openat`, without an addon). Measured on Linux (node:22-alpine, with the earlier `O_RDONLY` walk; the ubuntu CI runs the
  same tests, and a search-only parent, on the `O_PATH` one): a link as the last
  name, a middle folder or the parent is refused. On some kernels `O_DIRECTORY | O_NOFOLLOW` on a
  link reports `ENOTDIR`, so that is mapped to `ELOOP` when `lstat` confirms a link.
- **Deny floor.** Claude Code keeps its login in `~/.claude/.credentials.json` on Linux (the
  Keychain on macOS); with the keyring, browser profiles and both service folders, it joins
  every profile's floor.

## To measure

On Ubuntu 24.04 and 22.04 (systemd 255 and 249): the unit starts the right program for a path
with a space, `%`, `$` and non-ASCII; reboot brings the daemon up with nobody logged in; `/restart`
from a chat says "back up" and keeps every tmux pane; `systemctl --user stop` of a stuck daemon
gives up after 20 s; a `.inbox` swapped for a link refuses the file.
