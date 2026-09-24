import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importsAccepted, importsDialogOpen, paneBusy, paneIdle, pasteLanded, permissionDialog, trustAccepted, trustDialogOpen } from '../src/brain/tmux.js';
import { hookSettings, transcriptEvents, transcriptPath } from '../src/brain/tui.js';

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/pane-${name}.txt`, import.meta.url)), 'utf8');

test('pane states come from real Claude Code frames', () => {
  assert.equal(paneIdle(fixture('idle')), true);
  assert.equal(paneBusy(fixture('idle')), false);
  assert.equal(paneBusy(fixture('busy')), true);
  assert.equal(paneIdle(fixture('busy')), false);
  // A dialog shows a prompt-like row too; pasting into it would answer it.
  assert.equal(paneIdle(fixture('permission')), false);
  assert.equal(paneIdle(fixture('trust')), false);
  assert.equal(paneIdle(''), false);
});

test('the permission dialog is read from the box, not from the transcript above it', () => {
  const d = permissionDialog(fixture('permission'));
  assert.ok(d);
  assert.equal(d.tool, 'Bash command');
  assert.match(d.preview, /touch \/Users\/example\/angelia-outside-probe\.txt/);
  assert.doesNotMatch(d.preview, /I'll run that command/); // the assistant's own line is not the dialog
  assert.equal(permissionDialog(fixture('idle')), null);
});

test('the trust dialog is recognised and only accepted once the cursor is on yes', () => {
  assert.equal(trustDialogOpen(fixture('trust')), true);
  assert.equal(trustAccepted(fixture('trust')), false); // cursor starts on "No, exit"
  assert.equal(trustAccepted(fixture('trust-selected')), true);
  assert.equal(trustDialogOpen(fixture('idle')), false);
});

test('the external-imports dialog (a new profile folder importing _shared) is recognised and accepted only on yes', () => {
  assert.equal(paneIdle(fixture('imports')), false);
  assert.equal(importsDialogOpen(fixture('imports')), true);
  assert.equal(importsAccepted(fixture('imports')), false); // cursor starts on "No, disable external imports"
  assert.equal(importsAccepted(fixture('imports-selected')), true);
  assert.equal(importsDialogOpen(fixture('trust')), false);
  assert.equal(importsDialogOpen(fixture('idle')), false);
});

test('a paste is only submitted once it is visible in the box', () => {
  assert.equal(pasteLanded('  ❯ hello there\n', 'hello there'), true);
  assert.equal(pasteLanded('  ❯ [Pasted text +14 lines]\n', 'a very long message'), true);
  assert.equal(pasteLanded('  ❯ \n', 'hello there'), false);
});

test('a paste counts only inside the input box, never on an earlier prompt echoed above it', () => {
  const rule = '─'.repeat(40);
  const pane = (box: string) => `❯ hello there\n\n⏺ Hi.\n\n${rule}\n${box}\n${rule}\n  Opus 5·high\n  ⏵⏵ bypass permissions on\n`;
  assert.equal(pasteLanded(pane('❯ '), 'hello there'), false);
  assert.equal(pasteLanded(pane('❯ hello there'), 'hello there'), true);
  assert.equal(pasteLanded(`[Pasted text +3 lines] earlier\n${rule}\n❯ \n${rule}\n`, 'x'), false);
  assert.equal(pasteLanded(`${rule}\n❯ first line\n  second line\n${rule}\n`, 'first line second line'), true);
  const named = `${rule} trip-planning ─`; // a named session labels the box's top rule
  assert.equal(pasteLanded(`❯ hello there\n${named}\n❯ hello there\n${rule}\n  Fable 5.1·low\n  ⏵⏵ bypass permissions on\n`, 'hello there'), true);
  assert.equal(pasteLanded(`❯ hello there\n${named}\n❯ \n${rule}\n  Fable 5.1·low\n`, 'hello there'), false);
});

test('transcript rows become progress events in order', () => {
  const rows = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'looking' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'user', message: { content: 'result' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
  ].map((r) => JSON.stringify(r)).join('\n');
  assert.deepEqual(transcriptEvents(rows), [{ kind: 'text', text: 'looking' }, { kind: 'tool' }, { kind: 'text', text: 'done' }]);
  assert.deepEqual(transcriptEvents('not json\n'), []);
});

test('transcript path follows Claude Code layout', () => {
  assert.equal(transcriptPath('/Users/example/agents/notes', 'abc', '/Users/example'),
    '/Users/example/.claude/projects/-Users-example-agents-notes/abc.jsonl');
});

test('the stop hook writes the turn answer where the daemon polls for it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'angelia-hook-'));
  const transcript = join(dir, 't.jsonl');
  const marker = join(dir, 'turn.json');
  writeFileSync(transcript, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'first, a look' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    { type: 'user', message: { content: 'tool result' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'the answer' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const hook = fileURLToPath(new URL('../scripts/tui-stop-hook.mjs', import.meta.url));
  execFileSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript, session_id: 's1' }),
    env: { ...process.env, ANGELIA_TUI_MARKER: marker },
  });
  const row = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(row.text, 'the answer'); // the progress line is not repeated
  assert.equal(row.transcript_path, transcript);
  assert.ok(row.at > 0);
});

test('the stop hook keeps out of a session nobody routed', () => {
  const hook = fileURLToPath(new URL('../scripts/tui-stop-hook.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.ANGELIA_TUI_MARKER;
  const out = execFileSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'Stop' }), env, encoding: 'utf8' });
  assert.equal(out, ''); // a session the user started themselves is left alone, and nothing is delivered
});

test('the settings file registers exactly one Stop hook', () => {
  const s = hookSettings('/x/hook.mjs') as { hooks: { Stop: { hooks: { command: string }[] }[] } };
  assert.equal(s.hooks.Stop.length, 1);
  assert.match(s.hooks.Stop[0].hooks[0].command, /node "\/x\/hook\.mjs"/);
});

test('a Stop hook in the user or project settings is named, since --settings merges it with ours', async () => {
  const { tuiHookWarnings } = await import('../src/brain/tui.js');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'angelia-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'angelia-cwd-'));
  const base = { permission_mode: 'acceptEdits', add_dirs: [], backend: 'claude-code' } as any;
  const profiles = { t: { ...base, cwd, tui: true }, p: { ...base, cwd, tui: false } };
  assert.deepEqual(tuiHookWarnings(profiles, home), []);
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  const w = tuiHookWarnings(profiles, home);
  assert.equal(w.length, 1); // print-mode profile p is not warned: no --settings there
  assert.match(w[0], /^profiles\.t: tui: true, and .*settings\.local\.json has a Stop hook/);
});

test('tmux older than 3.7 is a warning for tui profiles, never a refusal; missing tmux is named', async () => {
  const { tmuxWarnings } = await import('../src/brain/tui.js');
  const { Config } = await import('../src/instance/config/schema.js');
  const profiles = Config.parse({ profiles: { a: { cwd: '/tmp/a', tui: true }, b: { cwd: '/tmp/b' } }, routes: [] }).profiles;
  assert.match(tmuxWarnings(profiles, 'tmux 3.6a').join(), /tui: true in a, and tmux 3\.6a is older than 3\.7.*brew upgrade tmux/);
  assert.deepEqual(tmuxWarnings(profiles, 'tmux 3.7c'), []);
  assert.deepEqual(tmuxWarnings(profiles, 'tmux next-3.8'), []);
  assert.deepEqual(tmuxWarnings(profiles, 'tmux 4.0'), []);
  assert.match(tmuxWarnings(profiles, null).join(), /tmux is not installed/);
  assert.deepEqual(tmuxWarnings({ b: profiles.b }, 'tmux 2.9'), [], 'no tui profile, nothing to say');
});

test('idle means the prompt is in the input box: an open dialog with earlier messages above it is not idle', () => {
  const dialog = readFileSync(fileURLToPath(new URL('./fixtures/pane-model-dialog.txt', import.meta.url)), 'utf8');
  // What a used session looks like: earlier prompts echoed with the same ❯ the box uses.
  const scrollback = '❯ [telegram group -100 · Dana (1)] earlier message\n\n⏺ Earlier answer.\n';
  assert.equal(paneIdle(dialog), false);
  assert.equal(paneIdle(scrollback + dialog), false, 'the /model dialog replaced the box; the echo above is not a prompt');
  const idle = readFileSync(fileURLToPath(new URL('./fixtures/pane-idle.txt', import.meta.url)), 'utf8');
  assert.equal(paneIdle(scrollback + idle), true);
  // The agent printing the permission question in its answer does not hold an idle pane busy.
  assert.equal(paneIdle(`⏺ The CLI will ask "Do you want to proceed?" before it runs that.\n${idle}`), true);
  // The older boxed drawing still counts.
  assert.equal(paneIdle('⏺ done\n╭────────────╮\n│ >          │\n╰────────────╯\n  ? for shortcuts'), true);
});

test('the permission dialog is the last one on screen: the agent quoting the question above it is not a prompt', () => {
  const pane = fixture('permission');
  const quoted = `⏺ Next the CLI will ask "Do you want to proceed?" and show the command.\n${pane}`;
  assert.deepEqual(permissionDialog(quoted), permissionDialog(pane));
});

test('tmux mode refuses what print mode refuses: an apiKeyHelper, or a CLI older than the minimum', async () => {
  const { tuiLaunchProblem } = await import('../src/brain/tui.js');
  const { chmodSync, mkdirSync: md } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'angelia-tuicheck-'));
  const home = join(dir, 'home'); md(join(home, '.claude'), { recursive: true });
  const cwd = join(dir, 'p'); md(join(cwd, '.claude'), { recursive: true });
  const bin = (v: string) => { const f = join(dir, `claude-${v}`); writeFileSync(f, `#!/bin/sh\necho "${v} (Claude Code)"\n`); chmodSync(f, 0o755); return f; };
  assert.equal(await tuiLaunchProblem(bin('2.1.280'), cwd, process.env, home), null);
  assert.equal(await tuiLaunchProblem(bin('2.1.100'), cwd, process.env, home), 'version: claude 2.1.100 < 2.1.270');
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ apiKeyHelper: '/usr/local/bin/key' }));
  assert.match((await tuiLaunchProblem(bin('2.1.280'), cwd, process.env, home))!, /^billing: .*settings\.local\.json sets apiKeyHelper/);
});

test('a second permission dialog right after a chat answer is announced; the one just answered is not', async () => {
  const { DialogWatch } = await import('../src/brain/tui.js');
  const w = new DialogWatch();
  const pending = new Set<string>();
  const see = (d: { tool: string; preview: string } | null, now: number) => { const r = w.see(d, (id) => pending.has(id), now); if (r.announce) pending.add(r.announce); if (r.gone) pending.delete(r.gone); return r; };
  const a = { tool: 'Bash', preview: 'ls' }, b = { tool: 'Write', preview: 'notes.md' };
  const first = see(a, 0).announce!;
  assert.ok(first);
  assert.deepEqual(see(a, 700), {}, 'the same dialog, unanswered: nothing new');
  pending.delete(first); // the owner answered yes in the chat
  assert.deepEqual(see(a, 1400), {}, 'the key has not landed yet');
  const second = see(b, 2100).announce;
  assert.ok(second && second !== first, 'the next dialog, never seen without one between');
  pending.delete(second!);
  assert.deepEqual(see(b, 2800), {});
  assert.ok(see(b, 2800 + 3000).announce, 'the same question still up well after the answer: asked again');
  assert.deepEqual(Object.keys(see(null, 9000)), ['gone']);
});
