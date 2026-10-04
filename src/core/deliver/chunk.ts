export const LIMITS = { telegram: 4000, whatsapp: 3500 } as const;

/** Split text for a chat platform: paragraphs first, then lines, then hard cuts. Code fences are closed and reopened. */
export function chunk(text: string, limit: number): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= limit) return [t];
  const out: string[] = [];
  let rest = t;
  let open: Fence | null = null;
  while (rest.length) {
    // A reopened fence costs its opener on top and its closer at the end. When that would eat more
    // than half the room (a tiny limit), the piece goes out without it: a long code block then loses
    // its formatting, never its text, and the loop always moves forward.
    const reopen = open && fenceCost(open) <= limit / 2 ? open : null;
    if (!reopen) open = null;
    const head = prefix(reopen);
    if (head.length + rest.length <= limit) { out.push(head + rest); break; }
    // Room for the closer at the end: "\n```" plus one spare, more when the open fence is longer.
    const room = limit - head.length - Math.max(5, (reopen?.closer.length ?? 0) + 2);
    let cut = rest.lastIndexOf('\n\n', room);
    if (cut < room / 3) cut = rest.lastIndexOf('\n', room);
    if (cut < room / 3) cut = rest.lastIndexOf(' ', room);
    if (cut < room / 3) cut = room;
    // A hard cut inside an emoji leaves a lone surrogate half at the edge; Telegram answers 400 to it.
    if (cut === room && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1;
    cut = Math.max(1, cut);
    // A fence of more than three backticks opened in this piece needs a longer closer: give it room.
    let piece = '', next: Fence | null = null;
    for (;;) {
      next = fenceState(rest.slice(0, cut), open);
      piece = head + rest.slice(0, cut) + (next ? '\n' + next.closer : '');
      if (piece.trim().length <= limit || cut === 1) break;
      cut = Math.max(1, cut - (piece.trim().length - limit));
      if (cut > 1 && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1;
    }
    rest = rest.slice(cut).replace(/^\s+/, '');
    open = next;
    out.push(piece.trim());
  }
  return out;
}

/** An open code fence: the opener to write at the top of the next piece (backticks and a short
 *  language tag, never the rest of the line: a long info string must not eat the room), and the closer. */
interface Fence { opener: string; closer: string }

function fenceCost(f: Fence): number {
  return f.opener.length + 1 + f.closer.length + 1;
}

function prefix(fence: Fence | null): string {
  return fence ? fence.opener + '\n' : '';
}

/** Returns the fence still open at the end of `piece` (given the state at its start). */
function fenceState(piece: string, open: Fence | null): Fence | null {
  let state = open;
  for (const line of piece.split('\n')) {
    const m = /^\s*(`{3,10})(?!`)([\w+#.-]{0,20})/.exec(line);
    if (m) state = state ? null : { opener: m[1] + m[2], closer: m[1] };
  }
  return state;
}
