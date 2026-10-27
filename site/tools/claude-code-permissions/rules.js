// The Claude Code permissions builder: the choices a visitor ticks into a `.claude/settings.json`.
// Plain JavaScript, no build step: the page loads this file as a module, and tests/site-tools.test.ts
// imports it. Rule syntax as https://code.claude.com/docs/en/permissions documents it (checked
// 2026-10-27): `Tool` or `Tool(specifier)`, evaluated deny, then ask, then allow; path rules use
// gitignore patterns, where `~/` is the home folder, `//` the disk root and a single `/` the project.

export const SCHEMA = 'https://json.schemastore.org/claude-code-settings.json';

/** `permissions.defaultMode` values that take effect from a project's settings. `auto` and
 *  `bypassPermissions` do not (the docs: set those in ~/.claude/settings.json), so they are not offered. */
export const MODES = ['default', 'acceptEdits', 'plan', 'dontAsk'];

/** A file or folder pattern denied to the file tools both ways. A Read deny also stops Edit and Write
 *  on the path, but not NotebookEdit, so both rules are written. */
const both = (...paths) => paths.flatMap((p) => [`Read(${p})`, `Edit(${p})`]);

/** Every tick box: where its rules go and what they are. The ids are the form's values. */
export const PRESETS = [
  { id: 'edit', list: 'allow', label: 'Edit files in the project folder', rules: ['Edit(./**)'] },
  { id: 'npm', list: 'allow', label: 'Run npm scripts and tests', rules: ['Bash(npm run *)', 'Bash(npm test *)'] },
  { id: 'git-commit', list: 'allow', label: 'Stage and commit with git', rules: ['Bash(git add *)', 'Bash(git commit *)'] },
  { id: 'web-search', list: 'allow', label: 'Search the web', rules: ['WebSearch'] },
  { id: 'web-fetch', list: 'allow', label: 'Fetch any web page', rules: ['WebFetch'] },

  { id: 'git-push', list: 'ask', label: 'Push with git', rules: ['Bash(git push *)'] },
  { id: 'publish', list: 'ask', label: 'Publish a package', rules: ['Bash(npm publish *)'] },
  { id: 'rm', list: 'ask', label: 'Delete files with rm', rules: ['Bash(rm *)'] },

  { id: 'env', list: 'deny', label: '.env files, at any depth', rules: both('.env', '.env.*') },
  { id: 'secrets', list: 'deny', label: 'Folders named secrets, at any depth', rules: both('secrets/**') },
  { id: 'keys', list: 'deny', label: 'Key and certificate files (.pem, .key)', rules: both('*.pem', '*.key') },
  { id: 'ssh', list: 'deny', label: 'SSH keys (~/.ssh)', rules: both('~/.ssh/**') },
  { id: 'cloud', list: 'deny', label: 'Cloud logins (~/.aws, ~/.config/gcloud, ~/.kube)', rules: both('~/.aws/**', '~/.config/gcloud/**', '~/.kube/**') },
  { id: 'tokens', list: 'deny', label: 'Token files (~/.netrc, ~/.npmrc, ~/.git-credentials, ~/.config/gh)', rules: both('~/.netrc', '~/.npmrc', '~/.git-credentials', '~/.config/gh/**') },
  { id: 'history', list: 'deny', label: 'Shell history', rules: both('~/.zsh_history', '~/.bash_history') },
  { id: 'transcripts', list: 'deny', label: 'Claude Code transcripts of all your sessions', rules: both('~/.claude/projects/**', '~/.claude/history.jsonl') },
  { id: 'sudo', list: 'deny', label: 'sudo', rules: ['Bash(sudo *)'] },
  { id: 'force-push', list: 'deny', label: 'Force push', rules: ['Bash(git push --force *)', 'Bash(git push -f *)'] },
  { id: 'curl', list: 'deny', label: 'curl and wget', rules: ['Bash(curl *)', 'Bash(wget *)'] },
  { id: 'no-fetch', list: 'deny', label: 'Every web fetch', rules: ['WebFetch'] },
  { id: 'no-mcp', list: 'deny', label: 'Every MCP server', rules: ['mcp__*'] },
];

