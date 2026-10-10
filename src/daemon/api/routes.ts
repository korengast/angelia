import { z } from 'zod';
import { APP_COMMANDS } from '../../core/commands.js';
import type { ChatEvent } from '../../core/events.js';
import type { ChatHistory, HandoffResult, WaitingPermission } from '../../core/orchestrator.js';
import type { SessionRow } from '../../core/types.js';
import type { ProfileJson } from '../../instance/profiles.js';
import type { JobsView } from '../../jobs/jobs-view.js';

/**
 * Every route the local API answers, with what it takes and what it gives. The server serves a path
 * only when it is in this table, and `angelia api spec` prints this table as an OpenAPI document, so
 * the published contract and what the daemon does cannot part ways.
 *
 * `stable`: version 1 of the contract. Within version 1 a stable route only gains: a new optional
 * field in, a new field or event type out, a new route. Removing or changing anything stable is
 * version 2 (`api` in `/healthz`). `internal`: there for Angelia's own clients (the desktop app, the
 * CLI), and it may change in any release.
 */
/** The version of the API's contract. A client refuses another. */
export const DESK_API_VERSION = 1;
/** What this daemon adds to version 1, so a client can offer it or say to update. An old daemon
 *  ignores a field it does not know (files sent to it would be dropped without a word). */
export const DESK_FEATURES = ['command', 'files', 'views', 'openapi'] as const;

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  summary: string;
  description?: string;
  /** none: no token; owner: the owner's token only; any: the owner's, or an agent's for its own chat
   *  (and for another profile's chat when the daemon allows that, with `from`). */
  token: 'none' | 'owner' | 'any';
  stability: 'stable' | 'internal';
  query?: z.ZodObject;
  body?: z.ZodObject;
  /** The 200 answer: a JSON body, or, for a stream, one event's `data`. */
  response: z.ZodType;
  stream?: true;
  /** Error statuses beyond 403 (bad token), each with an `{ error }` body. */
  errors: number[];
  /** A request that succeeds against a daemon with chat `telegram:1` routed to profile `a` (the tests
   *  send it). For GET, the query. */
  example?: Record<string, unknown>;
  /** A realistic 200 answer to show (a test checks it against `response`). For a stream, one event. */
  answer?: unknown;
}

const key = z.string().min(1).describe('A routed chat as `platform:chat`, such as `telegram:123456` or `whatsapp:1203630000…@g.us`; `angelia profiles --json` lists them.');
const from = z.string().optional().describe('An agent writing into another profile\'s chat names its own chat here; its own token then counts. Not for the owner.');
const legacyToken = z.string().optional().meta({ deprecated: true }).describe('The token, for clients that predate the Authorization header. Prefer the header.');
const profile = z.string().describe('A profile name from the routing table.');
const ok = z.object({ ok: z.literal(true) });

export const ErrorBody = z.object({ error: z.string().describe('Says what went wrong; safe to show.') });

export const SessionRowSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  last_used_at: z.string(),
  turns: z.number(),
  started: z.boolean(),
  label: z.string(),
  backend: z.string().optional().describe('The CLI that owns this session.'),
  model: z.string().optional().describe('A /model override for this session only.'),
  effort: z.string().optional().describe('An /effort override for this session only.'),
  background_since: z.string().optional().describe('A handoff moved the chat on while this session\'s turn was running.'),
});

export const HistoryItemSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  at: z.string().optional().describe('ISO time.'),
  tools: z.array(z.string()).optional().describe('Tools the assistant used in this message, each once.'),
});

export const ChatHistorySchema = z.object({
  session: z.string().nullable().describe('The session read; null when the chat has none yet.'),
  supported: z.boolean().describe('False for a CLI whose history Angelia cannot read yet.'),
  items: z.array(HistoryItemSchema),
  more: z.boolean().describe('Older messages exist before the first item.'),
  cursor: z.string().optional().describe('With `more`: pass it as `before` to get the page of older messages. Opaque.'),
});

export const WaitingPermissionSchema = z.object({
  key: z.string(), at: z.string(), id: z.string(), tool: z.string(), preview: z.string(), detail: z.string().optional(),
});

const turnEnvelope = { key: z.string(), at: z.string() };
export const ChatEventSchema = z.discriminatedUnion('type', [
  z.object({ ...turnEnvelope, type: z.literal('turn'), turn: z.string(), text: z.string(), sender: z.string(), surface: z.enum(['chat', 'app']), queued: z.number() })
    .describe('A turn began. `surface: app`: the owner typed it in a client, and the answer goes back to that client only.'),
  z.object({ ...turnEnvelope, type: z.literal('progress'), text: z.string() }).describe('A line the agent said along the way.'),
  z.object({ ...turnEnvelope, type: z.literal('out'), text: z.string() }).describe('A line the chat got (or, for an app turn, would have got).'),
  z.object({ ...turnEnvelope, type: z.literal('permission'), id: z.string(), tool: z.string(), preview: z.string(), detail: z.string().optional() })
    .describe('The agent waits for a yes or no; answer it with POST /permission.'),
  z.object({ ...turnEnvelope, type: z.literal('permission-answered'), id: z.string(), allow: z.boolean(), by: z.enum(['chat', 'app', 'timeout', 'terminal']) }),
  z.object({ ...turnEnvelope, type: z.literal('turn-end'), turn: z.string(), ok: z.boolean(), reason: z.string().optional(), queued: z.number() }),
]);

