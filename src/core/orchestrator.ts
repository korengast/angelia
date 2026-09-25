import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { Config, Profile } from '../instance/config/schema.js';
import type { Inbound, BrainEvent, Platform } from './types.js';
import { cleanName, cleanText, isGroupChat, parseSessionKey, sessionKey } from './types.js';
import { matchRoute } from './router/match.js';
import { gate, isOwner, OWNER_COMMANDS } from './router/gate.js';
import { SessionMap } from './session/map.js';
import { KeyedQueue } from './session/queue.js';
import { createBrain, locateBin, profileBin, type Brain, type BackendName } from '../brain/index.js';
import { projectsDir } from '../brain/transcripts.js';
import { remoteControlName } from '../brain/argv.js';
import { chunk, LIMITS } from './deliver/chunk.js';
import { extractMediaTags, resolveMedia, snapshotMedia, MediaError, type Media, type MediaRequest } from './deliver/media.js';
import { ProgressOutbox, RateLimiter } from './deliver/rate.js';
import { failureLine, isLimitText, limitHint, UNMATCHED_LINE, NOT_OWNER_LINE, permissionLine, parsePermissionReply, PERMISSION_TIMEOUT_LINE } from './deliver/text.js';
import { parseCommand, HELP, statusText, resumeListText } from './commands.js';
import { runShell } from './shell.js';
import { profileEnv, tableSecrets, type ChildEnv } from './env.js';
import { capabilityEnv } from '../capabilities/resolve.js';
import { API_SOCKET } from '../instance/instance.js';

export interface Sender {
  send(chat: string, text: string, thread?: string): Promise<void>;
  /** Attach a file that already passed `resolveMedia`. Absent on an adapter that cannot. */
  sendMedia?(chat: string, m: Media, thread?: string): Promise<void>;
  typing?(chat: string, on: boolean): Promise<void>;
  /** The chat's own name (a group's subject), for naming a new profile. */
  chatName?(chat: string): Promise<string | undefined>;
}

export interface OrchestratorOptions {
  stateDir?: string;
  /** Executable per backend, when not the default on PATH (tests, odd installs). */
  bins?: Partial<Record<BackendName, string>>;
  /** Claude Code's projects folder, for placing transcripts before a resume (brain.ts). `true` means the
   *  real one; absent (tests) means no placement and no fresh start for a lost conversation. */
  transcripts?: true | string;
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
  restart?: { check(): string | undefined; launch(key: string): void };
  /** defaults.unmatched: onboard. Makes the profile and route for a new chat, adds them to the live
   *  config, and returns the new profile's name and the prompt for its first turn (onboard.ts). */
  onboard?: (i: Inbound, chatName?: string) => { name: string; prompt: string; git?: Promise<string> };
}

const DROP_LOG_MS = 10 * 60_000;
/** Messages that may wait behind a chat's running turn. Past it, the chat is told once, and the rest dropped. */
const QUEUE_MAX = 10;
const BUSY_LINE = 'Still working through earlier messages in this chat, so this one was not taken. Send it again when I have answered.';
/** More chunks than this and an answer goes as its start plus a file. */
const LONG_ANSWER_PARTS = 4;
/** Messages one chat's agent may send another profile's chat in an hour. */
const PEER_PER_HOUR = 30;

/** inbound -> route -> gate -> command or turn -> deliver. One instance per daemon. */
export class Orchestrator {
  readonly map: SessionMap;
  private queue = new KeyedQueue();
  private brains = new Map<string, Brain>();
  /** Brains let go of without ending them (an idle reap): a tmux pane keeps running and the next
   *  message reattaches it by name. Kept here so that /new, /resume or a backend switch in between
   *  ends the pane too, instead of leaving it running with nobody to reach it. */
  private parked = new Map<string, Brain>();
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
  private log: (line: string) => void;

  constructor(private readonly cfg: Config, private readonly senders: Partial<Record<Platform, Sender>>, private readonly opts: OrchestratorOptions = {}) {
    const dir = opts.stateDir ?? join(homedir(), '.angelia');
    this.map = new SessionMap(join(dir, 'sessions.json'));
    this.log = opts.log ?? (() => {});
  }

