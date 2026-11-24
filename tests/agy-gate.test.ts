import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { AgyBrain, AGY_LOST_SUBAGENT_LINE, AGY_PTY, AGY_TOKEN, agyGate, agySeedLogin, agyMcpName, agyMode, agyPolicy, agySandboxProfile, mcpDenied } from '../src/brain/agy.js';
import { agyRequest } from '../src/brain/tool-request.js';
import { checkable } from '../src/core/permission-rules.js';
import { SANDBOX_EXEC, sandboxProfile, type PiPolicy } from '../src/brain/pi-gate.js';
import { tmuxSocketPath } from '../src/brain/tmux.js';
import type { Profile } from '../src/instance/config/schema.js';
import type { BrainEvent } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
// A sandboxed fake agy must not get the owner's real sign-in copied into a scratch folder.
AgyBrain.readLogin = () => undefined;
const FAKE_AGY = join(here, 'fake-agy.mjs');
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'angelia-agy-gate-')));
const darwin = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);

/** A workspace with a secret and a note, and a policy over it. */
function ws() {
  const dir = scratch();
  writeFileSync(join(dir, 'secret.txt'), 'SECRET\n');
  writeFileSync(join(dir, 'notes.txt'), 'hello\n');
  return dir;
}
const policy = (dir: string, mode: PiPolicy['mode'], o: Partial<PiPolicy> = {}): PiPolicy =>
  ({ mode, cwd: dir, dirs: [], deny: [`Read(${dir}/secret.txt)`, 'mcp__bad', 'mcp__half__drop'], sandbox: true, ...o });
const tc = (name: string, rawInput: Record<string, unknown> = {}) => ({ toolCallId: 'c1', name, rawInput, kind: 'other' });
const blockOf = (v: unknown) => (typeof v === 'object' && v ? (v as { reason: string }).reason : String(v));

test('agyGate: read_file is read: a denied file is blocked with the rule named, others allowed in every mode', () => {
  const d = ws();
  for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const) {
    assert.match(blockOf(agyGate(policy(d, mode), tc('read_file', { Path: join(d, 'secret.txt') }))), new RegExp(`^Angelia's profile rules deny read of ${d}/secret\\.txt$`), mode);
    assert.equal(agyGate(policy(d, mode), tc('read_file', { Path: join(d, 'notes.txt') })), 'allow', mode);
  }
  // Another case of the same name is the same file on macOS's disk.
  if (process.platform === 'darwin') assert.notEqual(agyGate(policy(d, 'bypassPermissions'), tc('read_file', { Path: join(d, 'SECRET.txt') })), 'allow');
});

test('agyGate: write_file and edit_file by mode; a denied file is blocked; plan blocks every edit', () => {
  const d = ws();
  const w = (mode: PiPolicy['mode'], path: string, name = 'write_file') => agyGate(policy(d, mode), tc(name, { Path: path }));
  assert.equal(w('default', join(d, 'new.txt')), 'ask');
  assert.equal(w('acceptEdits', join(d, 'new.txt')), 'allow');
  assert.equal(w('acceptEdits', '/etc/outside.txt'), 'ask');
  assert.equal(w('bypassPermissions', join(d, 'new.txt')), 'allow');
  assert.match(blockOf(w('bypassPermissions', '/etc/outside.txt')), /^In bypass, agy writes without asking only in the profile's folders/);
  assert.equal(w('bypassPermissions', '/etc/outside.txt'.replace('/etc', d)), 'allow');
  assert.match(blockOf(w('plan', join(d, 'new.txt'))), /deny changes in plan mode$/);
  assert.match(blockOf(w('plan', join(d, 'new.txt'), 'edit_file')), /deny changes in plan mode$/);
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) assert.match(blockOf(w(mode, join(d, 'secret.txt'), 'edit_file')), /deny edit of .*secret\.txt$/, mode);
  // A request with no name, or call_mcp_tool without its names, is never allowed unasked; bypass refuses it.
  for (const t of [tc(''), tc('call_mcp_tool', { ServerName: 'bad' }), tc('call_mcp_tool', { ServerName: 1, ToolName: 'go' })]) {
    assert.equal(agyGate(policy(d, 'default'), t), 'ask');
    assert.equal(agyGate(policy(d, 'acceptEdits'), t), 'ask');
    assert.match(blockOf(agyGate(policy(d, 'plan'), t)), /plan mode/);
    assert.match(blockOf(agyGate(policy(d, 'bypassPermissions'), t)), /cannot tell which tool .* so bypass does not allow it/);
  }
  assert.match(blockOf(agyGate(policy(d, 'bypassPermissions'), tc('call_mcp_tool', { ServerName: 'bad', ToolName: 'go' }))), /rule mcp__bad/);
  // A write that names no path is never placed: asked (blocked in plan).
  assert.equal(agyGate(policy(d, 'acceptEdits'), tc('write_file', {})), 'ask');
  assert.match(blockOf(agyGate(policy(d, 'plan'), tc('write_file', {}))), /plan mode/);
  // sandbox: false lets bypass write anywhere, as pi does.
  assert.equal(agyGate(policy(d, 'bypassPermissions', { sandbox: false }), tc('write_file', { Path: '/etc/outside.txt' })), 'allow');
});

