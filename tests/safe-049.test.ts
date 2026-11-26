import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { urlPattern } from '../src/capabilities/compile.js';
import { wireChild } from '../src/brain/brain.js';

// 0.4.9, connector and compile safety: the small carried items (0.4.3 final look, connall reviews).

test('urlPattern: no query, fragment or user:key@ is copied; an address with no path gets /*, never host*', () => {
  assert.equal(urlPattern('https://mcp.tavily.com/mcp/?tavilyApiKey=K'), 'https://mcp.tavily.com/mcp/*');
  assert.equal(urlPattern('https://sse.example.com/s#frag'), 'https://sse.example.com/s*');
  assert.equal(urlPattern('https://x.example.com/mcp'), 'https://x.example.com/mcp', 'nothing cut: as it is');
  assert.equal(urlPattern('https://host.example?k=K'), 'https://host.example/*', 'not https://host.example*, which lets in host.example.evil');
  assert.equal(urlPattern('http://localhost:8080#k'), 'http://localhost:8080/*');
  assert.equal(urlPattern('https://user:KEY@x.example.com/mcp'), 'https://*@x.example.com/mcp');
  assert.equal(urlPattern('https://user:KEY@x.example.com/mcp?k=K'), 'https://*@x.example.com/mcp*');
  assert.equal(urlPattern('https://x.example.com/a@b/mcp'), 'https://x.example.com/a@b/mcp', 'an @ in the path is no user');
});

test('stderr: a blocked-connector warning cut between two chunks is no failure text, and is counted once', () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined }) as any;
  const failures: string[] = [], benign: string[] = [];
  wireChild(child, { exit: () => {}, failure: (t) => failures.push(t), line: () => {}, benign: (l) => benign.push(l) });
  const warn = 'Warning: claude.ai MCP server blocked by enterprise policy: claude.ai Gmail\n';
  for (const c of [warn.slice(0, 20), warn.slice(20)]) child.stderr.emit('data', Buffer.from(c));
  assert.deepEqual(benign, [warn.trim()]);
  assert.equal(failures.at(-1), '', 'once the line is whole it is out of the failure text');
  child.stderr.emit('data', Buffer.from('Error: real trouble\n'));
  assert.equal(failures.at(-1), 'Error: real trouble\n', failures.join(' | '));
});
