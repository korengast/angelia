#!/usr/bin/env node
// Fake `claude -p --input-format stream-json` for tests.
// Per user message: system/init, optional progress, optional permission round-trip, result.
//   text contains "PROGRESS" -> an assistant text block, then a tool_use block, then the result
//   text contains "TAILTEXT" -> an assistant text block immediately followed by the result (must not be emitted as progress)
//   text contains "PERM"     -> a can_use_tool control_request; result reports allow/deny
//                               with "PERMQUIET" the result after the answer is empty (Grok Build ends a denied turn so)
//   text contains "CRASH"    -> exit 1 mid-turn
//   text contains "NOLOGIN"  -> the CLI's own row for a lost login, and an error result with its words;
//                               "NOLOGINONCE" only on the first such message, then the echo
//   text contains "BGSTART"  -> a shell command sent to the background; "BGDONE" is its end
//   text contains "APIERR"   -> the same for a server error ("API Error: 500 …")
//   text contains "EMPTY"    -> empty result
//   text contains "LIMITOK"  -> a usage-limit line as an ordinary answer (no error)
//   text contains "SLOW"     -> the answer takes 3s, so a turn can be interrupted mid-flight
//   text contains "HANG"     -> no output at all, ever (a stuck CLI)
//   text contains "GRANDCHILD" -> starts `sleep 300` (a long tool), answers with its pid, then ignores EOF
//   text contains "QUIETWORK" -> system lines (work with no text) every 50 ms until the file
//                               FAKE_CLAUDE_QUIET_GO names exists, then the answer
//   text contains "SEPARATOR" -> the answer holds a raw U+2028 (JSON.stringify leaves it unescaped)
//   text contains "BUSYTURN" -> forty progress lines, then the answer
//   text contains "ENVDUMP"  -> the answer lists the canary variables it can see (CANARY_*, the bot token, API keys)
//   text contains "AUTOMEMORY" -> the answer is CLAUDE_CODE_DISABLE_AUTO_MEMORY as the child sees it
// env FAKE_CLAUDE_APIKEY=1  -> apiKeySource "ANTHROPIC_API_KEY" (billing refusal test)
// env FAKE_CLAUDE_VERSION   -> claude_code_version override
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// `angelia ask`: one question, the prompt on stdin, one JSON result. The answer echoes what the copy
// was started with, so a test can see the flags. "ASKSLOW" answers after 1.5 s, "ASKFAIL" fails.
if (process.argv[process.argv.indexOf('--output-format') + 1] === 'json') {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { prompt += d; });
  process.stdin.on('end', () => {
    const answer = JSON.stringify({ argv: process.argv.slice(2), prompt, cwd: process.cwd() });
    const say = () => process.stdout.write(JSON.stringify(prompt.includes('ASKFAIL')
      ? { type: 'result', is_error: true, result: 'boom' }
      : { type: 'result', subtype: 'success', is_error: false, result: answer }) + '\n');
    if (prompt.includes('ASKSLOW')) setTimeout(say, 1500); else say();
  });
} else {

const sid = process.argv.includes('--session-id') ? process.argv[process.argv.indexOf('--session-id') + 1]
          : process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : 'no-session';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let inited = false;
const init = () => { if (inited) return; inited = true; out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(),
      apiKeySource: process.env.FAKE_CLAUDE_APIKEY ? 'ANTHROPIC_API_KEY' : 'none',
      claude_code_version: process.env.FAKE_CLAUDE_VERSION || '2.1.270',
      permissionMode: 'acceptEdits', model: 'fake', tools: [], mcp_servers: [] }); };