test('agyGate: run_command is bash: asked, plain read-only in acceptEdits runs, plan blocks, bypass runs', () => {
  const d = ws();
  const c = (mode: PiPolicy['mode'], cmd: string) => agyGate(policy(d, mode), tc('run_command', { CommandLine: cmd }));
  assert.equal(c('default', 'ls'), 'ask');
  assert.equal(c('acceptEdits', 'ls'), 'allow');
  assert.equal(c('acceptEdits', 'cat notes.txt'), 'allow');
  assert.equal(c('acceptEdits', 'cat secret.txt'), 'ask', 'a read-only command on a denied file is not run unasked');
  assert.equal(c('acceptEdits', 'rm notes.txt'), 'ask');
  assert.match(blockOf(c('plan', 'ls')), /deny commands in plan mode$/);
  assert.equal(c('bypassPermissions', 'rm -rf x'), 'allow');
});

test('agyGate: a Bash(...) deny rule blocks the command in every mode, bypass too, also inside a list or in capitals', () => {
  const d = ws();
  const pol = (mode: PiPolicy['mode']) => policy(d, mode, { deny: ['Bash(rm *)', 'Bash(git push:*)'] });
  const c = (mode: PiPolicy['mode'], cmd: string) => agyGate(pol(mode), tc('run_command', { CommandLine: cmd }));
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) assert.match(blockOf(c(mode, 'rm keep.txt')), /deny this command \(rule Bash\(rm \*\)\)$/, mode);
  assert.match(blockOf(c('default', 'echo hi && RM -f x')), /rule Bash\(rm \*\)/);
  assert.match(blockOf(c('default', 'git push origin main')), /rule Bash\(git push:\*\)/);
  assert.equal(c('default', 'echo rm'), 'ask');
  assert.equal(c('bypassPermissions', 'ls'), 'allow');
  assert.match(blockOf(agyGate(policy(d, 'default', { deny: ['Bash'] }), tc('run_command', { CommandLine: 'ls' }))), /rule Bash\)$/);
});

test('agyGate: MCP tools by their mcp__ name; a deny rule blocks in every mode; other tools asked, plan blocks', () => {
  const d = ws();
  const g = (mode: PiPolicy['mode'], name: string, raw: Record<string, unknown> = {}, servers: string[] = []) => agyGate(policy(d, mode), tc(name, raw), servers);
  assert.equal(g('default', 'mcp_echo_say'), 'ask');
  assert.equal(g('acceptEdits', 'mcp_echo_say'), 'ask');
  assert.equal(g('bypassPermissions', 'mcp_echo_say'), 'allow');
  assert.match(blockOf(g('plan', 'mcp_echo_say')), /deny mcp__echo__say in plan mode$/);
  for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const) {
    assert.equal(blockOf(g(mode, 'mcp_bad_x')), "Angelia's profile rules deny mcp__bad__x (rule mcp__bad)", mode);
    assert.equal(blockOf(g(mode, 'call_mcp_tool', { ServerName: 'bad', ToolName: 'y', Arguments: {} })), "Angelia's profile rules deny mcp__bad__y (rule mcp__bad)", mode);
  }
  assert.match(blockOf(g('bypassPermissions', 'mcp_half_drop')), /rule mcp__half__drop/);
  assert.equal(g('bypassPermissions', 'mcp_half_keep'), 'allow');
  // A server whose name has `_` in it is read whole when the profile lists it.
  assert.equal(g('default', 'mcp_bad_x_go', {}, ['bad_x']), 'ask', 'mcp__bad_x__… is another server than mcp__bad');
  assert.equal(g('default', 'call_mcp_tool', { ServerName: 'echo', ToolName: 'say' }), 'ask');
  // Anything else: asked; plan blocks it; bypass runs it.
  assert.equal(g('default', 'invoke_subagent'), 'ask');
  assert.equal(g('acceptEdits', 'ask_question'), 'ask');
  assert.match(blockOf(g('plan', 'invoke_subagent')), /deny agy:invoke_subagent in plan mode$/);
  assert.equal(g('bypassPermissions', 'swarm'), 'allow');
  // An agy tool that happens to be named like one of pi's is never read as it.
  assert.equal(g('default', 'read', { path: join(d, 'notes.txt') }), 'ask');
});

