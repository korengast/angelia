// The bot check's page. The token stays in the input and in memory for one check: it is sent only to
// api.telegram.org (the page's CSP allows no other connection), never stored, never logged. Every
// value from Telegram goes into the page as text, never as markup: anyone can name a group.
import { checkBot, isGroup, routeLine } from './bot.js';

const $ = (id) => document.getElementById(id);
const form = $('check'), token = $('token'), button = $('run'), status = $('status'), error = $('error'), result = $('result');

/** An element with text and optional attributes; children may be nodes or strings. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  node.append(...children.filter((c) => c !== undefined && c !== null));
  return node;
}

function copyButton(text, label) {
  const b = el('button', { type: 'button', class: 'btn light small', 'aria-label': label }, 'Copy');
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 2000);
  });
  return b;
}

const when = (unix) => (unix ? new Date(unix * 1000).toLocaleString() : 'unknown time');
const TYPES = { private: 'Direct chat', group: 'Group', supergroup: 'Group', channel: 'Channel' };

function renderBot(bot) {
  return el('section', { class: 'card', 'aria-labelledby': 'bot-name' },
    el('h3', { id: 'bot-name' }, `${bot.first_name} `, el('span', { class: 'fine' }, `@${bot.username}`)),
    el('dl', {},
      el('dt', {}, 'Bot id'), el('dd', {}, el('code', {}, String(bot.id))),
      el('dt', {}, 'Can be added to groups'), el('dd', {}, bot.can_join_groups ? 'Yes' : 'No (turn it on in @BotFather, /setjoingroups)'),
      el('dt', {}, 'Reads every group message'), el('dd', {}, bot.can_read_all_group_messages
        ? 'Yes (privacy mode is off)'
        : 'No. Privacy mode is on, so in a group it sees only commands, replies to it and messages that mention it.')));
}

function renderWebhook(webhook) {
  return el('section', { class: 'card warn', 'aria-labelledby': 'webhook-title' },
    el('h3', { id: 'webhook-title' }, 'This bot has a webhook'),
    el('p', {}, 'Telegram sends its updates to ', el('code', {}, webhook.url), `, so getUpdates would fail with 409 Conflict. ${webhook.pending_update_count ?? 0} updates are waiting there.`),
    el('p', {}, 'Angelia polls instead. When it starts with this token, it removes the webhook, and whatever receives it stops getting updates. Give Angelia a bot of its own unless nothing uses the webhook. This page changes nothing.'));
}

function renderChat(chat) {
  const line = routeLine(chat);
  return el('li', { class: 'card' },
    el('h4', {}, chat.name, ' ', el('span', { class: 'fine' }, TYPES[chat.type] ?? chat.type)),
    el('p', {}, 'Chat id ', el('code', {}, String(chat.id)), ' ', copyButton(String(chat.id), `Copy the chat id of ${chat.name}`)),
    el('p', { class: 'fine' }, `${chat.count} update${chat.count === 1 ? '' : 's'}, the last at ${when(chat.last)}.`),
    chat.senders.length ? el('p', { class: 'fine' }, 'Written by: ', ...chat.senders.flatMap((s, i) => [i ? ', ' : '', `${s.name} (user id `, el('code', {}, String(s.id)), ')'])) : undefined,
    el('p', { class: 'fine' }, 'Route for routing.yaml (change the profile name):'),
    el('pre', {}, el('code', {}, line)), copyButton(line, `Copy the route line for ${chat.name}`),
    isGroup(chat) && chat.senders.length !== 1 ? el('p', { class: 'fine' }, 'In a group, add owners: [your user id]. Owners approve what the agent runs.') : undefined);
}

function render({ bot, webhook, chats }) {
  const parts = [el('h2', { id: 'result-title', tabindex: '-1' }, 'Result'), renderBot(bot)];
  if (webhook.url) parts.push(renderWebhook(webhook));
  else if (!chats.length) parts.push(el('section', { class: 'card' },
    el('h3', {}, 'No recent messages'),
    el('p', {}, `Send @${bot.username} a message, then check again. In a group, mention it: @${bot.username} hello.`),
    el('p', { class: 'fine' }, 'Telegram keeps updates for 24 hours, and only until a program that polls the bot takes them. If Angelia already runs with this token, it took them: find the chat id in its log instead.')));
  else parts.push(el('h3', {}, `Chats in the last updates (${chats.length})`), el('ul', { class: 'chats' }, ...chats.map(renderChat)));
  result.replaceChildren(...parts);
  result.hidden = false;
  result.querySelector('#result-title').focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.hidden = true;
  error.textContent = '';
  result.hidden = true;
  button.disabled = true;
  form.setAttribute('aria-busy', 'true');
  status.textContent = 'Asking Telegram…';
  try {
    const r = await checkBot(token.value);
    status.textContent = r.webhook.url ? 'The token works. The bot has a webhook.' : `The token works. ${r.chats.length} chat${r.chats.length === 1 ? '' : 's'} found.`;
    render(r);
  } catch (err) {
    status.textContent = '';
    error.textContent = err.message;
    error.hidden = false;
    if (err.step === 'token') token.focus();
  } finally {
    button.disabled = false;
    form.removeAttribute('aria-busy');
  }
});

$('show').addEventListener('change', (e) => { token.type = e.target.checked ? 'text' : 'password'; });
$('forget').addEventListener('click', () => {
  token.value = '';
  result.replaceChildren();
  result.hidden = true;
  error.hidden = true;
  status.textContent = 'Token cleared from the page.';
  token.focus();
});
