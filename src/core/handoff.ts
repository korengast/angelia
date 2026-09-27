import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import type { Config } from '../instance/config/schema.js';

/** A handoff that cannot go ahead; the message is for the person at the terminal, as is. */
export class HandoffError extends Error {}

/**
 * Where `/angelia-handoff` sends a terminal session.
 * - `session`: the folder is a Claude Code profile's own, so the session itself moves to its chat.
 * - `brief`: any other folder. The session stays in the terminal; the chat's agent gets a written brief
 *   and the project's path in a fresh session. `via` says why this profile: the folder is its own (on
 *   another CLI), it lies inside the profile's add_dirs, or the table's handoff profile catches the rest.
 */
export interface HandoffTarget {
  mode: 'session' | 'brief';
  profile: string;
  via: 'folder' | 'add_dirs' | 'default';
  /** Session keys of the chats routed to the profile, in table order. */
  chats: string[];
  /** The chat to use when none is named: the table's handoff chat, when it is one of these. */
  preferred?: string;
}

export function handoffTarget(cfg: Config, cwd: string): HandoffTarget {
  const here = real(cwd);
  const names = Object.keys(cfg.profiles);
  const { profile: fallback, chat } = handoffDefault(cfg);
  const own = closest(names.map((n) => ({ n, dirs: [cfg.profiles[n].cwd] })), here);
  if (own) {
    const mode = cfg.profiles[own].backend === 'claude-code' ? 'session' : 'brief';
    return withChats(cfg, { mode, profile: own, via: 'folder' }, chat);
  }
  const reach = closest(names.map((n) => ({ n, dirs: cfg.profiles[n].add_dirs })), here, fallback);
  if (reach) return withChats(cfg, { mode: 'brief', profile: reach, via: 'add_dirs' }, chat);
  if (!fallback) throw new HandoffError(`${here} belongs to no profile, and the routing table names no handoff profile for other folders. Set defaults.handoff to one (a profile, or a chat like whatsapp:<id>), then angelia restart.`);
  return withChats(cfg, { mode: 'brief', profile: fallback, via: 'default' }, chat);
}

/** `defaults.handoff` read: a profile name, or a chat (`platform:chat`) that stands for its profile. */
export function handoffDefault(cfg: Config): { profile?: string; chat?: string } {
  const v = cfg.defaults.handoff;
  if (!v) return {};
  if (!/^(whatsapp|telegram):/.test(v)) {
    if (!cfg.profiles[v]) throw new HandoffError(`defaults.handoff names profile "${v}", which the routing table does not have.`);
    return { profile: v };
  }
  const route = cfg.routes.find((r) => routeKey(r) === v);
  if (!route) throw new HandoffError(`defaults.handoff names chat ${v}, which no route has.`);
  return { profile: route.profile, chat: v };
}

/** The chat to hand over to: the only one, or the one `selector` names (1-based, or a session key). */
export function pickChat(t: HandoffTarget, selector?: string): string {
  if (!selector && t.preferred) return t.preferred;
  if (selector) {
    const hit = /^\d+$/.test(selector) ? t.chats[Number(selector) - 1] : t.chats.find((k) => k === selector);
    if (!hit) throw new HandoffError(`No chat ${selector} for profile ${t.profile}.\n${chatList(t)}`);
    return hit;
  }
  if (t.chats.length === 1) return t.chats[0];
  throw new HandoffError(`Profile ${t.profile} has ${t.chats.length} chats. Pick one: /angelia-handoff <number>\n${chatList(t)}`);
}

export function chatList(t: HandoffTarget): string {
  return t.chats.map((k, n) => `${n + 1}. ${k}`).join('\n');
}

/** What the target's agent reads as the first turn of its fresh session. */
export function briefTurn(project: string, brief: string): string {
  return [
    'Handoff from a terminal session on this machine: the owner moves the work below to this chat and goes on here.',
    `Project: ${project}`,
    '',
    brief.trim(),
    '',
    'Work on that project in its folder. Reply with one short line: what you picked up, and the next step. Then wait for the owner.',
  ].join('\n');
}

function withChats(cfg: Config, t: Omit<HandoffTarget, 'chats'>, preferred?: string): HandoffTarget {
  const chats = [...new Set(cfg.routes.filter((r) => r.profile === t.profile).map(routeKey))];
  if (!chats.length) throw new HandoffError(`Profile ${t.profile} has no chat routed to it, so there is nowhere to continue.`);
  return { ...t, chats, ...(preferred && chats.includes(preferred) ? { preferred } : {}) };
}

function routeKey(r: Config['routes'][number]): string {
  return r.thread ? `${r.platform}:${r.chat}:${r.thread}` : `${r.platform}:${r.chat}`;
}

/** The profile with the deepest folder that holds `here`. A tie goes to `prefer`, else the first in the table. */
function closest(list: { n: string; dirs: string[] }[], here: string, prefer?: string): string | undefined {
  let best: { n: string; depth: number } | undefined;
  for (const { n, dirs } of list) {
    for (const d of dirs) {
      const root = real(d);
      if (here !== root && !here.startsWith(root.endsWith(sep) ? root : root + sep)) continue;
      if (!best || root.length > best.depth || (root.length === best.depth && n === prefer)) best = { n, depth: root.length };
    }
  }
  return best?.n;
}

/** The folder as the file system names it: /tmp and /private/tmp are one folder on a Mac. */
function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}
