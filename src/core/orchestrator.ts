import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { Config, Profile } from '../instance/config/schema.js';
import type { Inbound, BrainEvent, Platform, SessionRow } from './types.js';
import { cleanName, cleanText, isGroupChat, parseSessionKey, sessionKey } from './types.js';
import { matchRoute } from './router/match.js';
import { gate, isOwner, OWNER_COMMANDS } from './router/gate.js';
import { SessionMap } from './session/map.js';
import { KeyedQueue } from './session/queue.js';
import { createBrain, locateBin, profileBin, type Brain, type BackendName } from '../brain/index.js';
import { projectsDir } from '../brain/transcripts.js';
import { START_EXIT } from '../brain/tui.js';
import { claudeHistory, claudeTranscriptFor, piHistory, type HistoryItem, type HistoryPage } from '../brain/history.js';
import { grokPage, grokReplay } from '../brain/grok-history.js';
import { codexCursorFor, codexHistory } from '../brain/codex-history.js';
import { claudeTerminalLine, remoteControlName } from '../brain/argv.js';
import { AskError, claudeAskArgv, codexAskArgv, fileAnswer, piAskArgv, piSessionFile, runAsk, textAnswer, type AskReader } from '../brain/ask.js';
import { gatePath, piPolicy, piSandboxed } from '../brain/pi.js';
import { profileCacheDir } from '../brain/cache.js';
import { chunk, LIMITS } from './deliver/chunk.js';
import { assertOrigin, extractMediaTags, resolveMedia, snapshotMedia, MediaError, type Media, type MediaRequest } from './deliver/media.js';
import { ProgressOutbox, RateLimiter } from './deliver/rate.js';
import { failureLine, isLimitText, limitHint, UNMATCHED_LINE, NOT_OWNER_LINE, LATE_ANSWER_LINE, permissionLine, parsePermissionReply, PERMISSION_TIMEOUT_LINE } from './deliver/text.js';
import { parseCommand, HELP, statusText, resumeListText, type AppCommand } from './commands.js';
import { briefTurn, handoffTarget, HandoffError, pickChat } from './handoff.js';
import { runShell } from './shell.js';
import { catalog as askCatalog, effortsFor, LABELS, type Catalog } from '../brain/catalog.js';
import { profileEnv, tableSecrets, type ChildEnv } from './env.js';
import { capabilityEnv } from '../capabilities/resolve.js';
import { agentDenyRules, profilePermissions } from '../capabilities/compile.js';
import { API_SOCKET } from '../instance/instance.js';
import { MAX_INBOUND, saveInbound } from '../adapters/inbox.js';
import type { ChatEventBody, ChatListener } from './events.js';

export interface Sender {
  send(chat: string, text: string, thread?: string): Promise<void>;
  /** Attach a file that already passed `resolveMedia`. Absent on an adapter that cannot. */
  sendMedia?(chat: string, m: Media, thread?: string): Promise<void>;
  typing?(chat: string, on: boolean): Promise<void>;
  /** The chat's own name (a group's subject), for naming a new profile. */
  chatName?(chat: string): Promise<string | undefined>;
}

/** A profile made for a new chat: its name, the first turn's prompt, and the workspace commit, which settles later. */
export interface Onboarded { name: string; prompt: string; git?: Promise<string> }
/** A backend switch: what was removed from the profile's folder, and notes for the owner. */
export interface Switched { removed: string[]; notes: string[] }

export interface OrchestratorOptions {
  /** Tests: how often a running turn is checked for a stall (default a minute). */
  stallTickMs?: number;
  /** Tests: the waits between attempts at a send that failed (default SEND_RETRY_MS). */
  sendRetryMs?: number[];
  /** Tests: the random gap between the chunks of one long answer (default 1.5 to 4 s). */
  chunkGapMs?: [number, number];
  stateDir?: string;
  /** Executable per backend, when not the default on PATH (tests, odd installs). */
  bins?: Partial<Record<BackendName, string>>;
  /** Claude Code's projects folder, for placing transcripts before a resume (brain.ts). `true` means the
   *  real one; absent (tests) means no placement and no fresh start for a lost conversation. */
  transcripts?: true | string;
  /** Tests: the home folder where pi keeps its sessions (default the real one). */
  cliHome?: string;
  env?: NodeJS.ProcessEnv;
  /** What `~/.angelia/env` holds. Kept here and never put in `process.env`: a child gets only the
   *  variables its own profile's capabilities declare (core/env.ts). */
  secrets?: Record<string, string>;
  /** The API token for one chat's agent (api/server.ts), put in its environment as ANGELIA_API_TOKEN. */
  sessionToken?: (key: string) => string;
  /** Why a profile's agent may not start (capabilities/compile.ts, launchCheck): never compiled, or a
   *  protection its last compile wrote is gone. Asked before a session starts; anything listed stops it. */
  launchGuard?: (profile: string) => string[];
  log?: (line: string) => void;
  /** The self-awareness prompt for a profile, by name (self.ts). Absent in tests: agents get none. */
  selfPrompt?: (profileName: string) => string;
  /** /restart. check() loads the routing table and returns its error, if any; launch() starts the
   *  detached restart. Absent in tests and anywhere the daemon cannot restart itself. */
  restart?: {
    check(): string | undefined; launch(key: string): void;
    /** The table's changes since the owner last accepted it, one line each (`angelia accept --check`);
     *  throws when that cannot be told. accept() takes the table, only while its changes still have the
     *  fingerprint given (instance/accepted.ts); returns its error, if any. */
    wider?(): { lines: string[]; fingerprint: string }; accept?(fingerprint: string): string | undefined;
  };
  /** defaults.unmatched: onboard. Makes the profile and route for a new chat, adds them to the live
   *  config, and returns the new profile's name and the prompt for its first turn (onboard.ts). */
  onboard?: (i: Inbound, chatName?: string) => Onboarded | Promise<Onboarded>;
  /** /backend: moves a profile to another CLI in the table, compiled, and in the live config (switch-backend.ts). */
  switchBackend?: (profile: string, backend: BackendName) => Switched | Promise<Switched>;
  /** What a backend offers for /model and /effort (catalog.ts); a test passes its own. */
  catalog?: (backend: BackendName, bin: string | undefined, env: NodeJS.ProcessEnv) => Promise<Catalog>;
}

type TurnOptions = { bare?: boolean; preface?: string; retried?: boolean; follow?: AsyncGenerator<BrainEvent> };

/** The backends /backend offers. */
const SWITCHABLE: BackendName[] = ['claude-code', 'grok', 'codex', 'pi'];
/** How long a CLI's model list is reused before it is asked again. */
const CATALOG_MS = 10 * 60_000;

const DROP_LOG_MS = 10 * 60_000;
/** Messages that may wait behind a chat's running turn. Past it, the chat is told once, and the rest dropped. */
const QUEUE_MAX = 10;
/** The waits between attempts at a failed send: about two minutes in all, enough for a reconnect. */
const SEND_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Undelivered answers kept per chat. */
const OWED_MAX = 5;
/** Questions (`angelia ask`) one chat answers at the same time; each is a CLI process. */
const ASK_MAX = 2;
/** Questions answered at the same time across all chats. */
const ASK_TOTAL = 4;
/** The tail of a /stop or /new answer that also took back waiting messages. */
function waitingDropped(n: number): string {
  return n ? ` ${n} waiting message${n === 1 ? '' : 's'} dropped.` : '';
}
const BUSY_LINE = 'Still working through earlier messages in this chat, so this one was not taken. Send it again when I have answered.';
/** More chunks than this and an answer goes as its start plus a file. */
const LONG_ANSWER_PARTS = 4;
/** Messages one chat's agent may send another profile's chat in an hour. */
const PEER_PER_HOUR = 30;
/** How long a replayed grok conversation is served from memory when no turn of its chat ended. */
const GROK_HISTORY_TTL_MS = 10 * 60_000;
/** History readers that start a CLI, at once, in the whole daemon. */
const HISTORY_SLOTS = 2;

/** A history the CLI could not give (it did not answer, or does not know the session); `status` for the API. */
export class HistoryError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}
/** One page of a chat's history as the API sends it. `supported: false` for a CLI Angelia cannot read yet. */
export type ChatHistory = HistoryPage & { session: string | null; supported: boolean };

/** inbound -> route -> gate -> command or turn -> deliver. One instance per daemon. */
/** The profile as one session runs it: its /model and /effort overrides on top. */
function withOverrides(p: Profile, row: SessionRow): Profile {
  return { ...p, ...(row.model ? { model: row.model } : {}), ...(row.effort ? { effort: row.effort as Profile['effort'] } : {}) };
}

export class Orchestrator {
  readonly map: SessionMap;
  private queue = new KeyedQueue();
  private brains = new Map<string, Brain>();
  /** Brains let go of without ending them (an idle reap): a tmux pane keeps running and the next
   *  message reattaches it by name. Kept here so that /new, /resume or a backend switch in between
   *  ends the pane too, instead of leaving it running with nobody to reach it. */
  private parked = new Map<string, Brain>();
  /** Sessions a handoff moved a chat away from while their turn ran, by session id. Their panes go on
   *  with nobody reading them until the turn is over, or `/resume` takes one back (handoff). */
  private background = new Map<string, { key: string; brain: Brain }>();
  /** When each chat last messaged each other chat (reach). */
  private peerSends = new Map<string, number[]>();
  /** Chats told their queue is full, until one message gets in again. */
  private busyTold = new Set<string>();
  /** One outbound bucket per platform: a busy Telegram chat must not slow WhatsApp down. */
  private rates = new Map<Platform, RateLimiter>();
  private unmatchedNotified = new Map<string, number>();
  /** Drop lines per chat and reason: when the last one was written, and how many were held back since. */
  private drops = new Map<string, { at: number; held: number }>();
  /** Bumped every time a session is deliberately dropped (/stop, /new, /model, a resume). A turn
   *  that was running at the time sees its era go stale, and knows the failure it is about to
   *  report was the user pulling the plug rather than the agent crashing. */
  private era = new Map<string, number>();
  /** The grants /restart last listed per chat, so /restart confirm accepts only what the owner saw. */
  private shownWider = new Map<string, string>();
  /** Answers a chat could not be sent, to go out with the next thing it is told (at most OWED_MAX). */
  private owed = new Map<string, string[]>();
  private catalogs = new Map<string, { at: number; c: Catalog }>();
  /** Clients watching the chats live (the API's event stream), and the message each chat's running
   *  turn answers, so a permission answered from a client can tell the chat it was. */
  private listeners = new Set<ChatListener>();
  private running = new Map<string, Inbound>();
  /** Questions being answered per chat (`ask`), each in its own read-only copy. */
  private asking = new Map<string, number>();
  /** Every question being answered, to stop at shutdown. */
  private questions = new Set<AbortController>();
  /** Each chat's open permission requests by full id, so an answer by prefix (the chat's `y abcde`)
   *  is evented under the id the client was given, and a client that connects later can list them. */
  private asks = new Map<string, Map<string, WaitingPermission>>();
  private log: (line: string) => void;

