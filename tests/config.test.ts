import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { Config } from '../src/instance/config/schema.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError, configWarnings } from '../src/instance/config/load.js';

function fixture(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-cfg-'));
  mkdirSync(join(dir, 'fam'));
  mkdirSync(join(dir, 'code'));
  const path = join(dir, 'routing.yaml');
  writeFileSync(path, yaml.replaceAll('$DIR', dir));
  return path;
}

test('valid example loads with defaults', () => {
  const cfg = loadConfig(fixture(`
profiles:
  family: { cwd: $DIR/fam }
  coding: { cwd: $DIR/code, permission_mode: bypassPermissions, add_dirs: [$DIR] }
routes:
  - { platform: whatsapp, chat: "1@g.us", profile: family, mention: required }
  - { platform: telegram, chat: 123, profile: coding }
whatsapp: {}
telegram: {}
`));
  assert.equal(Object.keys(cfg.profiles).length, 2);
  assert.equal(cfg.profiles.family.permission_mode, 'acceptEdits');
  assert.equal(cfg.routes[1].chat, '123');
  assert.equal(cfg.defaults.unmatched, 'drop');
  assert.equal(cfg.defaults.max_out_per_min, 10);
});

test('unknown profile names the route index', () => {
  assert.throws(
    () => loadConfig(fixture(`
profiles: { family: { cwd: $DIR/fam } }
routes: [ { platform: telegram, chat: 1, profile: nope } ]
`)),
    (e: Error) => e instanceof ConfigError && /routes\[0\]\.profile.*nope/.test(e.message),
  );
});

test('missing cwd fails', () => {
  assert.throws(
    () => loadConfig(fixture(`
profiles: { x: { cwd: $DIR/missing } }
routes: []
`)),
    (e: Error) => e instanceof ConfigError && /not a directory/.test(e.message),
  );
});

test('bypassPermissions on a dir with .env needs unsafe_ok', () => {
  const p = fixture(`
profiles: { x: { cwd: $DIR/fam, permission_mode: bypassPermissions } }
routes: []
`);
  writeFileSync(join(p, '..', 'fam', '.env'), 'SECRET=1');
  assert.throws(() => loadConfig(p), (e: Error) => e instanceof ConfigError && /\.env/.test(e.message));
  writeFileSync(p, `
profiles: { x: { cwd: ${join(p, '..', 'fam')}, permission_mode: bypassPermissions, unsafe_ok: true } }
routes: []
`);
  assert.equal(loadConfig(p).profiles.x.unsafe_ok, true);
});

test('configWarnings flags risky but legal combinations', async () => {
  const { configWarnings } = await import('../src/instance/config/load.js');
  const cfg = Config.parse({
    profiles: { yolo: { cwd: '.', permission_mode: 'bypassPermissions', shell: true } },
    routes: [
      { platform: 'whatsapp', chat: 'g@g.us', profile: 'yolo', mention: 'any' },
      { platform: 'telegram', chat: 5, profile: 'yolo' },
    ],
    defaults: { unmatched: 'reply' },
  });
  const w = configWarnings(cfg);
  assert.equal(w.filter((x) => x.startsWith('routes[0]')).length, 3);
  assert.equal(w.filter((x) => x.startsWith('routes[1]')).length, 0);
  assert.ok(w.some((x) => x.startsWith('defaults.unmatched')));
});

test('configWarnings: tui on a grok profile is named; on Claude it is silent', async () => {
  const { configWarnings } = await import('../src/instance/config/load.js');
  const cfg = Config.parse({
    profiles: { g: { cwd: '.', backend: 'grok', tui: true }, plain: { cwd: '.' }, real: { cwd: '.', tui: true } },
    routes: [],
  });
  // No routes here, so every profile also earns the "nothing reaches it" warning; this test is
  // only about the tui one.
  const w = configWarnings(cfg).filter((x) => /tui/.test(x));
  assert.equal(w.filter((x) => x.startsWith('profiles.g')).length, 1);
  assert.equal(w.filter((x) => x.startsWith('profiles.plain')).length, 0);
  assert.equal(w.filter((x) => x.startsWith('profiles.real')).length, 0);
});

