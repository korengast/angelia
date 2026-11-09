import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
let out = '';
// One build for every test here, into a temp folder and without the demo videos, so it needs no network.
before(() => {
  out = mkdtempSync(join(tmpdir(), 'angelia-site-'));
  execFileSync(process.execPath, [join(repo, 'site', 'build.mjs'), '--out', out, '--no-media'], { stdio: 'ignore' });
});
after(() => rmSync(out, { recursive: true, force: true }));

const html = (path: string) => readFileSync(join(out, path, 'index.html'), 'utf8');
const one = (text: string, re: RegExp) => re.exec(text)?.[1];
const unescape = (t: string) => t.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const head = (path: string) => {
  const h = html(path);
  return {
    title: unescape(one(h, /<title>([^<]*)<\/title>/) ?? ''),
    og: unescape(one(h, /<meta property="og:title" content="([^"]*)">/) ?? ''),
    h1: unescape((one(h, /<h1[^>]*>([\s\S]*?)<\/h1>/) ?? '').replace(/<[^>]+>/g, '')),
  };
};

test('site build: the pages carry the titles and headings people search for', () => {
  assert.equal(head('').title, 'Angelia: Claude Code on WhatsApp and Telegram');
  assert.equal(head('').og, 'Angelia: Claude Code on WhatsApp and Telegram');
  const want: Record<string, [string, string]> = {
    whatsapp: ['Claude Code on WhatsApp · Angelia', 'Claude Code on WhatsApp'],
    telegram: ['Claude Code Telegram bot · Angelia', 'Claude Code Telegram bot'],
    'claude-code': ['Claude Code on WhatsApp and Telegram: sessions, approvals', 'Claude Code on WhatsApp and Telegram: sessions and approvals from your phone'],
    alternatives: ['Angelia vs OpenClaw, Hermes Agent and Remote Control', 'Angelia vs OpenClaw, Hermes Agent and Claude Code Remote Control'],
    'tools/claude-code-permissions': ['Claude Code permissions: settings.json allow, ask, deny', 'Claude Code permissions: settings.json allow, ask, deny'],
  };
  for (const [path, [title, h1]] of Object.entries(want)) {
    const h = head(path);
    assert.equal(h.title, title, `${path}: title`);
    assert.equal(h.h1, h1, `${path}: h1`);
    assert.ok(h.title.length <= 60, `${path}: the title fits in search results`);
    // The share title is the page's title without the brand.
    assert.equal(h.og, title.replace(/ · Angelia$/, ''), `${path}: og:title`);
  }
});

test('site build: the sitemap lists the decisions page but no ADR, and each hub has a date', () => {
  const xml = readFileSync(join(out, 'sitemap.xml'), 'utf8');
  const urls = [...xml.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?<\/url>/g)].map((m) => ({ loc: m[1], lastmod: m[2] }));
  const locs = urls.map((u) => u.loc);
  assert.ok(locs.includes('https://useangelia.com/docs/decisions/'));
  assert.deepEqual(locs.filter((l) => /\/docs\/decisions\/\d/.test(l)), []);
  assert.equal(new Set(locs).size, locs.length, 'each URL once');
  for (const hub of ['/', '/guides/', '/tools/', '/docs/', '/docs/decisions/']) {
    const u = urls.find((x) => x.loc === `https://useangelia.com${hub}`);
    assert.ok(u, `${hub} is in the sitemap`);
    // Without git history (a shallow clone) a docs date is unknown; the others come from the pages' headers.
    if (!hub.startsWith('/docs/')) assert.match(u.lastmod ?? '', /^\d{4}-\d{2}-\d{2}$/, `${hub} has a lastmod`);
  }
  // A hub is as new as the newest page it lists.
  const dated = (prefix: RegExp) => urls.filter((u) => prefix.test(u.loc) && u.lastmod).map((u) => u.lastmod!).sort().at(-1);
  assert.equal(urls.find((u) => u.loc.endsWith('/guides/'))!.lastmod, dated(/\/guides\/[^/]+\/$/));
  assert.equal(urls.find((u) => u.loc.endsWith('/tools/'))!.lastmod, dated(/\/tools\/[^/]+\/$/));
  assert.ok(urls[0].lastmod! >= dated(/\/(guides|tools)\/[^/]+\/$|\.com\/(?!docs\/)[a-z-]+\/$/)!, 'the home page is as new as what it links to');
});

test('site build: ADR pages say noindex,follow; every other page may be indexed', () => {
  const robots = (path: string) => one(html(path), /<meta name="robots" content="([^"]*)">/);
  const adrs = readFileSync(join(out, 'docs', 'decisions', 'index.html'), 'utf8').match(/href="\/docs\/decisions\/\d{4}-[^"]+\/"/g) ?? [];
  assert.ok(adrs.length >= 10, 'the decisions page lists the ADRs');
  for (const a of adrs) assert.equal(robots(a.slice(7, -1)), 'noindex,follow', a);
  for (const path of ['', 'docs', 'docs/decisions', 'docs/reference', 'guides', 'claude-code', 'tools/claude-code-permissions']) assert.equal(robots(path), undefined, path);
});

