import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * A profile's permission levels (schema.ts `permissions`): what Angelia does with a request the CLI
 * asks about. Each rule is a fixed pattern in Claude Code's own permission syntax, `Tool` or
 * `Tool(specifier)`, matched here in code, never judged by a model. The lists are checked in this
 * order, and the first list with a match decides: refuse, then ask, then approve; else the default.
 * Matching follows Claude Code's documented rules (code.claude.com/docs/en/permissions), and where
 * a case is open it leans the safe way: a refuse or ask rule matches more readily, an approve rule
 * less. See docs/reference.md, Permission levels.
 */
export type Level = 'refuse' | 'ask' | 'approve';
export interface PermissionPolicy { default: Level; refuse: string[]; ask: string[]; approve: string[] }

/** A request in Claude Code's naming: its tool and its input. A backend that cannot name one this way
 *  sends none, and then no rule can match (decide()). */
export interface ToolRequest { tool: string; input?: unknown }

export interface Decision { level: Level; /** The rule that decided, `refuse: Bash(rm *)`; none for the default. */ rule?: string; /** Set when the rules could not be checked on this request. */ unchecked?: true }

interface Ctx { cwd: string; home?: string }

type Rule =
  | { kind: 'tool'; tools: string[] }
  | { kind: 'bash'; body: string; tail: boolean }
  | { kind: 'path'; tools: string[]; glob: string; anchor: 'abs' | 'home' | 'root' | 'cwd' }
  | { kind: 'domain'; host: string }
  | { kind: 'mcp'; prefix: string; exact: boolean }
  | { kind: 'agent'; name: string };

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const AGENT_TOOLS = ['Agent', 'Task'];
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Parse a rule, or say why it cannot be one: the load refuses such a rule (schema.ts). */
export function parseRule(text: string): Rule | string {
  const s = text.trim();
  const m = /^([^()\s]+)(?:\((.*)\))?$/s.exec(s);
  if (!m) return `"${text}" is not a rule: write Tool or Tool(specifier), e.g. Bash(git push *)`;
  const [, tool, spec] = m;
  if (tool.startsWith('mcp__')) {
    if (spec !== undefined) return `"${text}": an MCP rule takes no parentheses; write mcp__server, mcp__server__tool or mcp__server__*`;
    const parts = tool.split('__');
    if (parts.length < 2 || !parts[1]) return `"${text}": an MCP rule names a server: mcp__server or mcp__server__tool`;
    if (parts.length === 2 || (parts.length === 3 && parts[2] === '*')) return { kind: 'mcp', prefix: `mcp__${parts[1]}__`, exact: false };
    if (tool.includes('*')) return `"${text}": only a whole server takes *, as mcp__server__*`;
    return { kind: 'mcp', prefix: tool, exact: true };
  }
  if (!TOOL_NAME.test(tool)) return `"${text}": "${tool}" is not a tool name`;
  const family = tool === 'Read' ? READ_TOOLS : tool === 'Edit' ? EDIT_TOOLS : AGENT_TOOLS.includes(tool) ? AGENT_TOOLS : [tool];
  if (spec !== undefined && !spec.trim()) return `"${text}": empty parentheses; write ${tool} alone to match all of its uses`;
  if (spec === undefined || spec.trim() === '*') return { kind: 'tool', tools: family };
  if (tool === 'Bash') {
    let p = spec.trim();
    if (p.endsWith(':*')) p = `${p.slice(0, -2)} *`;
    // `ls *` also matches a bare `ls`: the space and what follows are optional together.
    const tail = p.endsWith(' *');
    const body = tail ? p.slice(0, -2) : p;
    if ((body.match(/\*/g)?.length ?? 0) > MAX_STARS) return `"${text}": at most ${MAX_STARS} * in one rule`;
    return { kind: 'bash', body, tail };
  }
  if (tool === 'Read' || tool === 'Edit') {
    if (spec.startsWith('!')) return `"${text}": a negated path (!) is not supported here`;
    const anchor = spec.startsWith('//') ? 'abs' : spec === '~' || spec.startsWith('~/') ? 'home' : spec.startsWith('/') ? 'root' : 'cwd';
    const glob = anchor === 'abs' ? spec.slice(1) : anchor === 'home' ? spec.slice(1) : anchor === 'root' ? spec : spec.replace(/^\.\//, '');
    if (!glob || glob === '/') return { kind: 'path', tools: family, glob: '**', anchor: anchor === 'cwd' ? 'cwd' : anchor };
    return { kind: 'path', tools: family, glob: glob.replace(/^\//, ''), anchor };
  }
  if (tool === 'WebFetch') {
    const d = /^domain:(\S+)$/.exec(spec.trim());
    if (!d) return `"${text}": WebFetch takes domain:<host>, e.g. WebFetch(domain:example.com)`;
    return { kind: 'domain', host: d[1].toLowerCase().replace(/\.$/, '') };
  }
  if (AGENT_TOOLS.includes(tool)) return { kind: 'agent', name: spec.trim() };
  return `"${text}": Angelia cannot check a specifier on ${tool}; write the bare tool name (${tool}) to match all of its uses`;
}

function escape(s: string): string { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

/** gitignore-style glob to a regex over a path with no leading slash. */
function globRe(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slashAfter = glob[i + 2] === '/';
      out += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escape(c);
  }
  // A folder pattern (`x/` or a bare `x`) also covers what is inside it, as in gitignore.
  return new RegExp(`^${out.replace(/\/$/, '')}(?:/.*)?$`, 's');
}

const GLOB_CHAR = /[*?[\]{}]/;

/** A glob's leading folders with no wildcard in them, and the rest: `notes/**` is `notes` and `**`, so
 *  the folder itself matches too, and the folder can be resolved on disk. */
function splitGlob(glob: string): { dir: string; rest: string } {
  const segs = glob.split('/');
  let n = 0;
  while (n < segs.length && !GLOB_CHAR.test(segs[n])) n++;
  return { dir: segs.slice(0, n).join('/'), rest: segs.slice(n).join('/') };
}

/** The path as the disk resolves it: the deepest part that exists, symbolic links followed, and the
 *  rest as written. A link inside an approved folder that points out of it is matched where it points. */
function realish(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (let i = 0; i < 4096; i++) {
    try { return tail.length ? join(realpathSync(cur), ...tail) : realpathSync(cur); } catch { /* not there: one up */ }
    const up = dirname(cur);
    if (up === cur) return p;
    tail.unshift(basename(cur));
    cur = up;
  }
  return p;
}

/** Where a path rule is read from: the folder its relative form starts at. The profile's folder is
 *  both the CLI's working folder and its project root (the folder that holds .claude/). */
function base(anchor: 'abs' | 'home' | 'root' | 'cwd', ctx: Ctx): string {
  return anchor === 'abs' ? '/' : anchor === 'home' ? (ctx.home ?? homedir()) : ctx.cwd;
}

function expand(raw: string, home: string): string {
  return raw === '~' ? home : raw.startsWith('~/') ? `${home}${raw.slice(1)}` : raw;
}

/**
 * The paths a request touches, as absolute paths, or undefined when it names none the rules can read.
 * Every path field counts (NotebookEdit's notebook_path, a Grep or LS path). A Glob pattern counts by
 * its folders before the first wildcard, read from its `path`; for refuse and ask the whole pattern
 * with `..` taken out too. An approve rule never passes a pattern with `..` in it.
 */
function targetsOf(req: ToolRequest, ctx: Ctx, strict: boolean): string[] | undefined {
  const home = ctx.home ?? homedir();
  const o = req.input && typeof req.input === 'object' ? (req.input as Record<string, unknown>) : {};
  const raw: string[] = [];
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof o[k] === 'string' && o[k]) raw.push(o[k] as string);
  const from = typeof o.path === 'string' && o.path ? resolve(ctx.cwd, expand(o.path, home)) : ctx.cwd;
  if (req.tool === 'Glob' && typeof o.pattern === 'string' && o.pattern) {
    const pat = expand(o.pattern, home);
    // An approve never passes `..` or a brace (`{notes,/etc}/x` names two places).
    if (strict && (pat.split('/').includes('..') || pat.includes('{'))) return undefined;
    raw.push(resolve(from, splitGlob(pat).dir || '.'));
    if (!strict) raw.push(resolve(from, pat));
  }
  // Grep, Glob and LS with no path search the working folder.
  if (!raw.length && (req.tool === 'Grep' || req.tool === 'Glob' || req.tool === 'LS')) raw.push(ctx.cwd);
  return raw.length ? raw.map((x) => resolve(ctx.cwd, expand(x, home))) : undefined;
}

function matchPath(r: Extract<Rule, { kind: 'path' }>, req: ToolRequest, ctx: Ctx, strict: boolean): boolean {
  if (!r.tools.includes(req.tool)) return false;
  const targets = targetsOf(req, ctx, strict);
  if (!targets) return !strict;
  // Refuse and ask without regard to case (the usual macOS disk opens ~/.SSH/id as ~/.ssh/id), and by
  // the path as written or as the disk resolves it; approve only by where it resolves, every path.
  const fold = (x: string) => (strict ? x : x.toLowerCase());
  const one = (t: string) => {
    const fulls = strict ? [realish(t)] : [t, realish(t)];
    return fulls.some((full) => pathHit(r, fold(full), ctx, strict, fold));
  };
  return strict ? targets.every(one) : targets.some(one);
}

function relOf(full: string, from: string): string | undefined {
  if (from === '/') return full.slice(1);
  if (full === from) return '';
  return full.startsWith(`${from}/`) ? full.slice(from.length + 1) : undefined;
}

function pathHit(r: Extract<Rule, { kind: 'path' }>, full: string, ctx: Ctx, strict: boolean, fold: (x: string) => string): boolean {
  const b = base(r.anchor, ctx);
  const bases = (x: string) => (strict ? [fold(realish(x))] : [fold(x), fold(realish(x))]);
  const glob = fold(r.glob);
  // A pattern with no slash inside it (`.env`, `*.key`) matches at any depth, as in gitignore. A
  // relative refuse or ask rule (`secrets/**`) does too; an approve rule stays at the profile's folder.
  const deep = r.anchor === 'cwd' && (!glob.replace(/\/$/, '').includes('/') || !strict);
  if (deep) {
    const re = globRe(glob);
    for (const from of bases(b)) {
      const rel = relOf(full, from);
      const within = !strict ? full.split('/').filter(Boolean) : rel === undefined ? [] : rel.split('/').filter(Boolean);
      for (let i = 0; i < within.length; i++) if (re.test(within.slice(i).join('/'))) return true;
    }
    return false;
  }
  const { dir, rest } = splitGlob(glob.replace(/\/$/, ''));
  for (const from of bases(dir ? join(b, dir) : b)) {
    const rel = relOf(full, from);
    if (rel === undefined) continue;
    if (!rest || globRe(rest).test(rel)) return true;
  }
  return false;
}

// ---- Bash ----

/** Wildcards one shell rule may hold: the matcher's work grows with each. */
const MAX_STARS = 8;
/** Stands for one whitespace character in a pattern (the space before a trailing ` *`). */
const WS = '\u0000';

/** `*` matches anything, WS one whitespace character, all else itself. Linear in the text for each
 *  piece between stars (leftmost match of each piece, which is exact for a pattern with only `*`). */
function starMatch(pattern: string, s: string): boolean {
  const segs = pattern.split('*');
  const at = (seg: string, i: number) => {
    if (i + seg.length > s.length) return false;
    for (let j = 0; j < seg.length; j++) {
      const p = seg[j], c = s[i + j];
      if (p === WS ? !/\s/.test(c) : p !== c) return false;
    }
    return true;
  };
  const first = segs[0], last = segs[segs.length - 1];
  if (segs.length === 1) return s.length === first.length && at(first, 0);
  if (!at(first, 0)) return false;
  let pos = first.length;
  for (let k = 1; k < segs.length - 1; k++) {
    const seg = segs[k];
    let i = pos;
    for (; i + seg.length <= s.length; i++) if (at(seg, i)) break;
    if (i + seg.length > s.length) return false;
    pos = i + seg.length;
  }
  return s.length - last.length >= pos && at(last, s.length - last.length);
}

/** Does a shell rule match one simple command. `fold`: without regard to case. A trailing ` *` also
 *  takes the bare command: `ls *` matches `ls` and `ls -la`, not `lsof`. */
function shellMatch(r: Extract<Rule, { kind: 'bash' }>, cmd: string, fold: boolean): boolean {
  const body = fold ? r.body.toLowerCase() : r.body, s = fold ? cmd.toLowerCase() : cmd;
  return starMatch(body, s) || (r.tail && starMatch(`${body}${WS}*`, s));
}

/** decide() gives up past this: the answer is then never approve. */
const BUDGET_MS = 50;
let deadline = Infinity;
class OverBudget extends Error {}
function budget(): void { if (Date.now() > deadline) throw new OverBudget(); }


/** A command line longer than this is never approved by a rule, and every shell refuse or ask rule
 *  matches it: the matcher's work stays bounded whatever the agent sends. */
export const MAX_COMMAND = 8192;

/** Split a command line into its simple commands on the separators Claude Code names (&&, ||, ;, |,
 *  |&, &, newline), keeping quoted text whole. Also returns what `$(…)`, backticks and `( … )` hold,
 *  as more commands. For refuse and ask only: an approve rule reads a line through plainParts(). */
export function splitCommand(cmd: string): { parts: string[] } {
  budget();
  const parts: string[] = [];
  let cur = '', q: '"' | "'" | null = null;
  const push = () => { if (cur.trim()) parts.push(cur.trim()); cur = ''; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1];
    if (q) {
      if (c === '\\' && q === '"') { cur += c + (n ?? ''); i++; continue; }
      // Inside double quotes `$(…)` and backticks still run: what they hold is a command too.
      if (q === '"' && c === '$' && n === '(') {
        const end = closing(cmd, i + 1);
        parts.push(...splitCommand(cmd.slice(i + 2, end)).parts);
        cur += cmd.slice(i, end + 1); i = end; continue;
      }
      if (q === '"' && c === '`') {
        const end = cmd.indexOf('`', i + 1);
        parts.push(...splitCommand(end < 0 ? cmd.slice(i + 1) : cmd.slice(i + 1, end)).parts);
        cur += end < 0 ? cmd.slice(i) : cmd.slice(i, end + 1); i = end < 0 ? cmd.length : end; continue;
      }
      if (c === q) q = null;
      cur += c; continue;
    }
    if (c === '\\') { cur += c + (n ?? ''); i++; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '$' && n === '(') {
      const end = closing(cmd, i + 1);
      parts.push(...splitCommand(cmd.slice(i + 2, end)).parts);
      cur += cmd.slice(i, end + 1); i = end; continue;
    }
    if (c === '`') {
      const end = cmd.indexOf('`', i + 1);
      parts.push(...splitCommand(end < 0 ? cmd.slice(i + 1) : cmd.slice(i + 1, end)).parts);
      cur += end < 0 ? cmd.slice(i) : cmd.slice(i, end + 1); i = end < 0 ? cmd.length : end; continue;
    }
    if (c === '(' && !cur.trim()) {
      const end = closing(cmd, i);
      parts.push(...splitCommand(cmd.slice(i + 1, end)).parts);
      i = end; continue;
    }
    if (c === '\n' || c === '\r' || c === ';') { push(); continue; }
    if (c === '&' && n === '&') { push(); i++; continue; }
    if (c === '|' && (n === '|' || n === '&')) { push(); i++; continue; }
    if (c === '|') { push(); continue; }
    if (c === '&' && cmd[i - 1] !== '>' && n !== '>') { push(); continue; }
    cur += c;
  }
  push();
  return { parts };
}

function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return s.length;
}

