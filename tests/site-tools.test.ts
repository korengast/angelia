import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- the site's tools are plain JavaScript, without types
import { buildSettings, settingsText, commandRule, domainOf, mcpName, PRESETS, DEFAULTS, SCHEMA } from '../site/tools/claude-code-permissions/rules.js';
// @ts-expect-error -- the site's tools are plain JavaScript, without types
import { checkBot, cleanToken, chatsFrom, routeLine, CheckError, TOKEN } from '../site/tools/telegram-bot-check/bot.js';
// @ts-expect-error -- the site's Worker is plain JavaScript, without types
import worker, { PAGE_CSP } from '../site/worker/main.js';

const site = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const page = (slug: string) => readFileSync(join(site, 'tools', `${slug}.html`), 'utf8');

// --- The permissions builder ---------------------------------------------------------------------

/** `Tool` or `Tool(specifier)`, the only shape the docs give a rule (code.claude.com/docs/en/permissions). */
const RULE = /^(\*|mcp__[\w*-]+|[A-Z][A-Za-z]+)(\((.+)\))?$/s;

test('site tools: the default choices make valid JSON with the secrets denied and nothing to warn about', () => {
  const { settings, warnings } = buildSettings(DEFAULTS);
  const text = settingsText(settings);
  assert.deepEqual(JSON.parse(text), settings);
  assert.equal(settings.$schema, SCHEMA);
  assert.deepEqual(warnings, []);
  const { allow, ask, deny } = settings.permissions;
  for (const r of ['Read(.env)', 'Read(.env.*)', 'Edit(.env)', 'Read(secrets/**)', 'Read(~/.ssh/**)', 'Edit(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.netrc)', 'Bash(sudo *)', 'Bash(git push --force *)'])
    assert.ok(deny.includes(r), `deny has ${r}`);
  assert.deepEqual(ask, ['Bash(git push *)', 'Bash(npm publish *)']);
  assert.ok(allow.includes('Bash(npm run *)'));
  assert.equal(settings.permissions.defaultMode, undefined, 'an unset mode stays unset');
  for (const r of [...allow, ...ask, ...deny]) assert.match(r, RULE);
});

