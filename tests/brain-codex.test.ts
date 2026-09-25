import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Config } from '../src/instance/config/schema.js';
import { loadConfig, ConfigError } from '../src/instance/config/load.js';
import { createBrain, type Brain } from '../src/brain/index.js';
import { CodexBrain, describeGrant } from '../src/brain/codex.js';
import { codexApproval, codexCacheDir, codexConfigConflict, codexFilesystem, codexOverrides, codexSandboxNote, tomlTable } from '../src/brain/codex-config.js';
import { CODEX_LAUNCH_DIRS, launchCheck, pathRule, planProfile, profileFloor } from '../src/capabilities/compile.js';
import { codexRows, codexSessionFile, exportChat } from '../src/instance/export.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { LOST_SESSION_LINE } from '../src/brain/transcripts.js';
import type { BrainEvent, Inbound } from '../src/core/types.js';
import { stringify } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-codex.mjs');
type Mode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
const base = { cwd: here, add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'codex' as const };
const profile = (permission_mode: Mode = 'acceptEdits', extra: Record<string, unknown> = {}) => ({ ...base, permission_mode, ...extra }) as any;

const made: Brain[] = [];
process.on('exit', () => made.forEach((b) => b.kill()));
function make(mode: Mode = 'acceptEdits', started = false, env: NodeJS.ProcessEnv = {}, extra: Record<string, unknown> = {}, id = 'sess-1') {
  const b = createBrain(profile(mode, extra), { id, started }, { bin: FAKE, permissionTimeoutMs: 200, env: { ...process.env, ...env }, system: 'SELF', apiSocket: '/state/api.sock', profileName: 'cx' });
  made.push(b); b.start();
  return b;
}
async function collect(b: Brain, text: string, allow = true): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of b.turn(text)) { out.push(e); if (e.kind === 'permission') b.answerPermission(e.id.slice(0, 8), allow); }
  return out;
}