  constructor(private readonly cfg: Config, private readonly senders: Partial<Record<Platform, Sender>>, private readonly opts: OrchestratorOptions = {}) {
    const dir = opts.stateDir ?? join(homedir(), '.angelia');
    this.log = opts.log ?? (() => {});
    this.map = new SessionMap(join(dir, 'sessions.json'), (line) => this.log(line));
  }

  async handle(raw: Inbound): Promise<void> {
    const i = { ...raw, text: cleanText(raw.text), ...(raw.senderName !== undefined ? { senderName: cleanText(raw.senderName) } : {}) };
    const g = gate(i, matchRoute(this.cfg, i));
    const key = sessionKey(i);
    if (!g.ok) {
      if (g.reason === 'unmatched' && this.cfg.defaults.unmatched === 'onboard' && this.opts.onboard && !parseCommand(i.text)
        && !this.cfg.onboard?.skip.includes(`${i.platform}:${i.chat}`)) {
        // Only an owner makes a new profile. Anyone can add the bot's number to a group. And in a
        // group the message must address the bot, as the new route will (onboard.mention, required by
        // default): an owner chatting in a group the bot happens to be in must not wake up to a new
        // profile. With mention: any the owner wants the bot to answer every message there anyway.
        if (!this.cfg.onboard?.owners.includes(i.sender)) { this.dropped(key, `reason=unmatched-not-owner sender=${i.sender}`); return; }
        if (i.isGroup && !i.mentioned && this.cfg.onboard?.mention !== 'any') { this.dropped(key, 'reason=unmatched-not-mentioned'); return; }
        return this.queue.enqueue(key, () => this.onboard(i, key));
      }
      // The sender is named when it is the reason, so an allow list missing someone can be fixed.
      this.dropped(key, `reason=${g.reason}${g.reason === 'sender' ? ` sender=${i.sender}` : ''}`);
      if (g.reason === 'unmatched' && this.cfg.defaults.unmatched === 'reply') await this.notifyUnmatched(i);
      return;
    }
    const { route } = g;
    const profile = this.cfg.profiles[route.profile];
    const perm = parsePermissionReply(i.text);
    if (perm) {
      const b = this.brains.get(key);
      if (b?.hasPendingPermission(perm.id)) {
        if (!isOwner(i, route)) { this.log(`permission reply ignored key=${key} sender=${i.sender} reason=not-owner`); return this.reply(i, NOT_OWNER_LINE); }
        const full = this.askId(key, perm.id);
        if (b.answerPermission(perm.id, perm.allow)) this.answered(key, full ?? perm.id, perm.allow, 'chat');
        else return this.reply(i, LATE_ANSWER_LINE);
        return;
      }
    }
    const cmd = parseCommand(i.text);
    if (cmd && OWNER_COMMANDS.has(cmd.name) && !isOwner(i, route)) {
      this.log(`${cmd.name} refused key=${key} sender=${i.sender} reason=not-owner`);
      return this.reply(i, NOT_OWNER_LINE);
    }
    if (cmd?.name === 'sh') return this.shell(i, key, route.profile, profile, cmd.script);
    if (cmd) return this.command(i, key, route.profile, cmd, isOwner(i, route));
    // A slash at the start goes to the CLI as its own command (`/compact`, `/clear`, `/add-dir`, a
    // custom one) only from an owner, or for a command the profile opens to everyone. From anyone else
    // it is a message like any other, in the envelope: in tmux mode the CLI's commands reach plugins,
    // MCP, permissions and the user-wide default model.
    const bare = isAgentCommand(i) && (isOwner(i, route) || profile.agent_commands.includes(agentCommandName(i.text)));
    if (isAgentCommand(i) && !bare) this.log(`agent command sent as text key=${key} sender=${i.sender} reason=not-owner`);
    if (this.queueFull(key)) {
      // One chat cannot line up an hour of turns, each drawing on the platform's one bucket; said once per pile-up.
      this.dropped(key, 'reason=queue-full');
      if (!this.busyTold.has(key)) { this.busyTold.add(key); await this.reply(i, BUSY_LINE); }
      return;
    }
    this.busyTold.delete(key);
    await this.queue.enqueue(key, () => this.turn(i, key, route.profile, { bare }));
  }

  private async command(i: Inbound, key: string, profileName: string, cmd: NonNullable<ReturnType<typeof parseCommand>>, owner: boolean): Promise<void> {
    switch (cmd.name) {
      case 'help': return this.reply(i, HELP);
      case 'restart': {
        if (!this.opts.restart) return this.reply(i, 'This daemon cannot restart itself. Run angelia restart from a terminal.');
        const err = this.opts.restart.check();
        // A table that does not load would leave nothing running and nothing to reply with.
        if (err) return this.reply(i, `Not restarting: the routing table does not load.\n${err}`);
        // The daemon runs on the table the owner accepted, and an agent with the workspace in its
        // add_dirs can edit the table: show the changes, and take them on /restart confirm, which
        // accepts exactly what was shown (instance/accepted.ts).
        if (this.opts.restart.wider) {
          let wider: string[], fingerprint: string;
          try { ({ lines: wider, fingerprint } = this.opts.restart.wider()); } catch (e) { return this.reply(i, `Not restarting: could not compare the table with what you accepted.\n${(e as Error).message}`); }
          const shown = wider.join('\n');
          if (wider.length && (cmd.value?.toLowerCase() !== 'confirm' || this.shownWider.get(key) !== shown)) {
            this.shownWider.set(key, shown);
            return this.reply(i, `Not restarting yet. The routing table changed since you last accepted it:\n${wider.map((l) => `• ${l}`).join('\n')}\nIf you made these changes, send /restart confirm to accept them and restart.`);
          }
          this.shownWider.delete(key);
          if (wider.length) {
            const no = this.opts.restart.accept?.(fingerprint);
            if (no) return this.reply(i, `Not restarting: accepting the table failed.\n${no}`);
            this.log(`table accepted key=${key} sender=${i.sender}: ${wider.join('; ')}`);
          }
        }
        const busy = [...this.brains.entries()].filter(([k, b]) => k !== key && b.alive).length;
        this.log(`restart requested key=${key} sender=${i.sender}`);
        await this.reply(i, `Routing table ok. Restarting now; I will post here when I am back.${busy ? ` ${busy} other running session${busy > 1 ? 's' : ''} will be cut and resume on the next message.` : ''}`);
        this.opts.restart.launch(key);
        return;
      }
      case 'status': return this.reply(i, this.statusOf(key, profileName, owner));
      case 'new': { const n = this.queue.drop(key); return this.reply(i, await this.newSession(key) + waitingDropped(n)); }
      case 'stop': { const n = this.queue.drop(key); return this.reply(i, await this.stop(key) || n ? 'Stopped.' + waitingDropped(n) : 'Nothing running.'); }
      case 'model': return this.modelCommand(i, key, profileName, cmd.value);
      case 'effort': return this.effortCommand(i, key, profileName, cmd.value);
      case 'backend': return this.backendCommand(i, key, profileName, cmd.value);
      case 'resume': {
        if (!cmd.selector) return this.reply(i, resumeListText(this.map, key));
        await this.dropBrain(key);
        const row = this.map.setActive(key, cmd.selector);
        if (!row) return this.reply(i, 'No such session.');
        const bg = this.background.get(row.id);
        if (!bg || bg.key !== key || !bg.brain.follow) return this.reply(i, `Resumed ${row.id.slice(0, 8)} · ${row.label || '(no label)'}`);
        // Its turn still runs: read it here again, so a waiting permission can be answered and the answer arrives.
        this.background.delete(row.id);
        this.map.setBackground(key, row.id, null);
        const follow = bg.brain.follow();
        this.brains.set(key, bg.brain);
        this.log(`background taken back key=${key} session=${row.id.slice(0, 8)}`);
        await this.reply(i, `Resumed ${row.id.slice(0, 8)} · ${row.label || '(no label)'}. Its turn is still running; the answer comes here.`);
        return this.queue.enqueue(key, () => this.turn(i, key, profileName, { follow }));
      }
    }
  }

  /** `owner`: also the line that resumes a Claude Code session at a terminal. It names folders on
   *  this machine, and /status is open to everyone in a group. */
  private statusOf(key: string, profileName: string, owner: boolean): string {
    const row = this.map.getActive(key);
    const p = this.cfg.profiles[profileName];
    const terminal = owner && row?.started && p && (row.backend ?? p.backend) === 'claude-code'
      ? claudeTerminalLine(withOverrides(p, row), row.id)
      : undefined;
    return statusText(this.map, key, profileName, this.brains.get(key)?.alive ?? false, this.queue.queued(key), terminal);
  }

  private async newSession(key: string): Promise<string> {
    await this.dropBrain(key);
    return `New session ${this.map.startNew(key).id.slice(0, 8)} started.`;
  }

  /** End the chat's agent, and with it any turn it runs. False when nothing was running. */
  private async stop(key: string): Promise<boolean> {
    if (!this.brains.get(key)?.alive) return false;
    await this.dropBrain(key);
    return true;
  }

  /**
   * /new, /stop or /status pressed in the desk app. The answer goes back to the app. A change the
   * chat would otherwise not understand (its session replaced, its turn cut) is also said there.
   * Not queued, as in the chat: a /stop must not wait behind the turn it stops.
   */
  async appCommand(key: string, name: AppCommand): Promise<string> {
    const profile = this.profileName(key);
    if (!profile) throw new Error(`not a routed chat: ${key}`);
    const tell = (line: string) => this.notify(key, line).catch((e) => this.log(`app command note failed key=${key} ${(e as Error).message}`));
    this.log(`app command key=${key} ${name}`);
    switch (name) {
      case 'status': return this.statusOf(key, profile, true);
      case 'new': {
        const n = this.queue.drop(key);
        const said = await this.newSession(key);
        await tell(`${said.slice(0, -1)} from the desk app.${waitingDropped(n)}`);
        return said + waitingDropped(n);
      }
      case 'stop': {
        const chatTurn = this.running.get(key)?.surface !== 'app' && this.running.has(key);
        const n = this.queue.drop(key);
        if (!await this.stop(key) && !n) return 'Nothing running.';
        if (chatTurn || n) await tell('Stopped from the desk app.' + waitingDropped(n));
        return 'Stopped.' + waitingDropped(n);
      }
    }
  }

