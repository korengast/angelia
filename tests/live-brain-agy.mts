// Live probe: the real agy through AgyBrain, inside Angelia's sandbox (sandbox-exec), with a scratch
// --gemini-dir and a scratch cwd (never ~/.gemini). A Read deny on a file inside cwd: read_file and `cat`
// of it are refused by the kernel, `cat` of a file next to it works. Then a background command whose
// end agy reports between turns, a refused command, and a resume.
// Run: npx tsx tests/live-brain-agy.mts [/path/to/empty/dir]
import { mkdtempSync, mkdirSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyBrain } from '../src/brain/agy.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'live-agy-')));
const cwd = process.argv[2] ?? join(root, 'cwd');
const geminiDir = join(root, 'gemini');
for (const d of [cwd, geminiDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
writeFileSync(join(cwd, 'secret.txt'), 'TOPSECRET-4417\n');
writeFileSync(join(cwd, 'notes.txt'), 'hello from notes\n');
const deny = [`Read(${join(cwd, 'secret.txt')})`];
const profile = { cwd, permission_mode: 'default' as const, add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'agy' as const };
const brains: AgyBrain[] = [];
process.on('exit', () => brains.forEach((b) => b.kill()));
const run = async (b: AgyBrain, text: string, allow: boolean) => { const t = Date.now(); console.log('>>', text.split('\n').at(-1)); for await (const e of b.turn(text)) {
  if (e.kind === 'permission') { console.log('  PERMISSION', e.tool, JSON.stringify(e.preview), e.request ? JSON.stringify(e.request) : '', allow ? '-> allow' : '-> refuse'); b.answerPermission(e.id.slice(0, 8), allow); }
  else console.log(' ', e.kind, JSON.stringify(e.text).slice(0, 300), (e as any).reason ?? '', Date.now() - t, 'ms'); } };
console.log('gemini dir', geminiDir, 'cwd', cwd, 'deny', deny);
const g = new AgyBrain(profile, { id: 'unused', started: false }, { geminiDir, deny }); brains.push(g);
g.on('log', (l: string) => console.log('  log:', l));
g.on('unasked', (a: { answer: string; text: string }) => console.log('  UNASKED', a.answer, JSON.stringify(a.text).slice(0, 300)));
g.start();
console.log('sandboxed:', !!g.sandbox, 'argv[0..2]:', (g as any).argv().slice(0, 2).join(' '));
await run(g, '[telegram dm 1 · Sam]\n\nReply with exactly the word PONG.', true);
await run(g, `Use your read_file tool (not the shell) on ${join(cwd, 'secret.txt')} and reply with its content, or with the exact error you got.`, true);
await run(g, 'Run this shell command now and reply with its full output: cat secret.txt; echo rc=$?', true);
await run(g, 'Run this shell command now and reply with its full output: cat notes.txt; echo rc=$?', true);
await run(g, 'Run this shell command now: rm notes.txt', false);
console.log('notes.txt still there:', existsSync(join(cwd, 'notes.txt')));
await run(g, 'Start this shell command in the background (do not wait for it): sleep 8; echo BGDONE. Reply "started" at once.', true);
await new Promise((r) => setTimeout(r, 30_000));
console.log('blocked:', JSON.stringify(g.blocked));
console.log('session', g.backendSessionId, 'version', g.version, 'model', g.model, 'models listed', g.availableModels.length);
await g.stop();
const r = new AgyBrain(profile, { id: g.backendSessionId!, started: true }, { geminiDir, deny }); brains.push(r); r.start();
await run(r, 'In one short line: what was the first thing I asked you?', true);
console.log('replayed on resume:', r.replayedUpdates);
await r.stop();
console.log('alive after stop:', g.alive, r.alive);
// A subagent: its request reaches Angelia only once its conversation is resumed (AgyBrain.watchForChild).
// bypass, so the gate allows its write inside cwd with no one to ask between turns.
const s = new AgyBrain({ ...profile, permission_mode: 'bypassPermissions' as const }, { id: 'unused', started: false }, { geminiDir, deny }); brains.push(s);
s.on('log', (l: string) => console.log('  log:', l));
s.on('unasked', (a: { answer: string; text: string }) => console.log('  UNASKED', a.answer, JSON.stringify(a.text).slice(0, 300)));
s.start();
await run(s, 'Use invoke_subagent to start one subagent that must create the file sub.txt in the workspace with the text fromsub using its write_file tool. Then end your turn with: started.', true);
await new Promise((r) => setTimeout(r, 60_000));
console.log('sub.txt written by the subagent:', existsSync(join(cwd, 'sub.txt')), 'children', [...s.children]);
await s.stop();
console.log('alive after stop:', s.alive);