test('codex: factory, config, the sandbox overrides on argv', () => {
  assert.ok(createBrain(profile(), { id: 'x', started: false }, { bin: 'true' }) instanceof CodexBrain);
  assert.equal(Config.parse({ profiles: { c: { cwd: here, backend: 'codex' } }, routes: [] }).profiles.c.backend, 'codex');
  const deny = ['Read(/h/.ssh/**)', 'Edit(/h/.ssh/**)', 'Edit(/w/p/.claude/settings.json)', 'Read(~/.netrc)', 'Read(/h/*/secret)', 'mcp__bank'];
  const fs = codexFilesystem(deny, ['/w/_common'], '/h');
  assert.deepEqual(fs.entries, { '/w/_common': 'write', '/h/.ssh': 'deny', '/w/p/.claude/settings.json': 'read', '/h/.netrc': 'deny' });
  assert.deepEqual(fs.skipped, ['Read(/h/*/secret)']);
  const home = mkdtempSync(join(tmpdir(), 'angelia-codex-h-'));
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.bank]\ncommand = "x"\n[mcp_servers.maps]\ncommand = "y"\n');
  const { args } = codexOverrides(profile('acceptEdits'), { deny, writable: ['/w/_common'], socket: '/state/api.sock', home });
  assert.deepEqual(args, [
    '-c', 'project_doc_fallback_filenames=["CLAUDE.md"]',
    '-c', 'default_permissions="angelia"',
    '-c', 'permissions.angelia.extends=":workspace"',
    '-c', `permissions.angelia.filesystem=${tomlTable({ '/w/_common': 'write', '/h/.ssh': 'deny', '/w/p/.claude/settings.json': 'read', [join(home, '.netrc')]: 'deny' })}`,
    '-c', 'permissions.angelia.network.enabled=true',
    '-c', 'features.network_proxy=true',
    '-c', 'permissions.angelia.network.domains={"*"="allow"}',
    '-c', 'permissions.angelia.network.unix_sockets={"/state/api.sock"="allow"}',
    '-c', 'features.exec_permission_approvals=true',
    '-c', 'features.request_permissions_tool=true',
    '-c', 'mcp_servers.bank.enabled=false',
  ]);
  // Only where the owner is asked: bypass and plan never widen the sandbox.
  for (const m of ['bypassPermissions', 'plan'] as Mode[]) assert.ok(!codexOverrides(profile(m), { deny: [], writable: [], home }).args.some((a) => a.includes('permission_approvals') || a.includes('request_permissions')), m);
  // Without a socket the list is empty, never absent: with the proxy on, only a listed socket answers.
  assert.ok(codexOverrides(profile('acceptEdits'), { deny: [], writable: [], home }).args.includes('permissions.angelia.network.unix_sockets={}'));
  assert.ok(codexOverrides(profile('plan'), { deny: [], writable: ['/x'], home }).args.includes('permissions.angelia.extends=":read-only"'));
  assert.ok(!codexOverrides(profile('plan'), { deny: [], writable: ['/x'], home }).args.some((a) => a.includes('filesystem')));
  assert.deepEqual(codexOverrides(profile('bypassPermissions', { sandbox: false }), { deny, writable: [], home }).args, ['-c', 'project_doc_fallback_filenames=["CLAUDE.md"]', '-c', 'mcp_servers.bank.enabled=false']);
  assert.deepEqual(['default', 'acceptEdits', 'bypassPermissions', 'plan'].map((m) => codexApproval(profile(m as Mode))), ['on-request', 'on-request', 'never', 'never']);
  const note = codexSandboxNote(profile(), ['/w/_common'], 'shop');
  assert.match(note, /add the folder to add_dirs for this profile in routing\.yaml, then `angelia compile shop --write`/);
  assert.match(note, /ask for access to that exact folder .* for this turn/);
  assert.match(note, /fully outside the sandbox does not work here/);
  assert.match(note, /\.git folder .* read-only/);
  assert.match(codexSandboxNote(profile('bypassPermissions'), [], 'shop'), /Do not try to get around the sandbox\.$/);
  assert.match(codexSandboxNote(profile('plan'), [], 'shop'), /you only read, you write nothing/);
  assert.equal(tomlTable({ 'a"b\\c': 'deny' }), '{"a\\"b\\\\c"="deny"}');
  assert.equal(tomlTable({ 'a\x7fb': 'deny' }), '{"a\\u007Fb"="deny"}');
  // A server whose name needs quotes cannot be switched off with -c: the launch is refused, not left open.
  writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers."bank two"]\ncommand = "x"\n');
  assert.match(codexOverrides(profile(), { deny: ['mcp__bank two'], writable: [], home }).refuse ?? '', /cannot be switched off/);
  // Codex's own merged view decides: a layer other than Angelia's flags touching the profile, or a denied server left on.
  assert.equal(codexConfigConflict({ layers: [{ name: { type: 'sessionFlags' }, config: { permissions: { angelia: { extends: ':workspace' } } } }], config: {} }, []), undefined);
  assert.match(codexConfigConflict({ layers: [{ name: { type: 'project', dotCodexFolder: '/p/.codex' }, config: { permissions: { angelia: { network: {}, filesystem: { '/x': 'read' } } } } }] }, []) ?? '', /\(\/p\/\.codex\) sets permissions\.angelia/);
  assert.equal(codexConfigConflict({ layers: [{ name: { type: 'project', dotCodexFolder: '/p/.codex' }, disabledReason: 'untrusted', config: { permissions: { angelia: { network: {} } } } }] }, []), undefined, 'a layer Codex does not apply');
  // Any server Codex would load that the profile was not given refuses, in whatever form it was written.
  assert.match(codexConfigConflict({ layers: [], config: { mcp_servers: { bank: { enabled: true }, maps: {} } } }, ['maps']) ?? '', /not given would load: bank;/);
  assert.equal(codexConfigConflict({ layers: [], config: { mcp_servers: { bank: { enabled: false }, maps: {} } } }, ['maps']), undefined);
  assert.notEqual(codexCacheDir('/s', 'שלום'), codexCacheDir('/s', 'שלוה'), 'names that differ get different folders');
});

