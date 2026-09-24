import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * This repository is meant to be public, and everything in it should be general. The leak that
 * actually happens is not a secret — it is the machine it was written on: a home directory in a
 * captured terminal frame, a developer's name as the example sender, a phone number with a real
 * country code. It was scrubbed once by hand and came back within three days of ordinary work.
 *
 * So the check runs itself, and it names nobody: it asks whether the tree looks like *the machine
 * running the test*, whoever that is. A contributor leaking their own username fails the same way.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The placeholder identity every example in this repo uses. */
const EXAMPLE_USER = 'example';
const EXAMPLE_PHONE_PREFIX = '1555';
const EXAMPLE_GROUP = /^1203630{11}\d@g\.us$/; // 120363 + 12 digits, all placeholder zeros but the last

/**
 * package-lock.json is generated and full of digit strings that look like anything you search for.
 * This file is the only other exception, and it has to be: it contains the counter-examples the
 * detectors are proven against, so scanning it would flag them all. They are fabricated numbers
 * from documentation ranges, and this exemption covers one file by name and nothing else.
 */
const SKIP = new Set(['package-lock.json', 'tests/hygiene.test.ts']);
/** The author's identity belongs in exactly these places. package.json carries the repository URL,
 *  which is where `angelia update` fetches from; npm's own field for it, nothing else there names anyone.
 *  The landing page's build and the reference's by-hand install name the repository, as the README does. */
const MAY_NAME_THE_AUTHOR = new Set(['install.sh', 'allowed_signers', 'LICENSE', 'README.md', 'package.json', 'site/build.mjs', 'docs/reference.md']);
/** Accounts that are not a person: CI runs as "runner", and the word is ordinary English. */
const NOT_A_PERSON = new Set(['runner', 'admin', 'ubuntu', 'root', 'user']);

/**
 * Everything git would carry: committed files *and* new ones that are not ignored. A brand-new file
 * is exactly where a leak is still cheap to fix, and `git ls-files` alone would not see it — as this
 * file proved the moment it was written.
 */
function tracked(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8' });
  return [...new Set(out.split('\n').filter(Boolean))];
}

function read(file: string): string | undefined {
  try {
    const buf = readFileSync(join(repo, file));
    if (buf.includes(0)) return undefined; // binary
    return buf.toString('utf8');
  } catch { return undefined; }
}

/** The detectors, as one function, so they can be proven against known-bad lines below. */
export function problems(file: string, line: string, home: string): string[] {
  const out: string[] = [];
  const user = basename(home);

  if (line.includes(home)) out.push("this machine's home directory");
  for (const m of line.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
    if (m[1] !== EXAMPLE_USER) out.push(`a home directory "${m[1]}" (use /Users/${EXAMPLE_USER})`);
  }
  if (user.length >= 4 && !NOT_A_PERSON.has(user) && !MAY_NAME_THE_AUTHOR.has(file) && new RegExp(user, 'i').test(line)) {
    out.push("the current user's name");
  }
  const phones = [...line.matchAll(/\b(\d{9,15})(?::\d+)?@(?:s\.whatsapp\.net|lid)\b/g),
                  ...line.matchAll(/(?:phone|allow_from|owners)\D{0,12}(\d{9,15})/gi)];
  for (const m of phones) {
    const allSame = /^(\d)\1+$/.test(m[1]); // 1111111…, a stand-in for a LID, not a number
    if (!allSame && !m[1].startsWith(EXAMPLE_PHONE_PREFIX)) out.push(`a phone-shaped id "${m[1]}" (use ${EXAMPLE_PHONE_PREFIX}…)`);
  }
  for (const m of line.matchAll(/\b\d+@g\.us\b/g)) {
    if (!EXAMPLE_GROUP.test(m[0]) && !/^\d@g\.us$/.test(m[0])) out.push(`a real-looking group id "${m[0]}"`);
  }
  // A session link from a real screen capture names a session in someone's claude.ai account.
  for (const m of line.matchAll(/claude\.ai\/code\/session_(\w+)/g)) {
    if (!/^01Example/.test(m[1])) out.push(`a real claude.ai session link "${m[1]}" (use session_01Example…)`);
  }
  return out;
}

