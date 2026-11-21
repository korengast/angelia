import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { AUTO_DENY_MESSAGE } from '../src/core/deliver/text.js';
import { codexRequest, grokRequest, piRequest } from '../src/brain/tool-request.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-claude.mjs');
const dm = (text: string): Inbound => ({ platform: 'telegram', chat: '1', sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [] });

/** One profile `a` on a DM, with these permissions, on the fake Claude Code (it asks for `rm -rf /tmp/x`). */
function rig(permissions: unknown) {
  const cfg = Config.parse({ profiles: { a: { cwd: here, permissions } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000 } });
  const sent: string[] = [], logs: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } } },
    { stateDir: mkdtempSync(join(tmpdir(), 'angelia-levels-')), bins: { 'claude-code': FAKE }, log: (l: string) => logs.push(l) });
  return { o, sent, logs, asked: () => sent.filter((s) => s.includes('🔐')) };
}

/** A brain that asks for each request in turn, then answers; `answers` says what answerPermission returns. */
function fakeBrain(requests: { tool: string; preview: string; request?: { tool: string; input?: unknown } }[], answers = true) {
  const given: { id: string; allow: boolean }[] = [];
  return {
    given,
    brain: {
      name: 'fake', alive: true, lastUsedAt: 0, pendingPermissionCount: 0,
      on() { return this; }, start() {}, kill() {}, async release() {}, async stop() {},
      hasPendingPermission: () => false,
      answerPermission: (id: string, allow: boolean) => { given.push({ id, allow }); return answers; },
      async *turn() {
        let n = 0;
        for (const r of requests) yield { kind: 'permission', id: `abcdef${String(++n).padStart(2, '0')}-0000-4000-8000-000000000000`, ...r };
        yield { kind: 'result', text: 'done', isError: false };
      },
    },
  };
}

test('approve all: the request runs at once, nothing is posted, the log names the default', async (t) => {
  const { o, sent, logs, asked } = rig('approve'); t.after(() => o.shutdown());
  await o.handle(dm('warm up'));
  await o.handle(dm('PERM do it'));
  assert.deepEqual(asked(), []);
  assert.equal(sent.at(-1), 'tool allowed: rm -rf /tmp/x', 'the CLI ran it with its own input');
  assert.ok(logs.includes('permission auto-approved key=telegram:1 tool=Bash by=default approve'), logs.join('\n'));
});

