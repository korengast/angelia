import { loadConfig } from '../instance/config/load.js';
import { arm, armedList, ARM_HOURS, ARM_HOURS_MAX, bindChat, cancelArmed, connectRefusal, isChatPlatform, untilText, type Armed } from '../instance/connect.js';
import { parseSessionKey } from '../core/types.js';
import type { Config } from '../instance/config/schema.js';
import type { RouteSettings } from '../instance/connect.js';

const ids = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

/** --allow, --owners and --mention: the new route's settings. Takes them out of argv; the rest is returned. */
export function routeFlags(argv: string[], usage: string): { route?: RouteSettings; rest: string[] } {
  const route: RouteSettings = {};
  const rest: string[] = [];
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n];
    if (a !== '--allow' && a !== '--owners' && a !== '--mention') { rest.push(a); continue; }
    const v = argv[++n];
    if (v === undefined) throw new Error(`${a} needs a value\n${usage}`);
    if (a === '--allow') route.allow_from = ids(v);
    else if (a === '--owners') route.owners = ids(v);
    else if (v === 'required' || v === 'any') route.mention = v;
    else throw new Error(`--mention: required or any\n${usage}`);
  }
  return { ...(Object.keys(route).length ? { route } : {}), rest };
}

export const CONNECT_USAGE = [
  'usage: angelia profile connect <profile> whatsapp|telegram [--hours N] [--allow <id,...>] [--owners <id,...>] [--mention required|any]',
  '         the next new chat there (an owner adds the bot, or writes first) goes to <profile>',
  `       angelia profile connect <profile> whatsapp:<chat>|telegram:<chat>   route that chat to <profile> now`,
  '       angelia profile connect --cancel whatsapp|telegram',
  '       angelia profile connect                                            what is armed',
].join('\n');

export interface ConnectWiring {
  stateDir: string;
  /** The routing table on disk. */
  table: string;
  self?: (profile: string) => string;
  /** The daemon log (daemon.ts, logLine), for connect-armed and the rest. */
  log?: (line: string) => void;
  now?: Date;
}

