import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import angeliaGate, { decide, fileOps, globRegex, parseRules, sandboxed, sandboxProblem, sandboxProfile, SANDBOX_EXEC, type PiPolicy } from '../src/brain/pi-gate.js';
import { createBrain, type Brain } from '../src/brain/index.js';
import { PiBrain, piSandboxNote } from '../src/brain/pi.js';
import { Config } from '../src/instance/config/schema.js';
import { loadConfig } from '../src/instance/config/load.js';
import { credentialRules, launchCheck, planProfile } from '../src/capabilities/compile.js';
import type { BrainEvent } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const mac = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
const skip = mac ? false : 'macOS sandbox-exec only';

/** A command run the way pi's bash tool runs it: the shell, `-c`, the command the gate left. */
const run = (command: string, cwd: string) => spawnSync('/bin/bash', ['-c', command], { cwd, encoding: 'utf8' });

const roots: string[] = [];
process.on('exit', () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A home with a secret folder, a Read-only rule on a glob, an Edit-only launch file, links into both. */
function rig() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-sb-')));
  roots.push(root);
  const home = join(root, 'h'), work = join(home, 'work'), ssh = join(home, '.ssh'), state = join(home, '.state'), other = join(home, 'profiles', 'other');
  for (const d of [work, ssh, state, other, join(work, '.claude')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(ssh, 'id_rsa'), 'SECRET-KEY');
  writeFileSync(join(state, 'status.json'), 'SECRET-STATE');
  writeFileSync(join(state, 'daemon.log'), 'log line');
  writeFileSync(join(other, 'notes.md'), 'OTHER-PROFILE');
  writeFileSync(join(work, '.claude', 'settings.json'), '{}');
  writeFileSync(join(work, 'notes.md'), 'mine');
  const nfd = join(home, 'cafe\u0301'); mkdirSync(nfd); writeFileSync(join(nfd, 'k'), 'SECRET-NFD');
  const deny = [`Read(${ssh}/**)`, `Edit(${ssh}/**)`, `Read(${state}/*.json)`, `Edit(${state}/*.json)`, `Read(${home}/profiles/other/**)`, `Edit(${home}/profiles/other/**)`,
    `Edit(${work}/.claude/settings.json)`, `Read(${home}/caf\u00e9/**)`];
  const profile = sandboxProfile(deny, home);
  const sh = (cmd: string) => run(sandboxed(cmd, profile), work);
  return { root, home, work, ssh, state, other, deny, profile, sh };
}

test('pi sandbox: the file tools open through the kernel, so a checked file swapped for a link to a secret is still refused', { skip }, async () => {
  const r = rig();
  const o = fileOps(sandboxProfile(r.deny, r.home, { writable: [r.work] }));
  // The race the gate alone loses: the path it checked is now a link to a denied file.
  symlinkSync(join(r.ssh, 'id_rsa'), join(r.work, 'swapped'));
  await assert.rejects(o.readFile(join(r.work, 'swapped')), /Operation not permitted/);
  await assert.rejects(o.writeFile(join(r.work, 'swapped'), 'x'), /Operation not permitted/);
  await assert.rejects(o.access(join(r.work, 'swapped')));
  await assert.rejects(o.writeFile(join(r.work, '.claude', 'settings.json'), '{}'), /Operation not permitted/);
  assert.equal(readFileSync(join(r.ssh, 'id_rsa'), 'utf8'), 'SECRET-KEY');
  // What the tools do every day still works: a read, a write in a new folder, an edit's check.
  assert.equal((await o.readFile(join(r.work, 'notes.md'))).toString(), 'mine');
  await o.mkdir(join(r.work, 'a', 'b'));
  await o.writeFile(join(r.work, 'a', 'b', 'c.txt'), 'hello \'quoted\' $HOME\n');
  assert.equal(readFileSync(join(r.work, 'a', 'b', 'c.txt'), 'utf8'), "hello 'quoted' $HOME\n");
  await o.editAccess(join(r.work, 'a', 'b', 'c.txt'));
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  writeFileSync(join(r.work, 'i.png'), png);
  const seen: Buffer[] = [];
  const typed = fileOps(sandboxProfile(r.deny, r.home), async (f) => { seen.push(readFileSync(f)); return 'image/png'; });
  assert.equal(await typed.detectImageMimeType!(join(r.work, 'i.png')), 'image/png');
  assert.deepEqual(seen, [png], "pi's own check is given the file's first bytes");
});

test('pi sandbox: no command reads another chat\'s transcript or a CLI\'s user config, or writes a turn into one; the shell\'s snapshot stays readable', { skip }, () => {
  const r = rig();
  const put = (rel: string, text: string) => { const p = join(r.home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p; };
  const chat = put('.claude/projects/-Users-me-money/s1.jsonl', 'OTHER-CHAT\n');
  const rollout = put('.codex/sessions/2026/09/30/rollout-1.jsonl', 'CODEX-CHAT\n');
  const config = put('.claude.json', 'MCP-TOKEN');
  const snapshot = put('.claude/shell-snapshots/snapshot-zsh-1.sh', 'alias ll=ls');
  const p = Config.parse({ profiles: { p: { cwd: r.work, backend: 'pi' } }, routes: [] }).profiles.p;
  // Approved-command shape: writes anywhere but the denied paths, so only the rules stand in the way.
  const sh = (cmd: string) => run(sandboxed(cmd, sandboxProfile(credentialRules(p, r.home, {}), r.home)), r.work);
  for (const f of [chat, rollout, config, chat.replace('/.claude/', '/.CLAUDE/')]) {
    const c = sh(`cat '${f}'`);
    assert.notEqual(c.status, 0, f);
    assert.doesNotMatch(c.stdout, /OTHER-CHAT|CODEX-CHAT|MCP-TOKEN/, f);
  }
  assert.match(sh(`echo '{"type":"user"}' >> '${chat}'`).stderr, /Operation not permitted/);
  assert.equal(readFileSync(chat, 'utf8'), 'OTHER-CHAT\n');
  const own = sh(`cat '${snapshot}'`);
  assert.equal(own.status, 0, own.stderr);
  assert.equal(own.stdout, 'alias ll=ls');
});

test('pi sandbox: an unasked command cannot plant what git runs later, and commits still work', { skip }, () => {
  const r = rig();
  const sh = (cmd: string) => run(sandboxed(cmd, sandboxProfile(r.deny, r.home, { writable: [r.work] })), r.work);
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd: r.work, encoding: 'utf8' });
  for (const cmd of ['git init -q .', 'mkdir .GIT', 'echo "gitdir: /tmp" > .git']) assert.notEqual(sh(cmd).status, 0, cmd);
  assert.equal(git('init', '-q', '.').status, 0);
  for (const cmd of ['echo "[core]" >> .git/config', 'touch .git/hooks/pre-commit', 'echo "* filter=x" > .git/info/attributes', 'mv .git .old'])
    assert.match(sh(cmd).stderr, /Operation not permitted/, cmd);
  assert.equal(run(sandboxed('git init -q approved', sandboxProfile(r.deny, r.home)), r.work).status, 0, 'a command the owner approved may');
  const c = sh('echo x > f && git add f && git -c user.email=a@b -c user.name=a commit -qm x && git log --oneline');
  assert.equal(c.status, 0, c.stderr);
});

