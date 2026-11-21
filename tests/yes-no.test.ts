import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { Orchestrator, type OrchestratorOptions } from '../src/core/orchestrator.js';
import { LATE_ANSWER_LINE, NOT_OWNER_LINE, READ_FIRST_LINE, afterCloseLine, answeredLine, followsCloseLine, parseBareAnswer, parsePermissionReply, permissionLine, pressedText, whichOneLine } from '../src/core/deliver/text.js';
import type { Inbound } from '../src/core/types.js';
import { asker, openAsks } from './asker.js';

/**
 * A permission request answered with a bare "yes" or "no": taken only where it cannot land on another
 * request, or on a request at all when it was said to a person. The adapters' side of it (what a reply
 * and a mention are, the buttons) is in whatsapp-adapter.test.ts and telegram.test.ts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-claude.mjs');
const A = 'aaaa1111-0000-4000-8000-000000000001', B = 'bbbb2222-0000-4000-8000-000000000002';
const ASK_A = { id: A, tool: 'Bash', preview: 'touch aaaa' }, ASK_B = { id: B, tool: 'Bash', preview: 'touch bbbb' };
const LINE_A = permissionLine(A, 'Bash', 'touch aaaa'), LINE_B = permissionLine(B, 'Bash', 'touch bbbb');
const DM = 'telegram:1', GROUP = 'whatsapp:g@g.us', OPEN = 'whatsapp:open@g.us';
/** The wait these tests use in place of the three seconds. */
const MIN = 40;

/** `people`: who the platform says is in each group (none: it cannot say). Every send gets a message id, as a real one does. */
function setup(opts: OrchestratorOptions = {}, people: Record<string, string[]> = {}) {
  const cfg = Config.parse({
    profiles: { a: { cwd: here } },
    routes: [
      { platform: 'telegram', chat: 1, profile: 'a' },
      { platform: 'whatsapp', chat: 'g@g.us', profile: 'a', mention: 'required', owners: ['u1'], allow_from: ['*'] },
      { platform: 'whatsapp', chat: 'open@g.us', profile: 'a', mention: 'any', owners: ['u1'], allow_from: ['*'] },
    ],
    defaults: { max_out_per_min: 1000 },
  });
  const sent: string[] = [], logs: string[] = [], ids = new Map<string, string>();
  let n = 0;
  const sender = {
    send: async (_chat: string, text: string) => { sent.push(text); const id = `m${++n}`; ids.set(text, id); return { id }; },
    people: async (chat: string) => people[chat],
  };
  const o = new Orchestrator(cfg, { telegram: sender, whatsapp: sender },
    { stateDir: mkdtempSync(join(tmpdir(), 'angelia-yesno-')), bins: { 'claude-code': FAKE }, bareAnswerMinMs: MIN, log: (l) => logs.push(l), ...opts });
  /** A reply to the message that carried this text, as an adapter would report it. */
  const replyTo = (text: string, ours = true): Partial<Inbound> => ({ quoted: text, reply: { id: ids.get(text)!, ours } });
  return { o, sent, logs, ids, replyTo };
}
// Every message has its platform's time, as the live adapters give it: a bare word without one is not taken.
const dm = (text: string, extra: Partial<Inbound> = {}): Inbound => ({ platform: 'telegram', chat: '1', sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [], at: Date.now(), ...extra });
/** In the group that hears only what names the bot: `@bot` typed, as the adapter reports it. */
const grp = (text: string, sender = 'u1', extra: Partial<Inbound> = {}): Inbound => ({ ...dm(`@bot ${text}`), platform: 'whatsapp', chat: 'g@g.us', isGroup: true, mentioned: true, botMentions: ['@bot'], sender, ...extra });
/** In the group that hears everything (mention: any): nothing names the bot. */
const any = (text: string, sender = 'u1', extra: Partial<Inbound> = {}): Inbound => ({ ...dm(text), platform: 'whatsapp', chat: 'open@g.us', isGroup: true, sender, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(5); }
}
/** A turn that asks for these requests, once their lines are in the chat and have been there for `wait` ms. */
async function ask(o: Orchestrator, sent: string[], i: Inbound, ids: string[], wait = MIN + 30): Promise<{ done: Promise<void> }> {
  const done = o.handle({ ...i, text: `ASK:${ids.join(',')}` });
  await until(() => ids.every((id) => sent.includes(permissionLine(id, 'Bash', `touch ${id.slice(0, 4)}`))), 'the request lines');
  await sleep(wait);
  // In an object: an async function that returned the turn's promise itself would wait for the turn.
  return { done };
}

