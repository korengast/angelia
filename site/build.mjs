// Builds the landing page: inlines the mark as a <symbol> and draws the meander ring.
// node site/build.mjs        ->  site/dist/, ready to upload as it is (Cloudflare Pages reads _redirects, _headers)
// node site/build.mjs --drafts ->  the same, with the guides still marked draft (to read them locally, never to deploy)
// node site/build.mjs --og   ->  the share card and the README banner as pages in the temp folder; render them
//                                into static/og.png (1200x630) and static/banner.png (1280x400 at 2x)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

if (process.argv.includes('--og')) {
  const out = join(tmpdir(), 'angelia-og');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'og.html'), page('og.html'));
  writeFileSync(join(out, 'banner.html'), page('banner.html'));
  // One card per guide, its title in place of the slogan: render og-<slug>.html into site/static/guides/<slug>/og.png.
  for (const f of readdirSync(join(here, 'guides')).filter((x) => x.endsWith('.html'))) {
    const { title } = JSON.parse(readFileSync(join(here, 'guides', f), 'utf8').match(/^<!--(\{[\s\S]*?\})-->\n/)[1]);
    writeFileSync(join(out, `og-${f}`), page('og.html').replace(/<h1>[\s\S]*?<\/h1>/, `<h1 class="guide">${esc(title)}</h1>`).replace('On WhatsApp and Telegram. On your machine.', 'A guide from Angelia.'));
  }
  cpSync(join(here, 'fonts'), join(out, 'fonts'), { recursive: true });
  console.log(`${out}: og.html at 1200x630 into site/static/og.png, banner.html at 1280x400 (2x) into site/static/banner.png`);
  process.exit(0);
}

// Guides: site/guides/<slug>.html is the article body, headed by a JSON comment (title, description,
// date, optional updated, draft). A draft is left out of the site and the sitemap unless --drafts.
const AUTHOR = { '@type': 'Person', name: 'Koren Gast', url: 'https://github.com/korengast' };
const guides = readdirSync(join(here, 'guides')).filter((f) => f.endsWith('.html')).map((f) => {
  const src = readFileSync(join(here, 'guides', f), 'utf8');
  const m = src.match(/^<!--(\{[\s\S]*?\})-->\n/);
  if (!m) throw new Error(`site/guides/${f}: no JSON header`);
  return { slug: f.replace(/\.html$/, ''), body: src.slice(m[0].length), ...JSON.parse(m[1]) };
}).filter((g) => !g.draft || process.argv.includes('--drafts')).sort((a, b) => b.date.localeCompare(a.date));
// The tab and search title: the brand after it only while the whole stays within what results show.
const pageTitle = (title) => (title.length + 10 <= 60 ? `${title} · Angelia` : title);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d) => { const [y, m, day] = d.split('-').map(Number); return `${day} ${MONTHS[m - 1]} ${y}`; };
// Every h2 gets an id (from its text when it has none), so a section can be linked to.
const slugify = (t) => t.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const withIds = (body) => body.replace(/<h2>([\s\S]*?)<\/h2>/g, (_, inner) => `<h2 id="${slugify(inner)}">${inner}</h2>`);
const guidePage = ({ title, description, url, date, modified = date, byline, body, jsonld, ogType = 'article', ogImage = `${SITE}/og.png`, ogAlt = 'Angelia. Your coding agent. Your personal assistant.' }) => page('guide.html')
  .replace('{{OGTYPE}}', ogType).replace('{{OGIMAGE}}', ogImage).replace('{{OGALT}}', esc(ogAlt))
  .replace('<!--ARTICLE-->', ogType === 'article' ? `<meta property="article:published_time" content="${date}">\n<meta property="article:modified_time" content="${modified}">` : '')
  .replaceAll('{{PAGETITLE}}', esc(pageTitle(title))).replaceAll('{{MODIFIED}}', modified)
  .replaceAll('{{TITLE}}', esc(title)).replaceAll('{{DESCRIPTION}}', esc(description)).replaceAll('{{URL}}', url)
  .replaceAll('{{DATE}}', date).replace('{{BYLINE}}', byline).replace('{{JSONLD}}', JSON.stringify(jsonld).replace(/</g, '\\u003c'))
  .replace('<!--BODY-->', withIds(body).replaceAll('{{SITE}}', SITE).replaceAll('{{REPO}}', REPO).replaceAll('{{VERSION}}', version));

