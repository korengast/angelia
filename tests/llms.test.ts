import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('llms.txt names the CLIs the README\'s Backends table supports, and the coming ones as coming', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const table = readme.slice(readme.indexOf('## Backends'), readme.indexOf('## Documentation'));
  const rows = [...table.matchAll(/^\| ([^|]+?) \| [^|]* \| (supported|coming soon) \|/gm)].map((m) => ({ cli: m[1], status: m[2] }));
  assert.ok(rows.length >= 4, 'the Backends table was read');
  const summary = /^> (.*)$/m.exec(readFileSync(join(root, 'site', 'src', 'llms.txt'), 'utf8'))![1];
  const supported = /supported: ([^;)]*)/.exec(summary)?.[1] ?? '';
  const next = /; ([^)]*) next\)/.exec(summary)?.[1] ?? '';
  for (const r of rows) {
    if (r.status === 'supported') assert.ok(supported.includes(r.cli), `${r.cli} is supported in the README; llms.txt says: ${summary}`);
    else assert.ok(next.includes(r.cli) && !supported.includes(r.cli), `${r.cli} is coming soon in the README; llms.txt says: ${summary}`);
  }
});
