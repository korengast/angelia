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

/** Which Claude app connectors the profile loads (Profile.connectors, else defaults.connectors). */
export function connectorMode(cfg: Config, name: string): 'granted' | 'all' {
  return cfg.profiles[name]?.connectors ?? cfg.defaults.connectors ?? 'granted';
}

/**
 * The connector capabilities a profile in `connectors: all` drops, by name, with their urls: each one
 * it is denied (its own deny, or defaults.deny it does not lift), and each one under its except: that
 * it is not given back under its own capabilities. Sorted by name.
 */
export function droppedConnectors(cfg: Config, name: string): [string, string][] {
  const p = cfg.profiles[name];
  const { allowed, denied } = resolveProfile(cfg, name);
  const names = new Set([...denied.keys(), ...p.except.filter((n) => !allowed.has(n))]);
  return [...names].sort().flatMap((n) => { const c = cfg.capabilities[n]; return c?.kind === 'connector' ? [[n, c.url] as [string, string]] : []; });
}

/**
 * The note for one connector a profile in `connectors: all` drops (compile and check-config). The deny
 * list matches a connector by its address only (measured: by name it does nothing), so a pattern with
 * a typo, or a connector whose address changed, matches nothing, and the connector loads: this mode
 * fails open where granted fails closed. The daemon warns when a start (print or tmux mode) blocks fewer
 * connectors than the profile drops (blockedShort).
 */
export function droppedConnectorNote(name: string, url: string): string {
  return `connectors: all: ${name} is kept out by its address ${url} only; if that is not the address of the connector in the Claude app (a typo, or an address it changed), nothing is blocked and ${name} loads. Each start's warning from Claude Code should name it as blocked; the daemon log warns when a start blocks fewer connectors than this profile drops`;
}