test('the words: yes, no, y, n, כן, לא alone, any case, a full stop or exclamation mark after; only the bot\'s own mention may stand beside one', () => {
  for (const [said, allow] of [['yes', true], ['Yes', true], ['YES!', true], ['y', true], ['Y.', true], ['כן', true], ['כן!', true], [' yes ', true],
    ['no', false], ['No.', false], ['N', false], ['n!', false], ['לא', false], ['לא.', false]] as const) assert.equal(parseBareAnswer(said), allow, said);
  for (const said of ['yes please', 'no thanks', 'yes?', 'yes,', 'yess', 'ok', 'כן בבקשה', 'לא תודה', '', 'yes d640cc6a', 'no 12345@s.whatsapp.net', 'yes me@example.com', 'y y']) assert.equal(parseBareAnswer(said), null, said);
  // The bot's own @name, as the adapter read it in this message, and nobody else's.
  const bot = ['@Angelia_bot', '@15550000000'];
  for (const [said, allow] of [['@Angelia_bot yes', true], ['yes @angelia_BOT', true], ['כן @15550000000', true], ['@15550000000 no.', false], ['no @Angelia_bot.', false]] as const) assert.equal(parseBareAnswer(said, bot), allow, said);
  for (const said of ['@972500000001 כן', 'yes @972500000001', '@ann yes', '@Angelia_bot @ann yes', '@Angelia_botx yes']) assert.equal(parseBareAnswer(said, bot), null, `${said}: said to someone else`);
  assert.equal(parseBareAnswer('@972500000001 כן'), null, 'no mention is stripped that the adapter did not name as the bot\'s');
  // With an id it is the other parser's, as before: the id names the request, so any mention may ride along.
  assert.deepEqual(parsePermissionReply('yes d640cc6a @972501234567'), { id: 'd640cc6a', allow: true });
  assert.equal(parsePermissionReply('yes'), null);
});

