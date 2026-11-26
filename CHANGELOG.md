# Changelog

## Unreleased

- The agent knows what was posted in its chat since its last turn (a job's line, `angelia send`, another profile, Angelia's own lines): it reads them before your next message and does not send them again. New: `--source <label>` on `angelia send` and `send-media`. `angelia export` lists these lines.
- Idle tmux panes are ended: one Angelia reads no more that sat idle `defaults.pane_idle_hours` (default 12), or that runs an older Claude Code. The next message resumes it. A pane with a dialog or a teammate open is kept.
- A session with a background shell command, subagent or teammate still running is no longer ended or let go of by the idle reap (`idle_exit_minutes`), for at most 12 hours per task. This holds in print mode too.
- A failed API call (a lost login, a server error) is no longer posted as the agent's answer. The same turn runs once more after one minute. A login that is still lost gets one line that says what to do. `angelia health` counts these as `api errors`.
