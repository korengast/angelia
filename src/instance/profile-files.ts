import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { O_NOFOLLOW_ANY } from '../core/paths.js';

/**
 * What a client of the owner's API (Angelia Desk, the phone app) may see of a profile's folder: its
 * instruction file and its files. One set of rules for every client (plan D18), moved here from Desk:
 * paths stay inside the folder (a link out is refused, not followed), credential names and places are
 * never listed or opened, the profile's own `Read(...)` deny rules hold, and only a little of a file.
 */

/** The most of one file shown; the rest is left out and the answer says so. */
export const FILE_MAX_BYTES = 512 * 1024;
/** The most entries one folder lists. */
export const LIST_MAX = 1000;

/** A request the rules refuse; the message is safe to show. */
export class FileError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * Names never listed or opened, at any depth: env files, key and certificate files, and anything
 * named for a secret, a token, a password or a credential, even when they are the owner's own.
 */
export function secretName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    /^\.env(\.|$)/.test(n) ||
    /\.(pem|key|p12|pfx|keystore|jks|kdbx|gpg|asc)$/.test(n) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(n) ||
    /(secret|token|passw|credential|apikey|api_key)/.test(n) ||
    ['.netrc', '.npmrc', '.pypirc', 'auth.json', '.git-credentials', 'cookies', 'cookies.sqlite'].includes(n)
  );
}

/** Folders left out of a list: version control and dependency trees. */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** True when an absolute, resolved path must not be shown (a credential place, a deny rule). */
export type Hidden = (realPath: string) => boolean;

export interface FileEntry { name: string; kind: 'dir' | 'file' }
export type FileView = { binary: true; size: number } | { binary: false; size: number; text: string; cut: boolean };
export type Instructions = { found: true; file: string; text: string; cut: boolean } | { found: false; file: string; why: string };

/** A relative path from a client, as segments. Never absolute, never `..` or `.`. */
export function segments(rel: string): string[] {
  if (rel.includes('\0') || rel.startsWith('/') || rel.includes('\\')) throw new FileError('not a path inside the profile folder');
  const parts = rel.split('/').filter(Boolean);
  for (const p of parts) {
    if (p === '..' || p === '.') throw new FileError('not a path inside the profile folder');
    if (secretName(p) || SKIP_DIRS.has(p)) throw new FileError('that file is not shown here');
  }
  return parts;
}

/** The real path of `rel` under `folder`, refused when it resolves outside it or to a hidden place. */
function inside(folder: string, rel: string, hidden: Hidden): string {
  let root: string, real: string;
  try { root = realpathSync(folder); } catch { throw new FileError('the profile folder is missing', 404); }
  const parts = segments(rel);
  try { real = realpathSync(join(root, ...parts)); } catch { throw new FileError('no such file or folder', 404); }
  if (real !== root && !real.startsWith(root + sep)) throw new FileError('that path leads outside the profile folder');
  // A link with a plain name can lead to a secret one in the same folder: the target's names count too.
  for (const p of real.slice(root.length).split(sep).filter(Boolean)) if (secretName(p) || SKIP_DIRS.has(p)) throw new FileError('that file is not shown here');
  if (hidden(real)) throw new FileError('that file is not shown here');
  return real;
}

/**
 * Open a checked, resolved path for reading, and keep it the file that was checked. The open follows no
 * link anywhere on the path (O_NOFOLLOW_ANY on macOS; elsewhere the last name), and the file must be the
 * one stat saw before the checks (same device and inode), so swapping a folder for a link between the
 * check and the open fails. Non-blocking, so a named pipe cannot hold the daemon; only a regular file
 * of this user with one name: a hard link can give a credential file a plain name in a plain folder.
 * Returns the open descriptor; the caller closes it.
 */
export function openChecked(real: string, uid: number | undefined = process.getuid?.()): number {
  let before;
  try { before = statSync(real, { bigint: true }); } catch { throw new FileError('no such file', 404); }
  if (!before.isFile()) throw new FileError('not a file');
  let fd: number;
  // macOS refuses O_NOFOLLOW together with O_NOFOLLOW_ANY (EINVAL): the latter covers the last name too.
  const noFollow = O_NOFOLLOW_ANY || constants.O_NOFOLLOW;
  try { fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | noFollow); }
  catch { throw new FileError('that file could not be opened'); }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (st.dev !== before.dev || st.ino !== before.ino) throw new FileError('that file changed while it was read');
    if (!st.isFile()) throw new FileError('not a file');
    if (uid !== undefined && Number(st.uid) !== uid) throw new FileError('that file belongs to another user');
    if (st.nlink > 1n) throw new FileError('a file with more than one name is not shown');
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** The text of an open file: its first FILE_MAX_BYTES, or its size alone when it is binary (a NUL in
 *  its first 8 KiB). */
