# ADR 0005 — TypeScript on Node ≥ 22, no Python sidecar

Status: accepted 2026-09-13. Baileys and grammY are Node; a Python router
would need a Node sidecar and two supervisors. One runtime, `tsx` for dev, `tsc` for build,
`node --test` for tests, no framework, no bundler. MIT.
