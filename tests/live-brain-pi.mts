// Live probe: the real pi through PiBrain, its gate and the sandbox. Needs a pi login.
// Run: npx tsx tests/live-brain-pi.mts /path/to/empty/dir [provider/model] [pi binary]
// It makes <dir>/work (the profile folder) and <dir>/secret (a folder the rules deny), then checks
// each mode's answer and that the kernel refuses the secret to a command pi runs unasked.
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PiBrain } from '../src/brain/pi.js';
const root = process.argv[2] ?? process.cwd();
const model = process.argv[3];
const bin = process.argv[4];
const cwd = join(root, 'work'), secret = join(root, 'secret');
mkdirSync(join(cwd, '.claude'), { recursive: true }); mkdirSync(secret, { recursive: true });
writeFileSync(join(secret, 'notes.txt'), 'LIVE-PROBE-SECRET\n');
writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [`Read(${secret}/**)`, `Edit(${secret}/**)`] } }));
const profile = (permission_mode: string) => ({ cwd, permission_mode, add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'pi', ...(model ? { model } : {}) }) as any;
let fails = 0;
const check = (ok: boolean, what: string) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) fails++; };
const run = async (b: PiBrain, text: string, allow = true) => {
  const t = Date.now(); const asked: string[] = []; let answer = '';
  for await (const e of b.turn(text)) {
    if (e.kind === 'permission') { asked.push(`${e.tool}: ${e.preview}`); console.log('  PERMISSION', e.tool, JSON.stringify(e.preview).slice(0, 100), allow ? '-> allow' : '-> deny'); b.answerPermission(e.id.slice(0, 8), allow); }
    else { console.log(' ', e.kind, JSON.stringify(e.text).slice(0, 160), (e as any).reason ?? '', Date.now() - t, 'ms'); if (e.kind === 'result') answer = e.text; }
  }
  return { asked, answer };
};
const opts = { system: 'You are the profile "live" in an Angelia instance. When asked your profile name, answer with it.', ...(bin ? { bin } : {}) };
const id = randomUUID();

const a = new PiBrain(profile('acceptEdits'), { id, started: false }, opts); a.start();
check(/PONG/.test((await run(a, '[telegram dm 1 · Sam]\n\nReply with exactly the word PONG.')).answer), 'a turn answers');
let r = await run(a, 'Use the bash tool to run: touch denied.txt . Then say in one line whether it ran.', false);
check(r.asked.length === 1 && !existsSync(join(cwd, 'denied.txt')), 'acceptEdits asks for a command; a no leaves no file');
r = await run(a, 'Use the bash tool to run: date > live-pi.txt . Then say in one line whether it ran.', true);
check(r.asked.length === 1 && existsSync(join(cwd, 'live-pi.txt')), 'a yes runs it (inside the sandbox)');
r = await run(a, 'Use the bash tool to run: ls . No other tool.');
check(r.asked.length === 0, 'a plain read-only command runs unasked');
r = await run(a, `Use the read tool to read ${secret}/notes.txt and tell me its first word.`);
check(!/LIVE-PROBE-SECRET/.test(r.answer), 'the file tool is refused the secret');
check(/live/i.test((await run(a, 'What is your profile name? One word.')).answer), 'the self prompt reached pi');
await a.stop();

const y = new PiBrain(profile('bypassPermissions'), { id: randomUUID(), started: false }, opts); y.start();
r = await run(y, `Use the bash tool to run exactly: cat ${secret}/notes.txt ; then quote the tool output exactly.`);
check(r.asked.length === 0 && !/LIVE-PROBE-SECRET/.test(r.answer) && /not permitted|denied|refused|blocked/i.test(r.answer), 'bypass runs the command unasked and the kernel refuses the secret');
r = await run(y, 'Use the bash tool to run exactly: echo sandboxed-ok > ok.txt && cat ok.txt ; then quote the output.');
check(existsSync(join(cwd, 'ok.txt')) && /sandboxed-ok/.test(r.answer), 'bypass commands still work in the profile folder');
r = await run(y, 'Use the write tool to write the text tool-ok to tool.txt, then the read tool to read tool.txt, and quote what it holds.');
check(existsSync(join(cwd, 'tool.txt')) && readFileSync(join(cwd, 'tool.txt'), 'utf8').includes('tool-ok') && /tool-ok/.test(r.answer), 'the file tools write and read through the sandbox');
// The gate allows a write in the profile folder; only the kernel refuses a git hook: this passes
// only if the write tool's disk access runs in the sandbox.
spawnSync('git', ['init', '-q', cwd]);
r = await run(y, 'Use the write tool (not bash) to write the text "echo hi" to .git/hooks/pre-commit, then say in one line whether it worked.');
check(!existsSync(join(cwd, '.git', 'hooks', 'pre-commit')), 'the write tool is held by the kernel: no git hook');
await y.stop();

const b2 = new PiBrain(profile('acceptEdits'), { id, started: true }, opts); b2.start();
check(/PONG/.test((await run(b2, 'In one short line: what was the first word I asked you to reply with?')).answer), 'the session resumes by the id Angelia minted');
await b2.stop();
// An installed Angelia's gate lies under node_modules, where pi's loader does not rewrite its import
// of pi's package (a chat found it): the built gate, copied there, must still find the package.
const built = join(import.meta.dirname, '..', 'dist', 'brain', 'pi-gate.js');
if (existsSync(built)) {
  const nm = join(root, 'node_modules', 'angelia'), out = join(root, 'sdk.txt');
  cpSync(join(import.meta.dirname, '..', 'dist'), join(nm, 'dist'), { recursive: true });
  cpSync(join(import.meta.dirname, '..', 'package.json'), join(nm, 'package.json'));
  writeFileSync(join(nm, 'probe.js'), `import { writeFileSync } from 'node:fs';\nimport { loadPiSdk } from './dist/brain/pi-gate.js';\nexport default async () => { const m = await loadPiSdk(); writeFileSync(${JSON.stringify(out)}, String(typeof m?.createWriteToolDefinition)); };\n`);
  spawnSync(bin ?? 'pi', ['--mode', 'rpc', '--no-session', '-e', join(nm, 'probe.js')], { cwd: root, input: '', timeout: 30_000 });
  check(existsSync(out) && readFileSync(out, 'utf8') === 'function', 'the built gate, installed under node_modules, finds pi\'s package');
} else console.log('SKIP the installed gate check: run npm run build first');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED', 'pi', a.version, 'session', id);
process.exit(fails ? 1 : 0);
