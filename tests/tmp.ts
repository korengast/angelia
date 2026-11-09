import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A temp folder for one test, removed when the test ends. The prefix names it in the system temp folder. */
export function tmp(t: { after(fn: () => unknown): void }, prefix = 'angelia-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
