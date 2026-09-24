import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** `~` and `~/x` under the home folder; anything else unchanged. */
export function expandHome(p: string, home = homedir()): string {
  return p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p;
}

/** True when `path` is `dir` or below it. Compared by path segment, so `profiles-old/x` is not inside `profiles`. */
export function isInside(path: string, dir: string, home = homedir()): boolean {
  const r = relative(resolve(expandHome(dir, home)), resolve(expandHome(path, home)));
  return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
}
