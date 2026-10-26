/**
 * Node2Shell (CVE-2026-111497): an out-of-bounds write in Node's Brotli decoder, remote code execution
 * from a response body. The daemon decodes untrusted HTTP all day (Telegram's API through fetch and
 * grammy, WhatsApp media through Baileys), so the runtime under it matters as much as the code.
 * Fixed in 22.23.4, 24.22.1 and 26.12.1; 23, 25 and older lines get no fix. npm's `engines` only
 * warns (EBADENGINE), so the places that can say so check it themselves: update and the daemon's start
 * log a warning, status and check-config print a line. Only install.sh refuses, at the first install;
 * past it, a refusal would not take the daemon off its Node, and would keep Angelia's own fixes out.
 */

/** The versions with the fix, as a person reads them. The same words as the README and install.sh. */
export const NODE_FIX = 'Node 22.23.4+, 24.22.1+ or 26.12.1+';

/**
 * install.sh's rule, read the same way (a test runs both over one table): a major above 26, or 22, 24
 * or 26 at or past its fix. Anything that does not split into numbers is refused, a prerelease of
 * the fix included (`26.12.1-rc.1`): it is not the release that carries the fix.
 */
export function nodeHasFix(version = process.versions.node): boolean {
  const [a, b, c] = version.split('.').map(Number), f = ({ 22: [23, 4], 24: [22, 1], 26: [12, 1] } as Record<number, [number, number] | undefined>)[a];
  return a > 26 || (!!f && (b > f[0] || (b === f[0] && c >= f[1])));
}

/** What is wrong with this Node, or undefined when it has the fix. */
export function nodeFixProblem(version = process.versions.node): string | undefined {
  return nodeHasFix(version) ? undefined : `Node ${version || '(no version)'} is open to CVE-2026-111497 (Node2Shell, remote code execution through the Brotli decoder); ${NODE_FIX} has the fix`;
}
