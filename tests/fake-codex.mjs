#!/usr/bin/env node
// Fake `codex app-server` (JSON-RPC, one object per line). Shapes copied from codex-cli 0.157.0 on 2026-09-25.
//   text contains "PROGRESS"  -> a message, a command item, then the answer
//   text contains "PERM"      -> item/commandExecution/requestApproval; answer says whether it was accepted
//   text contains "EDIT"      -> a fileChange item, then item/fileChange/requestApproval
//   text contains "PERM" and "MORE" -> the approval also carries additionalPermissions (a folder)
//   text contains "ESCALATE"  -> item/permissions/requestApproval for a folder; answer echoes what was granted
//   text contains "ASKUSER"   -> item/tool/requestUserInput; answer echoes the reply
//   text contains "FAIL"      -> turn/completed with status failed
//   text contains "CRASH"     -> exit 1 mid-turn
//   text contains "SEP"       -> an answer with U+2028 inside the JSON string
//   text contains "ARGS"      -> the answer is this process's argv and the thread params, as JSON
//   text contains "RESOLVE"   -> an approval request Codex then settles itself (serverRequest/resolved)
//   "/compact"                -> thread/compact/start, then a compaction turn (as real 0.157.0: no thread/compacted)
//   env FAKE_CODEX_HANG=1      -> never answers anything (a binary that does not start)
//   env FAKE_CODEX_BUSY=1      -> thread/resume fails: the thread has another writer
//   env FAKE_CODEX_WRONG_PROFILE=1 -> the thread reports a permission profile other than Angelia's
//   env FAKE_CODEX_LAYER_PERMS=1  -> config/read shows the owner's config setting permissions.angelia
//   env FAKE_CODEX_MCP_ON=<name>  -> config/read shows that MCP server still enabled
//   env FAKE_CODEX_NO_RESUME=1 -> thread/resume fails (the thread is gone)
//   env FAKE_CODEX_VERSION     -> the version in initialize's userAgent (default 0.157.0)
import { randomUUID } from 'node:crypto';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const note = (method, params) => out({ method, params });
let threadId = null, threadParams = null, reqId = 5000, turnNo = 0, tid = 't0';
const sandboxed = process.argv.includes('default_permissions="angelia"');
/** The thread fields real Codex returns about what it applied. */
const applied = (p) => ({
  activePermissionProfile: process.env.FAKE_CODEX_WRONG_PROFILE ? { id: ':workspace', extends: null } : sandboxed ? { id: 'angelia', extends: ':workspace' } : { id: ':danger-full-access', extends: null },
  sandbox: p.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite' },
  approvalsReviewer: p.approvalsReviewer ?? 'auto_review',
});
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = reqId++; waiting.set(id, resolve); out({ id, method, params }); });
const msg = (text) => note('item/completed', { threadId, turnId: tid, item: { type: 'agentMessage', id: randomUUID(), text } });
const done = (status = 'completed', error = null) => note('turn/completed', { threadId, turn: { id: tid, status, error } });

