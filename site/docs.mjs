// The repository's Markdown docs as HTML, at build time, so the site never drifts from them. A small
// renderer for the Markdown docs/ writes, not for any Markdown: ATX headings, paragraphs, tight and
// loose lists, fenced code, pipe tables, code spans, links, bold and italic. Anything else (see
// UNSUPPORTED) fails the build, so a doc never renders differently here and on GitHub without notice.

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GitHub's heading anchor: lower case, punctuation dropped, each space a hyphen. Links written for
 *  GitHub (`reference.md#skills-scripts-and-tools`) then land on the same heading here. */
export const anchor = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

/** github-slugger's ids: a repeated heading gets -1, -2..., and an id already taken moves on. */
function slugger() {
  const seen = new Map();
  return (base) => {
    let id = base;
    while (seen.has(id)) { seen.set(base, seen.get(base) + 1); id = `${base}-${seen.get(base)}`; }
    seen.set(id, 0);
    return id;
  };
}

/** A link goes to the web, to mail, to a heading or to a relative path; any other scheme is text. */
const SAFE_HREF = /^(https?:|mailto:|#)|^(?![a-z][a-z0-9+.-]*:)/i;
const CODE_SPAN = /(`+)([\s\S]*?[^`])\1(?!`)/g;

/** One line of Markdown text into HTML. `link(href)` gives the URL a link points at on the site. */
export function inline(md, link = (h) => h) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  const marks = (t) => esc(t)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, '$1<em>$2</em>');
  // Code spans first: nothing inside one is Markdown, brackets included. A link's text may hold them.
  let t = md.replace(CODE_SPAN, (_, _ticks, code) => hold(`<code>${esc(code.replace(/^ (.*) $/, '$1'))}</code>`))
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (all, text, href) => SAFE_HREF.test(href) ? hold(`<a href="${esc(link(href))}">${marks(text)}</a>`) : all);
  t = marks(t);
  while (/\u0000\d+\u0000/.test(t)) t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);
  return t;
}

/** What the renderer does not handle, outside fenced code: [test, what it is]. Line tests see each
 *  line; text tests see a paragraph with its code spans taken out. */
const UNSUPPORTED_LINE = [
  [/^ {0,3}~~~/, 'a ~~~ fence'],
  [/^ {0,3}>/, 'a blockquote'],
  [/^ {0,3}(=+|-+|(\* *){3,}|(_ *){3,})\s*$/, 'a setext heading or a rule'],
  [/^ +([-*+]|\d+[.)]) /, 'an indented (nested) list item'],
  [/^(\+|\d+\)) /, 'a list marker other than -, * or 1.'],
];
const UNSUPPORTED_TEXT = [
  [/!\[/, 'an image'],
  [/\\[!-/:-@[-`{-~]/, 'a backslash escape'],
  [/<\/?[a-zA-Z!]/, 'raw HTML'],
];
function unsupported(md) {
  const found = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let fenced = false;
  let para = [];
  const flush = () => {
    const text = para.map(([, l]) => (l.trimStart().startsWith('|') ? l.replace(/\\\|/g, '') : l)).join('\n').replace(CODE_SPAN, '');
    for (const [re, what] of UNSUPPORTED_TEXT) if (re.test(text)) found.push(`${what} near line ${para[0][0]}`);
    para = [];
  };
  lines.forEach((l, k) => {
    if (FENCE.test(l) || (fenced && /^ {0,3}```\s*$/.test(l))) { flush(); fenced = !fenced; return; }
    if (fenced) return;
    if (/^\s*$/.test(l)) { flush(); return; }
    for (const [re, what] of UNSUPPORTED_LINE) if (re.test(l) && !(l.includes('|') && TABLE_RULE.test(l))) found.push(`${what} at line ${k + 1}`);
    para.push([k + 1, l]);
  });
  flush();
  return found;
}

const plain = (md) => inline(md).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const ITEM = /^( {0,3})([-*]|\d+\.) +(.*)$/;
const FENCE = /^ {0,3}```\s*([\w-]*)\s*$/;
// A closing run of #s counts only after a space, so "Use C#" keeps its #.
const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const TABLE_RULE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * A Markdown document into { title, html, headings }. The first h1 is the title and is left out of
 * the html (the page template prints it); every other heading gets its GitHub anchor as its id.
 * Throws on Markdown it does not render (UNSUPPORTED_LINE, UNSUPPORTED_TEXT), naming each place.
 */
export function renderMarkdown(md, link = (h) => h) {
  const found = unsupported(md);
  if (found.length) throw new Error(`Markdown the site cannot render: ${found.join('; ')}`);
  return render(md, link, slugger());
}

function render(md, link, slug) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const headings = [];
  let title;
  let i = 0;
  const startsBlock = (l) => FENCE.test(l) || HEADING.test(l) || ITEM.test(l) || /^\s*$/.test(l);
  const blocks = (src) => render(src, link, slug).html;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    let m;
    if ((m = line.match(FENCE))) {
      const body = [];
      for (i++; i < lines.length && !/^ {0,3}```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre${m[1] ? ` class="${esc(m[1])}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = line.match(HEADING))) {
      i++;
      const level = m[1].length;
      if (level === 1 && title === undefined) { title = plain(m[2]); continue; }
      const id = slug(anchor(plain(m[2])));
      headings.push({ level, id, text: plain(m[2]) });
      out.push(`<h${level} id="${id}">${inline(m[2], link)}</h${level}>`);
      continue;
    }
    if (line.trimStart().startsWith('|') && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trimStart().startsWith('|'); i++) rows.push(cells(lines[i]));
      const row = (r, tag) => `<tr>${head.map((_, k) => `<${tag}>${inline(r[k] ?? '', link)}</${tag}>`).join('')}</tr>`;
      // A wide table scrolls sideways on a phone, under a hint (see the page's CSS).
      out.push(`<div class="table${head.length >= 4 ? ' wide' : ''}"><table><thead>${row(head, 'th')}</thead><tbody>${rows.map((r) => row(r, 'td')).join('')}</tbody></table></div>`);
      continue;
    }
    if ((m = line.match(ITEM))) {
      const ordered = /\d/.test(m[2]);
      const items = [];
      let loose = false;
      while (i < lines.length) {
        const im = lines[i].match(ITEM);
        if (!im || /\d/.test(im[2]) !== ordered) break;
        const width = im[1].length + im[2].length + 1;
        const body = [im[3]];
        for (i++; i < lines.length; i++) {
          const l = lines[i];
          if (/^\s*$/.test(l)) {
            // A blank line goes on with the item only when an indented line follows it.
            const next = lines[i + 1] ?? '';
            if (/^ {2,}\S/.test(next) && !ITEM.test(next)) { body.push(''); loose = true; continue; }
            break;
          }
          if (ITEM.test(l)) break;
          if (/^ {2,}/.test(l)) { body.push(l.slice(Math.min(width, l.length - l.trimStart().length))); continue; }
          if (startsBlock(l) || l.trimStart().startsWith('|')) break;
          body.push(l); // a lazy continuation line
        }
        items.push(body.join('\n'));
        // A blank line between two items makes the list loose.
        if (/^\s*$/.test(lines[i] ?? '') && ITEM.test(lines[i + 1] ?? '') && /\d/.test(lines[i + 1].match(ITEM)[2]) === ordered) { loose = true; i++; }
      }
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered && Number(m[2]) !== 1 ? ` start="${Number(m[2])}"` : '';
      out.push(`<${tag}${start}>${items.map((it) => {
        const html = blocks(it);
        return `<li>${loose ? html : html.replace(/^<p>([\s\S]*?)<\/p>/, '$1')}</li>`;
      }).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    for (; i < lines.length && !startsBlock(lines[i]) && !(lines[i].trimStart().startsWith('|') && TABLE_RULE.test(lines[i + 1] ?? '')); i++) para.push(lines[i].trim());
    out.push(`<p>${inline(para.join('\n'), link)}</p>`);
  }
  return { title, html: out.join('\n'), headings };
}

/** The table of contents for a long page: its h2s, each with its h3s. */
export function toc(headings) {
  const items = [];
  for (const h of headings) {
    if (h.level === 2) items.push({ ...h, subs: [] });
    else if (h.level === 3 && items.length) items.at(-1).subs.push(h);
  }
  const a = (h) => `<a href="#${h.id}">${esc(h.text)}</a>`;
  return `<nav class="toc" aria-label="On this page"><p class="toc-h">On this page</p><ul>${items.map((h) =>
    `<li>${a(h)}${h.subs.length ? `<ul>${h.subs.map((s) => `<li>${a(s)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul></nav>`;
}
