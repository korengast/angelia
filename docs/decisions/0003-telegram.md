# ADR 0003 — Telegram: grammY, long polling, plain text, privacy mode on

Status: accepted 2026-09-13. grammY 1.46 (MIT). Long polling (one consumer per token). Plain text,
4 000-char paragraph-aware chunks, fences closed/reopened. `message_thread_id` in the session key.
Allowlist by numeric `from.id`. Groups: the bot must be a group admin (or privacy mode disabled and the bot re-added), because privacy mode drops plain @mentions; angelia enforces `mention` itself.
Media via `getFile` (≤20 MB) into `<cwd>/.inbox/`.