  /** A drop line, at most one per chat and reason every ten minutes, with the count it held back: a
   *  stranger who writes all day must not fill the disk one line per message. */
  private dropped(key: string, what: string): void {
    const at = Date.now(), k = `${key} ${what}`, seen = this.drops.get(k);
    if (seen && at - seen.at < DROP_LOG_MS) { seen.held++; return; }
    if (this.drops.size >= 1000) this.drops.clear();
    this.drops.set(k, { at, held: 0 });
    this.log(`drop key=${key} ${what}${seen?.held ? ` (+${seen.held} more since the last line)` : ''}`);
  }

  /** First message from an owner in an unknown chat: make its profile, then run the turn with the onboarding prompt. */
  private async onboard(i: Inbound, key: string): Promise<void> {
    // A second message that queued behind the first finds the route already made.
    const route = matchRoute(this.cfg, i);
    if (route) return this.turn(i, key, route.profile, { bare: isAgentCommand(i) });
    let made: Onboarded;
    try {
      const chatName = await this.senders[i.platform]?.chatName?.(i.chat).catch(() => undefined);
      made = await this.opts.onboard!(i, chatName);
    } catch (e) {
      this.log(`onboard failed key=${key} ${(e as Error).message}`);
      return this.reply(i, `Could not set up an agent for this chat: ${(e as Error).message}`);
    }
    this.log(`onboarded key=${key} profile=${made.name}`);
    const name = made.name;
    void made.git?.then((g) => this.log(`onboard git key=${key} profile=${name} ${g}`));
    await this.reply(i, `New chat. I made a profile for it, named ${made.name}. Its agent will ask what this chat is for.`);
    return this.turn(i, key, made.name, { preface: made.prompt });
  }

  /** The backend's catalog, asked of the CLI at most every ten minutes. Kept per profile: a CLI lists
   *  the models its keys reach, and each profile is given its own keys. */
  private async catalogFor(profileName: string): Promise<Catalog> {
    const p = this.cfg.profiles[profileName];
    const bin = this.binFor(p);
    const k = `${profileName} ${p.backend} ${bin ?? ''}`;
    const hit = this.catalogs.get(k);
    if (hit && Date.now() - hit.at < CATALOG_MS) return hit.c;
    const c = await (this.opts.catalog ?? askCatalog)(p.backend, bin, this.childEnv(profileName).env);
    if (c.models.length) this.catalogs.set(k, { at: Date.now(), c });
    return c;
  }

  /** What this chat runs with now, and where that comes from. */
  private current(key: string, profileName: string, what: 'model' | 'effort'): { value?: string; from: string } {
    const row = this.map.getActive(key);
    if (row?.[what]) return { value: row[what], from: 'this session' };
    const v = this.cfg.profiles[profileName]?.[what];
    return v ? { value: v, from: `profile ${profileName}` } : { from: 'default' };
  }

  private async modelCommand(i: Inbound, key: string, profileName: string, value?: string): Promise<void> {
    const p = this.cfg.profiles[profileName];
    const c = await this.catalogFor(profileName);
    const cli = LABELS[p.backend];
    if (!value) {
      const cur = this.current(key, profileName, 'model');
      const def = c.models.find((m) => m.isDefault)?.id;
      const now = cur.value ? `${cur.value} (${cur.from})` : `${cli}'s default${def ? `, ${def}` : ''}`;
      const list = c.models.length ? c.models.map((m) => `• ${m.id}${m.isDefault ? ' (default)' : ''}`).join('\n') : `(${cli} did not list its models)`;
      return this.reply(i, [`Model: ${now}`, '', `${cli} models:`, list, ...(c.note ? [c.note] : []), '', 'Set for this session: /model <name>. Back to the profile\'s: /model default'].join('\n'));
    }
    const clear = /^(default|reset|none)$/i.test(value);
    if (!clear && !c.anyModel && !c.models.some((m) => m.id === value)) {
      return this.reply(i, `${cli} has no model ${value}. Choose one of: ${c.models.map((m) => m.id).join(', ')}.`);
    }
    this.map.ensureActive(key);
    this.map.setOverride(key, { model: clear ? null : value });
    await this.dropBrain(key); // the next message respawns with the override; the session id is kept
    return this.reply(i, clear ? 'model back to the profile default.' : `model set to ${value} for this session.`);
  }

  private async effortCommand(i: Inbound, key: string, profileName: string, value?: string): Promise<void> {
    const p = this.cfg.profiles[profileName];
    const c = await this.catalogFor(profileName);
    const model = this.current(key, profileName, 'model').value;
    const { levels, defaultLevel } = effortsFor(c, model);
    const forWhat = model ?? c.models.find((m) => m.isDefault)?.id ?? `${LABELS[p.backend]}'s default model`;
    if (!value) {
      const cur = this.current(key, profileName, 'effort');
      const list = levels.map((l) => `${l}${l === defaultLevel ? ' (default)' : ''}`).join(', ');
      return this.reply(i, [`Effort: ${cur.value ? `${cur.value} (${cur.from})` : `the default${defaultLevel ? `, ${defaultLevel}` : ''}`}`, `Levels for ${forWhat}: ${list}`, '', 'Set for this session: /effort <level>. Back to the profile\'s: /effort default'].join('\n'));
    }
    const clear = /^(default|reset|none)$/i.test(value);
    const level = value.toLowerCase();
    if (!clear && !levels.includes(level)) return this.reply(i, `effort for ${forWhat} is one of ${levels.join(', ')}, or default.`);
    this.map.ensureActive(key);
    this.map.setOverride(key, { effort: clear ? null : level });
    await this.dropBrain(key);
    return this.reply(i, clear ? 'effort back to the profile default.' : `effort set to ${level} for this session.`);
  }

  private async backendCommand(i: Inbound, key: string, profileName: string, value?: string): Promise<void> {
    const p = this.cfg.profiles[profileName];
    const installed = (b: BackendName) => !!(this.opts.bins?.[b] ?? locateBin(b === p.backend ? profileBin(p) : profileBin({ ...p, backend: b, bin: undefined }), this.opts.env ?? process.env));
    const others = this.cfg.routes.filter((r) => r.profile === profileName).length - 1;
    if (!value) {
      const rows = SWITCHABLE.map((b) => `• ${b} (${LABELS[b]})${b === p.backend ? ' — now' : installed(b) ? '' : ' — not installed'}`);
      return this.reply(i, [`Backend of profile ${profileName}: ${p.backend} (${LABELS[p.backend]})`, '', ...rows, '', `Switch: /backend <name>. It changes the profile${others > 0 ? ` for all ${others + 1} chats that use it` : ''} and starts a fresh session.`].join('\n'));
    }
    const b = value.toLowerCase() as BackendName;
    if (!SWITCHABLE.includes(b)) return this.reply(i, `No backend ${value}. Choose one of: ${SWITCHABLE.join(', ')}.`);
    if (b === p.backend) return this.reply(i, `Profile ${profileName} already runs on ${LABELS[b]}.`);
    if (!installed(b)) return this.reply(i, `${LABELS[b]} is not installed on this computer, so nothing changed.`);
    if (!this.opts.switchBackend) return this.reply(i, 'This daemon cannot change the routing table. Edit backend in routing.yaml, then angelia compile and angelia restart.');
    const from = p.backend;
    let done: Switched;
    try { done = await this.opts.switchBackend(profileName, b); }
    catch (e) {
      this.log(`backend switch failed key=${key} profile=${profileName} to=${b} ${(e as Error).message}`);
      return this.reply(i, `Nothing changed: ${(e as Error).message}`);
    }
    this.log(`backend switched key=${key} profile=${profileName} to=${b} sender=${i.sender}`);
    // Every chat on this profile: its running CLI is the old one. Each starts on the new one at its next message.
    const chats = new Set(this.cfg.routes.filter((r) => r.profile === profileName).map((r) => `${r.platform}:${r.chat}`));
    for (const k of new Set([...this.brains.keys(), ...this.parked.keys()])) {
      const s = parseSessionKey(k);
      if (chats.has(`${s.platform}:${s.chat}`)) await this.dropBrain(k);
    }
    // A session not started yet is reused at the next message: its /model and /effort were for the old CLI.
    for (const k of this.map.keys()) {
      const s = parseSessionKey(k);
      if (chats.has(`${s.platform}:${s.chat}`) && !this.map.getActive(k)?.started) this.map.setOverride(k, { model: null, effort: null });
    }
    const row = this.map.startNew(key);
    return this.reply(i, [
      `Profile ${profileName} now runs on ${LABELS[b]}. New session ${row.id.slice(0, 8)} started.`,
      ...(done.removed.length ? [`Taken off the profile, they belonged to ${LABELS[from]}: ${done.removed.join(', ')}.`] : []),
      ...(others > 0 ? [`${others} other chat${others > 1 ? 's on this profile switch' : ' on this profile switches'} at their next message.`] : []),
      // The switch takes the model off, and pi's own default provider may have no login here.
      ...(b === 'pi' ? ['Pick a model with /model: pi\'s own default may be a provider with no login here.'] : []),
      ...done.notes.map((n) => `Note: ${n}`),
    ].join('\n'));
  }

  /** /sh: runs outside the brain queue so it works even while a turn is stuck. Opt-in per profile. */
  private async shell(i: Inbound, key: string, profileName: string, profile: Profile, script: string): Promise<void> {
    if (!profile.shell) return this.reply(i, `Shell is off for profile ${profileName}. Set shell: true in routing.yaml to enable /sh.`);
    this.log(`sh key=${key} sender=${i.sender} chars=${script.length}`);
    const r = await runShell(script, { cwd: profile.cwd, env: this.childEnv(profileName).env, timeoutMs: profile.shell_timeout_seconds * 1000 });
    this.log(`sh done key=${key} exit=${r.timedOut ? 'timeout' : r.code}`);
    return this.reply(i, r.text);
  }

  /** Environment for a profile's agent and `/sh`: no bot token, no billing variable, and of the
   *  secrets only the ones this profile's capabilities name. With no profile: the tmux server's. */
  private childEnv(profileName?: string): ChildEnv {
    return profileEnv(this.opts.env ?? process.env, this.opts.secrets ?? {}, tableSecrets(this.cfg), profileName ? capabilityEnv(this.cfg, profileName) : []);
  }

  /** The absolute executable for a profile, looked up now rather than trusted to the daemon's PATH.
   *  A test's `bins` override is taken as given. */
  private binFor(profile: Profile): string | undefined {
    return this.opts.bins?.[profile.backend] ?? locateBin(profileBin(profile), this.opts.env ?? process.env);
  }

  private async brainFor(key: string, name: string): Promise<Brain> {
    const b = this.brains.get(key);
    if (b?.alive) return b;
    const next = this.makeBrain(key, name, this.map.ensureActive(key, '', this.cfg.profiles[name].backend));
    next.start();
    this.brains.set(key, next);
    this.parked.delete(key); // the same pane, reattached by name
    return next;
  }

