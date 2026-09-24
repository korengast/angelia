#!/usr/bin/env node
// Fake `claude -p --input-format stream-json` for tests.
// Per user message: system/init, optional progress, optional permission round-trip, result.
//   text contains "PROGRESS" -> an assistant text block, then a tool_use block, then the result
//   text contains "TAILTEXT" -> an assistant text block immediately followed by the result (must not be emitted as progress)
//   text contains "PERM"     -> a can_use_tool control_request; result reports allow/deny
//   text contains "CRASH"    -> exit 1 mid-turn
//   text contains "EMPTY"    -> empty result
//   text contains "SLOW"     -> the answer takes 3s, so a turn can be interrupted mid-flight
//   text contains "BUSYTURN" -> forty progress lines, then the answer
//   text contains "ENVDUMP"  -> the answer lists the canary variables it can see (CANARY_*, the bot token, API keys)
// env FAKE_CLAUDE_APIKEY=1  -> apiKeySource "ANTHROPIC_API_KEY" (billing refusal test)
// env FAKE_CLAUDE_VERSION   -> claude_code_version override
import { createInterface } from 'node:readline';

const sid = process.argv.includes('--session-id') ? process.argv[process.argv.indexOf('--session-id') + 1]
          : process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : 'no-session';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let inited = false;
const init = () => { if (inited) return; inited = true; out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(),
      apiKeySource: process.env.FAKE_CLAUDE_APIKEY ? 'ANTHROPIC_API_KEY' : 'none',
      claude_code_version: process.env.FAKE_CLAUDE_VERSION || '2.1.270',
      permissionMode: 'acceptEdits', model: 'fake', tools: [], mcp_servers: [] }); };

let pending = null; // permission request awaiting a control_response
let initialized = false; // like the real CLI: no initialize handshake, no permission requests (tools are denied)
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    initialized = true;
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [] } } });
    return;
  }
  if (msg.type === 'control_response') {
    const behavior = msg.response?.response?.behavior ?? 'deny';
    // The CLI runs the tool with updatedInput, so an allow must carry the request's own input back.
    const ran = msg.response?.response?.updatedInput?.command;
    const said = `tool ${behavior}ed${behavior === 'allow' ? `: ${ran ?? 'no command'}` : ''}`;
    out({ type: 'assistant', message: { content: [{ type: 'text', text: said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, session_id: sid });
    pending = null;
    return;
  }
  if (msg.type !== 'user') return;
  init();
  const text = String(msg.message?.content ?? '');
  if (text.includes('CRASH')) process.exit(1);
  if (text.includes('PROGRESS')) {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  }
  if (text.includes('BUSYTURN')) {
    // A busy turn: forty lines of commentary, then the answer, which the CLI also sends as text.
    for (let n = 1; n <= 40; n++) out({ type: 'assistant', message: { content: [{ type: 'text', text: `step ${n}` }] } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'final answer' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'final answer', session_id: sid });
    return;
  }
  if (text.includes('TAILTEXT')) {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'final words' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'final words', session_id: sid });
    return;
  }
  if (text.includes('PERM') && !initialized) {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'I did it (made up)' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'I did it (made up)', session_id: sid, permission_denials: [{ tool_name: 'Bash' }] });
    return;
  }
  if (text.includes('PERM')) {
    pending = '6b480a6f-d386-4972-95d9-2eeaef82f3bc';
    out({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_name: 'Bash',
          input: { command: 'rm -rf /tmp/x' }, description: 'remove x' } });
    return;
  }
  if (text.includes('SLOW')) {
    setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: 'slow answer', session_id: sid }), 3000);
    return;
  }
  if (text.includes('LIMIT')) {
    const limit = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage, to continue.";
    out({ type: 'result', subtype: 'success', is_error: true, result: limit, session_id: sid });
    return;
  }
  if (text.includes('ENVDUMP')) {
    // Values only for CANARY_*: a real token in the test runner's environment must never be printed.
    // ANGELIA_API_TOKEN is always a test's own: a chat-scoped token derived from a throwaway owner token.
    const seen = Object.keys(process.env).filter((k) => /^CANARY_|^TELEGRAM_BOT_TOKEN$|^ANTHROPIC_API_KEY$|^ANGELIA_API_TOKEN$/.test(k)).sort().map((k) => (/^CANARY_|^ANGELIA_API_TOKEN$/.test(k) ? `${k}=${process.env[k]}` : k));
    out({ type: 'result', subtype: 'success', is_error: false, result: `env: ${seen.join(' ') || 'none'}`, session_id: sid });
    return;
  }
  const result = text.includes('EMPTY') ? '' : process.env.FAKE_CLAUDE_ECHO_ARGV ? `argv: ${process.argv.slice(2).join(' ')}` : `echo: ${text}`;
  out({ type: 'assistant', message: { content: [{ type: 'text', text: result }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result, session_id: sid });
});
rl.on('close', () => process.exit(0));
