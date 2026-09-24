// Live probe: the real grok through GrokBrain. Run: npx tsx tests/live-brain-grok.mts /path/to/empty/dir
import { GrokBrain } from '../src/brain/grok.js';
const cwd = process.argv[2] ?? process.cwd();
const profile = { cwd, permission_mode: 'acceptEdits' as const, add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'grok' as const };
const run = async (b: GrokBrain, text: string) => { const t = Date.now(); for await (const e of b.turn(text)) {
  if (e.kind === 'permission') { console.log('PERMISSION', e.tool, e.preview, '-> allow'); b.answerPermission(e.id.slice(0, 8), true); }
  else console.log(e.kind, JSON.stringify(e.text).slice(0, 100), (e as any).reason ?? '', Date.now() - t, 'ms'); } };
const g = new GrokBrain(profile, { id: 'unused', started: false }); g.start();
await run(g, '[telegram dm 1 · Sam]\n\nReply with exactly the word PONG.');
await run(g, 'Run these shell commands now: git init -q live-repo; date > live-grok.txt; echo written');
console.log('session', g.backendSessionId, 'version', g.version);
await g.stop();
const r = new GrokBrain(profile, { id: g.backendSessionId!, started: true }); r.start();
await run(r, 'In one short line: what was the first thing I asked you?');
await r.stop();
console.log('alive after stop:', r.alive);
