// The site is static assets. Cloudflare's asset server answers a Range request with the whole file
// (200), and Safari, on iOS above all, plays a <video> only from 206 answers. So the demo videos, and
// only they (run_worker_first in wrangler.jsonc), pass through this script, which cuts the range.

/** One `bytes=` range of a file of `size` bytes: { start, end } (end inclusive), 'bad' when it cannot
 *  be served (416), or undefined to answer with the whole file (no range, several ranges, or another
 *  unit: a server may ignore those). */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  let start, end;
  if (m[1] === '') {
    // The last N bytes.
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return undefined;
  }
  if (start >= size) return 'bad';
  return { start, end };
}

export default {
  async fetch(request, env) {
    const range = request.headers.get('range');
    const ifRange = request.headers.get('if-range');
    const withRanges = (res, status = res.status, body = res.body) => {
      const headers = new Headers(res.headers);
      if (res.status === 200) headers.set('accept-ranges', 'bytes');
      return { headers, response: () => new Response(body, { status, headers }) };
    };
    // No range: the asset server's own answer (a HEAD keeps its Content-Length), saying ranges work.
    if (!range) return withRanges(await env.ASSETS.fetch(request)).response();
    // Ask for the whole file, with GET even for a HEAD: the range is cut from the body.
    const plain = new Headers(request.headers);
    plain.delete('range');
    plain.delete('if-range');
    const res = await env.ASSETS.fetch(new Request(request.url, { method: 'GET', headers: plain }));
    const head = request.method === 'HEAD';
    // An If-Range that is not this file's ETag means the client's copy changed: the whole file.
    if (res.status !== 200 || (ifRange && ifRange !== res.headers.get('etag'))) return withRanges(res, res.status, head ? null : res.body).response();
    const body = await res.arrayBuffer();
    const size = body.byteLength;
    const r = parseRange(range, size);
    if (r === undefined) return withRanges(res, 200, head ? null : body).response();
    if (r === 'bad') {
      const { headers } = withRanges(res);
      headers.set('content-range', `bytes */${size}`);
      headers.delete('content-length');
      return new Response(null, { status: 416, headers });
    }
    const { headers } = withRanges(res);
    headers.set('content-range', `bytes ${r.start}-${r.end}/${size}`);
    headers.set('content-length', String(r.end - r.start + 1));
    return new Response(head ? null : body.slice(r.start, r.end + 1), { status: 206, headers });
  },
};
