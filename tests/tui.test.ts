import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDirAccepted, addDirDialog, importsAccepted, importsDialogOpen, paneBusy, paneIdle, pasteLanded, permissionDialog, submitPasted, trustAccepted, trustDialogOpen } from '../src/brain/tmux.js';
import { addDirListed, hookSettings, transcriptEvents, transcriptPath } from '../src/brain/tui.js';

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

test('busy is read above the input box: rows under the box (status, one per teammate) never hide the spinner (claude 2.1.329)', () => {
  // A capture of a working pane with one teammate, measured on claude 2.1.329; only the conversation
  // above the spinner was replaced with filler.
  const one = fixture('busy-teammates');
  assert.equal(paneBusy(one), true);
  assert.equal(paneIdle(one), false);
  // The same capture with three more teammate rows added by hand, drawn as the measured one is. The
  // spinner is then more than 14 lines from the end of the screen, which read as idle mid-turn.
  const four = fixture('busy-teammates-4');
  assert.ok(four.trimEnd().split('\n').length - four.split('\n').findIndex((l) => l.startsWith('✶ Synthesizing…')) > 14, 'the fixture has the spinner outside the old foot');
  assert.equal(paneBusy(four), true);
  assert.equal(paneIdle(four), false);
  // Any number of them: nothing under the box is read.
  const many = four.trimEnd() + '\n' + Array.from({ length: 20 }, (_, n) => `  ◯ worker-${n}  More work${' '.repeat(150)}5s · ↓ 1.0k tokens`).join('\n') + '\n';
  assert.equal(paneBusy(many), true);
  // Rows between the spinner and the box do not hide it either (a task list, drawn by hand here).
  const tasks = four.replace(/^(  ⎿\s+Tip: .*)$/m, `$1\n${Array.from({ length: 10 }, (_, n) => `     ☐ Task number ${n}`).join('\n')}`);
  assert.equal(tasks.split('\n').length, four.split('\n').length + 10);
  assert.equal(paneBusy(tasks), true);
  // The turn over, teammates still listed: the spinner row is gone, or redrawn as done.
  const over = four.replace(/^✶ Synthesizing….*\n  ⎿\s+Tip: .*\n/m, '');
  assert.equal(paneBusy(over), false);
  assert.equal(paneIdle(over), true);
  assert.equal(paneIdle(four.replace(/^✶ Synthesizing….*$/m, '✻ Crunched for 4m 44s · done')), true);
});

test('busy above the box: the last spinner row decides, and a row of the conversation is never the spinner', () => {
  const idle = fixture('idle');
  const box = idle.slice(idle.indexOf('─'.repeat(20)));
  // An old answer that opens with a word and "…" sits in the rows above the box: not a running turn.
  assert.equal(paneBusy(`⏺ Hmm… that file is not there.\n\n  It was moved last week.\n\n${box}`), false);
  assert.equal(paneIdle(`⏺ Hmm… that file is not there.\n\n  It was moved last week.\n\n${box}`), true);
  assert.equal(paneBusy(`❯ wait… one more thing\n\n⏺ Yes.\n\n${box}`), false);
  // A spinner row above a later "done" row is history; a spinner row far above the box is scrollback.
  assert.equal(paneBusy(`✻ Wibbling… (2m 2s · ↓ 8k tokens)\n⏺ Answer.\n\n✻ Crunched for 14s · done\n\n${box}`), false);
  assert.equal(paneBusy(`✻ Wibbling… (2m 2s · ↓ 8k tokens)\n${'  a line of an old answer\n'.repeat(30)}\n${box}`), false);
  assert.equal(paneBusy(`✻ Wibbling… (2m 2s · ↓ 8k tokens)\n\n${box}`), true);
  // No input box on screen (a dialog): the foot of the capture decides, as before.
  assert.equal(paneBusy('⏺ Reading.\n\n✽ Actioning…\n'), true);
  assert.equal(paneBusy(`✽ Actioning…\n${'x\n'.repeat(20)}`), false);
});