test('the secret guard covers add_dirs, not only cwd, and unsafe_ok still opts out', () => {
  const home = mkdtempSync(join(tmpdir(), 'angelia-cfg-'));
  const work = join(home, 'work'); mkdirSync(work);
  const side = join(home, 'side'); mkdirSync(side);
  mkdirSync(join(side, 'secrets'));           // the grant next door, not the profile's own folder
  const write = (profile: Record<string, unknown>) => {
    const p = join(home, 'r.yaml');
    writeFileSync(p, JSON.stringify({ profiles: { a: profile }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], telegram: {} }));
    return p;
  };
  assert.throws(() => loadConfig(write({ cwd: work, permission_mode: 'bypassPermissions', add_dirs: [side] })),
    /which it can also reach, containing secrets/);
  // The same grant is fine once it is stated out loud, and fine without bypass.
  assert.ok(loadConfig(write({ cwd: work, permission_mode: 'bypassPermissions', add_dirs: [side], unsafe_ok: true })));
  assert.ok(loadConfig(write({ cwd: work, permission_mode: 'acceptEdits', add_dirs: [side] })));
});

test('a profile no route names is called out', () => {
  const cfg = Config.parse({
    profiles: { live: { cwd: '.' }, orphan: { cwd: '.' } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'live' }],
  });
  const w = configWarnings(cfg);
  assert.ok(w.some((l) => /profiles\.orphan: no route names it/.test(l)), w.join('\n'));
  assert.ok(!w.some((l) => /profiles\.live: no route/.test(l)));
});