export function readOpen(fd: number): FileView {
  const size = Number(fstatSync(fd, { bigint: true }).size);
  const take = Math.min(size, FILE_MAX_BYTES);
  const buf = Buffer.alloc(take);
  let got = 0;
  while (got < take) { const n = readSync(fd, buf, got, take - got, got); if (!n) break; got += n; }
  const head = buf.subarray(0, got);
  if (head.subarray(0, 8192).includes(0)) return { binary: true, size };
  return { binary: false, size, text: head.toString('utf8'), cut: size > take };
}

/** The entries of a folder inside the profile folder, folders first, hidden ones left out. */
export function listProfileFolder(folder: string, rel: string, hidden: Hidden): FileEntry[] {
  const real = inside(folder, rel, hidden);
  if (!lstatSync(real).isDirectory()) throw new FileError('not a folder');
  const root = realpathSync(folder);
  // Names first (cheap), in the order shown; the checks, which stat, run only until the list is full.
  const dirents = readdirSync(real, { withFileTypes: true }).filter((d) => !secretName(d.name) && !SKIP_DIRS.has(d.name));
  dirents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  const out: FileEntry[] = [];
  for (const d of dirents) {
    if (out.length >= LIST_MAX) break;
    let target: string;
    try { target = realpathSync(join(real, d.name)); } catch { continue; } // a link to nothing
    // A link that leaves the folder, or leads to a hidden place, is not listed (it could not be opened).
    if (target !== root && !target.startsWith(root + sep)) continue;
    if (target.slice(root.length).split(sep).some((p) => secretName(p) || SKIP_DIRS.has(p))) continue;
    if (hidden(target)) continue;
    let st;
    try { st = statSync(target); } catch { continue; }
    if (st.isDirectory()) out.push({ name: d.name, kind: 'dir' });
    else if (st.isFile()) out.push({ name: d.name, kind: 'file' });
  }
  // A link to a folder sorts as a file until resolved: put folders first again.
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
}

/** The first FILE_MAX_BYTES of a regular file of this user inside the profile folder; a binary file
 *  (a NUL in its first 8 KiB) as its size only. */
export function readProfileFile(folder: string, rel: string, hidden: Hidden, uid: number | undefined = process.getuid?.()): FileView {
  const real = inside(folder, rel, hidden);
  const fd = openChecked(real, uid);
  try { return readOpen(fd); } finally { closeSync(fd); }
}

/** The file a profile's CLI reads first: Claude Code reads CLAUDE.md; Codex, pi and grok read
 *  AGENTS.md when there is one, else CLAUDE.md (Angelia writes its managed block there). */
export function instructionNames(backend: string): string[] {
  return backend === 'claude-code' ? ['CLAUDE.md'] : ['AGENTS.md', 'CLAUDE.md'];
}

/** A profile's instruction file, as `readProfileFile` reads any file (same rules), said plainly
 *  when there is none or it cannot be shown. */
export function readInstructions(folder: string, backend: string, hidden: Hidden, uid: number | undefined = process.getuid?.()): Instructions {
  const names = instructionNames(backend);
  try { realpathSync(folder); } catch { return { found: false, file: names[0], why: 'the profile folder is missing' }; }
  for (const name of names) {
    try { lstatSync(join(folder, name)); } catch { continue; }
    try {
      const v = readProfileFile(folder, name, hidden, uid);
      if (v.binary) return { found: false, file: name, why: `${name} is not text` };
      return { found: true, file: name, text: v.text, cut: v.cut };
    } catch (e) {
      if (e instanceof FileError && e.status === 404) continue; // a link to nothing
      if (e instanceof FileError && /outside/.test(e.message)) return { found: false, file: name, why: `${name} points outside the profile folder` };
      return { found: false, file: name, why: e instanceof FileError ? `${name}: ${e.message}` : `${name} could not be read` };
    }
  }
  return { found: false, file: names[0], why: 'this profile has no instruction file' };
}