const ProfileSchema = z.object({
  name: z.string(),
  backend: z.string(),
  tui: z.boolean(),
  model: z.string().nullable(),
  folder: z.string(),
  chats: z.array(z.object({ chat: z.string(), session: z.string().nullable(), sessions: z.array(z.string()) })),
  settings: z.record(z.string(), z.unknown()).describe('The table\'s settings for the profile. Its keys may grow.'),
});

const JobsSchema = z.object({
  file: z.string(),
  jobs: z.array(z.object({
    name: z.string(), when: z.string(), kind: z.enum(['turn', 'send', 'run']), what: z.string(), chat: z.string().nullable(),
    enabled: z.boolean(), installed: z.boolean(), runs: z.array(z.object({ at: z.string(), result: z.string() })),
  })),
  error: z.string().optional(),
});

const HandoffSchema = ok.extend({ key: z.string(), profile: z.string(), mode: z.enum(['session', 'brief']), said: z.string() });

const fileItem = z.union([z.string().min(1), z.object({ path: z.string().min(1), from: z.string().min(1).optional() })]);
/** Files one app turn may carry. */
export const TURN_FILES_MAX = 10;
/** Owner-only views of a profile, for Angelia's desktop app. Their shapes may change in any release. */
const view = z.looseObject({}).describe('A view for Angelia\'s desktop app; its shape may change in any release.');

