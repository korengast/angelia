import { homedir } from 'node:os';
import type { Profile } from '../instance/config/schema.js';
import { agyArgv } from './argv.js';
import { agyGeminiDir } from './cache.js';
import { acpReplay } from './grok-history.js';
import type { HistoryItem } from './history.js';
import { SANDBOX_EXEC } from './pi-gate.js';
import { AgyBrain, agyPolicy, agySandboxed, agySandboxProfile, agySeedLogin } from './agy.js';
import { agyLaunchProblems } from './agy-instructions.js';
import { readGuard } from '../capabilities/compile.js';

/** A load of an agy session took about 2 s with its start (agy 1.5.14); a cold start up to 20 s. */
export const AGY_REPLAY_TIMEOUT_MS = 45_000;

/**
 * An agy session's conversation, for /history and the app: `agy acp` started on the profile's own
 * --gemini-dir, in the same sandbox as the chat's agy, `session/load`, keep what it replays, stop it.
 * No model is called. The conversation store is protobuf in SQLite (antigravity-cli/conversations/
 * <id>.db), which nothing here reads without a new dependency, so the replay is the reader.
 * Refused, like a chat's start, when agy would load what Angelia did not give it (agyLaunchProblems).
 */
export function agyReplay(profile: Profile, sessionId: string, o: { stateDir: string; profileName: string; bin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; geminiDir?: string }): Promise<{ items: HistoryItem[]; cut: boolean } | undefined> {
  const gd = o.geminiDir ?? agyGeminiDir(o.stateDir, o.profileName);
  const problems = agyLaunchProblems(profile.cwd, profile.add_dirs, gd, readGuard(o.stateDir, o.profileName)?.agy?.skills ?? []);
  if (problems.length) return Promise.reject(new Error(`agy not started: ${problems.join('; ')}`));
  if (agySandboxed(profile)) agySeedLogin(gd, AgyBrain.readLogin);
  const line = agyArgv(profile, gd, o.bin ?? 'agy');
  const argv = agySandboxed(profile)
    ? [SANDBOX_EXEC, '-p', agySandboxProfile(agyPolicy(profile), gd, homedir(), { closeSiblings: !o.geminiDir }), ...line]
    : line;
  return acpReplay(argv, profile.cwd, sessionId, { env: o.env, timeoutMs: o.timeoutMs ?? AGY_REPLAY_TIMEOUT_MS });
}
