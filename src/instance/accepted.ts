import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Config, Profile, Route } from './config/schema.js';
import { withoutRemoved } from './config/load.js';

/**
 * The routing table the owner accepted, kept in the state folder, where no agent can write. The table
 * itself sits in the workspace, which an agent can edit when the workspace is in its add_dirs: it could
 * give itself a shell, new owners, a capability that runs any program, an onboarding block that hands
 * strangers a profile. So the daemon, and every job, runs on the accepted table. A table that changed
 * since waits for the owner: /restart lists the changes and takes them on /restart confirm; on the host
 * `angelia accept` (--check lists them) and `angelia compile --write` take them.
 *
 * Every change counts, narrower ones too, but for the few fields below that grant nothing. Listing what
 * widens instead would miss the next field that does.
 */
// A folder of its own: a guard is compiled/<encoded profile name>.json, and an encoded name never
// holds a slash, so no profile can be named onto this file.
export const ACCEPTED_FILE = join('compiled', 'table', 'accepted.json');

/** Fields a change to which grants no one anything: taken without asking, when nothing else waits.
 *  The timeouts stay under Node's timer limit in the schema (a longer one would fire at once). The
 *  outgoing rate is not here: without it a chat could flood the platform into banning the number. */
const FREE_PROFILE = new Set(['model', 'effort', 'shell_timeout_seconds']);
const FREE_ROUTE = new Set(['mention']);
const FREE_DEFAULTS = new Set(['idle_exit_minutes', 'permission_timeout_minutes', 'turn_stall_minutes']);

const routeName = (r: Config['routes'][number]) => `${r.platform}:${r.chat}${r.thread !== undefined ? `#${r.thread}` : ''}`;

/** What the comparison sees: the table without the free fields, routes by chat (a duplicate keeps its place). */
function view(cfg: Config): Record<string, unknown> {
  const drop = (o: Record<string, unknown> | undefined, free: Set<string>) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !free.has(k)));
  const routes: Record<string, unknown> = {};
  for (const r of cfg.routes) {
    let k = routeName(r);
    for (let n = 2; k in routes; n++) k = `${routeName(r)} (${n})`;
    routes[k] = drop(r as Record<string, unknown>, FREE_ROUTE);
  }
  return {
    ...cfg,
    profiles: Object.fromEntries(Object.entries(cfg.profiles).map(([n, p]) => [n, drop(p as Record<string, unknown>, FREE_PROFILE)])),
    routes,
    defaults: drop(cfg.defaults as Record<string, unknown>, FREE_DEFAULTS),
  };
}

