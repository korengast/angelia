import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTranscripts, placeTranscript, projectFolder, projectsDir, transcriptPath } from '../src/brain/transcripts.js';
import { failureLine, FAILURE_LINE } from '../src/core/deliver/text.js';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function store() {
  const root = mkdtempSync(join(tmpdir(), 'angelia-projects-'));
  const cwd = mkdtempSync(join(tmpdir(), 'angelia-cwd-'));
  return { root, cwd, here: join(root, projectFolder(cwd), `${ID}.jsonl`) };
}

test('the projects folder follows CLAUDE_CONFIG_DIR and the transcript path is the cwd with dashes', () => {
  assert.equal(projectsDir('/Users/example', {}), '/Users/example/.claude/projects');
  assert.equal(projectsDir('/Users/example', { CLAUDE_CONFIG_DIR: '/srv/cc' }), '/srv/cc/projects');
  assert.equal(projectFolder('/nonexistent/a.b/ç'), '-nonexistent-a-b--');
  assert.equal(transcriptPath('/nonexistent/x', ID, '/Users/example'), `/Users/example/.claude/projects/-nonexistent-x/${ID}.jsonl`);
});

test('a transcript already under the cwd folder is left alone', () => {
  const { root, cwd, here } = store();
  mkdirSync(join(root, projectFolder(cwd)), { recursive: true });
  writeFileSync(here, '{"type":"user"}\n');
  assert.deepEqual(placeTranscript(cwd, ID, root), { status: 'here' });
});

test('a transcript that lives under the folder the profile moved out of is copied, with its sidecar, and the source stays', () => {
  const { root, cwd, here } = store();
  const old = join(root, '-Users-example-old-gateway-groups-trader');
  mkdirSync(join(old, ID), { recursive: true });
  writeFileSync(join(old, `${ID}.jsonl`), '{"type":"user"}\n{"type":"assistant"}\n');
  writeFileSync(join(old, ID, 'agent-1.jsonl'), '{}\n');
  // An empty stray file elsewhere never counts as the conversation.
  mkdirSync(join(root, '-somewhere-else'));
  writeFileSync(join(root, '-somewhere-else', `${ID}.jsonl`), '');
  assert.deepEqual(findTranscripts(ID, root), [join(old, `${ID}.jsonl`)]);
  assert.deepEqual(placeTranscript(cwd, ID, root), { status: 'copied', from: join(old, `${ID}.jsonl`) });
  assert.equal(readFileSync(here, 'utf8'), '{"type":"user"}\n{"type":"assistant"}\n');
  assert.ok(existsSync(join(root, projectFolder(cwd), ID, 'agent-1.jsonl')));
  assert.ok(existsSync(join(old, `${ID}.jsonl`)));
  assert.deepEqual(placeTranscript(cwd, ID, root), { status: 'here' });
});

test('two copies elsewhere: the larger one (more of the conversation) is the one placed', () => {
  const { root, cwd, here } = store();
  for (const [dir, body] of [['-a', '{"type":"user"}\n'], ['-b', '{"type":"user"}\n{"type":"assistant"}\n']]) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, `${ID}.jsonl`), body);
  }
  assert.deepEqual(placeTranscript(cwd, ID, root), { status: 'copied', from: join(root, '-b', `${ID}.jsonl`) });
  assert.match(readFileSync(here, 'utf8'), /assistant/);
});

test('a conversation gone from every folder is reported missing, and a missing projects folder is not an error', () => {
  const { root, cwd } = store();
  assert.deepEqual(placeTranscript(cwd, ID, root), { status: 'missing' });
  assert.deepEqual(placeTranscript(cwd, ID, join(root, 'nope')), { status: 'missing' });
});

test('the failure line carries the logged reason, with the home folder as ~, and stays generic without one', () => {
  assert.equal(failureLine(), FAILURE_LINE);
  assert.equal(failureLine('exception'), FAILURE_LINE);
  assert.equal(failureLine('the agent exited while starting (claude in /Users/example/.angelia/workspace/profiles/x; run it there by hand to see why)', '/Users/example'),
    'Something broke on my side (the agent exited while starting (claude in ~/.angelia/workspace/profiles/x; run it there by hand to see why)). Try again, or /new.');
  assert.ok(failureLine('x'.repeat(500)).length < 400);
  assert.equal(failureLine('exit: Error: could not read "my secret plan"'), 'Something broke on my side (exit: Error: could not read "my secret plan"). Try again, or /new.');
  assert.equal(failureLine('exit: Error: could not read "my secret plan"', undefined, true), 'Something broke on my side (the agent exited without answering). Try again, or /new.', 'a group never sees the error output');
  assert.match(failureLine('billing: claude is using apiKeyHelper, not the subscription', undefined, true), /billing/, 'Angelia\'s own reasons still show');
});