const when = untilText;
const line = (a: Armed) => `${a.platform}: ${a.profile}, until ${when(a.until)}`;

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * The new route's settings that differ from what the onboard: block alone would give, as one line, or
 * empty. `r` is what the route gets: owners in full (the block's and --owners), its allow list and
 * mention. Printed by the command, so a widening by --owners, --allow or --mention is in plain sight
 * (review fix M3): the command is a terminal one, and an agent with a shell can run it too.
 */
function widening(cfg: Config, r: RouteSettings): string {
  const ob = cfg.onboard;
  const owners = ob?.owners ?? [], allow = ob?.allow_from ?? owners, mention = ob?.connect_mention ?? 'required';
  const parts = [
    r.owners && !sameSet(r.owners, owners) && `owners ${r.owners.join(', ')}`,
    r.allow_from && !sameSet(r.allow_from, allow) && `allow_from ${r.allow_from.join(', ')}`,
    r.mention && r.mention !== mention && `mention ${r.mention}`,
  ].filter(Boolean);
  return parts.length ? `Its route differs from the onboard: block: ${parts.join('; ')}.` : '';
}

/** The arm's flags as the route will have them: --owners added to the block's owners. */
const armRoute = (cfg: Config, r: RouteSettings): RouteSettings => ({ ...r, ...(r.owners ? { owners: [...new Set([...(cfg.onboard?.owners ?? []), ...r.owners])] } : {}) });

/** Throw a refusal for a profile that cannot take a chat this way. */
function refuse(cfg: Config, profile: string, platform?: 'whatsapp' | 'telegram'): void {
  const why = connectRefusal(cfg, profile, platform);
  if (why) throw new Error(why);
}

/**
 * `angelia profile connect`: arm a profile for the next new chat on a platform, take an arm back, list
 * them, or route a chat whose id is known to a profile now. Returns what to print.
 */
export async function connectCommand(all: string[], w: ConnectWiring): Promise<string> {
  const { route, rest: argv } = routeFlags(all, CONNECT_USAGE);
  const words: string[] = [];
  let cancel: string | undefined, hours: number | undefined;
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n];
    if (a === '--cancel') { cancel = argv[++n]; if (cancel === undefined) throw new Error(CONNECT_USAGE); }
    else if (a === '--hours') {
      const v = argv[++n];
      hours = Number(v);
      if (v === undefined || !/^\d+$/.test(v) || hours < 1 || hours > ARM_HOURS_MAX) throw new Error(`--hours: a whole number from 1 to ${ARM_HOURS_MAX}\n${CONNECT_USAGE}`);
    } else words.push(a);
  }
  const log = w.log ?? (() => {});
  const now = w.now ?? new Date();

  if (cancel !== undefined) {
    if (words.length || hours !== undefined || route || !isChatPlatform(cancel)) throw new Error(CONNECT_USAGE);
    const gone = cancelArmed(w.stateDir, cancel, now);
    if (!gone) return `Nothing was armed for ${cancel}.`;
    log(`connect-cancelled platform=${cancel} profile=${gone.profile}`);
    return `Cancelled: ${gone.profile} no longer takes the next new ${cancel} chat.`;
  }
  if (!words.length) {
    if (hours !== undefined || route) throw new Error(CONNECT_USAGE);
    const all = armedList(w.stateDir, now);
    return all.length ? all.map(line).join('\n') : 'Nothing is armed. A new chat an owner writes in is handled as defaults.unmatched says.';
  }
  const [profile, target, ...more] = words;
  if (!target || more.length) throw new Error(CONNECT_USAGE);
  const cfg = loadConfig(w.table);
  refuse(cfg, profile, isChatPlatform(target) ? target : undefined);

  if (isChatPlatform(target)) {
    const { armed, replaced } = arm(w.stateDir, { profile, platform: target, hours: hours ?? ARM_HOURS, now, ...(route ? { route } : {}) });
    log(`connect-armed profile=${profile} platform=${target} until=${armed.until}${replaced ? ` replaced=${replaced.profile}` : ''}`);
    return [
      `Armed ${profile} for the next new ${target} chat, until ${when(armed.until)}.${replaced ? ` This replaces ${replaced.profile}, which was armed until ${when(replaced.until)}.` : ''}`,
      // In a group the first message always mentions the bot; the mention setting is for the messages after.
      `Add the bot to the group as an owner: the chat goes to ${profile} at once, with no onboarding. If the add is not seen, write there and mention the bot as an owner: that first message connects it.`,
      ...(armed.route && widening(cfg, armRoute(cfg, armed.route)) ? [widening(cfg, armRoute(cfg, armed.route))] : []),
      `Cancel with: angelia profile connect --cancel ${target}`,
    ].join('\n');
  }

  // A chat whose id is known: routed now, by the same function an armed message uses.
  if (hours !== undefined) throw new Error(`--hours is for arming a platform, not for a chat routed now\n${CONNECT_USAGE}`);
  const { platform, chat, thread } = parseSessionKey(target);
  if (!chat || !isChatPlatform(platform)) throw new Error(CONNECT_USAGE);
  if (thread) throw new Error('profile connect takes a chat, not a topic: a topic gets its own route under the chat\'s profile, by hand (angelia guide routing)');
  if (cfg.routes.some((r) => r.platform === platform && r.chat === chat)) throw new Error(`${target} is already routed`);
  const made = bindChat({ table: w.table, cfg, profile, platform, chat, instance: w.stateDir, self: w.self, now, ...(route ? { route } : {}) });
  log(`connected key=${platform}:${chat} profile=${profile} from=terminal`);
  const git = made.git ? ` Workspace git: ${await made.git}.` : '';
  const r = cfg.routes.find((x) => x.platform === platform && x.chat === chat);
  const wide = r ? widening(cfg, { owners: r.owners, allow_from: r.allow_from, mention: r.mention }) : '';
  return `Connected ${platform}:${chat} to ${profile}.${git}${wide ? `\n${wide}` : ''}\nThe daemon picks it up at the next restart (/restart in a chat you own, or angelia restart).`;
}