test('agy gate: servers a and a_b, tool mcp_a_b_c: a deny rule for either reading refuses it (fails closed)', () => {
  const d = ws();
  const deny = (rule: string) => ({ ...policy(d, 'bypassPermissions'), deny: [rule] });
  for (const rule of ['mcp__a__b_c', 'mcp__a_b__c', 'mcp__a', 'mcp__a_b__*']) {
    const v = agyGate(deny(rule), tc('mcp_a_b_c', {}), ['a', 'a_b']);
    assert.equal(typeof v === 'object' && v.action, 'block', rule);
  }
  assert.equal(agyGate(deny('mcp__a__other'), tc('mcp_a_b_c', {}), ['a', 'a_b']), 'allow');
  // One known server fits: that reading alone. None: every split.
  assert.equal(agyGate(deny('mcp__a'), tc('mcp_a_b_c', {}), ['a_b']), 'allow');
  assert.equal(typeof agyGate(deny('mcp__x_y__z'), tc('mcp_x_y_z', {}), []) === 'object', true);
});

test('agy names: mcp names, deny matching, modes, the request in Claude Code naming, checkable rules', () => {
  assert.equal(agyMcpName('mcp_echo_say'), 'mcp__echo__say');
  assert.equal(agyMcpName('mcp_my_srv_do_it', ['my_srv']), 'mcp__my_srv__do_it');
  assert.equal(agyMcpName('mcp_my_srv_do_it'), 'mcp__my__srv_do_it');
  assert.equal(agyMcpName('mcp_x'), undefined);
  assert.equal(agyMcpName('read_file'), undefined);
  assert.equal(mcpDenied(['mcp__a__*'], 'mcp__a__b'), 'mcp__a__*');
  assert.equal(mcpDenied(['mcp__a__b'], 'mcp__a__c'), undefined);
  assert.equal(mcpDenied(['Read(/x)', 'mcp__ab'], 'mcp__a__b'), undefined);
  const p = (permission_mode: Profile['permission_mode']) => ({ permission_mode }) as Profile;
  assert.equal(agyMode(p('default')), 'default');
  assert.equal(agyMode(p('acceptEdits')), 'accept-edits');
  assert.equal(agyMode(p('plan')), 'plan');
  assert.equal(agyMode(p('bypassPermissions')), 'default', 'never auto');
  assert.deepEqual(agyRequest(tc('read_file', { Path: '/a' })), { tool: 'Read', input: { file_path: '/a' } });
  assert.deepEqual(agyRequest(tc('write_file', { Path: '/a', Content: 'x' })), { tool: 'Write', input: { file_path: '/a' } });
  assert.deepEqual(agyRequest(tc('edit_file', { Path: '/a' })), { tool: 'Edit', input: { file_path: '/a' } });
  assert.deepEqual(agyRequest(tc('run_command', { CommandLine: 'ls' })), { tool: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(agyRequest(tc('mcp_echo_say', { text: 'x' })), { tool: 'mcp__echo__say', input: { text: 'x' } });
  assert.deepEqual(agyRequest(tc('call_mcp_tool', { ServerName: 's', ToolName: 't', Arguments: { a: 1 } })), { tool: 'mcp__s__t', input: { a: 1 } });
  assert.equal(agyRequest(tc('invoke_subagent', { Prompt: 'x' })), undefined);
  assert.ok(checkable('agy', 'Bash(rm *)') && checkable('agy', 'Read(~/x)') && checkable('agy', 'mcp__gh') && checkable('agy', 'Edit'));
  assert.ok(!checkable('agy', 'WebFetch(domain:x.com)'));
});

test('agyPolicy: pi\'s policy from the profile, the session\'s deny on top; sandbox: false has no sockets', () => {
  const d = ws();
  mkdirSync(join(d, '.claude'));
  writeFileSync(join(d, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [`Read(${d}/secret.txt)`, 'mcp__bad'], additionalDirectories: ['/opt/common'] } }));
  const prof = { cwd: d, add_dirs: ['/opt/extra'], permission_mode: 'plan', backend: 'agy' } as unknown as Profile;
  const pol = agyPolicy(prof, '/state/cache/agy/abc', ['Edit(/thread/.claude/**)', 'mcp__bad']);
  assert.deepEqual(pol, { mode: 'plan', cwd: d, dirs: ['/opt/extra', '/opt/common'], deny: [`Read(${d}/secret.txt)`, `Read(${join(d, d)}/secret.txt)`, 'mcp__bad', 'Edit(/thread/.claude/**)'], sandbox: true, sockets: [tmuxSocketPath()], cache: '/state/cache/agy/abc' });
  const off = agyPolicy({ ...prof, sandbox: false } as Profile);
  assert.equal(off.sandbox, false); assert.equal(off.sockets, undefined); assert.equal(off.cache, undefined);
});

