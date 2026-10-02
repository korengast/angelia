/**
 * The permission gate Angelia loads into pi with `-e` (PiBrain). pi has no permission prompt of its
 * own, by design; an extension's `tool_call` hook can block a call, and `ctx.ui.confirm()` becomes an
 * `extension_ui_request` on stdout in RPC mode, which PiBrain relays to the chat like Claude's
 * can_use_tool (measured 2026-09-25, pi 0.86.1).
 *
 * pi loads this file by itself, so it imports nothing but Node. The policy comes from the
 * ANGELIA_PI_POLICY environment variable: the profile's permission mode, its folders, whether the
 * shell runs sandboxed, and the deny rules its last compile wrote (the same `Read(/abs)` / `Edit(/abs)`
 * entries as grok's). Without a valid policy nothing runs.
 *
 * Two layers hold the deny rules. pi's file tools are checked here: paths read the way pi's own tools
 * read them (a leading `@`, `file://`, `~`, Unicode spaces, the read tool's fallback spellings),
 * resolved through symlinks one component at a time as the OS does, and compared by file identity
 * (device and inode), so no spelling the disk treats as the same name gets past a rule. Shell
 * commands are not read at all: each runs inside macOS's sandbox (sandbox-exec) with a profile made
 * from the same rules, so the kernel refuses a denied path whatever the command's spelling, for every
 * program the command starts. Measured 2026-09-27: other case, symlinks, relative links, `..`, globs,
 * NFD names, a hard link or a rename made by the command, all refused. The sandbox does not stop a
 * command from asking a program outside it to act (a terminal through tmux or Apple Events, launchd);
 * that is why no mode but bypass runs a command unasked, except a short list of plain read-only ones.
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type PiMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
const MODES: PiMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

export interface PiPolicy {
  mode: PiMode;
  cwd: string;
  /** Folders besides cwd where acceptEdits writes without asking (add_dirs, _common/, directory capabilities). */
  dirs: string[];
  /** Compiled deny rules: `Read(<path or glob>)`, `Edit(<path or glob>)`; anything else is ignored. */
  deny: string[];
  /** Shell commands run inside macOS's sandbox with the deny rules; false only when the table says `sandbox: false`. */
  sandbox: boolean;
  /** Unix sockets no command may connect to besides those under a Read rule: Angelia's tmux server,
   *  where other profiles' agents run. */
  sockets?: string[];
  /** The profile's own cache folder (npm, pip, uv, XDG point there), writable to its commands. */
  cache?: string;
}

/** The title prefix PiBrain recognises; any other dialog is not ours. */
export const PERMISSION_TITLE = 'angelia-permission';

/** pi's bash tool has no timeout of its own; no command runs longer than this many seconds, so one
 *  that never ends (`tail -f`, a server) cannot hold the chat forever. Claude Code's ceiling. */
export const BASH_TIMEOUT_S = 600;

/** pi's own search tools, off by default in pi 0.86.1. Without them the model searches through the
 *  shell, which outside bypass asks the owner each time; these the gate checks and lets run. */
export const SEARCH_TOOLS = ['grep', 'find', 'ls'];

const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
const WRITE_TOOLS = new Set(['edit', 'write']);
/** Tools that walk a folder: a denied path anywhere under the target blocks them too. */
const WALK_TOOLS = new Set(['grep', 'find']);
/** A walk that only lists names: over a denied folder it asks instead of refusing. */
const NAME_WALKS = new Set(['find']);
/** Commands acceptEdits runs unasked, and only with plain path arguments inside the profile's
 *  folders. Each was chosen because no flag of it writes a file or runs a program: `rg --pre`,
 *  `tree -o`, `git --output`, git's config hooks (`core.fsmonitor`), `file -C` and `tail -f` (which
 *  never ends) are why rg, tree, git, file and tail are not here. */
const READ_ONLY = new Set(['ls', 'pwd', 'cat', 'head', 'wc', 'echo', 'date', 'whoami', 'uname', 'stat']);
const NO_CASE = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Text folding for the comparison only, never for a path that is used. It only backs up the file
 * identity check below, for paths that do not exist yet: APFS folds case with full Unicode case
 * folding and ignores normalisation (long s is s, sharp s is ss), which lower-casing alone misses.
 */
export const fold = (p: string): string => {
  const hit = folds?.get(p);
  if (hit !== undefined) return hit;
  const f = NO_CASE ? p.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFC') : p.normalize('NFC');
  folds?.set(p, f);
  return f;
};

/** A path as pi's tools read it (pi 0.86.1, utils/paths.js normalizePath with stripAtPrefix and
 *  normalizeUnicodeSpaces), made absolute against `base`. `..` is collapsed as text, as pi does. */