  /** A brain for one session of a chat, with its listeners, not started. */
  private makeBrain(key: string, name: string, row: SessionRow): Brain {
    const profile = this.cfg.profiles[name];
    const effective = withOverrides(profile, row);
    const env = this.childEnv(name);
    // The chat's own API token is a secret like the capability ones: in tmux mode it reaches the
    // pane through the private file, never a command line.
    const api = this.opts.sessionToken?.(key);
    const b = createBrain(effective, { id: row.id, started: row.started }, {
      bin: this.binFor(profile), env: { ...env.env, ANGELIA_SESSION_KEY: key, ...(api ? { ANGELIA_API_TOKEN: api } : {}) },
      hostEnv: this.childEnv().env, granted: api ? [...env.granted, 'ANGELIA_API_TOKEN'].sort() : env.granted, withheld: env.withheld,
      permissionTimeoutMs: this.cfg.defaults.permission_timeout_minutes * 60_000,
      system: this.opts.selfPrompt?.(name),
      projectsDir: this.opts.transcripts === true ? projectsDir() : this.opts.transcripts,
      apiSocket: join(this.opts.stateDir ?? join(homedir(), '.angelia'), API_SOCKET),
      profileName: name,
    });
    b.on('log', (line: string) => this.log(`${line} key=${key}`));
    // A prompt nobody answered is denied; the chat hears it, or the turn just seems to go wrong.
    b.on('permission-timeout', (id: string) => {
      this.log(`permission timed out key=${key} id=${id.slice(0, 8)}`);
      this.answered(key, id, false, 'timeout');
      // An app turn's request was never in the chat, so neither is its timeout; the client has the event.
      if (this.running.get(key)?.surface === 'app') return;
      void this.notify(key, `${PERMISSION_TIMEOUT_LINE} (${id.slice(0, 8)})`).catch((e) => this.log(`permission timeout note: ${(e as Error).message}`));
    });
    return b;
  }

  /** `bare`: the message is a CLI command and goes as is, without the envelope. `preface` goes before
   *  the message, to the agent only (the onboarding prompt); the session label stays the message. */
  /** `follow`: no message goes in; the events are those of a turn already running (a /resume of a
   *  session sent to the background), delivered as any turn's are. */
  private async turn(i: Inbound, key: string, name: string, o: TurnOptions = {}): Promise<void> {
    this.running.set(key, i);
    const turn = i.turnId ?? randomUUID();
    this.emit(key, { type: 'turn', turn, text: i.text, sender: i.senderName ?? i.sender, surface: i.surface ?? 'chat', queued: this.queue.queued(key) });
    let failed: string | undefined = 'exception';
    try { failed = await this.runTurn(i, key, name, o); }
    finally {
      if (this.running.get(key) === i) { this.running.delete(key); this.asks.delete(key); }
      this.emit(key, { type: 'turn-end', turn, ok: !failed, ...(failed ? { reason: failed } : {}), queued: this.queue.queued(key) });
    }
  }

  /** One turn; returns why it failed, or undefined when the agent answered. */
  private async runTurn(i: Inbound, key: string, name: string, o: TurnOptions = {}): Promise<string | undefined> {
    const { bare = false, preface, retried = false, follow } = o;
    const app = i.surface === 'app';
    const profile = this.cfg.profiles[name];
    const sender = this.senders[i.platform];
    const era = this.era.get(key) ?? 0;
    const row = this.map.ensureActive(key, i.text, profile.backend);
    if (!this.brains.get(key)?.alive && !this.binFor(profile)) {
      // Said plainly, not as the generic failure line: nothing is wrong with the chat or the session,
      // and no retry will help until the CLI is installed or `bin:` points at it.
      this.log(`turn failed key=${key} reason=${profileBin(profile)} not found`);
      await this.reply(i, `This chat's agent (${profileBin(profile)}) is not installed where Angelia can find it. Nothing was sent to it. Run angelia check-config on the host.`);
      return 'cli not found';
    }
    // A session starts only with the protections its last compile wrote. An edit that removed a deny
    // rule or turned the sandbox off, by an agent or by hand, stops here instead of widening the next launch.
    const refused = this.brains.get(key)?.alive ? [] : this.opts.launchGuard?.(name) ?? [];
    if (refused.length) {
      this.log(`launch refused key=${key} profile=${name}: ${refused.join('; ')}`);
      const why = refused[0] === 'never compiled' ? 'its profile was never compiled, so it has no deny rules yet'
        : refused.every((r) => r.startsWith('deny ') || r.startsWith('sandbox off')) ? `${refused.length} of its protections were changed outside Angelia`
        : refused[0];
      await this.reply(i, `This chat's agent was not started: ${why}. Nothing was sent to it. The owner can fix it with: angelia compile --write ${name}`);
      return 'launch refused';
    }
    const b = await this.brainFor(key, name);
    const text = preface ? `${preface}\n\n${agentText(i, bare)}` : agentText(i, bare);
    const events = follow ?? b.turn(text);
    if (!app) await sender?.typing?.(i.chat, true);
    let result: Extract<BrainEvent, { kind: 'result' }> | undefined;
    // Progress lines never hold the turn: they queue, merge while the bucket is full, and give way
    // to the answer and to permission prompts (deliver/rate.ts).
    const progress = new ProgressOutbox(this.rateFor(i.platform), (t) => this.replyFromAgent(i, t, profile, true),
      (e) => this.log(`progress failed key=${key} ${(e as Error).message}`));
    // A CLI that stops answering would hold the chat for good, typing, with every later message
    // queued behind it. In print mode any event is a sign of life: none for half the stall time and
    // the chat hears so; none for all of it and the CLI is stopped. tmux mode watches its own pane.
    const stallMs = this.cfg.defaults.turn_stall_minutes * 60_000;
    let lastEvent = Date.now(), told = false, stalled = false;
    const watch = stallMs > 0 && !profile.tui && !follow ? setInterval(() => {
      // A permission waiting on the owner is not a stall: the clock starts again once it is answered.
      if (b.pendingPermissionCount > 0) { lastEvent = Date.now(); return; }
      // Any line from the CLI counts, not only the ones that become chat events: a long run of tool
      // calls with no text between them is work, not silence.
      const idle = Date.now() - Math.max(lastEvent, b.lastOutputAt ?? 0);
      if (idle >= stallMs && !stalled) {
        stalled = true;
        this.log(`turn stalled key=${key} after ${Math.round(idle / 60_000)} min without output`);
        void this.dropBrain(key);
      } else if (idle >= stallMs / 2 && !told) {
        told = true;
        void this.reply(i, `Nothing new from the agent for ${Math.round(idle / 60_000)} minutes. It may be stuck; Angelia stops it at ${this.cfg.defaults.turn_stall_minutes} minutes, or send /stop now.`).catch(() => {});
      }
    }, this.opts.stallTickMs ?? 60_000) : undefined;
    watch?.unref?.();
    try {
      for await (const e of events) {
        lastEvent = Date.now();
        if (e.kind === 'progress') {
          // A client sees each line at once; the chat gets them through the rate limit. An app turn's
          // lines go to the client only, so they never reach the outbox.
          this.emit(key, { type: 'progress', text: e.text });
          if (!app) progress.push(e.text);
        }
        // A line that cannot be delivered must not end the turn: the agent works on, the answer is
        // what matters, and a permission line nobody saw times out as a no.
        else if (e.kind === 'notice') await this.reply(i, e.text).catch((err) => this.log(`notice failed key=${key} ${(err as Error).message}`));
        else if (e.kind === 'permission') {
          let open = this.asks.get(key);
          if (!open) this.asks.set(key, open = new Map());
          const ask = { key, at: new Date().toISOString(), id: e.id, tool: e.tool, preview: e.preview, ...(e.detail ? { detail: e.detail } : {}) };
          open.set(e.id, ask);
          this.emit(key, { type: 'permission', id: e.id, tool: e.tool, preview: e.preview, ...(e.detail ? { detail: e.detail } : {}) });
          if (app) continue;
          try {
            if (e.detail) await this.reply(i, e.detail);
            await this.reply(i, permissionLine(e.id, e.tool, e.preview));
          } catch (err) { this.log(`permission line failed key=${key} ${(err as Error).message}`); }
        }
        else if (e.kind === 'permission-answered') {
          if (!this.asks.get(key)?.has(e.id)) continue;
          this.answered(key, e.id, e.allow, 'terminal');
          if (!app) await this.reply(i, `Permission ${e.allow ? 'allowed' : 'denied'} in the Claude app or the pane.`).catch(() => {});
        }
        else result = e;
      }
    } catch (err) {
      this.log(`turn error key=${key} ${(err as Error).message}`);
    } finally {
      if (watch) clearInterval(watch);
      if (!app) await sender?.typing?.(i.chat, false);
    }
    // What the agent said along the way and the rate limit held back goes in front of the answer.
    const unsent = await progress.close();
    if (stalled) {
      if (unsent.length) await this.replyFromAgent(i, unsent.join('\n\n'), profile).catch(() => {});
      await this.reply(i, `The agent gave no output for ${this.cfg.defaults.turn_stall_minutes} minutes, so Angelia stopped it. Send your message again, or /new for a fresh session.`).catch(() => {});
      return 'stalled';
    }
    if (!result || result.isError) {
      const stopped = (this.era.get(key) ?? 0) !== era;
      this.log(`turn failed key=${key} reason=${stopped ? 'stopped by the user' : result?.reason ?? 'exception'}`);
      // /stop, /new and a model change all kill the child mid-turn on purpose. The chat was already
      // told what happened; a failure line on top of it reads like a bug that is not there.
      if (stopped) return 'stopped';
      if (!retried && !row.started && freshRetry(result?.reason)) {
        // First turn of a brand-new session died: retry exactly once with a fresh id, per plan E.
        // Once. A deterministic failure - not logged in, a flag this build rejects, no tmux - fails
        // the retry the same way, and an unbounded loop mints sessions and spawns processes as fast
        // as the machine allows while the chat hears nothing at all.
        await this.forget(key);
        this.map.startNew(key, i.text);
        this.log(`retry with fresh session key=${key}`);
        return this.runTurn(i, key, name, { ...o, retried: true });
      }
      await this.forget(key);
      if (unsent.length) await this.replyFromAgent(i, unsent.join('\n\n'), profile);
      // Out of usage: say so, and how to switch model, instead of "something broke".
      if (result?.text && isLimitText(result.text)) await this.reply(i, `${result.text}\n${limitHint(profile.backend)}`);
      else await this.reply(i, failureLine(result?.reason, homedir(), i.isGroup));
      return result?.reason ?? 'exception';
    }
    // Backends that mint their own conversation id (grok) report it after the first turn;
    // the row takes that id so the next spawn can resume it.
    const id = b.backendSessionId && b.backendSessionId !== row.id ? this.map.rename(key, row.id, b.backendSessionId) : row.id;
    this.map.recordTurn(key, id, i.text, profile.backend);
    // Delivery can fail on its own - a platform hiccup, a chat that no longer exists. That must not
    // escape the turn: the queue entry would reject and the agent child would be left running with
    // nobody holding it.
    try {
      // The CLI often sends its answer as a last progress line too: never deliver it twice.
      const tail = unsent.length && unsent[unsent.length - 1] === result.text ? unsent.slice(0, -1) : unsent;
      const fresh = unsent.length > 0 || result.text !== progress.lastSent;
      if (result.text && isLimitText(result.text)) {
        this.log(`usage limit key=${key}`);
        if (tail.length) await this.replyFromAgent(i, tail.join('\n\n'), profile);
        if (fresh) await this.reply(i, result.text);
        await this.reply(i, limitHint(profile.backend));
      } else if (result.text && fresh) await this.replyFromAgent(i, [...tail, result.text].join('\n\n'), profile);
      else if (tail.length) await this.replyFromAgent(i, tail.join('\n\n'), profile);
      else if (!result.text && !progress.lastSent && bare) await this.reply(i, `${i.text.trim().split(/\s/)[0]} done.`);
    } catch (err) {
      // Kept, and sent with the next thing this chat is told: the answer exists, the platform was down.
      this.log(`deliver failed key=${key} ${(err as Error).message}`);
      const owed = this.owed.get(key) ?? [];
      const rest = (err as { unsent?: string }).unsent ?? result.text;
      if (rest && owed.length < OWED_MAX) this.owed.set(key, [...owed, rest]);
    }
    return undefined;
  }

