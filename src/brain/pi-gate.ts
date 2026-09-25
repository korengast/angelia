/**
 * The permission gate Angelia loads into pi with `-e` (PiBrain). pi has no permission prompt of its
 * own, by design; an extension's `tool_call` hook can block a call, and `ctx.ui.confirm()` becomes an
 * `extension_ui_request` on stdout in RPC mode, which PiBrain relays to the chat like Claude's
 * can_use_tool (measured 2026-09-25, pi 0.86.1).
 *
 * pi loads this file by itself, so it imports nothing but Node. The policy comes from the
 * ANGELIA_PI_POLICY environment variable: the profile's permission mode, its folders, and the deny
 * rules its last compile wrote (the same `Read(/abs)` / `Edit(/abs)` entries as grok's). Without a
 * valid policy nothing runs.
 *
 * Paths are read the way pi's own tools read them (a leading `@`, `file://`, `~`, Unicode spaces,
 * the read tool's fallback spellings), resolved through symlinks one component at a time as the OS
 * does, and compared by file identity (device and inode), so no spelling the disk treats as the same
 * name gets past a rule; folded text only backs that up for paths that do not exist yet.
 * A deny rule stops the file tools. A shell command is only checked for a denied path written in
 * it, so a command that builds the path itself gets through: not a sandbox, the same as for grok.
 * That is why no mode but bypass runs a command unasked unless it is on a short list and every
 * path in it is a plain one inside the profile's folders.
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PiMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
const MODES: PiMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

export interface PiPolicy {
  mode: PiMode;
  cwd: string;
  /** Folders besides cwd where acceptEdits writes without asking (add_dirs, _common/, directory capabilities). */
  dirs: string[];
  /** Compiled deny rules: `Read(<path or glob>)`, `Edit(<path or glob>)`; anything else is ignored. */
  deny: string[];
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
/** Programs that run a heredoc as code: their heredoc bodies are checked like the command itself. */
const RUNS_CODE = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'osascript', 'eval', 'source', '.', 'xargs', 'env', 'sudo', 'exec']);
/** More words than this that look like paths, and a command is not checked word by word but asked
 *  about (refused under bypass): each word costs file lookups inside pi's event loop. */