test('agySandboxProfile: writable folders, own gemini dir opened last, siblings closed, PTY open; pi\'s profile unchanged without `own`', () => {
  const d = ws(), state = scratch();
  const gd = join(state, 'agy', 'mine');
  const sb = agySandboxProfile(policy(d, 'default', { dirs: ['/opt/common'], sockets: ['/s/tmux'], cache: join(state, 'cache', 'agy', 'mine') }), gd);
  assert.match(sb, /\(deny appleevent-send\)/);
  assert.match(sb, /\(deny network-outbound \(remote unix-socket \(path-literal "\/s\/tmux"\)\)\)/);
  assert.ok(sb.includes(`(subpath "${d}")`) && sb.includes('(subpath "/opt/common")') && sb.includes(`(subpath "${gd}")`));
  const lines = sb.split('\n');
  const at = lines.indexOf(`(allow file-read* file-write* (subpath "${gd}"))`);
  assert.deepEqual(lines.slice(at, at + 3), [`(allow file-read* file-write* (subpath "${gd}"))`, '(allow file-read* file-write* (literal "/dev/ptmx"))', '(allow file-read* file-write* (regex "^/[dD][eE][vV]/[tT][tT][yY][sS]"))']);
  // The gemini dir's inputs come after the folder is opened again: the sandbox takes the last match.
  for (const f of [join(gd, 'config'), join(gd, 'GEMINI.md'), join(gd, 'antigravity-cli', 'settings.json'), join(gd, 'antigravity-cli', 'plugins'), join(gd, 'antigravity-cli', 'hooks'), join(gd, 'antigravity-cli', 'mcp')]) {
    const i = lines.indexOf(`(deny file-write* (subpath "${f}"))`);
    assert.ok(i > at, `${f} closed after the open rule`);
  }
  assert.ok(!lines.some((l) => l.includes('Keychains') && l.startsWith('(allow')), 'the keychain is never opened');
  assert.ok(lines.includes('(deny process-exec* (literal "/usr/bin/security"))'));
  assert.ok(lines.some((l) => l.includes(`^${join(state, 'agy').replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)}/`)), 'the other gemini dirs are closed');
  assert.deepEqual(AGY_PTY.map((o) => o.path), ['/dev/ptmx', '/dev/ttys']);
  // `own` is new: a profile made without it is the same text as before.
  assert.equal(sandboxProfile(['Read(/x)'], '/h', { cache: '/c/pi/a', writable: ['/w'] }), sandboxProfile(['Read(/x)'], '/h', { cache: '/c/pi/a', writable: ['/w'], own: [] }));
});

test('agySeedLogin: the owner\'s sign-in is copied into the gemini dir once, again only when it changes; a file agy refreshed is kept', () => {
  const g = scratch(), file = join(g, AGY_TOKEN);
  const login = (r: string) => JSON.stringify({ token: { access_token: 'a', refresh_token: r }, auth_method: 'oauth' });
  assert.equal(agySeedLogin(g, () => undefined), false, 'no sign-in anywhere');
  assert.equal(agySeedLogin(g, () => login('r1')), true);
  assert.equal(readFileSync(file, 'utf8'), login('r1'));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // agy refreshed the access token in the file: same refresh token, so the file stays.
  writeFileSync(file, JSON.stringify({ token: { access_token: 'newer', refresh_token: 'r1' } }));
  agySeedLogin(g, () => login('r1'));
  assert.match(readFileSync(file, 'utf8'), /newer/);
  // The owner signed in again: the new sign-in replaces it.
  agySeedLogin(g, () => login('r2'));
  assert.equal(readFileSync(file, 'utf8'), login('r2'));
  // The keychain cannot be read (or holds no JSON): the file there is kept and counts.
  assert.equal(agySeedLogin(g, () => 'garbage'), true);
  assert.equal(readFileSync(file, 'utf8'), login('r2'));
});

test('agySeedLogin: no write through a link the agent planted, at the file, its folder or a guessed temp name', () => {
  const login = JSON.stringify({ token: { refresh_token: 'FAKE-R' } });
  const victimDir = scratch(), victim = join(victimDir, 'victim.txt');
  // A guessed temp name (the old pid one) and a link at the file itself.
  let g = scratch();
  mkdirSync(join(g, 'antigravity-cli'), { recursive: true });
  writeFileSync(victim, 'owner file');
  symlinkSync(victim, join(g, `${AGY_TOKEN}.${process.pid}.tmp`));
  assert.equal(agySeedLogin(g, () => login), true, 'the guessed name is not used');
  assert.equal(readFileSync(victim, 'utf8'), 'owner file');
  assert.equal(lstatSync(join(g, AGY_TOKEN)).isSymbolicLink(), false);
  g = scratch();
  mkdirSync(join(g, 'antigravity-cli'), { recursive: true });
  symlinkSync(victim, join(g, AGY_TOKEN));
  assert.equal(agySeedLogin(g, () => login), true, 'a link at the file is removed, then the file is seeded (review 3, L4)');
  assert.equal(readFileSync(victim, 'utf8'), 'owner file');
  assert.ok(lstatSync(join(g, AGY_TOKEN)).isFile());
  assert.equal(readFileSync(join(g, AGY_TOKEN), 'utf8'), login);
  // The folder itself a link to the owner's: nothing is written there.
  g = scratch();
  symlinkSync(victimDir, join(g, 'antigravity-cli'));
  assert.equal(agySeedLogin(g, () => login), false, 'a linked folder is refused');
  assert.deepEqual(readdirSync(victimDir), ['victim.txt']);
});