  /** Is this key a routed chat? */
  routed(key: string): boolean { return this.profileFor(key) !== undefined; }

  /** A chat's sessions for a client: the active id, and every session it has had, last used first. */
  sessionsOf(key: string): { active: string | null; sessions: SessionRow[] } {
    return { active: this.map.getActive(key)?.id ?? null, sessions: this.map.list(key, Number.MAX_SAFE_INTEGER) };
  }

  /** A chat's conversation, from the CLI's own transcript: `session` (the active one when absent), last
   *  `limit` messages. Undefined when the chat never had that session: an id from anywhere else is never
   *  turned into a path. `supported: false` for a CLI whose transcripts Angelia cannot read yet. */
  historyOf(key: string, session?: string, limit?: number, before?: string): ChatHistory | undefined | Promise<ChatHistory | undefined> {
    const p = this.profileFor(key);
    if (!p) return undefined;
    const id = session ?? this.map.getActive(key)?.id;
    if (!id) return { session: null, supported: true, items: [], more: false };
    const row = this.map.list(key, Number.MAX_SAFE_INTEGER).find((r) => r.id === id);
    if (!row) return undefined;
    const backend = row.backend ?? p.backend;
    if (backend === 'grok') {
      if (!row.started) return { session: id, supported: true, items: [], more: false };
      return this.grokHistory(key, row).then((r) => ({ session: id, supported: true, ...grokPage(r.items, { limit, before, cut: r.cut }) }));
    }
    if (backend === 'codex') {
      if (!row.started) return { session: id, supported: true, items: [], more: false };
      if (before !== undefined && !codexCursorFor(before, id)) return Promise.reject(new HistoryError('that cursor is not one for this session', 400));
      const route = matchRoute(this.cfg, parseSessionKey(key))!;
      const profile = this.cfg.profiles[route.profile];
      return this.historySlot(() => codexHistory(withOverrides(profile, row), id, { limit, before, bin: this.binFor(profile), env: this.childEnv(route.profile).env }))
        .then((page) => {
          if (!page) throw new HistoryError('Codex did not give this session\'s history');
          return { session: id, supported: true, ...page };
        });
    }
    if (backend === 'pi') {
      const path = piSessionFile(id, this.opts.cliHome);
      return { session: id, supported: true, ...(path ? piHistory(path, { limit, before }) : { items: [], more: false }) };
    }
    if (backend !== 'claude-code') return { session: id, supported: false, items: [], more: false };
    const root = typeof this.opts.transcripts === 'string' ? this.opts.transcripts : projectsDir();
    const path = claudeTranscriptFor(p.cwd, id, root);
    return { session: id, supported: true, ...(path ? claudeHistory(path, { limit, before }) : { items: [], more: false }) };
  }

  /** Replayed grok conversations by session id, kept until a turn of that chat ends (a replay starts
   *  grok and takes seconds), or GROK_HISTORY_TTL_MS. One replay at a time per session; `grokGen` moves
   *  on at every turn end, and a replay that started before it is not kept. */
  private grokCache = new Map<string, { items: HistoryItem[]; cut: boolean; at: number }>();
  private grokLoads = new Map<string, Promise<{ items: HistoryItem[]; cut: boolean }>>();
  private grokGen = new Map<string, number>();

  private grokHistory(key: string, row: SessionRow): Promise<{ items: HistoryItem[]; cut: boolean }> {
    const id = row.id;
    const hit = this.grokCache.get(id);
    // A terminal resume can add to a session the daemon never sees: a cached copy goes stale after a while.
    if (hit && Date.now() - hit.at < GROK_HISTORY_TTL_MS) return Promise.resolve(hit);
    let load = this.grokLoads.get(id);
    if (!load) {
      const route = matchRoute(this.cfg, parseSessionKey(key))!;
      const profile = this.cfg.profiles[route.profile];
      const gen = this.grokGen.get(id) ?? 0;
      const started = this.historySlot(() => grokReplay(withOverrides(profile, row), id, { bin: this.binFor(profile), env: this.childEnv(route.profile).env }))
        .then((r) => {
          if (!r) { this.log(`grok history: no replay key=${key} session=${id.slice(0, 8)}`); throw new HistoryError('grok did not replay this session'); }
          if ((this.grokGen.get(id) ?? 0) === gen) this.grokCache.set(id, { ...r, at: Date.now() });
          return r;
        })
        .finally(() => { if (this.grokLoads.get(id) === started) this.grokLoads.delete(id); });
      this.grokLoads.set(id, load = started);
    }
    return load;
  }

  /** A turn of this chat ended: every grok session it has may have changed (the turn's own, after a
   *  rename or a /new during the turn, too). */
  private dropGrokHistory(key: string): void {
    for (const r of this.map.list(key, Number.MAX_SAFE_INTEGER)) {
      if (!this.grokCache.has(r.id) && !this.grokLoads.has(r.id)) continue;
      this.grokGen.set(r.id, (this.grokGen.get(r.id) ?? 0) + 1);
      this.grokCache.delete(r.id);
      this.grokLoads.delete(r.id);
    }
  }

