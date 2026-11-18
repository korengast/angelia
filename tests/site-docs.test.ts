import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- the site's build is plain JavaScript, without types
import { renderMarkdown, anchor, toc, inline, rewriteLinks } from '../site/docs.mjs';

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

test('site docs: a link goes only to the web, to mail, to a heading or to a relative path', () => {
  const { html } = renderMarkdown('[a](https://x.org) [b](mailto:a@x.org) [c](#part) [d](../x.md) [e](javascript:alert) [f](data:text/html,x) [`g`](y.md) and `[h](z.md)`');
  assert.equal(html, '<p><a href="https://x.org">a</a> <a href="mailto:a@x.org">b</a> <a href="#part">c</a> <a href="../x.md">d</a> ' +
    '[e](javascript:alert) [f](data:text/html,x) <a href="y.md"><code>g</code></a> and <code>[h](z.md)</code></p>');
  // Two slashes (forward or back) reach another host; a control character can hide a scheme.
  assert.equal(inline('[a](//evil.example) [b](\\\\evil.example) [c](\u0001javascript:x) [d](/docs/)'),
    '[a](//evil.example) [b](\\\\evil.example) [c](\u0001javascript:x) <a href="/docs/">d</a>');
  // A target ends at a double quote, so a quote cannot leave the href; a title is not a link.
  assert.equal(inline('[a](x"onmouseover="y) [b](x.md "title")'), '[a](x&quot;onmouseover=&quot;y) [b](x.md &quot;title&quot;)');
  // The text cannot forge the place of a held piece: the private-use mark is taken out first.
  assert.equal(inline('`c` \uE0000\uE000 and \u00000\u0000'), '<code>c</code> 0 and \u00000\u0000');
});

test('site docs: heading ids follow github-slugger, and a # in a heading is kept', () => {
  const { html } = renderMarkdown('## Foo\n\n## Foo\n\n## Foo-1\n\n## Use C#\n\n## Closed ##');
  assert.equal(html, ['<h2 id="foo">Foo</h2>', '<h2 id="foo-1">Foo</h2>', '<h2 id="foo-1-1">Foo-1</h2>', '<h2 id="use-c">Use C#</h2>', '<h2 id="closed">Closed</h2>'].join('\n'));
});

test('site docs: Markdown the renderer does not handle fails the build, with where it is', () => {
  for (const [md, what] of [['> quoted', 'a blockquote'], ['Title\n===', 'a setext heading'], ['a\n\n---', 'a rule'],
    ['+ item', 'a list marker'], ['- a\n  + nested', 'a list marker'], ['- a\n\t- b', 'a tab indent'],
    ['```\ncode', 'a fence that is never closed'], ['- a\n\n  ```\n  code\n- b', 'a fence that is never closed'],
    // A top-level fence closes at 0-3 spaces, as the page renders it: a deeper ``` is code, and the fence stays open.
    ['```\ncode\n    ```\nafter', 'a fence that is never closed'], ['~~~\ncode\n~~~', 'a ~~~ fence'], ['![logo](x.png)', 'an image'], ['a \\* b', 'a backslash escape'], ['a <br> b', 'raw HTML'],
    ['[a][ref]', 'a reference link'], ['[ref]: https://x.org', 'a reference link or definition'], ['a &rarr; b', 'an HTML entity'], ['see https://x.org now', 'a bare URL'],
    ['para\n\n    code', 'an indented code block'], ['~~gone~~', 'strikethrough'], ['an _emphasis_ here', 'underscore emphasis']])
    assert.throws(() => renderMarkdown(md), (e: Error) => e.message.includes(what), md);
  // Inside code, in a table's escaped pipe, and in a fenced block, the same characters are fine.
  assert.doesNotThrow(() => renderMarkdown('`<br> \\* ![x](y)`\n\n| a | b |\n|---|---|\n| `x \\| y` | c |\n\n```\n> quoted\n---\n```'));
  // A deeper ``` inside a top-level fence is code: the check after the fence still runs, and the page shows it as code.
  assert.throws(() => renderMarkdown('```\n    ```\n```\n\n> quoted'), (e: Error) => e.message.includes('a blockquote'));
  assert.equal(renderMarkdown('```\n    ```\n```').html, '<pre><code>    ```</code></pre>');
  // A link's own URL, snake_case words, and a list item's indented continuation are fine too.
  assert.doesNotThrow(() => renderMarkdown('[site](https://x.org) and allow_from and a_b_c\n\n- item\n\n    more of the item'));
});

