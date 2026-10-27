import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- the site's build is plain JavaScript, without types
import { renderMarkdown, anchor, toc } from '../site/docs.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

test('site docs: the renderer turns the Markdown docs/ writes into HTML', () => {
  const md = [
    '# ADR 0001 — Title: here',
    '',
    'Status: accepted. A line',
    'wrapped by hand, `a <b>` and **bold** and *it* and [a link](other.md#part).',
    '',
    '## Antigravity CLI (`agy`)',
    '',
    '1. **One.** First line',
    '   goes on.',
    '2. Two',
    '',
    '- item with `code` and a [`linked file`](x.md)',
    '',
    '```bash',
    'echo "<hi>" # **not bold**',
    '```',
    '',
    '| Path | Purpose |',
    '|---|---|',
    '| `a \\| b` | c |',
    '',
    '## Antigravity CLI (`agy`)',
  ].join('\n');
  const { title, html, headings } = renderMarkdown(md, (h: string) => `/site/${h}`);
  assert.equal(title, 'ADR 0001 — Title: here');
  assert.deepEqual(headings.map((h: { id: string }) => h.id), ['antigravity-cli-agy', 'antigravity-cli-agy-1']);
  assert.equal(html, [
    '<p>Status: accepted. A line\nwrapped by hand, <code>a &lt;b&gt;</code> and <strong>bold</strong> and <em>it</em> and <a href="/site/other.md#part">a link</a>.</p>',
    '<h2 id="antigravity-cli-agy">Antigravity CLI (<code>agy</code>)</h2>',
    '<ol><li><strong>One.</strong> First line\ngoes on.</li><li>Two</li></ol>',
    '<ul><li>item with <code>code</code> and a <a href="/site/x.md"><code>linked file</code></a></li></ul>',
    '<pre class="bash"><code>echo &quot;&lt;hi&gt;&quot; # **not bold**</code></pre>',
    '<div class="table"><table><thead><tr><th>Path</th><th>Purpose</th></tr></thead><tbody><tr><td><code>a | b</code></td><td>c</td></tr></tbody></table></div>',
    '<h2 id="antigravity-cli-agy-1">Antigravity CLI (<code>agy</code>)</h2>',
  ].join('\n'));
  assert.match(toc(headings), /<a href="#antigravity-cli-agy-1">Antigravity CLI \(agy\)<\/a>/);
  assert.equal(anchor("What is yours and what is Angelia's"), 'what-is-yours-and-what-is-angelias');
});

test('site docs: every doc the site publishes renders with no Markdown left in its text', () => {
  const files = ['docs/reference.md', 'docs/security.md', 'docs/runbook.md', ...readdirSync(join(repo, 'docs', 'decisions')).filter((f) => f.endsWith('.md')).map((f) => `docs/decisions/${f}`)];
  for (const file of files) {
    const { title, html } = renderMarkdown(readFileSync(join(repo, file), 'utf8'));
    assert.ok(title, `${file}: a title`);
    // Outside code, no Markdown syntax survives: no bold markers, link brackets, fences or table rules.
    const text = html.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '');
    for (const left of ['**', '](', '```', '|---', '\n# ', '\n## ']) assert.ok(!text.includes(left), `${file}: "${left}" left in the page`);
    assert.equal((html.match(/<pre/g) ?? []).length, (readFileSync(join(repo, file), 'utf8').match(/^```/gm) ?? []).length / 2, `${file}: every fence a code block`);
  }
});
