#!/usr/bin/env node
// Fake `agy acp` (Antigravity CLI over ACP, JSON-RPC 2.0). Shapes copied from agy 1.5.14 on 2026-11-21.
//   argv must hold `acp --gemini-dir <dir>`; it is written to $FAKE_AGY_ARGV_LOG when set
//   text contains "PROGRESS" -> message chunks, a run_command tool_call, more chunks, end_turn
//   text contains "PERM"     -> session/request_permission for run_command; allowed: "tool allowed"; rejected: the turn ends with no text (as agy does)
//   text contains "TWICE"    -> two permission requests in one turn (run_command, then write_file); a reject of either ends silent
//   text "ASK <tool> <json rawInput>" -> one permission request for that tool; allowed: "ran <tool>"; rejected: silent
//   text "WAKE"              -> "started" ends the turn; 150 ms later, with no prompt open, a message "BGDONE"
//   text "WAKEASK <tool> <json>" -> ends the turn; then a permission request between turns, and a message
//                               "after: allowed" or "after: refused" by its answer
//   text contains "SUBAGENT" -> an invoke_subagent tool_call that asks nothing, then "delegated"
//   text "CHILD" / "CHILD-LOST" -> invoke_subagent; "delegated" ends the turn. CHILD writes the subagent's
//                               conversation (naming this session) under <gemini-dir>/antigravity-cli/conversations;
//                               once the client resumes it, the subagent asks write_file (its own session id),
//                               says "child text", and the parent says "subagent: allowed" or "subagent: refused".
//                               CHILD-LOST writes nothing (the client cannot find it).
//   text contains "MODE?"    -> answers with the mode last set by session/set_mode
//   text contains "CRASH"    -> exit 1 mid-turn
//   text contains "MODEL?"   -> answers with the model last set by session/set_model
//   env FAKE_AGY_SILENT=1    -> never answers initialize
//   env FAKE_AGY_NO_RESUME=1 -> session/resume answers with an error (then the client must use session/load)
//   env FAKE_AGY_NO_RESUME_CAP=1 -> initialize does not advertise resume
//   env FAKE_AGY_BAD_MODEL=<id> -> session/set_model of that id is an error
//   env FAKE_AGY_NO_AUTH=1   -> session/new answers "Authentication required" (no login)
//   env FAKE_AGY_LOG=<file>  -> each session method and its session id is appended to the file
//   env FAKE_AGY_SESSION_CHILD=<file> -> at start runs a command in a new session (as agy's PTY shell does) and writes its pid there
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const fail = (id, message) => out({ jsonrpc: '2.0', id, error: { code: -32000, message } });
const update = (sessionId, u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const chunk = (sid, text) => update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const log = (line) => { if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, line + '\n'); };
if (process.env.FAKE_AGY_SESSION_CHILD) {
  const { spawn } = await import('node:child_process');
  // detached: a new session and process group, which a kill of agy's own group does not reach.
  const c = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
  writeFileSync(process.env.FAKE_AGY_SESSION_CHILD, String(c.pid));
}
if (process.env.FAKE_AGY_ARGV_LOG) appendFileSync(process.env.FAKE_AGY_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
const gd = process.argv.indexOf('--gemini-dir');
if (process.argv[2] !== 'acp' || gd < 0 || !process.argv[gd + 1]) { process.stderr.write('fake-agy: want acp --gemini-dir <dir>\n'); process.exit(2); }
const gemini = process.argv[gd + 1];
const children = new Set(), grand = new Set();
let sid = null, model = 'gemini-4-hydrogen', mode = 'default', reqId = 1000; const waiting = new Map();
const models = { availableModels: ['gemini-4-hydrogen', 'gemini-4-neon', 'gemini-3.8-flash', 'gemini-9'].flatMap((b) => ['low', 'medium', 'high', 'xhigh'].map((l) => ({ modelId: `${b}-${l}`, name: `${b} (${l})` }))), currentModelId: 'gemini-4-neon-high' };
const noise = () => {
  update(sid, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'goal', description: 'Run until done.' }] });
  update(sid, { sessionUpdate: 'usage_update', used: 0, size: 1048576 });
};
const tool = (id, name, rawInput, title, kind) => ({ toolCallId: id, name, args: rawInput, status: 'pending', kind, title, rawInput });
const ask = (tc, then) => {
  const id = reqId++;
  update(sid, { sessionUpdate: 'tool_call', ...tc, status: 'in_progress' });
  // FAKE_AGY_ALWAYS_ONLY: offers only "allow always", which Angelia must never pick.
  const allowOpt = process.env.FAKE_AGY_ALWAYS_ONLY ? { optionId: 'always', name: 'Always', kind: 'allow_always' } : { optionId: 'allow', name: 'Allow', kind: 'allow_once' };
  out({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: sid, toolCall: { sessionUpdate: 'tool_call', ...tc }, options: [
    allowOpt, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } });
  waiting.set(id, (outcome) => {
    const ok = outcome?.outcome === 'selected' && (outcome.optionId === 'allow' || outcome.optionId === 'always');
    update(sid, { sessionUpdate: 'tool_call_update', ...tc, status: ok ? 'completed' : 'failed' });
    then(ok);
  });
};
const handle = (m) => {
  if (m.method === 'initialize' && process.env.FAKE_AGY_SILENT) return;
  if (m.method === 'initialize') {
    const sessionCapabilities = process.env.FAKE_AGY_NO_RESUME_CAP ? { load: {}, close: {}, list: {} } : { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} };
    return reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities }, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.14' } });
  }
  if (m.method === 'session/new' && process.env.FAKE_AGY_NO_AUTH) return fail(m.id, 'Authentication required');
  if (m.method === 'session/new') { sid = randomUUID(); log(`new ${sid}`); reply(m.id, { sessionId: sid, models }); return noise(); }
  if (m.method === 'session/resume' && children.has(m.params.sessionId)) {
    const cid = m.params.sessionId, parent = sid;
    log(`resume-child ${cid}`);
    reply(m.id, { sessionId: cid, models });
    // FAKE_AGY_GRANDCHILD: the first subagent starts one of its own, named only in its conversation file.
    if (process.env.FAKE_AGY_GRANDCHILD && !grand.size) {
      const gid = randomUUID(); children.add(gid); grand.add(gid);
      writeFileSync(join(gemini, 'antigravity-cli', 'conversations', `${gid}.db`), `SQLite parent ${cid} steps`);
      update(cid, { sessionUpdate: 'tool_call', ...tool('call_g', 'invoke_subagent', { Role: 'Helper' }, 'Run invoke_subagent', 'other'), status: 'in_progress' });
    }
    const tc = { toolCallId: 'call_child', name: 'write_file', rawInput: { Path: join(gemini, 'child.txt'), Content: 'x' }, kind: 'edit', title: 'Write child.txt', status: 'pending' };
    const id = reqId++;
    out({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: cid, toolCall: { sessionUpdate: 'tool_call', ...tc }, options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } });
    waiting.set(id, (outcome) => {
      const ok = outcome?.outcome === 'selected' && outcome.optionId === 'allow';
      update(cid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child text' } });
      chunk(parent, ok ? 'subagent: allowed' : 'subagent: refused');
    });
    return;
  }
  if (m.method === 'session/resume') {
    log(`resume ${m.params.sessionId}`);
    if (process.env.FAKE_AGY_NO_RESUME) return fail(m.id, 'session not found');
    sid = m.params.sessionId;
    update(sid, { sessionUpdate: 'session_info_update', title: 'Earlier chat' });
    return reply(m.id, { models });
  }
  if (m.method === 'session/load') {
    log(`load ${m.params.sessionId}`);
    sid = m.params.sessionId;
    update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } });
    chunk(sid, 'replayed history');
    return reply(m.id, { models });
  }
  if (m.method === 'session/set_model') {
    log(`set_model ${m.params.modelId}`);
    if (process.env.FAKE_AGY_BAD_MODEL === m.params.modelId) return fail(m.id, `unknown model ${m.params.modelId}`);
    model = m.params.modelId;
    update(sid, { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: model.replace(/-(low|medium|high|xhigh)$/, '') }] });
    return reply(m.id, {});
  }
  if (m.method === 'session/set_mode') {
    log(`set_mode ${m.params.modeId}`);
    if (!['default', 'accept-edits', 'auto', 'plan'].includes(m.params.modeId)) return fail(m.id, `unknown mode ${m.params.modeId}`);
    mode = m.params.modeId;
    return reply(m.id, {});
  }
  if (m.method === 'session/close') { log(`close ${m.params.sessionId}`); return reply(m.id, {}); }
  if (m.id !== undefined && m.method === undefined && waiting.has(m.id)) { const k = waiting.get(m.id); waiting.delete(m.id); return k(m.result?.outcome); }
  if (m.method !== 'session/prompt') return;
  const text = m.params.prompt.map((p) => p.text ?? '').join('');
  const end = () => { update(sid, { sessionUpdate: 'usage_update', used: 9713, size: 1048576 }); reply(m.id, { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }); };
  const finish = (t) => { chunk(sid, t); end(); };
  update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about it' } });
  if (text.includes('CRASH')) { process.stderr.write('agy: you are not logged in\n'); process.exit(1); }
  if (text.includes('MODEL?')) return finish(`model ${model}`);
  if (text.includes('MODE?')) return finish(`mode ${mode}`);
  const asked = /^(WAKEASK|ASK) (\S+) (.*)$/s.exec(text);
  if (asked) {
    const tc = tool(`call_${reqId}`, asked[2], JSON.parse(asked[3]), asked[2], 'other');
    if (asked[1] === 'ASK') return ask(tc, (ok) => (ok ? finish(`ran ${asked[2]}`) : end()));
    finish('started');
    return setTimeout(() => ask(tc, (ok) => chunk(sid, ok ? 'after: allowed' : 'after: refused')), 150);
  }
  if (text.includes('CHILD')) {
    const tc = tool('call_s', 'invoke_subagent', { Role: 'Writer', TypeName: 'self' }, 'Run invoke_subagent', 'other');
    const write = () => {
      if (text.includes('CHILD-LOST')) return;
      const cid = randomUUID(); children.add(cid);
      const dir = join(gemini, 'antigravity-cli', 'conversations'); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${randomUUID()}.db`), 'another conversation');
      writeFileSync(join(dir, `${cid}.db`), `SQLite parent ${sid} steps`);
    };
    // FAKE_AGY_CHILD_FIRST: the subagent's conversation is on disk before the client gets the
    // invoke_subagent line, as on a loaded machine.
    if (process.env.FAKE_AGY_CHILD_FIRST) {
      write();
      return setTimeout(() => {
        update(sid, { sessionUpdate: 'tool_call', ...tc, status: 'in_progress' });
        update(sid, { sessionUpdate: 'tool_call_update', ...tc, status: 'completed' });
        finish('delegated');
      }, 300);
    }
    update(sid, { sessionUpdate: 'tool_call', ...tc, status: 'in_progress' });
    write();
    update(sid, { sessionUpdate: 'tool_call_update', ...tc, status: 'completed' });
    return finish('delegated');
  }
  if (text.includes('SUBAGENT')) {
    update(sid, { sessionUpdate: 'tool_call', ...tool('call_s', 'invoke_subagent', { Prompt: 'go' }, 'Subagent: go', 'other'), status: 'in_progress' });
    return finish('delegated');
  }
  if (text.includes('WAKE')) {
    finish('started');
    return setTimeout(() => { update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'bg_1', status: 'completed' }); chunk(sid, 'The background command finished: '); chunk(sid, 'BGDONE'); }, 150);
  }
  if (text.includes('PROGRESS')) {
    chunk(sid, 'working '); chunk(sid, 'on it');
    const tc = tool('call_1', 'run_command', { CommandLine: 'ls', WaitMsBeforeAsync: 5000, toolSummary: 'List' }, 'ls', 'execute');
    update(sid, { sessionUpdate: 'tool_call', ...tc, status: 'in_progress' });
    update(sid, { sessionUpdate: 'tool_call_update', ...tc, status: 'completed' });
    return finish('all done');
  }
  if (text.includes('TWICE')) {
    return ask(tool('call_a', 'run_command', { CommandLine: 'date > a.txt' }, 'date > a.txt', 'execute'), (ok) => {
      if (!ok) return end();
      ask(tool('call_b', 'write_file', { Path: '/tmp/b.txt', Content: 'b' }, 'Write b.txt', 'edit'), (ok2) => (ok2 ? finish('both ran') : end()));
    });
  }
  if (text.includes('PERM')) {
    return ask(tool('call_8204146495325518175', 'run_command', { CommandLine: 'rm -rf /tmp/x', WaitMsBeforeAsync: 5000, toolSummary: 'Remove x' }, 'rm -rf /tmp/x', 'execute'), (ok) => (ok ? finish('tool allowed') : end()));
  }
  finish(`echo: ${text}`);
};
createInterface({ input: process.stdin }).on('line', (line) => handle(JSON.parse(line)));
process.stdin.on('close', () => process.exit(0));
