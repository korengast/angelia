// node site/indexnow.mjs [url ...]  ->  tells IndexNow (Bing, Yandex and the others that share it) about
// the site's pages. Run it after a deploy is live. With no arguments it sends every URL in the live sitemap.
// The key is public by design: IndexNow checks that https://useangelia.com/<key>.txt holds it.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://useangelia.com';
const here = dirname(fileURLToPath(import.meta.url));
const keyFile = readdirSync(join(here, 'static')).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (!keyFile) throw new Error('site/static has no IndexNow key file (<32 hex>.txt)');
const key = keyFile.slice(0, -4);

const live = await fetch(`${SITE}/${keyFile}`);
if (!live.ok || (await live.text()).trim() !== key) throw new Error(`${SITE}/${keyFile} does not serve the key yet: deploy first`);
const urls = process.argv.length > 2 ? process.argv.slice(2)
  : [...(await (await fetch(`${SITE}/sitemap.xml`)).text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: new URL(SITE).host, key, keyLocation: `${SITE}/${keyFile}`, urlList: urls }),
});
console.log(`IndexNow ${res.status} for ${urls.length} URLs`);
if (res.status >= 300) process.exit(1);
