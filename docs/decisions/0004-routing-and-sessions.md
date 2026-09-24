# ADR 0004 — routing.yaml, profile = directory, session map

Status: accepted 2026-09-13. `routing.yaml` (repo root example) is the schema: `profiles`,
`routes`, `whatsapp`, `telegram`, `defaults`. Session key `platform:chat[:thread]` → UUID in
`~/.angelia/sessions.json` with full history; `/new` mints, `/resume` lists. One in-process queue
per key; a pidfile makes the daemon the only writer. Unmatched chats are dropped silently by default.
Envelope goes in user text (`[whatsapp group 1203…@g.us · Owner]\n<text>`), never in the system prompt.