test('codex: a turn, progress before an action, the id Codex mints, the default model, the self prompt and the sandbox note', async () => {
  const b = make();
  assert.deepEqual(await collect(b, 'hello'), [{ kind: 'result', text: 'echo: hello', isError: false }]);
  assert.match(b.backendSessionId!, /^thr-/);
  assert.equal(b.version, '0.157.0');
  assert.deepEqual(await collect(b, 'PROGRESS'), [{ kind: 'progress', text: 'working on it' }, { kind: 'result', text: 'all done', isError: false }]);
  const { argv, threadParams } = JSON.parse(((await collect(b, 'ARGS'))[0] as any).text);
  assert.equal(argv.at(-1), 'app-server');
  assert.ok(argv.includes('permissions.angelia.network.unix_sockets={"/state/api.sock"="allow"}'));
  assert.equal(threadParams.model, 'gpt-fake');
  assert.equal(threadParams.approvalPolicy, 'on-request');
  assert.equal(threadParams.approvalsReviewer, 'user');
  assert.equal(threadParams.sandbox, null);
  assert.match(threadParams.developerInstructions, /^SELF\n\nYou run inside Codex's sandbox/);
  assert.match(threadParams.developerInstructions, /angelia compile cx --write/);
  const args2 = JSON.parse(((await collect(b, 'ARGS'))[0] as any).text);
  assert.match(args2.npmCache, /^\/state\/cache\/codex\/[0-9a-f]{16}\/npm$/, 'its own cache folder under the state folder, not temp');
  assert.ok(args2.argv.some((a: string) => /permissions\.angelia\.filesystem=.*"\/state\/cache\/codex\/[0-9a-f]{16}"="write"/.test(a)));
  assert.ok(args2.argv.some((a: string) => /permissions\.angelia\.filesystem=.*"\/state\/cache\/codex"="deny"/.test(a)), 'the other profiles\' caches are denied');
  assert.deepEqual(await collect(b, 'SEP'), [{ kind: 'result', text: 'one two', isError: false }]);
  await b.stop();
  assert.equal(b.alive, false);
});

test('codex: leaving the sandbox is asked in the chat, both ways, with the add_dirs way out; a timeout denies; wider permissions and screen questions are refused', async () => {
  const b = make();
  const ev = await collect(b, 'PERM', true);
  assert.equal(ev[0].kind, 'permission');
  assert.equal((ev[0] as any).tool, 'command');
  assert.match((ev[0] as any).preview, /^touch \/elsewhere\/x \(write outside the workspace\)\. Or add the folder to add_dirs instead\.$/);
  assert.deepEqual(ev[1], { kind: 'result', text: 'tool allowed', isError: false });
  assert.equal(((await collect(b, 'PERM', false))[1] as any).text, 'tool denied');
  const edit = await collect(b, 'EDIT', false);
  assert.equal((edit[0] as any).tool, 'edit');
  assert.match((edit[0] as any).preview, /\/elsewhere\/a\.txt: \+hi/);
  assert.equal((edit[1] as any).text, 'edit denied');
  let timedOut = '';
  b.on('permission-timeout', (id: string) => { timedOut = id; });
  const t: BrainEvent[] = [];
  for await (const e of b.turn('PERM')) t.push(e); // never answered: 200 ms timeout
  assert.equal((t[1] as any).text, 'tool denied'); assert.ok(timedOut);
  // A command that asks for a folder on top names it; a request for a folder is the owner's to answer.
  const more = await collect(b, 'PERM MORE', true);
  assert.match((more[0] as any).preview, /^touch \/elsewhere\/x \(asks write access to \/elsewhere; write outside the workspace\)\./);
  const grant = await collect(b, 'ESCALATE', true);
  assert.equal((grant[0] as any).tool, 'more access, this turn');
  assert.equal((grant[0] as any).preview, 'write access to /Users/example/Downloads (copy notes.md there). Or add the folder to add_dirs instead.');
  const asked = { network: null, fileSystem: { read: null, write: ['/Users/example/Downloads'], entries: [{ path: { type: 'path', path: '/Users/example/Downloads' }, access: 'write' }] } };
  assert.deepEqual(grant[1], { kind: 'result', text: `granted: ${JSON.stringify({ permissions: asked, scope: 'turn' })}`, isError: false });
  assert.equal(((await collect(b, 'ESCALATE', false))[1] as any).text, 'granted: {"permissions":{},"scope":"turn"}');
  assert.deepEqual(await collect(b, 'ASKUSER'), [{ kind: 'result', text: 'answered: {"answers":{}}', isError: false }]);
  // A request Codex settles itself leaves nothing waiting for the chat.
  const res: BrainEvent[] = [];
  for await (const e of b.turn('RESOLVE')) res.push(e);
  assert.equal(res[0].kind, 'permission'); assert.equal((res[1] as any).text, 'settled by codex');
  assert.equal(b.pendingPermissionCount, 0);
  await b.stop();
});

test('codex: a request for more access in words', () => {
  assert.equal(describeGrant(null), '');
  assert.equal(describeGrant({ network: { enabled: true }, fileSystem: { read: ['/r'], write: ['/w', '/w'] } }), 'write access to /w; read access to /r; network');
  assert.equal(describeGrant({ fileSystem: { read: null, write: ['/ignored'], entries: [{ path: { type: 'glob_pattern', pattern: '/g/**' }, access: 'write' }, { path: { type: 'special', value: { kind: 'root' } }, access: 'read' }, { path: { type: 'path', path: '/x' }, access: 'deny' }] } }), 'write access to /g/**; read access to special {"kind":"root"}; no access to /x');
});

test('codex: bypass and plan never ask, sandbox false is full access; a failed turn, a crash, a missing binary, an old version', async () => {
  const y = make('bypassPermissions');
  assert.equal(JSON.parse(((await collect(y, 'ARGS'))[0] as any).text).threadParams.approvalPolicy, 'never');
  assert.deepEqual(await collect(y, 'ESCALATE'), [{ kind: 'result', text: 'granted: {"permissions":{},"scope":"turn"}', isError: false }]);
  await y.stop();
  const f = make('bypassPermissions', false, {}, { sandbox: false });
  const fp = JSON.parse(((await collect(f, 'ARGS'))[0] as any).text);
  assert.equal(fp.threadParams.sandbox, 'danger-full-access');
  assert.ok(!fp.argv.some((a: string) => a.startsWith('default_permissions')));
  assert.match(fp.threadParams.developerInstructions, /runs without a sandbox/);
  assert.deepEqual(await collect(f, 'FAIL'), [{ kind: 'result', text: 'You have hit your usage limit.', isError: true, reason: 'You have hit your usage limit.' }]);
  assert.deepEqual(await collect(f, 'CRASH'), [{ kind: 'result', text: '', isError: true, reason: 'exit: codex: stream disconnected before completion' }]);
  const none = createBrain(profile(), { id: 'x', started: false }, { bin: join(here, 'no-such-codex') });
  made.push(none); none.start();
  const ev = await collect(none, 'hello');
  assert.equal(ev.length, 1); assert.equal((ev[0] as any).isError, true); assert.equal(none.alive, false);
  const old = make('acceptEdits', false, { FAKE_CODEX_VERSION: '0.120.0' });
  assert.deepEqual(await collect(old, 'hi'), [{ kind: 'result', text: '', isError: true, reason: 'version: codex 0.120.0 < 0.157.0; update codex' }]);
});

test('codex: resume keeps the thread; a thread Codex lost starts fresh and says so once; /compact is Codex\'s compact', async () => {
  const r = make('acceptEdits', true, {}, {}, 'thr-old');
  assert.deepEqual(await collect(r, 'back'), [{ kind: 'result', text: 'echo: back', isError: false }]);
  assert.equal(r.backendSessionId, 'thr-old');
  assert.deepEqual(await collect(r, '/compact'), [{ kind: 'result', text: 'Compacted.', isError: false }]);
  await r.stop();
  const gone = make('acceptEdits', true, { FAKE_CODEX_NO_RESUME: '1' }, {}, 'thr-gone');
  assert.deepEqual(await collect(gone, 'hi'), [{ kind: 'notice', text: LOST_SESSION_LINE }, { kind: 'result', text: 'echo: hi', isError: false }]);
  assert.match(gone.backendSessionId!, /^thr-(?!gone)/);
  assert.deepEqual(await collect(gone, 'again'), [{ kind: 'result', text: 'echo: again', isError: false }]);
  await gone.stop();
  // A thread another writer holds is an error, not a fresh start that would hide it from /resume.
  const busy = make('acceptEdits', true, { FAKE_CODEX_BUSY: '1' }, {}, 'thr-busy');
  const ev = await collect(busy, 'hi');
  assert.equal(ev.length, 1); assert.equal((ev[0] as any).isError, true); assert.match((ev[0] as any).reason, /already has an active writer/);
  for (let i = 0; i < 50 && busy.alive; i++) await new Promise((r) => setTimeout(r, 20)); // killed, not kept warm
  assert.equal(busy.alive, false);
  // A thread whose sandbox is not Angelia's is refused.
  const wrong = make('acceptEdits', false, { FAKE_CODEX_WRONG_PROFILE: '1' });
  assert.match(((await collect(wrong, 'hi'))[0] as any).reason, /^refused: Codex applied the permission profile :workspace/);
});

test('orchestrator: a codex chat takes the id Codex minted and resumes it after /stop', async (t) => {
  const cfg = Config.parse({ profiles: { c: { cwd: here, backend: 'codex' } }, routes: [{ platform: 'telegram', chat: 4, profile: 'c' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } }, whatsapp: { send: async () => {} } },
    { stateDir: mkdtempSync(join(tmpdir(), 'angelia-cx-o-')), bins: { codex: FAKE } });
  t.after(() => o.shutdown());
  const dm = (text: string): Inbound => ({ platform: 'telegram', chat: '4', sender: 'u1', text, isGroup: false, mentioned: false, media: [] });
  await o.handle(dm('hi'));
  assert.match(sent[0], /^echo: /);
  const row = o.map.getActive('telegram:4')!;
  assert.match(row.id, /^thr-/); assert.ok(row.started); assert.equal(row.backend, 'codex');
  await o.handle(dm('/stop'));
  await o.handle(dm('ARGS'));
  assert.equal(JSON.parse(sent.at(-1)!).threadParams.threadId, row.id);
  assert.equal(o.map.getActive('telegram:4')!.id, row.id);
});

test('codex: compile writes the floor as /abs and makes .codex/ and .agents/ read-only; its login is in the floor; export reads rollouts', () => {
  assert.equal(pathRule('Read', '/h/.ssh/**', 'codex', '/h'), 'Read(/h/.ssh/**)');
  assert.deepEqual(CODEX_LAUNCH_DIRS, [join('.codex', '**'), join('.agents', '**')]);
  const cfg = Config.parse({ profiles: { c: { cwd: '/w/c', backend: 'codex' } }, routes: [] });
  assert.ok(profileFloor(cfg, 'c', '/state', '/h').includes('Read(/h/.codex/auth.json)'));

  const home = mkdtempSync(join(tmpdir(), 'angelia-cx-home-'));
  const saved = process.env.CODEX_HOME; delete process.env.CODEX_HOME;
  try {
    const day = join(home, '.codex', 'sessions', '2026', '09', '25');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-2026-09-25T14-50-16-thr-1.jsonl'), [
      { type: 'session_meta', payload: { id: 'thr-1' } },
      { type: 'response_item', timestamp: 't0', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'SELF' }] } },
      { type: 'response_item', timestamp: 't0', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /w/c' }, { type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
      { type: 'response_item', timestamp: 't1', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
      { type: 'response_item', timestamp: 't2', payload: { type: 'custom_tool_call', name: 'exec' } },
      { type: 'response_item', timestamp: 't3', payload: { type: 'custom_tool_call_output', output: 'OUTPUT' } },
      { type: 'response_item', timestamp: 't4', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert.ok(codexSessionFile('thr-1', home)?.endsWith('-thr-1.jsonl'));
    const cfg2 = Config.parse({ profiles: { c: { cwd: '/w/c', backend: 'codex' } }, routes: [{ platform: 'telegram', chat: '7', profile: 'c' }] });
    const rows = exportChat(cfg2, { chats: { 'telegram:7': { active: 'thr-1', history: [{ id: 'thr-1', backend: 'codex' }] } } } as any, 'telegram:7', { home });
    assert.deepEqual(rows.map((r) => [r.role, r.text, r.tools]), [['user', 'hello', undefined], ['assistant', 'done', ['exec']]]);
    assert.equal(codexRows(codexSessionFile('thr-1', home), { chat: 'c', profile: 'c', backend: 'codex', session: 'thr-1' }, true).filter((r) => r.role === 'tool')[0].text, 'OUTPUT');
  } finally { if (saved !== undefined) process.env.CODEX_HOME = saved; }
});

test('config: a group open to everyone on bypass is allowed for a sandboxed Codex profile, refused with sandbox: false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-cx-cfg-'));
  const write = (sandbox?: boolean) => {
    const path = join(dir, `routing-${sandbox}.yaml`);
    writeFileSync(path, stringify({ profiles: { c: { cwd: dir, backend: 'codex', permission_mode: 'bypassPermissions', ...(sandbox === undefined ? {} : { sandbox }) } }, routes: [{ platform: 'whatsapp', chat: '3@g.us', profile: 'c', allow_from: ['*'] }], whatsapp: {} }));
    return path;
  };
  assert.doesNotThrow(() => loadConfig(write()));
  assert.throws(() => loadConfig(write(false)), ConfigError);
});

