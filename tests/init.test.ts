import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit, readEnvToken, ensureProfileDir, type Ask, type PairedChat } from '../src/instance/init.js';
import { builtinVoiceTools } from '../src/voice/setup.js';
import { loadConfig } from '../src/instance/config/load.js';

/** No test may touch a real `gh` or a real GitHub account; git init in a temp dir is fine. The machine
 *  has the voice tools and no coding CLI in reach, so the wizard picks Claude Code without asking. */
const machine = {
  ghReady: () => false, createRepo: () => 'not in tests', hasBin: (b: string) => b === 'whisper' || b === 'ffmpeg',
  linkWhatsApp: async () => { throw new Error('WhatsApp is not linked in this test'); },
  waitForWhatsAppChat: async (): Promise<PairedChat> => { throw new Error('no WhatsApp in this test'); },
  trustGrok: async () => true,
  cloneAngelia: () => { throw new Error('no clone in this test'); },
};

/** Scripted answers: each question pops the next answer of its kind. */
function scripted(answers: { text?: string[]; secret?: string[]; choose?: string[]; confirm?: boolean[] }) {
  const said: string[] = [];
  const pop = <T>(arr: T[] | undefined, what: string): T => { if (!arr?.length) throw new Error(`no scripted ${what} answer`); return arr.shift()!; };
  const ask: Ask = {
    say: (l) => said.push(l),
    text: async (_q, def) => { const a = pop(answers.text, 'text'); return a === '' ? def! : a; },
    secret: async () => pop(answers.secret, 'secret'),
    choose: async (_q, _o, def) => (pop(answers.choose, 'choose') || def) as never,
    confirm: async (_q, def) => { const a = answers.confirm?.shift(); return a === undefined ? def! : a; },
  };
  return { ask, said };
}

test('quick path: bad token then good, pair one DM, config loads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const cwd = join(dir, 'home');
  // shell yes · pair stranger? no · pair Owner? yes
  const { ask, said } = scripted({ choose: ['quick', 'telegram', 'builtin', 'builtin', 'acceptEdits'], secret: ['bad', 'good'], text: [cwd], confirm: [true, false, true] });
  const chats: PairedChat[] = [{ id: '999', title: 'Stranger', isGroup: false }, { id: '5554', title: 'Owner', isGroup: false }];
  const r = await runInit({
    ask, stateDir: dir, ...machine,
    verifyToken: async (t) => { if (t !== 'good') throw new Error('401'); return 'mybot'; },
    waitForChat: async () => chats.shift()!,
  });
  assert.equal(readEnvToken(r.envPath), 'good');
  assert.equal(statSync(r.envPath).mode & 0o777, 0o600);
  assert.ok(said.some((l) => /rejected/.test(l)));
  const cfg = loadConfig(r.configPath);
  assert.deepEqual(Object.keys(cfg.profiles), ['main']);
  assert.equal(cfg.profiles.main.cwd, cwd);
  assert.equal(cfg.profiles.main.shell, true);
  assert.deepEqual(cfg.routes.map((x) => [x.chat, x.profile, x.mention]), [['5554', 'main', undefined]]);
  assert.ok(existsSync(join(cwd, 'CLAUDE.md')));
  assert.doesNotMatch(readFileSync(r.configPath, 'utf8'), /good/);
});