test('agySeedLogin: a named pipe or an empty folder at the file does not hold the daemon; it is replaced (review 3, M1, L4)', () => {
  const login = JSON.stringify({ token: { refresh_token: 'FAKE-R' } });
  let g = scratch();
  mkdirSync(join(g, 'antigravity-cli'), { recursive: true });
  assert.equal(spawnSync('/usr/bin/mkfifo', [join(g, AGY_TOKEN)]).status, 0);
  assert.equal(agySeedLogin(g, () => login), true);
  assert.equal(readFileSync(join(g, AGY_TOKEN), 'utf8'), login);
  g = scratch();
  mkdirSync(join(g, AGY_TOKEN), { recursive: true });
  assert.equal(agySeedLogin(g, () => login), true);
  assert.ok(lstatSync(join(g, AGY_TOKEN)).isFile());
  // A folder with files in it is not emptied: the seed fails, nothing of it is removed.
  g = scratch();
  mkdirSync(join(g, AGY_TOKEN), { recursive: true });
  writeFileSync(join(g, AGY_TOKEN, 'keep'), 'x');
  assert.equal(agySeedLogin(g, () => login), false);
  assert.equal(readFileSync(join(g, AGY_TOKEN, 'keep'), 'utf8'), 'x');
});

test('sandbox (macOS): no command reaches the keychain door; the gemini dir\'s inputs cannot be written, its conversations can', { skip: !darwin && 'no sandbox-exec here' }, () => {
  const d = ws(), state = scratch();
  const gd = join(state, 'agy', 'mine');
  for (const x of ['config', 'antigravity-cli/conversations']) mkdirSync(join(gd, x), { recursive: true });
  const sb = agySandboxProfile(policy(d, 'default'), gd);
  const run = (...argv: string[]) => spawnSync(SANDBOX_EXEC, ['-p', sb, ...argv], { cwd: d, encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(run('/usr/bin/security', 'list-keychains').status, 0);
  assert.notEqual(run('/bin/sh', '-c', 'security list-keychains').status, 0);
  for (const f of ['config/mcp_config.json', 'config/config.json', 'GEMINI.md', 'config/GEMINI.md', 'config/skills/x/SKILL.md', 'antigravity-cli/settings.json', 'antigravity-cli/builtin/skills/x/SKILL.md', 'config/plugins/rt2/hooks.json', 'config/skills2/x', 'antigravity-cli/hooks/h.json', 'antigravity-cli/mcp/x', 'antigravity-cli/knowledge/x']) {
    assert.notEqual(run('/bin/sh', '-c', 'mkdir -p "$(dirname "$1")"; echo x > "$1"', 'sh', join(gd, f)).status, 0, f);
  }
  assert.notEqual(run('/bin/mv', join(gd, 'config'), join(gd, 'config2')).status, 0, 'the folder above cannot be swapped');
  assert.equal(run('/bin/sh', '-c', 'echo x > "$1" && cat "$1"', 'sh', join(gd, 'antigravity-cli', 'conversations', 'c.db')).stdout, 'x\n');
  // No named pipe, in the gemini dir or the profile's folder (review 3, M1); a plain file still can.
  for (const f of [join(gd, 'antigravity-cli', 'antigravity-oauth-token'), join(d, 'CLAUDE.md.fifo')]) {
    assert.notEqual(run('/usr/bin/mkfifo', f).status, 0, f);
    assert.equal(existsSync(f), false, f);
  }
  assert.equal(run('/usr/bin/touch', join(d, 'plain.txt')).status, 0);
});

test('sandbox (macOS): a denied file is refused through a real sandbox-exec; the PTY opens only with AGY_PTY; other gemini dirs are closed', { skip: !darwin && 'no sandbox-exec here' }, () => {
  const d = ws(), state = scratch();
  const gd = join(state, 'agy', 'mine'), other = join(state, 'agy', 'other');
  mkdirSync(gd, { recursive: true }); mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'conv.db'), 'theirs');
  const sb = agySandboxProfile(policy(d, 'default'), gd);
  const run = (profile: string, ...argv: string[]) => spawnSync(SANDBOX_EXEC, ['-p', profile, ...argv], { cwd: d, encoding: 'utf8', timeout: 10_000 });
  const secret = run(sb, '/bin/cat', join(d, 'secret.txt'));
  assert.notEqual(secret.status, 0); assert.match(secret.stderr, /Operation not permitted/);
  assert.equal(run(sb, '/bin/cat', join(d, 'notes.txt')).stdout, 'hello\n');
  assert.equal(run(sb, '/bin/sh', '-c', `echo x > ${gd}/own.txt && cat ${gd}/own.txt`).stdout, 'x\n');
  assert.match(run(sb, '/bin/cat', join(other, 'conv.db')).stderr, /Operation not permitted/);
  assert.notEqual(run(sb, '/bin/sh', '-c', `echo x > ${other}/planted`).status, 0);
  const pty = ['/usr/bin/python3', '-c', 'import os; m, s = os.openpty(); print("pty", os.ttyname(s).startswith("/dev/ttys"))'];
  assert.equal(run(sb, ...pty).stdout.trim(), 'pty True');
  const noPty = sandboxProfile(policy(d, 'default').deny, undefined, { writable: [d, gd], noLaunch: true });
  assert.notEqual(run(noPty, ...pty).status, 0, 'without the PTY opening a command cannot get a terminal (agy: "failed to create PTY")');
});

