import { closeSync, constants, existsSync, lstatSync, openSync } from 'node:fs';
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

/** macOS: fail an open if any part of the path is a symbolic link (sys/fcntl.h, macOS 11+). Linux has no such flag, so `openNoFollow` walks the path instead. */
const O_NOFOLLOW_ANY = 0x20000000;

const errno = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * Open `path` (absolute, no `.`, `..` or empty segment) failing with ELOOP if ANY component is a symbolic link, so a link swapped in between a check and the open cannot redirect a write. macOS has one flag for it (O_NOFOLLOW_ANY, never combined with O_NOFOLLOW: EINVAL). Linux has none, so the path is walked from `/` one folder at a time, each opened with O_DIRECTORY | O_NOFOLLOW and the next name resolved through `/proc/self/fd/<dir>` (what `openat` does, with no native addon). Returns the descriptor; the caller closes it.
 */
export function openNoFollow(path: string, flags: number, mode?: number): number {
  const parts = path.split('/').slice(1);
  if (!isAbsolute(path) || parts.some((p) => p === '' || p === '.' || p === '..')) throw errno('EINVAL', `refusing to open ${path}: not an absolute path of plain names`);
  if (process.platform === 'darwin') return openSync(path, flags | O_NOFOLLOW_ANY, mode);
  if (process.platform !== 'linux') throw new Error(`the symlink guard is not implemented on ${process.platform}`);
  if (!existsSync('/proc/self/fd')) throw new Error('the symlink guard needs /proc on Linux');
  let dir = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const name of parts.slice(0, -1)) {
      const at = `/proc/self/fd/${dir}/${name}`;
      let next: number;
      try { next = openSync(at, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (e) {
        // O_DIRECTORY | O_NOFOLLOW on a link reports ENOTDIR on some kernels, ELOOP on others: both mean a link.
        if ((e as NodeJS.ErrnoException).code === 'ENOTDIR' && lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw errno('ELOOP', `${path}: ${name} is a symbolic link`);
        throw e;
      }
      closeSync(dir); dir = next;
    }
    return openSync(`/proc/self/fd/${dir}/${parts[parts.length - 1]}`, flags | constants.O_NOFOLLOW, mode);
  } finally { closeSync(dir); }
}
