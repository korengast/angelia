import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error -- the site's Worker and build are plain JavaScript, without types
import worker, { prefersMarkdown } from '../site/worker/main.js';
// @ts-expect-error -- the site's Worker and build are plain JavaScript, without types
import { htmlToMarkdown } from '../site/markdown.mjs';

test('site markdown: only a client that names text/markdown and wants it as much as HTML gets it', () => {
  for (const yes of ['text/markdown', 'text/markdown, text/html', 'text/markdown;q=1, text/html;q=0.9', 'text/html;q=0.5, text/markdown', 'text/markdown, */*'])
    assert.equal(prefersMarkdown(yes), true, yes);
  for (const no of [null, '', '*/*', 'text/*', 'text/html', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'text/markdown;q=0', 'text/markdown;q=0.5, text/html', 'text/plain', 'text/markdown;q=0.5, */*'])
    assert.equal(prefersMarkdown(no), false, String(no));
});

/** The Worker in front of a stand-in asset server: the home page, a guide folder, and the 404 page. */
const FILES: Record<string, [string, string]> = {
  '/': ['<html><body><h1>Home</h1></body></html>', 'text/html'],
  '/index.md': ['# Home\n', 'text/markdown'],
  '/guides/a/': ['<html><body><h1>A</h1></body></html>', 'text/html'],
  '/guides/a/index.md': ['# A\n', 'text/markdown'],
  '/404.md': ['# Not found\n\nNothing is at this address. [llms.txt](https://useangelia.com/llms.txt)\n', 'text/markdown'],
  '/llms.txt': ['# Angelia\n', 'text/plain; charset=utf-8'],
  '/angelia-demo.mp4': ['0123456789', 'video/mp4'],
};
const env = {
  ASSETS: {
    fetch: async (r: Request) => {
      const { pathname } = new URL(r.url);
      if (pathname === '/guides/a') return new Response(null, { status: 301, headers: { location: '/guides/a/' } });
      const [body, type] = FILES[pathname] ?? ['<html><body>Not found</body></html>', 'text/html'];
      return new Response(r.method === 'HEAD' ? null : body, { status: FILES[pathname] ? 200 : 404, headers: { 'content-type': type, vary: 'Accept-Encoding' } });
    },
  },
};
async function ask(path: string, accept?: string, method = 'GET') {
  const res: Response = await worker.fetch(new Request(`https://useangelia.com${path}`, { method, headers: accept ? { accept } : {} }), env);
  return { res, body: await res.text(), type: res.headers.get('content-type'), vary: res.headers.get('vary') };
}

test('site markdown: a page answers Markdown or HTML by Accept, and says Vary: Accept either way', async () => {
  for (const path of ['/', '/guides/a/']) {
    const md = await ask(path, 'text/markdown');
    assert.equal(md.res.status, 200);
    assert.equal(md.type, 'text/markdown; charset=utf-8');
    assert.match(md.body, /^# /);
    assert.equal(md.vary, 'Accept-Encoding, Accept');
    const html = await ask(path, 'text/html');
    assert.equal(html.res.status, 200);
    assert.equal(html.type, 'text/html');
    assert.match(html.body, /<h1>/);
    assert.equal(html.vary, 'Accept-Encoding, Accept');
  }
  const browser = await ask('/', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  assert.equal(browser.type, 'text/html');
  const head = await ask('/', 'text/markdown', 'HEAD');
  assert.equal(head.type, 'text/markdown; charset=utf-8');
  assert.equal(head.body, '');
});

test('site markdown: a missing page keeps its 404 and gives an agent a Markdown body that says where to look', async () => {
  const md = await ask('/no-such-page', 'text/markdown');
  assert.equal(md.res.status, 404);
  assert.equal(md.type, 'text/markdown; charset=utf-8');
  assert.equal(md.vary, 'Accept-Encoding, Accept');
  assert.ok(md.body.length >= 20);
  assert.match(md.body, /llms\.txt/);
  const html = await ask('/no-such-page', 'text/html');
  assert.equal(html.res.status, 404);
  assert.equal(html.type, 'text/html');
});

test('site markdown: redirects, other files and the videos pass through as the asset server sent them', async () => {
  const moved = await ask('/guides/a', 'text/markdown');
  assert.equal(moved.res.status, 301);
  assert.equal(moved.res.headers.get('location'), '/guides/a/');
  const llms = await ask('/llms.txt', 'text/markdown');
  assert.equal(llms.type, 'text/plain; charset=utf-8');
  assert.equal(llms.vary, 'Accept-Encoding');
  const direct = await ask('/index.md');
  assert.equal(direct.type, 'text/markdown; charset=utf-8');
  const video = await ask('/angelia-demo.mp4', undefined);
  assert.equal(video.res.headers.get('accept-ranges'), 'bytes');
  const part = await worker.fetch(new Request('https://useangelia.com/angelia-demo.mp4', { headers: { range: 'bytes=2-4' } }), env);
  assert.equal(part.status, 206);
  assert.equal(await part.text(), '234');
});

test('site markdown: the converter keeps headings, lists, links, code and tables, and drops page chrome', () => {
  const html = `<html><head><title>T</title><style>p{}</style></head><body>
<a class="skip" href="#x">Skip</a><header><nav><a href="/">Home</a></nav></header>
<main><h1>Title <em>here</em></h1>
<p>See <a href="/guides/">the guides</a> &amp; <code>npm test</code>.<svg><path d="M0"/></svg></p>
<ul><li><b>One.</b> First</li><li><h3>Two</h3><p>Second</p></li></ul>
<ol><li>A</li><li>B</li></ol>
<pre class="yaml">a: 1
b: &lt;2&gt;</pre>
<table><tr><th>CLI</th><th>Status</th></tr><tr><td><b>pi</b><br><code>backend: pi</code></td><td>today</td></tr></table>
<div class="msg me">Hi</div><div class="msg bot">Hello</div>
<div aria-hidden="true">hidden</div><button>Copy</button>
<nav class="more"><h2>More guides</h2><ul><li><a href="/guides/b/">B</a></li></ul></nav>
</main><script>if (a < b) document.write('<p>no</p>')</script></body></html>`;
  assert.equal(htmlToMarkdown(html, 'https://useangelia.com/guides/a/'), [
    '# Title *here*',
    'See [the guides](https://useangelia.com/guides/) & `npm test`.',
    '- **One.** First\n- **Two**\n  Second',
    '1. A\n2. B',
    '```yaml\na: 1\nb: <2>\n```',
    '| CLI | Status |\n| --- | --- |\n| **pi** `backend: pi` | today |',
    '> **You:** Hi',
    '> **Angelia:** Hello',
    '## More guides',
    '- [B](https://useangelia.com/guides/b/)',
  ].join('\n\n') + '\n');
});
