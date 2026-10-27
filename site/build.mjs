// Builds the landing page: inlines the mark as a <symbol> and draws the meander ring.
// node site/build.mjs        ->  site/dist/, ready to upload as it is (Cloudflare Pages reads _redirects, _headers)
// node site/build.mjs --drafts ->  the same, with the guides still marked draft (to read them locally, never to deploy)
// node site/build.mjs --og   ->  the share card and the README banner as pages in the temp folder; render them
//                                into static/og.png (1200x630) and static/banner.png (1280x400 at 2x)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlToMarkdown } from './markdown.mjs';
import { renderMarkdown, toc, inline, rewriteLinks } from './docs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = 'https://useangelia.com';
const REPO = 'korengast/angelia';
const version = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version;
const mark = readFileSync(join(here, 'mark.svg'), 'utf8');
const viewBox = mark.match(/viewBox="([^"]+)"/)[1];
const inner = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const symbol = `<symbol id="mark" viewBox="${viewBox}" fill="currentColor">${inner}</symbol>`;

// One meander tile (20x20), bent around the circle between rOut and rIn.
function ring({ cx = 200, cy = 200, rOut = 196, band = 26, units = 36 } = {}) {
  const tile = [[[0, 18], [20, 18]], [[16, 18], [16, 2], [4, 2], [4, 14], [12, 14], [12, 6], [8, 6], [8, 10]]];
  const at = (u, x, y) => {
    const a = ((u * 20 + x) / (units * 20)) * 2 * Math.PI - Math.PI / 2;
    const r = rOut - 4 - (y / 20) * band;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const parts = [];
  for (let u = 0; u < units; u++) {
    for (const line of tile) {
      const pts = [];
      for (let i = 0; i < line.length - 1; i++) {
        const [x0, y0] = line[i], [x1, y1] = line[i + 1];
        const steps = y0 === y1 ? Math.max(2, Math.ceil(Math.abs(x1 - x0) / 2)) : 1;
        for (let s = 0; s <= steps; s++) pts.push(at(u, x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps));
      }
      parts.push('M' + pts.map(p => p.map(n => n.toFixed(1)).join(' ')).join(' L'));
    }
  }
  const sw = (band / 20) * 1.9;
  return `<circle cx="${cx}" cy="${cy}" r="${rOut}" fill="none" stroke="currentColor" stroke-width="3"/>` +
    `<path d="${parts.join(' ')}" fill="none" stroke="currentColor" stroke-width="${sw.toFixed(2)}" stroke-linecap="square" stroke-linejoin="miter"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${rOut - band - 12}" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
}

const page = (name) => readFileSync(join(here, 'src', name), 'utf8')
  .replace('<!--MARK-->', symbol)
  .replaceAll('<!--RING-->', ring())
  .replaceAll('{{SITE}}', SITE)
  .replaceAll('{{REPO}}', REPO)
  .replaceAll('{{VERSION}}', version);

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Guides (site/guides/<slug>.html) and pages (site/pages/<slug>.html) are an HTML body headed by a JSON
// comment: title, description, date, optional updated (and for a page, card and nav: its share card's
// second line and its name in the home page's footer), draft. A draft is left out of the site and the
// sitemap unless --drafts.
const headed = (dir) => readdirSync(join(here, dir)).filter((f) => f.endsWith('.html')).map((f) => {
  const src = readFileSync(join(here, dir, f), 'utf8');
  const m = src.match(/^<!--(\{[\s\S]*?\})-->\n/);
  if (!m) throw new Error(`site/${dir}/${f}: no JSON header`);
  return { slug: f.replace(/\.html$/, ''), body: src.slice(m[0].length), ...JSON.parse(m[1]) };
}).filter((g) => !g.draft || process.argv.includes('--drafts')).sort((a, b) => b.date.localeCompare(a.date));

if (process.argv.includes('--og')) {
  const out = join(tmpdir(), 'angelia-og');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'og.html'), page('og.html'));
  writeFileSync(join(out, 'banner.html'), page('banner.html'));
  // One card per guide, its title in place of the slogan: render og-<slug>.html into site/static/guides/<slug>/og.png.
  // A page's card keeps the slogan's second line, or says its own ("card" in its header): render
  // og-<slug>.html into site/static/<slug>/og.png.
  const titled = (title, line) => page('og.html').replace(/<h1>[\s\S]*?<\/h1>/, `<h1 class="guide">${esc(title)}</h1>`).replace('On WhatsApp and Telegram. On your machine.', line);
  for (const { slug, title } of headed('guides')) writeFileSync(join(out, `og-${slug}.html`), titled(title, 'A guide from Angelia.'));
  for (const { slug, title, card } of headed('pages')) writeFileSync(join(out, `og-${slug}.html`), titled(title, card ?? 'On WhatsApp and Telegram. On your machine.'));
  // The docs share one card: render og-docs.html into site/static/docs/og.png.
  writeFileSync(join(out, 'og-docs.html'), titled('The docs: reference, security, runbook, decisions', 'Built from the repository.'));
  cpSync(join(here, 'fonts'), join(out, 'fonts'), { recursive: true });
  console.log(`${out}: og.html at 1200x630 into site/static/og.png, banner.html at 1280x400 (2x) into site/static/banner.png`);
  process.exit(0);
}

const AUTHOR = { '@type': 'Person', name: 'Koren Gast', url: 'https://github.com/korengast' };
const guides = headed('guides');
// Pages: what Angelia does for one CLI or chat app, and how it compares. Each lives at /<slug>/, listed
// in this order (a page not named here comes last).
const PAGE_ORDER = ['claude-code', 'whatsapp', 'telegram', 'alternatives'];
const rank = (slug) => (PAGE_ORDER.includes(slug) ? PAGE_ORDER.indexOf(slug) : PAGE_ORDER.length);
const pages = headed('pages').sort((a, b) => rank(a.slug) - rank(b.slug));
// Tools: site/tools/<slug>.html is a free tool's page, headed like a guide, and site/tools/<slug>/ holds
// its scripts, served beside it (the page loads them as modules; tests/site-tools.test.ts imports them).
const tools = headed('tools').sort((a, b) => a.title.localeCompare(b.title));
// The tab and search title: the brand after it only while the whole stays within what results show.
const pageTitle = (title) => (title.length + 10 <= 60 ? `${title} · Angelia` : title);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d) => { const [y, m, day] = d.split('-').map(Number); return `${day} ${MONTHS[m - 1]} ${y}`; };
// Every h2 gets an id (from its text when it has none), so a section can be linked to.
const slugify = (t) => t.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const withIds = (body) => body.replace(/<h2>([\s\S]*?)<\/h2>/g, (_, inner) => `<h2 id="${slugify(inner)}">${inner}</h2>`);
// Search results cut a title past 60 characters and a description past 155: the build refuses longer ones.
// A description made from a file (an ADR's heading) is cut to fit instead, at a word, with an ellipsis.
const clip = (text, max = 155) => (text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '').replace(/[\s,;:—-]+$/, '')}…`);
const fits = (title, description) => {
  if (pageTitle(title).length > 60) throw new Error(`title over 60 characters: ${title}`);
  if (description.length > 155) throw new Error(`description over 155 characters (${description.length}): ${title}`);
};
const guidePage = ({ title, heading = title, description, url, date, modified = date, byline, body, jsonld, ogType = 'article', ogImage = `${SITE}/og.png`, ogAlt = 'Angelia. Your coding agent. Your personal assistant.' }) => {
  fits(title, description);
  return page('guide.html')
  .replace('{{OGTYPE}}', ogType).replace('{{OGIMAGE}}', ogImage).replace('{{OGALT}}', esc(ogAlt))
  .replace('<!--ARTICLE-->', ogType === 'article' ? `<meta property="article:published_time" content="${date}">\n<meta property="article:modified_time" content="${modified}">` : '')
  .replaceAll('{{PAGETITLE}}', esc(pageTitle(title))).replaceAll('{{MODIFIED}}', modified)
  .replace('{{HEADING}}', esc(heading)).replaceAll('{{TITLE}}', esc(title)).replaceAll('{{DESCRIPTION}}', esc(description)).replaceAll('{{URL}}', url)
  .replaceAll('{{DATE}}', date).replace('{{BYLINE}}', byline).replace('{{JSONLD}}', JSON.stringify(jsonld).replace(/</g, '\\u003c'))
  .replace('<!--BODY-->', withIds(body).replaceAll('{{SITE}}', SITE).replaceAll('{{REPO}}', REPO).replaceAll('{{VERSION}}', version));
};

// A page's own share card, when one has been rendered: site/static/<page>/og.png (see --og).
const card = (dir) => existsSync(join(here, 'static', dir, 'og.png')) ? `${SITE}/${dir}/og.png` : `${SITE}/og.png`;
const guideOg = (slug) => card(`guides/${slug}`);
const out = join(here, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Every guide ends with links to the others, above its Try box: the pages link each other, not only the index.
const moreGuides = (slug) => {
  const others = guides.filter((o) => o.slug !== slug);
  return others.length ? `<nav class="more" aria-label="More guides"><h2 id="more-guides">More guides</h2><ul>${others.map((o) => `<li><a href="/guides/${o.slug}/">${esc(o.title)}</a></li>`).join('')}</ul></nav>\n` : '';
};
const aboveTry = (body, more) => body.includes('<div class="try"') ? body.replace('<div class="try"', `${more}<div class="try"`) : body + more;
const withMore = (g) => aboveTry(g.body, moreGuides(g.slug));
for (const g of guides) {
  const url = `${SITE}/guides/${g.slug}/`;
  mkdirSync(join(out, 'guides', g.slug), { recursive: true });
  writeFileSync(join(out, 'guides', g.slug, 'index.html'), guidePage({
    title: g.title, description: g.description, url, date: g.date, modified: g.updated ?? g.date, body: withMore(g),
    ogImage: guideOg(g.slug), ogAlt: g.title,
    byline: `Koren Gast · Updated <time datetime="${g.updated ?? g.date}">${longDate(g.updated ?? g.date)}</time>`,
    jsonld: { '@context': 'https://schema.org', '@type': 'Article', headline: g.title, description: g.description, datePublished: g.date, dateModified: g.updated ?? g.date, author: AUTHOR, mainEntityOfPage: url, image: guideOg(g.slug), publisher: { '@type': 'Organization', name: 'Angelia', url: `${SITE}/` } },
  }));
}
// Every page ends with links to the other pages, the docs, the tools and the guides.
const morePages = (slug) => `<nav class="more" aria-label="More about Angelia"><h2 id="more-about-angelia">More about Angelia</h2><ul>${
  [...pages.filter((o) => o.slug !== slug).map((o) => [`/${o.slug}/`, o.title]), ['/docs/', 'Docs'], ...(tools.length ? [['/tools/', 'Tools']] : []), ...(guides.length ? [['/guides/', 'Guides']] : [])]
    .map(([href, t]) => `<li><a href="${href}">${esc(t)}</a></li>`).join('')}</ul></nav>\n`;
for (const p of pages) {
  const url = `${SITE}/${p.slug}/`;
  const modified = p.updated ?? p.date;
  mkdirSync(join(out, p.slug), { recursive: true });
  writeFileSync(join(out, p.slug, 'index.html'), guidePage({
    title: p.title, description: p.description, url, date: p.date, modified, body: aboveTry(p.body, morePages(p.slug)),
    ogType: 'website', ogImage: card(p.slug), ogAlt: p.title,
    byline: `Angelia · Updated <time datetime="${modified}">${longDate(modified)}</time>`,
    jsonld: { '@context': 'https://schema.org', '@type': 'WebPage', name: p.title, description: p.description, dateModified: modified, url, image: card(p.slug), isPartOf: { '@type': 'WebSite', name: 'Angelia', url: `${SITE}/` } },
  }));
}
if (guides.length) writeFileSync(join(out, 'guides', 'index.html'), guidePage({
  title: 'Guides', description: 'How to run your coding agent CLI as a personal assistant from WhatsApp and Telegram.',
  url: `${SITE}/guides/`, date: guides[0].date, byline: 'Angelia', ogType: 'website',
  body: '<ul>' + guides.map((g) => `<li><a href="/guides/${g.slug}/">${esc(g.title)}</a><br><span class="meta">${g.date} · ${esc(g.description)}</span></li>`).join('') + '</ul>',
  jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Angelia guides', url: `${SITE}/guides/` },
}));

// Docs: the repository's own Markdown, rendered at build time (site/docs.mjs), so a page never says
// something its file does not. docs/<name>.md is /docs/<name>/, an ADR is /docs/decisions/<file name>/.
// Each page's Markdown copy is the file itself, with its links pointing at the site.
const BLOB = `https://github.com/${REPO}/blob/main`;
// A doc's date for the sitemap: its last commit. None in a shallow clone, where every file would get
// the newest commit's date, or without git.
const git = (...args) => { try { return execFileSync('git', args, { cwd: join(here, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const history = git('rev-parse', '--is-shallow-repository') === 'false';
const lastCommit = (file) => (history && git('log', '-1', '--format=%cs', '--', file)) || undefined;
const newest = (dates) => dates.filter(Boolean).sort().at(-1);
const DOCS = [
  { file: 'docs/reference.md', description: 'Every Angelia feature in full: capabilities per profile, the backends, setting up by hand, the instance folder, and every file Angelia keeps.' },
  { file: 'docs/security.md', description: 'Who can reach and command the agent, tokens, secrets, the sandbox, logs, and what leaves your machine. Read it before you give the bot to anyone.' },
  { file: 'docs/runbook.md', description: 'Day-to-day Angelia commands, where to look, known failures and their fixes, backup, cutting a release, and uninstalling.' },
  ...readdirSync(join(here, '..', 'docs', 'decisions')).filter((f) => /^\d{4}-.+\.md$/.test(f)).sort().map((f) => ({ file: `docs/decisions/${f}`, adr: f.slice(0, 4) })),
].map((d) => {
  const md = readFileSync(join(here, '..', d.file), 'utf8');
  const path = `/${d.file.replace(/\.md$/, '')}/`;
  const modified = lastCommit(d.file);
  if (!d.adr) return { ...d, md, path, modified, ogImage: card('docs') };
  // An ADR's heading is long ("ADR 0008 — Host mode per profile: print mode by default, …"): the tab
  // title keeps the part before its first colon or semicolon, the description says the whole.
  const heading = md.match(/^# (.+)$/m)[1];
  const what = heading.replace(/^ADR \d+ — /, '');
  let title = `ADR ${d.adr}: ${what.split(/[:;]/)[0]}`;
  if (title.length > 60) title = title.split(',')[0];
  // The status paragraph's first sentence, and any later one that says the record changed since.
  const said = (md.match(/^Status: ([\s\S]*?)(?:\n\s*\n|(?![\s\S]))/m)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const sentences = said.split(/(?<=\.)\s+/);
  const status = [sentences[0], ...sentences.slice(1).filter((t) => /supersed|historical|amended|replaced/i.test(t))].filter(Boolean).join(' ');
  const changed = /supersed|historical in part/i.test(status) ? ' (superseded in part)' : /amended|replaced by/i.test(status) ? ' (amended)' : '';
  return { ...d, md, path, modified, title, status, description: clip(`Angelia design decision ${d.adr}: ${what}${changed}.`), ogImage: card('docs') };
});
const docPath = new Map([...DOCS.map((d) => [d.file, d.path]), ['docs/decisions', '/docs/decisions/'], ['docs/api.md', '/docs/api.md']]);
/** Where a link in a doc goes: another doc's page, the API page the site serves as it is, or the file on
 *  GitHub. A link out of the repository has no page to go to, so the build refuses it. */
const docLink = (from) => (href) => {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [file, hash] = href.split('#');
  const target = posix.normalize(posix.join(posix.dirname(from), file)).replace(/\/$/, '');
  if (target === '..' || target.startsWith('../') || target.startsWith('/')) throw new Error(`${from}: the link ${href} leaves the repository`);
  return (docPath.get(target) ?? `${BLOB}/${target}`) + (hash ? `#${hash}` : '');
};
const MORE_DOCS = [['/docs/reference/', 'Reference'], ['/docs/security/', 'Security model'], ['/docs/runbook/', 'Runbook'], ['/docs/decisions/', 'Decisions'], ['/docs/api.md', 'Local API (Markdown)']];
const moreDocs = (path) => `<nav class="more" aria-label="More docs"><h2 id="more-docs">More docs</h2><ul>${MORE_DOCS.filter(([p]) => p !== path).map(([p, t]) => `<li><a href="${p}">${t}</a></li>`).join('')}</ul></nav>`;
const docByline = (d) => `<a href="/docs/">Docs</a>${d.adr ? ' · <a href="/docs/decisions/">Decisions</a>' : ''} · <a href="${BLOB}/${d.file}">${d.file} on GitHub</a>`;
for (const d of DOCS) {
  const { title, html, headings } = renderMarkdown(d.md, docLink(d.file));
  // A long page opens with its contents, after the lines that introduce it.
  const body = headings.filter((h) => h.level === 2).length >= 4 && html.includes('<h2') ? html.replace('<h2', `${toc(headings)}\n<h2`) : html;
  d.title ??= title;
  d.heading = title;
  mkdirSync(join(out, d.path), { recursive: true });
  writeFileSync(join(out, d.path, 'index.html'), guidePage({
    title: d.title, heading: d.heading, description: d.description, url: SITE + d.path, byline: docByline(d), ogType: 'website',
    ogImage: d.ogImage, ogAlt: d.title, body: `<div class="doc">\n${body}\n${moreDocs(d.path)}\n</div>`,
    jsonld: { '@context': 'https://schema.org', '@type': 'TechArticle', headline: d.title, description: d.description, url: SITE + d.path, isPartOf: { '@type': 'WebSite', name: 'Angelia', url: `${SITE}/` } },
  }));
  writeFileSync(join(out, d.path, 'index.md'), rewriteLinks(d.md, (h) => {
    const to = docLink(d.file)(h);
    return to.startsWith('/') ? SITE + to : to;
  }));
}
const adrs = DOCS.filter((d) => d.adr);
const docIndex = (path, title, name, description, body) => {
  mkdirSync(join(out, path), { recursive: true });
  writeFileSync(join(out, path, 'index.html'), guidePage({
    title, description, url: SITE + path, byline: path === '/docs/' ? 'Angelia' : '<a href="/docs/">Docs</a>', ogType: 'website',
    ogImage: card('docs'), ogAlt: title, body: `<div class="doc">\n${body}\n</div>`,
    jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name, url: SITE + path },
  }));
};
docIndex('/docs/', 'Angelia docs: reference, security, runbook, API, decisions', 'Angelia docs', 'The Angelia docs: the reference, the security model, the runbook, the local API and the design decisions, built from the repository.',
  `<p class="lede">These pages are the Markdown files in the repository's <code>docs/</code> folder, rebuilt with the site. They follow the main branch, so they may describe things the latest release does not have yet. Each page links to its file on GitHub.</p>
<ul>
<li><a href="/docs/reference/">Reference</a><br><span class="meta">Features in detail, capabilities per profile, the backends, setting things up by hand, the instance folder, every file Angelia keeps.</span></li>
<li><a href="/docs/security/">Security model</a><br><span class="meta">Who can reach and command the agent, tokens, secrets, the sandbox, logs, what leaves your machine.</span></li>
<li><a href="/docs/runbook/">Runbook</a><br><span class="meta">Day-to-day commands, where to look, known failures and their fixes, cutting a release, uninstalling.</span></li>
<li><a href="/docs/api.md">Local API</a> (Markdown, with an <a href="/openapi.json">OpenAPI document</a>)<br><span class="meta">Scripts and agents talk to the daemon: tokens, routes, events, the stability promise.</span></li>
<li><a href="/docs/decisions/">Decisions</a><br><span class="meta">Why it is built this way, with the CLI versions each finding was measured on.</span></li>
</ul>
<p>The <a href="https://github.com/{{REPO}}#readme">README</a> covers install, the quick start and the chat commands. For agents, <a href="/llms.txt">llms.txt</a> lists the same docs, and every page here is also served as Markdown.</p>`);
docIndex('/docs/decisions/', 'Decisions', 'Angelia decisions', 'Why Angelia is built this way: the architecture decision records, with the CLI versions each finding was measured on.',
  `<p class="lede">Each record says what was decided, what else was tried, and what it costs. A later record can amend an earlier one; the status line at the top of each says so.</p>
<ul>${adrs.map((d) => `<li><a href="${d.path}">${esc(d.heading)}</a>${d.status ? `<br><span class="meta">${inline(d.status, docLink(d.file))}</span>` : ''}</li>`).join('\n')}</ul>${adrs.some((d) => d.adr === '0010') ? '' : '\n<p>There is no 0010. It recorded a design that was removed before the code was published, and the record was left out with it.</p>'}`);
// Tools: each tool's page at /tools/<slug>/, with its scripts beside it, and the index at /tools/.
const moreTools = (slug) => `<nav class="more" aria-label="More tools"><h2 id="more-tools">More tools</h2><ul>${tools.filter((o) => o.slug !== slug).map((o) => `<li><a href="/tools/${o.slug}/">${esc(o.title)}</a></li>`).join('')}<li><a href="/docs/">Docs</a></li>${guides.length ? '<li><a href="/guides/">Guides</a></li>' : ''}</ul></nav>\n`;
for (const t of tools) {
  const url = `${SITE}/tools/${t.slug}/`;
  mkdirSync(join(out, 'tools', t.slug), { recursive: true });
  if (existsSync(join(here, 'tools', t.slug))) cpSync(join(here, 'tools', t.slug), join(out, 'tools', t.slug), { recursive: true });
  writeFileSync(join(out, 'tools', t.slug, 'index.html'), guidePage({
    title: t.title, description: t.description, url, date: t.date, modified: t.updated ?? t.date, ogType: 'website', ogAlt: t.title,
    body: t.body.replace('<div class="try"', `${moreTools(t.slug)}<div class="try"`),
    byline: `A free tool from Angelia · Updated <time datetime="${t.updated ?? t.date}">${longDate(t.updated ?? t.date)}</time>`,
    jsonld: { '@context': 'https://schema.org', '@type': 'WebApplication', name: t.title, description: t.description, url, applicationCategory: 'DeveloperApplication', operatingSystem: 'Any', isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, dateModified: t.updated ?? t.date, author: AUTHOR, publisher: { '@type': 'Organization', name: 'Angelia', url: `${SITE}/` } },
  }));
}
if (tools.length) {
  copyFileSync(join(here, 'tools', 'tools.css'), join(out, 'tools', 'tools.css'));
  writeFileSync(join(out, 'tools', 'index.html'), guidePage({
    title: 'Free tools', description: 'Small free tools for Claude Code and Telegram bots. Each runs in your browser and sends nothing to us.',
    url: `${SITE}/tools/`, date: tools.map((t) => t.updated ?? t.date).sort().at(-1), byline: 'Angelia', ogType: 'website',
    body: '<p class="lede">Small free tools for Claude Code and Telegram bots. Each runs in your browser and sends nothing to us.</p>\n<ul>' + tools.map((t) => `<li><a href="/tools/${t.slug}/">${esc(t.title)}</a><br><span class="meta">${esc(t.description)}</span></li>`).join('') + '</ul>',
    jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Angelia tools', url: `${SITE}/tools/` },
  }));
}
// The comparison guide, linked from the home page once it is published.
const COMPARE = 'claude-code-whatsapp-telegram';
const html = page('index.html')
  .replace('<!--GUIDES-->', guides.length ? '<li class="keep"><a href="/guides/">Guides</a></li>' : '')
  .replace('<!--COMPARE-->', guides.some((g) => g.slug === COMPARE)
    ? `<p class="compare"><span>Remote Control, Claude Code channels, a WhatsApp plugin or Angelia?</span> <a class="btn light" href="/guides/${COMPARE}/">Four ways compared →</a></p>` : '')
  // The other guides by name, so each one is a link from the home page.
  .replace('<!--GUIDE-LINKS-->', guides.some((g) => g.slug !== COMPARE)
    ? `<p class="more-guides">Guides: ${guides.filter((g) => g.slug !== COMPARE).map((g) => `<a href="/guides/${g.slug}/">${esc(g.title)}</a>`).join(' · ')}</p>` : '')
  .replace('<!--COMPARE-HERO-->', guides.some((g) => g.slug === COMPARE) ? ` <a href="/guides/${COMPARE}/">How it compares</a>.` : '')
  // The docs, the tools and every page, in the footer: short names, since the footer is one line on a laptop.
  .replace('<!--PAGE-LINKS-->', `<span>${[['/docs/', 'Docs'], ...(tools.length ? [['/tools/', 'Tools']] : []), ...pages.map((p) => [`/${p.slug}/`, p.nav ?? p.title])].map(([href, t]) => `<a href="${href}">${esc(t)}</a>`).join(' · ')}</span>`);
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, '404.html'), page('404.html'));
// Every page as Markdown beside its index.html, for an agent that sends Accept: text/markdown (the Worker
// picks the file, site/worker/ranges.js). The 404 page has its own text: where to look instead. The docs
// pages wrote theirs above, from the Markdown they were made of.
for (const dir of ['', ...(guides.length ? ['guides'] : []), ...guides.map((g) => `guides/${g.slug}`), ...pages.map((p) => p.slug), 'docs', 'docs/decisions']) {
  const path = dir ? `/${dir}/` : '/';
  writeFileSync(join(out, dir, 'index.md'), htmlToMarkdown(readFileSync(join(out, dir, 'index.html'), 'utf8'), SITE + path));
}
for (const dir of tools.length ? ['tools', ...tools.map((t) => `tools/${t.slug}`)] : []) writeFileSync(join(out, dir, 'index.md'), htmlToMarkdown(readFileSync(join(out, dir, 'index.html'), 'utf8'), `${SITE}/${dir}/`));
writeFileSync(join(out, '404.md'), `# Not found\n\nNothing is at this address on ${SITE}. The page may have moved, or the link has a typo.\n\n` +
  `- [Home page](${SITE}/) ([Markdown](${SITE}/index.md))\n- [llms.txt](${SITE}/llms.txt): the documentation, listed for agents\n` +
  `- [Sitemap](${SITE}/sitemap.xml)\n` + (guides.length ? `- [Guides](${SITE}/guides/)\n` : '') + `- [Docs](${SITE}/docs/)\n` + (tools.length ? `- [Tools](${SITE}/tools/)\n` : '') +
  pages.map((p) => `- [${p.title}](${SITE}/${p.slug}/)\n`).join('') + `- [GitHub](https://github.com/${REPO})\n`);
// For agents (llmstxt.org): /llms.txt lists the docs, /llms-full.txt holds them in one file, and the API
// page and its OpenAPI document are served as they are. Links point at this release's tag, so an agent
// reads the docs of the version the install line gives.
const TAG = `https://github.com/${REPO}/blob/v${version}`;
const llmsVars = (t) => t.replaceAll('{{SITE}}', SITE).replaceAll('{{VERSION}}', version)
  .replaceAll('{{RAW}}', `https://raw.githubusercontent.com/${REPO}/v${version}`).replaceAll('{{TREE}}', `https://github.com/${REPO}/tree/v${version}`);
writeFileSync(join(out, 'llms.txt'), llmsVars(readFileSync(join(here, 'src', 'llms.txt'), 'utf8')));
/** A repository Markdown file with its relative links made absolute, so they work out of the repo. */
const absolute = (file) => {
  const dir = dirname(file);
  const abs = (href) => /^(https?:|mailto:|#)/.test(href) ? href : `${TAG}/${join(dir, href.split('#')[0])}${href.includes('#') ? '#' + href.split('#')[1] : ''}`;
  return readFileSync(join(here, '..', file), 'utf8')
    .replace(/\]\(([^)\s]+)\)/g, (_, h) => `](${abs(h)})`)
    .replace(/href="([^"]+)"/g, (_, h) => `href="${abs(h)}"`);
};
const FULL = ['README.md', 'docs/api.md', 'docs/reference.md', 'docs/security.md'];
writeFileSync(join(out, 'llms-full.txt'), `# Angelia ${version}: the documentation in one file\n\n` +
  FULL.map((f) => `<!-- ${TAG}/${f} -->\n\n${absolute(f)}`).join('\n\n---\n\n'));
mkdirSync(join(out, 'docs', 'api'), { recursive: true });
writeFileSync(join(out, 'docs', 'api.md'), readFileSync(join(here, '..', 'docs', 'api.md'), 'utf8'));
for (const to of ['openapi.json', 'docs/api/openapi.json']) copyFileSync(join(here, '..', 'docs', 'api', 'openapi.json'), join(out, to));
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
writeFileSync(join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}/</loc></url>` +
  (guides.length ? `<url><loc>${SITE}/guides/</loc></url>` : '') +
  guides.map((g) => `<url><loc>${SITE}/guides/${g.slug}/</loc><lastmod>${g.updated ?? g.date}</lastmod></url>`).join('') +
  pages.map((p) => `<url><loc>${SITE}/${p.slug}/</loc><lastmod>${p.updated ?? p.date}</lastmod></url>`).join('') +
  [['/docs/', newest(DOCS.map((d) => d.modified))], ...DOCS.filter((d) => !d.adr).map((d) => [d.path, d.modified]), ['/docs/decisions/', newest(adrs.map((d) => d.modified))], ...adrs.map((d) => [d.path, d.modified])]
    .map(([p, date]) => `<url><loc>${SITE}${p}</loc>${date ? `<lastmod>${date}</lastmod>` : ''}</url>`).join('') +
  (tools.length ? `<url><loc>${SITE}/tools/</loc></url>` : '') + tools.map((t) => `<url><loc>${SITE}/tools/${t.slug}/</loc><lastmod>${t.updated ?? t.date}</lastmod></url>`).join('') + '</urlset>\n');
copyFileSync(join(here, 'mark.svg'), join(out, 'mark.svg'));
copyFileSync(join(here, 'favicon.svg'), join(out, 'favicon.svg'));
cpSync(join(here, 'fonts'), join(out, 'fonts'), { recursive: true });
cpSync(join(here, 'static'), out, { recursive: true });
// The demo video: kept out of the repository, which every install clones, and fetched from a release
// download pinned by SHA-256. Cached in site/.media; a file that does not match is refused and the build
// fails, so a deploy never serves something else.
const MEDIA_RELEASE = `https://github.com/${REPO}/releases/download/site-media-1`;
const MEDIA = {
  'angelia-demo.webm': '5c4022c3fc5bed8dbe262033e37f3f8120202a2ec91885ebf61886d53ac98633',
  'angelia-demo-muted.mp4': '95723b707888c9b961b8a9f5e05c3d2533762015ad692426b670135978568b31',
  // The README's demo: a GIF, because GitHub shows images from a README, not videos from a site.
  'angelia-demo.gif': '15db7aef78fb4abd4fe074d525a598f7e1ee6ae04a6360e8e7e0e00a6e2100e7',
};
const cache = join(here, '.media');
mkdirSync(cache, { recursive: true });
for (const [name, sha] of Object.entries(MEDIA)) {
  const file = join(cache, name);
  const ok = () => existsSync(file) && createHash('sha256').update(readFileSync(file)).digest('hex') === sha;
  if (!ok()) {
    const res = await fetch(`${MEDIA_RELEASE}/${name}`);
    if (!res.ok) throw new Error(`site media: ${name}: HTTP ${res.status} from ${MEDIA_RELEASE}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    if (!ok()) throw new Error(`site media: ${name} does not match its pinned SHA-256; not deployed`);
  }
  copyFileSync(file, join(out, name));
}
// The short install line. It points at the install.sh attached to the release, byte for byte the one in
// the signed tag (it carries that release's key), because GitHub counts an asset's downloads.
writeFileSync(join(out, '_redirects'),
  `/install https://github.com/${REPO}/releases/download/v${version}/install.sh 302\n` +
  // Permanent, so search engines keep only the slash form. Cloudflare's own slash and index.html
  // redirects are 307, which Search Console reports as "Page with redirect" for months.
  ['/index.html /', ...(guides.length ? ['/guides /guides/', '/guides/index.html /guides/'] : []),
    ...guides.flatMap((g) => [`/guides/${g.slug} /guides/${g.slug}/`, `/guides/${g.slug}/index.html /guides/${g.slug}/`]),
    ...['/docs/', '/docs/decisions/', ...DOCS.map((d) => d.path), ...pages.map((p) => `/${p.slug}/`)].flatMap((p) => [`${p.slice(0, -1)} ${p}`, `${p}index.html ${p}`]),
    ...(tools.length ? ['/tools /tools/', '/tools/index.html /tools/'] : []), ...tools.flatMap((t) => [`/tools/${t.slug} /tools/${t.slug}/`, `/tools/${t.slug}/index.html /tools/${t.slug}/`])]
    .map((r) => `${r} 301\n`).join(''));
writeFileSync(join(out, '_headers'), [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  // Cloudflare Web Analytics (cookieless) injects its beacon script and posts to cloudflareinsights.com.
  "  Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; img-src 'self' data:; frame-ancestors 'none'",
  // Where an agent finds the docs for any page (llmstxt.org).
  '  Link: </llms.txt>; rel="describedby"',
  '/llms*.txt',
  '  Content-Type: text/plain; charset=utf-8',
  '/docs/*.md',
  '  Content-Type: text/markdown; charset=utf-8',
  '/fonts/*',
  '  Cache-Control: public, max-age=2592000',
  '/angelia-demo*',
  '  Cache-Control: public, max-age=2592000',
  // A page's Markdown copy names the page as the one to index: search engines keep the HTML.
  ...['/', ...(guides.length ? ['/guides/'] : []), ...guides.map((g) => `/guides/${g.slug}/`), ...pages.map((p) => `/${p.slug}/`), '/docs/', '/docs/decisions/', ...DOCS.map((d) => d.path),
    ...(tools.length ? ['/tools/', ...tools.map((t) => `/tools/${t.slug}/`)] : [])]
    .flatMap((p) => [`${p}index.md`, `  Link: <${SITE}${p}>; rel="canonical"`]),
  '',
].join('\n'));
console.log('site/dist written', (html.length / 1024).toFixed(1) + ' kB', `install -> v${version}`, `guides: ${guides.length}`);