// Whole, never cut: the owner accepts what the list shows, and the fingerprint is taken from it. JSON
// also keeps a value on one line (a line break in a value would split the list).
const show = (v: unknown) => JSON.stringify(v) ?? 'nothing';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// What a new profile or route holds without being told: left out when one is listed, so the list
// shows what was written, not eighteen defaults to skim past.
const PROFILE_DEFAULTS = Profile.parse({ cwd: '/' }) as Record<string, unknown>;
const ROUTE_DEFAULTS = Route.parse({ platform: 'telegram', chat: '0', profile: 'x' }) as Record<string, unknown>;
const isDefault = (parent: string, k: string, v: unknown) => {
  const d = parent === 'profiles' ? PROFILE_DEFAULTS : parent === 'routes' ? ROUTE_DEFAULTS : undefined;
  return !!d && k !== 'cwd' && k !== 'profile' && JSON.stringify(d[k]) === JSON.stringify(v);
};
// A name from the table goes in as it is only when it cannot pass for list text (a line break would
// add a made-up line to what the owner reads). Letters and digits of any script count (a profile made
// from a Hebrew group name); control and format characters (bidi marks) do not.
const key = (k: string) => (/^[\p{L}\p{M}\p{N}_@:#()+ .-]+$/u.test(k) ? k : JSON.stringify(k));

/** A place in the table as tableChanges names it (`profiles.home.shell`), each part written the way the
 *  list writes it. Callers of `beyond` build their own paths with this, never by hand: a name the list
 *  quotes would otherwise not match, and their own change would count as someone else's. */
export const tablePath = (...parts: string[]): string => parts.map(key).join('.');

/** Every difference between two tables, one plain line each, as `profiles.home.shell: false → true`. */
export function tableChanges(was: Config, now: Config): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string, parent = '') => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const at = (k: string) => (path ? `${path}.${key(k)}` : key(k));
    if (isObj(a) && isObj(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], at(k), path);
      return;
    }
    // Something new is listed field by field, so a long one hides nothing.
    if (a === undefined && isObj(b)) {
      out.push(`${path}: new`);
      for (const k of Object.keys(b)) if (!isDefault(parent, k, b[k])) walk(undefined, b[k], at(k), path);
      return;
    }
    if (a === undefined) return void out.push(`${path}: ${show(b)}`);
    if (b === undefined) return void out.push(`${path}: removed`);
    if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every((x) => typeof x !== 'object')) {
      const plus = b.filter((x) => !a.includes(x)), minus = a.filter((x) => !b.includes(x));
      if (plus.length || minus.length) return void out.push(`${path}: ${[...plus.map((x) => `+ ${show(x)}`), ...minus.map((x) => `- ${show(x)}`)].join(', ')}`);
    }
    out.push(`${path}: ${show(a)} → ${show(b)}`);
  };
  walk(view(was), view(now), '');
  return out;
}

/** A short fingerprint of a list of changes: /restart confirm accepts only the list the owner saw. */
export function changesHash(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/** The accepted table, or undefined when none was recorded yet. Throws when the file is damaged. */
export function readAccepted(stateDir: string): Config | undefined {
  let text: string;
  try { text = readFileSync(join(stateDir, ACCEPTED_FILE), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  // Through the schema, as the live table is: a field a newer version added gets its default on both
  // sides, so it is no change, and a file of the wrong shape is an error, not a half-read table.
  const parsed = Config.safeParse(withoutRemoved(JSON.parse(text)));
  if (!parsed.success) throw new Error(`${join(stateDir, ACCEPTED_FILE)} is not a table this version reads: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export function writeAccepted(cfg: Config, stateDir: string): void {
  const file = join(stateDir, ACCEPTED_FILE);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(cfg) + '\n', { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/**
 * What to run on: the live table when it holds nothing the owner has not accepted, else the accepted
 * one, with the changes waiting. No accepted table yet (the first start with this version): the live
 * one, recorded by the caller that may write (the daemon).
 */
export function effectiveTable(live: Config, stateDir: string): { cfg: Config; pending: string[]; first: boolean } {
  const acc = readAccepted(stateDir);
  if (!acc) return { cfg: live, pending: [], first: true };
  const pending = tableChanges(acc, live);
  return { cfg: pending.length ? acc : live, pending, first: false };
}

/** Before the daemon writes the table itself (onboarding, /backend): what it is about to build on
 *  must be the accepted table, or it would take changes nobody saw. Returns why not, if not. */
export function pendingRefusal(live: Config, stateDir: string): string | undefined {
  const { pending } = effectiveTable(live, stateDir);
  return pending.length ? `the routing table has ${pending.length} change(s) the owner has not accepted. See them with /restart in a chat or angelia accept --check; take them with /restart confirm or angelia accept` : undefined;
}

/** After the daemon wrote the table itself: the changes beyond `own` (the paths it meant to change, as
 *  tableChanges names them), which an edit made between its read and its write would be. */
export function beyond(stateDir: string, fresh: Config, own: string[]): string[] {
  const acc = readAccepted(stateDir);
  if (!acc) return [];
  return tableChanges(acc, fresh).filter((l) => !own.some((p) => l.startsWith(`${p}: `) || l.startsWith(`${p}.`)));
}