/** Every JSON-LD block on a page, parsed: a block that is not JSON fails here. */
const jsonld = (path: string) => [...html(path).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
/** The page's article as a reader sees it: tags gone, entities read, spaces collapsed. */
const visible = (path: string) => unescape((/<article>([\s\S]*?)<\/article>/.exec(html(path)) ?? /<main[^>]*>([\s\S]*?)<\/main>/.exec(html(path))!)[1]
  .replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<\/?(p|li|ul|ol|pre|br|div|h\d|table|tr|td|th)\b[^>]*>/g, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ');

test('site build: every JSON-LD block parses, and FAQ and HowTo text is the text on the page', () => {
  const types = (path: string) => jsonld(path).map((j) => j['@type']);
  assert.deepEqual(types(''), ['SoftwareApplication']);
  // The repository and the npm package, as package.json names them.
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.deepEqual(jsonld('')[0].sameAs, [pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''), `https://www.npmjs.com/package/${pkg.name}`]);
  assert.deepEqual(types('guides/claude-code-whatsapp-telegram'), ['Article', 'FAQPage']);
  assert.deepEqual(types('alternatives'), ['WebPage', 'FAQPage']);
  assert.deepEqual(types('guides/claude-code-from-phone'), ['Article', 'HowTo']);
  for (const dir of ['guides', 'docs', 'docs/decisions', 'claude-code', 'whatsapp', 'tools', 'tools/claude-code-permissions']) assert.equal(jsonld(dir).length, 1, dir);

  for (const path of ['guides/claude-code-whatsapp-telegram', 'alternatives']) {
    const [faq] = jsonld(path).filter((j) => j['@type'] === 'FAQPage');
    const text = visible(path);
    assert.ok(faq.mainEntity.length >= 1);
    for (const q of faq.mainEntity) {
      assert.equal(q['@type'], 'Question');
      assert.match(q.name, /\?$/, 'a question');
      assert.ok(text.includes(q.name), `${path}: "${q.name}" is a heading on the page`);
      assert.ok(q.acceptedAnswer.text.length > 80, `${path}: an answer, not a stub`);
      assert.ok(text.includes(q.acceptedAnswer.text), `${path}: the answer is the page's text`);
    }
  }
  assert.equal(jsonld('alternatives')[1].mainEntity[0].name, 'Which one would you recommend?');
  assert.match(jsonld('alternatives')[1].mainEntity[0].acceptedAnswer.text, /: Angelia\./);

  const howto = jsonld('guides/claude-code-from-phone')[1];
  const text = visible('guides/claude-code-from-phone');
  assert.equal(howto.totalTime, 'PT10M');
  assert.deepEqual(howto.step.map((s: { name: string }) => s.name), ['Install and pair a chat', 'Keep it running', 'Point it at your code', 'Approve commands from the phone']);
  for (const s of howto.step) {
    assert.equal(s['@type'], 'HowToStep');
    assert.ok(text.includes(s.text), `step "${s.name}" is the page's text`);
    assert.ok(html('guides/claude-code-from-phone').includes(`<h2 id="${s.url.split('#')[1]}">`), `step "${s.name}" links to its heading`);
  }
});

test('site build: llms.txt answers the common questions with links on the site, and links the docs pages, not raw files', () => {
  const txt = readFileSync(join(out, 'llms.txt'), 'utf8');
  const docsAt = txt.indexOf('\n## ');
  for (const q of ['How do I run Claude Code from WhatsApp?', 'How does Angelia compare to OpenClaw?', 'Is it safe?']) {
    const at = txt.indexOf(`**${q}**`);
    // Free text before the first section, as llmstxt.org puts it, with at least one link on the site.
    assert.ok(at > 0 && at < docsAt, `${q} is answered before the lists`);
    const answer = txt.slice(at, txt.indexOf('\n', at));
    assert.match(answer, /\]\(https:\/\/useangelia\.com\/[^)]*\)/, `${q} links the site`);
    assert.ok(answer.split(/(?<=[.?!)])\s+(?=[A-Z[])/).length <= 4, `${q}: a short answer`);
  }
  for (const doc of ['reference', 'security', 'runbook']) {
    assert.ok(txt.includes(`(https://useangelia.com/docs/${doc}/)`), `${doc} on the site`);
    assert.ok(!txt.includes(`/docs/${doc}.md)`), `${doc}: no raw file`);
  }
  for (const m of txt.matchAll(/\]\(https:\/\/useangelia\.com(\/[^)#]*)\)/g)) {
    const p = m[1].endsWith('/') ? join(out, m[1], 'index.html') : join(out, m[1]);
    assert.doesNotThrow(() => readFileSync(p), `${m[1]} exists`);
  }
});