/** What an approve rule may read in a shell line: plain words and quoted strings with no $ ` or \ in
 *  them, split on &&, || and | only. */
const PLAIN = /[A-Za-z0-9_./:@%+=,~-]/;

/**
 * The simple commands of a line, if every one is plain: words of [A-Za-z0-9_./:@%+=,~-] or quoted
 * strings with no `$`, backtick, backslash or control character inside, joined by &&, || or |. Any
 * other character outside quotes (; & < > # ( ) { } * ? [ ] ! a newline, a tab, a backslash, a
 * letter outside ASCII) makes it not plain: an approve rule then never matches, and the line is asked.
 * That is what keeps a comment, a redirection, a glob qualifier or a `=(…)` from riding on an approve.
 */
export function plainParts(cmd: string): string[] | undefined {
  if (cmd.length > MAX_COMMAND) return undefined;
  const parts: string[] = [];
  let words: string[] = [], w = '', inWord = false;
  const endWord = () => { if (inWord) words.push(w); w = ''; inWord = false; };
  const endPart = () => { endWord(); if (!words.length) return false; parts.push(words.join(' ')); words = []; return true; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === ' ') { endWord(); continue; }
    if (c === "'" || c === '"') {
      const end = cmd.indexOf(c, i + 1);
      if (end < 0) return undefined;
      // eslint-disable-next-line no-control-regex
      if (/[$`\\\x00-\x1f\x7f]/.test(cmd.slice(i + 1, end))) return undefined;
      w += cmd.slice(i, end + 1); inWord = true; i = end; continue;
    }
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) { if (!endPart()) return undefined; i++; continue; }
    if (c === '|') { if (!endPart()) return undefined; continue; }
    // zsh reads a word that starts with `=` as a path search (`=ls`) and `=(…)` as a command.
    if (c === '=' && !inWord) return undefined;
    if (PLAIN.test(c)) { w += c; inWord = true; continue; }
    return undefined;
  }
  return endPart() ? parts : undefined;
}

/** Taken off the front of a plain command before an approve rule reads it: they run what follows. */
const PLAIN_WRAPPERS = new Set(['time', 'nohup', 'command', 'builtin', 'noglob', 'exec']);

/** A plain command as an approve rule reads it, or undefined if it starts with `NAME=value`. */
function plainCommand(part: string): string | undefined {
  const words = part.split(' ');
  for (let guard = 0; guard < 8 && words.length > 1; guard++) {
    if (PLAIN_WRAPPERS.has(words[0])) words.shift();
    else if (words[0] === 'timeout' && words.length > 2 && /^\d+(?:\.\d+)?[smhd]?$/.test(words[1])) words.splice(0, 2);
    else if (words[0] === 'nice' && words[1] === '-n' && words.length > 3 && /^-?\d+$/.test(words[2])) words.splice(0, 3);
    else break;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return undefined;
  // git's -c, --config-env and --exec-path can name a program for git to run (core.pager, an alias):
  // a git approve rule never covers them.
  if (words[0] === 'git') {
    for (let i = 1; i < words.length && words[i].startsWith('-'); i++) {
      if (/^(?:-c|--config-env|--exec-path)(?:=|$)/.test(words[i])) return undefined;
      if (words[i] === '-C') i++;
    }
  }
  return words.join(' ');
}

/** Replace until nothing changes: a pattern that cannot eat the last word stops, never loops. */
function eat(s: string, re: RegExp): string {
  for (let guard = 0; guard < 64; guard++) {
    const next = s.replace(re, '');
    if (next === s) return s;
    s = next;
  }
  return s;
}

const WRAPPERS = new Set(['time', 'nohup', 'command', 'builtin', 'noglob', 'exec', 'sudo', 'doas', '{', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);

/** The command a wrapper or a shell keyword runs (`timeout 30 x`, `sudo -u root x`, `{ x; }`, `then
 *  x`, `xargs -n1 x`, …), past any leading `NAME=value`. For refuse and ask. */
function unwrap(part: string): string {
  let s = part.trim();
  for (let guard = 0; guard < 20; guard++) {
    const assign = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"])*\s+/.exec(s);
    if (assign) { s = s.slice(assign[0].length); continue; }
    const w = /^(\S+)\s+/.exec(s);
    if (!w) break;
    const word = w[1];
    let rest = s.slice(w[0].length);
    if (WRAPPERS.has(word) && !['sudo', 'doas'].includes(word)) { s = rest; continue; }
    if (word === 'env' || word === 'sudo' || word === 'doas') { s = eat(rest, /^(?:-[uUgCDph]\s+\S+|-\S+)\s+/); continue; }
    if (word === 'timeout') {
      rest = eat(rest, /^(?:-[sk]\s+\S+|--\S+|-\S+)\s+/);
      s = rest.replace(/^\S+\s+/, ''); // the duration
      continue;
    }
    if (word === 'nice') { s = eat(rest, /^(?:-n\s+\S+|-\d+|--adjustment=\S+|-\S+)\s+/); continue; }
    if (word === 'stdbuf') { s = eat(rest, /^(?:-[ioe]\s*\S+|--\S+)\s+/); continue; }
    if (word === 'xargs') { s = eat(rest, /^(?:-[nILPsdEa]\s*\S+|--\S+|-\S+)\s+/); continue; }
    break;
  }
  return s.replace(/\s+/g, ' ');
}

/** `bash -c '…'`, `sh -lc "…"`, `zsh -c …`: the script inside, as more commands. */
function shellScript(part: string): string | undefined {
  const m = /^(?:\/\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(?:'([^']*)'|"((?:\\.|[^"\\])*)")\s*$/s.exec(part.trim());
  return m ? (m[1] ?? m[2].replace(/\\(.)/g, '$1')) : undefined;
}

function commandOf(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string') return (input as { command: string }).command;
  return undefined;
}

/** git's own options before its subcommand (`git -C dir push`, `git -c x=y push`): taken off. */
const GIT_OPTS = /^git\s+(?:(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)(?:=\S+|\s+\S+)|-[pP]|--\S+)\s+)+/;

/**
 * Each simple command a line may run, for refuse and ask, read several ways and every reading kept: the
 * split above, a plain split on every separator and comment mark whatever the quotes (so a quote in a
 * comment hides nothing), with quotes and backslashes taken out of each (`\rm`, `"rm"`, `r''m`), past
 * wrappers and shell keywords, inside a shell -c, eval, `find -exec` and `xargs`, and git past its own
 * options. Best effort by nature: a variable (`X=rm; $X x`) or another language (`python -c`) is not
 * seen. A hard limit belongs in the profile's deny rules or the sandbox.
 */
function allCommands(cmd: string, depth = 0): string[] {
  const out = new Set<string>();
  const pieces = cmd.split(/&&|\|\||[;|&\n\r#{}()`]|\$\(/).map((x) => x.trim()).filter(Boolean);
  for (const p of [...splitCommand(cmd).parts, ...pieces]) {
    budget();
    for (const form of new Set([p, p.replace(/['"\\]/g, '')])) {
      const u = unwrap(form);
      out.add(form); out.add(u);
      // `/bin/rm x` runs rm as surely as `rm x` does.
      const bare = u.replace(/^\/\S*\//, '');
      out.add(bare);
      const g = GIT_OPTS.exec(bare);
      if (g) out.add(`git ${bare.slice(g[0].length)}`);
      for (const x of bare.split(/\s-(?:exec|execdir|ok|okdir)\s+/).slice(1)) out.add(unwrap(x));
      if (depth < 3) {
        const ev = /^eval\s+(.*)$/s.exec(bare);
        if (ev) for (const c of allCommands(ev[1].replace(/^(['"])(.*)\1$/s, '$2'), depth + 1)) out.add(c);
        const inner = shellScript(u);
        if (inner !== undefined) for (const c of allCommands(inner, depth + 1)) out.add(c);
      }
    }
  }
  return [...out];
}

/** Whether a plain command matches one shell approve rule, a shell -c script part by part too. */
function approvedPart(r: Extract<Rule, { kind: 'bash' }>, part: string, depth = 0): boolean {
  budget();
  const u = plainCommand(part);
  if (u === undefined) return false;
  if (shellMatch(r, u, false)) return true;
  const inner = shellScript(u);
  if (inner === undefined || depth >= 3) return false;
  const sub = plainParts(inner);
  return !!sub && sub.every((x) => approvedPart(r, x, depth + 1));
}

/** Does one rule match this request. `strict` is for an approve rule: an unclear case is no match. */
export function matches(rule: Rule, req: ToolRequest, ctx: Ctx, strict: boolean): boolean {
  switch (rule.kind) {
    case 'tool': return rule.tools.includes(req.tool);
    // A whole-server approve takes only a tool name with no more `__` in it: `mcp__a` does not approve
    // `mcp__a__b__c`, which may be a tool of a server named `a__b`.
    case 'mcp': return rule.exact ? req.tool === rule.prefix : req.tool.startsWith(rule.prefix) && (!strict || !req.tool.slice(rule.prefix.length).includes('__'));
    case 'agent': {
      if (!AGENT_TOOLS.includes(req.tool)) return false;
      const t = (req.input as { subagent_type?: unknown } | undefined)?.subagent_type;
      return typeof t === 'string' ? t === rule.name : !strict;
    }
    case 'domain': {
      if (req.tool !== 'WebFetch') return false;
      const url = (req.input as { url?: unknown } | undefined)?.url;
      let host: string;
      // A trailing dot names the same host: `evil.com.` is `evil.com`.
      try { host = new URL(String(url)).hostname.toLowerCase().replace(/\.$/, ''); } catch { return !strict; }
      if (rule.host === '*') return true;
      if (rule.host.startsWith('*.')) return host.endsWith(rule.host.slice(1));
      // Refuse and ask take the host's subdomains too.
      return host === rule.host || (!strict && host.endsWith(`.${rule.host}`));
    }
    case 'path': return matchPath(rule, req, ctx, strict);
    case 'bash': {
      if (req.tool !== 'Bash') return false;
      const cmd = commandOf(req.input);
      if (cmd === undefined) return !strict;
      if (strict) { const parts = plainParts(cmd); return !!parts && parts.every((p) => approvedPart(rule, p)); }
      if (cmd.length > MAX_COMMAND) return true;
      // Without regard to case: on the usual macOS disk `RM x` runs rm.
      return allCommands(cmd).some((c) => { budget(); return shellMatch(rule, c, true); });
    }
  }
}

/**
 * What to do with one request. With no request in Claude Code's naming (a backend that cannot give
 * one, or a dialog read off a screen), no rule can be checked: the default holds, except that a
 * default of approve becomes ask when there are refuse or ask rules, which might have matched.
 */
export function decide(policy: PermissionPolicy, req: ToolRequest | undefined, ctx: Ctx): Decision {
  deadline = Date.now() + BUDGET_MS;
  try { return decideIn(policy, req, ctx); } catch (e) {
    if (!(e instanceof OverBudget)) throw e;
    // Too long to read in time: never approved. A refuse default stays a refusal.
    return { level: policy.default === 'refuse' ? 'refuse' : 'ask', unchecked: true };
  } finally { deadline = Infinity; }
}

function decideIn(policy: PermissionPolicy, req: ToolRequest | undefined, ctx: Ctx): Decision {
  if (!req) {
    if (policy.default === 'approve' && (policy.refuse.length || policy.ask.length)) return { level: 'ask', unchecked: true };
    return { level: policy.default, ...(policy.refuse.length || policy.ask.length || policy.approve.length ? { unchecked: true as const } : {}) };
  }
  for (const level of ['refuse', 'ask', 'approve'] as const) {
    for (const text of policy[level]) {
      const r = parseRule(text);
      if (typeof r === 'string') continue; // refused at load; never here
      budget();
      if (matches(r, req, ctx, level === 'approve')) return { level, rule: `${level}: ${text}` };
    }
  }
  // A plain pipeline or && list whose every part one approve rule or another names: `git log | head`
  // with Bash(git log *) and Bash(head *).
  const cmd = req.tool === 'Bash' ? commandOf(req.input) : undefined;
  const parts = cmd === undefined ? undefined : plainParts(cmd);
  if (parts && parts.length > 1) {
    const shell = policy.approve.flatMap((text) => { const r = parseRule(text); return typeof r !== 'string' && r.kind === 'bash' ? [{ text, r }] : []; });
    const used = parts.map((p) => shell.find((x) => approvedPart(x.r, p)));
    if (used.every(Boolean)) return { level: 'approve', rule: `approve: ${[...new Set(used.map((x) => x!.text))].join(' + ')}` };
  }
  return { level: policy.default };
}

/** Which kinds of rule a backend's requests can be checked against (see each brain's `request`). */
export function checkable(backend: string, text: string): boolean {
  const r = parseRule(text);
  if (typeof r === 'string') return false;
  if (backend === 'claude-code') return true; // print mode and the tmux hook both carry the tool and its input
  if (backend === 'pi') return r.kind === 'bash' || r.kind === 'path' || (r.kind === 'tool' && r.tools.some((t) => ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'].includes(t)));
  if (backend === 'codex' || backend === 'grok') return r.kind === 'bash' || (r.kind === 'tool' && r.tools.includes('Bash'));
  return false;
}
