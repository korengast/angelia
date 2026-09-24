import type { Config, Route } from '../../instance/config/schema.js';
import type { Inbound } from '../types.js';

/** Most specific route wins: a thread-specific route beats a chat-wide one. */
export function matchRoute(cfg: Config, i: Pick<Inbound, 'platform' | 'chat' | 'thread'>): Route | undefined {
  const same = cfg.routes.filter((r) => r.platform === i.platform && r.chat === i.chat);
  return same.find((r) => r.thread !== undefined && r.thread === i.thread) ?? same.find((r) => r.thread === undefined);
}
