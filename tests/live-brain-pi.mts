// Live probe: the real pi through PiBrain and its gate. Needs a pi login.
// Run: npx tsx tests/live-brain-pi.mts /path/to/empty/dir [provider/model]
import { randomUUID } from 'node:crypto';
import { PiBrain } from '../src/brain/pi.js';
const cwd = process.argv[2] ?? process.cwd();
const model = process.argv[3];
const profile = { cwd, permission_mode: 'acceptEdits' as const, add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'pi' as const, ...(model ? { model } : {}) };
const run = async (b: PiBrain, text: string, allow = true) => { const t = Date.now(); for await (const e of b.turn(text)) {
  if (e.kind === 'permission') { console.log('PERMISSION', e.tool, e.preview, allow ? '-> allow' : '-> deny'); b.answerPermission(e.id.slice(0, 8), allow); }
  else console.log(e.kind, JSON.stringify(e.text).slice(0, 140), (e as any).reason ?? '', Date.now() - t, 'ms'); } };
const id = randomUUID();
const system = 'You are the profile "live" in an Angelia instance. When asked your profile name, answer with it.';
const b = new PiBrain(profile, { id, started: false }, { system }); b.start();
await run(b, '[telegram dm 1 · Sam]\n\nReply with exactly the word PONG.');
await run(b, 'Use the bash tool to run: touch denied.txt . Then say in one line whether it ran.', false);
await run(b, 'Use the bash tool to run: date > live-pi.txt . Then say in one line whether it ran.', true);
await run(b, 'Use the bash tool to run: ls . No other tool.');
await run(b, 'What is your profile name? One word.');
await b.stop();
const r = new PiBrain(profile, { id, started: true }, { system }); r.start();
await run(r, 'In one short line: what was the first thing I asked you?');
await r.stop();
console.log('alive after stop:', r.alive, 'session', id);