// A guide's own share card, when one has been rendered: site/static/guides/<slug>/og.png (see --og).
const guideOg = (slug) => existsSync(join(here, 'static', 'guides', slug, 'og.png')) ? `${SITE}/guides/${slug}/og.png` : `${SITE}/og.png`;
const out = join(here, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const g of guides) {
  const url = `${SITE}/guides/${g.slug}/`;
  mkdirSync(join(out, 'guides', g.slug), { recursive: true });
  writeFileSync(join(out, 'guides', g.slug, 'index.html'), guidePage({
    title: g.title, description: g.description, url, date: g.date, modified: g.updated ?? g.date, body: g.body,
    ogImage: guideOg(g.slug), ogAlt: g.title,
    byline: `Koren Gast · Updated <time datetime="${g.updated ?? g.date}">${longDate(g.updated ?? g.date)}</time>`,
    jsonld: { '@context': 'https://schema.org', '@type': 'Article', headline: g.title, description: g.description, datePublished: g.date, dateModified: g.updated ?? g.date, author: AUTHOR, mainEntityOfPage: url, image: guideOg(g.slug), publisher: { '@type': 'Organization', name: 'Angelia', url: `${SITE}/` } },
  }));
}
if (guides.length) writeFileSync(join(out, 'guides', 'index.html'), guidePage({
  title: 'Guides', description: 'How to run your coding agent CLI as a personal assistant from WhatsApp and Telegram.',
  url: `${SITE}/guides/`, date: guides[0].date, byline: 'Angelia', ogType: 'website',
  body: '<ul>' + guides.map((g) => `<li><a href="/guides/${g.slug}/">${esc(g.title)}</a><br><span class="meta">${g.date} · ${esc(g.description)}</span></li>`).join('') + '</ul>',
  jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Angelia guides', url: `${SITE}/guides/` },
}));
// The comparison guide, linked from the home page once it is published.
const COMPARE = 'claude-code-whatsapp-telegram';
const html = page('index.html')
  .replace('<!--GUIDES-->', guides.length ? '<li class="keep"><a href="/guides/">Guides</a></li>' : '')
  .replace('<!--COMPARE-->', guides.some((g) => g.slug === COMPARE)
    ? `<p class="sub compare"><a href="/guides/${COMPARE}/">Remote Control, Claude Code channels, a WhatsApp plugin or Angelia? Four ways compared →</a></p>` : '');
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, '404.html'), page('404.html'));
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
writeFileSync(join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}/</loc></url>` +
  (guides.length ? `<url><loc>${SITE}/guides/</loc></url>` : '') +
  guides.map((g) => `<url><loc>${SITE}/guides/${g.slug}/</loc><lastmod>${g.updated ?? g.date}</lastmod></url>`).join('') + '</urlset>\n');
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
  `/docs https://github.com/${REPO}#readme 302\n/docs/ https://github.com/${REPO}#readme 302\n`);
writeFileSync(join(out, '_headers'), [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  // Cloudflare Web Analytics (cookieless) injects its beacon script and posts to cloudflareinsights.com.
  "  Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; img-src 'self' data:; frame-ancestors 'none'",
  '/fonts/*',
  '  Cache-Control: public, max-age=2592000',
  '/angelia-demo*',
  '  Cache-Control: public, max-age=2592000',
  '',
].join('\n'));
console.log('site/dist written', (html.length / 1024).toFixed(1) + ' kB', `install -> v${version}`, `guides: ${guides.length}`);
