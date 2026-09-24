#!/usr/bin/env node
// Fake `grok agent stdio` (Grok Build over ACP, JSON-RPC 2.0). Shapes copied from grok 1.0.30 on 2026-09-15.
//   text contains "PROGRESS" -> message chunks, a tool_call update, more chunks, end_turn
//   text contains "PERM"     -> session/request_permission (allow_once / reject_once options) before the tool runs; skipped with --always-approve
//   text contains "CRASH"    -> exit 1 mid-turn
//   text contains "FAIL"     -> JSON-RPC error on session/prompt
//   env FAKE_GROK_NO_LOAD=1  -> session/load answers with an error (unknown session)
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const bypass = process.argv.includes('--always-approve');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const update = (sessionId, u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const chunk = (sid, text) => update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
let sid = null, reqId = 1000; const waiting = new Map(); // permission rpc id -> continuation
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'fake-grok', version: '1.0.30' } });
  if (m.method === 'session/new') { sid = 'grok-' + randomUUID(); return reply(m.id, { sessionId: sid, models: { currentModelId: 'grok-4.6' } }); }
  if (m.method === 'session/load') {
    if (process.env.FAKE_GROK_NO_LOAD) return out({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'session not found' } });
    sid = m.params.sessionId; chunk(sid, 'replayed history'); return reply(m.id, { models: { currentModelId: 'grok-4.6' } });
  }
  if (m.id !== undefined && m.method === undefined && waiting.has(m.id)) { const k = waiting.get(m.id); waiting.delete(m.id); return k(m.result?.outcome); }
  if (m.method !== 'session/prompt') return;
  const text = m.params.prompt.map((p) => p.text ?? '').join('');
  if (text.includes('CRASH')) { process.stderr.write('grok: the model is not available on this plan\n'); process.exit(1); }
  if (text.includes('FAIL')) return out({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'model unavailable' } });
  const finish = (t) => { chunk(sid, t); reply(m.id, { stopReason: 'end_turn' }); };
  if (text.includes('PROGRESS')) {
    chunk(sid, 'working '); chunk(sid, 'on it');
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'run_terminal_command', rawInput: { command: 'ls' } });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' });
    return finish('all done');
  }
  if (text.includes('PERM')) {
    const tc = { toolCallId: 'call-7f3a', kind: 'execute', title: 'Execute `rm -rf /tmp/x`', rawInput: { command: 'rm -rf /tmp/x' }, _meta: { 'x.ai/tool': { name: 'run_terminal_command' } } };
    update(sid, { sessionUpdate: 'tool_call', ...tc });
    if (bypass) return finish('tool allowed');
    const id = reqId++;
    out({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: sid, toolCall: tc, options: [
      { optionId: 'always-allow', name: 'Yes, always', kind: 'allow_always' }, { optionId: 'allow', name: 'Yes', kind: 'allow_once' }, { optionId: 'reject', name: 'No', kind: 'reject_once' } ] } });
    waiting.set(id, (outcome) => finish(outcome?.outcome === 'selected' && outcome.optionId === 'allow' ? 'tool allowed' : 'tool denied'));
    return;
  }
  finish(`echo: ${text}`);
});
process.stdin.on('close', () => process.exit(0));
