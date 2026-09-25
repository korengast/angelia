// Builds the landing page: inlines the mark as a <symbol> and draws the meander ring.
// node site/build.mjs        ->  site/dist/, ready to upload as it is (Cloudflare Pages reads _redirects, _headers)
// node site/build.mjs --og   ->  the share card and the README banner as pages in the temp folder; render them
//                                into static/og.png (1200x630) and static/banner.png (1280x400 at 2x)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, rmSync } from 'node:fs';
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

if (process.argv.includes('--og')) {
  const out = join(tmpdir(), 'angelia-og');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'og.html'), page('og.html'));
  writeFileSync(join(out, 'banner.html'), page('banner.html'));
  cpSync(join(here, 'fonts'), join(out, 'fonts'), { recursive: true });
  console.log(`${out}: og.html at 1200x630 into site/static/og.png, banner.html at 1280x400 (2x) into site/static/banner.png`);
  process.exit(0);
}

const out = join(here, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const html = page('index.html');
writeFileSync(join(out, 'index.html'), html);
writeFileSync(join(out, '404.html'), page('404.html'));
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
writeFileSync(join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}/</loc></url></urlset>\n`);
copyFileSync(join(here, 'mark.svg'), join(out, 'mark.svg'));
copyFileSync(join(here, 'favicon.svg'), join(out, 'favicon.svg'));
cpSync(join(here, 'fonts'), join(out, 'fonts'), { recursive: true });
cpSync(join(here, 'static'), out, { recursive: true });
// The short install line. It points at the install.sh attached to the release, byte for byte the one in
// the signed tag (it carries that release's key), because GitHub counts an asset's downloads.
writeFileSync(join(out, '_redirects'),
  `/install https://github.com/${REPO}/releases/download/v${version}/install.sh 302\n`);
writeFileSync(join(out, '_headers'), [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  // Cloudflare Web Analytics (cookieless) injects its beacon script and posts to cloudflareinsights.com.
  "  Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; img-src 'self' data:; frame-ancestors 'none'",
  '/fonts/*',
  '  Cache-Control: public, max-age=2592000',
  '',
].join('\n'));
console.log('site/dist written', (html.length / 1024).toFixed(1) + ' kB', `install -> v${version}`);