// ---- through the fake agy, with the real gate ----

const made: AgyBrain[] = [];
// A test that fails before its own stop() must not leave fake agy running: it ends only when its stdin
// closes, and this process holds that pipe open, so the file (and the whole `npm test`) never ends.
// Seen 2026-11-21: a run under load waited 8 hours. Every brain still alive is killed after each test.
afterEach(() => { for (const b of made.splice(0)) if (b.alive) b.kill(); });
process.on('exit', () => made.forEach((b) => b.kill()));
function brain(dir: string, mode: Profile['permission_mode'], o: { deny?: string[]; env?: NodeJS.ProcessEnv; sandbox?: boolean } = {}) {
  const p = { cwd: dir, add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'agy', permission_mode: mode, sandbox: o.sandbox ?? false } as unknown as Profile;
  const b = new AgyBrain(p, { id: 's', started: false }, { bin: FAKE_AGY, permissionTimeoutMs: 300, geminiDir: scratch(), deny: [`Read(${dir}/secret.txt)`, 'mcp__bad', ...(o.deny ?? [])], env: { ...process.env, ...o.env } });
  made.push(b); b.start();
  return b;
}
async function turn(b: AgyBrain, text: string, allow = true): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of b.turn(text)) { out.push(e); if (e.kind === 'permission') b.answerPermission(e.id.slice(0, 8), allow); }
  return out;
}
const ask = (name: string, raw: Record<string, unknown>) => `ASK ${name} ${JSON.stringify(raw)}`;
const unasked = (b: AgyBrain) => new Promise<{ answer: string; text: string }>((r) => b.once('unasked', r));

test('fake agy: the gate answers agy before the chat; a block names the rule in the refused line', async () => {
  const d = ws();
  const b = brain(d, 'acceptEdits');
  assert.deepEqual(await turn(b, 'MODE?'), [{ kind: 'result', text: 'mode accept-edits', isError: false }]);
  assert.deepEqual(await turn(b, ask('read_file', { Path: join(d, 'secret.txt') })), [{ kind: 'result', text: `agy stopped after a refused action (read_file: Angelia's profile rules deny read of ${d}/secret.txt): it did not run.`, isError: false }]);
  assert.deepEqual(await turn(b, ask('write_file', { Path: join(d, 'a.txt') })), [{ kind: 'result', text: 'ran write_file', isError: false }], 'acceptEdits writes inside unasked');
  assert.deepEqual(await turn(b, ask('run_command', { CommandLine: 'ls' })), [{ kind: 'result', text: 'ran run_command', isError: false }]);
  const asked = await turn(b, ask('run_command', { CommandLine: 'rm a.txt' }), false);
  assert.deepEqual(asked.map((e) => e.kind), ['permission', 'result']);
  assert.deepEqual((asked[0] as any).request, { tool: 'Bash', input: { command: 'rm a.txt' } });
  assert.deepEqual(await turn(b, ask('mcp_bad_go', {})), [{ kind: 'result', text: "agy stopped after a refused action (mcp_bad_go: Angelia's profile rules deny mcp__bad__go (rule mcp__bad)): it did not run.", isError: false }]);
  assert.deepEqual(b.blocked.map((x) => x.tool), ['read_file', 'mcp_bad_go']);
  assert.equal(b.pendingPermissionCount, 0);
  await b.stop();
});

