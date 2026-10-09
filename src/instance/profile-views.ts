import { closeSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import type { Config } from './config/schema.js';
import { resolveProfile } from '../capabilities/resolve.js';
import { RECORD } from '../capabilities/compile.js';
import { FileError, instructionNames, openChecked, readOpen, secretName, type Hidden } from './profile-files.js';

/**
 * The profile views beside its files (mobile plan M1.2): memory, skills and capabilities. What a
 * person needs to see what a profile knows and can do. Read with the rules of profile-files.ts:
 * no credential name or place, the profile's own deny rules, a little of each file.
 */

/** Imports followed from the instruction file, at most this deep (Claude Code allows five hops). */
const IMPORT_DEPTH = 5;
/** At most this many imported files in one answer. */
const IMPORT_MAX = 50;
/** Skills listed per answer at most. */
const SKILL_MAX = 300;
/** Lines longer than this are not searched for imports. */
const MAX_LINE = 4096;
/** A skill's name and description at most, as shown. */
const NAME_MAX = 120;
const DESCRIPTION_MAX = 1000;

/** `~` as the owner reads it, so a page shows `~/…` and never the home path itself. */
export function shortPath(p: string, home = homedir()): string {
  // Paths here are resolved: the home's resolved form counts too (/var is /private/var on macOS).
  let real = home;
  try { real = realpathSync(home); } catch { /* as given */ }
  for (const h of [home, real]) if (p === h) return '~'; else if (p.startsWith(h + sep)) return `~/${p.slice(h.length + 1)}`;
  return p;
}

/** One file anywhere the profile's instructions or skills name it: a regular file of this user with one
 *  name, not a credential, not hidden, opened as profile-files.ts opens any file; text only. */
function readNamed(path: string, hidden: Hidden, uid: number | undefined = process.getuid?.()): { text: string; cut: boolean } {
  let real: string;
  try { real = realpathSync(path); } catch { throw new FileError('no such file', 404); }
  if (real.split(sep).some((p) => secretName(p))) throw new FileError('that file is not shown here');
  if (hidden(real)) throw new FileError('that file is not shown here');
  const fd = openChecked(real, uid);
  try {
    const v = readOpen(fd);
    if (v.binary) throw new FileError('not a text file');
    return { text: v.text, cut: v.cut };
  } finally {
    closeSync(fd);
  }
}

/** `@path` imports in an instruction file, as Claude Code reads them: outside code spans and fenced
 *  blocks, `@` at the start or after a space, a path that starts with `.`, `/`, `~` or a name. */
export function importsOf(text: string, max = IMPORT_MAX): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    // A line this long is data, not instructions; the cap also keeps every pattern below cheap.
    if (fence || line.length > MAX_LINE) continue;
    const plain = line.replace(/`[^`]*`/g, '');
    for (const m of plain.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+)/g)) {
      // Sentence punctuation after a reference is not part of it (trimmed by hand: a regex anchored at
      // the end is quadratic on a long run of dots).
      let ref = m[1];
      let end = ref.length;
      while (end > 0 && '.,;:!?)'.includes(ref[end - 1])) end--;
      ref = ref.slice(0, end);
      // An email address or a handle is not a file: a file reference names a folder or an extension.
      if (!ref || (!ref.includes('/') && !ref.includes('.')) || seen.has(ref)) continue;
      seen.add(ref);
      out.push(ref);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export interface MemoryView {
  /** The profile's own memory folder, relative to its folder, when it has one (browse it with /files). */
  folder: string | null;
  /** Files its instruction file brings in with `@` (and theirs, IMPORT_DEPTH deep), in order. */
  imports: { ref: string; path: string; from: string; text?: string; cut?: boolean; why?: string }[];
}

/** What a profile knows beyond its instruction file: its memory folder and the files it imports. */
export function memoryView(folder: string, backend: string, hidden: Hidden, home = homedir()): MemoryView {
  let root: string;
  try { root = realpathSync(folder); } catch { return { folder: null, imports: [] }; }
  let memory: string | null = null;
  for (const name of ['memory', 'Memory', '.memory']) {
    try { if (statSync(join(root, name)).isDirectory() && !hidden(realpathSync(join(root, name)))) { memory = name; break; } } catch { /* none */ }
  }
  const imports: MemoryView['imports'] = [];
  const seen = new Set<string>();
  const walk = (file: string, from: string, text: string, depth: number) => {
    if (depth > IMPORT_DEPTH) return;
    for (const ref of importsOf(text)) {
      if (imports.length >= IMPORT_MAX) return;
      const path = ref.startsWith('~/') ? join(home, ref.slice(2)) : ref.startsWith('/') ? ref : join(dirname(file), ref);
      let real = path;
      try { real = realpathSync(path); } catch { /* reported below */ }
      if (seen.has(real)) continue;
      seen.add(real);
      const entry: MemoryView['imports'][number] = { ref, path: shortPath(real, home), from };
      try {
        const r = readNamed(path, hidden);
        entry.text = r.text; entry.cut = r.cut;
        imports.push(entry);
        walk(real, shortPath(real, home), r.text, depth + 1);
      } catch (e) {
        entry.why = e instanceof FileError ? e.message : 'could not be read';
        imports.push(entry);
      }
    }
  };
  for (const name of instructionNames(backend)) {
    const file = join(root, name);
    try { walk(file, name, readNamed(file, hidden).text, 1); break; } catch { /* the next name */ }
  }
  return { folder: memory, imports };
}

export interface SkillEntry {
  name: string;
  description: string;
  /** profile: in its own folder; capability: given by the routing table; everyone: installed for every
   *  profile of that CLI, which no compile can filter. */
  source: 'profile' | 'capability' | 'everyone';
  /** Where its SKILL.md is, `~`-shortened. */
  path: string;
}

/** A skill's name and description from its SKILL.md front matter. A value never runs on to the next
 *  line; an empty one counts as missing. */
function frontMatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const get = (k: string, max: number) => {
    const v = new RegExp(`^${k}:[ \\t]*(.*)$`, 'm').exec(m[1])?.[1]?.trim().replace(/^["']|["']$/g, '').trim();
    return v ? v.slice(0, max) : undefined;
  };
  return { name: get('name', NAME_MAX), description: get('description', DESCRIPTION_MAX) };
}

/** The skill folders a profile's CLI reads in its own folder, and those installed for every profile. */
function skillDirs(backend: string, cwd: string, home: string): { dir: string; source: SkillEntry['source'] }[] {
  const own = backend === 'claude-code' ? ['.claude/skills'] : backend === 'pi' ? ['.pi/skills', '.agents/skills', '.claude/skills'] : backend === 'codex' ? ['.agents/skills', '.codex/skills'] : ['.agents/skills', '.grok/skills', '.claude/skills'];
  const everyone = backend === 'pi' ? [join(home, '.pi', 'agent', 'skills'), join(home, '.agents', 'skills')]
    : backend === 'codex' ? [join(process.env.CODEX_HOME ?? join(home, '.codex'), 'skills'), join(home, '.agents', 'skills')]
      : backend === 'grok' ? [join(home, '.grok', 'skills'), join(home, '.agents', 'skills')]
        : [join(home, '.claude', 'skills')];
  return [...own.map((d) => ({ dir: join(cwd, d), source: 'profile' as const })), ...everyone.map((dir) => ({ dir, source: 'everyone' as const }))];
}

/** The skills a profile's agent can use, with where each comes from. */
export function skillsView(cfg: Config, profile: string, hidden: Hidden, home = homedir(), rulesOnly: Hidden = hidden): { skills: SkillEntry[] } {
  const p = cfg.profiles[profile];
  const out: SkillEntry[] = [];
  const seen = new Set<string>();
  // The CLI's own folder in the home (~/.claude) is a credential place as a whole, but its skills/ is
  // what every profile runs: there only the profile's deny rules and the secret names hold.
  const names = new Set<string>();
  const add = (file: string, source: SkillEntry['source'], fallback: string, base?: string) => {
    if (out.length >= SKILL_MAX) return;
    let real: string;
    try { real = realpathSync(file); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let fm: { name?: string; description?: string } = {};
    try { fm = frontMatter(readNamed(real, checkFor(real, source, base)).text); } catch { return; } // hidden or unreadable: not listed
    const name = fm.name ?? fallback.slice(0, NAME_MAX);
    // One name, one skill: the first wins (table, then folder, then everyone), as /skill reads it.
    if (!name || names.has(name)) return;
    names.add(name);
    out.push({ name, description: fm.description ?? '', source, path: shortPath(real, home) });
  };
  /** The deny rules alone hold only for a file that is really inside the CLI's skills folder; a link
   *  out of it (to ~/.claude/settings.json, say) is held to every check. */
  const checkFor = (real: string, source: SkillEntry['source'], base?: string): Hidden =>
    source === 'everyone' && base && (real === base || real.startsWith(base + sep)) ? rulesOnly : hidden;
  // Given by the table first: a capability skill the profile also links into its folder counts as that.
  for (const [name, c] of resolveProfile(cfg, profile).allowed) {
    if (c?.kind !== 'skill') continue;
    const path = c.path.startsWith('~/') ? join(home, c.path.slice(2)) : c.path;
    add(path.endsWith('.md') ? path : join(path, 'SKILL.md'), 'capability', name);
  }
  for (const { dir, source } of skillDirs(p.backend, p.cwd, home)) {
    let entries: string[] = [];
    let base: string | undefined;
    try { entries = readdirSync(dir); base = realpathSync(dir); } catch { continue; }
    for (const n of entries.sort()) add(join(dir, n, 'SKILL.md'), source, n, base);
  }
  return { skills: out };
}

/** One skill's SKILL.md, by the name skillsView gave; only a skill that view lists can be read. */
export function readSkill(cfg: Config, profile: string, name: string, hidden: Hidden, home = homedir(), rulesOnly: Hidden = hidden): { name: string; path: string; text: string; cut: boolean } {
  const hit = skillsView(cfg, profile, hidden, home, rulesOnly).skills.find((s) => s.name === name);
  if (!hit) throw new FileError('no such skill', 404);
  const path = hit.path.startsWith('~/') ? join(home, hit.path.slice(2)) : hit.path;
  // The listing already held this file to the right check; read it under the strictest one that still
  // lets a skill of the CLI's own folder through: the same choice, made again on the resolved path.
  let check = hidden;
  if (hit.source === 'everyone') {
    const p = cfg.profiles[profile];
    for (const { dir, source } of skillDirs(p.backend, p.cwd, home)) {
      if (source !== 'everyone') continue;
      try { const base = realpathSync(dir); const real = realpathSync(path); if (real.startsWith(base + sep)) check = rulesOnly; } catch { /* not this one */ }
    }
  }
  return { name: hit.name, path: hit.path, ...readNamed(path, check) };
}

export interface CapabilityEntry {
  name: string;
  kind: string;
  when?: string;
  /** What it is, without anything secret: a command's program, a skill or folder path, an MCP server's
   *  program or host. Never arguments, environment values or query strings. */
  what: string;
  /** How many secret files it reaches (their paths are not shown). */
  secrets?: number;
}

/** The capabilities a profile gets and those it is denied, from the routing table, and when it was
 *  last compiled (its record's time), so a change not compiled yet shows. */
export function capabilitiesView(cfg: Config, profile: string, home = homedir()): { allowed: CapabilityEntry[]; denied: { name: string; kind: string }[]; compiledAt: string | null } {
  const r = resolveProfile(cfg, profile);
  const what = (c: NonNullable<ReturnType<typeof r.allowed.get>>): string => {
    switch (c.kind) {
      // The program, past any `KEY=value` set in front of it (that can be a secret).
      case 'command': return c.run.trim().split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? '';
      case 'skill': case 'directory': return shortPath(c.path.startsWith('~/') ? join(home, c.path.slice(2)) : c.path, home);
      case 'mcp': if (c.url) { try { return new URL(c.url).host; } catch { return 'remote'; } } return (c.command ?? '').split('/').pop() ?? '';
    }
  };
  const allowed: CapabilityEntry[] = [];
  for (const [name, c] of r.allowed) {
    if (!c) continue;
    const e: CapabilityEntry = { name, kind: c.kind, what: what(c) };
    if (c.when) e.when = c.when;
    if ('secrets' in c && c.secrets.length) e.secrets = c.secrets.length;
    allowed.push(e);
  }
  const denied = [...r.denied].filter(([, c]) => c).map(([name, c]) => ({ name, kind: c!.kind }));
  let compiledAt: string | null = null;
  try { compiledAt = statSync(join(cfg.profiles[profile].cwd, RECORD)).mtime.toISOString(); } catch { /* never compiled */ }
  return { allowed, denied, compiledAt };
}