export function piPath(input: string, base: string, home = homedir()): string {
  let p = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  if (p.startsWith('@')) p = p.slice(1);
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = join(home, p.slice(2));
  else if (p.startsWith('file://')) { try { p = fileURLToPath(p); } catch { /* left as written */ } }
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

/** The spellings pi's read tool falls back to when the path as given does not exist (pi 0.86.1,
 *  path-utils.js resolveReadPath): a narrow space before AM/PM, NFD, a curly apostrophe, both. */
export function readVariants(p: string): string[] {
  const nfd = p.normalize('NFD');
  const curly = (x: string) => x.replace(/'/g, '\u2019');
  return [...new Set([p, p.replace(/ (AM|PM)\./gi, '\u202F$1.'), nfd, curly(p), curly(nfd)])];
}

/** The path the OS would reach: resolved one component at a time, so a relative link is read against
 *  the real folder it sits in, and a link whose target does not exist yet is followed too. */
export function real(abs: string, depth = 0): string {
  if (depth > 100) return abs;
  try { return realpathSync(abs); } catch { /* some part does not exist, or is a dangling link */ }
  const parent = dirname(abs);
  if (parent === abs) return abs;
  const base = real(parent, depth + 1);
  const here = join(base, basename(abs));
  try { if (lstatSync(here).isSymbolicLink()) return real(resolve(base, readlinkSync(here)), depth + 1); } catch { /* not there */ }
  return here;
}

/** File ids, folder chains and folded spellings already worked out during one decision: the read
 *  tool's spellings share their folders, and each is held against every rule. */
let ids: Map<string, string | undefined> | null = null;
let chains: Map<string, Set<string>> | null = null;
let folds: Map<string, string> | null = null;

/** A file's identity on disk, which no spelling of its path can change. */
function idOf(p: string): string | undefined {
  if (ids?.has(p)) return ids.get(p);
  let id: string | undefined;
  try { const s = statSync(p, { bigint: true }); id = `${s.dev}:${s.ino}`; } catch { id = undefined; }
  ids?.set(p, id);
  return id;
}

/** `abs` is `root` or lies under it. Both are real paths. Decided by identity: `root`'s id among the
 *  ids of `abs` and every folder above it; by folded text only where `root` does not exist. */
export function under(abs: string, root: string): boolean {
  const a = fold(abs), r = fold(root);
  if (a === r || a.startsWith(r.endsWith(sep) ? r : r + sep)) return true;
  const id = idOf(root);
  return !!id && chain(abs).has(id);
}

/** The ids of `abs` and of every folder above it that exists. */
function chain(abs: string): Set<string> {
  const known = chains?.get(abs);
  if (known) return known;
  const out = new Set<string>();
  for (let cur = abs; ; cur = dirname(cur)) {
    const id = idOf(cur);
    if (id) out.add(id);
    if (dirname(cur) === cur) break;
  }
  chains?.set(abs, out);
  return out;
}

/** The names from `base` down to `root`, when `root` lies under `base`; found by identity. */
function below(root: string, base: string): string[] | undefined {
  const id = idOf(base);
  const names: string[] = [];
  for (let cur = root; ; cur = dirname(cur)) {
    if ((id && idOf(cur) === id) || fold(cur) === fold(base)) return names;
    if (dirname(cur) === cur) return undefined;
    names.unshift(basename(cur));
  }
}

type Rule = { tool: 'Read' | 'Edit'; root: () => string; test: (abs: string) => boolean };

/** Counts decisions, so a rule folder that does not exist yet is looked up again once per decision. */
let decision = 0;

/** A rule's folder, resolved once it exists; one that does not exist yet is looked up again in the next decision. */
function rootOf(raw: string): () => string {
  let root = real(raw), found = !!idOf(root), at = decision;
  return () => { if (!found && at !== decision) { root = real(raw); found = !!idOf(root); at = decision; } return root; };
}

export function parseRules(deny: string[], home = homedir()): Rule[] {
  const out: Rule[] = [];
  for (const r of deny) {
    const m = /^(Read|Edit)\(([\s\S]+)\)$/.exec(r);
    if (!m) continue;
    // Claude's absolute form is `//abs`; grok's and pi's is `/abs`. Both mean the same here.
    const raw = piPath(m[2].replace(/^\/\//, '/'), '/', home);
    const tool = m[1] as 'Read' | 'Edit';
    // A brace group that holds a `/` or is left open is syntax this does not model: the rule then
    // covers its whole fixed folder (fails closed).
    const brace = raw.indexOf('{');
    if (brace !== -1 && /\{[^}]*(\/|$)/.test(raw.slice(brace))) {
      const root = rootOf(raw.slice(0, raw.slice(0, brace).lastIndexOf('/')) || '/');
      out.push({ tool, root, test: (abs) => under(abs, root()) });
      continue;
    }
    // Any glob character starts the pattern, as in the sandbox (sandboxProfile).
    const star = raw.search(/[*?[{]/);
    if (star === -1 || (raw.endsWith('/**') && star === raw.length - 2)) {
      const root = rootOf(star === -1 ? raw : raw.slice(0, -3));
      out.push({ tool, root, test: (abs) => under(abs, root()) });
    } else {
      const dir = raw.slice(0, raw.slice(0, star).lastIndexOf('/')) || '/';
      const root = rootOf(dir);
      const pats = raw.slice(dir.length).split('/').filter(Boolean).map((x) => (x === '**' ? null : glob(fold(x))));
      out.push({ tool, root, test: (abs) => { const names = below(abs, root()); return !!names && reaches(pats, names); } });
    }
  }
  return out;
}

/** A glob segment as a matcher, or 'any' for syntax this does not model (fails closed). */
type Glob = ((name: string) => boolean) | 'any';

/**
 * One glob segment of a rule (`*`, `?`, `[..]`, `{a,b}`) as a matcher over a folded name, with no
 * regular expression, so a pattern cannot make a check slow. Braces are expanded first; nested
 * braces, `{a..z}` ranges, `[[:class:]]` and a `[` left open are taken as reaching everything.
 */
export function glob(pat: string): Glob {
  if (/\{[^}]*\{|\{[^}]*\.\.[^}]*\}|\[:|\[\]|\[!\]|\[\^\]|\[[^\]]*$/.test(pat)) return 'any';
  const alts: string[] = [];
  const expand = (p: string) => {
    if (alts.length > 64) return;
    const i = p.indexOf('{'), j = p.indexOf('}', i);
    if (i === -1 || j === -1) { alts.push(p); return; }
    for (const x of p.slice(i + 1, j).split(',')) expand(p.slice(0, i) + x + p.slice(j + 1));
  };
  expand(pat);
  if (alts.length > 64) return 'any';
  const ms = alts.map((p) => (name: string) => wild(p, name));
  return (name) => ms.some((f) => f(name));
}

/** Wildcard match in linear time: `*`, `?`, `[set]` / `[!set]` with ranges; backtracks to the last star only. */
function wild(p: string, s: string): boolean {
  let i = 0, j = 0, star = -1, mark = 0;
  const cls = (at: number, c: string): [boolean, number] | null => {
    const end = p.indexOf(']', at + 2);
    if (end === -1) return null;
    let body = p.slice(at + 1, end);
    const neg = body[0] === '!' || body[0] === '^';
    if (neg) body = body.slice(1);
    let hit = false;
    for (let k = 0; k < body.length; k++) {
      if (body[k + 1] === '-' && k + 2 < body.length) { if (c >= body[k] && c <= body[k + 2]) hit = true; k += 2; }
      else if (body[k] === c) hit = true;
    }
    return [hit !== neg, end + 1];
  };
  while (j < s.length) {
    const c = p[i];
    if (c === '*') { star = i++; mark = j; continue; }
    if (c === '?') { i++; j++; continue; }
    if (c === '[') { const r = cls(i, s[j]); if (r && r[0]) { i = r[1]; j++; continue; } if (!r && s[j] === '[') { i++; j++; continue; } }
    else if (c !== undefined && c === s[j]) { i++; j++; continue; }
    if (star === -1) return false;
    i = star + 1; j = ++mark;
  }
  while (p[i] === '*') i++;
  return i === p.length;
}

/** Whether a path of glob segments reaches the names down to a root (null is `**`): a pattern
 *  longer than the names still counts only when it goes on with `**`. */
function reaches(pats: (Glob | null)[], names: string[]): boolean {
  for (let i = 0; i < Math.min(pats.length, names.length); i++) {
    const g = pats[i];
    if (g === null || g === 'any') return true;
    if (!g(fold(names[i]))) return false;
  }
  return pats.length <= names.length || pats[names.length] === null;
}

type Verdict = { action: 'allow' } | { action: 'ask' } | { action: 'block'; reason: string };

interface Compiled { rules: Rule[]; folders: string[]; writable: string[]; cacheParent?: string; cache?: string }
const compiled = new WeakMap<PiPolicy, Map<string, Compiled>>();

/** Where a command that runs unasked, and a bypass file write, may write (TEMP_DIRS aside): the
 *  profile's folders and its cache. One list for both, or the file tool would be the way around. */
function unaskedWritable(policy: PiPolicy, home: string): string[] {
  return [...[policy.cwd, ...policy.dirs].map((d) => piPath(d, '/', home)), ...(policy.cache ? [policy.cache] : [])];
}

/** The rules and folders of a policy, parsed once: the gate's policy never changes while pi runs. */
function compile(policy: PiPolicy, home: string): Compiled {
  let byHome = compiled.get(policy);
  if (!byHome) compiled.set(policy, (byHome = new Map()));
  let c = byHome.get(home);
  if (!c) {
    const folders = [policy.cwd, ...policy.dirs].map((d) => real(piPath(d, '/', home)));
    const cache = policy.cache ? real(policy.cache) : undefined;
    byHome.set(home, (c = { rules: parseRules(policy.deny, home), folders, writable: [...unaskedWritable(policy, home).map(real), ...TEMP_DIRS], ...(cache ? { cache, cacheParent: dirname(cache) } : {}) }));
  }
  return c;
}

/** What the gate does with one tool call. Pure but for the file system lookups, so the tests can walk every mode. */
export function decide(policy: PiPolicy, tool: string, input: Record<string, unknown>, home = homedir()): Verdict {
  ids = new Map(); chains = new Map(); folds = new Map(); decision++;
  try { return decideOnce(policy, tool, input, home); } finally { ids = chains = folds = null; }
}

function decideOnce(policy: PiPolicy, tool: string, input: Record<string, unknown>, home: string): Verdict {
  const { rules, folders, writable, cache, cacheParent } = compile(policy, home);
  const at = (p: unknown) => real(piPath(typeof p === 'string' && p ? p : '.', policy.cwd, home));
  const inside = (abs: string) => folders.some((d) => under(abs, d));
  const denied = (abs: string, kinds: ('Read' | 'Edit')[], walk: boolean) =>
    rules.find((r) => kinds.includes(r.tool) && (r.test(abs) || (walk && under(r.root(), abs))));
  const blocked = (what: string) => ({ action: 'block' as const, reason: `Angelia's profile rules deny ${what}. It did not run; tell the owner it was refused, do not report it as done.` });
  // The other pi profiles' cache folders sit next to this one's: closed, as their folders are.
  const foreignCache = (abs: string) => !!cacheParent && under(abs, cacheParent) && fold(abs) !== fold(cacheParent) && !under(abs, cache!);

  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
    const kinds: ('Read' | 'Edit')[] = READ_TOOLS.has(tool) ? ['Read'] : ['Read', 'Edit'];
    // The read tool opens the first spelling that exists; every one it could open is checked.
    // pi makes them from the path after its own clean-up, so they are made here after piPath too.
    const clean = piPath(typeof input.path === 'string' && input.path ? input.path : '.', policy.cwd, home);
    const spellings = (tool === 'read' ? readVariants(clean) : [clean]).map((sp) => real(sp));
    for (const abs of spellings) {
      if (foreignCache(abs)) return blocked(`${tool} of ${abs}, another profile's cache`);
      const r = denied(abs, kinds, WALK_TOOLS.has(tool) && !NAME_WALKS.has(tool));
      if (r) return blocked(`${tool} of ${abs}${fold(r.root()) !== fold(abs) ? ` (rule on ${r.root()})` : ''}`);
      // find over a folder that holds a denied one would list names in it: asked, not refused.
      if (NAME_WALKS.has(tool) && denied(abs, kinds, true) && policy.mode !== 'bypassPermissions') return { action: 'ask' };
    }
    if (READ_TOOLS.has(tool)) return { action: 'allow' };
    if (policy.mode === 'plan') return blocked('changes in plan mode');
    // Bypass writes without asking only where its unasked commands may write too; a write elsewhere
    // would get around the sandbox with the file tool. With `sandbox: false` it writes anywhere.
    if (policy.mode === 'bypassPermissions') {
      if (!policy.sandbox || writable.some((d) => under(spellings[0], d))) return { action: 'allow' };
      return { action: 'block', reason: `In bypass, pi writes without asking only in the profile's folders (${folders.join(', ')}), its cache folder and temp; ${spellings[0]} is outside them. It did not run. Tell the owner: adding the folder to add_dirs lets you write there.` };
    }
    if (policy.mode === 'acceptEdits' && inside(spellings[0])) return { action: 'allow' };
    return { action: 'ask' };
  }
  if (tool === 'bash') {
    // The command is not read for paths: the sandbox holds it to the deny rules (sandboxed() below).
    if (policy.mode === 'plan') return blocked('commands in plan mode');
    if (policy.mode === 'bypassPermissions') return { action: 'allow' };
    // A read-only command runs unasked only on paths inside the folders that no Read rule covers: with
    // `sandbox: false` nothing else would stop it.
    if (policy.mode === 'acceptEdits' && readOnly(String(input.command ?? ''), (w) => { const a = at(w); return inside(a) && !denied(a, ['Read'], true); })) return { action: 'allow' };
    return { action: 'ask' };
  }
  // A tool an extension or package added: nothing to check it against, so only bypass lets it run unasked.
  if (policy.mode === 'plan') return blocked(`${tool} in plan mode`);
  return policy.mode === 'bypassPermissions' ? { action: 'allow' } : { action: 'ask' };
}

/** macOS's sandbox tool: every shell command runs under it, with a profile made from the rules. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** A string in a sandbox profile (SBPL, a Scheme dialect): backslash and double quote escaped. */
const sbpl = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** Text matched as itself in the sandbox's regex, ASCII letters in either case: the kernel compares
 *  the name as stored on disk, and APFS lets a file be reached, or made, under another case. */
const reText = (s: string) => Array.from(s).map((c) => (/[A-Za-z]/.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : /[.[\]()*+?{}|^$\\]/.test(c) ? `\\${c}` : c)).join('');
const segRe = (s: string) => s.replace(/\*|\?|[^*?]+/g, (m) => (m === '*' ? '[^/]*' : m === '?' ? '[^/]' : reText(m)));

/** A rule's glob part as regexes, one per segment (`**` spans folders), or undefined for syntax this
 *  does not model: classes, nested or open braces, `{a..z}` ranges, a brace group holding a `/`,
 *  letters outside ASCII. */
function globSegs(tail: string): string[] | undefined {
  // Non-ASCII letters: the disk folds their case and normalisation, which a regex does not.
  // oxlint-disable-next-line no-control-regex -- any character outside ASCII, on purpose
  if (/[[\]]/.test(tail) || /[^\x00-\x7f]/.test(tail) || /\{[^}]*(\{|\.\.|\/|$)/.test(tail) || /\}/.test(tail.replace(/\{[^{}]*\}/g, ''))) return undefined;
  const segs = tail.split('/').filter(Boolean);
  return segs.map((seg, i) => (seg === '**' ? (i === segs.length - 1 ? '(/.*)?' : '(/[^/]+)*')
    : '/' + seg.replace(/\{([^{}]*)\}|[^{}]+/g, (m, alts?: string) => (alts !== undefined ? `(${alts.split(',').map(segRe).join('|')})` : segRe(m)))));
}

/** The glob part of a rule (after its fixed folder, `/`-separated) as a regex tail, or undefined for
 *  syntax it does not model. */
export function globRegex(tail: string): string | undefined {
  return globSegs(tail)?.join('');
}

/** A path as the kernel names it: links resolved (real), and the part that exists in the case and
 *  Unicode form stored on disk (realpath(3)); the part that does not exist yet as written. */
function onDisk(abs: string): string {
  const r = real(abs);
  for (let cur = r; ; cur = dirname(cur)) {
    try { return join(realpathSync.native(cur), relative(cur, r)); } catch { /* not there yet */ }
    if (dirname(cur) === cur) return r;
  }
}

/** The devices a command may write to wherever it runs: output, the null device, its own descriptors. */
const DEVICES = ['(literal "/dev/null")', '(literal "/dev/zero")', '(literal "/dev/tty")', '(literal "/dev/stdout")', '(literal "/dev/stderr")', '(literal "/dev/dtracehelper")', '(regex #"^/dev/fd/")'];

/** Temp folders every command may write, as the kernel names them: /tmp and this user's own temp
 *  folder ($TMPDIR), not the rest of /var/folders, which holds other apps' caches. */
const TEMP_DIRS = [...new Set(['/private/tmp', onDisk(tmpdir())])];

interface SandboxOptions {
  /** Unix sockets no command may connect to, besides those under a Read rule. */
  sockets?: string[];
  /** When given, the only folders a command may write in (with temp and the output devices). */
  writable?: string[];
  /** The profile's own cache folder: the others next to it are closed, for reading and writing. */
  cache?: string;
}

/**
 * The sandbox profile for a policy's deny rules. Everything is allowed but what the rules deny: a Read
 * rule closes reading (listing and stat too), writing and connecting to a socket under its path; an
 * Edit rule closes every kind of write (create, change, delete, rename, link, mode). Each rule path is
 * given as written and as the OS resolves it. A rule with a glob becomes a regex, ASCII case folded;
 * one whose glob this does not model denies its whole fixed folder (fails closed).
 * The kernel matches paths, so a folder above a rule could be renamed and the protected files read or
 * changed under the new name (a review showed it): every folder above a rule, and above a closed
 * socket, cannot itself be renamed, removed or replaced; what is inside them stays open. With
 * `writable`, a command writes nowhere else: the confinement Codex's sandbox and Claude Code's apply.
 */
export function sandboxProfile(deny: string[], home = homedir(), o: SandboxOptions = {}): string {
  const out = new Set<string>();
  const kept = new Set<string>();
  const keepAbove = (p: string) => { for (let cur = dirname(p); ; cur = dirname(cur)) { kept.add(cur); if (dirname(cur) === cur) break; } };
  for (const r of deny) {
    const m = /^(Read|Edit)\(([\s\S]+)\)$/.exec(r);
    if (!m) continue;
    const raw = piPath(m[2].replace(/^\/\//, '/'), '/', home);
    // Any glob character starts the pattern, as in the file-tool check (parseRules).
    const star = raw.search(/[*?[{]/);
    // Each as a folder (subpath) or a regex; a socket filter names the regex kind path-regex.
    let filter: { kind: 'subpath' | 'regex'; value: string }[];
    if (star === -1 || (raw.endsWith('/**') && star === raw.length - 2)) {
      const root = star === -1 ? raw : raw.slice(0, -3);
      const roots = [...new Set([root, onDisk(root)])];
      roots.forEach(keepAbove);
      filter = roots.map((value) => ({ kind: 'subpath', value }));
    } else {
      const dir = raw.slice(0, raw.slice(0, star).lastIndexOf('/')) || '/';
      const names = raw.slice(dir.length).split('/').filter(Boolean);
      const segs = globSegs(raw.slice(dir.length));
      const dirs = [...new Set([dir, onDisk(dir)])];
      dirs.forEach((d) => keepAbove(join(d, '_')));
      const head = (d: string) => `^${reText(d === '/' ? '' : d)}`;
      if (!segs) filter = dirs.map((value) => ({ kind: 'subpath', value }));
      else {
        const tail = segs.join('');
        filter = dirs.map((x) => ({ kind: 'regex', value: `${head(x)}${tail}${names.at(-1) === '**' ? '' : '(/.*)?'}$` }));
        // The folders a pattern passes through on the way down (up to the first `**`) are kept too.
        const stop = names.slice(0, -1).indexOf('**');
        for (let i = 1; i <= (stop === -1 ? names.length - 1 : stop); i++)
          for (const x of dirs) out.add(`(deny file-write* (regex ${sbpl(`${head(x)}${segs.slice(0, i).join('')}$`)}))`);
      }
    }
    for (const { kind, value } of filter) {
      const f = `(${kind} ${sbpl(value)})`;
      out.add(`(deny file-write* ${f})`);
      if (m[1] === 'Read') {
        out.add(`(deny file-read* ${f})`);
        out.add(`(deny network-outbound (remote unix-socket (${kind === 'regex' ? 'path-regex' : kind} ${sbpl(value)})))`);
      }
    }
  }
  for (const s of o.sockets ?? []) {
    out.add(`(deny network-outbound (remote unix-socket (path-literal ${sbpl(s)})))`);
    out.add(`(deny file-write* (literal ${sbpl(s)}))`);
    keepAbove(s);
  }
  // launchd's ssh-agent socket: the key it holds would sign for a command that cannot read ~/.ssh.
  const lines = ['(version 1)', '(allow default)', `(deny network-outbound (remote unix-socket (path-regex ${sbpl('^/private/(tmp|var/run)/com\\.apple\\.launchd\\.[^/]+/Listeners$')})))`];
  if (o.cache) {
    const own = [...new Set([o.cache, onDisk(o.cache)])], parent = [...new Set([dirname(o.cache), onDisk(dirname(o.cache))])];
    // Strictly below the shared folder: tools such as npx look at the folders above their cache.
    out.add(`(deny file-read* file-write* (require-all (require-any ${parent.map((d) => `(regex ${sbpl(`^${reText(d)}/`)})`).join(' ')}) (require-not (require-any ${own.map((d) => `(subpath ${sbpl(d)})`).join(' ')}))))`);
  }
  if (o.writable) {
    const where = [...new Set([...o.writable.flatMap((d) => [d, onDisk(d)]), ...TEMP_DIRS])].map((d) => `(subpath ${sbpl(d)})`);
    lines.push(`(deny file-write* (require-not (require-any ${[...where, ...DEVICES].join(' ')})))`);
    // What git runs later, outside any sandbox, when someone runs git there: a repo's config and hooks,
    // and a new `.git` (git init, or a gitdir file pointing elsewhere). Commits still work. Codex
    // keeps `.git` read-only in its writable folders for the same reason.
    const git = `/${reText('.git')}(/(${reText('config')}|${reText('hooks')}(/.*)?|${reText('info/attributes')}))?$`;
    lines.push(`(deny file-write* (regex ${sbpl(git)}))`);
  }
  return [...lines, ...out, ...[...kept].map((k) => `(deny file-write* (literal ${sbpl(k)}))`)].join('\n');
}

/** A shell word in single quotes: the one POSIX quoting with no escapes inside. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The command pi's bash tool runs instead of the model's: the same command, in the same shell (`$0`
 * of the shell pi started), under sandbox-exec with the profile. pi keeps the model's own command in
 * the session (measured on 0.87.1: the session file and the model's context never see this line).
 * ANGELIA_SANDBOX tells Angelia's own CLI, run inside, that an unreadable profile folder is the
 * sandbox, not a broken table.
 */
export function sandboxed(command: string, profile: string): string {
  return `exec /usr/bin/env ANGELIA_SANDBOX=pi ${SANDBOX_EXEC} -p ${sq(profile)} "$0" -c ${sq(command)}`;
}

/** One program under sandbox-exec with the profile: its stdout, or an Error with its stderr (for a
 *  denied path, the kernel's "Operation not permitted"). */
function inSandbox(profile: string, argv: string[], input = ''): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const c = spawn(SANDBOX_EXEC, ['-p', profile, ...argv], { env: { ...process.env, ANGELIA_SANDBOX: 'pi' } });
    const out: Buffer[] = [], err: Buffer[] = [];
    c.stdout.on('data', (d: Buffer) => out.push(d));
    c.stderr.on('data', (d: Buffer) => err.push(d));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString().trim() || `exit ${code}`))));
    c.stdin.on('error', () => { /* the program ended before reading: its exit says why */ });
    c.stdin.end(input);
  });
}

/**
 * The disk access of pi's read, write and edit tools, each done by a program under sandbox-exec. The
 * gate checks a path when the call comes, and pi opens it later, in its own process: a command left
 * running in the background could swap a checked file for a symlink to a denied one in between (a
 * review measured it). Done here, the kernel checks the open itself. `detectImage` is pi's own check,
 * given a copy of the file's first bytes.
 */
export function fileOps(profile: string, detectImage?: (file: string) => Promise<string | null | undefined>) {
  const run = (argv: string[], input?: string) => inSandbox(profile, argv, input);
  const readFile = (path: string) => run(['/bin/cat', '--', path]);
  return {
    readFile,
    access: async (path: string) => { await run(['/bin/test', '-r', path]); },
    editAccess: async (path: string) => { await run(['/bin/sh', '-c', 'test -r "$1" && test -w "$1"', 'sh', path]); },
    writeFile: async (path: string, content: string) => { await run(['/bin/sh', '-c', 'cat > "$1"', 'sh', path], content); },
    mkdir: async (dir: string) => { await run(['/bin/mkdir', '-p', '--', dir]); },
    detectImageMimeType: detectImage && (async (path: string) => {
      const head = await run(['/usr/bin/head', '-c', '4100', '--', path]);
      const dir = mkdtempSync(join(tmpdir(), 'angelia-pi-'));
      try { writeFileSync(join(dir, 'head'), head); return await detectImage(join(dir, 'head')); } finally { rmSync(dir, { recursive: true, force: true }); }
    }),
  };
}

/** pi's package, as its extension loader names it to an extension. In a variable, so Angelia's own
 *  build does not look for it. */
const PI_SDK = '@earendil-works/pi-coding-agent';

/**
 * pi's package, for the file tools. pi's loader gives an extension its package name, but only in a
 * file it transforms, and it leaves files under node_modules alone: an installed Angelia's gate is
 * one (measured 2026-09-27: "package did not load" in a chat). Then it is found from the pi running
 * this file: its entry script lies inside the package.
 */
export async function loadPiSdk(argv1 = process.argv[1]): Promise<any> {
  try { return await import(PI_SDK); } catch { /* not transformed: look from pi's own script */ }
  let d: string;
  try { d = dirname(realpathSync(argv1 ?? '')); } catch { return undefined; }
  for (; dirname(d) !== d; d = dirname(d)) {
    let pkg: any;
    try { pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')); } catch { continue; }
    if (!/^@[\w-]+\/pi-coding-agent$/.test(pkg?.name ?? '')) continue;
    const entry = pkg.exports?.['.']?.import ?? pkg.main;
    return typeof entry === 'string' ? import(pathToFileURL(join(d, entry)).href).catch(() => undefined) : undefined;
  }
  return undefined;
}

/** Why commands cannot run sandboxed here, or '' when they can: the profile compiled and ran once. */
export function sandboxProblem(profile: string): string {
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) return `this system has no ${SANDBOX_EXEC}, which Angelia runs every pi command in`;
  const r = spawnSync(SANDBOX_EXEC, ['-p', profile, '/usr/bin/true'], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? '' : `the sandbox did not start (${(r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 200)})`;
}

/**
 * A command acceptEdits may run unasked: one command from READ_ONLY, nothing a shell would expand
 * or redirect (no quotes, globs, variables, operators, `~`, `=`), every flag a plain one (no value
 * glued to it) and every other word a path that `inside` accepts.
 */
export function readOnly(cmd: string, inside: (word: string) => boolean = () => true): boolean {
  if (/[;&|<>`$\n\\(){}'"*?[\]~!#=]/.test(cmd)) return false;
  const [first, ...rest] = cmd.trim().split(/\s+/);
  if (!READ_ONLY.has(first ?? '')) return false;
  return rest.every((w) => (w.startsWith('-') ? /^-[A-Za-z0-9-]+$/.test(w) : inside(w)));
}

/** The policy Angelia passed, or undefined when it is missing or not one Angelia writes. */
function policyFromEnv(env: NodeJS.ProcessEnv = process.env): PiPolicy | undefined {
  try {
    const p = JSON.parse(env.ANGELIA_PI_POLICY ?? '') as Partial<PiPolicy>;
    const strings = (x: unknown) => Array.isArray(x) && x.every((v) => typeof v === 'string');
    // A policy that does not say `sandbox: false` gets the sandbox.
    if (typeof p.cwd === 'string' && MODES.includes(p.mode as PiMode) && strings(p.dirs ?? []) && strings(p.deny ?? []) && strings(p.sockets ?? []) && (p.cache === undefined || typeof p.cache === 'string'))
      return { mode: p.mode as PiMode, cwd: p.cwd, dirs: p.dirs ?? [], deny: p.deny ?? [], sandbox: p.sandbox !== false, ...(p.sockets?.length ? { sockets: p.sockets } : {}), ...(p.cache ? { cache: p.cache } : {}) };
  } catch { /* fall through */ }
  return undefined;
}

/**
 * pi's read, write and edit tools with their disk access done by fileOps: the kernel then holds the
 * deny rules at the open, where the gate's check alone could be raced. A write or edit the owner
 * approved runs under the approved profile, any other under the unasked one. A pi whose package
 * cannot be loaded here runs none of the three.
 */
async function sandboxFileTools(pi: any, planMode: boolean, sandboxFor: (kind: 'unasked' | 'approved') => { profile: string; problem: string }, approved: Set<string>): Promise<void> {
  const sdk = await loadPiSdk();
  const makers = { read: sdk?.createReadToolDefinition, write: sdk?.createWriteToolDefinition, edit: sdk?.createEditToolDefinition };
  if (!makers.read || !makers.write || !makers.edit) {
    pi.on('tool_call', async (e: any) => (e.toolName in makers ? { block: true, reason: "This pi's file tools cannot run in Angelia's sandbox (its package did not load). Tell the owner; the shell still works." } : undefined));
    return;
  }
  const cwd = process.cwd();
  const ops = (id: string) => {
    const sb = sandboxFor(approved.delete(id) ? 'approved' : 'unasked');
    if (sb.problem) throw new Error(`No file tool can run: ${sb.problem}`);
    return fileOps(sb.profile, sdk.detectSupportedImageMimeTypeFromFile);
  };
  const wrap = (make: any, pick: (o: ReturnType<typeof fileOps>) => object) => {
    pi.registerTool({ ...make(cwd), execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => make(cwd, { operations: pick(ops(id)) }).execute(id, params, signal, onUpdate, ctx) });
  };
  wrap(makers.read, (o) => ({ readFile: o.readFile, access: o.access, detectImageMimeType: o.detectImageMimeType }));
  // Plan mode names its tools on argv; a write tool registered here must not appear in it.
  if (planMode) return;
  wrap(makers.write, (o) => ({ writeFile: o.writeFile, mkdir: o.mkdir }));
  wrap(makers.edit, (o) => ({ readFile: o.readFile, writeFile: o.writeFile, access: o.editAccess }));
}

export default async function angeliaGate(pi: any): Promise<void> {
  const policy = policyFromEnv();
  if (!policy) {
    // Loaded without a policy Angelia wrote: something is wrong, so nothing runs.
    pi.on('tool_call', async () => ({ block: true, reason: "Angelia's policy for this profile is missing, so no tool may run. Tell the owner." }));
    return;
  }
  // Plan mode already names its tools on argv (--tools); elsewhere the search tools are added to
  // whatever is active, so the owner's own extension tools stay as they are.
  if (policy.mode !== 'plan') pi.on('session_start', () => { try { pi.setActiveTools([...new Set([...pi.getActiveTools(), ...SEARCH_TOOLS])]); } catch { /* an older pi: the shell still works */ } });
  // The sandbox profiles, made and tried at the first command and kept once they work: a machine
  // without them refuses commands, and a try that failed (a slow machine timing out) is tried again. A command that runs unasked is confined to the profile's folders for writes; one the owner
  // approved, having read it, may write elsewhere. The deny rules hold for both.
  const profiles: Partial<Record<'unasked' | 'approved', { profile: string; problem: string }>> = {};
  const sandboxFor = (kind: 'unasked' | 'approved') => {
    let sb = profiles[kind];
    if (!sb) {
      const writable = kind === 'unasked' ? unaskedWritable(policy, homedir()) : undefined;
      const profile = sandboxProfile(policy.deny, homedir(), { sockets: policy.sockets, writable, cache: policy.cache });
      sb = { profile, problem: sandboxProblem(profile) };
      if (!sb.problem) profiles[kind] = sb;
    }
    return sb;
  };
  const approved = new Set<string>();
  pi.on('tool_call', async (event: any, ctx: any) => {
    const input = (event.input ?? {}) as Record<string, unknown>;
    const shell = event.toolName === 'bash';
    const refuse = (problem: string) => ({ block: true, reason: `No command can run: ${problem}. Tell the owner; sandbox: false for this profile in the routing table runs commands without it.` });
    if (shell && policy.sandbox && sandboxFor('unasked').problem) return refuse(sandboxFor('unasked').problem);
    const v = decide(policy, String(event.toolName), input);
    if (v.action === 'block') return { block: true, reason: v.reason };
    if (v.action === 'ask') {
      const ok = await ctx.ui.confirm(`${PERMISSION_TITLE} ${event.toolName}`, JSON.stringify(input), { signal: ctx.signal });
      if (!ok) return { block: true, reason: 'The owner did not approve this (denied, or no answer in time). It did not run; say so, do not report it as done.' };
      if (!shell) approved.add(String(event.toolCallId));
    }
    // event.input is mutable and what the tool runs with (pi docs, tool_call).
    if (shell) {
      input.timeout = Math.min(typeof input.timeout === 'number' && input.timeout > 0 ? input.timeout : Infinity, BASH_TIMEOUT_S);
      if (policy.sandbox) {
        const sb = sandboxFor(v.action === 'ask' ? 'approved' : 'unasked');
        if (sb.problem) return refuse(sb.problem);
        input.command = sandboxed(String(input.command ?? ''), sb.profile);
      }
    }
    return undefined;
  });
  if (policy.sandbox && typeof pi.registerTool === 'function') await sandboxFileTools(pi, policy.mode === 'plan', sandboxFor, approved);
}
