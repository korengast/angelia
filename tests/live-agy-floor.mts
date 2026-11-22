// Live probe after the merge of the gate and the compile step: the real agy inside the full sandbox,
// with the floor every profile gets (credentialRules: ~/.ssh, the CLIs' stores, ~/.gemini's
// conversations and MCP configs), plus a profile with `sandbox: false`. Scratch --gemini-dir and cwd.
// Run: npx tsx tests/live-agy-floor.mts
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyBrain } from '../src/brain/agy.js';
import { credentialRules } from '../src/capabilities/compile.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'live-agy-floor-')));
const brains: AgyBrain[] = [];
// The sandboxed agy gets a copy of the owner's sign-in in its scratch folder: removed at exit.
process.on('exit', () => { brains.forEach((b) => b.kill()); rmSync(root, { recursive: true, force: true }); });
async function run(b: AgyBrain, text: string, allow: boolean): Promise<void> {
  const t = Date.now(); console.log('>>', text);
  for await (const e of b.turn(text)) {
    if (e.kind === 'permission') { console.log('  PERMISSION', e.tool, JSON.stringify(e.preview).slice(0, 120), allow ? '-> allow' : '-> refuse'); b.answerPermission(e.id.slice(0, 8), allow); }
    else console.log(' ', e.kind, JSON.stringify(e.text ?? '').slice(0, 200), (e as any).reason ?? '', Date.now() - t, 'ms');
  }
}
for (const sandbox of [true, false]) {
  const cwd = join(root, `cwd-${sandbox}`), geminiDir = join(root, `gemini-${sandbox}`);
  for (const d of [cwd, geminiDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const profile = { cwd, permission_mode: 'default' as const, add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'agy' as const, sandbox };
  const deny = credentialRules(profile);
  const b = new AgyBrain(profile, { id: 'unused', started: false }, { geminiDir, deny, stateDir: join(root, 'state') }); brains.push(b);
  b.on('log', (l: string) => console.log('  log:', l));
  b.start();
  console.log(`== sandbox: ${sandbox}; floor rules: ${deny.length}; sandboxed: ${!!b.sandbox}; argv[0]: ${(b as any).argv()[0]}`);
  await run(b, 'Reply with exactly the word PONG.', true);
  if (sandbox) await run(b, `Run this shell command now and reply with its full output: ls ${join(homedir(), '.gemini')} | head -2; echo rc=$?`, true);
  // The keychain: a command agy runs must find none of the owner's items (prints only found / not found).
  if (sandbox) await run(b, "Run this shell command now and reply with its full output: for s in 'Claude Code-credentials' gh:github.com gemini; do security find-generic-password -s \"$s\" >/dev/null 2>&1 && echo \"$s FOUND\" || echo \"$s not found\"; done", true);
  if (sandbox) await run(b, `Run this shell command now and reply with its full output: echo x > ${join(geminiDir, 'config', 'mcp_config.json')} && echo WROTE || echo REFUSED`, true);
  console.log('  model', b.model, 'models listed', b.availableModels.length);
  await b.stop();
  console.log('  alive after stop:', b.alive);
}
