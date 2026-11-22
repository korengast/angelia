import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
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

/** Linux: a descriptor that names a folder without opening it for reading (asm-generic/fcntl.h, x86-64 and arm64;
 *  Node has no constant for it). A walk needs only search (x) on each folder: with O_RDONLY a parent of mode 0711
 *  (common for /home on shared hosts) would refuse every path below it. `/proc/self/fd/N/<name>` resolves through an
 *  O_PATH descriptor like through any other. */
const O_PATH = 0x200000;

const errno = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * Open `path` (absolute, no `.`, `..` or empty segment) failing with ELOOP if ANY component is a symbolic link, so a link swapped in between a check and the open cannot redirect a write. macOS has one flag for it (O_NOFOLLOW_ANY, never combined with O_NOFOLLOW: EINVAL). Linux has none, so the path is walked from `/` one folder at a time, each opened with O_PATH | O_DIRECTORY | O_NOFOLLOW (search permission only) and the next name resolved through `/proc/self/fd/<dir>` (what `openat` does, with no native addon). Returns the descriptor; the caller closes it.
 */
export function openNoFollow(path: string, flags: number, mode?: number): number {
  const parts = path.split('/').slice(1);
  if (!isAbsolute(path) || parts.some((p) => p === '' || p === '.' || p === '..')) throw errno('EINVAL', `refusing to open ${path}: not an absolute path of plain names`);
  if (process.platform === 'darwin') return openSync(path, flags | O_NOFOLLOW_ANY, mode);
  if (process.platform !== 'linux') throw new Error(`the symlink guard is not implemented on ${process.platform}`);
  if (!existsSync('/proc/self/fd')) throw new Error('the symlink guard needs /proc on Linux');
  const walk = O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let dir = openSync('/', walk);
  try {
    for (const name of parts.slice(0, -1)) {
      const at = `/proc/self/fd/${dir}/${name}`;
      let next: number;
      try { next = openSync(at, walk); }
      catch (e) {
        // O_PATH | O_NOFOLLOW would open the link itself; with O_DIRECTORY that is ENOTDIR (ELOOP on some kernels): both mean a link.
        if ((e as NodeJS.ErrnoException).code === 'ENOTDIR' && lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw errno('ELOOP', `${path}: ${name} is a symbolic link`);
        throw e;
      }
      closeSync(dir); dir = next;
    }
    return openSync(`/proc/self/fd/${dir}/${parts[parts.length - 1]}`, flags | constants.O_NOFOLLOW, mode);
  } finally { closeSync(dir); }
}

/**
 * The text of a plain file the daemon reads from a place an agent can write in (a profile's folder,
 * its settings, agy's gemini dir). Opened non-blocking, so a named pipe planted there cannot hold the
 * daemon (red team, review 3), and read only when fstat says it is a regular file; with `follow: false`
 * a link at the last name is refused too (ELOOP). Throws like readFileSync: ENOENT when missing,
 * EFTYPE when it is not a regular file. At most `max` bytes (default 16 MiB).
 */
export function readPlainText(path: string, o: { follow?: boolean; max?: number } = {}): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (o.follow === false ? constants.O_NOFOLLOW : 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error(`${path} is not a plain file`), { code: 'EFTYPE' });
    const take = Math.min(st.size, o.max ?? 16 * 1024 * 1024);
    const buf = Buffer.alloc(take);
    let got = 0;
    while (got < take) { const n = readSync(fd, buf, got, take - got, got); if (!n) break; got += n; }
    return buf.subarray(0, got).toString('utf8');
  } finally { closeSync(fd); }
}