test('pi sandbox: the profile compiles and runs; one that does not is named', { skip }, () => {
  assert.equal(sandboxProblem(rig().profile), '');
  assert.match(sandboxProblem('(version 1)(allow nonsense'), /the sandbox did not start/);
});

test('pi sandbox: the kernel refuses a denied path however the command spells or reaches it', { skip }, () => {
  const r = rig();
  symlinkSync(r.ssh, join(r.work, 'keys'));
  symlinkSync('../.ssh', join(r.work, 'rel'));
  // Each of these prints a secret without the sandbox (checked first, so a typo cannot pass as a refusal).
  const reads = [
    `cat ${r.ssh}/id_rsa`, `cat ${r.home}/.SSH/ID_RSA`, 'cat keys/id_rsa', 'cat rel/id_rsa', `cat ${r.work}/../.ssh/id_rsa`, 'cat ~/.ssh/id_rsa',
    `cat ${r.home}/.ss?/id*`, `python3 -c "print(open('${r.ssh}/id_rsa').read())"`, `node -e "console.log(require('fs').readFileSync('${r.ssh}/id_rsa','utf8'))"`,
    `cat ${r.state}/status.json`, `cat ${r.state}/STATUS.JSON`, `cat ${r.home}/caf\u00e9/k`, `cat ${r.home}/cafe\u0301/k`,
    'bash -c "cat ~/.ssh/id_rsa"', `sh -c 'cd ${r.ssh} && cat id_rsa'`,
  ];
  for (const cmd of reads) assert.match(run(`HOME=${r.home}; ${cmd}`, r.work).stdout, /SECRET/, `control: ${cmd}`);
  assert.match(run(`cat ${r.other}/notes.md`, r.work).stdout, /OTHER-PROFILE/);
  const denied = [...reads, `cat ${r.other}/notes.md`,
    `ls ${r.ssh}`, `cp ${r.ssh}/id_rsa ./copy`, `ln ${r.ssh}/id_rsa ./hard`, `mv ${r.ssh}/id_rsa ./moved`, `echo x > ${r.ssh}/authorized_keys`,
    `echo '{}' > .claude/settings.json`, 'rm .claude/settings.json', 'mv .claude/settings.json .claude/x', 'chmod 777 .claude/settings.json',
  ];
  for (const cmd of denied) {
    const x = r.sh(`HOME=${r.home}; ${cmd}`);
    assert.ok(!/SECRET|OTHER-PROFILE/.test(x.stdout), `${cmd} printed a secret`);
    assert.notEqual(x.status, 0, `${cmd} succeeded: ${x.stdout}${x.stderr}`);
  }
  assert.equal(readFileSync(join(r.ssh, 'id_rsa'), 'utf8'), 'SECRET-KEY');
  assert.equal(readFileSync(join(r.work, '.claude', 'settings.json'), 'utf8'), '{}');
  for (const f of ['copy', 'hard', 'moved']) assert.ok(!existsSync(join(r.work, f)), f);
  // What the rules leave open works: the Edit-only file reads, other state files, the own folder.
  for (const cmd of ['cat .claude/settings.json', `cat ${r.state}/daemon.log`, 'echo new > made.txt && cat made.txt', 'cat notes.md', `ls ${r.home}`, 'git init -q repo && git -C repo status --short', 'mktemp'])
    assert.equal(r.sh(cmd).status, 0, cmd);
});