test('fake agy: a request offering only allow_always is never allowed, by the gate or by the chat', async () => {
  const d = ws();
  const b = brain(d, 'bypassPermissions', { env: { FAKE_AGY_ALWAYS_ONLY: '1' } });
  assert.deepEqual(await turn(b, ask('write_file', { Path: join(d, 'a.txt') })), [{ kind: 'result', text: 'agy stopped after a refused action (write_file: agy offered no allow-once answer): it did not run.', isError: false }]);
  await b.stop();
  const c = brain(d, 'default', { env: { FAKE_AGY_ALWAYS_ONLY: '1' } });
  const asked = await turn(c, ask('run_command', { CommandLine: 'rm a.txt' }), true);
  assert.deepEqual(asked.map((e) => e.kind), ['permission', 'result']);
  assert.notEqual((asked[1] as any).text, 'ran run_command', 'the approval is answered as cancelled');
  await c.stop();
});

test('fake agy: plan mode is set and the gate blocks every edit and command; bypass is agy\'s default with the gate allowing all but denies', async () => {
  const d = ws();
  const log = join(scratch(), 'log');
  const p = brain(d, 'plan', { env: { FAKE_AGY_LOG: log } });
  assert.deepEqual(await turn(p, 'MODE?'), [{ kind: 'result', text: 'mode plan', isError: false }]);
  for (const [name, raw] of [['run_command', { CommandLine: 'ls' }], ['write_file', { Path: join(d, 'x') }], ['edit_file', { Path: join(d, 'notes.txt') }], ['invoke_subagent', {}]] as const) {
    const ev = await turn(p, ask(name, raw));
    assert.equal(ev.length, 1, name); assert.match((ev[0] as any).text, /in plan mode\): it did not run\.$/, name);
  }
  assert.deepEqual(await turn(p, ask('read_file', { Path: join(d, 'notes.txt') })), [{ kind: 'result', text: 'ran read_file', isError: false }]);
  await p.stop();
  const lines = (await import('node:fs')).readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(lines.slice(1), ['set_model gemini-4-hydrogen-high', 'set_mode plan', `close ${p.backendSessionId}`], 'session/close before the process ends');
  const y = brain(d, 'bypassPermissions');
  assert.deepEqual(await turn(y, 'MODE?'), [{ kind: 'result', text: 'mode default', isError: false }], 'never auto');
  assert.deepEqual(await turn(y, ask('run_command', { CommandLine: 'rm -rf x' })), [{ kind: 'result', text: 'ran run_command', isError: false }]);
  assert.deepEqual(await turn(y, ask('mcp_echo_say', {})), [{ kind: 'result', text: 'ran mcp_echo_say', isError: false }]);
  assert.match(((await turn(y, ask('read_file', { Path: join(d, 'secret.txt') })))[0] as any).text, /deny read of .*secret\.txt\): it did not run\.$/);
  assert.equal(y.blocked.length, 1);
  await y.stop();
});

test('fake agy: a message agy sends after end_turn reaches the chat as an unasked answer; a request between turns is gated', async (t) => {
  const was = AgyBrain.quietMs;
  AgyBrain.quietMs = 50;
  t.after(() => { AgyBrain.quietMs = was; });
  const d = ws();
  const b = brain(d, 'default');
  const woke = unasked(b);
  assert.deepEqual(await turn(b, 'WAKE'), [{ kind: 'result', text: 'started', isError: false }]);
  assert.deepEqual(await woke, { answer: 'self', text: 'The background command finished: BGDONE' });
  // Asked between turns, with no turn to ask in: refused, and the chat hears what agy said after.
  let next = unasked(b);
  await turn(b, `WAKEASK run_command ${JSON.stringify({ CommandLine: 'rm x' })}`);
  assert.deepEqual(await next, { answer: 'self', text: 'after: refused' });
  assert.equal(b.blocked.at(-1)!.reason, 'asked between turns, when no one could answer');
  assert.equal(b.blocked.at(-1)!.between, true);
  // A read the rules allow runs between turns, as in a turn; a denied one is blocked by the rule.
  next = unasked(b);
  await turn(b, `WAKEASK read_file ${JSON.stringify({ Path: join(d, 'notes.txt') })}`);
  assert.deepEqual(await next, { answer: 'self', text: 'after: allowed' });
  next = unasked(b);
  await turn(b, `WAKEASK read_file ${JSON.stringify({ Path: join(d, 'secret.txt') })}`);
  assert.deepEqual(await next, { answer: 'self', text: 'after: refused' });
  assert.match(b.blocked.at(-1)!.reason!, /deny read of .*secret\.txt/);
  await b.stop();
});

test('fake agy: between-turns text not yet quiet goes first in the next turn, never twice', async (t) => {
  const was = AgyBrain.quietMs;
  AgyBrain.quietMs = 5000;
  t.after(() => { AgyBrain.quietMs = was; });
  const b = brain(ws(), 'default');
  let emitted = 0;
  b.on('unasked', () => emitted++);
  await turn(b, 'WAKE');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(await turn(b, 'next'), [{ kind: 'unasked', answer: 'self', text: 'The background command finished: BGDONE' }, { kind: 'result', text: 'echo: next', isError: false }]);
  assert.equal(emitted, 0);
  await b.stop();
});