test('the lines: the request asks for yes or no and names itself last; which one, what a bare answer was taken for, what a press says, after a request ended', () => {
  assert.equal(permissionLine('d640cc6a-1111-4222-8333-444444444444', 'Bash', 'touch x'), '🔐 Bash: touch x\nReply "yes" or "no". (request d640cc6a)');
  assert.equal(whichOneLine([ASK_A, { id: B, tool: 'Write', preview: `${'x'.repeat(70)}\nmore` }]),
    `Which one? 2 requests are waiting:\naaaa1111 Bash: touch aaaa\nbbbb2222 Write: ${'x'.repeat(60)}…\nAnswer "yes <id>" or "no <id>", or reply to the request's own message.`);
  assert.equal(answeredLine(true, ASK_A), 'Allowed: Bash: touch aaaa (request aaaa1111)');
  assert.equal(answeredLine(false, { id: B, tool: 'Write', preview: `${'x'.repeat(70)}\nmore` }), `Denied: Write: ${'x'.repeat(60)}… (request bbbb2222)`);
  assert.equal(pressedText(true, ASK_A), 'Allowed: Bash: touch aaaa');
  assert.ok(pressedText(false, { tool: 'Bash', preview: 'x'.repeat(5000) }).length <= 200, 'a press\'s answer fits the Bot API\'s 200 characters');
  assert.match(afterCloseLine(true, false), /^A request in this chat ended a moment ago, so "yes" or "no" alone is not taken for a few minutes\. Reply to the open request's own message or answer with its id/);
  assert.match(afterCloseLine(true, true), /press its button/);
  assert.match(afterCloseLine(false, true), /^Too late: that request is no longer waiting, and your word was not passed to the agent\./);
  assert.match(followsCloseLine(false), /^Another request in this chat ended without an answer around the time this one was asked, so "yes" or "no" alone is not taken for it\. Reply to the request's own message or answer with its id/);
  assert.match(followsCloseLine(true), /press its button/);
});

test('one request open in a private chat: a bare yes, no, y, n, כן or לא answers it, the chat is told what it was taken for, and the word never reaches the agent', async (t) => {
  const { o, sent } = setup(); t.after(() => o.shutdown());
  const f = asker(o, DM);
  for (const [said, allow] of [['yes', true], ['no', false], ['Y', true], ['n', false], ['כן', true], ['לא', false], ['Yes.', true], ['לא!', false]] as const) {
    sent.length = 0; f.answers.length = 0; f.turns.length = 0;
    const turn = await ask(o, sent, dm(''), [A]);
    await o.handle(dm(said));
    await turn.done;
    assert.deepEqual(f.answers, [[A, allow]], said);
    assert.deepEqual(sent.toSorted(), [LINE_A, answeredLine(allow, ASK_A), `done: aaaa=${allow ? 'yes' : 'no'}`].toSorted(), said);
    assert.equal(f.turns.length, 1, `${said}: no turn of its own`);
    assert.deepEqual(openAsks(o, DM), []);
  }
});

test('one request open, the real CLI path: yes lets the tool run, לא refuses it, and the clients hear who answered', async (t) => {
  const { o, sent } = setup(); t.after(() => o.shutdown());
  const events: { type: string; by?: string; allow?: boolean }[] = [];
  o.onEvent((e) => { if (e.type === 'permission-answered') events.push({ type: e.type, by: e.by, allow: e.allow }); });
  for (const [said, answer, receipt] of [['yes', 'tool allowed: rm -rf /tmp/x', 'Allowed: Bash: rm -rf /tmp/x (request 6b480a6f)'], ['לא', 'tool denyed', 'Denied: Bash: rm -rf /tmp/x (request 6b480a6f)']] as const) {
    sent.length = 0;
    const turn = o.handle(dm('PERM do it'));
    await until(() => /\(request [0-9a-f]{8}\)$/.test(sent.at(-1) ?? ''), 'the request line');
    assert.match(sent.at(-1)!, /^🔐 Bash: rm -rf \/tmp\/x\nReply "yes" or "no"\. \(request 6b480a6f\)$/);
    await sleep(MIN + 30);
    await o.handle(dm(said));
    await turn;
    assert.ok(sent.includes(receipt), sent.join(' | '));
    assert.ok(sent.includes(answer), sent.join(' | '));
  }
  assert.deepEqual(events, [{ type: 'permission-answered', by: 'chat', allow: true }, { type: 'permission-answered', by: 'chat', allow: false }]);
});

test('a request in the chat for under three seconds is not answered by a bare yes: the owner is asked to read it, and nothing reaches the agent', async (t) => {
  const { o, sent, logs } = setup({ bareAnswerMinMs: undefined }); t.after(() => o.shutdown());
  const f = asker(o, DM);
  const turn = await ask(o, sent, dm(''), [A], 0);
  await o.handle(dm('yes'));
  assert.deepEqual(sent, [LINE_A, READ_FIRST_LINE]);
  assert.deepEqual(f.answers, []);
  assert.deepEqual(openAsks(o, DM), [A], 'still open');
  assert.ok(logs.includes(`permission reply ignored key=${DM} reason=request-just-posted id=aaaa1111`), logs.join('\n'));
  // With the id it is taken at once, as always, and with no receipt: the id said which.
  await o.handle(dm('yes aaaa1111'));
  await turn.done;
  assert.deepEqual(f.answers, [[A, true]]);
  assert.equal(f.turns.length, 1, 'the bare yes never became a turn');
  // The next message is answered as a message: nothing waited in the queue behind the turn.
  await o.handle(dm('hello'));
  assert.deepEqual(sent.slice(2), ['done: aaaa=yes', 'echo: hello']);
});

test('the three seconds count to when the answer was sent, by its platform\'s time: sent before the request, it is not taken however late it arrives; a clock ahead of ours gains nothing; with no time at all it is not taken', async (t) => {
  const { o, sent, logs } = setup({ bareAnswerMinMs: 300 }); t.after(() => o.shutdown());
  const f = asker(o, DM);
  const turn = await ask(o, sent, dm(''), [A], 350);
  // Typed before the request was there, delivered late (a reconnect, a download in front of it).
  await o.handle(dm('yes', { at: Date.now() - 5000 }));
  assert.deepEqual(sent, [LINE_A, READ_FIRST_LINE]);
  // A message with no time from its platform: when it arrived says nothing of when it was sent.
  await o.handle(dm('yes', { at: undefined }));
  assert.deepEqual(sent, [LINE_A, READ_FIRST_LINE, READ_FIRST_LINE]);
  assert.ok(logs.includes(`permission reply ignored key=${DM} reason=message-has-no-time id=aaaa1111`), logs.join('\n'));
  assert.deepEqual(f.answers, []);
  // Stamped in the future: taken as sent now, and by now the request has been read.
  await o.handle(dm('no', { at: Date.now() + 60_000 }));
  await turn.done;
  assert.deepEqual(f.answers, [[A, false]]);
});

test('two requests open: a bare answer answers none and the chat is asked which one; a reply to a request\'s own message answers that one, at once and with no receipt', async (t) => {
  const { o, sent, replyTo } = setup({ bareAnswerMinMs: undefined }); t.after(() => o.shutdown());
  const f = asker(o, DM);
  const turn = await ask(o, sent, dm(''), [A, B], 0);
  await o.handle(dm('yes'));
  assert.deepEqual(f.answers, []);
  assert.equal(sent.at(-1), whichOneLine([ASK_A, ASK_B]));
  assert.deepEqual(openAsks(o, DM), [A, B]);
  // The reply is to B's line: B is answered, A waits on. No three seconds: the owner is looking at it.
  await o.handle(dm('yes', replyTo(LINE_B)));
  assert.deepEqual(f.answers, [[B, true]]);
  assert.deepEqual(openAsks(o, DM), [A]);
  await o.handle(dm('לא', replyTo(LINE_A)));
  await turn.done;
  assert.deepEqual(f.answers, [[B, true], [A, false]]);
  assert.equal(f.turns.length, 1);
  assert.deepEqual(sent, [LINE_A, LINE_B, whichOneLine([ASK_A, ASK_B]), 'done: bbbb=yes aaaa=no'], 'the reply said which request: no receipt');
});

test('a reply picks a request by the id of the message replied to, never by what it quotes: the same words under another message, or from another author, are a message for the agent', async (t) => {
  const { o, sent, ids, replyTo } = setup(); t.after(() => o.shutdown());
  const f = asker(o, DM);
  const turn = await ask(o, sent, dm(''), [A, B]);
  // Each is a message for the agent: it waits behind the running turn.
  const said = [
    // The quote says B's line word for word, but the message replied to is another one.
    o.handle(dm('yes', { quoted: LINE_B, reply: { id: 'someone-elses-message', ours: true } })),
    // B's line's own id, but the platform says its author is not us (a message sent under a copied id).
    o.handle(dm('yes', replyTo(LINE_B, false))),
    // A quote with no reply facts at all, and a reply the platform gave no id for.
    o.handle(dm('yes', { quoted: LINE_B })),
    o.handle(dm('yes', { quoted: LINE_B, reply: { ours: true } })),
  ];
  await sleep(40);
  assert.deepEqual(f.answers, [], 'none of them answered a request');
  assert.deepEqual(openAsks(o, DM), [A, B]);
  assert.deepEqual(sent, [LINE_A, LINE_B], 'and none got a line');
  assert.ok(ids.has(LINE_B));
  await o.handle(dm('no aaaa1111'));
  await o.handle(dm('no bbbb2222'));
  await Promise.all([turn.done, ...said]);
  assert.equal(f.turns.length, 5, 'the four replies as turns of their own');
  assert.ok(f.turns.slice(1).every((x) => x.endsWith('yes')), f.turns.join(' | '));
});

test('a reply "yes" to a person\'s message, or to the agent\'s own question, with a request open: not an answer, a message for the agent', async (t) => {
  const { o, sent, replyTo } = setup({}, { 'open@g.us': ['u1', 'member'] }); t.after(() => o.shutdown());
  const f = asker(o, OPEN);
  // A member's turn asks. Then the member writes to the owner, who swipe-replies "כן" to that.
  const turn = await ask(o, sent, any('', 'member'), [A]);
  const toPerson = o.handle(any('כן', 'u1', { quoted: 'are you coming tonight?', reply: { id: 'the-members-message', ours: false } }));
  // The agent asked something earlier; the owner swipe-replies yes to that message of the bot's.
  const toQuestion = o.handle(any('yes', 'u1', { mentioned: true, quoted: 'Shall I book the table for 8?', reply: { id: 'the-bots-question', ours: true } }));
  await sleep(40);
  assert.deepEqual(f.answers, [], 'the request was not approved');
  assert.deepEqual(openAsks(o, OPEN), [A]);
  assert.deepEqual(sent, [LINE_A]);
  // To the request's own line it is an answer.
  await o.handle(any('no', 'u1', replyTo(LINE_A)));
  await Promise.all([turn.done, toPerson, toQuestion]);
  assert.deepEqual(f.answers, [[A, false]]);
  assert.equal(f.turns.length, 3, 'the two replies reached the agent');
  assert.match(f.turns[1], /כן$/);
});

test('a reply to the line of a request that is over answers nothing and is told so, never the one open now', async (t) => {
  const { o, sent, logs, replyTo } = setup({ bareAfterCloseMs: 0 }); t.after(() => o.shutdown());
  const f = asker(o, DM);
  let turn = await ask(o, sent, dm(''), [A]);
  await o.handle(dm('no aaaa1111'));
  await turn.done;
  // A new turn asks B. A's line is still in the chat to reply to.
  turn = await ask(o, sent, dm(''), [B]);
  await o.handle(dm('yes', replyTo(LINE_A)));
  assert.deepEqual(f.answers, [[A, false]]);
  assert.equal(sent.at(-1), LATE_ANSWER_LINE);
  assert.ok(logs.includes(`permission reply ignored key=${DM} reason=replied-to-request-not-open id=aaaa1111`), logs.join('\n'));
  assert.deepEqual(openAsks(o, DM), [B]);
  await o.handle(dm('yes', replyTo(LINE_B)));
  await turn.done;
  assert.deepEqual(f.answers, [[A, false], [B, true]]);
  assert.equal(f.turns.length, 2, 'none of these became a turn');
});

test('a reply cannot reach past its chat: a request line of another chat is no request here', async (t) => {
  const { o, sent, replyTo } = setup(); t.after(() => o.shutdown());
  const there = asker(o, DM), here_ = asker(o, GROUP);
  const far = await ask(o, sent, dm(''), [A]);
  await o.handle(grp('yes', 'u1', replyTo(LINE_A)));
  assert.deepEqual(there.answers, []);
  assert.equal(here_.turns.length, 1, 'in the group it is a message for the agent');
  assert.deepEqual(openAsks(o, DM), [A]);
  await o.handle(dm('no'));
  await far.done;
});

test('in a group with other people a bare word is an answer only when it names the bot', async (t) => {
  const { o, sent } = setup({}, { 'open@g.us': ['u1', 'member'] }); t.after(() => o.shutdown());
  // The group that hears everything, with a member who is no owner: "yes" may be said to that member.
  const f = asker(o, OPEN);
  const turn = await ask(o, sent, any('', 'member'), [A]);
  const plain = o.handle(any('כן'));
  await sleep(40);
  assert.deepEqual(f.answers, [], 'said to nobody in particular: not taken');
  assert.deepEqual(sent, [LINE_A], 'and no line about it');
  // "@<a member> yes": the mention is not the bot's.
  const toMember = o.handle(any('@972500000001 yes'));
  await sleep(40);
  assert.deepEqual(f.answers, []);
  // "@bot yes" is said to the bot.
  await o.handle(any('@bot yes', 'u1', { mentioned: true, botMentions: ['@bot'] }));
  await Promise.all([turn.done, plain, toMember]);
  assert.deepEqual(f.answers, [[A, true]]);
  assert.equal(f.turns.length, 3, 'the two that were no answer went to the agent, after the turn');
  assert.match(f.turns[1], /כן$/);
  assert.match(f.turns[2], /@972500000001 yes$/);
});

test('in a group a bare word that does not name the bot is a message, whoever the people are', async (t) => {
  const { o, sent } = setup(); t.after(() => o.shutdown());
  const f = asker(o, OPEN);
  const turn = await ask(o, sent, any(''), [A]);
  const plain = o.handle(any('yes'));
  await sleep(40);
  assert.deepEqual(f.answers, []);
  await o.handle(any('yes aaaa1111'));
  await Promise.all([turn.done, plain]);
  assert.deepEqual(f.answers, [[A, true]]);
  assert.equal(f.turns.length, 2);
});

test('a bare word from a member who is no owner is a message, as it always was; their "yes <id>" is refused', async (t) => {
  const { o, sent, logs, replyTo } = setup(); t.after(() => o.shutdown());
  const f = asker(o, GROUP);
  const turn = await ask(o, sent, grp(''), [A]);
  const said = [o.handle(grp('yes', 'intruder')), o.handle(grp('כן', 'intruder', replyTo(LINE_A)))];
  await sleep(40);
  assert.deepEqual(f.answers, [], 'never reached the brain');
  assert.deepEqual(sent, [LINE_A], 'no line: it was no attempt to answer');
  await o.handle(grp('yes aaaa1111', 'intruder'));
  assert.equal(sent.at(-1), NOT_OWNER_LINE);
  assert.equal(logs.filter((l) => l === `permission reply ignored key=${GROUP} sender=intruder reason=not-owner`).length, 1, logs.join('\n'));
  assert.deepEqual(openAsks(o, GROUP), [A]);
  // Without a mention the group's messages do not reach Angelia at all, the owner's bare yes included.
  await o.handle(grp('yes', 'u1', { text: 'yes', mentioned: false, botMentions: [] }));
  assert.deepEqual(f.answers, []);
  await o.handle(grp('no'));
  await Promise.all([turn.done, ...said]);
  assert.deepEqual(f.answers, [[A, false]]);
  assert.equal(f.turns.length, 3, 'the member\'s two words went to the agent');
});

test('no request open: yes is a message like any other and reaches the agent, with or without a reply', async (t) => {
  const { o, sent } = setup(); t.after(() => o.shutdown());
  await o.handle(dm('yes'));
  assert.equal(sent.at(-1), 'echo: [telegram dm 1 · Owner (u1)]\n\nyes');
  await o.handle(dm('לא', { quoted: LINE_A, reply: { id: 'm99', ours: true } }));
  assert.match(sent.at(-1)!, /לא$/);
  assert.ok(sent.at(-1)!.includes('(request aaaa1111)'), 'the quote goes to the agent as any quote does');
  assert.equal(sent.length, 2);
});

test('a request whose line never reached the chat is not answered by a bare yes: the word goes to the agent after the turn', async (t) => {
  const { o } = setup(); t.after(() => o.shutdown());
  const sent: string[] = [];
  let down = true;
  (o as unknown as { senders: Record<string, unknown> }).senders.telegram = { send: async (_c: string, text: string) => { if (down && text.startsWith('🔐')) throw Object.assign(new Error('chat not found'), { error_code: 400 }); sent.push(text); } };
  const f = asker(o, DM);
  const turn = o.handle(dm(`ASK:${A}`));
  await until(() => openAsks(o, DM).length === 1, 'the request');
  await sleep(MIN + 30);
  down = false;
  const said = o.handle(dm('yes'));
  await sleep(50);
  assert.deepEqual(f.answers, [], 'nobody read that request in the chat');
  await o.handle(dm('yes aaaa1111'));
  await Promise.all([turn, said]);
  assert.deepEqual(f.answers, [[A, true]]);
  assert.deepEqual(sent, ['done: aaaa=yes', 'echo: yes']);
});

test('yes <id> and no <id> work as before, with one request open and with two, at once, and say nothing back', async (t) => {
  const { o, sent } = setup({ bareAnswerMinMs: undefined }); t.after(() => o.shutdown());
  const f = asker(o, DM);
  let turn = await ask(o, sent, dm(''), [A], 0);
  await o.handle(dm('yes aaaa1111'));
  await turn.done;
  sent.length = 0;
  turn = await ask(o, sent, dm(''), [A, B], 0);
  await o.handle(dm('no bbbb2222.'));
  await o.handle(dm('@angelia_bot y aaaa1'));
  await turn.done;
  assert.deepEqual(f.answers, [[A, true], [B, false], [A, true]]);
  assert.equal(f.turns.length, 2);
  assert.deepEqual(sent, [LINE_A, LINE_B, 'done: bbbb=no aaaa=yes']);
});

test('a photo with the caption yes is not an answer: it waits its turn and goes to the agent', async (t) => {
  const { o, sent } = setup(); t.after(() => o.shutdown());
  const f = asker(o, DM);
  const turn = await ask(o, sent, dm(''), [A]);
  const photo = o.handle(dm('yes', { media: ['/x/.inbox/a.jpg'] }));
  await sleep(50);
  assert.deepEqual(f.answers, []);
  await o.handle(dm('no'));
  await Promise.all([turn.done, photo]);
  assert.deepEqual(f.answers, [[A, false]]);
  assert.equal(f.turns.length, 2);
  assert.match(f.turns[1], /yes\n\[file: \/x\/\.inbox\/a\.jpg\]$/);
});

test('after a request ended with no answer from the chat (here: answered in the app), a bare word answers nothing for a while: a "yes" typed for it and sent late must not approve the next one', async (t) => {
  const { o, sent, logs, replyTo } = setup({ bareAfterCloseMs: 400 }); t.after(() => o.shutdown());
  const f = asker(o, DM);
  const turn = await ask(o, sent, dm(''), [A, B]);
  // A is answered in the app (it could as well have timed out); B is open, and has been for a while.
  assert.equal(o.answerPermission(DM, A, false), true);
  // The "yes" the owner typed for A on a phone that was offline arrives, stamped now by the platform.
  await o.handle(dm('yes'));
  assert.deepEqual(f.answers, [[A, false]], 'B was not approved');
  assert.equal(sent.at(-1), afterCloseLine(true, false));
  assert.ok(logs.includes(`permission reply ignored key=${DM} reason=a-request-just-ended`), logs.join('\n'));
  assert.deepEqual(openAsks(o, DM), [B]);
  // What names its request is taken as always.
  await o.handle(dm('yes', replyTo(LINE_B)));
  await turn.done;
  assert.deepEqual(f.answers, [[A, false], [B, true]]);
  // Nothing open now, still inside the while: the word is told too late, and is never a turn of its own.
  await o.handle(dm('yes'));
  assert.equal(sent.at(-1), afterCloseLine(false, false));
  assert.equal(f.turns.length, 1);
  // Past it, a bare word is what it always was: here, with nothing open, a message.
  await sleep(420);
  await o.handle(dm('yes'));
  assert.equal(sent.at(-1), 'echo: yes');
  // And a request answered from the chat opens no such while: the next one takes a bare word.
  const next = await ask(o, sent, dm(''), [A]);
  await o.handle(dm('no'));
  await next.done;
  const last = await ask(o, sent, dm(''), [B]);
  await o.handle(dm('yes'));
  await last.done;
  assert.deepEqual(f.answers.slice(2), [[A, false], [B, true]]);
});

test('a request asked right after one ended takes no bare word for as long as it waits: the "yes" typed offline for the first arrives minutes later, past the while, and must not approve it', async (t) => {
  const { o, sent, logs, replyTo } = setup({ bareAfterCloseMs: 250 }); t.after(() => o.shutdown());
  const f = asker(o, DM);
  // The owner types "yes" for A with no network. A ends unanswered (here its turn ends; a timeout is the same).
  const first = await ask(o, sent, dm(''), [A]);
  f.end();
  await first.done;
  // B is asked a moment later, inside the while.
  const second = await ask(o, sent, dm(''), [B], 0);
  // The phone is back long after the while is over (a request waits ten minutes): the "yes" arrives,
  // stamped now, with B the only request open and long read.
  await sleep(300);
  await o.handle(dm('yes'));
  assert.deepEqual(f.answers, [], 'B was not approved');
  assert.equal(sent.at(-1), followsCloseLine(false));
  assert.ok(logs.includes(`permission reply ignored key=${DM} reason=request-beside-one-that-ended id=bbbb2222`), logs.join('\n'));
  assert.deepEqual(openAsks(o, DM), [B]);
  // It still waits, and what names it answers it.
  await o.handle(dm('no', replyTo(LINE_B)));
  await second.done;
  assert.deepEqual(f.answers, [[B, false]]);
  assert.equal(f.turns.length, 2, 'the bare yes never became a turn');
  // A request asked after the while takes a bare word again (B was answered from the chat: no new while).
  const third = await ask(o, sent, dm(''), [A]);
  await o.handle(dm('yes'));
  await third.done;
  assert.deepEqual(f.answers, [[B, false], [A, true]]);
  assert.ok(sent.includes(answeredLine(true, ASK_A)));
});

test('a request open beside one that ended without the chat\'s answer takes no bare word either, however long it waits', async (t) => {
  const { o, sent } = setup({ bareAfterCloseMs: 150 }); t.after(() => o.shutdown());
  const f = asker(o, DM);
  const turn = await ask(o, sent, dm(''), [A, B]);
  assert.equal(o.answerPermission(DM, A, true), true);
  await sleep(200);
  await o.handle(dm('yes'));
  assert.deepEqual(f.answers, [[A, true]], 'the yes typed for A did not land on B');
  assert.equal(sent.at(-1), followsCloseLine(false));
  await o.handle(dm('no bbbb2222'));
  await turn.done;
  assert.deepEqual(f.answers, [[A, true], [B, false]]);
});

test('a request that timed out, and one left open when its turn ended, start the same while', async (t) => {
  const cfg = Config.parse({ profiles: { a: { cwd: here } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000, permission_timeout_minutes: 0.005 } });
  const sent: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } } }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-yesno-')), bins: { 'claude-code': FAKE }, bareAnswerMinMs: 0 });
  t.after(() => o.shutdown());
  // The real CLI path: nobody answers, the timeout denies it, the turn ends.
  await o.handle(dm('PERMWHY do it'));
  assert.ok(sent.some((s) => s.startsWith('No answer to the permission request in time')), sent.join(' | '));
  await o.handle(dm('yes'));
  assert.equal(sent.at(-1), afterCloseLine(false, false), 'the yes typed for it is not handed to the agent as "yes"');
  // A turn that ends with its request open (a /stop, a crash).
  const { o: o2, sent: sent2 } = setup(); t.after(() => o2.shutdown());
  const f = asker(o2, DM);
  const turn = await ask(o2, sent2, dm(''), [A]);
  f.end();
  await turn.done;
  await o2.handle(dm('yes'));
  assert.equal(sent2.at(-1), afterCloseLine(false, false));
  assert.equal(f.turns.length, 1);
});

