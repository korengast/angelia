import type { Orchestrator } from '../../core/orchestrator.js';
import type { Config } from '../../instance/config/schema.js';
import { profilesDetail } from '../../instance/profiles.js';
import { jobsView } from '../../jobs/jobs-view.js';
import { homedir } from 'node:os';
import { agentDenyRules } from '../../capabilities/compile.js';
import { parseRules, withIdCache } from '../../brain/pi-gate.js';
import { deniedChecker } from '../../core/deliver/media.js';
import { listProfileFolder, readInstructions, readProfileFile, type Hidden } from '../../instance/profile-files.js';
import { capabilitiesView, memoryView, readSkill, skillsView } from '../../instance/profile-views.js';
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
    // The profile views need the state folder (the profile's deny rules, the credential places):
    // without one, as in a bare test, they are absent rather than read from the real instance.
    instructions: (profile) => view(cfg, profile, stateDir, (sd) => readInstructions(cfg.profiles[profile].cwd, cfg.profiles[profile].backend, hiddenFor(cfg, profile, sd))),
    files: (profile, path) => view(cfg, profile, stateDir, (sd) => listProfileFolder(cfg.profiles[profile].cwd, path, hiddenFor(cfg, profile, sd))),
    file: (profile, path) => view(cfg, profile, stateDir, (sd) => readProfileFile(cfg.profiles[profile].cwd, path, hiddenFor(cfg, profile, sd))),
    memory: (profile) => view(cfg, profile, stateDir, (sd) => memoryView(cfg.profiles[profile].cwd, cfg.profiles[profile].backend, hiddenFor(cfg, profile, sd))),
    skills: (profile) => view(cfg, profile, stateDir, (sd) => skillsView(cfg, profile, hiddenFor(cfg, profile, sd), homedir(), rulesFor(cfg, profile, sd))),
    skill: (profile, name) => view(cfg, profile, stateDir, (sd) => readSkill(cfg, profile, name, hiddenFor(cfg, profile, sd), homedir(), rulesFor(cfg, profile, sd))),
    capabilities: (profile) => (Object.hasOwn(cfg.profiles, profile) ? capabilitiesView(cfg, profile) : undefined),
  };
}

/** Only the profile's own `Read(...)` deny rules (for the skills folder of its CLI in the home). */
function rulesFor(cfg: Config, profile: string, stateDir: string, home = homedir()): Hidden {
  const rules = parseRules(agentDenyRules(cfg, profile, stateDir, home), home).filter((r) => r.tool === 'Read');
  return (path) => rules.some((r) => r.test(path));
}

/** What a client of the owner's API is never shown of a profile's folder: credential places, and what
 *  the profile's own `Read(...)` deny rules keep its agent out of. */
function hiddenFor(cfg: Config, profile: string, stateDir: string, home = homedir()): Hidden {
  const rules = parseRules(agentDenyRules(cfg, profile, stateDir, home), home).filter((r) => r.tool === 'Read');
  const credential = deniedChecker(home, stateDir);
  return (path) => credential(path) || rules.some((r) => r.test(path));
}

/** One view request: the file id caches on for its whole run (a listing checks every entry against
 *  the same places), and only for a profile that exists, with a state folder (else undefined). */
function view<T>(cfg: Config, profile: string, stateDir: string | undefined, fn: (stateDir: string) => T): T | undefined {
  if (!stateDir || !Object.hasOwn(cfg.profiles, profile)) return undefined;
  return withIdCache(() => fn(stateDir));
}