test('advanced path: two profiles, a group gets mention: required, stored token reused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const { ask } = scripted({
    choose: ['advanced', 'telegram', 'builtin', 'builtin', 'bypassPermissions', 'acceptEdits'],
    text: ['coding', join(dir, 'coding'), 'family', join(dir, 'family')],
    // keep token? yes · coding: shell yes, pair? yes, another chat? no, another profile? yes · family: shell no, pair? yes, open Family to all? no, another chat? yes, pair? yes, open Cousins to all? yes, another chat? no, another profile? no
    confirm: [true, true, true, false, true, false, true, false, true, true, true, false, false],
  });
  const chats: PairedChat[] = [
    { id: '5554', title: 'Owner', isGroup: false },
    { id: '-100777', title: 'Family', isGroup: true, sender: '5554' },
    { id: '-100888', title: 'Cousins', isGroup: true, sender: '5554' },
  ];
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'env'), 'TELEGRAM_BOT_TOKEN=stored\n');
  let verified = '';
  const r = await runInit({ ask, stateDir: dir, ...machine, verifyToken: async (t) => { verified = t; return 'mybot'; }, waitForChat: async () => chats.shift()! });
  assert.equal(verified, 'stored');
  const cfg = loadConfig(r.configPath);
  assert.deepEqual(Object.keys(cfg.profiles), ['coding', 'family']);
  assert.equal(cfg.profiles.coding.permission_mode, 'bypassPermissions');
  assert.equal(cfg.profiles.coding.shell, true);
  assert.equal(cfg.profiles.family.shell, false);
  assert.deepEqual(cfg.routes.map((x) => [x.chat, x.profile, x.mention]), [
    ['5554', 'coding', undefined], ['-100777', 'family', 'required'], ['-100888', 'family', 'required'],
  ]);
  assert.deepEqual(cfg.routes.map((x) => x.owners), [[], ['5554'], ['5554']]);
  assert.deepEqual(cfg.routes.map((x) => x.allow_from), [[], [], ['*']], 'a group admits only its owner, the person who paired it, unless opened to everyone');
});

test('backend question: asked only when several CLIs are installed; one installed CLI is picked silently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const cwd = join(dir, 'main');
  const asked: string[] = [];
  const many = scripted({ choose: ['quick', 'telegram', 'builtin', 'builtin', 'grok', 'acceptEdits'], secret: ['good'], text: [cwd], confirm: [false, true] });
  const origChoose = many.ask.choose;
  many.ask.choose = (q, o, d) => { asked.push(q); return origChoose(q, o, d); };
  const r = await runInit({ ask: many.ask, stateDir: dir, ...machine, verifyToken: async () => 'mybot', waitForChat: async () => ({ id: '1', title: 'me', isGroup: false }), hasBin: () => true });
  assert.ok(asked.some((q) => q.startsWith('Which CLI answers')));
  assert.equal(loadConfig(r.configPath).profiles.main.backend, 'grok');
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(join(cwd, 'CLAUDE.md')));

  const dir2 = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const one = scripted({ choose: ['quick', 'telegram', 'builtin', 'builtin', 'acceptEdits'], secret: ['good'], text: [join(dir2, 'main')], confirm: [false, true] });
  const r2 = await runInit({ ask: one.ask, stateDir: dir2, ...machine, verifyToken: async () => 'mybot', waitForChat: async () => ({ id: '1', title: 'me', isGroup: false }), hasBin: (b) => b === 'grok' });
  assert.equal(loadConfig(r2.configPath).profiles.main.backend, 'grok');
  assert.ok(existsSync(join(dir2, 'main', 'CLAUDE.md')));
});

