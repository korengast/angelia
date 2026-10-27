// The bot check's page. The token stays in the input and in memory for one check: it is sent only to
// api.telegram.org (the page's CSP allows no other connection), never stored, never logged. Every
// value from Telegram goes into the page as text, never as markup: anyone can name a group.
import { checkBot, isGroup, routeLine } from './bot.js';

const $ = (id) => document.getElementById(id);
const box = $('check'), token = $('token'), button = $('run'), status = $('status'), error = $('error'), result = $('result');

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
        : 'No. Privacy mode is on: in a group it gets only commands sent to it, replies to its messages and service messages, not plain @mentions. Make it a group admin to get every message, as Angelia needs, or turn privacy mode off in @BotFather (/setprivacy) and add it to the group again.')));
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
    isGroup(chat) ? el('p', { class: 'fine' }, 'Replace YOUR_USER_ID with your own user id: the chat id of your direct chat with the bot. Owners approve what the agent runs, so put only yourself there, even if someone else wrote above.') : undefined);
}

function render({ bot, webhook, chats }) {
  const parts = [el('h2', { id: 'result-title', tabindex: '-1' }, 'Result'), renderBot(bot)];
  if (webhook.url) parts.push(renderWebhook(webhook));
  else if (!chats.length) parts.push(el('section', { class: 'card' },
    el('h3', {}, 'No recent messages'),
    el('p', {}, `Send @${bot.username} a message, then check again. For a group, add the bot to it, or send /start@${bot.username} there.`),
    el('p', { class: 'fine' }, 'Telegram keeps updates for 24 hours, and only until a program that polls the bot takes them. If Angelia already runs with this token, it took them: find the chat id in its log instead.')));
  else parts.push(el('h3', {}, `Chats in the last updates (${chats.length})`), el('ul', { class: 'chats' }, ...chats.map(renderChat)));
  result.replaceChildren(...parts);
  result.hidden = false;
  result.querySelector('#result-title').focus();
}

// No form and no password field: nothing is ever submitted, and no browser offers to save the token.
// The box is a text field drawn as dots (tools.css, .masked); Enter runs the check like the button.
async function run() {
  error.hidden = true;
  error.textContent = '';
  result.hidden = true;
  button.disabled = true;
  box.setAttribute('aria-busy', 'true');
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
    box.removeAttribute('aria-busy');
  }
}

button.addEventListener('click', run);
token.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !button.disabled) { e.preventDefault(); run(); } });
$('show').addEventListener('change', (e) => { token.classList.toggle('masked', !e.target.checked); });
$('forget').addEventListener('click', () => {
  token.value = '';
  result.replaceChildren();
  result.hidden = true;
  error.hidden = true;
  status.textContent = 'Token cleared from the page.';
  token.focus();
});