test('pi sandbox: a socket under a Read rule, and one named by the policy, cannot be reached', { skip }, async (t) => {
  const r = rig();
  const inside = join(r.ssh, 'agent.sock');
  const named = join(r.root, 'tmux.sock');
  const servers = [inside, named].map((p) => { const s = createServer((c) => c.end('HELLO\n')); s.listen(p); return s; });
  t.after(() => servers.forEach((s) => s.close()));
  await new Promise((res) => setTimeout(res, 100));
  const profile = sandboxProfile(r.deny, r.home, { sockets: [named] });
  const connect = (p: string) => `node -e "const c=require('net').connect('${p}');c.on('data',d=>{process.stdout.write(d);process.exit(0)});c.on('error',e=>{console.error(e.code);process.exit(3)})"`;
  const open = join(r.root, 'open.sock');
  const s3 = createServer((c) => c.end('HELLO\n')); s3.listen(open); t.after(() => s3.close());
  await new Promise((res) => setTimeout(res, 100));
  // spawnSync would block the servers' event loop: ask asynchronously.
  const ask = (cmd: string) => new Promise<{ status: number | null; out: string }>((res) => {
    const c = spawn('/bin/bash', ['-c', sandboxed(cmd, profile)], { cwd: r.work });
    let out = ''; c.stdout.on('data', (d: Buffer) => { out += d; }); c.stderr.on('data', (d: Buffer) => { out += d; });
    c.on('close', (status: number | null) => res({ status, out }));
  });
  assert.match((await ask(connect(open))).out, /HELLO/);
  for (const p of [inside, named]) { const x = await ask(connect(p)); assert.notEqual(x.status, 0, p); assert.doesNotMatch(x.out, /HELLO/); }
});

