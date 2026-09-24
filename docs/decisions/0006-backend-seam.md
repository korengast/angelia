# ADR 0006 — Agent-agnostic router, Claude Code as the v1 backend

Status: accepted 2026-09-13. Historical in part: "v1 accepts only claude-code" no longer holds; Grok Build is a second backend (ADR 0007). The seam itself is as described.

Angelia routes chats to a local coding agent. Routing, sessions, gating, chunking and delivery
never mention a specific agent. The `Brain` interface in `src/brain/` is the only seam:
`start()` in a profile cwd, `turn(text)` yielding `progress | permission | result`, `stop()`.
`profiles.<name>.backend` selects the implementation; v1 accepts only `claude-code`.
Candidates for v2: Codex CLI and OpenCode, each needing three facts before an ADR: how a session
is resumed by id, how a permission prompt is surfaced without a TTY, and whether the process can
stay alive across turns. No backend is added until those are measured the way ADR 0001 measured
Claude Code.