test('codex: in plan mode nothing asks and the profile is read-only; Codex\'s merged config cannot loosen it', async () => {
  const p = make('plan');
  const { argv, threadParams } = JSON.parse(((await collect(p, 'ARGS'))[0] as any).text);
  assert.equal(threadParams.approvalPolicy, 'never');
  assert.ok(argv.includes('permissions.angelia.extends=":read-only"'));
  assert.match(threadParams.developerInstructions, /plan mode: you only read/);
  await p.stop();
  const lay = make('acceptEdits', false, { FAKE_CODEX_LAYER_PERMS: '1' });
  assert.match(((await collect(lay, 'hi'))[0] as any).reason, /^refused: a Codex config layer \(\/Users\/example\/\.codex\/config\.toml\) sets permissions\.angelia/);
  const dir = mkdtempSync(join(tmpdir(), 'angelia-cx-mcp-'));
  mkdirSync(join(dir, '.claude'));
  const mcp = make('acceptEdits', false, { FAKE_CODEX_MCP_ON: 'bank' }, { cwd: dir });
  assert.match(((await collect(mcp, 'hi'))[0] as any).reason, /^refused: MCP servers this profile was not given would load: bank/);
  // A server the last compile gave the profile may load.
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'angelia-compiled.json'), JSON.stringify({ version: 1, backend: 'codex', links: {}, mcpServers: ['bank'], mcpStrict: false, deny: [], additionalDirectories: [], blockLines: [], compiledAt: 'x' }));
  const given = make('acceptEdits', false, { FAKE_CODEX_MCP_ON: 'bank' }, { cwd: dir });
  assert.deepEqual(await collect(given, 'hi'), [{ kind: 'result', text: 'echo: hi', isError: false }]);
  await given.stop();
});