test('pi sandbox: the command runs exactly as written, in the same shell, with its exit code and output', { skip }, () => {
  const r = rig();
  const cmds = [
    `printf '%s|' "a b" 'c'"'"'d' $'e\\tf' "\\$HOME" \`echo g\`; echo`,
    'cat <<EOF\nline one $((1+2))\nEOF',
    "echo 'שלום עולם' é ü 🙂",
    'x=5; if [ "$x" -gt 3 ]; then echo big; fi; for i in 1 2; do echo $i; done',
    'echo out; echo err >&2; exit 7',
    'pwd',
    'echo "$0"',
    'f() { echo "fn $1"; }; f arg',
    "echo 'back\\\\slash' \"double \\\" quote\"",
  ];
  for (const c of cmds) {
    const want = run(c, r.work), got = r.sh(c);
    assert.equal(got.status, want.status, c);
    assert.equal(got.stdout, want.stdout, c);
    assert.equal(got.stderr, want.stderr, c);
  }
  assert.equal(r.sh('printenv ANGELIA_SANDBOX').stdout.trim(), 'pi');
});

test('pi sandbox: rule globs become regexes; syntax it does not model closes the whole folder', () => {
  assert.equal(globRegex('/*.json'), '/[^/]*\\.[jJ][sS][oO][nN]');
  assert.equal(globRegex('/a/**/b/*.{js,ts}'), '/[aA](/[^/]+)*/[bB]/[^/]*\\.([jJ][sS]|[tT][sS])');
  assert.equal(globRegex('/x/**'), '/[xX](/.*)?');
  for (const bad of ['/[ab]', '/{a,{b}}', '/{a..z}', '/{open', '/close}', '/{a/b,c}']) assert.equal(globRegex(bad), undefined, bad);
  const p = sandboxProfile(['Read(/s/{a..z}/*)', 'Edit(/e/**)', 'Read(//abs/x)', 'Bash(rm)', 'mcp__x'], '/h');
  assert.match(p, /\(deny file-read\* \(subpath "\/s"\)\)/);
  assert.match(p, /\(deny file-write\* \(subpath "\/e"\)\)/);
  assert.doesNotMatch(p, /file-read\* \(subpath "\/e"\)/); // an Edit rule leaves reading open
  assert.match(p, /\(deny file-write\* \(subpath "\/abs\/x"\)\)/); // a Read rule closes writing too
  assert.match(p, /\(deny file-write\* \(literal "\/abs"\)\)/); // and the folders above it cannot be renamed
  // A brace group holding a `/`, and a rule path with a newline in it, close the whole folder in both layers.
  assert.match(sandboxProfile(['Read(/x/{a/b,c})'], '/h'), /\(deny file-read\* \(subpath "\/x"\)\)/);
  assert.equal(parseRules(['Read(/x/{a/b,c})'])[0].test('/x/a/b'), true);
  assert.equal(parseRules(['Read(/x/{a/b,c})'])[0].test('/x/c'), true);
  assert.equal(parseRules(['Read(/x/{a,c}.md)'])[0].test('/x/c.md'), true);
  assert.equal(parseRules(['Read(/x/a\nb)']).length, 1);
  assert.match(sandboxProfile(['Read(/x/a\nb)'], '/h'), /subpath "\/x\/a\nb"/);
  assert.match(p, /\(deny file-read\* \(subpath "\/abs\/x"\)\)/);
  assert.match(p, /\(deny network-outbound \(remote unix-socket \(subpath "\/abs\/x"\)\)\)/);
  assert.doesNotMatch(p, /rm|mcp/);
  assert.match(sandboxProfile(['Read(/a "b\\\\c)'], '/h'), /\(subpath "\/a \\"b\\\\\\\\c"\)/);
  assert.ok(sandboxProfile(['Read(~/.x/*.json)'], '/Users/example').includes(String.raw`(deny file-read* (regex "^/[uU][sS][eE][rR][sS]/[eE][xX][aA][mM][pP][lL][eE]/\\.[xX]/[^/]*\\.[jJ][sS][oO][nN](/.*)?$"))`));
});

const FAKE_PI = join(here, 'fake-pi.mjs');
const made: Brain[] = [];
process.on('exit', () => made.forEach((b) => b.kill()));
PiBrain.noRunCheckMs = 100;
async function answer(b: Brain, text: string): Promise<string> {
  const out: BrainEvent[] = [];
  for await (const e of b.turn(text)) { out.push(e); if (e.kind === 'permission') b.answerPermission(e.id.slice(0, 8), true); }
  return (out.at(-1) as any).text;
}

test('pi sandbox: through PiBrain and the gate, bypass runs a command and the kernel still refuses the secret; sandbox: false turns that off', { skip }, async () => {
  const r = rig();
  writeFileSync(join(r.work, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: r.deny } }));
  const mk = (extra: Record<string, unknown>) => {
    const b = createBrain({ cwd: r.work, add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'pi', permission_mode: 'bypassPermissions', ...extra } as any, { id: 's', started: false }, { bin: FAKE_PI, env: { ...process.env } });
    made.push(b); b.start(); return b;
  };
  const b = mk({});
  assert.match(await answer(b, `RUN:cat ${r.ssh}/id_rsa`), /^exit 1: .*Operation not permitted/);
  assert.equal(await answer(b, 'RUN:echo ok && cat notes.md'), 'exit 0: ok\nmine');
  await b.stop();
  const open = mk({ sandbox: false });
  assert.equal(await answer(open, `RUN:cat ${r.ssh}/id_rsa`), 'exit 0: SECRET-KEY');
  await open.stop();
});

