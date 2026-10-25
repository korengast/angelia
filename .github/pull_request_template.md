> Fixing a security vulnerability? Do not open a public PR. Report it privately as [SECURITY.md](../blob/main/SECURITY.md) says.

<!-- Title: what the user sees, not the code. "restart under launchd never brings the daemon back",
     not "add kickstart call". Keep "Allow edits by maintainers" on, so we can finish small fixes. -->

## Problem

<!-- What goes wrong, for whom, and when. One or two plain sentences. Link the issue if there is one. -->

## Fix

<!-- How the change solves it, briefly. Say why when it is not obvious from the diff. -->

## Evidence

<!-- What you ran and what you saw: tests (`npm test` on macOS with tmux), a real instance, logs,
     screenshots. Say what you could not check. Remove phone numbers, chat ids, names, tokens
     and home paths from logs and screenshots before you paste them. If you measured a CLI's or the OS's behaviour,
     name the version, and add an ADR in docs/decisions/ when the change depends on it. -->

## Checklist

- [ ] `npm test` and `npm run lint` pass
- [ ] Nothing personal in the tree (chat ids, phone numbers, home paths, hostnames)
- [ ] No model call, scheduler, memory or skills system inside the daemon (Angelia is not an agent)