test('the request\'s line is sent as that request\'s (for an adapter with buttons), and the adapter is told when it is over: answered, timed out', async (t) => {
  const cfg = Config.parse({ profiles: { a: { cwd: here } }, routes: [{ platform: 'telegram', chat: 1, profile: 'a' }], defaults: { max_out_per_min: 1000, permission_timeout_minutes: 0.005 } });
  const sent: [string, string | undefined][] = [], over: string[] = [];
  const sender = { send: async (_c: string, text: string, _t?: string, o?: { ask?: string }) => { sent.push([text.split('\n')[0], o?.ask]); }, askDone: (chat: string, id: string) => { over.push(`${chat} ${id}`); } };
  const o = new Orchestrator(cfg, { telegram: sender }, { stateDir: mkdtempSync(join(tmpdir(), 'angelia-yesno-')), bins: { 'claude-code': FAKE }, bareAnswerMinMs: MIN, bareAfterCloseMs: 0 });
  t.after(() => o.shutdown());
  const ID = '6b480a6f-d386-4972-95d9-2eeaef82f3bc';
  // Nobody answers: the timeout denies it.
  await o.handle(dm('PERMWHY do it'));
  assert.deepEqual(sent.slice(0, 1), [['🔐 Bash: rm -rf /tmp/x', ID]]);
  assert.ok(sent.slice(1).every(([, ask]) => ask === undefined), 'no other line is a request\'s');
  assert.deepEqual(over, [`1 ${ID}`]);
  // Answered with a bare word.
  const turn = o.handle(dm('PERM do it'));
  await until(() => sent.filter(([, ask]) => ask).length === 2, 'the second request line');
  await sleep(MIN + 30);
  await o.handle(dm('yes'));
  await turn;
  assert.deepEqual(over, [`1 ${ID}`, `1 ${ID}`]);
});