  async handle(raw: Inbound): Promise<void> {
    const i = { ...raw, text: cleanText(raw.text), ...(raw.senderName !== undefined ? { senderName: cleanText(raw.senderName) } : {}) };
    const g = gate(i, matchRoute(this.cfg, i));
    const key = sessionKey(i);
    if (!g.ok) {
      if (g.reason === 'unmatched' && this.cfg.defaults.unmatched === 'onboard' && this.opts.onboard && !parseCommand(i.text)
        && !this.cfg.onboard?.skip.includes(`${i.platform}:${i.chat}`)) {
        // Only an owner makes a new profile. Anyone can add the bot's number to a group. And in a
        // group the message must address the bot, as every routed group requires by default: an
        // owner chatting in a group the bot happens to be in must not wake up to a new profile.
        if (!this.cfg.onboard?.owners.includes(i.sender)) { this.dropped(key, `reason=unmatched-not-owner sender=${i.sender}`); return; }
        if (i.isGroup && !i.mentioned) { this.dropped(key, 'reason=unmatched-not-mentioned'); return; }
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
        b.answerPermission(perm.id, perm.allow);
        return;
      }
    }
    const cmd = parseCommand(i.text);
    if (cmd && OWNER_COMMANDS.has(cmd.name) && !isOwner(i, route)) {
      this.log(`${cmd.name} refused key=${key} sender=${i.sender} reason=not-owner`);
      return this.reply(i, NOT_OWNER_LINE);
    }
    if (cmd?.name === 'sh') return this.shell(i, key, route.profile, profile, cmd.script);
    if (cmd) return this.command(i, key, route.profile, cmd);
    // A slash at the start goes to the CLI as its own command (`/compact`, `/clear`, `/add-dir`, a
    // custom one) only from an owner, or for a command the profile opens to everyone. From anyone else
    // it is a message like any other, in the envelope: in tmux mode the CLI's commands reach plugins,
    // MCP, permissions and the user-wide default model.
    const bare = isAgentCommand(i) && (isOwner(i, route) || profile.agent_commands.includes(agentCommandName(i.text)));
    if (isAgentCommand(i) && !bare) this.log(`agent command sent as text key=${key} sender=${i.sender} reason=not-owner`);
    if (this.queue.queued(key) >= QUEUE_MAX) {
      // One chat cannot line up an hour of turns, each drawing on the platform's one bucket; said once per pile-up.
      this.dropped(key, 'reason=queue-full');
      if (!this.busyTold.has(key)) { this.busyTold.add(key); await this.reply(i, BUSY_LINE); }
      return;
    }
    this.busyTold.delete(key);
    await this.queue.enqueue(key, () => this.turn(i, key, route.profile, { bare }));
  }