test('hearing and speaking are asked, not assumed: own command, none, and the install hint', async () => {
  // A command of the operator's own: it is what the instruction file names, and nothing of ours appears.
  const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const a = scripted({
    choose: ['quick', 'telegram', 'own', 'own', 'acceptEdits'],
    secret: ['good'],
    text: ['curl-stt', 'curl-tts', join(dir, 'main')],
    confirm: [false, true],
  });
  await runInit({ ask: a.ask, stateDir: dir, ...machine, verifyToken: async () => 'mybot', waitForChat: async () => ({ id: '1', title: 'me', isGroup: false }), hasBin: (b) => b === 'claude' });
  const own = readFileSync(join(dir, 'main', 'CLAUDE.md'), 'utf8');
  assert.match(own, /curl-stt <path>/);
  assert.match(own, /curl-tts "<what to say>"/);
  assert.doesNotMatch(own, /transcribe\.mjs|speak\.mjs/);
  // Missing whisper is a note with the install line, not a decision taken for the operator.
  assert.ok(a.said.some((l) => /whisper and ffmpeg not installed/.test(l) && /brew install openai-whisper ffmpeg/.test(l)));

  // Declining both: the file says so plainly instead of naming a command that does not exist.
  const dir2 = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const b = scripted({ choose: ['quick', 'telegram', 'none', 'none', 'acceptEdits'], secret: ['good'], text: [join(dir2, 'main')], confirm: [false, true] });
  await runInit({ ask: b.ask, stateDir: dir2, verifyToken: async () => 'mybot', waitForChat: async () => ({ id: '1', title: 'me', isGroup: false }), hasBin: (x) => ['claude', 'whisper', 'ffmpeg'].includes(x) });
  const none = readFileSync(join(dir2, 'main', 'CLAUDE.md'), 'utf8');
  assert.match(none, /\[voice note: path\]/);
  assert.match(none, /cannot hear it and ask for the request in text/);
  assert.doesNotMatch(none, /voice note instead of text/);
});

test('choosing what ships: the built-in pair by command, never an install path, never the fast-but-wrong whisper model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-instr-'));
  ensureProfileDir({ name: 'notes', cwd: dir, backend: 'claude-code', permission_mode: 'acceptEdits', shell: false }, builtinVoiceTools());
  const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  // A path breaks the day the package moves; `angelia` is on PATH wherever it is installed.
  assert.match(text, /`angelia transcribe <path>`/);
  assert.match(text, /`angelia speak "<what to say>"`/);
  assert.doesNotMatch(text, /\.mjs|node_modules|--model base/);
});


test('init refuses to eat an existing routing table, and backs it up when told to replace it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const configPath = join(dir, 'routing.yaml');
  const before = 'profiles:\n  mine:\n    cwd: /tmp\nroutes: []\n';
  writeFileSync(configPath, before);

  // Default answer: keep. Nothing else is asked, and nothing is touched.
  const keep = scripted({ choose: ['keep'] });
  const r = await runInit({ ask: keep.ask, stateDir: dir, ...machine, verifyToken: async () => 'b', waitForChat: async () => ({ id: '1', title: 't', isGroup: false }) });
  assert.equal(r.kept, true);
  assert.equal(readFileSync(configPath, 'utf8'), before);
  assert.ok(keep.said.some((l) => /already a routing table/.test(l)));

  // Replace: the wizard runs, and the old table is beside the new one.
  const { ask, said } = scripted({ choose: ['replace', 'quick', 'telegram', 'builtin', 'builtin', 'acceptEdits'], secret: ['good'], text: [dir], confirm: [true, false, true] });
  await runInit({ ask, stateDir: dir, ...machine, verifyToken: async () => 'mybot', waitForChat: async () => ({ id: '5554', title: 'Owner', isGroup: false }) });
  assert.notEqual(readFileSync(configPath, 'utf8'), before);
  const saved = readdirSync(dir).find((f) => f.endsWith('.bak'))!;
  assert.ok(saved, 'a backup was written');
  assert.equal(readFileSync(join(dir, saved), 'utf8'), before);
  assert.equal(statSync(join(dir, saved)).mode & 0o777, 0o600);
  assert.ok(said.some((l) => /Old table saved as/.test(l)));
});

