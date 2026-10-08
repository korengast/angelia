import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep, basename } from 'node:path';
import type { Platform } from '../types.js';
import { HOME_PRIVATE, STATE_LOGS, STATE_PRIVATE } from '../../instance/instance.js';
import { fold, parseRules, under } from '../../brain/pi-gate.js';

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

/** What a caller asked to send, before the path is checked. */
export interface MediaRequest {
  path: string;
  caption?: string;
  /** Audio only: send as a voice bubble (default). `false` sends it as a plain file. */
  voice?: boolean;
  /** Document only: the name shown in the chat. Defaults to the file's own name. */
  fileName?: string;
}

/** A request that passed the guard: safe to hand to an adapter. */
export interface Media extends MediaRequest {
  path: string;
  kind: MediaKind;
  mime: string;
  bytes: number;
  fileName: string;
}

/** Bot-side limits. Telegram's Bot API refuses over 50 MB; WhatsApp is far higher, but we read files into the socket. */
export const MAX_MEDIA_BYTES: Record<Platform, number> = { whatsapp: 64 * 1024 * 1024, telegram: 50 * 1024 * 1024 };

const IMAGE = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const VIDEO = ['mp4', 'mov', 'm4v', 'avi', 'mkv', '3gp', 'webm'];
const AUDIO = ['ogg', 'opus', 'oga', 'mp3', 'm4a', 'wav', 'aac', 'flac'];

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', avi: 'video/x-msvideo', mkv: 'video/x-matroska', '3gp': 'video/3gpp', webm: 'video/webm',
  ogg: 'audio/ogg; codecs=opus', opus: 'audio/ogg; codecs=opus', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', flac: 'audio/flac',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  zip: 'application/zip', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Extensions a `MEDIA:` tag may name. A bare word after the tag is never a path. */
export const TAG_EXTS = [...IMAGE, ...VIDEO, ...AUDIO, 'pdf', 'txt', 'md', 'csv', 'json', 'zip', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];

export function ext(path: string): string {
  return (path.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1]) ?? '';
}

export function kindOf(path: string): MediaKind {
  const e = ext(path);
  if (IMAGE.includes(e)) return 'image';
  if (VIDEO.includes(e)) return 'video';
  if (AUDIO.includes(e)) return 'audio';
  return 'document';
}

export function mimeOf(path: string): string {
  return MIME[ext(path)] ?? 'application/octet-stream';
}

export function isOpus(path: string): boolean {
  return ['ogg', 'opus'].includes(ext(path));
}

/**
 * Places a file may never come from, however the path is spelled. Symlinks are resolved first, so a
 * link planted inside an allowed folder does not help. It guards attachments only: an agent that can
 * read a secret can also put it in its reply as text, which no check here sees. So this stops the
 * cheap mistake (a model talked into attaching a key file), not a determined one.
 *
 * A denylist and not an allowlist on purpose: "send me the PDF in my Downloads" is the job of a
 * personal assistant. The instance's own folder is not denied as a whole, since every profile lives
 * in its workspace; its private state files are (STATE_PRIVATE).
 *
 * The daemon reads the file, outside every agent's sandbox and deny rules. So a request an agent made
 * also carries that profile's own deny rules (`deny`), and the file must be one its file tools may
 * read: another profile's folder stays out of reach, as it is for the agent itself.
 */
const DENY_DIRS = ['/etc', '/proc', '/sys', '/dev', '/var/db', '/private/etc', '/private/var/db'];
const DENY_HOME_DIRS = [...HOME_PRIVATE.dirs, '.claude', '.grok', '.pi', '.codex', '.config/git', 'Library/Application Support', 'Library/Containers', 'Library/Group Containers'];
const DENY_SEGMENTS = ['secrets', '.secrets', 'credentials', 'keychains', '.gnupg', '.ssh'];
const DENY_NAMES = /^(\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.vault-token|\.git-credentials|\.[a-z]*_history|credentials(\.toml)?|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|keystore|jks)|.*token.*\.json|auth\.json|.*credentials.*\.json)$/i;

export class MediaError extends Error {}

export interface MediaWhere {
  home?: string;
  stateDir?: string;
  /** The asking agent's deny rules (compile.ts, agentDenyRules); its `Read(...)` rules bind the send too.
   *  Absent when the owner asked. */
  deny?: string[];
}

/**
 * Check a path a caller (agent, script, cron launcher) asked to send. Absolute only, symlinks
 * resolved, a real file, inside the platform's size limit, not from a credential location, and not
 * from where the asking agent's deny rules keep its file tools out.
 * Throws `MediaError` with a line that is safe to show in the chat.
 */