  private async command(i: Inbound, key: string, profileName: string, cmd: NonNullable<ReturnType<typeof parseCommand>>): Promise<void> {
    switch (cmd.name) {
      case 'help': return this.reply(i, HELP);
      case 'restart': {
        if (!this.opts.restart) return this.reply(i, 'This daemon cannot restart itself. Run angelia restart from a terminal.');
        const err = this.opts.restart.check();
        // A table that does not load would leave nothing running and nothing to reply with.
        if (err) return this.reply(i, `Not restarting: the routing table does not load.\n${err}`);
        const busy = [...this.brains.entries()].filter(([k, b]) => k !== key && b.alive).length;
        this.log(`restart requested key=${key} sender=${i.sender}`);
        await this.reply(i, `Routing table ok. Restarting now; I will post here when I am back.${busy ? ` ${busy} other running session${busy > 1 ? 's' : ''} will be cut and resume on the next message.` : ''}`);
        this.opts.restart.launch(key);
        return;
      }
      case 'status': return this.reply(i, statusText(this.map, key, profileName, this.brains.get(key)?.alive ?? false, this.queue.queued(key)));
      case 'new': {
        await this.dropBrain(key);
        const row = this.map.startNew(key);
        return this.reply(i, `New session ${row.id.slice(0, 8)} started.`);
      }
      case 'stop': {
        const b = this.brains.get(key);
        if (!b?.alive) return this.reply(i, 'Nothing running.');
        await this.dropBrain(key);
        return this.reply(i, 'Stopped.');
      }
      case 'model': case 'effort': {
        const row = this.map.ensureActive(key);
        if (!cmd.value) return this.reply(i, `${cmd.name} for this session: ${row[cmd.name] ?? `(profile default${this.profileDefault(profileName, cmd.name)})`}`);
        const clear = /^(default|reset|none)$/i.test(cmd.value);
        if (cmd.name === 'effort' && !clear && !['low', 'medium', 'high', 'xhigh', 'max'].includes(cmd.value.toLowerCase())) return this.reply(i, 'effort is one of low, medium, high, xhigh, max, or default.');
        this.map.setOverride(key, { [cmd.name]: clear ? null : (cmd.name === 'effort' ? cmd.value.toLowerCase() : cmd.value) });
        await this.dropBrain(key); // the next message respawns with the override; the session id is kept
        return this.reply(i, clear ? `${cmd.name} back to the profile default.` : `${cmd.name} set to ${cmd.value} for this session.`);
      }
      case 'resume': {
        if (!cmd.selector) return this.reply(i, resumeListText(this.map, key));
        await this.dropBrain(key);
        const row = this.map.setActive(key, cmd.selector);
        return this.reply(i, row ? `Resumed ${row.id.slice(0, 8)} · ${row.label || '(no label)'}` : 'No such session.');
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
    let made: { name: string; prompt: string; git?: Promise<string> };
    try {
      const chatName = await this.senders[i.platform]?.chatName?.(i.chat).catch(() => undefined);
      made = this.opts.onboard!(i, chatName);
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

  private profileDefault(profileName: string, what: 'model' | 'effort'): string {
    const v = this.cfg.profiles[profileName]?.[what];
    return v ? `: ${v}` : '';
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
    let b = this.brains.get(key);
    if (b?.alive) return b;
    const profile = this.cfg.profiles[name];
    const row = this.map.ensureActive(key, '', profile.backend);
    const effective = { ...profile, ...(row.model ? { model: row.model } : {}), ...(row.effort ? { effort: row.effort as Profile['effort'] } : {}) };
    const env = this.childEnv(name);
    // The chat's own API token is a secret like the capability ones: in tmux mode it reaches the
    // pane through the private file, never a command line.
    const api = this.opts.sessionToken?.(key);
    b = createBrain(effective, { id: row.id, started: row.started }, {
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
      void this.notify(key, `${PERMISSION_TIMEOUT_LINE} (${id.slice(0, 8)})`).catch((e) => this.log(`permission timeout note: ${(e as Error).message}`));
    });
    b.start();
    this.brains.set(key, b);
    this.parked.delete(key); // the same pane, reattached by name
    return b;
  }

  /** `bare`: the message is a CLI command and goes as is, without the envelope. `preface` goes before
   *  the message, to the agent only (the onboarding prompt); the session label stays the message. */
  private async turn(i: Inbound, key: string, name: string, o: { bare?: boolean; preface?: string; retried?: boolean } = {}): Promise<void> {
    const { bare = false, preface, retried = false } = o;
    const profile = this.cfg.profiles[name];
    const sender = this.senders[i.platform];
    const era = this.era.get(key) ?? 0;
    const row = this.map.ensureActive(key, i.text, profile.backend);
    if (!this.brains.get(key)?.alive && !this.binFor(profile)) {
      // Said plainly, not as the generic failure line: nothing is wrong with the chat or the session,
      // and no retry will help until the CLI is installed or `bin:` points at it.
      this.log(`turn failed key=${key} reason=${profileBin(profile)} not found`);
      return this.reply(i, `This chat's agent (${profileBin(profile)}) is not installed where Angelia can find it. Nothing was sent to it. Run angelia check-config on the host.`);
    }
    // A session starts only with the protections its last compile wrote. An edit that removed a deny
    // rule or turned the sandbox off, by an agent or by hand, stops here instead of widening the next launch.
    const refused = this.brains.get(key)?.alive ? [] : this.opts.launchGuard?.(name) ?? [];
    if (refused.length) {
      this.log(`launch refused key=${key} profile=${name}: ${refused.join('; ')}`);
      const why = refused[0] === 'never compiled' ? 'its profile was never compiled, so it has no deny rules yet'
        : refused.every((r) => r.startsWith('deny ') || r.startsWith('sandbox off')) ? `${refused.length} of its protections were changed outside Angelia`
        : refused[0];
      return this.reply(i, `This chat's agent was not started: ${why}. Nothing was sent to it. The owner can fix it with: angelia compile --write ${name}`);
    }
    const b = await this.brainFor(key, name);
    const text = preface ? `${preface}\n\n${agentText(i, bare)}` : agentText(i, bare);
    await sender?.typing?.(i.chat, true);
    let result: Extract<BrainEvent, { kind: 'result' }> | undefined;
    // Progress lines never hold the turn: they queue, merge while the bucket is full, and give way
    // to the answer and to permission prompts (deliver/rate.ts).
    const progress = new ProgressOutbox(this.rateFor(i.platform), (t) => this.replyFromAgent(i, t, profile, true),
      (e) => this.log(`progress failed key=${key} ${(e as Error).message}`));
    try {
      for await (const e of b.turn(text)) {
        if (e.kind === 'progress') progress.push(e.text);
        else if (e.kind === 'notice') await this.reply(i, e.text);
        else if (e.kind === 'permission') {
          if (e.detail) await this.reply(i, e.detail);
          await this.reply(i, permissionLine(e.id, e.tool, e.preview));
        }
        else result = e;
      }
    } catch (err) {
      this.log(`turn error key=${key} ${(err as Error).message}`);
    } finally {
      await sender?.typing?.(i.chat, false);
    }
    // What the agent said along the way and the rate limit held back goes in front of the answer.
    const unsent = await progress.close();
    if (!result || result.isError) {
      const stopped = (this.era.get(key) ?? 0) !== era;
      this.log(`turn failed key=${key} reason=${stopped ? 'stopped by the user' : result?.reason ?? 'exception'}`);
      // /stop, /new and a model change all kill the child mid-turn on purpose. The chat was already
      // told what happened; a failure line on top of it reads like a bug that is not there.
      if (stopped) return;
      if (!retried && !row.started && String(result?.reason ?? '').startsWith('exit')) {
        // First turn of a brand-new session died: retry exactly once with a fresh id, per plan E.
        // Once. A deterministic failure - not logged in, a flag this build rejects, no tmux - fails
        // the retry the same way, and an unbounded loop mints sessions and spawns processes as fast
        // as the machine allows while the chat hears nothing at all.
        await this.forget(key);
        this.map.startNew(key, i.text);
        this.log(`retry with fresh session key=${key}`);
        return this.turn(i, key, name, { ...o, retried: true });
      }
      await this.forget(key);
      if (unsent.length) await this.replyFromAgent(i, unsent.join('\n\n'), profile);
      // Out of usage: say so, and how to switch model, instead of "something broke".
      if (result?.text && isLimitText(result.text)) return this.reply(i, `${result.text}\n${limitHint(profile.backend)}`);
      return this.reply(i, failureLine(result?.reason, homedir(), i.isGroup));
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
      this.log(`deliver failed key=${key} ${(err as Error).message}`);
    }
  }

  /** Is this key a routed chat? */
  routed(key: string): boolean { return this.profileFor(key) !== undefined; }

  /** A prompt from this machine (`angelia turn`, a job). `fromAgent`: the chat's own agent asked, with
   *  its own token. That one is labelled as such and never runs as a CLI command: an agent a member
   *  talked into it must not reach /model or /logout, which only an owner may send. */
  async injectTurn(key: string, text: string, fromAgent = false, fromKey?: string): Promise<void> {
    const k = parseSessionKey(key);
    const senderName = fromKey ? `profile ${this.profileName(fromKey) ?? '?'} (${fromKey})` : fromAgent ? 'this chat\'s agent' : 'scheduled';
    const i: Inbound = { ...k, sender: fromKey ? 'profile' : 'local', senderName, text: cleanText(text), isGroup: isGroupChat(k.platform, k.chat), mentioned: true, media: [] };
    const route = matchRoute(this.cfg, i);
    if (!route) return;
    await this.queue.enqueue(key, () => this.turn(i, key, route.profile, { bare: !fromAgent && isAgentCommand(i) }));
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
    const k = `${from}>${to}`;
    const recent = (this.peerSends.get(k) ?? []).filter((t) => t > now - 3600_000);
    if (recent.length >= PEER_PER_HOUR) { this.log(`peer message refused from=${from} to=${to} reason=hourly-limit`); return `${PEER_PER_HOUR} messages to ${b} in the last hour; wait`; }
    recent.push(now);
    this.peerSends.set(k, recent);
    this.log(`peer message from=${from} (${a}) to=${to} (${b})`);
    return undefined;
  }

  /**
   * Attach a file to the chat behind a session key: `angelia send-media`, a cron launcher, or a
   * `MEDIA:` tag. The path is checked here, once, for every caller.
   */
  async sendMediaTo(key: string, req: MediaRequest): Promise<void> {
    const { platform: p, chat, thread } = parseSessionKey(key);
    const sender = this.senders[p];
    if (!sender?.sendMedia) throw new MediaError(`${p}: this adapter cannot send files`);
    const m = resolveMedia(req, p, { stateDir: this.opts.stateDir });
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
    if (!r) this.rates.set(p, r = new RateLimiter(this.cfg.defaults.max_out_per_min));
    return r;
  }

  /** `held`: the caller already took the first chunk's slot (a progress batch). */
  private async reply(i: Inbound, text: string, held = false): Promise<void> {
    const sender = this.senders[i.platform];
    if (!sender) throw new Error(`${i.platform} is not set up in the routing table`);
    let parts = chunk(text, LIMITS[i.platform]);
    // A very long answer as a hundred messages would hold the platform's bucket for minutes, every
    // other chat behind it: the start goes as text, the whole of it as a file.
    const whole = parts.length > LONG_ANSWER_PARTS && sender.sendMedia ? text : undefined;
    if (whole) parts = [...parts.slice(0, LONG_ANSWER_PARTS - 1), `… ${parts.length - LONG_ANSWER_PARTS + 1} more messages' worth: the whole answer is in the attached file.`];
    for (let n = 0; n < parts.length; n++) {
      if (!(held && n === 0)) await this.rateFor(i.platform).acquire(n === 0);
      await sender.send(i.chat, parts[n], i.thread);
    }
    if (whole) {
      const dir = mkdtempSync(join(tmpdir(), 'angelia-answer-'));
      const path = join(dir, 'answer.md');
      try {
        writeFileSync(path, whole, { mode: 0o600 });
        await this.rateFor(i.platform).acquire(true);
        await sender.sendMedia!(i.chat, { path, kind: 'document', mime: 'text/markdown', bytes: Buffer.byteLength(whole), fileName: 'answer.md' }, i.thread);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }

  /**
   * The agent's own words. With `media_tags` on for the profile, a `MEDIA:<absolute path>` line is
   * pulled out and the file is attached; the rest goes as text. Off by default: the road should not
   * read meaning into the brain's text unless this chat asked it to.
   */
  private async replyFromAgent(i: Inbound, text: string, profile: Profile, held = false): Promise<void> {
    if (!profile.media_tags) return this.reply(i, text, held);
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
    for (const b of [...this.brains.values(), ...this.parked.values()]) { const n = (b as { name?: unknown }).name; if (typeof n === 'string') keep.add(n); }
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

  status(): { key: string; alive: boolean; queued: number }[] {
    return [...this.brains].map(([key, b]) => ({ key, alive: b.alive, queued: this.queue.queued(key) }));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.brains.keys()].map((k) => this.dropBrain(k, false)));
  }
}

const AUDIO_EXT = /\.(ogg|opus|oga|m4a|mp3|wav|aac|flac|amr)$/i;

/** Files are handed to the agent by path. A voice note is labelled as such: the agent, not the router, transcribes it. */
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

