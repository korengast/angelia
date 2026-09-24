import type { Route } from '../../instance/config/schema.js';
import type { Inbound } from '../types.js';

export type GateResult = { ok: true; route: Route } | { ok: false; reason: 'unmatched' | 'sender' | 'mention' };

export function gate(i: Pick<Inbound, 'sender' | 'isGroup' | 'mentioned'>, route: Route | undefined): GateResult {
  if (!route) return { ok: false, reason: 'unmatched' };
  if (!mayTalk(i, route)) return { ok: false, reason: 'sender' };
  const mention = route.mention ?? 'required';
  if (i.isGroup && mention === 'required' && !i.mentioned) return { ok: false, reason: 'mention' };
  return { ok: true, route };
}

/**
 * Who may talk to the agent. By default only the owners: an agent is a personal assistant first, and
 * anyone it listens to can steer it. In a DM that is the chat's own user. A group lets others in only
 * by name (allow_from), or everyone with "*".
 */
export function mayTalk(i: Pick<Inbound, 'sender' | 'isGroup'>, route: Route): boolean {
  if (route.allow_from.includes(EVERYONE)) return true;
  if (route.allow_from.length) return route.allow_from.includes(i.sender);
  return isOwner(i, route);
}

/** allow_from: ["*"]: every member of the chat. */
export const EVERYONE = '*';

/** May this sender run /sh or answer a permission prompt? DMs: yes. Groups: only listed owners. */
export function isOwner(i: Pick<Inbound, 'sender' | 'isGroup'>, route: Route): boolean {
  return !i.isGroup || route.owners.includes(i.sender);
}

/**
 * Commands only an owner may run in a group. They are not read-only: `/new` and `/resume` change
 * which conversation the group is talking to, `/model` and `/effort` change what it costs and kill
 * the running child to apply. Any member who can reach the chat could reach those; the README said
 * otherwise, and only `/sh` was actually gated.
 *
 * `/help` and `/status` stay open: they tell you what you are in, which is the thing a member needs.
 */
export const OWNER_COMMANDS = new Set(['new', 'stop', 'resume', 'model', 'effort', 'sh', 'restart']);