test('a new profile in the workspace gets the deny floor before its agent starts; one outside it only when you say yes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const { ask } = scripted({ choose: ['quick', 'telegram', 'builtin', 'builtin', 'acceptEdits'], secret: ['good'], text: [''], confirm: [false, true] });
  const r = await runInit({ ask, stateDir: dir, ...machine, verifyToken: async () => 'mybot', waitForChat: async () => ({ id: '1', title: 'me', isGroup: false }) });
  const cwd = loadConfig(r.configPath).profiles.main.cwd;
  assert.ok(cwd.startsWith(join(dir, 'workspace', 'profiles')), cwd);
  const deny: string[] = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')).permissions.deny;
  // A state folder outside the home folder is written in Claude's absolute form, //path.
  for (const r of [`Read(/${join(dir, 'env')})`, `Edit(/${join(dir, 'env')})`, `Read(/${join(dir, 'wa', '**')})`, `Read(/${join(dir, 'api.token')})`]) assert.ok(deny.includes(r), r);

  const out = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const two = scripted({ choose: ['quick', 'telegram', 'builtin', 'builtin', 'acceptEdits'], secret: ['good'], text: [join(out, 'mine')], confirm: [false, true, false] });
  await runInit({ ask: two.ask, stateDir: out, ...machine, verifyToken: async () => 'mybot', waitForChat: async () => ({ id: '1', title: 'me', isGroup: false }) });
  assert.ok(two.said.includes('Later: angelia compile main --write'));
  assert.ok(!existsSync(join(out, 'mine', '.claude', 'settings.json')), 'a folder of yours is not written into unasked');

  const yes = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const three = scripted({ choose: ['quick', 'telegram', 'builtin', 'builtin', 'acceptEdits'], secret: ['good'], text: [join(yes, 'mine')], confirm: [false, true, true] });
  await runInit({ ask: three.ask, stateDir: yes, ...machine, verifyToken: async () => 'mybot', waitForChat: async () => ({ id: '1', title: 'me', isGroup: false }) });
  assert.ok(existsSync(join(yes, 'mine', '.claude', 'settings.json')), 'written when you say yes');
});

test('a new token replaces one line of the env file; the capability secrets beside it stay', async () => {
  const { setEnvVar } = await import('../src/core/env.js');
  const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const env = join(dir, 'env');
  const { writeFileSync: w } = await import('node:fs');
  w(env, 'export TELEGRAM_BOT_TOKEN="old"\nBANK_USER=me\nBANK_PASS=secret\n');
  assert.equal(readEnvToken(env), 'old', 'export and quotes, as the daemon reads them');
  setEnvVar(env, 'TELEGRAM_BOT_TOKEN', 'new');
  assert.equal(readFileSync(env, 'utf8'), 'TELEGRAM_BOT_TOKEN=new\nBANK_USER=me\nBANK_PASS=secret\n');
  assert.equal(statSync(env).mode & 0o777, 0o600);
  setEnvVar(join(dir, 'fresh'), 'TELEGRAM_BOT_TOKEN', 't');
  assert.equal(readFileSync(join(dir, 'fresh'), 'utf8'), 'TELEGRAM_BOT_TOKEN=t\n');
});

test('WhatsApp only: links once, pairs a confirmed chat, writes a whatsapp block and no Telegram', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const linked: string[] = [];
  let tries = 0;
  // link fails once, try again? yes · shell no · pair stranger? no · pair owner? yes
  const { ask, said } = scripted({ choose: ['quick', 'whatsapp', 'builtin', 'builtin', 'acceptEdits'], text: [join(dir, 'main')], confirm: [true, false, false, true] });
  const chats: PairedChat[] = [{ id: '15550001@s.whatsapp.net', title: 'Stranger', isGroup: false }, { id: '15559999@s.whatsapp.net', title: 'Me (15559999)', isGroup: false, sender: '15559999' }];
  const r = await runInit({
    ask, stateDir: dir, ...machine,
    verifyToken: async () => { throw new Error('Telegram was not chosen'); },
    waitForChat: async () => { throw new Error('Telegram was not chosen'); },
    linkWhatsApp: async (authDir) => { if (++tries === 1) throw new Error('no link within 10 minutes'); linked.push(authDir); },
    waitForWhatsAppChat: async (authDir) => { assert.equal(authDir, join(dir, 'wa')); return chats.shift()!; },
  });
  assert.deepEqual(linked, [join(dir, 'wa')]);
  assert.ok(said.some((l) => /second, established number/.test(l)), 'the own-number warning comes before the link');
  assert.ok(said.some((l) => /not linked: no link within 10 minutes/.test(l)));
  const cfg = loadConfig(r.configPath);
  assert.equal(cfg.whatsapp?.auth_dir, join(dir, 'wa'));
  assert.equal(cfg.telegram, undefined);
  assert.deepEqual(cfg.routes.map((x) => [x.platform, x.chat, x.profile]), [['whatsapp', '15559999@s.whatsapp.net', 'main']]);
  assert.equal(readEnvToken(r.envPath), undefined);
});

