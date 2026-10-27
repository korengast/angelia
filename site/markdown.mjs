// The site's pages as Markdown, for agents that ask for it (Accept: text/markdown, served by
// site/worker/ranges.js). A small converter for the markup this site writes, not for any HTML:
// headings, paragraphs, lists, links, code, tables and the chat figure. Chrome is left out: the head,
// scripts, styles, icons, buttons, the skip link, and anything hidden from screen readers.

const VOID = new Set(['br', 'img', 'source', 'meta', 'link', 'input', 'hr', 'use', 'rect', 'path', 'circle']);
const SKIP = new Set(['head', 'script', 'style', 'svg', 'button', 'nav', 'header', 'template']);
const BLOCK = new Set(['p', 'div', 'nav', 'section', 'figure', 'figcaption', 'main', 'article', 'header', 'footer', 'table', 'pre', 'ul', 'ol', 'blockquote']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←', copy: '©' };

/** A code span that holds backticks: a fence one longer than its longest run, with a space inside
 *  when the code starts or ends with one (CommonMark). */
const codeSpan = (code) => {
  const fence = '`'.repeat(Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = /^`|`$/.test(code) ? ' ' : '';
  return fence + pad + code + pad + fence;
};
const decode = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#'
  ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  : ENTITIES[e.toLowerCase()] ?? m);

/** HTML into a tree of { tag, attrs, children } and strings. Comments are dropped. */
function parse(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+|<)/g;
  for (let m; (m = re.exec(html));) {
    const [all, close, name, rawAttrs, selfClose, text] = m;
    if (text !== undefined) { stack.at(-1).children.push(decode(text)); continue; }
    if (all.startsWith('<!--')) continue;
    const tag = name.toLowerCase();
    if (close) {
      const at = stack.findLastIndex((n) => n.tag === tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    const node = { tag, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!selfClose && !VOID.has(tag)) stack.push(node);
    // Raw text: the parser must not read a script's or style's body as markup.
    if (tag === 'script' || tag === 'style') {
      const end = html.indexOf(`</${tag}>`, re.lastIndex);
      re.lastIndex = end < 0 ? html.length : end;
    }
  }
  return root;
}

const textOf = (n) => typeof n === 'string' ? n : n.children.map(textOf).join('');
const classes = (n) => (n.attrs.class ?? '').split(/\s+/);
// A guide's "More guides" list is a nav, but it is content: kept.
const hidden = (n) => (SKIP.has(n.tag) && !(n.tag === 'nav' && classes(n).includes('more'))) || n.attrs['aria-hidden'] === 'true' || classes(n).includes('skip') || classes(n).includes('sr');

/** Converts one page. `base` is the page's own URL: site paths become absolute links. */
export function htmlToMarkdown(html, base) {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const url = (href) => {
    if (!href) return href;
    try { return new URL(href, base).href; } catch { return href; }
  };
  const inline = (nodes) => nodes.map((n) => {
    if (typeof n === 'string') return n.replace(/\s+/g, ' ');
    if (hidden(n)) return '';
    const inner = () => inline(n.children);
    switch (n.tag) {
      case 'br': return '\n';
      case 'code': return codeSpan(textOf(n).replace(/\s+/g, ' '));
      case 'b': case 'strong': { const t = inner().trim(); return t ? `**${t}** ` : ''; }
      case 'em': case 'i': { const t = inner().trim(); return t ? `*${t}* ` : ''; }
      case 'a': { const t = inner().trim(); return t ? `[${t}](${url(n.attrs.href)})` : ''; }
      case 'img': return `![${n.attrs.alt ?? ''}](${url(n.attrs.src)})`;
      case 'time': return inner();
      default: return BLOCK.has(n.tag) || /^h[1-6]$/.test(n.tag) || n.tag === 'li' ? '' : inner();
    }
  }).join('');
  const tidy = (t) => t.replace(/ +\n/g, '\n').replace(/\n +/g, '\n').replace(/ {2,}/g, ' ').replace(/ +([.,;:)])/g, '$1').trim();

  const out = [];
  const block = (nodes, indent = '') => {
    let run = [];
    const flush = () => {
      const t = tidy(inline(run));
      if (t) out.push(indent + t.replace(/\n/g, '\n' + indent));
      run = [];
    };
    for (const n of nodes) {
      if (typeof n === 'string' || !(BLOCK.has(n.tag) || /^h[1-6]$/.test(n.tag) || ['li', 'video', 'tr'].includes(n.tag))) { run.push(n); continue; }
      flush();
      if (hidden(n)) continue;
      if (/^h[1-6]$/.test(n.tag)) {
        const t = tidy(inline(n.children)).replace(/\n/g, ' ');
        // A heading cannot sit in a list item: there it is the item's bold first line.
        out.push(indent ? `${indent}**${t.replace(/\*\*/g, '')}**` : `${'#'.repeat(Number(n.tag[1]))} ${t}`);
        continue;
      }
      if (n.tag === 'pre') {
        const lang = ['yaml', 'json', 'sh', 'bash', 'ts', 'js'].find((l) => classes(n).includes(l) || classes(n).includes(`language-${l}`)) ?? '';
        out.push(`${indent}\`\`\`${lang}\n${textOf(n).replace(/^\n/, '').replace(/\s+$/, '')}\n\`\`\``.replace(/\n/g, '\n' + indent));
        continue;
      }
      if (n.tag === 'ul' || n.tag === 'ol') {
        // A tight list: one entry for the whole list, the lines of an item under its marker.
        let i = 0;
        const items = [];
        for (const li of n.children.filter((c) => typeof c !== 'string' && c.tag === 'li' && !hidden(c))) {
          const mark = n.tag === 'ol' ? `${++i}. ` : '- ';
          const at = out.length;
          block(li.children, indent + ' '.repeat(mark.length));
          const item = out.splice(at).join('\n');
          items.push(indent + mark + item.slice(indent.length + mark.length));
        }
        if (items.length) out.push(items.join('\n'));
        continue;
      }
      if (n.tag === 'table') {
        const rows = [];
        const walk = (x) => typeof x !== 'string' && (x.tag === 'tr' ? rows.push(x) : x.children.forEach(walk));
        walk(n);
        const cells = rows.map((r) => r.children.filter((c) => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'))
          .map((c) => tidy(inline(c.children)).replace(/\n/g, ' ').replace(/\|/g, '\\|')));
        if (!cells.length) continue;
        const width = Math.max(...cells.map((r) => r.length));
        const line = (r) => '| ' + Array.from({ length: width }, (_, k) => r[k] ?? '').join(' | ') + ' |';
        out.push([line(cells[0]), '|' + ' --- |'.repeat(width), ...cells.slice(1).map(line)].map((l) => indent + l).join('\n'));
        continue;
      }
      if (n.tag === 'video') {
        const label = n.attrs['aria-label'] ?? 'Video';
        const src = n.children.find((c) => typeof c !== 'string' && c.tag === 'source' && /mp4/.test(c.attrs.type ?? ''))?.attrs.src;
        if (src) out.push(`${indent}[${label}](${url(src)})`);
        continue;
      }
      // The chat figure: who says each message.
      if (classes(n).includes('msg')) {
        const who = classes(n).includes('me') ? 'You' : 'Angelia';
        out.push(`${indent}> **${who}:** ${tidy(inline(n.children))}`);
        continue;
      }
      if (n.tag === 'blockquote') {
        const at = out.length;
        block(n.children);
        out.push(out.splice(at).join('\n\n').replace(/^/gm, '> '));
        continue;
      }
      block(n.children, indent);
    }
    flush();
  };
  block(parse(body).children);
  return out.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
