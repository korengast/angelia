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
 * install.sh's rule, read the same way (a test runs both over one table). Accepted: exactly three
 * dot-separated runs of digits (`^\d+\.\d+\.\d+$`), and then a major above 26, or 22, 24 or 26 at or
 * past its fix. Everything else is refused before the numbers are compared: a prerelease of the fix
 * (`26.12.1-rc.1`, which is not the release that carries it), a leading `v` or space, a short `27`,
 * and what Number() would read as a large major (`Infinity`, `1e2.0.0`).
 */
export function nodeHasFix(version = process.versions.node): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [a, b, c] = version.split('.').map(Number), f = ({ 22: [23, 4], 24: [22, 1], 26: [12, 1] } as Record<number, [number, number] | undefined>)[a];
  return a > 26 || (!!f && (b > f[0] || (b === f[0] && c >= f[1])));
}

/** What is wrong with this Node, or undefined when it has the fix. `path`, when given, says which binary. */
export function nodeFixProblem(version = process.versions.node, path?: string): string | undefined {
  return nodeHasFix(version) ? undefined : `Node ${version || '(no version)'}${path ? ` at ${path}` : ''} is open to CVE-2026-111497 (Node2Shell, remote code execution through the Brotli decoder); ${NODE_FIX} has the fix`;
}

/**
 * Whether a node path stays on one version, so a fixed Node installed later never lands there.
 * stableNode() (service.ts) writes the PATH link into the plist when it resolves to the node that
 * runs, and the real path otherwise: for nvm, fnm, asdf, Volta, Homebrew's Cellar or an unpacked
 * tarball, a folder named after the version (fnm's per-shell links go away besides).
 */
export function versionedNode(path: string): boolean {
  return /\/[^/]*\d+\.\d+\.\d+[^/]*\/|\/fnm_multishells\//.test(path);
}

/** What the owner does about a Node without the fix, when the daemon starts as `path`: a path that
 *  stays on its version needs the plist written again, or launchd keeps starting the old Node. */
export function nodeAdvice(path?: string, service = true): string {
  if (path && versionedNode(path)) return `install a fixed Node, then angelia service install <routing.yaml> so the service starts it (${path} stays on this version)`;
  // Under launchd a restart starts the plist's node; without it, restart reuses the Node it runs on.
  return service ? 'install a fixed Node, then angelia restart' : 'install a fixed Node, then angelia restart from a terminal where it comes first on PATH';
}
