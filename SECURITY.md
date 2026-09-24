# Security

Angelia runs on your own machine, holds a bot token and a WhatsApp login, and puts chat messages
in front of a coding agent that can read your files and run programs. Please report a vulnerability
privately.

**Supported versions:** the latest tag. Fixes go into a new release, not into old ones.

**How:** open a private security advisory on this repository (GitHub > Security > Report a
vulnerability). Do not open a public issue for a vulnerability.

**What to expect:** an acknowledgement within a week, a fix or a plan in the advisory thread, and
credit in the release notes if you want it.

**In scope:** anything in this repository: the daemon, the router and its gates, the local API,
the capabilities compiler, the installer. The threat model is in [docs/security.md](docs/security.md); a report that
shows one of those statements to be false is exactly what this page is for.

**Out of scope:** the coding CLIs Angelia launches (Claude Code, Grok Build) and the chat platforms
themselves. Prompt injection against an agent through what it reads is documented as a known limit,
not a vulnerability in Angelia.