test('site docs: a nested list, a fence and a table go inside the item whose content column they reach', () => {
  const md = [
    '1. **Firewall.** One rule.',
    '   - Remove the ICMP rule.',
    '   - Check the page.',
    '2. **Copy it:**',
    '',
    '   ```bash',
    '   rsync -a x y',
    '',
    '   echo two',
    '   ```',
    '',
    '   - `wa/` moves with it.',
    '3. Last.',
    '',
    '- top',
    '  - nested',
    '    - deeper',
    '  - nested again',
    '- next',
    '  1. inner',
    '',
    '  2. inner, loose',
    '- after',
    '',
    'Then:',
    '',
    '- outer',
    '  under it',
    '  - a',
    '',
    '    a goes on',
    '  ',
    '| | |',
    '|---|---|',
    '| `admin` | Your login. |',
  ].join('\n');
  // Text in a nested item is escaped like any other, and a quote still ends a link's target there.
  assert.equal(renderMarkdown('- a\n  - `<b>` & "x" > y\n    - [`<i>`](q.md?a=1&b="2")').html,
    '<ul><li>a\n<ul><li><code>&lt;b&gt;</code> &amp; &quot;x&quot; &gt; y\n<ul><li>[<code>&lt;i&gt;</code>](q.md?a=1&amp;b=&quot;2&quot;)</li></ul></li></ul></li></ul>');
  const { html } = renderMarkdown(md);
  assert.equal(html, [
    // A tight list stays tight with its nested list; a blank line between an item's own blocks makes it loose.
    '<ol><li><p><strong>Firewall.</strong> One rule.</p>\n<ul><li>Remove the ICMP rule.</li><li>Check the page.</li></ul></li>' +
    '<li><p><strong>Copy it:</strong></p>\n<pre class="bash"><code>rsync -a x y\n\necho two</code></pre>\n<ul><li><code>wa/</code> moves with it.</li></ul></li><li><p>Last.</p></li></ol>',
    // Three levels deep, and a blank line inside a nested list does not loosen the list it sits in.
    '<ul><li>top\n<ul><li>nested\n<ul><li>deeper</li></ul></li><li>nested again</li></ul></li>' +
    '<li>next\n<ol><li><p>inner</p></li><li><p>inner, loose</p></li></ol></li><li>after</li></ul>',
    '<p>Then:</p>',
    '<ul><li>outer\nunder it\n<ul><li><p>a</p>\n<p>a goes on</p></li></ul></li></ul>',
    // A header row with no text is left out.
    '<div class="table"><table><tbody><tr><td><code>admin</code></td><td>Your login.</td></tr></tbody></table></div>',
  ].join('\n'));
});

test('site docs: the Markdown copy rewrites link targets, never inside code', () => {
  const md = 'See [ref](reference.md#x) and `[not](a.md)`.\n\n```\n[not](b.md)\n```\n';
  assert.equal(rewriteLinks(md, (h: string) => `https://site/${h}`), 'See [ref](https://site/reference.md#x) and `[not](a.md)`.\n\n```\n[not](b.md)\n```\n');
});

test('site docs: every doc the site publishes renders with no Markdown left in its text', () => {
  const files = ['docs/reference.md', 'docs/security.md', 'docs/runbook.md', 'docs/linux-server.md', ...readdirSync(join(repo, 'docs', 'decisions')).filter((f) => f.endsWith('.md')).map((f) => `docs/decisions/${f}`)];
  for (const file of files) {
    const { title, html } = renderMarkdown(readFileSync(join(repo, file), 'utf8'));
    assert.ok(title, `${file}: a title`);
    // Outside code, no Markdown syntax survives: no bold markers, link brackets, fences or table rules.
    const text = html.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '');
    for (const left of ['**', '](', '```', '|---', '\n# ', '\n## ', '\n- ', '\n1. ']) assert.ok(!text.includes(left), `${file}: "${left}" left in the page`);
    assert.equal((html.match(/<pre/g) ?? []).length, (readFileSync(join(repo, file), 'utf8').match(/^ *```/gm) ?? []).length / 2, `${file}: every fence a code block`);
  }
});
