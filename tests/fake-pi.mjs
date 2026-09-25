#!/usr/bin/env node
// Fake `pi --mode rpc`. Shapes copied from pi 0.86.1 on 2026-09-25. It loads the real gate given
// with -e (Node strips its types), so the permission path runs through Angelia's own extension.
//   text contains "PROGRESS" -> text before a tool call, the call, then the answer
//   text contains "PERM"     -> a bash call `rm -rf /tmp/x`, gated; answer says whether it ran
//   text contains "READ:<p>" -> a read call of <p>, gated
//   text contains "DIALOG"   -> a select dialog from some other extension; expects a cancel
//   text contains "ERROR"    -> an assistant message that ended in a provider error
//   text contains "CRASH"    -> exit 1 mid-turn
//   text contains "SEP"      -> an answer with U+2028 inside the JSON string
//   text contains "ARGV"     -> the answer is this process's argv as JSON
//   text "/hello"            -> an extension command: accepted, a notify, and no run (answers get_state)
//   text "LATE" / "LATE?"    -> a select dialog sent after the turn settled / whether it was cancelled
//   text contains "TIMEOUT"  -> a bash call; the answer is the timeout the gate gave it
//   text contains "TOOLS"    -> the answer is the active tool list after the gate's session_start
//   {type:"compact"}         -> a compact response with token counts
//   env FAKE_PI_BUSY_ONCE=1  -> the first get_state says compaction is running
//   env FAKE_PI_LOST=1       -> stderr says the session was not found (a resume that starts fresh)
import { randomUUID } from 'node:crypto';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write(`${process.env.FAKE_PI_VERSION ?? '0.86.1'}\n`); process.exit(0); }
const flag = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (process.env.FAKE_PI_LOST) process.stderr.write(`Warning: No project session found with id '${flag('--session-id')}'; creating a new session with that id.\n`);

const handlers = [];
const waiting = new Map();
const ui = {
  confirm: (title, message) => new Promise((resolve) => { const id = randomUUID(); waiting.set(id, (r) => resolve(!!r.confirmed)); out({ type: 'extension_ui_request', id, method: 'confirm', title, message }); }),
};
const gate = flag('-e');
let active = ['read', 'bash', 'edit', 'write'];
const starts = [];
if (gate) (await import(gate)).default({ on: (ev, fn) => { if (ev === 'tool_call') handlers.push(fn); if (ev === 'session_start') starts.push(fn); }, getActiveTools: () => active, setActiveTools: (t) => { active = t; } });
for (const f of starts) await f({}, {});

const assistant = (content, extra = {}) => ({ type: 'message_end', message: { role: 'assistant', content, stopReason: 'stop', ...extra } });
let lateCancelled = false;
let busyShown = false;
async function tool(name, input) {
  const toolCallId = 'call-' + randomUUID();
  out(assistant([{ type: 'toolCall', id: toolCallId, name, arguments: input }], { stopReason: 'toolUse' }));
  out({ type: 'tool_execution_start', toolCallId, toolName: name, args: input });
  for (const h of handlers) { const r = await h({ toolName: name, toolCallId, input }, { ui, hasUI: true, signal: undefined }); if (r?.block) { out({ type: 'tool_execution_end', toolCallId, toolName: name, isError: true }); return r.reason; } }
  out({ type: 'tool_execution_end', toolCallId, toolName: name, isError: false });
  return 'ran';
}
const settle = () => { out({ type: 'agent_end', messages: [] }); out({ type: 'agent_settled' }); };

async function prompt(m) {
  const text = m.message;
  out({ id: m.id, type: 'response', command: 'prompt', success: true });
  if (text === '/hello') { out({ type: 'extension_ui_request', id: randomUUID(), method: 'notify', message: 'hi from hello' }); return; }
  out({ type: 'agent_start' });
  if (text.includes('CRASH')) { process.stderr.write('pi: no API key found for the selected model\n'); process.exit(1); }
  if (text.includes('ERROR')) { out(assistant([], { stopReason: 'error', errorMessage: '400 Third-party apps now draw from your extra usage' })); return settle(); }
  if (text.includes('PROGRESS')) {
    out(assistant([{ type: 'text', text: 'working on it' }, { type: 'toolCall', id: 'c1', name: 'ls', arguments: {} }], { stopReason: 'toolUse' }));
    out({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'ls', args: {} });
    out({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'ls', isError: false });
    out(assistant([{ type: 'text', text: 'all done' }]));
    return settle();
  }
  if (text.includes('PERM')) { const r = await tool('bash', { command: 'rm -rf /tmp/x' }); out(assistant([{ type: 'text', text: r === 'ran' ? 'tool allowed' : 'tool denied' }])); return settle(); }
  const read = /READ:(\S+)/.exec(text);
  if (read) { const r = await tool('read', { path: read[1] }); out(assistant([{ type: 'text', text: r === 'ran' ? 'read ok' : `read refused: ${r}` }])); return settle(); }
  if (text.includes('DIALOG')) {
    const id = randomUUID();
    await new Promise((resolve) => { waiting.set(id, (r) => resolve(r)); out({ type: 'extension_ui_request', id, method: 'select', title: 'Pick one', options: ['a', 'b'] }); })
      .then((r) => out(assistant([{ type: 'text', text: r.cancelled ? 'dialog cancelled' : 'dialog answered' }])));
    return settle();
  }
  if (text === 'LATE') {
    out(assistant([{ type: 'text', text: 'late dialog sent' }])); settle();
    const id = randomUUID();
    setTimeout(() => { waiting.set(id, (r) => { lateCancelled = !!r.cancelled; }); out({ type: 'extension_ui_request', id, method: 'input', title: 'Name?' }); }, 20);
    return;
  }
  if (text === 'LATE?') { out(assistant([{ type: 'text', text: lateCancelled ? 'late dialog cancelled' : 'late dialog pending' }])); return settle(); }
  if (text.includes('TIMEOUT')) { const input = { command: 'ls' }; await tool('bash', input); out(assistant([{ type: 'text', text: `timeout ${input.timeout}` }])); return settle(); }
  if (text.includes('SEP')) { out(assistant([{ type: 'text', text: 'one two' }])); return settle(); }
  if (text.includes('TOOLS')) { out(assistant([{ type: 'text', text: active.join(',') }])); return settle(); }
  if (text.includes('ARGV')) { out(assistant([{ type: 'text', text: JSON.stringify(argv) }])); return settle(); }
  out(assistant([{ type: 'text', text: `echo: ${text}` }]));
  settle();
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (s) => {
  buf += s;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.type === 'extension_ui_response') { const k = waiting.get(m.id); waiting.delete(m.id); k?.(m); continue; }
    if (m.type === 'prompt') void prompt(m);
    if (m.type === 'compact' && m.customInstructions === 'SMALL') { out({ id: m.id, type: 'response', command: 'compact', success: false, error: 'Nothing to compact (session too small)' }); continue; }
    if (m.type === 'compact') out({ id: m.id, type: 'response', command: 'compact', success: true, data: { summary: m.customInstructions ?? 's', tokensBefore: 150000, estimatedTokensAfter: 32000 } });
    if (m.type === 'get_state') { const busy = process.env.FAKE_PI_BUSY_ONCE && !busyShown; busyShown = true; out({ id: m.id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false, isCompacting: !!busy, pendingMessageCount: 0 } }); }
  }
});
process.stdin.on('end', () => process.exit(0));