test('an account already linked is kept; a declined retry stops setup before anything is written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'wa'), { recursive: true });
  writeFileSync(join(dir, 'wa', 'creds.json'), '{}');
  const kept = scripted({ choose: ['quick', 'whatsapp', 'builtin', 'builtin', 'acceptEdits'], text: [join(dir, 'main')], confirm: [false, true] });
  const r = await runInit({
    ask: kept.ask, stateDir: dir, ...machine, verifyToken: async () => 'x', waitForChat: async () => { throw new Error('no'); },
    waitForWhatsAppChat: async () => ({ id: '120363000000000001@g.us', title: 'Home', isGroup: true, sender: '15559999' }),
  });
  assert.ok(kept.said.some((l) => /already linked/.test(l)));
  const route = loadConfig(r.configPath).routes[0];
  assert.deepEqual([route.platform, route.mention, route.owners, route.allow_from], ['whatsapp', 'required', ['15559999'], []], 'a WhatsApp group: mention, the person who paired it as owner, only them');

  const dir2 = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const gave = scripted({ choose: ['quick', 'whatsapp'], confirm: [false] });
  await assert.rejects(runInit({ ask: gave.ask, stateDir: dir2, ...machine, verifyToken: async () => 'x', waitForChat: async () => { throw new Error('no'); } }), /WhatsApp not linked/);
  assert.ok(!existsSync(join(dir2, 'workspace', 'routing.yaml')));
});

test('both apps: each chat in the app picked for it; the self-development profile reaches its clone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  const cloned: string[] = [];
  const { ask } = scripted({
    choose: ['advanced', 'both', 'builtin', 'builtin', 'acceptEdits', 'telegram', 'whatsapp', 'acceptEdits', 'whatsapp'],
    secret: ['good'],
    text: ['coding', '', ''],
    // shell no · pair DM yes · another chat yes · pair group yes · open it no · another chat no · another profile no ·
    // self-dev yes · its shell no · pair yes · another chat no
    confirm: [false, true, true, true, false, false, false, true, false, true, false],
  });
  const r = await runInit({
    ask, stateDir: dir, ...machine,
    verifyToken: async () => 'mybot', waitForChat: async () => ({ id: '5554', title: 'Owner', isGroup: false }),
    linkWhatsApp: async () => {},
    waitForWhatsAppChat: async () => (cloned.length
      ? { id: '15559999@s.whatsapp.net', title: 'Me', isGroup: false, sender: '15559999' }
      : { id: '120363000000000001@g.us', title: 'Home', isGroup: true, sender: '15559999' }),
    cloneAngelia: (dest) => { cloned.push(dest); return `Cloned Angelia into ${dest}.`; },
  });
  const src = join(dir, 'projects', 'angelia');
  assert.deepEqual(cloned, [src]);
  const cfg = loadConfig(r.configPath);
  assert.deepEqual(cfg.routes.map((x) => [x.platform, x.chat, x.profile]), [
    ['telegram', '5554', 'coding'], ['whatsapp', '120363000000000001@g.us', 'coding'], ['whatsapp', '15559999@s.whatsapp.net', 'angelia-dev'],
  ]);
  assert.ok(cfg.telegram && cfg.whatsapp);
  assert.deepEqual(cfg.profiles['angelia-dev'].add_dirs, [src]);
  const md = readFileSync(join(cfg.profiles['angelia-dev'].cwd, 'CLAUDE.md'), 'utf8');
  assert.match(md, /installed package, not this clone/);
});

