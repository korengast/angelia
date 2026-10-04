import type { Orchestrator } from '../../core/orchestrator.js';
import type { ApiDeps } from './server.js';

/** What the API does, in the orchestrator's terms. One place, used by the daemon and its tests, so a
 *  test cannot pass on wiring of its own that the daemon does not have. */
export function apiDeps(orch: Orchestrator): ApiDeps {
  return {
    send: (key, text, fromKey) => orch.notify(key, text, fromKey),
    turn: (key, text, fromAgent, fromKey) => orch.injectTurn(key, text, fromAgent, fromKey),
    routed: (key) => orch.routed(key),
    queueFull: (key) => orch.queueFull(key),
    handoff: (req) => orch.handoff(req),
    peerAllowed: (kind, from, to) => orch.peerAllowed(kind, from, to),
    ask: (key, text, fromKey, signal) => orch.ask(key, text, fromKey, signal),
    reach: (from, to) => orch.reach(from, to),
    sendMedia: (key, m, byOwner) => orch.sendMediaTo(key, m, byOwner),
  };
}