test('codex: compile links skills into .agents/skills, warns about an AGENTS.md, and the launch guard refuses once the table turns the sandbox off', () => {
  const root = mkdtempSync(join(tmpdir(), 'angelia-cx-comp-'));
  const cwd = join(root, 'p'), skill = join(root, 'skills', 'maps'), state = join(root, 'state');
  mkdirSync(cwd, { recursive: true }); mkdirSync(skill, { recursive: true }); writeFileSync(join(skill, 'SKILL.md'), '---\nname: maps\n---\n');
  writeFileSync(join(cwd, 'AGENTS.md'), '# old\n');
  const table = (sandbox?: boolean) => Config.parse({ capabilities: { maps: { kind: 'skill', path: skill } }, profiles: { p: { cwd, backend: 'codex', capabilities: ['maps'], ...(sandbox === undefined ? {} : { sandbox }) } }, routes: [] });
  const pl = planProfile(table(), 'p', { home: join(root, 'h'), stateDir: state });
  assert.ok(pl.changes.includes(`+ skill link maps → ${skill}`));
  assert.ok(pl.notes.some((n) => /has an AGENTS\.md, which Codex reads instead of CLAUDE\.md/.test(n)));
  pl.apply();
  assert.ok(existsSync(join(cwd, '.agents', 'skills', 'maps', 'SKILL.md')));
  assert.deepEqual(launchCheck(table(), 'p', state), []);
  assert.deepEqual(launchCheck(table(false), 'p', state).map((x) => x.slice(0, 11)), ['sandbox off']);
  const other = Config.parse({ profiles: { p: { cwd, backend: 'claude-code' } }, routes: [] });
  assert.deepEqual(launchCheck(other, 'p', state), ['compiled for codex, not claude-code; compile again']);
});

