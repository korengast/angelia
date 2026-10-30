import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
let out = '';
// One build for every test here, into a temp folder and without the demo videos, so it needs no network.
before(() => {
  out = mkdtempSync(join(tmpdir(), 'angelia-site-'));
  execFileSync(process.execPath, [join(repo, 'site', 'build.mjs'), '--out', out, '--no-media'], { stdio: 'ignore' });
});
after(() => rmSync(out, { recursive: true, force: true }));

const html = (path: string) => readFileSync(join(out, path, 'index.html'), 'utf8');
const one = (text: string, re: RegExp) => re.exec(text)?.[1];
const unescape = (t: string) => t.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const head = (path: string) => {
  const h = html(path);
  return {
    title: unescape(one(h, /<title>([^<]*)<\/title>/) ?? ''),
    og: unescape(one(h, /<meta property="og:title" content="([^"]*)">/) ?? ''),
    h1: unescape((one(h, /<h1[^>]*>([\s\S]*?)<\/h1>/) ?? '').replace(/<[^>]+>/g, '')),
  };
};

test('site build: the pages carry the titles and headings people search for', () => {
  assert.equal(head('').title, 'Angelia: Claude Code on WhatsApp and Telegram');
  assert.equal(head('').og, 'Angelia: Claude Code on WhatsApp and Telegram');
  const want: Record<string, [string, string]> = {
    whatsapp: ['Claude Code on WhatsApp · Angelia', 'Claude Code on WhatsApp'],
    telegram: ['Claude Code Telegram bot · Angelia', 'Claude Code Telegram bot'],
    'claude-code': ['Claude Code on WhatsApp and Telegram: sessions, approvals', 'Claude Code on WhatsApp and Telegram: sessions and approvals from your phone'],
    alternatives: ['Angelia vs OpenClaw, Hermes Agent and Remote Control', 'Angelia vs OpenClaw, Hermes Agent and Claude Code Remote Control'],
  };
  for (const [path, [title, h1]] of Object.entries(want)) {
    const h = head(path);
    assert.equal(h.title, title, `${path}: title`);
    assert.equal(h.h1, h1, `${path}: h1`);
    assert.ok(h.title.length <= 60, `${path}: the title fits in search results`);
    // The share title is the page's title without the brand.
    assert.equal(h.og, title.replace(/ · Angelia$/, ''), `${path}: og:title`);
  }
});
