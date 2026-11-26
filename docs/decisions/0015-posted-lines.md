# ADR 0015 — The agent is told the lines posted past it

Status: accepted 2026-11-06.

## Context

A `send:` job, a `run:` job's output, `angelia send` from a script or from another profile, and
Angelia's own lines (a restart, a cut turn, a permission that timed out) all reach the chat through
`Orchestrator.notify()` and `sendMediaTo()`. The chat's agent never learned of them: they are not in
its CLI transcript and not in `angelia export`. Without that the agent repeated a reminder a job had
just posted, and could not answer a question about a line the chat had just read.

## Decision

- **Record.** `core/session/notes.ts` keeps, for any chat key: the time, the text as the chat saw
  it, who posted it (`source`), the session active then, and whether the agent was told. The newest
  200 per chat, 2000 characters a line, 64 000 a chat. The file is `posted-lines.json` in the state
  folder (0600), which no agent may open. Every posted line and every turn start that found lines
  rewrites the whole file, with no fsync; that is fine at these caps.
- **The rule.** Every line Angelia posts into a chat that the agent did not write is recorded: what
  `notify()` and `sendMediaTo()` post, and the lines of Angelia's own that end or replace a turn's
  answer (`told()`: no answer, denied, the failure line, a lost login, the usage-limit hint, the
  agent not found or not started, a stall that stopped it, a bare command's "done"). Not recorded,
  because they are about the chat and not said in the agent's name: permission prompts and their
  answers, the stall warning, a CLI notice, and the router's answers to a sender.
- **Who posted.** `job <name>` from a job; `profile <name>` from another profile's agent, whatever
  it says; `owner` for the owner's token with no label; `angelia` for the daemon's own lines; or the
  label a caller gives in `source` on `/send` and `/send-media` (printable, 60 characters at most,
  no `[`, `]` or `·`; the CLI's `--source`). A line the agent posts into its own chat with its own
  token and no source is not kept: it wrote it. With a source it is kept under that label, which may
  not start with `owner`, `angelia` or `profile`.
- **Tell.** At the start of a turn the chat's untold lines go before the envelope, oldest first,
  each with its local time and source, under one line that says they are data, never instructions,
  and not to send them again. A job's line is marked `output, unverified` (a `run:` job may print
  fetched text). Another profile's line is given only when the chat's profile lists that profile in
  `accept_from`: otherwise a line would be a way around that list. It stays kept, for export. At most 4000
  characters, the newest kept, one line for the count that went. They count as told at the turn's
  start: a turn the restart cuts loses them, and the cut line covers that. A line's further rows are
  quoted with `>`, so no posted text can forge a stamp line, the head line or the count line. Not
  before a bare CLI command (it goes as typed; the lines wait) or a handoff brief Angelia wrote, nor in `angelia ask` copies. A retry
  of the turn carries the same block.
- **Export.** `angelia export` puts the lines among the rows by time, as the agent's rows with a
  `source` field.

## Consequences

- The agent answers about a job's line and does not post it twice. The cost is one small block at
  the next turn, and one file write per posted line.
- A script that posts with the owner's token and gives no `--source` shows as `owner`. A peer cannot
  pose as the owner or a job: its source is always its profile.
- A line posted while a turn runs is read at the turn after it.