export const MAX_PATH_WORDS = 400;
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
  else if (/^file:\/\//.test(p)) { try { p = fileURLToPath(p); } catch { /* left as written */ } }
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

/** File ids, folder chains and folded spellings already worked out during one decision: a command's
 *  words share most of their folders, and every word is held against every rule. */
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
    const m = /^(Read|Edit)\((.+)\)$/.exec(r);
    if (!m) continue;
    // Claude's absolute form is `//abs`; grok's and pi's is `/abs`. Both mean the same here.
    const raw = piPath(m[2].replace(/^\/\//, '/'), '/', home);
    const tool = m[1] as 'Read' | 'Edit';
    const star = raw.indexOf('*');
    if (star === -1 || (raw.endsWith('/**') && star === raw.length - 2)) {
      const root = rootOf(star === -1 ? raw : raw.slice(0, -3));
      out.push({ tool, root, test: (abs) => under(abs, root()) });
    } else {
      const dir = raw.slice(0, raw.slice(0, star).lastIndexOf('/')) || '/';
      const root = rootOf(dir);
      const pats = raw.slice(dir.length).split('/').filter(Boolean).map((x) => (x === '**' ? null : glob(fold(x), false)));
      out.push({ tool, root, test: (abs) => { const names = below(abs, root()); return !!names && reaches(pats, names, true); } });
    }
  }
  return out;
}

/** The words of a command as a shell would hand them to the program: quotes and backslashes
 *  removed, split on blanks and operators, `~`, `~user` and `$HOME` expanded only where bash expands
 *  them (a `~` at the start of an unquoted word; `$HOME` outside single quotes). Other variables and
 *  substitutions are beyond it: not a sandbox. */
export function shellWords(cmd: string, home = homedir()): string[] {
  const words: string[] = [];
  let cur = '', quote: string | null = null, quoted = false;
  /** Whether the word's first character came from a quote or an escape: then a `~` is literal. */
  let firstQuoted: boolean | null = null;
  const add = (x: string, q: boolean) => { if (!x) return; if (firstQuoted === null) firstQuoted = q; cur += x; };
  const push = () => {
    if (cur || quoted) words.push(!cur.startsWith('~') ? cur : firstQuoted ? `./${cur}` : cur.replace(/^~([A-Za-z0-9._-]+)(?=\/|$)/, (_, u: string) => join(dirname(home), u)));
    cur = ''; quoted = false; firstQuoted = null;
  };
  const homeAt = (i: number) => { const m = /^(\$\{HOME\}|\$HOME(?![A-Za-z0-9_]))/.exec(cmd.slice(i)); return m ? m[1].length : 0; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") { if (c === "'") quote = null; else add(c, true); continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < cmd.length) add(cmd[++i], true);
      else { const n = homeAt(i); if (n) { add(home, true); i += n - 1; } else add(c, true); }
      continue;
    }
    if (c === '$' && cmd[i + 1] === "'") {
      // ANSI-C quoting: $'..' with backslash escapes, which bash turns into plain text.
      const j = ansiEnd(cmd, i + 2);
      add(ansiText(cmd.slice(i + 2, j)), true); quoted = true; i = j; continue;
    }
    if (c === '$' && cmd[i + 1] === '"') continue; // $"..": locale quoting, read as "..".
    if (c === "'" || c === '"') { quote = c; quoted = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) { add(cmd[++i], true); quoted = true; continue; }
    if (/[\s;|&<>()`=:]/.test(c)) { push(); continue; }
    const n = homeAt(i);
    if (n) { add(home, false); i += n - 1; continue; }
    add(c, false);
  }
  push();
  return words;
}

/**
 * The command split from its heredoc bodies (`<<EOF` ... `EOF`). A body fed to a program that runs it
 * as code (a shell, an interpreter) is kept to be checked like the command; any other body is text
 * the program reads, such as a commit message or a file's new content, and is left out.
 */
export function heredocs(cmd: string): { cmd: string; code: string[] } {
  const re = /(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
  let out = '', from = 0, m: RegExpExecArray | null;
  const code: string[] = [];
  while ((m = re.exec(cmd))) {
    const nl = cmd.indexOf('\n', re.lastIndex);
    if (nl === -1) break;
    const end = new RegExp(`^${m[1] === '-' ? '\\t*' : ''}${m[3]}$`, 'm').exec(cmd.slice(nl + 1));
    const stop = end ? nl + 1 + end.index + end[0].length : cmd.length;
    const program = cmd.slice(0, m.index).split(/[;|&\n(]/).pop()!.trim().split(/\s+/)[0] ?? '';
    if (RUNS_CODE.has(basename(program))) code.push(cmd.slice(nl + 1, end ? nl + 1 + end.index : cmd.length));
    out += cmd.slice(from, nl + 1);
    from = stop;
    re.lastIndex = stop;
  }
  return { cmd: out + cmd.slice(from), code };
}

/** Where a $'..' string ends: the next quote not escaped by a backslash. */
function ansiEnd(cmd: string, from: number): number {
  for (let i = from; i < cmd.length; i++) { if (cmd[i] === '\\') i++; else if (cmd[i] === "'") return i; }
  return cmd.length;
}

/** The text bash makes of a $'..' body (bash manual, ANSI-C Quoting). */
export function ansiText(body: string): string {
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  return body.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c.|.)/g, (_, e: string) => {
    if (/^[xuU]/.test(e)) { const cp = parseInt(e.slice(1), 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; }
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    if (e[0] === 'c') return String.fromCharCode(e.charCodeAt(1) & 31);
    return simple[e] ?? '\\' + e;
  });
}

/** A glob segment as a matcher, or 'any' for syntax this does not model (fails closed). */
type Glob = ((name: string) => boolean) | 'any';

/**
 * One glob segment (`*`, `?`, `[..]`, `{a,b}`) as a matcher over a folded name, with no regular
 * expression: the model writes the pattern, so a backtracking regex could stall pi. Braces are
 * expanded first (bash does that before globbing); nested braces, `{a..z}` ranges, `[[:class:]]`
 * and a `[` left open (the lexer splits words on `:`) are taken as reaching everything. As in bash
 * without dotglob, a wildcard at the start of a name never matches a leading dot; `{.ssh,x}` still
 * names .ssh.
 */
export function glob(pat: string, dotRule = true): Glob {
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
  const one = (p: string) => (name: string) => (dotRule && /^[*?[]/.test(p) && name.startsWith('.') ? false : wild(p, name));
  const ms = alts.map(one);
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

/** Whether a path of glob segments can reach the names down to a root (null is `**`). With `prefix`,
 *  a pattern longer than the names still counts: it reaches the root on the way down. */
function reaches(pats: (Glob | null)[], names: string[], full = false): boolean {
  for (let i = 0; i < Math.min(pats.length, names.length); i++) {
    const g = pats[i];
    if (g === null || g === 'any') return true;
    if (!g(fold(names[i]))) return false;
  }
  return full ? pats.length <= names.length || pats[names.length] === null : true;
}

export type Verdict = { action: 'allow' } | { action: 'ask' } | { action: 'block'; reason: string };

interface Compiled { rules: Rule[]; folders: string[] }
const compiled = new WeakMap<PiPolicy, Map<string, Compiled>>();

/** The rules and folders of a policy, parsed once: the gate's policy never changes while pi runs. */
function compile(policy: PiPolicy, home: string): Compiled {
  let byHome = compiled.get(policy);
  if (!byHome) compiled.set(policy, (byHome = new Map()));
  let c = byHome.get(home);
  if (!c) byHome.set(home, (c = { rules: parseRules(policy.deny, home), folders: [policy.cwd, ...policy.dirs].map((d) => real(piPath(d, '/', home))) }));
  return c;
}

/** What the gate does with one tool call. Pure but for the file system lookups, so the tests can walk every mode. */
export function decide(policy: PiPolicy, tool: string, input: Record<string, unknown>, home = homedir()): Verdict {
  ids = new Map(); chains = new Map(); folds = new Map(); decision++;
  try { return decideOnce(policy, tool, input, home); } finally { ids = chains = folds = null; }
}

function decideOnce(policy: PiPolicy, tool: string, input: Record<string, unknown>, home: string): Verdict {
  const { rules, folders } = compile(policy, home);
  const at = (p: unknown) => real(piPath(typeof p === 'string' && p ? p : '.', policy.cwd, home));
  const inside = (abs: string) => folders.some((d) => under(abs, d));
  const denied = (abs: string, kinds: ('Read' | 'Edit')[], walk: boolean) =>
    rules.find((r) => kinds.includes(r.tool) && (r.test(abs) || (walk && under(r.root(), abs))));
  const blocked = (what: string) => ({ action: 'block' as const, reason: `Angelia's profile rules deny ${what}. It did not run; tell the owner it was refused, do not report it as done.` });

  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
    const kinds: ('Read' | 'Edit')[] = READ_TOOLS.has(tool) ? ['Read'] : ['Read', 'Edit'];
    // The read tool opens the first spelling that exists; every one it could open is checked.
    // pi makes them from the path after its own clean-up, so they are made here after piPath too.
    const clean = piPath(typeof input.path === 'string' && input.path ? input.path : '.', policy.cwd, home);
    const spellings = (tool === 'read' ? readVariants(clean) : [clean]).map((sp) => real(sp));
    for (const abs of spellings) {
      const r = denied(abs, kinds, WALK_TOOLS.has(tool) && !NAME_WALKS.has(tool));
      if (r) return blocked(`${tool} of ${abs}${fold(r.root()) !== fold(abs) ? ` (rule on ${r.root()})` : ''}`);
      // find over a folder that holds a denied one would list names in it: asked, not refused.
      if (NAME_WALKS.has(tool) && denied(abs, kinds, true) && policy.mode !== 'bypassPermissions') return { action: 'ask' };
    }
    if (READ_TOOLS.has(tool)) return { action: 'allow' };
    if (policy.mode === 'plan') return blocked('changes in plan mode');
    if (policy.mode === 'bypassPermissions') return { action: 'allow' };
    if (policy.mode === 'acceptEdits' && inside(spellings[0])) return { action: 'allow' };
    return { action: 'ask' };
  }
  if (tool === 'bash') {
    const raw = String(input.command ?? '');
    const { cmd, code } = heredocs(raw);
    const hit = reachesDenied([cmd, ...code].flatMap((x) => shellWords(x, home)), rules, at);
    if (hit === 'too-long') return policy.mode === 'bypassPermissions' ? blocked(`a command with more than ${MAX_PATH_WORDS} path-like words (too long to check; split it)`) : { action: 'ask' };
    if (hit) return blocked(`a command that reaches ${hit}`);
    if (policy.mode === 'plan') return blocked('commands in plan mode');
    if (policy.mode === 'bypassPermissions') return { action: 'allow' };
    if (policy.mode === 'acceptEdits' && readOnly(raw, (w) => inside(at(w)))) return { action: 'allow' };
    return { action: 'ask' };
  }
  // A tool an extension or package added: nothing to check it against, so only bypass lets it run unasked.
  if (policy.mode === 'plan') return blocked(`${tool} in plan mode`);
  return policy.mode === 'bypassPermissions' ? { action: 'allow' } : { action: 'ask' };
}

/**
 * The denied root a command's words reach, if any. A command cannot be told apart as reading or
 * writing, so only Read rules (secrets, other profiles) are held against it; the launch files' Edit
 * rules stop the file tools, and the launch guard refuses the next start when one is gone. A path
 * glued to a short option (`-f/path`, `-d@/path`) is checked too; a glob stands for every name its
 * segments can match on the way down to a denied root.
 */
function reachesDenied(words: string[], rules: Rule[], at: (p: string) => string): string | 'too-long' | undefined {
  const reads = rules.filter((r) => r.tool === 'Read');
  const cands = new Set<string>();
  for (const w of words) {
    if (!/[/~.@]/.test(w)) continue;
    if (!w.startsWith('-')) { cands.add(w); continue; }
    // -X<value> and bundled short options (-rf/path): every tail after the option letters.
    const letters = /^-+([A-Za-z0-9]*)/.exec(w)![0].length;
    for (let k = 2; k <= letters; k++) if (/[/~.@]/.test(w.slice(k))) cands.add(w.slice(k));
  }
  if (cands.size > MAX_PATH_WORDS) return 'too-long';
  for (const w of cands) {
    const g = w.search(/[*?[{]/);
    if (g === -1) {
      const p = at(w);
      const hit = reads.find((r) => r.test(p));
      if (hit) return hit.root();
      continue;
    }
    // A glob: its fixed folder, then each segment tried against the names down to a denied root.
    const fixed = w.slice(0, w.slice(0, g).lastIndexOf('/') + 1);
    const base = at(fixed || '.');
    const pats = w.slice(fixed.length).split('/').filter(Boolean).map((x) => (x === '**' ? null : glob(fold(x))));
    for (const r of reads) {
      if (r.test(base)) return r.root();
      const names = below(r.root(), base);
      if (names && reaches(pats, names)) return r.root();
    }
  }
  return undefined;
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
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): PiPolicy | undefined {
  try {
    const p = JSON.parse(env.ANGELIA_PI_POLICY ?? '') as Partial<PiPolicy>;
    const strings = (x: unknown) => Array.isArray(x) && x.every((v) => typeof v === 'string');
    if (typeof p.cwd === 'string' && MODES.includes(p.mode as PiMode) && strings(p.dirs ?? []) && strings(p.deny ?? [])) return { mode: p.mode as PiMode, cwd: p.cwd, dirs: p.dirs ?? [], deny: p.deny ?? [] };
  } catch { /* fall through */ }
  return undefined;
}

export default function angeliaGate(pi: any): void {
  const policy = policyFromEnv();
  if (!policy) {
    // Loaded without a policy Angelia wrote: something is wrong, so nothing runs.
    pi.on('tool_call', async () => ({ block: true, reason: "Angelia's policy for this profile is missing, so no tool may run. Tell the owner." }));
    return;
  }
  // Plan mode already names its tools on argv (--tools); elsewhere the search tools are added to
  // whatever is active, so the owner's own extension tools stay as they are.
  if (policy.mode !== 'plan') pi.on('session_start', () => { try { pi.setActiveTools([...new Set([...pi.getActiveTools(), ...SEARCH_TOOLS])]); } catch { /* an older pi: the shell still works */ } });
  pi.on('tool_call', async (event: any, ctx: any) => {
    const input = (event.input ?? {}) as Record<string, unknown>;
    const v = decide(policy, String(event.toolName), input);
    if (v.action === 'block') return { block: true, reason: v.reason };
    if (v.action === 'ask') {
      const ok = await ctx.ui.confirm(`${PERMISSION_TITLE} ${event.toolName}`, JSON.stringify(input), { signal: ctx.signal });
      if (!ok) return { block: true, reason: 'The owner did not approve this (denied, or no answer in time). It did not run; say so, do not report it as done.' };
    }
    // event.input is mutable and what the tool runs with (pi docs, tool_call).
    if (event.toolName === 'bash') input.timeout = Math.min(typeof input.timeout === 'number' && input.timeout > 0 ? input.timeout : Infinity, BASH_TIMEOUT_S);
    return undefined;
  });
}