  /** History readers that start a CLI (grok, Codex) run HISTORY_SLOTS at a time in the whole daemon. */
  private historyRunning = 0;
  private historyWaiting: (() => void)[] = [];
  private async historySlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.historyRunning >= HISTORY_SLOTS) await new Promise<void>((r) => this.historyWaiting.push(r));
    this.historyRunning++;
    try { return await fn(); } finally { this.historyRunning--; this.historyWaiting.shift()?.(); }
  }

  /** Watch every chat live (core/events.ts). Returns the way to stop. */
  onEvent(fn: ChatListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** The full id of an open request of this chat that `prefix` names, as the brains match it. */
  private askId(key: string, prefix: string): string | undefined {
    const p = prefix.toLowerCase();
    const hits = [...(this.asks.get(key)?.keys() ?? [])].filter((id) => id.toLowerCase().startsWith(p));
    return hits.length === 1 ? hits[0] : undefined;
  }

  private answered(key: string, id: string, allow: boolean, by: 'chat' | 'app' | 'timeout' | 'terminal'): void {
    this.asks.get(key)?.delete(id);
    this.emit(key, { type: 'permission-answered', id, allow, by });
  }

  private emit(key: string, body: ChatEventBody): void {
    if (body.type === 'turn-end') this.dropGrokHistory(key);
    if (!this.listeners.size) return;
    const e = { key, at: new Date().toISOString(), ...body } as Parameters<ChatListener>[0];
    for (const fn of this.listeners) {
      try { fn(e); } catch (err) { this.log(`event listener failed key=${key} ${(err as Error).message}`); }
    }
  }

  /** A permission request answered from a client on this machine (the owner). The first answer wins,
   *  from here or from the chat; a chat whose turn it was is told it was answered elsewhere. False when
   *  nothing with that id is waiting. */
  answerPermission(key: string, id: string, allow: boolean): boolean {
    const b = this.brains.get(key);
    if (!b?.hasPendingPermission(id)) return false;
    const full = this.askId(key, id);
    if (!b.answerPermission(id, allow)) return false;
    this.answered(key, full ?? id, allow, 'app');
    const i = this.running.get(key);
    if (i && i.surface !== 'app') void this.reply(i, `Permission ${allow ? 'allowed' : 'denied'} from the desk app.`).catch((e) => this.log(`permission note failed key=${key} ${(e as Error).message}`));
    return true;
  }

  /**
   * Files the owner dropped in the desk app, copied into the chat's profile inbox, where a chat's own
   * files land: the agent reads them there, whatever its rules say about the folder they came from.
   * The send checks hold (no credential location, a real file), and a chat's size limit. `from`: the
   * file is a copy the app made (it can read where the person dropped it from; this daemon may not),
   * and the place it came from is checked too. Throws a MediaError whose message is safe to show; on a
   * throw no copy is left behind.
   */
  async attach(key: string, files: AttachFile[]): Promise<string[]> {
    const profile = this.profileName(key);
    if (!profile) throw new MediaError('not a routed chat');
    const { platform } = parseSessionKey(key);
    const where = { stateDir: this.opts.stateDir };
    const checked = files.map(({ path, from }) => {
      if (from !== undefined) assertOrigin(from, where);
      const m = resolveMedia({ path }, platform, where);
      if (m.bytes > MAX_INBOUND) throw new MediaError(`too big: ${Math.round(m.bytes / 1e6)} MB, limit ${MAX_INBOUND >> 20} MB`);
      return m.path;
    });
    const saved: string[] = [];
    try {
      for (const path of checked) {
        const dest = await saveInbound(this.cfg.profiles[profile].cwd, extname(path), createReadStream(path));
        if (!dest) throw new MediaError(`too big: limit ${MAX_INBOUND >> 20} MB`);
        saved.push(dest);
      }
    } catch (e) {
      for (const f of saved) rmSync(f, { force: true });
      throw e;
    }
    this.log(`attach key=${key} files=${saved.length}`);
    return saved;
  }

  /** A prompt from this machine (`angelia turn`, a job). `fromAgent`: the chat's own agent asked, with
   *  its own token. That one is labelled as such and never runs as a CLI command: an agent a member
   *  talked into it must not reach /model or /logout, which only an owner may send. */
  /** `media`: files already in the profile's inbox (`attach`), given to the agent as a chat's are. */
  async injectTurn(key: string, text: string, fromAgent = false, fromKey?: string, label = 'scheduled', surface?: 'app', turnId?: string, media: string[] = []): Promise<void> {
    const k = parseSessionKey(key);
    const app = surface === 'app' && !fromAgent && !fromKey;
    const senderName = fromKey ? `profile ${this.profileName(fromKey) ?? '?'} (${fromKey})` : fromAgent ? 'this chat\'s agent' : app ? 'the owner, in the desk app' : label;
    const i: Inbound = { ...k, sender: fromKey ? 'profile' : 'local', senderName, text: cleanText(text), isGroup: isGroupChat(k.platform, k.chat), mentioned: true, media, ...(app ? { surface: 'app' as const } : {}), ...(turnId ? { turnId } : {}) };
    const route = matchRoute(this.cfg, i);
    if (!route) return;
    // The same cap a chat's own messages have: an agent or a job looping `angelia turn` must not
    // line up model turns without end. The API checks queueFull first and answers 429.
    if (this.queueFull(key)) { this.dropped(key, `reason=queue-full from=${fromKey ? 'peer' : fromAgent ? 'agent' : label}`); return; }
    // Nobody awaits this for an API caller (it was told "queued" already): a failure ends here, logged.
    await this.queue.enqueue(key, () => this.turn(i, key, route.profile, { bare: !fromAgent && isAgentCommand(i) }))
      .catch((e) => this.log(`injected turn failed key=${key}: ${(e as Error).message}`));
  }

  /**
   * `angelia ask`: a question answered in a read-only copy of the chat's session, beside whatever the
   * chat is doing, and returned to the asker (src/brain/ask.ts). Not queued: a question must not
   * wait behind a long turn, and the copy changes nothing the turn could trip on. At most ASK_MAX at
   * once per chat and ASK_TOTAL in all. The chat hears one line only in a DM with one of the
   * instance's owners; anywhere else (a group, a DM with someone else) the question stays in the
   * log, so one profile's topic does not reach other people. `signal`: the asker went away.
   */
  async ask(key: string, text: string, fromKey?: string, signal?: AbortSignal): Promise<string> {
    // Counted on the chat the key reaches: a made-up thread on a chat-wide route is the same chat.
    const canon = this.chatKey(key);
    if (!canon) throw new AskError('not a routed chat', 404);
    if (fromKey && this.chatKey(fromKey) === canon) throw new AskError('ask another chat; your own session is you', 400);
    const k = parseSessionKey(key);
    const sender = fromKey ? `profile ${this.profileName(fromKey) ?? '?'} (${fromKey})` : 'the owner, from this machine';
    const i: Inbound = { ...k, sender: fromKey ? 'profile' : 'local', senderName: sender, text: cleanText(text), isGroup: isGroupChat(k.platform, k.chat), mentioned: true, media: [] };
    const route = matchRoute(this.cfg, i)!;
    const profile = this.cfg.profiles[route.profile];
    if (fromKey) {
      const no = this.peerAllowed('ask', fromKey, key);
      if (no) throw new AskError(no, 403);
    }
    // Grok Build cannot be held read-only by its flags (measured 2026-10-04): later, in an OS sandbox.
    if (profile.backend === 'grok') throw new AskError('asking a grok profile is not supported yet; give it a task with angelia turn', 501);
    const bin = this.binFor(profile);
    if (!bin) throw new AskError(`profile ${route.profile} cannot answer here now`, 502, `${profileBin(profile)} not installed`);
    const refused = this.opts.launchGuard?.(route.profile) ?? [];
    if (refused.length) throw new AskError(`profile ${route.profile} cannot answer here now`, 409, refused.join('; '));
    if ((this.asking.get(canon) ?? 0) >= ASK_MAX) throw new AskError(`this chat is already answering ${ASK_MAX} questions; ask again in a minute`, 429);
    if (this.questions.size >= ASK_TOTAL) throw new AskError(`${ASK_TOTAL} questions are being answered already; ask again in a minute`, 429);
    const row = this.map.getActive(canon);
    const effective = row ? withOverrides(profile, row) : profile;
    const session = row?.started ? row.id : undefined;
    const system = this.opts.selfPrompt?.(route.profile);
    // No capability secrets: the copy has no shell to use them with.
    const env = this.childEnv().env;
    // Work files of a copy (Codex's answer, pi's fork of the session) go in the state folder, which
    // every agent's rules close: never temp, where any sandboxed agent may read a transcript copy.
    const state = this.opts.stateDir ?? join(homedir(), '.angelia');
    let argv: string[], read: AskReader | undefined;
    const work = mkdtempSync(join(askRoot(state), 'q-'));
    try {
      if (profile.backend === 'codex') {
        // A project .codex/config.toml merges with these overrides (measured: it can open a writable
        // folder) and its MCP servers are not switched off here; the chat itself checks it at start.
        if (existsSync(join(profile.cwd, '.codex', 'config.toml'))) throw new AskError(`profile ${route.profile} cannot answer here now`, 409, 'a project .codex/config.toml');
        // Other profiles' cache folders stay closed, as for the chat's own agent (codex.ts start()).
        const cache = dirname(profileCacheDir(state, 'codex', route.profile));
        const out = join(work, 'answer.txt');
        try { argv = codexAskArgv(effective, session, bin, system, [...profilePermissions(profile.cwd).deny, `Read(${cache})`, `Edit(${cache})`], out); }
        catch (e) { throw e instanceof AskError ? e : new AskError(`profile ${route.profile} cannot answer here now`, 502, (e as Error).message); }
        read = fileAnswer(out);
      } else if (profile.backend === 'pi') {
        const file = session ? piSessionFile(session) : undefined;
        // A chat with a session whose file cannot be found would be answered blind: say so instead.
        if (session && !file) throw new AskError(`profile ${route.profile} cannot answer here now`, 409, 'its pi session file was not found');
        argv = piAskArgv(effective, file ? { file, into: join(work, 'fork') } : undefined, bin, system, gatePath());
        // The gate in plan mode: reads only, held to the profile's deny rules (in its sandbox, if any),
        // and, as for the chat's own agent, the other profiles' caches closed.
        const policy = piPolicy({ ...profile, permission_mode: 'plan' }, piSandboxed(profile) ? profileCacheDir(state, 'pi', route.profile) : undefined);
        Object.assign(env, { ANGELIA_PI_POLICY: JSON.stringify(policy) });
        if (policy.sandbox) delete env.SSH_AUTH_SOCK;
        read = textAnswer;
      } else {
        argv = claudeAskArgv(effective, session, bin, system);
      }
    } catch (e) {
      rmSync(work, { recursive: true, force: true });
      if (e instanceof AskError && e.detail) this.log(`ask failed key=${canon} ${e.message}: ${e.detail}`);
      throw e;
    }
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    this.questions.add(stop);
    this.asking.set(canon, (this.asking.get(canon) ?? 0) + 1);
    this.log(`ask key=${canon} from=${fromKey ?? 'owner'} session=${row?.started ? row.id.slice(0, 8) : 'fresh'}`);
    try {
      const answer = await runAsk(argv, profile.cwd, env, agentText(i, false), undefined, stop.signal, read);
      // A DM is with an owner when its chat id (the person's id, without the platform's suffix) is one
      // of the instance's or the route's owners. A DM nobody can place stays quiet.
      const bare = k.chat.replace(/@.*$/, '');
      const owner = [...(this.cfg.onboard?.owners ?? []), ...route.owners].map(String).includes(bare);
      if (fromKey && !i.isGroup && owner) {
        // Format characters (bidi overrides, zero-width) out, cut by character, never mid-emoji.
        const short = Array.from(new Intl.Segmenter().segment(i.text.replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim()), (g) => g.segment);
        const line = `📨 ${this.profileName(fromKey) ?? 'another profile'} asked: ${short.length > 80 ? `${short.slice(0, 79).join('')}…` : short.join('')} (answered)`;
        // Not awaited: a paced outbox must not hold the answer.
        void this.notify(canon, line).catch((e) => this.log(`ask note failed key=${canon} ${(e as Error).message}`));
      }
      return answer;
    } catch (e) {
      if (e instanceof AskError && e.detail) this.log(`ask failed key=${canon} ${e.message}: ${e.detail}`);
      throw e;
    } finally {
      rmSync(work, { recursive: true, force: true });
      signal?.removeEventListener('abort', onAbort);
      this.questions.delete(stop);
      const n = (this.asking.get(canon) ?? 1) - 1;
      if (n > 0) this.asking.set(canon, n); else this.asking.delete(canon);
    }
  }

  /**
   * May the agent of chat `from` ask chat `to` a question (`answer_from`) or give it a task
   * (`accept_from`)? Undefined: yes; else why not, for the asker. Checked before the hourly count, so
   * a refusal costs the pair nothing.
   */
  peerAllowed(kind: 'ask' | 'turn', from: string, to: string): string | undefined {
    const a = this.profileName(from), b = this.profileName(to);
    if (!a || !b) return 'not a routed chat';
    const list = kind === 'ask' ? this.cfg.profiles[b].answer_from : this.cfg.profiles[b].accept_from;
    if (list.includes('*') || list.includes(a)) return undefined;
    this.log(`${kind} refused key=${this.chatKey(to) ?? to} from=${from} reason=not-in-${kind === 'ask' ? 'answer_from' : 'accept_from'}`);
    return kind === 'ask'
      ? `profile ${b} does not answer questions from ${a}; its owner can add it to answer_from`
      : `profile ${b} does not take tasks from ${a}; ask it a question with angelia ask, or its owner can add ${a} to accept_from`;
  }

  /** The session key of the chat `key` reaches: its thread only when the route names that thread.
   *  Undefined when no route takes it. */
  private chatKey(key: string): string | undefined {
    const k = parseSessionKey(key);
    const route = matchRoute(this.cfg, k);
    return route ? sessionKey({ platform: k.platform, chat: k.chat, ...(route.thread !== undefined ? { thread: k.thread } : {}) }) : undefined;
  }

  /** True when the chat already has QUEUE_MAX turns running and waiting. */
  queueFull(key: string): boolean {
    return this.queue.queued(key) >= QUEUE_MAX;
  }

  /**
   * `/angelia-handoff` from a terminal (`angelia handoff`, owner only). In a profile's own folder the
   * terminal's Claude Code session becomes the chat's active one; anywhere else the chat starts a fresh
   * session whose first turn is the brief. A turn running in the chat goes on in the background.
   */
  async handoff(r: HandoffRequest): Promise<HandoffResult> {
    const t = handoffTarget(this.cfg, r.cwd);
    const key = pickChat(t, r.chat);
    const summary = r.summary.split(/\s+/).join(' ').trim().replace(/[.\s]+$/, '');
    if (!summary) throw new HandoffError('a one-line summary is needed');
    if (t.mode === 'session') {
      if (!r.session) throw new HandoffError('no session id: run it inside Claude Code, or pass --session <id>');
      if (this.map.getActive(key)?.id === r.session) throw new HandoffError(`this session is already the active one in ${key}`);
    } else if (!r.brief?.trim()) throw new HandoffError(`this folder is not profile ${t.profile}'s own, so the session does not move: a brief is needed after the summary line`);
    const moved = await this.clearForHandoff(key);
    if (t.mode === 'session') this.map.adopt(key, r.session!, summary, 'claude-code');
    else this.map.startNew(key, summary);
    const n = moved ? this.map.position(key, moved) : 0;
    const said = [
      t.mode === 'session' ? `From the terminal: ${summary}. Continuing here.` : `From the terminal, ${r.project ?? r.cwd}: ${summary}.`,
      ...(moved ? [`A running turn went to the background${n ? `; /resume ${n} shows it` : ''}.`] : []),
    ].join(' ');
    this.log(`handoff key=${key} profile=${t.profile} mode=${t.mode}${moved ? ` background=${moved.slice(0, 8)}` : ''}`);
    await this.notify(key, said);
    if (t.mode === 'brief') void this.injectTurn(key, briefTurn(r.project ?? r.cwd, r.brief!), false, undefined, 'terminal handoff')
      .catch((e) => this.log(`handoff brief failed key=${key} ${(e as Error).message}`));
    return { key, profile: t.profile, mode: t.mode, said };
  }

  /** Free the chat for a handoff. Idle: its session ends, as on /resume. Mid-turn: the pane goes on in
   *  the background, and its session id comes back. A CLI that cannot go on alone refuses the handoff. */
  private async clearForHandoff(key: string): Promise<string | undefined> {
    if (this.queue.queued(key) === 0) { await this.dropBrain(key); return undefined; }
    // A turn in the background asks its permissions in the chat; one the owner typed in the app must not.
    if (this.running.get(key)?.surface === 'app') throw new HandoffError(`${key} is answering a turn typed in the desk app. Wait for the answer, or stop it there, then try again.`);
    const b = this.brains.get(key);
    const row = this.map.getActive(key);
    if (!b?.alive || !b.release || !b.backgroundTurn || !row) {
      throw new HandoffError(`${key} is in the middle of a turn, and its agent cannot go on in the background. Wait for the answer, or /stop it there, then try again.`);
    }
    this.era.set(key, (this.era.get(key) ?? 0) + 1); // the turn being read ends quietly: its chat moved on
    this.brains.delete(key);
    await b.release();
    this.toBackground(key, row.id, b, b.turnSentAt ?? Date.now());
    return row.id;
  }

  private toBackground(key: string, id: string, b: Brain, since: number): void {
    this.background.set(id, { key, brain: b });
    this.map.setBackground(key, id, new Date(since));
    void this.watchBackground(id);
  }

  /** Read a background turn until it is over: a permission dialog is told to the chat once (it waits
   *  for an answer, with no time limit), and the end of the turn ends the pane. */
  private async watchBackground(id: string): Promise<void> {
    const e = this.background.get(id);
    if (!e?.brain.backgroundTurn) return;
    let result: Extract<BrainEvent, { kind: 'result' }> | undefined;
    try {
      for await (const ev of e.brain.backgroundTurn()) {
        if (ev.kind === 'result') result = ev;
        else if (ev.kind === 'permission') {
          this.log(`background permission key=${e.key} session=${id.slice(0, 8)} tool=${ev.tool}`);
          // Read off the screen, where a command can draw anything: nothing of it is quoted, and the chat is not asked.
          await this.notify(e.key, `The background turn of session ${id.slice(0, 8)} is waiting for a permission. Answer it in the Claude app or in its pane; the chat cannot, since only the screen says what it asks.`)
            .catch((err) => this.log(`background note failed key=${e.key} ${(err as Error).message}`));
        }
      }
    } catch (err) { this.log(`background watch failed key=${e.key} ${(err as Error).message}`); }
    if (this.background.get(id) !== e || result?.reason === 'released') return; // taken back by /resume
    this.background.delete(id);
    this.map.setBackground(e.key, id, null);
    this.log(`background turn over key=${e.key} session=${id.slice(0, 8)}${result?.isError ? ` reason=${result.reason}` : ''}`);
    await this.end(e.key, e.brain);
  }

  /** At startup: take back the background turns a restart cut off from their reader. A pane that is
   *  gone just loses its mark; the session stays in /resume. */
  async restoreBackground(): Promise<void> {
    for (const { key, row } of this.map.background()) {
      const name = this.profileName(key);
      const since = Date.parse(row.background_since ?? '');
      const b = name ? this.makeBrain(key, name, row) : undefined;
      if (b?.adopt && !Number.isNaN(since) && (await b.adopt(since).catch(() => false))) {
        this.log(`background restored key=${key} session=${row.id.slice(0, 8)}`);
        this.toBackground(key, row.id, b, since);
      } else this.map.setBackground(key, row.id, null);
    }
  }

  /** Post into the chat behind a session key (`angelia send`, a cron launcher). `fromKey`: another
   *  profile's agent posted it; the line starts with that profile's name. */
  async notify(key: string, text: string, fromKey?: string): Promise<void> {
    const k = parseSessionKey(key);
    const said = fromKey ? `[from ${this.profileName(fromKey) ?? fromKey}] ${text}` : text;
    await this.reply({ ...k, sender: '', text: '', isGroup: isGroupChat(k.platform, k.chat), mentioned: false, media: [] }, said);
  }

  private profileName(key: string): string | undefined {
    return matchRoute(this.cfg, parseSessionKey(key))?.profile;
  }

  /**
   * May the agent of chat `from` message chat `to`? Profiles talk to each other unless one of them is
   * isolated. At most PEER_PER_HOUR messages an hour from one chat to another, so two agents that keep
   * answering each other stop by themselves. Undefined: yes; otherwise the reason, for the asking agent.
   */
  reach(from: string, to: string, now = Date.now()): string | undefined {
    const a = this.profileName(from), b = this.profileName(to);
    if (!a || !b) return 'not a routed chat';
    if (this.cfg.profiles[a].isolated) return `profile ${a} is isolated: it cannot message other profiles`;
    if (this.cfg.profiles[b].isolated) return `profile ${b} is isolated: other profiles cannot message it`;
    // The chats the keys reach: a made-up thread on a chat-wide route must not get its own count.
    const k = `${this.chatKey(from) ?? from}>${this.chatKey(to) ?? to}`;
    const recent = (this.peerSends.get(k) ?? []).filter((t) => t > now - 3600_000);
    if (recent.length >= PEER_PER_HOUR) { this.log(`peer message refused from=${from} to=${to} reason=hourly-limit`); return `${PEER_PER_HOUR} messages to ${b} in the last hour; wait`; }
    recent.push(now);
    this.peerSends.set(k, recent);
    this.log(`peer message from=${from} (${a}) to=${to} (${b})`);
    return undefined;
  }

  /**
   * Attach a file to the chat behind a session key: `angelia send-media`, a cron launcher, or a
   * `MEDIA:` tag. The path is checked here, once, for every caller. Unless the owner's token asked
   * (`byOwner`), the request is the agent's, and is held to its profile's deny rules as well.
   */
  async sendMediaTo(key: string, req: MediaRequest, byOwner = false): Promise<void> {
    const { platform: p, chat, thread } = parseSessionKey(key);
    const sender = this.senders[p];
    if (!sender?.sendMedia) throw new MediaError(`${p}: this adapter cannot send files`);
    let deny: string[] | undefined;
    if (!byOwner) {
      const name = this.profileName(key);
      if (!name) throw new MediaError('not a routed chat');
      deny = agentDenyRules(this.cfg, name, this.opts.stateDir ?? join(homedir(), '.angelia'));
    }
    const m = resolveMedia(req, p, { stateDir: this.opts.stateDir, deny });
    const snap = snapshotMedia(m);
    try {
      await this.rateFor(p).acquire(true);
      await sender.sendMedia(chat, snap.media, thread);
    } finally { snap.cleanup(); }
    this.log(`media key=${key} kind=${m.kind} bytes=${m.bytes}`);
  }

  /** Profile behind a session key, if the chat is routed. */
  profileFor(key: string): Profile | undefined {
    const route = matchRoute(this.cfg, parseSessionKey(key));
    return route ? this.cfg.profiles[route.profile] : undefined;
  }

  private rateFor(p: Platform): RateLimiter {
    let r = this.rates.get(p);
    if (!r) this.rates.set(p, r = new RateLimiter(this.cfg.defaults.max_out_per_min, this.opts.chunkGapMs));
    return r;
  }

  /** `held`: the caller already took the first chunk's slot (a progress batch). */
  private async reply(i: Inbound, text: string, held = false): Promise<void> {
    // `held` is a batch of progress lines, which a client already saw as they came.
    if (!held) this.emit(sessionKey(i), { type: 'out', text });
    if (i.surface === 'app') return;
    const sender = this.senders[i.platform];
    if (!sender) throw new Error(`${i.platform} is not set up in the routing table`);
    let parts = chunk(text, LIMITS[i.platform]);
    // A very long answer as a hundred messages would hold the platform's bucket for minutes, every
    // other chat behind it: the start goes as text, the whole of it as a file.
    const whole = parts.length > LONG_ANSWER_PARTS && sender.sendMedia ? text : undefined;
    if (whole) parts = [...parts.slice(0, LONG_ANSWER_PARTS - 1), `… ${parts.length - LONG_ANSWER_PARTS + 1} more messages' worth: the whole answer is in the attached file.`];
    // Progress lines are not tried again: a later batch or the answer carries on, and a retry would
    // hold the answer, and every message behind it, for minutes.
    const send = <T>(f: () => Promise<T>) => (held ? f() : this.retrySend(f));
    for (let n = 0; n < parts.length; n++) {
      if (!(held && n === 0)) await this.rateFor(i.platform).acquire(n === 0);
      try { await send(() => sender.send(i.chat, parts[n], i.thread)); }
      catch (e) {
        // What did not go out, so a kept answer is not sent twice.
        (e as { unsent?: string }).unsent = parts.slice(n).join('\n\n');
        throw e;
      }
    }
    if (whole) {
      const dir = mkdtempSync(join(tmpdir(), 'angelia-answer-'));
      const path = join(dir, 'answer.md');
      try {
        writeFileSync(path, whole, { mode: 0o600 });
        await this.rateFor(i.platform).acquire(true);
        await this.retrySend(() => sender.sendMedia!(i.chat, { path, kind: 'document', mime: 'text/markdown', bytes: Buffer.byteLength(whole), fileName: 'answer.md' }, i.thread));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    // Delivered: an answer this chat could not get earlier goes out now, once, as the agent's words
    // (a MEDIA: line attaches its file, as it would have).
    const owed = held ? undefined : this.owed.get(sessionKey(i));
    if (owed?.length) {
      this.owed.delete(sessionKey(i));
      const route = matchRoute(this.cfg, i);
      for (const t of owed) {
        const late = `An answer that could not be delivered earlier:\n\n${t}`;
        await (route ? this.replyFromAgent(i, late, this.cfg.profiles[route.profile]) : this.reply(i, late)).catch((e) => this.log(`late answer failed key=${sessionKey(i)} ${(e as Error).message}`));
      }
    }
  }

  /**
   * One send, tried again when the platform is down for a moment: WhatsApp between a close and its
   * reconnect, Telegram's network or its 429 (its own wait is used), a server error. A refusal that
   * will not change (a 4xx other than 429: a chat that is gone, a bot that was blocked) is not.
   */
  private async retrySend<T>(send: () => Promise<T>): Promise<T> {
    const waits = this.opts.sendRetryMs ?? SEND_RETRY_MS;
    for (let n = 0; ; n++) {
      try { return await send(); }
      catch (e) {
        // Telegram (grammY) gives error_code, WhatsApp (Baileys, a Boom error) output.statusCode.
        const err = e as { error_code?: number; parameters?: { retry_after?: number }; output?: { statusCode?: number } };
        const code = err.error_code ?? err.output?.statusCode;
        const final = typeof code === 'number' && code >= 400 && code < 500 && code !== 429 && code !== 408;
        if (final || n >= waits.length) throw e;
        const wait = err.parameters?.retry_after ? Math.min(err.parameters.retry_after * 1000, 300_000) : waits[n];
        this.log(`send failed, again in ${Math.round(wait / 1000)} s: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  /**
   * The agent's own words. With `media_tags` on for the profile, a `MEDIA:<absolute path>` line is
   * pulled out and the file is attached; the rest goes as text. Off by default: the road should not
   * read meaning into the brain's text unless this chat asked it to.
   */
  private async replyFromAgent(i: Inbound, text: string, profile: Profile, held = false): Promise<void> {
    // An app turn's answer stays with the client; a file line in it is left as text there.
    if (!profile.media_tags || i.surface === 'app') return this.reply(i, text, held);
    const { text: rest, media } = extractMediaTags(text);
    if (rest) await this.reply(i, rest, held);
    for (const req of media) {
      try { await this.sendMediaTo(sessionKey(i), req); }
      catch (e) {
        this.log(`media failed key=${sessionKey(i)} ${(e as Error).message}`);
        await this.reply(i, e instanceof MediaError ? `Could not attach that file: ${e.message}` : 'Could not attach that file.');
      }
    }
  }

  private async notifyUnmatched(i: Inbound): Promise<void> {
    const k = `${i.platform}:${i.chat}`;
    const t = Date.now();
    if ((this.unmatchedNotified.get(k) ?? 0) > t - 3600_000) return;
    if (this.unmatchedNotified.size >= 1000) for (const [c, at] of this.unmatchedNotified) if (at <= t - 3600_000) this.unmatchedNotified.delete(c);
    this.unmatchedNotified.set(k, t);
    await this.reply(i, UNMATCHED_LINE);
  }

  /** `end: false` is "we are done with it for now": a backend that can survive on its own keeps
   *  the session running (and visible in the Claude app) and is reattached on the next message. */
  private async dropBrain(key: string, end = true): Promise<void> {
    this.era.set(key, (this.era.get(key) ?? 0) + 1);
    await this.forget(key, end);
  }

  /** Let go of a brain and always end its process first. Deleting the map entry alone leaves a
   *  child running with no owner: it survives the turn, the reap and the daemon itself. */
  private async forget(key: string, end = true): Promise<void> {
    const b = this.brains.get(key);
    this.brains.delete(key);
    const parked = this.parked.get(key);
    if (end && parked && parked !== b) { this.parked.delete(key); await this.end(key, parked); }
    if (!b?.alive) return;
    if (!end && b.release) {
      try { await b.release(); this.parked.set(key, b); return; }
      catch (err) { this.log(`release failed key=${key} ${(err as Error).message}`); }
    }
    await this.end(key, b);
  }

  private async end(key: string, b: Brain): Promise<void> {
    try { await b.stop(); } catch (err) {
      this.log(`stop failed key=${key} ${(err as Error).message}`);
      try { b.kill(); } catch { /* already gone */ }
    }
  }

  /** The tmux sessions this daemon stands behind (each chat's active session on a tui profile, and every
   *  brain it holds), and the name prefixes of its tui profiles: a pane with one of those prefixes and
   *  none of these names is an orphan (brain/tui.ts, sweepPanes). */
  tuiPanes(): { keep: Set<string>; prefixes: string[] } {
    const keep = new Set<string>();
    for (const b of [...this.brains.values(), ...this.parked.values(), ...[...this.background.values()].map((e) => e.brain)]) { const n = (b as { name?: unknown }).name; if (typeof n === 'string') keep.add(n); }
    for (const key of this.map.keys()) {
      const p = this.profileFor(key);
      const row = this.map.getActive(key);
      if (p?.tui && p.backend === 'claude-code' && row) keep.add(remoteControlName(p, { id: row.id, started: row.started }));
    }
    const prefixes = Object.values(this.cfg.profiles).filter((p) => p.tui && p.backend === 'claude-code').map((p) => remoteControlName(p, { id: '', started: false }));
    return { keep, prefixes: [...new Set(prefixes)] };
  }

  /** Reap brains idle longer than the configured window. Call from a timer. */
  async reapIdle(now = Date.now()): Promise<void> {
    const limit = this.cfg.defaults.idle_exit_minutes * 60_000;
    for (const [key, b] of this.brains) {
      if (b.alive && now - b.lastUsedAt > limit && this.queue.queued(key) === 0) { this.log(`reap key=${key}`); await this.dropBrain(key, false); }
    }
  }

  /** `running`: a turn is being answered now, so a client that connects mid-turn can show it. */
  status(): { key: string; alive: boolean; queued: number; running: boolean }[] {
    return [...this.brains].map(([key, b]) => ({ key, alive: b.alive, queued: this.queue.queued(key), running: this.running.has(key) }));
  }

  /** The permission requests waiting for an answer now, every chat, oldest first. */
  waitingPermissions(): WaitingPermission[] {
    return [...this.asks.values()].flatMap((m) => [...m.values()]).sort((a, b) => a.at.localeCompare(b.at));
  }

  async shutdown(): Promise<void> {
    for (const a of this.questions) a.abort();
    await Promise.all([...this.brains.keys()].map((k) => this.dropBrain(k, false)));
  }
}

/** A permission request that waits for an answer, as `GET /permissions` lists it. */
/** A file for `attach`: its path, and where the person picked it when the path is the app's copy. */
export interface AttachFile { path: string; from?: string }

export interface WaitingPermission { key: string; at: string; id: string; tool: string; preview: string; detail?: string }

export interface HandoffRequest {
  /** The terminal's folder: it decides the profile (core/handoff.ts). */
  cwd: string;
  /** The terminal's Claude Code session id; needed when the session itself moves. */
  session?: string;
  /** One line for the chat, and the session's label. */
  summary: string;
  /** For a folder that is not the profile's own: what the chat's agent needs to go on with the work. */
  brief?: string;
  /** The project as the brief names it: path, git branch, last commit. Default: `cwd`. */
  project?: string;
  /** Which of the profile's chats, when it has several: 1-based, or a session key. */
  chat?: string;
}

export interface HandoffResult { key: string; profile: string; mode: 'session' | 'brief'; said: string }

const AUDIO_EXT = /\.(ogg|opus|oga|m4a|mp3|wav|aac|flac|amr)$/i;

/** Files are handed to the agent by path. A voice note is labelled as such: the agent, not the router, transcribes it. */
/** A first turn worth one retry under a fresh id: the child exited, or a tmux pane died before its
 *  first prompt. The pane case covers an id Claude already holds a transcript for ("Session ID ...
 *  already in use"), which otherwise fails every message until /new (seen 2026-09-29 and -30). */
export function freshRetry(reason: string | undefined): boolean {
  const r = String(reason ?? '');
  return r.startsWith('exit') || r.startsWith(START_EXIT);
}

export function mediaLine(path: string): string {
  return AUDIO_EXT.test(path) ? `\n[voice note: ${path}]` : `\n[file: ${path}]`;
}

/** A message that starts with a slash is a command for the agent's own CLI (`/compact`, a custom
 *  command). The CLI matches those at the start of the message, so the envelope would hide them.
 *  Router commands are dispatched before this and never reach here. */
export function isAgentCommand(i: Pick<Inbound, 'text' | 'media'>): boolean {
  return i.media.length === 0 && /^\/[a-zA-Z]/.test(i.text.trim());
}

/** `/compact now` -> `compact`. */
export function agentCommandName(text: string): string {
  return text.trim().slice(1).split(/\s/)[0].toLowerCase();
}

/** What the agent is given for a turn: the envelope plus the message, or, when the router allowed it
 *  (`bare`), a CLI command as typed. */
export function agentText(i: Inbound, bare = isAgentCommand(i)): string {
  if (bare && isAgentCommand(i)) return i.text.trim();
  return envelope(i) + '\n\n' + quoteLookalikes(i.text) + i.media.map(mediaLine).join('');
}

/** A line in the sender's own text shaped like one Angelia writes (an envelope, a `[file: …]` or
 *  `[voice note: …]` line) is quoted with ">", so a member cannot pose as the owner in a second
 *  envelope, or hand the agent a file line pointing at a key. The self prompt tells the agent so. */
export function quoteLookalikes(text: string): string {
  return text.split('\n').map((l) => (/^\s*\[\s*(whatsapp|telegram|file\s*:|voice note\s*:)/i.test(l) ? `> ${l}` : l)).join('\n');
}


export function envelope(i: Inbound): string {
  const kind = i.isGroup ? 'group' : 'dm';
  const name = i.senderName ? cleanName(i.senderName) : '';
  const who = name ? `${name} (${i.sender})` : i.sender;
  return `[${i.platform} ${kind} ${i.chat}${i.thread ? ` thread ${i.thread}` : ''} · ${who}]`;
}

/** Where questions keep their work files: under compiled/, which every profile's deny floor closes.
 *  Emptied on first use in a process, so a daemon that died mid-question leaves nothing behind. */
const cleared = new Set<string>();
function askRoot(stateDir: string): string {
  const root = join(stateDir, 'compiled', 'ask');
  if (!cleared.has(root)) { rmSync(root, { recursive: true, force: true }); cleared.add(root); }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