test('pi: compile says where the rules hold; turning the sandbox off in the table needs a compile; the CLI inside the sandbox loads a table with hidden folders', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'angelia-sbc-')));
  const cwd = join(root, 'p'), state = join(root, 'state'), home = join(root, 'home');
  for (const d of [cwd, state, home]) mkdirSync(d, { recursive: true });
  const cfg = (sandbox?: boolean) => Config.parse({ profiles: { p: { cwd, backend: 'pi', permission_mode: 'bypassPermissions', ...(sandbox === undefined ? {} : { sandbox }) } }, routes: [] });
  const pl = planProfile(cfg(), 'p', { home, stateDir: state });
  assert.ok(pl.notes.some((n) => /every shell command \(each runs in a macOS sandbox/.test(n)), pl.notes.join('\n'));
  assert.ok(!pl.notes.some((n) => n.startsWith('bypassPermissions: deny rules stop the file tools, not the shell')));
  pl.apply();
  assert.deepEqual(launchCheck(cfg(), 'p', state), []);
  assert.match(launchCheck(cfg(false), 'p', state).join(), /sandbox for pi's commands off/);
  const off = planProfile(cfg(false), 'p', { home, stateDir: state });
  assert.ok(off.notes.some((n) => /sandbox: false, so shell commands run outside the sandbox/.test(n)));
  assert.ok(off.notes.some((n) => n.startsWith('bypassPermissions: deny rules stop the file tools, not the shell')));
  off.apply();
  assert.deepEqual(launchCheck(cfg(false), 'p', state), []);
  // A table whose other profile folder the process may not stat: fine inside the sandbox only.
  const table = join(root, 'routing.yaml');
  writeFileSync(table, stringify({ profiles: { p: { cwd, backend: 'pi' }, q: { cwd: join(root, 'hidden', 'q') } }, routes: [] }));
  mkdirSync(join(root, 'hidden', 'q'), { recursive: true });
  if (mac) {
    const loader = `import('${join(here, '..', 'src', 'instance', 'config', 'load.ts')}').then((m) => { m.loadConfig('${table}'); console.log('loaded'); }).catch((e) => { console.log(e.message); })`;
    const prof = sandboxProfile([`Read(${join(root, 'hidden')}/**)`], home);
    const inSandbox = spawnSync('/bin/bash', ['-c', sandboxed(`${process.execPath} --import tsx -e "${loader}"`, prof)], { cwd: here, encoding: 'utf8' });
    assert.equal(inSandbox.stdout.trim(), 'loaded', inSandbox.stderr);
    const bare = spawnSync(SANDBOX_EXEC, ['-p', prof, process.execPath, '--import', 'tsx', '-e', loader], { cwd: here, encoding: 'utf8' });
    assert.match(bare.stdout, /q\.cwd: not a directory/);
  }
  assert.equal(loadConfig(table).profiles.p.backend, 'pi');
});

