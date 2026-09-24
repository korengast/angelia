# ADR 0007 — Antigravity CLI and Grok Build as backends

Status: accepted 2026-09-15. The agy half is superseded 2026-09-21: agy was removed as a backend (headless it cannot deny a single tool, and its MCP servers are machine-wide, so per-profile capabilities could never be enforced on it). The measurements below stay as the record of why.

ADR 0006 asked three facts of any new backend: how a session is resumed by id, how a permission
prompt is surfaced without a TTY, and whether the process stays alive across turns. Both were
measured on this Mac on 2026-09-15 (agy 1.2.3, grok 1.0.13 then 1.0.30).

## Antigravity CLI (`agy`)

- **Process:** `agy --input-format stream-json --output-format stream-json --print=`. One process
  takes many turns: one `{event:"user", message:{role,content}}` line each. `--print` must carry an
  empty value or the CLI eats the next flag as the prompt.
- **Session:** the CLI mints `conversation_id` in its `init` event; `--conversation <id>` resumes it.
  Angelia therefore renames the session row to the backend id after the first turn.
- **Permissions:** headless agy cannot prompt. Without `--dangerously-skip-permissions` it denies the
  tool itself and reports `denied_actions` in the result. Angelia appends one fixed line telling the
  user to use `bypassPermissions` or an allow rule in agy's settings. `acceptEdits` and `default` map
  to `--mode accept-edits`, `plan` to `--mode plan`.
- **Latency:** 30 to 40 s per turn on this machine, inside agy itself (the same on a raw probe).
- **Instructions file:** AGENTS.md or GEMINI.md, not CLAUDE.md. The wizard writes AGENTS.md.

## Grok Build (`grok`)

- **Process:** `grok [--permission-mode X] agent [-m] [--reasoning-effort] [--always-approve] stdio`,
  driven over ACP (Agent Client Protocol, JSON-RPC 2.0 on stdio): `initialize`, then `session/new`
  or `session/load`, then one `session/prompt` per turn. Text arrives as `session/update`
  notifications; a `tool_call` update flushes buffered text as progress.
- **Session:** `session/new` returns the id; `session/load` (capability `loadSession`) resumes it
  and replays history. Same row rename as agy.
- **Permissions:** `session/request_permission` arrives as a JSON-RPC request with option kinds
  `allow_once`, `allow_always`, `reject_once`; Angelia answers with the matching option id, so the
  existing chat relay works unchanged. Safe commands (`touch`) are auto-allowed by
  grok; `rm`, `git init`, `curl` prompt. `bypassPermissions` becomes `--always-approve`.
- **Latency:** 3 to 6 s per turn.
- **Instructions file:** grok reads CLAUDE.md and Claude settings (`grok inspect`).

## Consequences

- `src/brain/brain.ts` holds the `Brain` interface, shared permission bookkeeping and the factory
  input; `src/brain/index.ts` picks the class from `profile.backend`.
- `SessionMap.rename` exists because two of three backends mint their own ids.
- pi and OpenCode follow the same three-fact rule before they get a class.
