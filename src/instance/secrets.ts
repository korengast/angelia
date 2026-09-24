/**
 * Values shaped like a credential, never keywords: a line that says "token" is documentation, one
 * that holds `ghp_…` is a leak. Only added lines are read, so removing a secret is never blocked.
 */
const SECRET_SHAPES: [string, RegExp][] = [
  ['a private key', /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY/],
  ['an Anthropic or OpenAI key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['an xAI key', /\bxai-[A-Za-z0-9]{20,}/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ['a JWT', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}/],
];

/**
 * What a personal assistant is more likely to write into its memory than an API key: a card number
 * from a checkout, a bank account. Checked by their own arithmetic, so an id that only looks long is
 * not taken for one: a card needs an issuer's prefix and the Luhn digit, an IBAN its mod-97 check.
 * Digits after a decimal point are a number, not a card.
 */
const CHECKED_SHAPES: [string, RegExp, (s: string) => boolean][] = [
  ['a card number', /(?<![\d.,-])(?:\d{4}[ -]){3}\d{1,7}(?![\d-]|[.,]\d)|(?<![\d.,])\d{13,19}(?![\d]|[.,]\d)/g, (s) => {
    const d = s.replace(/\D/g, '');
    return d.length >= 13 && d.length <= 19 && /^(4|5[1-5]|2[2-7]|3[47]|35|6011|65)/.test(d) && luhn(d);
  }],
  ['an IBAN', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, (s) => iban(s.replace(/ /g, ''))],
];

function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

function iban(s: string): boolean {
  if (s.length < 15 || s.length > 34) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let r = 0;
  for (const c of digits) r = (r * 10 + Number(c)) % 97;
  return r === 1;
}

/** A path from a diff header, as git wrote it: quoted, with octal escapes, when it holds a byte
 *  outside ASCII (a Hebrew file name). Taken literally, `git reset -- <name>` would match nothing. */
function diffPath(header: string): string {
  let p = header.slice(4);
  if (p.startsWith('"') && p.endsWith('"')) {
    const bytes: number[] = [];
    const body = p.slice(1, -1);
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i])); continue; }
      const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
      if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; continue; }
      const c = body[++i];
      bytes.push(...Buffer.from(({ n: '\n', t: '\t', '"': '"', '\\': '\\' } as Record<string, string>)[c] ?? c));
    }
    p = Buffer.from(bytes).toString('utf8');
  }
  return p.replace(/^b\//, '');
}

/** Each added line in a unified diff that holds a secret-shaped value, as `file: what`. Never the value. */
export function secretFindings(diff: string): string[] {
  const out: string[] = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { file = diffPath(line); continue; }
    if (!line.startsWith('+')) continue;
    for (const [what, re] of SECRET_SHAPES) if (re.test(line)) out.push(`${file}: ${what}`);
    for (const [what, re, ok] of CHECKED_SHAPES) if ([...line.matchAll(re)].some((m) => ok(m[0]))) out.push(`${file}: ${what}`);
  }
  return [...new Set(out)];
}
