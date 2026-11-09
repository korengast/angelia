import { SECRET_SHAPES } from '../instance/secrets.js';

/**
 * What the daemon's log never carries on purpose, and masks when a CLI's or a library's error line
 * carries it anyway: a credential shape (the workspace scanner's list, secrets.ts), a Telegram bot token
 * of any shape, a whole JWT, `Bearer <token>`, and a key=value or key: value pair whose key says it is a
 * secret. The value goes, the key stays, so the line still says what failed. A few regexes on a short
 * line: cheap enough to run on every line, the file write and the TTY echo both.
 */
const MASK = '<redacted>';

const SHAPES: RegExp[] = [
  // Before the scanner's shapes, which would take the first two parts of a JWT and leave its signature.
  /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}(?:\.[A-Za-z0-9_-]+)?/g,
  // The scanner's Telegram shape needs the `AA` Telegram tokens start with and a word boundary before
  // the digits; here any token-shaped value goes, in a `/bot<token>/` URL too.
  /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
  ...SECRET_SHAPES.map(([, re]) => new RegExp(re.source, 'g')),
];
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** `token=…`, `api_key: …`, `"password":"…"`, `Authorization: …`: a key that says secret, quoted or not,
 *  then a value of 8+ characters up to a space or a quote. Not `session` (the daemon's own session=<id>
 *  fields, and "could not start the session") and not bare `auth` (auth_dir, unauthorized, OAuth,
 *  author): measured on the live log, those masked what the next debugging needs and nothing secret.
 *  The key may start only after a character outside its own class: \b would try again at every `-` of
 *  a long dashed value, which took 98 ms on an 18 kB line. */
const PAIR = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|authorization|auth[_-]?token|cookie)[A-Za-z0-9_-]*["']?\s*[=:]\s*["']?)([^\s"']{8,})/gi;
/** Past this a line is cut before the regexes run: a log line is short, and a dump that is not stays
 *  cheap to mask. */
const MAX_LINE = 2000;

/** `line` with every credential-shaped value masked. The daemon's own words (`token in`, a chat id, a
 *  commit sha, a session id) stay as they are. */
export function redactLog(line: string): string {
  let out = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} … (line cut at ${MAX_LINE} characters)` : line;
  for (const re of SHAPES) out = out.replace(re, MASK);
  out = out.replace(BEARER, `$1${MASK}`);
  out = out.replace(PAIR, `$1${MASK}`);
  return out;
}
