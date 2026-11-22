// End to end, live: a scratch Angelia instance (its own state folder, never ~/.angelia, no daemon) with
// one agy profile compiled with a skill and an MCP server; turns through the Orchestrator, the real
// agy in the full sandbox. A permission ask relayed to the chat and answered there, a deny rule
// refused by the gate, /model, and a resume after the agent was dropped.
// Run: npx tsx tests/live-agy-e2e.mts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { planProfile } from '../src/capabilities/compile.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'live-agy-e2e-')));
const state = join(root, 'state'), cwd = join(root, 'profile'), lib = join(root, 'lib');
for (const d of [state, cwd, join(lib, 'fruit'), join(cwd, '.claude')]) mkdirSync(d, { recursive: true, mode: 0o700 });
writeFileSync(join(lib, 'fruit', 'SKILL.md'), '---\nname: fruit\ndescription: The secret fruit word. Use when asked for the secret fruit word.\n---\nThe secret fruit word is PINEAPPLE-42.\n');
writeFileSync(join(cwd, 'CLAUDE.md'), 'You answer in one short line.\n');
writeFileSync(join(cwd, 'keep.txt'), 'keep me\n');
// The owner's own rule in the profile: no rm.
writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm *)'] } }));
const mcpLog = join(root, 'mcp.log');
const cfg = Config.parse({
  capabilities: {
    fruit: { kind: 'skill', path: join(lib, 'fruit') },
    echo: { kind: 'mcp', command: 'python3', args: [join(here, '..', 'tools', 'probes', 'agy', 'mcp_echo.py'), 'echo', mcpLog] },
  },
  profiles: { live: { cwd, backend: 'agy', permission_mode: 'default', capabilities: ['fruit', 'echo'] } },
  routes: [{ platform: 'telegram', chat: 1, profile: 'live' }],
  defaults: { max_out_per_min: 1000 },
});
const plan = planProfile(cfg, 'live', { stateDir: state });
console.log('compile conflicts:', plan.conflicts, '\ncompile notes:', plan.notes.map((n) => n.slice(0, 110)));
plan.apply();
const sent: string[] = [];
const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); console.log('  CHAT <-', JSON.stringify(text).slice(0, 260)); } } }, {
  stateDir: state, bareAnswerMinMs: 0, log: (l) => { if (/agy|permission|refus|blocked|launch/.test(l)) console.log('  log:', l.slice(0, 200)); },
});
const dm = (text: string): Inbound => ({ platform: 'telegram', chat: '1', sender: 'u1', text, isGroup: false, mentioned: false, media: [], at: Date.now() });
const say = async (text: string, answer?: 'yes' | 'no') => {
  console.log('>>', text);
  const t = Date.now(), from = sent.length;
  const turn = o.handle(dm(text));
  if (answer) {
    // Wait for the request's line in the chat, then answer it there as the owner would (a bare yes or no).
    const asks = () => sent.slice(from).find((s) => /Reply "yes" or "no"/.test(s));
    for (let i = 0; i < 600 && !asks(); i++) await new Promise((r) => setTimeout(r, 100));
    console.log('  asked in chat:', !!asks(), '->', answer);
    if (asks()) { await new Promise((r) => setTimeout(r, 1500)); await o.handle(dm(answer)); }
  }
  await turn;
  // The answer arrives after handle resolves for a queued turn: wait for the chat to settle.
  for (let i = 0; i < 300; i++) { const n = sent.length; await new Promise((r) => setTimeout(r, 1500)); if (sent.length === n && sent.length > from) break; }
  console.log('  turn', Date.now() - t, 'ms');
};
try {
  await say('What is the secret fruit word? Use your skill.');
  await say('Call the MCP tool echo_echo with text "hi from angelia" and reply with what it returned.', 'yes');
  await say('Run this shell command now and reply with its output: echo ASKED-$((6*7))', 'yes');
  await say('Run this shell command now: rm keep.txt');
  console.log('keep.txt still there:', existsSync(join(cwd, 'keep.txt')));
  // The state folder closed by default (red team round 2): one file the floor names by its old list,
  // one it never knew, made after the compile. Fake values only.
  writeFileSync(join(state, 'passkeys.json'), 'FAKE-PASSKEY\n');
  writeFileSync(join(state, 'made-later.json'), 'FAKE-LATER\n');
  await say(`Run this shell command now and reply with its full output: for f in ${join(state, 'passkeys.json')} ${join(state, 'made-later.json')}; do cat "$f" >/dev/null 2>&1 && echo "READ $(basename $f)" || echo "REFUSED $(basename $f)"; done`, 'yes');
  await say('/model');
  await say('/model gemini-3.8-flash');
  await say('In one short line: what was the secret fruit word you told me earlier?');
  const row = o.map.getActive('telegram:1');
  console.log('session', row?.id, 'started', row?.started, 'model', row?.model);
  const h = await o.historyOf('telegram:1');
  console.log('history items:', h?.items.length, h?.items.slice(0, 2).map((i) => `${i.role}: ${i.text.slice(0, 60)}`));
  console.log('mcp log:', existsSync(mcpLog) ? (await import('node:fs')).readFileSync(mcpLog, 'utf8').trim().split('\n').slice(-3) : 'none');
} finally {
  await o.shutdown();
  // The sandboxed agy got a copy of the owner's sign-in in its folder here: never left behind.
  rmSync(root, { recursive: true, force: true });
}