let pending = null; // permission request awaiting a control_response
let quiet = false; // the result after the permission answer says nothing
let why = false; // PERMWHY: a refusal is said with the message it came with
let tries = 0; // PERMLOOP: a refused request is asked again, up to 30 times
let initialized = false; // like the real CLI: no initialize handshake, no permission requests (tools are denied)
const rl = createInterface({ input: process.stdin });
/** Turns answered with an API error so far (NOLOGINONCE fails only the first). */
let apiFailures = 0;

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    initialized = true;
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [] } } });
    return;
  }
  if (msg.type === 'control_response') {
    const behavior = msg.response?.response?.behavior ?? 'deny';
    if (tries > 0 && behavior === 'deny' && tries < 30) {
      pending = `6b480a6f-d386-4972-95d9-${String(++tries).padStart(12, '0')}`;
      out({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: `try ${tries}` } } });
      return;
    }
    tries = 0;
    // The CLI runs the tool with updatedInput, so an allow must carry the request's own input back.
    const ran = msg.response?.response?.updatedInput?.command;
    const said = `tool ${behavior}ed${behavior === 'allow' ? `: ${ran ?? 'no command'}` : why ? `: ${msg.response?.response?.message}` : ''}`;
    if (!quiet) out({ type: 'assistant', message: { content: [{ type: 'text', text: said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: quiet ? '' : said, session_id: sid });
    pending = null; quiet = false; why = false;
    return;
  }
  if (msg.type !== 'user') return;
  init();
  const text = String(msg.message?.content ?? '');
  if (text.includes('CRASH')) process.exit(1);
  if (text.includes('BGSTART')) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_bg1', name: 'Bash', input: { command: 'sleep 100' } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg1', content: 'started' }] }, tool_use_result: { backgroundTaskId: 'b1' } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'started', session_id: sid });
    return;
  }
  if (text.includes('BGDONE')) {
    out({ type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_bg1', status: 'completed' });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sid });
    return;
  }
  if ((text.includes('NOLOGIN') && !(text.includes('NOLOGINONCE') && apiFailures > 0)) || text.includes('APIERR')) {
    apiFailures++;
    const said = text.includes('APIERR') ? 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}' : 'Not logged in · Please run /login';
    out({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: said }] }, error: text.includes('APIERR') ? 'server_error' : 'authentication_failed' });
    out({ type: 'result', subtype: 'success', is_error: true, result: said, session_id: sid });
    return;
  }
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
    quiet = text.includes('PERMQUIET');
    why = text.includes('PERMWHY');
    tries = text.includes('PERMLOOP') ? 1 : 0;
    out({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_name: 'Bash',
          input: { command: 'rm -rf /tmp/x' }, description: 'remove x' } });
    return;
  }
  if (text.includes('SEPARATOR')) {
    out({ type: 'result', subtype: 'success', is_error: false, result: 'line one\u2028line two', session_id: sid });
    return;
  }
  if (text.includes('HANG')) return;
  if (text.includes('GRANDCHILD')) {
    const tool = spawn('sleep', ['300'], { stdio: 'ignore' });
    stubborn = true;
    out({ type: 'result', subtype: 'success', is_error: false, result: String(tool.pid), session_id: sid });
    return;
  }
  if (text.includes('QUIETWORK')) {
    const go = process.env.FAKE_CLAUDE_QUIET_GO ?? '';
    out({ type: 'system', subtype: 'status' });
    const t = setInterval(() => {
      if (!existsSync(go)) return out({ type: 'system', subtype: 'status' });
      clearInterval(t);
      out({ type: 'result', subtype: 'success', is_error: false, result: 'worked quietly', session_id: sid });
    }, 50);
    return;
  }
  if (text.includes('SLOW')) {
    setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: 'slow answer', session_id: sid }), 3000);
    return;
  }
  if (text.includes('LIMITOK')) {
    // Some CLIs give the limit as an ordinary answer, not an error.
    out({ type: 'result', subtype: 'success', is_error: false, result: "You've reached your usage limit. Switch to another model to continue.", session_id: sid });
    return;
  }
  if (text.includes('LIMIT')) {
    const limit = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage, to continue.";
    out({ type: 'result', subtype: 'success', is_error: true, result: limit, session_id: sid });
    return;
  }
  if (text.includes('AUTOMEMORY')) {
    out({ type: 'result', subtype: 'success', is_error: false, result: `auto memory off: ${process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? 'unset'}`, session_id: sid });
    return;
  }
  if (text.includes('ENVDUMP')) {
    // Values only for CANARY_*: a real token in the test runner's environment must never be printed.
    // ANGELIA_API_TOKEN is always a test's own: a chat-scoped token derived from a throwaway owner token.
    const seen = Object.keys(process.env).filter((k) => /^CANARY_|^TELEGRAM_BOT_TOKEN$|^ANTHROPIC_API_KEY$|^ANGELIA_API_TOKEN$/.test(k)).sort().map((k) => (/^CANARY_|^ANGELIA_API_TOKEN$/.test(k) ? `${k}=${process.env[k]}` : k));
    out({ type: 'result', subtype: 'success', is_error: false, result: `env: ${seen.join(' ') || 'none'}`, session_id: sid });
    return;
  }
  const result = text.includes('SAYSILENT') ? '[SILENT]' : text.includes('EMPTY') ? '' : process.env.FAKE_CLAUDE_ECHO_ARGV ? `argv: ${process.argv.slice(2).join(' ')}` : `echo: ${text}`;
  out({ type: 'assistant', message: { content: [{ type: 'text', text: result }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result, session_id: sid });
});
let stubborn = false;
rl.on('close', () => { if (!stubborn) process.exit(0); });
}