test('a grok profile: its folder is trusted in grok when you say yes, and you are told when it did not hold', async () => {
  const run = async (confirm: boolean[], trust: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
    const trusted: string[] = [];
    const s = scripted({ choose: ['quick', 'telegram', 'builtin', 'builtin', 'acceptEdits'], secret: ['good'], text: [join(dir, 'main')], confirm });
    await runInit({
      ask: s.ask, stateDir: dir, ...machine, hasBin: (b) => b === 'grok',
      verifyToken: async () => 'mybot', waitForChat: async () => ({ id: '1', title: 'me', isGroup: false }),
      trustGrok: async (cwd) => { trusted.push(cwd); return trust; },
    });
    return { trusted, said: s.said, cwd: join(dir, 'main') };
  };
  // shell no · pair yes · deny rules outside the workspace yes · trust yes
  const yes = await run([false, true, true, true], true);
  assert.deepEqual(yes.trusted, [yes.cwd]);
  assert.ok(yes.said.includes(`grok trusts ${yes.cwd}.`));
  const failed = await run([false, true, true, true], false);
  assert.ok(failed.said.some((l) => /did not confirm the trust\. Later: run grok --trust/.test(l)));
  const no = await run([false, true, true, false], true);
  assert.deepEqual(no.trusted, []);
  assert.ok(no.said.some((l) => l.startsWith('Later: run grok --trust')));
});

test('a failed clone leaves out the self-development profile and says how to add it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
  // shell no · pair yes · another chat no · another profile no · self-dev yes
  const { ask, said } = scripted({ choose: ['advanced', 'telegram', 'builtin', 'builtin', 'acceptEdits'], secret: ['good'], text: ['coding', ''], confirm: [false, true, false, false, true] });
  const r = await runInit({ ask, stateDir: dir, ...machine, verifyToken: async () => 'mybot', waitForChat: async () => ({ id: '1', title: 'me', isGroup: false }) });
  assert.deepEqual(Object.keys(loadConfig(r.configPath).profiles), ['coding']);
  assert.ok(said.some((l) => /Could not clone Angelia \(no clone in this test\)/.test(l)));
});

test('the wizard offers the service at the end: yes starts it for the table it wrote, a failure says how to retry, no leaves the commands', async () => {
  const run = async (keep: boolean, startService: (c: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'angelia-init-'));
    // shell no · pair Owner? yes · the rest default, except the service question, answered by its text
    const s = scripted({ choose: ['quick', 'telegram', 'builtin', 'builtin', 'acceptEdits'], secret: ['good'], text: [join(dir, 'main')], confirm: [false, true] });
    const confirm = s.ask.confirm;
    s.ask.confirm = async (q, def) => (q.startsWith('Keep Angelia running?') ? keep : confirm(q, def));
    const r = await runInit({ ask: s.ask, stateDir: dir, ...machine, verifyToken: async () => 'mybot', waitForChat: async () => ({ id: '5554', title: 'Owner', isGroup: false }), startService });
    return { r, said: s.said };
  };
  const started: string[] = [];
  const yes = await run(true, async (c) => { started.push(c); });
  assert.deepEqual(started, [yes.r.configPath]);
  assert.ok(yes.said.some((l) => l.startsWith('Done. Send your chat a message')));
  assert.ok(!yes.said.some((l) => /angelia daemon/.test(l)));

  const failed = await run(true, async () => { throw new Error('launchctl bootstrap failed: exit 5'); });
  assert.ok(failed.said.some((l) => /The service was not installed: launchctl bootstrap failed/.test(l)));
  assert.ok(failed.said.some((l) => l === 'Start it with:  angelia service install ' + failed.r.configPath));

  const no = await run(false, async () => { throw new Error('must not be called'); });
  assert.ok(no.said.some((l) => /^Start it with: {2}angelia daemon /.test(l)));
  assert.ok(no.said.some((l) => /angelia service install /.test(l)));
});
