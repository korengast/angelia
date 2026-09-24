# Contributing

Small project, small rules.

- **Run the tests.** `npm test`, on macOS with tmux installed (the tmux host and the launchd pieces
  are tested for real). It type-checks, runs the suite, then packs and installs the package into an
  empty prefix. The hygiene test refuses any tracked file that names a home directory, a phone
  number, a chat id or the current user; keep examples on the placeholders it accepts. Point
  `ANGELIA_HYGIENE_WORDS` at a file of your own words (profile names, services you use) and it
  refuses those too, without the list ever entering the repo.
- **Try it without touching your own instance.** `ANGELIA_STATE_DIR=$(mktemp -d) npm run dev -- init`,
  then `npm run dev -- daemon` with the same variable: a separate instance, token and all.
- **No formatter.** Match the surrounding code: dense, one idea per line, comments that say why.
  Lines run long where a table or a message reads better unbroken; that is deliberate.
- **Nothing personal in the tree.** No chat ids, phone numbers, hostnames, home paths or instruction
  files from a real setup. What makes an install yours lives in `~/.angelia`, never here.
- **Angelia is not an agent.** A change that adds a model call, a scheduler, a memory or a skills
  system inside the daemon will be declined; those belong to the CLI it launches.
- **Where code goes.** `src/` is grouped by concern: `cli/` (the command line), `adapters/`
  (WhatsApp, Telegram), `core/` (routing, sessions, delivery, chat commands), `brain/` (the CLI
  backends), `daemon/` (the process, its local API, service, restart, update), `instance/`
  (config, setup, onboarding, guide), `capabilities/` (the compiler), `jobs/`, `voice/`. Starter
  skills live in `capabilities/skills/` at the top level and ship as files.
- **Decisions get an ADR.** Anything measured against a CLI's behaviour goes in `docs/decisions/`
  with the version it was measured on, so the next person knows what to re-check.
- **Security findings** go through [SECURITY.md](SECURITY.md), not a public issue.