test('ask some: an approve rule passes what it names; anything else is asked', async (t) => {
  const { o, sent, logs, asked } = rig({ default: 'ask', approve: ['Bash(rm -rf /tmp/*)'] }); t.after(() => o.shutdown());
  await o.handle(dm('warm up'));
  await o.handle(dm('PERM do it'));
  assert.deepEqual(asked(), []);
  assert.equal(sent.at(-1), 'tool allowed: rm -rf /tmp/x');
  assert.ok(logs.includes('permission auto-approved key=telegram:1 tool=Bash by=approve: Bash(rm -rf /tmp/*)'), logs.join('\n'));

  const other = rig({ default: 'ask', approve: ['Bash(git status)'] }); t.after(() => other.o.shutdown());
  await other.o.handle(dm('warm up'));
  const p = other.o.handle(dm('PERM do it'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(other.asked().length, 1, 'not named by the rule: asked in the chat');
  const id = /request ([0-9a-f-]+)/.exec(other.sent.at(-1)!)![1];
  await other.o.handle(dm(`yes ${id}`));
  await p;
  assert.equal(other.sent.at(-1), 'tool allowed: rm -rf /tmp/x');
});

test('refuse some: a refuse rule beats an approve default, and the log names the rule', async (t) => {
  const { o, sent, logs, asked } = rig({ default: 'approve', refuse: ['Bash(rm *)'] }); t.after(() => o.shutdown());
  await o.handle(dm('warm up'));
  await o.handle(dm('PERMWHY do it'));
  assert.deepEqual(asked(), []);
  assert.equal(sent.at(-1), `tool denyed: ${AUTO_DENY_MESSAGE}`);
  assert.ok(logs.includes('permission auto-denied key=telegram:1 tool=Bash by=refuse: Bash(rm *)'), logs.join('\n'));
});

test('an ask rule beats an approve default: the chat is asked, and the log names the rule', async (t) => {
  const { o, sent, logs, asked } = rig({ default: 'approve', ask: ['Bash(rm *)'] }); t.after(() => o.shutdown());
  await o.handle(dm('warm up'));
  const p = o.handle(dm('PERM do it'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(asked().length, 1);
  assert.ok(logs.includes('permission asked key=telegram:1 tool=Bash by=ask: Bash(rm *)'), logs.join('\n'));
  const id = /request ([0-9a-f-]+)/.exec(sent.at(-1)!)![1];
  await o.handle(dm(`no ${id}`));
  await p;
  assert.equal(sent.at(-1), 'tool denyed');
});

test('refuse all, written as permissions, refuses like permission_prompts: deny', async (t) => {
  const { o, sent, logs, asked } = rig('refuse'); t.after(() => o.shutdown());
  await o.handle(dm('warm up'));
  await o.handle(dm('PERMWHY do it'));
  assert.deepEqual(asked(), []);
  assert.equal(sent.at(-1), `tool denyed: ${AUTO_DENY_MESSAGE}`);
  assert.ok(logs.includes('permission auto-denied key=telegram:1 tool=Bash by=default refuse'), logs.join('\n'));
});

test('a request the backend cannot name: approve all with refuse rules asks; a refuse default refuses', async (t) => {
  const { o, sent, logs } = rig({ default: 'approve', refuse: ['Bash(rm *)'] }); t.after(() => o.shutdown());
  const brains = (o as unknown as { brains: Map<string, unknown> }).brains;
  const f = fakeBrain([{ tool: 'edit', preview: 'a file change' }]);
  brains.set('telegram:1', f.brain);
  await o.handle(dm('do it'));
  assert.deepEqual(f.given, [], 'neither approved nor refused');
  assert.ok(sent.some((s) => s.includes('🔐')), sent.join(' | '));
  assert.ok(!logs.some((l) => l.startsWith('permission auto-')), logs.join('\n'));

  const r = rig({ default: 'refuse', approve: ['Bash(git status)'] }); t.after(() => r.o.shutdown());
  const g = fakeBrain([{ tool: 'more access, this turn', preview: 'write to a folder' }]);
  (r.o as unknown as { brains: Map<string, unknown> }).brains.set('telegram:1', g.brain);
  await r.o.handle(dm('do it'));
  assert.deepEqual(g.given, [{ id: 'abcdef01-0000-4000-8000-000000000000', allow: false }]);
  assert.ok(r.logs.includes('permission auto-denied key=telegram:1 tool=more access, this turn by=default refuse, rules not checkable on this request'), r.logs.join('\n'));
});

test('codex, grok and pi requests are matched by their shell command or path', async (t) => {
  const { o, logs } = rig({ default: 'ask', refuse: ['Bash(curl *)', 'Read(~/.ssh/**)'], approve: ['Bash(git status)', 'Read(notes/**)'] }); t.after(() => o.shutdown());
  const f = fakeBrain([
    { tool: 'command', preview: '', request: codexRequest('item/commandExecution/requestApproval', { kind: 'command', command: "/bin/zsh -lc 'git status'" }) },
    { tool: 'command', preview: '', request: codexRequest('execCommandApproval', { command: ['bash', '-lc', 'git status && curl x'] }) },
    { tool: 'run_terminal_command', preview: '', request: grokRequest({ kind: 'execute', rawInput: { command: 'git status' }, _meta: { 'x.ai/tool': { name: 'run_terminal_command' } } }) },
    { tool: 'read', preview: '', request: piRequest('read', { path: join(here, 'notes', 'a.md') }) },
  ]);
  (o as unknown as { brains: Map<string, unknown> }).brains.set('telegram:1', f.brain);
  await o.handle(dm('do it'));
  assert.deepEqual(f.given.map((g) => g.allow), [true, false, true, true], logs.join('\n'));
  assert.ok(logs.some((l) => l.endsWith('tool=command by=refuse: Bash(curl *)')), 'the argv joined, quoted: the curl after && is seen');
});

test('the backend mappers: what each request becomes, and what is not named', () => {
  assert.deepEqual(codexRequest('execCommandApproval', { command: ['bash', '-lc', "rm -rf 'a b'"] }), { tool: 'Bash', input: { command: "rm -rf 'a b'" } }, 'the script of bash -lc is what runs');
  assert.deepEqual(codexRequest('execCommandApproval', { command: ['git', 'commit', '-m', "it's"] }), { tool: 'Bash', input: { command: `git commit -m 'it'\\''s'` } });
  assert.deepEqual(grokRequest({ kind: 'execute', rawInput: { command: 'ls' }, _meta: { 'x.ai/tool': { name: 'run_terminal_cmd' } } }), { tool: 'Bash', input: { command: 'ls' } });
  assert.equal(codexRequest('item/commandExecution/requestApproval', { kind: 'writeStdin', command: 'write_stdin --session-id 1 x' }), undefined);
  assert.equal(codexRequest('item/fileChange/requestApproval', {}), undefined);
  assert.equal(codexRequest('item/permissions/requestApproval', {}), undefined);
  assert.equal(grokRequest({ kind: 'read', rawInput: { variant: 'ReadFile' }, _meta: { 'x.ai/tool': { name: 'read_file' } } }), undefined);
  assert.deepEqual(piRequest('bash', { command: 'ls' }), { tool: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(piRequest('find', { path: 'src' }), { tool: 'Glob', input: { file_path: 'src' } });
  assert.equal(piRequest('some_extension_tool', {}), undefined);
});

test('auto-approvals stop at fifty in one turn: the rest is asked', async (t) => {
  const { o, sent, logs } = rig('approve'); t.after(() => o.shutdown());
  const f = fakeBrain(Array.from({ length: 52 }, () => ({ tool: 'Bash', preview: 'ls', request: { tool: 'Bash', input: { command: 'ls' } } })));
  (o as unknown as { brains: Map<string, unknown> }).brains.set('telegram:1', f.brain);
  await o.handle(dm('do it'));
  assert.equal(f.given.length, 50);
  assert.equal(logs.filter((l) => l.startsWith('permission auto-approved key=')).length, 50);
  assert.ok(logs.includes('permission auto-approved 50 times key=telegram:1: the rest of the turn is asked'), logs.join('\n'));
  assert.equal(sent.filter((s) => s.includes('🔐')).length, 2);
});

test('an approval nobody waits for (the tmux hook stepped aside) is asked instead', async (t) => {
  const { o, sent, logs } = rig('approve'); t.after(() => o.shutdown());
  const f = fakeBrain([{ tool: 'Bash', preview: 'make', request: { tool: 'Bash', input: { command: 'make' } } }], false);
  (o as unknown as { brains: Map<string, unknown> }).brains.set('telegram:1', f.brain);
  await o.handle(dm('do it'));
  assert.ok(logs.includes('permission auto-approve failed key=telegram:1 tool=Bash: asked instead'), logs.join('\n'));
  assert.equal(sent.filter((s) => s.includes('🔐')).length, 1);
});

test("a turn another profile asked for is never auto-approved: the chat is asked; the owner's job keeps it", async (t) => {
  const { o, sent, logs, asked } = rig('approve'); t.after(() => o.shutdown());
  await o.handle(dm('warm up'));
  const p = o.injectTurn('telegram:1', 'PERM do it', false, 'telegram:2');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(asked().length, 1, sent.join('\n'));
  assert.ok(logs.some((l) => l.startsWith("permission asked key=telegram:1 tool=Bash by=default approve: a peer's turn")), logs.join('\n'));
  const id = /request ([0-9a-f-]+)/.exec(sent.at(-1)!)![1];
  await o.handle(dm(`no ${id}`));
  await p;
  await o.injectTurn('telegram:1', 'PERM do it', false, undefined, 'job nightly');
  assert.equal(asked().length, 1, 'a job of the owner: approved at once, nobody asked');
  assert.equal(sent.at(-1), 'tool allowed: rm -rf /tmp/x');
});