test('a deny rule that covers the profile\'s own folder is named: the agent could not write its own memory', async () => {
  const { selfDenyWarnings } = await import('../src/instance/config/load.js');
  const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'angelia-home-'));
  const cwd = join(home, '.angelia', 'workspace', 'profiles', 'trader');
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Edit(~/.angelia/**)', 'Read(~/.angelia/wa/**)', 'Edit(~/.angelia/env)', `Read(//${join(home, '.angelia', 'workspace')}/**)`, 'Edit(~/elsewhere/**)'] } }));
  const w = selfDenyWarnings('trader', cwd, home);
  assert.equal(w.length, 2, w.join('\n'));
  assert.match(w[0], /denies Edit\(~\/\.angelia\/\*\*\), which covers the profile's own folder .*cannot write its own files/);
  assert.match(w[1], /denies Read\(\/\/.*workspace\/\*\*\).*cannot read its own files/);
  mkdirSync(join(home, 'clean', '.claude'), { recursive: true });
  assert.deepEqual(selfDenyWarnings('clean', join(home, 'clean'), home), [], 'no settings file, no warning');
  // The broadest deny there is: the root. It covers every folder, the profile's included.
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Edit(//**)'] } }));
  assert.match(selfDenyWarnings('trader', cwd, home).join('\n'), /denies Edit\(\/\/\*\*\).*cannot write its own files/);
  // /x is from the profile's folder, not the machine's root; x and ./x too.
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Edit(/memory/**)', 'Edit(/**)', 'Read(./**)', `Read(${join(home, '.angelia')}/**)`] } }));
  assert.deepEqual(selfDenyWarnings('trader', cwd, home).map((w) => /denies (\S+)/.exec(w)![1]), ['Edit(/**),', 'Read(./**),']);
});

test('a table from before payments were removed still loads; each leftover key is named for deletion', () => {
  const cfg = loadConfig(fixture(`
profiles:
  buyer: { cwd: $DIR/code, pay: true, approvals: passkey }
routes:
  - { platform: telegram, chat: 123, profile: buyer }
telegram: {}
approvals: { page_url: https://approve.example.com/ }
pay: { currency: ILS, max_per_purchase: 300, max_per_day: 600 }
defaults: { unmatched: onboard }
onboard: { owners: ["1"], profile: { approvals: chat } }
`));
  assert.equal('pay' in cfg.profiles.buyer, false);
  const removed = configWarnings(cfg).filter((w) => /removed from Angelia/.test(w)).map((w) => w.split(':')[0]);
  assert.deepEqual(removed, ['pay', 'approvals', 'profiles.buyer.pay', 'profiles.buyer.approvals', 'onboard.profile.approvals']);
  assert.equal(configWarnings(loadConfig(fixture(`
profiles:
  a: { cwd: $DIR/code }
routes:
  - { platform: telegram, chat: 123, profile: a }
telegram: {}
`))).some((w) => /removed from Angelia/.test(w)), false);
});

// Every place a setting lives, spelt right. Each case below misspells one key in a copy of it.
const strictBase = () => ({
  capabilities: {
    notes: { kind: 'skill', path: '$DIR/code', secrets: [] },
    maps: { kind: 'mcp', command: 'maps-server', args: [] },
    lint: { kind: 'command', run: 'lint', when: 'checking code' },
    docs: { kind: 'directory', path: '$DIR/fam' },
  },
  profiles: { social: { cwd: '$DIR/fam', sandbox: true, isolated: true, deny: ['maps'], agent_commands: ['compact'], media_tags: false } },
  routes: [{ platform: 'whatsapp', chat: '1@g.us', profile: 'social', allow_from: ['2'], owners: ['1'] }],
  whatsapp: { phone: '+15550000000' },
  telegram: { token_env: 'TELEGRAM_BOT_TOKEN' },
  onboard: { owners: ['1'], profile: { permission_mode: 'default' } },
  defaults: { deny: ['lint'] },
});
type StrictTable = ReturnType<typeof strictBase> & Record<string, unknown>;

test('a misspelt key anywhere in the table is an error that names its full path', () => {
  assert.equal(loadConfig(fixture(stringify(strictBase()))).profiles.social.sandbox, true, 'control: every key spelt right loads');
  const cases: [string, (t: StrictTable) => void][] = [
    ['profiles.social.sanbox', (t) => { Object.assign(t.profiles.social, { sanbox: true }); }],
    ['profiles.social.isolatd', (t) => { Object.assign(t.profiles.social, { isolatd: true }); }],
    ['profiles.social.denny', (t) => { Object.assign(t.profiles.social, { denny: ['maps'] }); }],
    ['profiles.social.agent_comands', (t) => { Object.assign(t.profiles.social, { agent_comands: ['compact'] }); }],
    ['profiles.social.media_tag', (t) => { Object.assign(t.profiles.social, { media_tag: false }); }],
    ['routes.0.allow_form', (t) => { Object.assign(t.routes[0], { allow_form: ['3'] }); }],
    ['routes.0.owner', (t) => { Object.assign(t.routes[0], { owner: ['1'] }); }],
    ['defaults.dney', (t) => { Object.assign(t.defaults, { dney: ['maps'] }); }],
    ['route', (t) => { t.route = []; }],
    ['whatsapp.phon', (t) => { Object.assign(t.whatsapp, { phon: '+15550000000' }); }],
    ['telegram.token_envv', (t) => { Object.assign(t.telegram, { token_envv: 'BOT' }); }],
    ['onboard.owner', (t) => { Object.assign(t.onboard, { owner: ['1'] }); }],
    ['onboard.profile.permision_mode', (t) => { Object.assign(t.onboard.profile, { permision_mode: 'plan' }); }],
    ['capabilities.notes.secrests', (t) => { Object.assign(t.capabilities.notes, { secrests: ['$DIR/code/.env'] }); }],
    ['capabilities.maps.arg', (t) => { Object.assign(t.capabilities.maps, { arg: ['--port'] }); }],
    ['capabilities.lint.wen', (t) => { Object.assign(t.capabilities.lint, { wen: 'checking code' }); }],
    ['capabilities.docs.paht', (t) => { Object.assign(t.capabilities.docs, { paht: '$DIR/code' }); }],
  ];
  for (const [path, misspell] of cases) {
    const t = strictBase() as StrictTable;
    misspell(t);
    assert.throws(() => loadConfig(fixture(stringify(t))), (e: Error) => e instanceof ConfigError && e.message.includes(`${path}: unknown key`), path);
  }
});

test('a removed key does not hide a misspelt one next to it', () => {
  assert.throws(() => loadConfig(fixture(`
profiles:
  buyer: { cwd: $DIR/code, pay: true, sanbox: true }
routes: []
pay: { currency: ILS }
`)), (e: Error) => e instanceof ConfigError && /^profiles\.buyer\.sanbox: unknown key/.test(e.message));
});

test('routing.example.yaml matches the schema', () => {
  const example = parse(readFileSync(join(import.meta.dirname, '..', 'routing.example.yaml'), 'utf8'));
  const parsed = Config.safeParse(example);
  assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
});

test('a group open to everyone ("*") is named, with the other profiles it can reach; a group nobody can talk in too', async () => {
  const { configWarnings } = await import('../src/instance/config/load.js');
  const { Config } = await import('../src/instance/config/schema.js');
  const cfg = Config.parse({
    profiles: { fam: { cwd: '/tmp/fam' }, shut: { cwd: '/tmp/shut', isolated: true } },
    routes: [
      { platform: 'whatsapp', chat: 'open@g.us', profile: 'fam', owners: ['1'], allow_from: ['*'] },
      { platform: 'whatsapp', chat: 'mine@g.us', profile: 'fam', owners: ['1'] },
      { platform: 'whatsapp', chat: 'listed@g.us', profile: 'fam', owners: ['1'], allow_from: ['1', '2'] },
      { platform: 'whatsapp', chat: 'nobody@g.us', profile: 'fam' },
      { platform: 'whatsapp', chat: 'walled@g.us', profile: 'shut', owners: ['1'], allow_from: ['*'] },
      { platform: 'telegram', chat: 5, profile: 'fam' },
    ],
  });
  const w = configWarnings(cfg).filter((x) => /allow_from/.test(x));
  assert.equal(w.length, 3, w.join('\n'));
  assert.match(w[0], /open@g\.us.*allow_from: "\*", so every member.*message your other profiles; set isolated: true on fam/);
  assert.match(w[1], /nobody@g\.us.*nobody in this group can talk/);
  assert.match(w[2], /walled@g\.us.*every member/);
  assert.doesNotMatch(w[2], /other profiles/, 'an isolated profile reaches none');
});

test('a route for a platform the table does not set up is refused when the table loads', async () => {
  const { loadConfig, ConfigError } = await import('../src/instance/config/load.js');
  const { writeFileSync: w, mkdtempSync: m } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const { join: j } = await import('node:path');
  const dir = m(j(td(), 'angelia-cfg-'));
  const table = j(dir, 'routing.yaml');
  w(table, `profiles:\n  a: { cwd: ${dir} }\nroutes:\n  - { platform: whatsapp, chat: "g@g.us", profile: a }\ntelegram: { token_env: TELEGRAM_BOT_TOKEN }\n`);
  assert.throws(() => loadConfig(table), (e: Error) => e instanceof ConfigError && /routes\[0\]: a whatsapp route, and the table has no whatsapp: block/.test(e.message));
});

test('a group open to every member on a bypassPermissions profile loads only with the sandbox or an allow_from', () => {
  const table = (extra: string, route = '') => fixture(`
profiles:
  yolo: { cwd: $DIR/fam, permission_mode: bypassPermissions${extra} }
routes:
  - { platform: whatsapp, chat: g@g.us, profile: yolo${route} }
whatsapp: {}
`);
  const everyone = ', allow_from: ["*"]';
  assert.throws(() => loadConfig(table('', everyone)), /routes\[0\].*profile yolo, open to every member.*bypassPermissions.*sandbox: true/);
  assert.equal(loadConfig(table(', sandbox: true', everyone)).profiles.yolo.sandbox, true);
  assert.throws(() => loadConfig(table(', sandbox: true, backend: grok', everyone)), /without a sandbox/, 'grok has no sandbox to hold it');
  assert.deepEqual(loadConfig(table('', ', allow_from: ["15550000001"]')).routes[0].allow_from, ['15550000001']);
  assert.deepEqual(loadConfig(table('')).routes[0].allow_from, [], 'no allow_from: the owners only, nothing to refuse');
});