/** What the page starts with: a careful setup for a project, and the example printed in its HTML. */
export const DEFAULTS = {
  mode: '',
  presets: ['npm', 'git-commit', 'web-search', 'git-push', 'publish', 'env', 'secrets', 'keys', 'ssh', 'cloud', 'tokens', 'history', 'sudo', 'force-push'],
  commands: { allow: [], ask: [], deny: [] },
  domains: [], mcp: [], denyPaths: [], dirs: [],
  disableBypass: false, blockOutside: false,
};

/** Tool names a typed line may already start with; anything else is a shell command. */
const TOOL = /^(Bash|Read|Edit|Write|WebFetch|WebSearch|Agent|Skill|Glob|Grep|NotebookEdit|PowerShell|mcp__[\w*-]+)(\(.*\))?$/s;
/** Programs that run whatever follows them, so `npx *` allows any command (the docs' wrapper list). */
const RUNNERS = /^(npx|bunx|pnpm dlx|docker exec|devbox run|mise exec|direnv exec|sh -c|bash -c|zsh -c|env|xargs)\b/;

const lines = (text) => (Array.isArray(text) ? text : String(text ?? '').split('\n')).map((s) => s.trim()).filter(Boolean);

/** Path rules for Write, NotebookEdit and Glob are accepted and never match (the docs): Claude Code checks
 *  file paths against Edit and Read rules only, so such a rule is written as its Edit or Read twin. */
const PATH_TWIN = { Write: 'Edit', NotebookEdit: 'Edit', Glob: 'Read' };
const NEVER_MATCHES = /^(Write|NotebookEdit|Glob)\((.*)\)$/s;

/** A typed command line as a rule: `npm run build` becomes `Bash(npm run build)`; a full rule stays,
 *  but for a path rule that would never match. */
export function commandRule(line) {
  const t = line.replace(/^\$\s+/, '').trim();
  if (!TOOL.test(t)) return `Bash(${t})`;
  const m = NEVER_MATCHES.exec(t);
  return m ? `${PATH_TWIN[m[1]]}(${m[2]})` : t;
}

