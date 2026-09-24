import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, truncateSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractMediaTags, kindOf, mimeOf, resolveMedia, MediaError, MAX_MEDIA_BYTES } from '../src/core/deliver/media.js';

const dir = mkdtempSync(join(tmpdir(), 'angelia-media-'));
const file = (name: string, bytes = 8) => { const p = join(dir, name); writeFileSync(p, Buffer.alloc(bytes, 1)); return p; };

test('media: kind and mime come from the extension, unknown falls back to a document', () => {
  assert.equal(kindOf('/a/b.PNG'), 'image');
  assert.equal(kindOf('/a/b.mov'), 'video');
  assert.equal(kindOf('/a/b.m4a'), 'audio');
  assert.equal(kindOf('/a/b.pdf'), 'document');
  assert.equal(kindOf('/a/b.sqlite'), 'document');
  assert.equal(mimeOf('/a/b.jpeg'), 'image/jpeg');
  assert.equal(mimeOf('/a/b.ogg'), 'audio/ogg; codecs=opus');
  assert.equal(mimeOf('/a/b.sqlite'), 'application/octet-stream');
});

test('media guard: an absolute, real, sized file passes and comes back resolved', () => {
  const p = file('chart.png', 1024);
  const m = resolveMedia({ path: p, caption: 'today' }, 'whatsapp');
  assert.equal(m.kind, 'image');
  assert.equal(m.mime, 'image/png');
  assert.equal(m.bytes, 1024);
  assert.equal(m.fileName, 'chart.png');
  assert.equal(m.caption, 'today');
});

test('media guard: relative, missing, empty, a directory and an oversized file are all refused', () => {
  assert.throws(() => resolveMedia({ path: 'chart.png' }, 'whatsapp'), MediaError);
  assert.throws(() => resolveMedia({ path: join(dir, 'nope.png') }, 'whatsapp'), /no such file/);
  const empty = file('empty.png', 0); truncateSync(empty, 0);
  assert.throws(() => resolveMedia({ path: empty }, 'whatsapp'), /empty file/);
  assert.throws(() => resolveMedia({ path: dir }, 'whatsapp'), /not a file/);
  const big = join(dir, 'big.bin');
  writeFileSync(big, Buffer.alloc(1024));
  truncateSync(big, MAX_MEDIA_BYTES.telegram + 1);
  assert.throws(() => resolveMedia({ path: big }, 'telegram'), /too big/);
  // The same file is fine on the platform with the larger ceiling.
  assert.equal(resolveMedia({ path: big }, 'whatsapp').kind, 'document');
});

test('media guard: credential locations are refused, including through a symlink', () => {
  const deny = (p: string) => assert.throws(() => resolveMedia({ path: p }, 'whatsapp'), /refusing to send|no such file/);
  deny('/etc/passwd');
  deny(join(homedir(), '.ssh', 'id_rsa'));
  deny(file('.env'));
  deny(file('server.pem'));
  deny(file('google_token.json'));
  const secrets = join(dir, 'secrets'); mkdirSync(secrets, { recursive: true });
  const inside = join(secrets, 'card.png'); writeFileSync(inside, Buffer.alloc(8, 1));
  deny(inside);
  const link = join(dir, 'innocent.png');
  symlinkSync(inside, link);
  deny(link);
});

test('media tags: an absolute path with a known extension is pulled out, prose is left alone', () => {
  const r = extractMediaTags('Here is the chart.\n\nMEDIA:/tmp/a b.png\n\nAnd the rest.');
  assert.deepEqual(r.media, [{ path: '/tmp/a b.png' }]);
  assert.equal(r.text, 'Here is the chart.\n\nAnd the rest.');

  assert.deepEqual(extractMediaTags('use MEDIA:<path> to attach').media, []);
  assert.deepEqual(extractMediaTags('MEDIA:report.pdf is relative').media, []);
  assert.deepEqual(extractMediaTags('MEDIA:/tmp/x.sqlite').media, []);
  assert.deepEqual(extractMediaTags('no tag here').text, 'no tag here');

  const two = extractMediaTags('MEDIA:/tmp/a.png\nMEDIA:`/tmp/b c.pdf`\nMEDIA:/tmp/a.png');
  assert.deepEqual(two.media.map((m) => m.path), ['/tmp/a.png', '/tmp/b c.pdf']);
  assert.equal(two.text, '');
});

test('media guard: a profile\'s own files in the instance\'s workspace pass; the instance\'s private state and the credential files the review found do not', async () => {
  const { symlinkSync: link } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'angelia-media-home-'));
  const put = (rel: string) => { const p = join(home, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, Buffer.alloc(8, 1)); return p; };
  const ok = (rel: string) => assert.equal(resolveMedia({ path: put(rel) }, 'whatsapp', { home }).bytes, 8, rel);
  const no = (p: string) => assert.throws(() => resolveMedia({ path: p }, 'whatsapp', { home }), /refusing to send/, p);
  // Every profile lives in the workspace: its own reports and its inbox are its to send.
  ok('.angelia/workspace/profiles/family/report.pdf');
  ok('.angelia/workspace/profiles/family/.inbox/photo.jpg');
  ok('Downloads/invoice.pdf');
  for (const rel of ['.angelia/env', '.angelia/api.token', '.angelia/wa/creds.json', '.angelia/tui/x/turn.json', '.angelia/sessions.json', '.angelia/daemon.log',
    '.config/gh/hosts.yml', '.config/git/credentials', '.zsh_history', '.bash_history', '.pypirc', '.pgpass', '.vault-token', '.cargo/credentials.toml', '.gem/credentials',
    'Library/Cookies/Cookies.binarycookies', 'Library/Messages/chat.db', 'Library/Mail/V10/x.emlx']) no(put(rel));
  // A link from the workspace to the WhatsApp login is followed, then refused.
  const via = join(home, '.angelia', 'workspace', 'profiles', 'family', 'innocent.json');
  link(join(home, '.angelia', 'wa', 'creds.json'), via);
  no(via);
  // A state folder moved elsewhere is guarded where it is.
  const moved = mkdtempSync(join(tmpdir(), 'angelia-media-state-'));
  writeFileSync(join(moved, 'env'), 'x=1');
  assert.throws(() => resolveMedia({ path: join(moved, 'env') }, 'whatsapp', { home, stateDir: moved }), /refusing to send/);
});

test('the file sent is a copy taken at once: a swap under the checked name after that changes nothing, a swap before is refused', async () => {
  const { resolveMedia, snapshotMedia } = await import('../src/core/deliver/media.js');
  const { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'angelia-snap-'));
  const f = join(dir, 'report.pdf');
  writeFileSync(f, 'the real report');
  const m = resolveMedia({ path: f }, 'telegram');
  const snap = snapshotMedia(m);
  writeFileSync(f, 'swapped!');
  assert.equal(readFileSync(snap.media.path, 'utf8'), 'the real report');
  snap.cleanup();
  assert.ok(!existsSync(snap.media.path));
  // Swapped for a link to somewhere else between the check and the copy.
  const m2 = resolveMedia({ path: f }, 'telegram');
  rmSync(f);
  writeFileSync(join(dir, 'secret'), 'x'.repeat(8));
  symlinkSync(join(dir, 'secret'), f);
  assert.throws(() => snapshotMedia(m2), /changed before it could be sent/);
});