export function resolveMedia(req: MediaRequest, platform: Platform, where: MediaWhere = {}): Media {
  const home = where.home ?? homedir();
  const raw = (req.path ?? '').trim().replace(/^[`"']|[`"',.;:)\]}]+$/g, '').trim();
  if (!raw) throw new MediaError('no file path');
  const expanded = raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) throw new MediaError(`not an absolute path: ${short(raw)}`);
  let path: string;
  // The name as the disk holds it. The JavaScript realpath keeps the caller's spelling, and on a
  // case-insensitive disk `~/.ANGELIA/ENV` is the env file.
  try { path = realpathSync.native(resolve(expanded)); } catch { throw new MediaError(`no such file: ${short(raw)}`); }
  if (denied(path, home, where.stateDir)) throw new MediaError(`refusing to send from that location: ${short(raw)}`);
  if (where.deny && parseRules(where.deny, home).some((r) => r.tool === 'Read' && r.test(path))) throw new MediaError(`this profile may not read that file: ${short(raw)}`);
  let st;
  try { st = statSync(path); } catch { throw new MediaError(`no such file: ${short(raw)}`); }
  if (!st.isFile()) throw new MediaError(`not a file: ${short(raw)}`);
  if (st.size === 0) throw new MediaError(`empty file: ${short(raw)}`);
  const cap = MAX_MEDIA_BYTES[platform];
  if (st.size > cap) throw new MediaError(`too big for ${platform}: ${Math.round(st.size / 1e6)} MB, limit ${Math.round(cap / 1e6)} MB`);
  return {
    ...req,
    path,
    kind: kindOf(path),
    mime: mimeOf(path),
    bytes: st.size,
    fileName: req.fileName?.replace(/[/\\]/g, '') || basename(path),
  };
}

/**
 * Where a file came from, when what is read is a copy of it (the desk app copies a dropped file, since
 * the daemon may not read the folder it was in). The place is held to the same rules as a file sent
 * directly; resolved as far as this process can see it.
 */
export function assertOrigin(from: string, where: MediaWhere = {}): void {
  if (!isAbsolute(from)) throw new MediaError(`not an absolute path: ${short(from)}`);
  if (denied(real(from), where.home ?? homedir(), where.stateDir)) throw new MediaError(`refusing to send from that location: ${short(from)}`);
}

/**
 * A private copy of a checked file, taken at once, which is what the adapter sends. The send may wait
 * for the rate limit, and an agent that controls the folder could swap the file under the checked
 * name in that time. The file is opened without following a link, must still be the file that was
 * checked, and is copied from that open descriptor. `cleanup` removes the copy.
 */
export function snapshotMedia(m: Media): { media: Media; cleanup(): void } {
  let fd: number;
  try { fd = openSync(m.path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new MediaError(`the file changed before it could be sent: ${short(m.path)}`); }
  const dir = mkdtempSync(join(tmpdir(), 'angelia-send-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== m.bytes || realpathSync.native(m.path) !== m.path) throw new MediaError(`the file changed before it could be sent: ${short(m.path)}`);
    const copy = join(dir, basename(m.path));
    const out = openSync(copy, 'wx', 0o600);
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) writeSync(out, buf, 0, n);
    } finally { closeSync(out); }
    return { media: { ...m, path: copy }, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally { closeSync(fd); }
}

/** A folder as the file system names it, so a check against a realpath'd file cannot be sidestepped
 *  by a symlink in the folder's own path (/tmp is /private/tmp on macOS). */
const real = (p: string): string => { try { return realpathSync.native(p); } catch { return resolve(p); } };

/** By file identity (`under`), so a hard link to the env file counts as the env file, and by folded
 *  text, so another case or normalisation of a name does not get past. */
function denied(path: string, home: string, stateDir?: string): boolean {
  // The state folder at its default place and wherever ANGELIA_STATE_DIR moved it.
  const states = [...new Set([join(home, '.angelia'), ...(stateDir ? [stateDir] : []), ...(process.env.ANGELIA_STATE_DIR ? [process.env.ANGELIA_STATE_DIR] : [])].map(real))];
  const privateState = states.flatMap((s) => [...STATE_PRIVATE.files, ...STATE_PRIVATE.dirs, ...STATE_LOGS].map((f) => join(s, f)));
  const all = [...DENY_DIRS, ...DENY_HOME_DIRS.map((d) => real(join(home, d))), ...privateState];
  if (all.some((d) => under(path, d))) return true;
  const parts = path.split(sep);
  if (parts.slice(0, -1).some((p) => DENY_SEGMENTS.includes(fold(p).toLowerCase()))) return true;
  return DENY_NAMES.test(fold(parts[parts.length - 1]));
}

function short(p: string): string {
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = p.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, '');
  return clean.length > 120 ? clean.slice(0, 117) + '…' : clean;
}

/**
 * `MEDIA:<absolute path>` lines, a convention many agents' instructions already use.
 * Anchored like the gateway's: the path must be absolute and end in a known extension, so a bare
 * "MEDIA:" in prose, or a relative example, is left alone as text.
 */
const TAG_RE = new RegExp(
  String.raw`[\`"']?MEDIA:[ \t]*` +
  // A path is at most PATH_MAX (1024 on macOS): the bound keeps a line of many "MEDIA:/" from making
  // each one scan to the end of the line (quadratic: 256 KB took seconds on the daemon's thread).
  String.raw`(?<path>\`[^\`\n]{1,1024}\`|"[^"\n]{1,1024}"|'[^'\n]{1,1024}'|(?:~/|/)[^\n]{0,1024}?\.(?:${TAG_EXTS.join('|')}))` +
  String.raw`(?=[\s\`"',;:)\]}]|$)[\`"']?`,
  'gi',
);

export interface TaggedText { text: string; media: MediaRequest[] }

/** Split `MEDIA:` tags out of a block of text. The remaining text keeps its shape, minus the tags. */
export function extractMediaTags(input: string): TaggedText {
  if (!input.includes('MEDIA:')) return { text: input, media: [] };
  const media: MediaRequest[] = [];
  const seen = new Set<string>();
  const text = input.replace(TAG_RE, (_m, ...rest) => {
    const groups = rest[rest.length - 1] as { path: string };
    const p = groups.path.replace(/^[`"']|[`"']$/g, '').trim();
    if (p && !seen.has(p)) { seen.add(p); media.push({ path: p }); }
    return '';
  });
  return { text: tidy(text), media };
}

/** Remove the blank lines a stripped tag leaves behind, without reflowing the rest. */
function tidy(text: string): string {
  return text.split('\n').filter((l, n, a) => l.trim() !== '' || (n > 0 && a[n - 1].trim() !== '')).join('\n').trim();
}