test('fake agy: a tool that never asks (a subagent) is logged', async () => {
  const b = brain(ws(), 'default');
  const logs: string[] = [];
  b.on('log', (l: string) => logs.push(l));
  assert.deepEqual(await turn(b, 'SUBAGENT'), [{ kind: 'result', text: 'delegated', isError: false }]);
  assert.deepEqual(logs, ['agy used invoke_subagent, which asks no permission (Subagent: go)']);
  await b.stop();
});

test('fake agy: a subagent\'s requests are surfaced by resuming its conversation; its text is not the answer; one not found is said', async (t) => {
  const was = [AgyBrain.quietMs, AgyBrain.childScanMs];
  // Scans up to 3 s: under load the fake can be held more than 150 ms between the invoke_subagent line
  // and writing the conversation, and the last scan then said "not found" (load rerun, 2026-11-24).
  AgyBrain.quietMs = 50; AgyBrain.childScanMs = [20, 100, 400, 1500, 3000];
  t.after(() => { [AgyBrain.quietMs, AgyBrain.childScanMs] = was as [number, number[]]; });
  const d = ws();
  const log = join(scratch(), 'log');
  // default mode: the subagent's write is asked, between turns no one can answer it: refused.
  const b = brain(d, 'default', { env: { FAKE_AGY_LOG: log } });
  let next = unasked(b);
  assert.deepEqual(await turn(b, 'CHILD'), [{ kind: 'result', text: 'delegated', isError: false }]);
  assert.deepEqual(await next, { answer: 'self', text: 'subagent: refused' });
  assert.equal(b.children.size, 1);
  assert.ok((await import('node:fs')).readFileSync(log, 'utf8').includes(`resume-child ${[...b.children][0]}`));
  assert.equal(b.blocked.at(-1)!.tool, 'write_file');
  await b.stop();
  // bypass: the gate allows the subagent's write inside the gemini dir; the parent reports it.
  const y = brain(d, 'bypassPermissions');
  next = unasked(y);
  await turn(y, 'CHILD');
  const got = await next;
  assert.equal(got.text, 'subagent: allowed', 'the subagent\'s own "child text" is not delivered');
  await y.stop();
  // A subagent's own subagent is found from its conversation and attached too.
  const gl = join(scratch(), 'glog');
  const gr = brain(d, 'bypassPermissions', { env: { FAKE_AGY_GRANDCHILD: '1', FAKE_AGY_LOG: gl } });
  next = unasked(gr);
  await turn(gr, 'CHILD');
  await next;
  // The brain counts a child before fake agy has read its session/resume and logged it: wait for both.
  const resumed = () => readFileSync(gl, 'utf8').split('\n').filter((x) => x.startsWith('resume-child')).length;
  for (let i = 0; i < 100 && (gr.children.size < 2 || resumed() < 2); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(gr.children.size, 2, 'child and grandchild attached');
  assert.equal(resumed(), 2);
  await gr.stop();
  // Not found: one line, nothing attached.
  const l = brain(d, 'default');
  next = unasked(l);
  await turn(l, 'CHILD-LOST');
  assert.deepEqual(await next, { answer: 'self', text: AGY_LOST_SUBAGENT_LINE });
  assert.equal(l.children.size, 0);
  await l.stop();
});

test('fake agy (macOS): the whole process runs under sandbox-exec and still answers', { skip: !darwin && 'no sandbox-exec here' }, async () => {
  const d = ws();
  const argvLog = join(scratch(), 'argv');
  const b = brain(d, 'default', { sandbox: true, env: { FAKE_AGY_ARGV_LOG: argvLog } });
  assert.ok(b.sandbox && b.sandbox.includes('(literal "/dev/ptmx")'));
  assert.deepEqual(await turn(b, 'hello'), [{ kind: 'result', text: 'echo: hello', isError: false }]);
  await b.stop();
  assert.ok(!b.alive);
});

test('fake agy: a subagent whose conversation is on disk before its invoke_subagent line is still attached', async (t) => {
  const was = [AgyBrain.quietMs, AgyBrain.childScanMs];
  AgyBrain.quietMs = 50; AgyBrain.childScanMs = [20, 100, 400, 1500, 3000];
  t.after(() => { [AgyBrain.quietMs, AgyBrain.childScanMs] = was as [number, number[]]; });
  const log = join(scratch(), 'log');
  const b = brain(ws(), 'default', { env: { FAKE_AGY_LOG: log, FAKE_AGY_CHILD_FIRST: '1' } });
  const next = unasked(b);
  assert.deepEqual(await turn(b, 'CHILD'), [{ kind: 'result', text: 'delegated', isError: false }]);
  assert.deepEqual(await next, { answer: 'self', text: 'subagent: refused' });
  assert.equal(b.children.size, 1, 'the subagent is attached');
  await b.stop();
});