test('config: a Codex profile without its sandbox counts as unasked for an open group; a folder this process may not look at is not a broken table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-cx-cfg2-'));
  const path = join(dir, 'routing.yaml');
  writeFileSync(path, stringify({ profiles: { c: { cwd: dir, backend: 'codex', permission_mode: 'acceptEdits', sandbox: false } }, routes: [{ platform: 'whatsapp', chat: '3@g.us', profile: 'c', allow_from: ['*'] }], whatsapp: {} }));
  assert.throws(() => loadConfig(path), /without a sandbox/);
  const locked = join(dir, 'locked'), inner = join(locked, 'p');
  mkdirSync(inner, { recursive: true });
  writeFileSync(path, stringify({ profiles: { c: { cwd: inner, backend: 'codex' } }, routes: [], whatsapp: {} }));
  chmodSync(locked, 0o000);
  const was = process.env.CODEX_SANDBOX;
  try {
    assert.throws(() => loadConfig(path), /not a directory/, 'outside the sandbox an unreadable cwd is still an error');
    process.env.CODEX_SANDBOX = 'seatbelt';
    assert.doesNotThrow(() => loadConfig(path));
  } finally { chmodSync(locked, 0o755); if (was === undefined) delete process.env.CODEX_SANDBOX; else process.env.CODEX_SANDBOX = was; }
});

test('codex: a Codex that never answers fails the turn with a reason instead of leaving the chat on typing', async () => {
  const saved = CodexBrain.startTimeoutMs; CodexBrain.startTimeoutMs = 300;
  try {
    const h = make('acceptEdits', false, { FAKE_CODEX_HANG: '1' });
    const ev = await collect(h, 'hi');
    assert.equal(ev.length, 1); assert.equal((ev[0] as any).isError, true);
    assert.match((ev[0] as any).reason, /did not answer within 0 s of starting; check that `codex --version` runs/);
    for (let i = 0; i < 50 && h.alive; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.alive, false, 'the hung child is ended');
  } finally { CodexBrain.startTimeoutMs = saved; }
});