/** The host of a typed domain or URL: `https://docs.python.org/3/` is `docs.python.org`. */
export function domainOf(text) {
  const t = text.trim().replace(/^domain:/, '');
  try { return new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`).hostname.replace(/\.$/, '') || undefined; } catch { return undefined; }
}

/** An MCP server's name as it appears in its tool names: `.` and spaces become `_` (the docs). */
export const mcpName = (name) => name.trim().replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * The settings file for a set of choices: `{ settings, warnings }`. `settings` is the object to write
 * as `.claude/settings.json`; `warnings` are plain sentences about rules that match more, or less,
 * than they seem to.
 */
export function buildSettings(choices = DEFAULTS) {
  const c = { ...DEFAULTS, ...choices, commands: { ...DEFAULTS.commands, ...(choices.commands ?? {}) } };
  const lists = { allow: [], ask: [], deny: [] };
  const warnings = [];
  const add = (list, rule) => { if (!lists[list].includes(rule)) lists[list].push(rule); };
  const picked = new Set(c.presets);
  for (const p of PRESETS) if (picked.has(p.id)) for (const r of p.rules) add(p.list, r);

  for (const list of ['allow', 'ask', 'deny']) {
    for (const line of lines(c.commands[list])) {
      const rule = commandRule(line);
      add(list, rule);
      if (NEVER_MATCHES.test(line.trim())) warnings.push(`${line.trim()} would never match: Claude Code checks file paths against Edit and Read rules only. It is written as ${rule}.`);
      const inner = /^Bash\((.*)\)$/s.exec(rule)?.[1];
      if (list !== 'allow' || inner === undefined) continue;
      if (/^\S+ \*$/.test(inner) || inner === '*') warnings.push(`${rule} allows every ${inner === '*' ? '' : inner.split(' ')[0] + ' '}command. Put the * after the subcommand, as in Bash(git log *).`);
      else if (/\*(?!$)/.test(inner.replace(/ \*$/, '').replace(/:\*$/, ''))) warnings.push(`${rule} has a * before the end. It matches any text in that place, options included.`);
      if (RUNNERS.test(inner) && inner.includes('*')) warnings.push(`${rule}: ${RUNNERS.exec(inner)[1]} runs the command that follows it, so this allows any command. Write one rule per command instead.`);
    }
  }

  for (const d of lines(c.domains)) {
    const host = domainOf(d);
    if (host) add('allow', `WebFetch(domain:${host})`);
    else warnings.push(`"${d}" is not a domain; it was left out.`);
  }
  for (const m of lines(c.mcp)) {
    const name = mcpName(m);
    if (!name.replace(/_/g, '')) { warnings.push(`"${m}" is not an MCP server name; it was left out.`); continue; }
    if (name !== m) warnings.push(`The MCP server "${m}" appears in tool names as ${name}, so the rule uses that.`);
    add('allow', `mcp__${name}__*`);
  }
  for (const line of lines(c.denyPaths)) {
    const p = line.replace(/^(Read|Edit|Write|NotebookEdit|Glob)\((.*)\)$/s, '$2');
    if (/^!(\/|~\/)/.test(p)) warnings.push(`${p}: Claude Code reads a ! pattern from the current folder, so it cannot reopen a path under a ~/, / or // rule.`);
    if (/^\/[^/]/.test(p)) warnings.push(`${p} starts with one slash, so it means that path inside the project folder. For a path from the disk root, write //${p.slice(1)}.`);
    for (const r of both(p)) add('deny', r);
  }

  for (const r of lists.allow) {
    if (lists.deny.includes(r)) warnings.push(`${r} is in both allow and deny. Deny wins, so it is blocked.`);
    else if (lists.ask.includes(r)) warnings.push(`${r} is in both allow and ask. Ask wins, so Claude Code asks first.`);
  }
  if (lists.deny.includes('mcp__*') && lists.allow.some((r) => r.startsWith('mcp__'))) warnings.push('mcp__* in deny blocks every MCP server, the ones you allowed too.');
  if (lists.deny.includes('WebFetch') && lists.allow.some((r) => r.startsWith('WebFetch'))) warnings.push('WebFetch in deny removes the tool, so the allowed domains do nothing.');
  if (c.blockOutside && lines(c.dirs).length) warnings.push('Folders listed here in a project file do not count as working folders for blockReadsOutsideWorkingDirectories, so the file tools refuse reads in them. Add those folders in ~/.claude/settings.json or with --add-dir instead.');
  if (c.mode === 'dontAsk' && !lists.allow.length) warnings.push('dontAsk with no allow rules: Claude Code refuses every tool call that would ask, so it can only read.');

  const permissions = {};
  for (const list of ['allow', 'ask', 'deny']) if (lists[list].length) permissions[list] = lists[list];
  const dirs = lines(c.dirs);
  if (dirs.length) permissions.additionalDirectories = [...new Set(dirs)];
  if (c.mode) {
    if (!MODES.includes(c.mode)) throw new Error(`unknown permission mode: ${c.mode}`);
    permissions.defaultMode = c.mode;
  }
  if (c.disableBypass) permissions.disableBypassPermissionsMode = 'disable';
  if (c.blockOutside) permissions.blockReadsOutsideWorkingDirectories = true;
  return { settings: { $schema: SCHEMA, permissions }, warnings };
}

/** The file's text, as the page shows it and a test reads it from the page. */
export const settingsText = (settings) => JSON.stringify(settings, null, 2) + '\n';