test('site tools: every tick box writes rules in the documented syntax, once each, never a Write() path rule', () => {
  const { settings } = buildSettings({ presets: PRESETS.map((p: { id: string }) => p.id) });
  for (const list of ['allow', 'ask', 'deny']) {
    const rules: string[] = settings.permissions[list];
    assert.equal(new Set(rules).size, rules.length, `${list} has no duplicates`);
    for (const r of rules) {
      assert.match(r, RULE);
      // The docs: Write, NotebookEdit and Glob path rules are accepted and never match.
      assert.doesNotMatch(r, /^(Write|NotebookEdit|Glob)\(/);
    }
  }
  for (const p of PRESETS) for (const r of p.rules) assert.ok(settings.permissions[p.list].includes(r), `${p.id}: ${r} in ${p.list}`);
});

test('site tools: several choices give exactly the file they should', () => {
  const { settings, warnings } = buildSettings({
    mode: 'acceptEdits',
    presets: ['edit', 'env', 'curl'],
    commands: { allow: '$ make build\n\ncargo test *\nBash(go vet *)', ask: 'docker compose down', deny: 'terraform apply *' },
    domains: 'https://docs.python.org/3/\n*.github.com\ndomain:example.com',
    mcp: 'github\nmy.server',
    denyPaths: 'config/credentials.json\n//etc/private/**',
    dirs: '../shared-lib\n../shared-lib',
    disableBypass: true, blockOutside: true,
  });
  assert.deepEqual(settings, {
    $schema: SCHEMA,
    permissions: {
      allow: ['Edit(./**)', 'Bash(make build)', 'Bash(cargo test *)', 'Bash(go vet *)', 'WebFetch(domain:docs.python.org)', 'WebFetch(domain:*.github.com)', 'WebFetch(domain:example.com)', 'mcp__github__*', 'mcp__my_server__*'],
      ask: ['Bash(docker compose down)'],
      deny: ['Read(.env)', 'Edit(.env)', 'Read(.env.*)', 'Edit(.env.*)', 'Bash(curl *)', 'Bash(wget *)', 'Bash(terraform apply *)',
        'Read(config/credentials.json)', 'Edit(config/credentials.json)', 'Read(//etc/private/**)', 'Edit(//etc/private/**)'],
      additionalDirectories: ['../shared-lib'],
      defaultMode: 'acceptEdits',
      disableBypassPermissionsMode: 'disable',
      blockReadsOutsideWorkingDirectories: true,
    },
  });
  assert.deepEqual(warnings, ['The MCP server "my.server" appears in tool names as my_server, so the rule uses that.',
    'Folders listed here in a project file do not count as working folders for blockReadsOutsideWorkingDirectories, so the file tools refuse reads in them. Add those folders in ~/.claude/settings.json or with --add-dir instead.']);
  assert.deepEqual(JSON.parse(settingsText(settings)), settings);
});

test('site tools: rules that match more, or less, than they look get a warning', () => {
  const warn = (choices: object) => buildSettings(choices).warnings.join('\n');
  assert.match(warn({ presets: [], commands: { allow: 'git *' } }), /allows every git command/);
  assert.match(warn({ presets: [], commands: { allow: 'git log * main' } }), /a \* before the end/);
  assert.match(warn({ presets: [], commands: { allow: 'npx eslint *' } }), /npx runs the command that follows/);
  assert.doesNotMatch(warn({ presets: [], commands: { allow: 'watch -n 5 make *' } }), /runs the command that follows/, 'watch is an exec wrapper a prefix rule never approves');
  assert.match(warn({ presets: [], commands: { deny: 'Write(docs/**)' } }), /Write\(docs\/\*\*\) would never match.*written as Edit\(docs\/\*\*\)/);
  assert.match(warn({ presets: [], dirs: '../lib', blockOutside: true }), /do not count as working folders for blockReadsOutsideWorkingDirectories/);
  assert.equal(warn({ presets: [], dirs: '../lib' }), '');
  assert.match(warn({ presets: [], denyPaths: '!~/notes/public/**' }), /cannot reopen a path under a ~\/, \/ or \/\/ rule/);
  assert.equal(warn({ presets: [], commands: { allow: 'npm run *\nls -la' } }), '');
  assert.match(warn({ presets: ['web-fetch', 'no-fetch'] }), /WebFetch is in both allow and deny\. Deny wins/);
  assert.match(warn({ presets: ['no-mcp'], mcp: 'github' }), /mcp__\* in deny blocks every MCP server/);
  assert.match(warn({ presets: [], commands: { allow: 'rm -rf build', ask: 'rm -rf build' } }), /in both allow and ask\. Ask wins/);
  assert.match(warn({ presets: [], denyPaths: '/etc/passwd' }), /starts with one slash.*write \/\/etc\/passwd/);
  assert.match(warn({ presets: [], mode: 'dontAsk' }), /dontAsk with no allow rules/);
  assert.match(warn({ presets: [], domains: 'not a domain' }), /"not a domain" is not a domain/);
  assert.throws(() => buildSettings({ mode: 'bypassPermissions' }), /unknown permission mode/);
});

test('site tools: a typed command becomes a Bash rule, a typed rule stays, a URL becomes its host', () => {
  assert.equal(commandRule('npm run build'), 'Bash(npm run build)');
  assert.equal(commandRule('$ npm run build'), 'Bash(npm run build)');
  assert.equal(commandRule('Bash(npm run *)'), 'Bash(npm run *)');
  assert.equal(commandRule('mcp__github__get_issue'), 'mcp__github__get_issue');
  assert.equal(commandRule('WebFetch'), 'WebFetch');
  // Write, NotebookEdit and Glob path rules never match (the docs); their Edit and Read twins do.
  assert.equal(commandRule('Write(docs/**)'), 'Edit(docs/**)');
  assert.equal(commandRule('NotebookEdit(nb/**)'), 'Edit(nb/**)');
  assert.equal(commandRule('Glob(src/**)'), 'Read(src/**)');
  assert.equal(commandRule('Write'), 'Write', 'a bare tool name matches every use and stays');
  // A typed path rule in the deny paths is its path, never Read(Write(...)); a ! line carves out of the presets before it.
  const { settings } = buildSettings({ presets: ['env'], denyPaths: 'Write(build/secret.txt)\n!.env.example' });
  assert.deepEqual(settings.permissions.deny.slice(4), ['Read(build/secret.txt)', 'Edit(build/secret.txt)', 'Read(!.env.example)', 'Edit(!.env.example)']);
  assert.equal(domainOf('https://docs.python.org/3/library/'), 'docs.python.org');
  assert.equal(domainOf('example.com.'), 'example.com');
  assert.equal(mcpName('my server'), 'my_server');
});

test('site tools: the builder page has one tick box per preset, ticked as the defaults, and prints their file', () => {
  const html = page('claude-code-permissions');
  const boxes = [...html.matchAll(/<label><input type="checkbox" name="preset" value="([^"]+)"( checked)?>([\s\S]*?)<\/label>/g)];
  const sorted = (ids: string[]) => [...ids].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(sorted(boxes.map((m) => m[1])), sorted(PRESETS.map((p: { id: string }) => p.id)));
  assert.deepEqual(sorted(boxes.filter((m) => m[2]).map((m) => m[1])), sorted(DEFAULTS.presets));
  for (const p of PRESETS) {
    const label = boxes.find((m) => m[1] === p.id)![3];
    // A denied path (a Read and Edit pair) shows the path once; any other rule shows itself.
    for (const r of p.rules) assert.ok(label.includes(`<code>${(p.list === 'deny' && /^(Read|Edit)\((.*)\)$/.exec(r)?.[2]) || r}</code>`), `${p.id} shows ${r}`);
  }
  // Without JavaScript, and in the page's Markdown, the output box holds the defaults' file.
  const shown = /<code id="settings">([\s\S]*?)<\/code>/.exec(html)![1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const { settings } = buildSettings(DEFAULTS);
  assert.equal(shown, settingsText(settings));
  const p = settings.permissions;
  assert.match(html, new RegExp(`<p id="count"[^>]*>${p.allow.length} allow, ${p.ask.length} ask and ${p.deny.length} deny rules\\.</p>`));
});

// --- The Telegram bot check ----------------------------------------------------------------------

/** A token of the right shape that is nobody's. */
const FAKE = '123456789:AAFakeFakeFakeFakeFakeFakeFakeFake12';

/** A stand-in for fetch: answers by Bot API method and keeps every call. */
function telegram(answers: Record<string, unknown>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    const method = u.pathname.split('/').pop()!;
    const a = answers[method];
    if (a instanceof Error) throw a;
    const body = a ?? { ok: false, error_code: 404, description: 'Not Found' };
    return new Response(JSON.stringify(body), { status: (body as { ok: boolean; error_code?: number }).ok ? 200 : (body as { error_code: number }).error_code, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const ME = { ok: true, result: { id: 123456789, is_bot: true, first_name: 'Helper', username: 'helper_bot', can_join_groups: true, can_read_all_group_messages: false } };
const NO_HOOK = { ok: true, result: { url: '', has_custom_certificate: false, pending_update_count: 0 } };
const you = { id: 111111111, is_bot: false, first_name: 'Sam' };
const other = { id: 333333333, is_bot: false, first_name: 'Alex', last_name: 'Doe' };
const dm = { id: 111111111, type: 'private', first_name: 'Sam' };
const group = { id: -1001234567890, type: 'supergroup', title: 'House <b>chat</b>' };
const UPDATES = { ok: true, result: [
  { update_id: 1, message: { message_id: 1, date: 1_800_000_000, chat: dm, from: you, text: '/start' } },
  { update_id: 2, my_chat_member: { chat: group, from: you, date: 1_800_000_100 } },
  { update_id: 3, message: { message_id: 2, date: 1_800_000_200, chat: group, from: you, text: '@helper_bot hello' } },
  { update_id: 4, edited_message: { message_id: 2, date: 1_800_000_300, chat: group, from: other, text: 'edited' } },
  { update_id: 5, callback_query: { id: 'x', from: you, message: { message_id: 3, date: 1_800_000_050, chat: dm } } },
  { update_id: 6, message: { message_id: 4, date: 1_800_000_400, chat: group, from: { id: 999, is_bot: true, first_name: 'Other bot' } } },
] };

test('site tools: the bot check reads getMe, getWebhookInfo and getUpdates, and lists each chat once, newest first', async () => {
  const t = telegram({ getMe: ME, getWebhookInfo: NO_HOOK, getUpdates: UPDATES });
  const r = await checkBot(`  TELEGRAM_BOT_TOKEN="${FAKE}"\n`, t.fetchImpl);
  assert.deepEqual(t.calls.map((c) => c.url.pathname), [`/bot${FAKE}/getMe`, `/bot${FAKE}/getWebhookInfo`, `/bot${FAKE}/getUpdates`]);
  for (const c of t.calls) {
    assert.equal(c.url.origin, 'https://api.telegram.org');
    assert.equal(c.init.method, 'GET');
    assert.equal(c.init.credentials, 'omit');
    assert.equal(c.init.referrerPolicy, 'no-referrer');
  }
  // Read-only: no offset, so Telegram marks nothing as read.
  assert.equal(t.calls[2].url.searchParams.get('offset'), null);
  assert.equal(t.calls[2].url.searchParams.get('timeout'), '0');
  assert.equal(r.bot.username, 'helper_bot');
  assert.equal(r.updates, 6);
  assert.deepEqual(r.chats.map((c: { id: number }) => c.id), [-1001234567890, 111111111]);
  const [g, d] = r.chats;
  assert.equal(g.name, 'House <b>chat</b>', 'the name is kept as text; the page never inserts it as markup');
  assert.equal(g.count, 4);
  assert.equal(g.last, 1_800_000_400);
  assert.deepEqual(g.senders, [{ id: 111111111, name: 'Sam' }, { id: 333333333, name: 'Alex Doe' }], 'people only, no bots');
  assert.deepEqual([d.type, d.name, d.count, d.last], ['private', 'Sam', 2, 1_800_000_050]);
});

test('site tools: a webhook stops the check before getUpdates, and changes nothing', async () => {
  const t = telegram({ getMe: ME, getWebhookInfo: { ok: true, result: { url: 'https://hooks.example.com/bot', pending_update_count: 3 } } });
  const r = await checkBot(FAKE, t.fetchImpl);
  assert.deepEqual(t.calls.map((c) => c.url.pathname.split('/').pop()), ['getMe', 'getWebhookInfo']);
  assert.equal(r.chats, null);
  assert.equal(r.webhook.url, 'https://hooks.example.com/bot');
});

test('site tools: each failure names its step and what to do, and never carries the token', async () => {
  const fails = async (answers: Record<string, unknown>, token = FAKE) => {
    try { await checkBot(token, telegram(answers).fetchImpl); } catch (e) { return e as { step: string; code: number; message: string }; }
    assert.fail('the check should fail');
  };
  const refused = await fails({ getMe: { ok: false, error_code: 401, description: 'Unauthorized' } });
  assert.ok(refused instanceof CheckError);
  assert.deepEqual([refused.step, refused.code], ['getMe', 401]);
  assert.match(refused.message, /refused the token \(401 Unauthorized\)/);
  const busy = await fails({ getMe: ME, getWebhookInfo: NO_HOOK, getUpdates: { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' } });
  assert.deepEqual([busy.step, busy.code], ['getUpdates', 409]);
  assert.match(busy.message, /Another program polled this bot after the check started.*terminated by other getUpdates request.*Angelia: stop it/);
  const hooked = await fails({ getMe: ME, getWebhookInfo: NO_HOOK, getUpdates: { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" } });
  assert.match(hooked.message, /refused while the bot has a webhook/);
  const offline = await fails({ getMe: new TypeError('Failed to fetch') });
  assert.deepEqual([offline.step, offline.code], ['getMe', 0]);
  assert.match(offline.message, /did not answer/);
  for (const e of [refused, busy, hooked, offline]) assert.ok(!e.message.includes(FAKE.split(':')[1]), 'no token in the message');
  // A malformed token is refused before any request.
  const t = telegram({});
  await assert.rejects(checkBot('hello', t.fetchImpl), /does not look like a bot token/);
  assert.equal(t.calls.length, 0);
});

test('site tools: tokens are cleaned of what a copy brings along, and route lines name an owner only when one person wrote', () => {
  assert.equal(cleanToken(` bot${FAKE} `), FAKE);
  assert.equal(cleanToken(`BOT_TOKEN=${FAKE}`), FAKE);
  assert.equal(cleanToken(`'${FAKE}'`), FAKE);
  assert.ok(TOKEN.test(FAKE));
  assert.ok(!TOKEN.test('123:short'));
  const [g, d] = chatsFrom(UPDATES.result);
  assert.equal(routeLine(d), '- { platform: telegram, chat: 111111111, profile: coding }');
  // Owners approve what the agent runs: never filled in from whoever wrote, even when one person did.
  assert.equal(routeLine(g), '- { platform: telegram, chat: -1001234567890, profile: coding, owners: [YOUR_USER_ID] }');
  assert.equal(routeLine({ ...g, senders: [g.senders[0]] }, 'house'), '- { platform: telegram, chat: -1001234567890, profile: house, owners: [YOUR_USER_ID] }');
});

test('site tools: the bot check page connects only to api.telegram.org and runs no inline script', async () => {
  const csp: string = PAGE_CSP['/tools/telegram-bot-check/'];
  const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' '));
  assert.equal(directive('connect-src'), 'connect-src https://api.telegram.org');
  assert.equal(directive('script-src'), "script-src 'self'");
  assert.equal(directive('default-src'), "default-src 'none'");
  // The Worker puts the page's policy in place of the site-wide one, and only on that page.
  const SITE_CSP = "default-src 'self'; connect-src 'self' https://cloudflareinsights.com";
  const env = { ASSETS: { fetch: async () => new Response('<html><body>page</body></html>', { headers: { 'content-type': 'text/html', 'content-security-policy': SITE_CSP } }) } };
  const ask = async (path: string) => (await worker.fetch(new Request(`https://useangelia.com${path}`), env)).headers.get('content-security-policy');
  assert.equal(await ask('/tools/telegram-bot-check/'), csp);
  assert.equal(await ask('/tools/claude-code-permissions/'), SITE_CSP);
  assert.equal(await ask('/'), SITE_CSP);
  // script-src 'self': the page and the template it is set in may hold no inline script but JSON-LD.
  const template = readFileSync(join(site, 'src', 'guide.html'), 'utf8');
  for (const html of [page('telegram-bot-check'), template])
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /src="|type="application\/ld\+json"/, `inline script: ${m[0]}`);
  // No form and no password field: nothing is submitted, and no browser offers to save the token. The box
  // has no name either, and is drawn as dots by its class.
  const tg = page('telegram-bot-check');
  assert.doesNotMatch(tg, /<form\b|type="password"|type="submit"/);
  assert.match(tg, /<input id="token" type="text" class="masked"(?![^>]*\bname=)[^>]*>/);
});

test('site tools: each tool page has a short title and description, and loads scripts that exist', () => {
  for (const f of readdirSync(join(site, 'tools')).filter((x) => x.endsWith('.html'))) {
    const src = readFileSync(join(site, 'tools', f), 'utf8');
    const head = JSON.parse(/^<!--(\{[\s\S]*?\})-->\n/.exec(src)![1]);
    assert.ok(head.title.length + 10 <= 60, `${f}: the title fits with the brand`);
    assert.ok(head.description.length <= 155, `${f}: description is ${head.description.length} characters`);
    for (const m of src.matchAll(/<script type="module" src="\/tools\/([^"]+)"/g)) assert.ok(existsSync(join(site, 'tools', m[1])), `${f}: ${m[1]} exists`);
  }
});
