import type { Orchestrator } from '../../core/orchestrator.js';
import type { Config } from '../../instance/config/schema.js';
import { profilesDetail } from '../../instance/profiles.js';
import { jobsView } from '../../jobs/jobs-view.js';
import type { ApiDeps } from './server.js';

/** What the API does, in the orchestrator's terms. One place, used by the daemon and its tests, so a
 *  test cannot pass on wiring of its own that the daemon does not have. */
export function apiDeps(orch: Orchestrator, cfg: Config, status: () => unknown, stateDir?: string): ApiDeps {
  return {
    send: (key, text, fromKey) => orch.notify(key, text, fromKey),
    turn: (key, text, fromAgent, fromKey, surface, turnId, media) => orch.injectTurn(key, text, fromAgent, fromKey, 'scheduled', surface, turnId, media),
    attach: (key, paths) => orch.attach(key, paths),
    command: (key, name) => orch.appCommand(key, name),
    routed: (key) => orch.routed(key),
    queueFull: (key) => orch.queueFull(key),
    ask: (key, text, fromKey, signal) => orch.ask(key, text, fromKey, signal),
    handoff: (req) => orch.handoff(req),
    peerAllowed: (kind, from, to) => orch.peerAllowed(kind, from, to),
    reach: (from, to) => orch.reach(from, to),
    sendMedia: (key, m, byOwner) => orch.sendMediaTo(key, m, byOwner),
    events: (fn) => orch.onEvent(fn),
    answerPermission: (key, id, allow) => orch.answerPermission(key, id, allow),
    status,
    profiles: () => profilesDetail(cfg, { version: 1, chats: Object.fromEntries(orch.map.keys().map((k) => [k, { active: orch.map.getActive(k)?.id ?? null, history: orch.map.list(k, Number.MAX_SAFE_INTEGER) }])) }),
    sessions: (key) => orch.sessionsOf(key),
    history: (key, session, limit, before) => orch.historyOf(key, session, limit, before),
    permissions: () => orch.waitingPermissions(),
    jobs: (profile) => (stateDir && Object.hasOwn(cfg.profiles, profile) ? jobsView(cfg, profile, stateDir) : undefined),
  };
}