export const ROUTES: Route[] = [
  {
    method: 'GET', path: '/healthz', summary: 'Is the daemon up, and which API version and features it has', token: 'none', stability: 'stable',
    description: 'A client checks `api` and refuses a version it does not know. `features` lists what this daemon adds to the version.',
    response: z.object({ ok: z.literal(true), api: z.literal(1), features: z.array(z.string()) }), errors: [],
    answer: { ok: true, api: 1, features: ['command', 'files', 'views', 'openapi'] },
  },
  {
    method: 'GET', path: '/openapi.json', summary: 'This document, as the running daemon has it', token: 'none', stability: 'stable',
    description: 'Read it before calling: it matches the installed version. `angelia api spec` prints the same.',
    response: z.looseObject({ openapi: z.string() }), errors: [],
  },
  {
    method: 'POST', path: '/send', summary: 'Post a line into a routed chat', token: 'any', stability: 'stable',
    description: 'A line `MEDIA:<absolute path>` in the text attaches that file (not from another profile\'s agent). No agent sees the line. '
      + 'Another profile\'s agent may post when neither profile is isolated and the hourly limit between profiles allows it; the line says who sent it.',
    body: z.object({ key, text: z.string().min(1), from, token: legacyToken }),
    response: ok.extend({ media: z.number().optional().describe('Files attached from MEDIA: lines.') }),
    errors: [400, 404], example: { key: 'telegram:1', text: 'The backup finished.' }, answer: { ok: true },
  },
  {
    method: 'POST', path: '/send-media', summary: 'Attach a file to a routed chat', token: 'any', stability: 'stable',
    description: 'An agent\'s token works for its own chat only, and attaches only what its profile may read. Audio goes as a voice note unless `voice` is false.',
    body: z.object({
      key, path: z.string().min(1).describe('Absolute path.'), caption: z.string().optional(), voice: z.boolean().optional(),
      file_name: z.string().optional().describe('The name a document is sent under.'), token: legacyToken,
    }),
    response: ok, errors: [400, 404], answer: { ok: true },
  },
  {
    method: 'POST', path: '/turn', summary: 'Type a prompt into a chat\'s session', token: 'any', stability: 'stable',
    description: 'Queued; the answer goes to the chat, or, with `reply: caller`, to the event stream only. Watch `/events` for the turn id. '
      + 'An agent\'s prompt is plain text, never a CLI command. Another profile\'s agent may give a task only when the target lists it in `accept_from`. '
      + '429: the chat already holds 10 turns, running and waiting; try again after it answers.',
    body: z.object({
      key, text: z.string().optional().describe('Required unless files are given.'), from,
      reply: z.literal('caller').optional().describe('Owner only: the answer comes back as events, never to the chat; the agent sees the prompt as the owner\'s, typed in an app.'),
      plain: z.boolean().optional().describe('With reply: caller, a text starting with / stays a message.'),
      files: z.array(fileItem).min(1).max(TURN_FILES_MAX).optional().describe('With reply: caller only: files for the agent, copied into the profile\'s inbox.'),
      token: legacyToken,
    }),
    response: ok.extend({ queued: z.literal(true), turn: z.string().describe('The id the turn\'s events carry.') }),
    errors: [400, 404, 429], example: { key: 'telegram:1', text: 'Summarise today\'s mail.' }, answer: { ok: true, queued: true, turn: '7f0c2a9e-5b1d-4c3e-9a47-2e8f6d1b0c55' },
  },
  {
    method: 'POST', path: '/ask', summary: 'Ask a chat\'s agent a question and wait for the answer', token: 'any', stability: 'stable',
    description: 'A read-only copy of the chat\'s session answers: it reads files and nothing else, and keeps nothing. Up to ten minutes. '
      + 'The chat does not get the answer. A DM with an owner gets one line saying a question was asked; a group gets nothing. '
      + 'Another profile\'s agent may ask only when the target lists it in `answer_from`, neither profile is isolated, and the hourly limit between profiles allows it.',
    body: z.object({ key, text: z.string().min(1), from, token: legacyToken }),
    response: z.object({ answer: z.string() }), errors: [400, 404, 409, 429, 501, 502, 504],
    answer: { answer: 'Two things: the dentist at 10:30, and the invoice for March is due.' },
  },
  {
    method: 'GET', path: '/events', summary: 'The live event stream', token: 'owner', stability: 'stable', stream: true,
    description: 'Server-sent events: each `data:` line is one JSON event below. Comment lines (`: ping`) keep an idle stream alive. '
      + 'A client that stops reading is cut off; it reconnects and reads what it missed from `/history`. New event types may appear: ignore unknown ones.',
    query: z.object({ key: key.optional().describe('Only this chat\'s events.') }),
    response: ChatEventSchema, errors: [404], example: { key: 'telegram:1' },
    answer: { key: 'telegram:1', at: '2026-10-10T09:15:02.311Z', type: 'turn-end', turn: '7f0c2a9e-5b1d-4c3e-9a47-2e8f6d1b0c55', ok: true, queued: 0 },
  },
  {
    method: 'GET', path: '/profiles', summary: 'Profiles, their chats and their sessions', token: 'owner', stability: 'stable',
    response: z.object({ version: z.literal(1), profiles: z.array(ProfileSchema) }), errors: [], example: {},
    answer: { version: 1, profiles: [{ name: 'mail', backend: 'claude-code', tui: false, model: null, folder: '/Users/example/.angelia/workspace/profiles/mail',
      chats: [{ chat: 'telegram:123456', session: '3b9e1f4a-8c2d-4e6f-a1b3-5d7c9e0f2a48', sessions: ['3b9e1f4a-8c2d-4e6f-a1b3-5d7c9e0f2a48'] }], settings: { permission_mode: 'acceptEdits', effort: null } }] },
  },
  {
    method: 'GET', path: '/sessions', summary: 'A chat\'s sessions, last used first', token: 'owner', stability: 'stable',
    query: z.object({ key }), response: z.object({ active: z.string().nullable(), sessions: z.array(SessionRowSchema) }),
    errors: [404], example: { key: 'telegram:1' },
    answer: { active: '3b9e1f4a-8c2d-4e6f-a1b3-5d7c9e0f2a48', sessions: [{ id: '3b9e1f4a-8c2d-4e6f-a1b3-5d7c9e0f2a48', created_at: '2026-10-09T07:00:12.000Z', last_used_at: '2026-10-10T09:15:02.000Z', turns: 14, started: true, label: 'mail and calendar', backend: 'claude-code' }] },
  },
  {
    method: 'GET', path: '/history', summary: 'A chat\'s conversation, from the CLI\'s own record', token: 'owner', stability: 'stable',
    description: 'Angelia keeps no copy of messages: each CLI\'s own session files are read. The first page holds the newest messages; '
      + 'within a page, items are oldest first. For older messages, pass the page\'s `cursor` as `before`.',
    query: z.object({
      key, session: z.string().optional().describe('Default: the active session.'),
      limit: z.string().regex(/^\d+$/).optional().describe('Messages per page.'),
      before: z.string().optional().describe('The `cursor` of a page you have: you get the messages just before (older than) that page.'),
    }),
    response: ChatHistorySchema, errors: [400, 404, 500, 502], example: { key: 'telegram:1' },
    answer: { session: '3b9e1f4a-8c2d-4e6f-a1b3-5d7c9e0f2a48', supported: true, more: true, cursor: '183422', items: [
      { role: 'user', text: 'What is on today?', at: '2026-10-10T09:14:40.000Z' },
      { role: 'assistant', text: 'Two things: the dentist at 10:30, and the invoice for March is due.', at: '2026-10-10T09:15:01.000Z', tools: ['Read'] }] },
  },
  {
    method: 'GET', path: '/permissions', summary: 'Permission requests waiting now, every chat, oldest first', token: 'owner', stability: 'stable',
    response: z.object({ permissions: z.array(WaitingPermissionSchema) }), errors: [], example: {},
    answer: { permissions: [{ key: 'telegram:123456', at: '2026-10-10T09:20:00.000Z', id: 'k3v9q', tool: 'Bash', preview: 'git push origin main' }] },
  },
  {
    method: 'POST', path: '/permission', summary: 'Answer a permission request', token: 'owner', stability: 'stable',
    description: 'The first answer wins (chat, client or the CLI\'s own dialog). 409: nothing with that id waits.',
    body: z.object({ key, id: z.string().min(1), allow: z.boolean(), token: legacyToken }), response: ok, errors: [400, 404, 409], answer: { ok: true },
  },
  {
    method: 'GET', path: '/jobs', summary: 'A profile\'s scheduled jobs and their last runs', token: 'owner', stability: 'stable',
    query: z.object({ profile }), response: JobsSchema, errors: [404], example: { profile: 'a' },
    answer: { file: '/Users/example/.angelia/workspace/profiles/mail/angelia-jobs.yaml', jobs: [{ name: 'morning-card', when: '0 8 * * mon-fri', kind: 'turn',
      what: 'Write today\'s card.', chat: 'telegram:123456', enabled: true, installed: true, runs: [{ at: '2026-10-10T08:00:03.000Z', result: 'ok' }] }] },
  },
  {
    method: 'GET', path: '/status', summary: 'The daemon\'s own state', token: 'owner', stability: 'internal',
    response: view, errors: [404], example: {},
  },
  {
    method: 'POST', path: '/command', summary: 'A chat command pressed in a client', token: 'owner', stability: 'internal',
    body: z.object({ key, command: z.enum(APP_COMMANDS), token: legacyToken }), response: ok.extend({ text: z.string() }), errors: [400, 404],
    example: { key: 'telegram:1', command: 'status' },
  },
  {
    method: 'POST', path: '/handoff', summary: 'Move a terminal session to its chat (`angelia handoff`)', token: 'owner', stability: 'internal',
    body: z.object({
      cwd: z.string(), summary: z.string(), session: z.string().optional(), brief: z.string().optional(), project: z.string().optional(),
      chat: z.string().optional(), token: legacyToken,
    }),
    response: HandoffSchema, errors: [400, 404],
  },
  ...(['/instructions', '/memory', '/skills', '/capabilities'] as const).map((path): Route => ({
    method: 'GET', path, summary: `A profile's ${path.slice(1)}, for the desktop app`, token: 'owner', stability: 'internal',
    query: z.object({ profile }), response: view, errors: [400, 404], example: { profile: 'a' },
  })),
  ...(['/files', '/file'] as const).map((path): Route => ({
    method: 'GET', path, summary: path === '/files' ? 'A folder of a profile, for the desktop app' : 'One file of a profile, for the desktop app',
    token: 'owner', stability: 'internal',
    query: z.object({ profile, path: path === '/files' ? z.string().optional().describe('A folder relative to the profile folder; default: the folder itself.') : z.string().describe('Relative to the profile folder.') }),
    response: path === '/files' ? z.array(z.object({ name: z.string(), kind: z.enum(['dir', 'file']) })) : view, errors: [400, 404], example: path === '/files' ? { profile: 'a' } : { profile: 'a', path: 'CLAUDE.md' },
  })),
  {
    method: 'GET', path: '/skill', summary: 'One skill\'s text, for the desktop app', token: 'owner', stability: 'internal',
    query: z.object({ profile, name: z.string() }), response: view, errors: [400, 404],
  },
];

/** The route for a method and path, or undefined: the server answers 404 for anything not here. */
export function routeFor(method: string | undefined, path: string): Route | undefined {
  return ROUTES.find((r) => r.method === method && r.path === path);
}

// The schemas above describe the daemon's own types: a change to one that the schema does not follow
// fails the build here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function same<T extends true>(): T | void { /* compile-time only */ }
same<Same<z.infer<typeof SessionRowSchema>, SessionRow>>();
same<Same<z.infer<typeof ChatHistorySchema>, ChatHistory>>();
same<Same<z.infer<typeof WaitingPermissionSchema>, WaitingPermission>>();
same<Same<z.infer<typeof ChatEventSchema>, ChatEvent>>();
same<Same<Omit<z.infer<typeof ProfileSchema>, 'settings'>, ProfileJson>>();
same<Same<z.infer<typeof JobsSchema>, JobsView>>();
same<Same<Omit<z.infer<typeof HandoffSchema>, 'ok'>, HandoffResult>>();
