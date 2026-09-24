import type { Profile } from '../instance/config/schema.js';
import type { Brain, BrainOptions, BrainSession, BackendName } from './brain.js';
import { ClaudeBrain } from './claude.js';
import { TuiBrain } from './tui.js';
import { GrokBrain } from './grok.js';
import { profileBin } from './locate.js';

export type { Brain, BrainOptions, BrainSession, BackendName } from './brain.js';
export { BrainExited } from './brain.js';

export { DEFAULT_BIN, locateBin, cliWarnings, pathWithBins, profileBin } from './locate.js';

export function createBrain(profile: Profile, session: BrainSession, opts: BrainOptions = {}): Brain {
  const o = { ...opts, bin: opts.bin ?? profileBin(profile) };
  switch (profile.backend) {
    case 'grok': return new GrokBrain(profile, session, o);
    default: return profile.tui ? new TuiBrain(profile, session, o) : new ClaudeBrain(profile, session, o);
  }
}