test('pi sandbox: a folder above a rule, or a closed socket, cannot be renamed away; what is inside it stays usable', { skip }, async (t) => {
  const r = rig();
  const sock = join(r.root, 'sockdir', 'tmux.sock');
  mkdirSync(dirname(sock));
  const srv = createServer((c) => c.end('HELLO\n')); srv.listen(sock); t.after(() => srv.close());
  await new Promise((res) => setTimeout(res, 100));
  const profile = sandboxProfile([...r.deny, `Read(${r.home}/lone.txt)`], r.home, { sockets: [sock] });
  writeFileSync(join(r.home, 'lone.txt'), 'SECRET-LONE');
  const sh = (cmd: string) => run(sandboxed(`HOME=${r.home}; ${cmd}`, profile), r.work);
  for (const cmd of [`mv ${r.home} ${r.root}/h2 && cat ${r.root}/h2/.ssh/id_rsa`, `mv ${r.home}/profiles ${r.work}/p && cat ${r.work}/p/other/notes.md`,
    `mv ${r.state} ${r.work}/st && cat ${r.work}/st/status.json`, `mv ${r.home}/lone.txt ${r.work}/l && cat ${r.work}/l`,
    `mv ${r.work}/.claude ${r.work}/c2 && echo x > ${r.work}/c2/settings.json`, `mv ${r.work} ${r.root}/w2`,
    `mv ${sock} ${r.root}/moved.sock`, `mv ${dirname(sock)} ${r.root}/sd2`]) {
    const x = sh(cmd);
    assert.notEqual(x.status, 0, `${cmd}: ${x.stdout}`);
    assert.doesNotMatch(x.stdout, /SECRET|OTHER-PROFILE/, cmd);
  }
  assert.ok(existsSync(sock) && existsSync(join(r.work, '.claude', 'settings.json')) && existsSync(join(r.state, 'status.json')));
  for (const cmd of [`touch ${r.home}/new.txt && rm ${r.home}/new.txt`, `mkdir ${r.state}/sub && rmdir ${r.state}/sub`, 'mkdir d && mv d d2 && rmdir d2'])
    assert.equal(sh(cmd).status, 0, cmd);
});

