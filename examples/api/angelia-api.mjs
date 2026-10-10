#!/usr/bin/env node
// Talk to a running Angelia daemon over its local API. Node 18+, no packages; copy it freely.
//
//   node angelia-api.mjs health
//   node angelia-api.mjs send telegram:123456 "The backup finished."
//   node angelia-api.mjs ask  telegram:123456 "What is on my list today?"
//   node angelia-api.mjs turn telegram:123456 "Summarise today's mail."   # prints the answer as it comes
//
// The socket and the owner token are in ~/.angelia (ANGELIA_STATE_DIR moves it). Inside a chat's
// agent, ANGELIA_API_TOKEN is that agent's own token: it works for send, ask and turn into its own
// chat, but it cannot read the event stream, so `turn` here needs the owner's token.
// Contract: GET /openapi.json on the same socket, or https://useangelia.com/docs/api.md
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE = process.env.ANGELIA_STATE_DIR || join(homedir(), '.angelia');
const SOCKET = join(STATE, 'api.sock');
const token = () => process.env.ANGELIA_API_TOKEN || readFileSync(join(STATE, 'api.token'), 'utf8').trim();

/** One request; resolves to the JSON answer, or rejects with the daemon's own error text. */
export function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) };
    const req = request({ socketPath: SOCKET, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const out = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
        if (res.statusCode >= 400) reject(new Error(`${res.statusCode}: ${out?.error}`));
        else resolve(out);
      });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

/** Open a chat's event stream; `onEvent` gets each event. Resolves once the stream is open, with a
 *  function that closes it. */
export function openEvents(key, onEvent) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: SOCKET, path: `/events?key=${encodeURIComponent(key)}`, headers: { authorization: `Bearer ${token()}` } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`events: HTTP ${res.statusCode}`)); }
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          if (block.startsWith('data: ')) onEvent(JSON.parse(block.slice(6)));
        }
      });
      resolve(() => req.destroy());
    });
    req.on('error', reject);
    req.end();
  });
}

/** Give the chat's agent a task and print what the chat gets, until the turn ends. */
export async function turn(key, text) {
  let turnId, mine = false, done;
  const finished = new Promise((r) => { done = r; });
  // Before the turn, so its first event is not missed.
  const close = await openEvents(key, (e) => {
    if (e.type === 'turn') mine = e.turn === turnId;
    else if (e.type === 'out' && mine) console.log(e.text);
    else if (e.type === 'turn-end' && e.turn === turnId) done(e);
  });
  turnId = (await call('POST', '/turn', { key, text })).turn;
  const end = await finished;
  close();
  if (!end.ok) throw new Error(`the turn failed: ${end.reason ?? 'no reason given'}`);
}

const [cmd, key, ...words] = process.argv.slice(2);
const text = words.join(' ');
if (cmd === 'health') console.log(JSON.stringify(await call('GET', '/healthz')));
else if (cmd === 'send' && key && text) { await call('POST', '/send', { key, text }); console.log('sent'); }
else if (cmd === 'ask' && key && text) console.log((await call('POST', '/ask', { key, text })).answer);
else if (cmd === 'turn' && key && text) await turn(key, text);
else { console.error('usage: node angelia-api.mjs health | send <chat> <text> | ask <chat> <question> | turn <chat> <prompt>'); process.exit(2); }
