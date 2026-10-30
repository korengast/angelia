export const LIMITS = { telegram: 4000, whatsapp: 3500 } as const;

/** Split text for a chat platform: paragraphs first, then lines, then hard cuts. Code fences are closed
 *  and reopened; a table cut in two gets its header row and separator row again. */
export function chunk(text: string, limit: number): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= limit) return [t];
  const out: string[] = [];
  let rest = t;
  let open: Fence | null = null;
  let table: Table | null = null;
  while (rest.length) {
    // A reopened fence costs its opener on top and its closer at the end. When that would eat more
    // than half the room (a tiny limit), the piece goes out without it: a long code block then loses
    // its formatting, never its text, and the loop always moves forward.
    const reopen = open && fenceCost(open) <= limit / 2 ? open : null;
    if (!reopen) open = null;
    // The same for a table's two rows: without them the next piece's rows read as a run of bars.
    const again = table && tableCost(table) <= limit / 2 ? table : null;
    if (!again) table = null;
    const head = prefix(reopen) + (again ? again.header + '\n' + again.sep + '\n' : '');
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
    let after = rest.slice(cut).replace(/^\s+/, '');
    // A cut between a table's header row and its separator row would leave the next piece starting
    // with a lone separator: the header row moves over with it, and the repeat below then sees the table.
    const nl = rest.lastIndexOf('\n', cut - 1);
    if (!next && nl > 0 && /^\s*\|/.test(rest.slice(nl + 1, cut)) && SEPARATOR.test(after.slice(0, after.indexOf('\n') < 0 ? after.length : after.indexOf('\n')))) {
      cut = nl;
      piece = head + rest.slice(0, cut);
      after = rest.slice(cut).replace(/^\s+/, '');
    }
    // Only when the cut landed inside the table: a next piece that starts with anything but a row is
    // the text after it, or the rest of a row cut in the middle, which two rows on top would not help.
    table = after.startsWith('|') ? tableAt(rest.slice(0, cut), open, table) : null;
    rest = after;
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

/**
 * Returns the fence still open at the end of `piece` (given the state at its start). CommonMark's
 * rules (#36): a backtick opener's info string holds no backtick, so a line of inline code such as
 * "```x``` is the flag" opens nothing; a closer is at least as long as its opener and carries no info
 * string, so a ``` line inside a ```` block, or a tagged one, is content.
 * Backtick fences only. A tilde fence (~~~) and an indented code block (four spaces) are code in
 * CommonMark too, and are not tracked: the CLIs' answers write code in backtick fences, so a cut
 * inside either of the other two was never seen; one would lose the formatting of that block in the
 * pieces after the cut, never its text.
 */
function fenceState(piece: string, open: Fence | null): Fence | null {
  let state = open;
  for (const line of piece.split('\n')) state = fenceStep(line, state);
  return state;
}

function fenceStep(line: string, state: Fence | null): Fence | null {
  const m = /^\s*(`{3,10})(?!`)(.*)$/.exec(line);
  if (!m) return state;
  const info = m[2].trim();
  if (state) return m[1].length >= state.closer.length && !info ? null : state;
  return info.includes('`') ? null : { opener: m[1] + (/^[\w+#.-]{0,20}/.exec(info)?.[0] ?? ''), closer: m[1] };
}

/** A Markdown table the piece ends inside of: its header row and separator row, to write again on top
 *  of the next piece, as a fence's opener is. */
interface Table { header: string; sep: string }

function tableCost(t: Table): number {
  return t.header.length + 1 + t.sep.length + 1;
}

const SEPARATOR = /^\s*\|\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * The table `piece` ends inside of, given the fence and table in force at its start, or null. A table is
 * a run of lines that start with a bar, the first a header and the second a separator (|---|); the run
 * ends at the first line without a bar. Inside a fence a line is code, whatever it starts with. A GFM
 * table without leading bars (`a | b`) is not tracked: the CLIs rarely write one, and its rows after a
 * cut still read as text.
 */
function tableAt(piece: string, open: Fence | null, table: Table | null): Table | null {
  let fence = open, state = table, header: string | null = null;
  for (const line of piece.split('\n')) {
    const was = fence;
    fence = fenceStep(line, fence);
    if (was || fence || !/^\s*\|/.test(line)) { state = null; header = null; continue; }
    if (state) continue;
    if (header && SEPARATOR.test(line)) { state = { header, sep: line.trim() }; header = null; }
    else header = line.trim();
  }
  return state;
}