async function turn(text) {
  if (text.includes('CRASH')) { process.stderr.write('codex: stream disconnected before completion\n'); process.exit(1); }
  if (text.includes('FAIL')) return done('failed', { message: 'You have hit your usage limit.' });
  if (text.includes('PROGRESS')) {
    msg('working on it');
    note('item/started', { threadId, item: { type: 'commandExecution', id: 'c1', command: 'ls', status: 'inProgress' } });
    note('item/completed', { threadId, item: { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed', exitCode: 0 } });
    msg('all done'); return done();
  }
  if (text.includes('PERM')) {
    note('item/started', { threadId, item: { type: 'commandExecution', id: 'c2', command: 'touch /elsewhere/x', status: 'inProgress' } });
    const more = text.includes('MORE') ? { additionalPermissions: { network: null, fileSystem: { read: null, write: ['/elsewhere'], entries: [{ path: { type: 'path', path: '/elsewhere' }, access: 'write' }] } } } : {};
    const r = await ask('item/commandExecution/requestApproval', { kind: 'command', threadId, turnId: tid, itemId: 'c2', startedAtMs: 0, environmentId: null, command: 'touch /elsewhere/x', reason: 'write outside the workspace', ...more });
    msg(r.decision === 'accept' ? 'tool allowed' : 'tool denied'); return done();
  }
  if (text.includes('EDIT')) {
    note('item/started', { threadId, item: { type: 'fileChange', id: 'f1', changes: [{ path: '/elsewhere/a.txt', kind: { type: 'add' }, diff: '+hi' }], status: 'inProgress' } });
    const r = await ask('item/fileChange/requestApproval', { threadId, turnId: tid, itemId: 'f1', startedAtMs: 0, reason: null });
    msg(r.decision === 'accept' ? 'edit allowed' : 'edit denied'); return done();
  }
  if (text.includes('ESCALATE')) {
    const r = await ask('item/permissions/requestApproval', { threadId, turnId: tid, itemId: 'p1', environmentId: 'local', startedAtMs: 0, cwd: '/w', reason: 'copy notes.md there', permissions: { network: null, fileSystem: { read: null, write: ['/Users/example/Downloads'], entries: [{ path: { type: 'path', path: '/Users/example/Downloads' }, access: 'write' }] } } });
    msg(`granted: ${JSON.stringify(r)}`); return done();
  }
  if (text.includes('ASKUSER')) { const r = await ask('item/tool/requestUserInput', { threadId, turnId: tid, itemId: 'u1', questions: [] }); msg(`answered: ${JSON.stringify(r)}`); return done(); }
  if (text.includes('SEP')) { msg('one two'); return done(); }
  if (text.includes('ARGS')) { msg(JSON.stringify({ argv: process.argv.slice(2), threadParams, npmCache: process.env.npm_config_cache ?? null })); return done(); }
  if (text.includes('RESOLVE')) {
    const id = reqId++;
    out({ id, method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId, turnId: tid, itemId: 'c9', startedAtMs: 0, environmentId: null, command: 'touch /x' } });
    note('serverRequest/resolved', { threadId, requestId: id });
    msg('settled by codex'); return done();
  }
  msg(`echo: ${text}`); done();
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (s) => {
  if (process.env.FAKE_CODEX_HANG) return;
  buf += s;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.id !== undefined && m.method === undefined) { const k = waiting.get(m.id); waiting.delete(m.id); k?.(m.result ?? m.error); continue; }
    const reply = (result) => out({ id: m.id, result });
    if (m.method === 'initialize') reply({ userAgent: `angelia/${process.env.FAKE_CODEX_VERSION ?? '0.157.0'} (Mac OS; x86_64)`, codexHome: '/x', platformFamily: 'unix', platformOs: 'macos' });
    else if (m.method === 'model/list') reply({ data: [{ id: 'gpt-other', isDefault: false }, { id: 'gpt-fake', isDefault: true }] });
    else if (m.method === 'thread/start') { threadId = 'thr-' + randomUUID(); threadParams = m.params; reply({ thread: { id: threadId }, model: m.params.model, ...applied(m.params) }); note('thread/started', { thread: { id: threadId } }); }
    else if (m.method === 'thread/resume') {
      if (process.env.FAKE_CODEX_NO_RESUME) out({ id: m.id, error: { code: -32600, message: `no rollout found for thread id ${m.params.threadId}` } });
      else if (process.env.FAKE_CODEX_BUSY) out({ id: m.id, error: { code: -32600, message: `thread ${m.params.threadId} already has an active writer` } });
      else { threadId = m.params.threadId; threadParams = m.params; reply({ thread: { id: threadId }, model: m.params.model, ...applied(m.params) }); }
    }
    else if (m.method === 'turn/start') { tid = `t${++turnNo}`; reply({ turn: { id: tid, status: 'inProgress' } }); note('turn/started', { threadId, turn: { id: tid } }); void turn(m.params.input.map((x) => x.text ?? '').join('')); }
    else if (m.method === 'config/read') reply({
      config: { mcp_servers: process.env.FAKE_CODEX_MCP_ON ? { [process.env.FAKE_CODEX_MCP_ON]: { command: 'x', enabled: true } } : {} },
      origins: {},
      layers: [{ name: { type: 'sessionFlags' }, config: { permissions: { angelia: { extends: ':workspace' } } } },
        { name: { type: 'user', file: '/Users/example/.codex/config.toml' }, config: process.env.FAKE_CODEX_LAYER_PERMS ? { permissions: { angelia: { network: { dangerously_allow_all_unix_sockets: true } } } } : {} }],
    });
    else if (m.method === 'thread/compact/start') {
      reply({});
      note('turn/started', { threadId, turn: { id: 'k1' } });
      note('item/started', { threadId, item: { type: 'contextCompaction', id: 'k1i' } });
      note('item/completed', { threadId, item: { type: 'contextCompaction', id: 'k1i' } });
      note('turn/completed', { threadId, turn: { id: 'k1', status: 'completed', error: null } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
