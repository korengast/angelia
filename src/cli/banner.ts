/**
 * The banner at the top of `angelia init`: the Desk character (three wing strokes and a body) beside
 * the wordmark, then one line with the version. Static text, at most 64 columns, so it fits a default
 * terminal. Clay on a terminal (24-bit when it says it can, the nearest of 256 colours otherwise), plain
 * with NO_COLOR, and nothing at all when the output is not a terminal: pipes and CI stay clean.
 */
export const BANNER_ART = [
  ' ///   /\\     ┌─┐┌┐┌┌─┐┌─┐┬  ┬┌─┐',
  '///   /oo\\    ├─┤││││ ┬├┤ │  │├─┤',
  '     /____\\   ┴ ┴┘└┘└─┘└─┘┴─┘┴┴ ┴',
];

const CLAY_24 = '\x1b[38;2;208;107;107m';
const CLAY_256 = '\x1b[38;5;174m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export interface BannerTarget {
  isTTY?: boolean;
  env: NodeJS.ProcessEnv;
}

export function banner(version: string, out: BannerTarget): string {
  if (!out.isTTY) return '';
  const tagline = `Angelia ${version} · your coding agent, your personal assistant`;
  if (out.env.NO_COLOR !== undefined && out.env.NO_COLOR !== '') return `${[...BANNER_ART, tagline].join('\n')}\n\n`;
  const truecolor = /^(truecolor|24bit)$/i.test(out.env.COLORTERM ?? '');
  const clay = truecolor ? CLAY_24 : CLAY_256;
  return `${BANNER_ART.map((l) => `${clay}${l}${RESET}`).join('\n')}\n${DIM}${tagline}${RESET}\n\n`;
}