test('the permission dialog is read from the box, not from the transcript above it', () => {
  const d = permissionDialog(fixture('permission'));
  assert.ok(d);
  assert.equal(d.tool, 'Bash command');
  assert.equal(d.preview, 'Create frames-test.txt file · touch frames-test.txt', 'the dashed rules around the command are not text');
  assert.doesNotMatch(d.preview, /I'll run that command/); // the assistant's own line is not the dialog
  assert.equal(permissionDialog(fixture('idle')), null);
});

test('the trust dialog is recognised and only accepted once the cursor is on yes', () => {
  assert.equal(trustDialogOpen(fixture('trust')), true);
  assert.equal(trustAccepted(fixture('trust')), false); // cursor starts on "No, exit"
  assert.equal(trustAccepted(fixture('trust-selected')), true);
  assert.equal(trustDialogOpen(fixture('idle')), false);
  // A trust frame already answered stays in the history: the dialog below it is the open one.
  assert.equal(trustDialogOpen(fixture('trust-selected') + fixture('adddir')), false, 'a stale trust frame above the add-dir dialog');
  assert.equal(trustAccepted(fixture('trust-selected') + fixture('adddir')), false);
  assert.equal(addDirDialog(fixture('trust-selected') + fixture('adddir')), '/Users/example/.angelia/projects');
  assert.equal(trustDialogOpen(fixture('trust-selected') + fixture('idle')), false, 'nor above the prompt');
  assert.equal(trustDialogOpen(fixture('adddir') + fixture('trust')), true, 'the last dialog is the open one');
});

test('the external-imports dialog (a new profile folder importing _shared) is recognised and accepted only on yes', () => {
  assert.equal(paneIdle(fixture('imports')), false);
  assert.equal(importsDialogOpen(fixture('imports')), true);
  assert.equal(importsAccepted(fixture('imports')), false); // cursor starts on "No, disable external imports"
  assert.equal(importsAccepted(fixture('imports-selected')), true);
  assert.equal(importsDialogOpen(fixture('trust')), false);
  assert.equal(importsDialogOpen(fixture('idle')), false);
  assert.equal(importsDialogOpen(fixture('imports-selected') + fixture('idle')), false, 'a stale imports frame above the prompt');
  assert.equal(importsAccepted(fixture('imports-selected') + fixture('adddir')), false, 'nor above the add-dir dialog');
  assert.equal(trustDialogOpen(fixture('trust-selected') + fixture('imports')), false);
  assert.equal(importsDialogOpen(fixture('trust-selected') + fixture('imports')), true);
});

// The add-dir fixtures are not raw captures: they were written after a real claude 2.1.326 frame, at
// 120 columns (the rule's width), where the panes run at 220, and the folder is a placeholder. In
// pane-adddir-wrapped.txt the folder has the real wrap of a 220-column pane: Ink breaks it at column
// 219 and draws the rest on the next line with the same one-space indent (a capture without -J).
test('the add-dir dialog (claude 2.1.326) names its folder and is accepted only on yes, for a listed folder only', () => {
  assert.equal(paneIdle(fixture('adddir')), false);
  assert.equal(addDirDialog(fixture('adddir')), '/Users/example/.angelia/projects');
  assert.equal(addDirAccepted(fixture('adddir')), false); // cursor starts on "No, exit"
  assert.equal(addDirAccepted(fixture('adddir-selected')), true);
  assert.equal(addDirDialog(fixture('trust')), null);
  assert.equal(addDirDialog(fixture('imports')), null);
  assert.equal(addDirDialog(fixture('idle')), null);
  assert.equal(trustDialogOpen(fixture('adddir')), false, 'not taken for the folder-trust dialog');
  assert.equal(addDirDialog(' Adding a new directory: /tmp/x\n ❯ No, exit\n   Yes, add it\n'), '/tmp/x', 'the folder on the same line');
  assert.equal(addDirDialog(' Adding a new directory:\n /tmp/y\n ❯ No, exit\n   Yes, add it\n'), '/tmp/y', 'the folder on the next line');
  assert.equal(addDirDialog('│ Adding a new directory:  │\n│                         │\n│ /tmp/z                  │\n│ ❯ No, exit │\n│   Yes, add it │\n'), '/tmp/z', 'a bordered frame');
  // Only the dialog at the foot counts: a resumed conversation can quote the dialog for a listed folder.
  const quoted = ' Adding a new directory: /Users/example/.angelia/projects\n   No, exit\n ❯ Yes, add it\n\n';
  assert.equal(addDirDialog(quoted + fixture('adddir')), '/Users/example/.angelia/projects');
  assert.equal(addDirDialog(fixture('adddir').replace('/Users/example/.angelia/projects', '/Users/example/.ssh').replace(/^/, quoted)), '/Users/example/.ssh', 'the real dialog below a quoted one');
  assert.equal(addDirAccepted(quoted + fixture('adddir')), false, 'the quoted yes is not the live cursor');
  assert.equal(addDirDialog(quoted + fixture('idle')), null, 'a quote above the input box is no dialog');
  assert.equal(addDirAccepted(quoted + fixture('idle')), false);
  assert.equal(addDirDialog(' Adding a new directory: /tmp/x\n'), null, 'the title alone, without both answers below it');
  // A folder longer than the pane wraps at column 219 and goes on one space in, as the first line.
  const head = `/Users/example/${'b'.repeat(203)}`;
  assert.equal(addDirDialog(fixture('adddir-wrapped')), `${head}bbbbbbbb/secret`, 'the wrapped lines join into one folder, indent off');
  assert.equal(addDirListed(addDirDialog(fixture('adddir-wrapped'))!, [`${head}bbbbbbbb/secret`]), true, 'a wrapped listed folder is yes');
  assert.equal(addDirListed(addDirDialog(fixture('adddir-wrapped'))!, [head]), false, 'a listed folder that is only the first line is no');
  const spaced = fixture('adddir-wrapped').replace(' bbbbbbbb/secret', '  bbbbbbbb/secret');
  assert.equal(addDirDialog(spaced), `${head} bbbbbbbb/secret`, 'a space at the wrap stays a space');
  assert.equal(addDirListed(addDirDialog(spaced)!, [`${head}bbbbbbbb/secret`]), false, 'so that folder is refused, never yes');
  assert.equal(addDirDialog('│ Adding a new directory:  │\n│                         │\n│ /tmp/z                  │\n│ /more                   │\n│                         │\n│ ❯ No, exit │\n│   Yes, add it │\n'), '/tmp/z/more', 'a bordered frame wraps the same way');
  // A title opens its line: a folder whose name holds a title is still that folder, and refused.
  const evil = '/Users/example/evil/Adding a new directory: /Users/example/.angelia/projects';
  assert.equal(addDirDialog(fixture('adddir').replace('/Users/example/.angelia/projects', evil)), evil);
  assert.equal(addDirListed(evil, ['/Users/example/.angelia/projects']), false);
  const evilImports = fixture('adddir').replace('/Users/example/.angelia/projects', '/Users/example/Allow external CLAUDE.md file imports?');
  assert.equal(addDirDialog(evilImports), '/Users/example/Allow external CLAUDE.md file imports?');
  assert.equal(importsDialogOpen(evilImports + '  ❯ No, disable external imports\n'), false, 'nor is it the imports dialog');
  // An answered frame with another dialog under it: the cursor is that dialog's, so no Enter for it.
  const under = fixture('adddir-selected') + fixture('permission');
  assert.equal(addDirAccepted(under), false, 'the last ❯ is the permission prompt');
  assert.equal(addDirDialog(under), null);
  assert.equal(trustAccepted(fixture('trust-selected') + fixture('permission')), false);
  assert.equal(importsAccepted(fixture('imports-selected') + fixture('permission')), false);
  const dirs = ['/Users/example/.angelia/projects/', '~/code'];
  assert.equal(addDirListed('/Users/example/.angelia/projects', dirs, '/Users/example'), true);
  assert.equal(addDirListed('/Users/example/code', dirs, '/Users/example'), true);
  assert.equal(addDirListed('/Users/example/.ssh', dirs, '/Users/example'), false);
  assert.equal(addDirListed('/Users/example/.angelia', dirs, '/Users/example'), false, 'a parent of a listed folder is not listed');
  assert.equal(addDirListed('', dirs, '/Users/example'), false, 'no folder read is never yes');
  assert.equal(addDirListed(realpathSync(tmpdir()), [tmpdir()]), true, 'the resolved path of a symlinked folder');
  assert.equal(addDirListed('/Users/example/profile/notes', ['notes', '../shared'], '/Users/example', '/Users/example/profile'), true, 'a relative entry is under the profile cwd');
  assert.equal(addDirListed('/Users/example/shared', ['notes', '../shared'], '/Users/example', '/Users/example/profile'), true);
  assert.equal(addDirListed(join(process.cwd(), 'notes'), ['notes'], '/Users/example', '/Users/example/profile'), false, 'not under the daemon cwd');
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

test('the settings file registers one Stop hook and one PermissionRequest hook, which has time to wait for the chat', () => {
  type Hooks = { hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]> };
  const s = hookSettings('/x/hook.mjs', '/x/ask.mjs') as Hooks;
  assert.deepEqual(Object.keys(s.hooks).sort(), ['PermissionRequest', 'Stop']);
  assert.equal(s.hooks.Stop.length, 1);
  assert.match(s.hooks.Stop[0].hooks[0].command, /node "\/x\/hook\.mjs"/);
  assert.equal(s.hooks.PermissionRequest.length, 1);
  assert.match(s.hooks.PermissionRequest[0].hooks[0].command, /node "\/x\/ask\.mjs"/);
  assert.ok(s.hooks.PermissionRequest[0].hooks[0].timeout * 1000 > 11 * 60_000, 'longer than the hook waits for an answer');
  const shipped = hookSettings() as Hooks;
  for (const h of [shipped.hooks.Stop[0], shipped.hooks.PermissionRequest[0]]) assert.ok(existsSync(JSON.parse(h.hooks[0].command.slice('node '.length))), h.hooks[0].command);
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
  assert.match(tmuxWarnings(profiles, 'tmux 3.6a', 'darwin').join(), /tui: true in a, and tmux 3\.6a is older than 3\.7.*brew upgrade tmux/);
  assert.deepEqual(tmuxWarnings(profiles, 'tmux 3.7c'), []);
  assert.deepEqual(tmuxWarnings(profiles, 'tmux next-3.8'), []);
  assert.deepEqual(tmuxWarnings(profiles, 'tmux 4.0'), []);
  assert.match(tmuxWarnings(profiles, null).join(), /tmux is not installed/);
  const linux = tmuxWarnings(profiles, 'tmux 3.4', 'linux').join();
  assert.match(linux, /upgrade tmux to 3\.7\+/); assert.doesNotMatch(linux, /brew/);
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

test('a pasted message is pressed again when a fresh Claude Code drops the Enter; never into a dialog (master, 2026-10-10)', async () => {
  const rule = '─'.repeat(40);
  const box = (line: string) => `⏺ Ready.\n\n${rule}\n❯ ${line}\n${rule}\n  Opus 5·high\n  ⏵⏵ bypass permissions on\n`;
  const pasted = box('[Pasted text #1 +3 lines]');
  const empty = box('');
  const busy = fixture('busy');
  const dialog = fixture('permission');
  const run = async (frames: string[]) => {
    let enters = 0, i = 0;
    const ok = await submitPasted('first line\nsecond\nthird\nfourth', async () => frames[Math.min(i++, frames.length - 1)], async () => { enters++; }, { polls: 2, sleep: async () => {} });
    return { ok, enters };
  };
  assert.deepEqual(await run([pasted, pasted, empty]), { ok: true, enters: 2 }, 'the first Enter was lost: pressed once more, then taken');
  assert.deepEqual(await run([busy]), { ok: true, enters: 1 }, 'taken at once');
  assert.deepEqual(await run([pasted, dialog]), { ok: true, enters: 1 }, 'a dialog opened: never pressed again');
  assert.deepEqual(await run([pasted]), { ok: false, enters: 3 }, 'never taken: three presses, then no');
  assert.deepEqual(await run(['']), { ok: false, enters: 1 }, 'the pane is gone');
});
