// A test file whose one test passes but leaves a child running that ends only on stdin EOF, as fake agy
// does when a test fails before its stop(). Run by tests/test-runner-exit.test.ts, never by `npm test`.
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
test('passes, and leaves a child running', () => {
  const c = spawn('/bin/cat', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  if (process.env.LEAK_PID_FILE) writeFileSync(process.env.LEAK_PID_FILE, String(c.pid));
});
