import type { Capability, Config } from '../instance/config/schema.js';

export interface Resolved {
  /** What the profile gets, by name. */
  allowed: Map<string, Capability>;
  /** What must be unreachable from it, by name. */
  denied: Map<string, Capability>;
}

/**
 * One profile's capabilities, from the table alone. Order of precedence, weakest first:
 * the defaults; the profile's `except` (drops a default); the profile's own `capabilities` (adds, and
 * lifts a default deny — that is how one profile gets what every other profile is denied); the profile's own
 * `deny` (beats everything). The loader has already refused unknown names and self-contradictions.
 */
export function resolveProfile(cfg: Config, name: string): Resolved {
  const p = cfg.profiles[name];
  if (!p) throw new Error(`unknown profile "${name}"`);
  const allowed = new Set(cfg.defaults.capabilities.filter((n) => !p.except.includes(n)));
  for (const n of p.capabilities) allowed.add(n);
  const denied = new Set(cfg.defaults.deny.filter((n) => !p.capabilities.includes(n)));
  for (const n of p.deny) { denied.add(n); allowed.delete(n); }
  for (const n of denied) allowed.delete(n);
  const pick = (names: Set<string>) => new Map([...names].sort().map((n) => [n, cfg.capabilities[n]] as const));
  return { allowed: pick(allowed), denied: pick(denied) };
}

/** The variables this profile's allowed MCP capabilities declare: the only secrets its children get (core/env.ts). */
export function capabilityEnv(cfg: Config, name: string): string[] {
  const names = new Set<string>();
  for (const c of resolveProfile(cfg, name).allowed.values()) if (c.kind === 'mcp') for (const k of c.env) names.add(k);
  return [...names].sort();
}

/** Every variable any capability in the table declares: secrets, whoever holds them. */
export function allCapabilityEnv(cfg: Config): string[] {
  const names = new Set<string>();
  for (const c of Object.values(cfg.capabilities)) if (c.kind === 'mcp') for (const k of c.env) names.add(k);
  return [...names].sort();
}