test('pi sandbox: unasked commands write only in the profile\'s folders, its cache and temp; an approved one may write elsewhere', { skip }, async (t) => {
  const r = rig();
  // Temp is writable to every command, so the folder outside the profile's reach is not in temp:
  // node_modules (ignored by git), removed after.
  const shared = join(r.root, 'shared'), cache = join(r.root, 'cache'), elsewhere = mkdtempSync(join(here, '..', 'node_modules', '.angelia-sb-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  for (const d of [shared, cache]) mkdirSync(d);
  const confined = sandboxProfile(r.deny, r.home, { writable: [r.work, shared, cache] });
  const open = sandboxProfile(r.deny, r.home);
  const sh = (profile: string, cmd: string) => run(sandboxed(cmd, profile), r.work);
  for (const cmd of ['echo a > here.txt', `echo a > ${shared}/x`, `echo a > ${cache}/x`, 'echo a > "$(mktemp)"', 'echo a > /dev/null', 'ls -la / > /dev/null', `cat ${r.state}/daemon.log`])
    assert.equal(sh(confined, cmd).status, 0, cmd);
  for (const cmd of [`echo a > ${elsewhere}/x`, `touch ${here}/../node_modules/.angelia-sb-y`, 'echo a > .claude/settings.json'])
    assert.notEqual(sh(confined, cmd).status, 0, cmd);
  assert.equal(sh(open, `echo a > ${elsewhere}/x`).status, 0);
  assert.notEqual(sh(open, `cat ${r.ssh}/id_rsa`).status, 0);
  // The gate picks the profile: bypass runs unasked, so confined; an approved command gets the open one.
  const saved = process.env.ANGELIA_PI_POLICY;
  const handlers: Record<string, (e: any, c: any) => any> = {};
  const fakePi = { on: (ev: string, fn: any) => { handlers[ev] = fn; }, getActiveTools: () => [], setActiveTools: () => {} };
  try {
    const use = (mode: string) => { process.env.ANGELIA_PI_POLICY = JSON.stringify({ mode, cwd: r.work, dirs: [shared], deny: r.deny, cache }); angeliaGate(fakePi); };
    const via = async (cmd: string, yes = true) => { const input: any = { command: cmd }; const res = await handlers.tool_call({ toolName: 'bash', input }, { ui: { confirm: async () => yes } }); return res ? res : run(input.command, r.work); };
    use('bypassPermissions');
    assert.notEqual((await via(`echo a > ${elsewhere}/bypass`)).status, 0);
    assert.equal((await via(`echo a > ${cache}/ok`)).status, 0);
    use('default');
    assert.equal((await via(`echo a > ${elsewhere}/approved`)).status, 0);
    assert.notEqual((await via(`cat ${r.ssh}/id_rsa`)).status, 0);
    assert.equal((await via('echo never', false)).block, true);
  } finally { if (saved === undefined) delete process.env.ANGELIA_PI_POLICY; else process.env.ANGELIA_PI_POLICY = saved; }
});

test('pi sandbox: another profile\'s cache folder is closed', { skip }, () => {
  const r = rig();
  const caches = join(r.root, 'cache', 'pi'), mine = join(caches, 'aaa'), theirs = join(caches, 'bbb');
  for (const d of [mine, theirs]) mkdirSync(d, { recursive: true });
  writeFileSync(join(theirs, 'pkg.js'), 'OTHER-PROFILE cache');
  const profile = sandboxProfile(r.deny, r.home, { cache: mine, writable: [r.work, mine] });
  assert.equal(run(sandboxed(`echo ok > ${mine}/x && cat ${mine}/x`, profile), r.work).stdout, 'ok\n');
  for (const cmd of [`cat ${theirs}/pkg.js`, `echo x > ${theirs}/pkg.js`, `ls ${theirs}`]) assert.notEqual(run(sandboxed(cmd, profile), r.work).status, 0, cmd);
  const pol: PiPolicy = { mode: 'bypassPermissions', cwd: r.work, dirs: [], deny: [], sandbox: true, cache: mine };
  assert.equal(decide(pol, 'read', { path: join(theirs, 'pkg.js') }).action, 'block');
  assert.equal(decide(pol, 'write', { path: join(theirs, 'pkg.js'), content: '' }).action, 'block');
  assert.equal(decide(pol, 'write', { path: join(mine, 'x'), content: '' }).action, 'allow');
});

test('pi: the note tells each mode the truth about its shell', () => {
  const base = { cwd: '/w', add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'pi' } as any;
  assert.match(piSandboxNote({ ...base, permission_mode: 'plan' }), /plan mode: you read and search, you run no commands/);
  assert.match(piSandboxNote({ ...base, permission_mode: 'bypassPermissions' }, ['/s'], 'p', true), /may write only in: \/w, \/s, your cache folder and temp/);
  assert.doesNotMatch(piSandboxNote({ ...base, permission_mode: 'bypassPermissions' }, [], 'p', false), /cache/);
  assert.match(piSandboxNote({ ...base, permission_mode: 'default' }), /Every command waits for the owner's yes/);
  assert.match(piSandboxNote({ ...base, permission_mode: 'acceptEdits', sandbox: false }), /without a sandbox/);
});

test("pi sandbox: the ssh agent is out of reach, so a command cannot sign with the owner's key", { skip: skip || (!process.env.SSH_AUTH_SOCK && 'no ssh agent here') }, () => {
  const r = rig();
  const x = r.sh('ssh-add -l');
  assert.equal(x.status, 2, `the agent answered: ${x.stdout}${x.stderr}`);
});
