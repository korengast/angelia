// The site's Worker. Every page except fonts and images passes through it (run_worker_first in
// wrangler.jsonc). Two jobs, the rest is the asset server's own answer:
// - the demo videos answer Range requests (ranges.js);
// - Markdown for agents: a request whose Accept prefers text/markdown gets the page's index.md, and a
//   missing page gets 404.md with status 404 (acceptmarkdown.com). Pages that have both forms say
//   Vary: Accept, so a cache never hands one form to a client that asked for the other.
import ranges from './ranges.js';

/** The q of `type` in an Accept header, from the most specific range that names it (RFC 9110 12.5.1),
 *  and whether a range names it exactly. */
function quality(accept, type) {
  let best = { q: 0, rank: -1 };
  for (const part of accept.split(',')) {
    const [range, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    const rank = range === type ? 2 : range === `${type.split('/')[0]}/*` ? 1 : range === '*/*' ? 0 : -1;
    if (rank <= best.rank) continue;
    const q = params.find((p) => p.startsWith('q='));
    const value = q ? Number(q.slice(2)) : 1;
    best = { q: Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0, rank };
  }
  return best;
}

/** True when the client names text/markdown and wants it at least as much as HTML. A browser, curl's
 *  default (*\/*) and a crawler never name it, so they keep the HTML. */
export function prefersMarkdown(accept) {
  if (!accept) return false;
  const md = quality(accept, 'text/markdown');
  return md.rank === 2 && md.q > 0 && md.q >= quality(accept, 'text/html').q;
}

const withHeaders = (res, set, status = res.status) => {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(set)) {
    // Vary adds to what the asset server said (Accept-Encoding, say), never replaces it.
    const had = k === 'vary' ? headers.get('vary') : null;
    headers.set(k, had && !had.toLowerCase().split(/\s*,\s*/).includes('accept') ? `${had}, ${v}` : v);
  }
  return new Response(res.body, { status, headers, ...(status === res.status ? { statusText: res.statusText } : {}) });
};
const MARKDOWN = { 'content-type': 'text/markdown; charset=utf-8', vary: 'Accept' };
const isHtml = (res) => (res.headers.get('content-type') ?? '').startsWith('text/html');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/angelia-demo')) return ranges.fetch(request, env);
    const res = await env.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') return res;
    if (url.pathname.endsWith('.md') && res.status === 200) return withHeaders(res, MARKDOWN);
    if (!isHtml(res)) return res;
    if (prefersMarkdown(request.headers.get('accept'))) {
      // A page is a folder with index.html; its Markdown is index.md beside it. Redirects stay as they are.
      const file = res.status === 200 && url.pathname.endsWith('/') ? `${url.pathname}index.md` : res.status === 404 ? '/404.md' : undefined;
      if (file) {
        const md = await env.ASSETS.fetch(new Request(new URL(file, url), { method: request.method }));
        if (md.status === 200) return withHeaders(md, MARKDOWN, res.status);
      }
    }
    return withHeaders(res, { vary: 'Accept' });
  },
};
