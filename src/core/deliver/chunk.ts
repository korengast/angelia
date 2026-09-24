export const LIMITS = { telegram: 4000, whatsapp: 3500 } as const;

/** Split text for a chat platform: paragraphs first, then lines, then hard cuts. Code fences are closed and reopened. */
export function chunk(text: string, limit: number): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= limit) return [t];
  const out: string[] = [];
  let rest = t;
  let openFence: string | null = null;
  while (rest.length) {
    if (rest.length <= limit) { out.push(prefix(openFence) + rest); break; }
    const room = limit - (openFence ? openFence.length + 1 : 0) - 5; // 5 = "\n```" closer margin
    let cut = rest.lastIndexOf('\n\n', room);
    if (cut < room / 3) cut = rest.lastIndexOf('\n', room);
    if (cut < room / 3) cut = rest.lastIndexOf(' ', room);
    if (cut < room / 3) cut = room;
    // A hard cut inside an emoji leaves a lone surrogate half at the edge; Telegram answers 400 to it.
    if (cut === room && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1;
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\s+/, '');
    const fenceBefore = openFence;
    openFence = fenceState(piece, openFence);
    piece = prefix(fenceBefore) + piece + (openFence ? '\n```' : '');
    out.push(piece.trim());
  }
  return out;
}

function prefix(fence: string | null): string {
  return fence ? fence + '\n' : '';
}

/** Returns the fence line still open at the end of `piece` (given the state at its start). */
function fenceState(piece: string, open: string | null): string | null {
  let state = open;
  for (const line of piece.split('\n')) {
    if (/^\s*```/.test(line)) state = state ? null : line.trim();
  }
  return state;
}