test('the detectors catch what they are for, and leave the placeholders alone', () => {
  const home = '/Users/alice';
  const p = (line: string, file = 'src/x.ts') => problems(file, line, home);

  // Caught.
  assert.match(p('const cwd = "/Users/alice/agents/notes";')[0], /home directory/);
  assert.match(p(' * example: /home/bob/probe.txt')[0], /home directory "bob"/);
  assert.ok(p('senderName: "Alice"').some((x) => /current user's name/.test(x)));
  assert.deepEqual(problems('tests/x.ts', "// the test runner's environment", '/Users/runner'), [], 'CI\'s account name is a plain word');
  assert.match(p("const me = '447700900123:12@s.whatsapp.net';")[0], /phone-shaped id "447700900123"/);
  assert.match(p('allow_from: ["31612345678"]')[0], /phone-shaped id "31612345678"/);
  assert.match(p('chat: "120363111222333444@g.us"')[0], /real-looking group id/);
  assert.match(p('Continue at https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQr')[0], /session link/);

  // Left alone: the placeholders this repo uses, and an author line where a name belongs.
  assert.deepEqual(p('touch /Users/example/probe.txt'), []);
  assert.deepEqual(p("const US = ['15550000000:12@s.whatsapp.net', '11111111111111:3@lid'];"), []);
  assert.deepEqual(p('chat: "120363000000000001@g.us"'), []);
  assert.deepEqual(p('Continue at https://claude.ai/code/session_01ExampleExampleExample0'), []);
  assert.deepEqual(p("{ chat: '2@g.us', profile: 'side' }"), []);
  assert.deepEqual(p('Copyright (c) 2026 Alice Smith', 'LICENSE'), []);
});

test('no tracked file is shaped like the machine it was written on', () => {
  const home = homedir();
  const bad: string[] = [];
  for (const file of tracked()) {
    if (SKIP.has(file)) continue;
    const text = read(file);
    if (text === undefined) continue;
    text.split('\n').forEach((line, n) => {
      for (const what of problems(file, line, home)) bad.push(`${file}:${n + 1} has ${what}`);
    });
  }
  assert.deepEqual(bad, [], `\n${bad.join('\n')}\n`);
});

test('junk and personal config can never be committed by accident', () => {
  const files = tracked();
  for (const junk of ['.DS_Store', 'routing.yaml', '.env']) {
    assert.ok(!files.includes(junk), `${junk} is tracked; it must not be`);
  }
  // The example table is the one that may live here, and it must say so.
  assert.ok(files.includes('routing.example.yaml'));
  assert.match(read('routing.example.yaml')!, /THIS IS THE EXAMPLE/);
});

/**
 * Words the detectors above cannot know: a profile name, a brokerage, a bank, a watch brand. They are
 * personal, so the list must not live here; ANGELIA_HYGIENE_WORDS names a file outside the repo, one
 * word per line (# starts a comment). Without it the test is skipped, so a stranger and CI lose nothing.
 * The review notes under docs/review-* describe that residue by shape and never ship.
 */
test('no tracked file holds a word from the private list', (t) => {
  const list = process.env.ANGELIA_HYGIENE_WORDS;
  if (!list) { t.skip('ANGELIA_HYGIENE_WORDS is not set'); return; }
  const words = readFileSync(list, 'utf8').split('\n').map((w) => w.trim()).filter((w) => w && !w.startsWith('#'));
  const bad: string[] = [];
  for (const file of tracked()) {
    if (SKIP.has(file) || file.startsWith('docs/review-')) continue;
    const text = read(file);
    if (text === undefined) continue;
    text.split('\n').forEach((line, n) => {
      for (const w of words) if (line.toLowerCase().includes(w.toLowerCase())) bad.push(`${file}:${n + 1} has "${w}"`);
    });
  }
  assert.deepEqual(bad, [], `\n${bad.join('\n')}\n`);
});
