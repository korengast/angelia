import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { Config } from './config/schema.js';
import { INSTANCE_DIR, buildSkeleton, createPrivateRepo, defaultConfigPath, ghReady, initRepo, isRepo, profileDir, profilesDir } from './instance.js';
import { expandHome, loadConfig } from './config/load.js';
import { isInside } from '../core/paths.js';
import { planProfile } from '../capabilities/compile.js';
import { readEnvFile, setEnvVar } from '../core/env.js';
import { voiceLines, voiceQuestions, type VoiceTools } from '../voice/setup.js';

/** Everything the wizard asks, as data, so the flow is testable without a terminal. */
export interface Ask {
  text(q: string, def?: string): Promise<string>;
  secret(q: string): Promise<string>;
  choose<T extends string>(q: string, options: { key: T; label: string }[], def?: T): Promise<T>;
  confirm(q: string, def?: boolean): Promise<boolean>;
  say(line: string): void;
}

export type App = 'telegram' | 'whatsapp';
export interface PairedChat { id: string; title: string; isGroup: boolean; sender?: string }

export interface InitDeps {
  ask: Ask;
  stateDir?: string;
  /** Validate a bot token; returns the bot username or throws. */
  verifyToken(token: string): Promise<string>;
  /** Block until someone writes to the bot, return that chat. */
  waitForChat(token: string): Promise<PairedChat>;
  /** Whether a command can be found, the way the daemon finds it (locateBin). Required: a missing one
   *  used to mean "nothing installed" here and "everything installed" in the voice questions. */
  hasBin(bin: string): boolean;
  /** Link a WhatsApp account as a device (the QR page `angelia pair` shows); resolves once linked. */
  linkWhatsApp(authDir: string): Promise<void>;
  /** Block until someone writes to the linked WhatsApp account, return that chat. */
  waitForWhatsAppChat(authDir: string): Promise<PairedChat>;
  /** Mark a folder trusted in grok, which reads a folder's CLAUDE.md only then; whether it holds. */
  trustGrok(cwd: string): Promise<boolean>;
  /** Clone Angelia's source into a folder; returns what happened, in words, or throws. */
  cloneAngelia(dest: string): string;
  /** Overridable so tests never touch a real `gh` or a real GitHub account. */
  ghReady?(): boolean;
  createRepo?(workspace: string, name: string): string;
  /** Install and start the login service for this table (`angelia service install`). Absent where
   *  there is no service (not macOS) and in tests that do not test it. */
  startService?(configPath: string): Promise<void>;
}

type Backend = 'claude-code' | 'grok' | 'pi' | 'codex';
export interface ProfileDraft { name: string; cwd: string; permission_mode: string; shell: boolean; model?: string; backend: Backend; add_dirs?: string[]; instructions?: string }
interface RouteDraft { platform: App; chat: string; profile: string; mention?: 'required'; owners?: string[]; allow_from?: string[] }

const SELF_DEV = 'angelia-dev';

const BACKENDS: { key: Backend; label: string; bin: string; instructions: string }[] = [
  { key: 'claude-code', label: 'Claude Code (claude)', bin: 'claude', instructions: 'CLAUDE.md' },
  { key: 'grok', label: 'Grok Build (grok)', bin: 'grok', instructions: 'CLAUDE.md' },
  // pi reads AGENTS.md or CLAUDE.md; CLAUDE.md, because compile writes its managed block there.
  { key: 'pi', label: 'pi (pi)', bin: 'pi', instructions: 'CLAUDE.md' },
  // Codex reads CLAUDE.md through the fallback name Angelia passes it (codex-config.ts).
  { key: 'codex', label: 'Codex (codex)', bin: 'codex', instructions: 'CLAUDE.md' },
];

const MODES = [
  { key: 'acceptEdits', label: 'acceptEdits — edits files freely, asks before shell and risky tools (recommended)' },
  { key: 'default', label: 'default — asks before every tool' },
  { key: 'bypassPermissions', label: 'bypassPermissions — never asks (only for a directory you trust the agent with)' },
] as const;

/**
 * Move an existing routing table aside, and return where it went. The wizard used to overwrite it
 * without a word: every route, every profile, every owner list, gone because someone ran `init`
 * twice. Onboarding is about to be the thing that builds a whole instance, and a setup step that
 * can destroy the config it is setting up cannot be that.
 */
export function backupConfig(configPath: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const to = `${configPath}.${stamp}.bak`;
  copyFileSync(configPath, to);
  chmodSync(to, 0o600);
  return to;
}

export async function runInit(d: InitDeps): Promise<{ configPath: string; envPath: string; kept?: true }> {
  const { ask } = d;
  const dir = d.stateDir ?? INSTANCE_DIR;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Where a table already is, if there is one - a workspace copy, or one left beside the
  // credentials from before workspaces existed. A new one always goes in the workspace.
  const configPath = defaultConfigPath(dir, dir);
  const envPath = join(dir, 'env');
  let replacing = false;

  // Asked first, before a single other question: nobody should answer fifteen of them and only
  // then find out what it cost.
  if (existsSync(configPath)) {
    ask.say(`There is already a routing table at ${configPath}.`);
    const what = await ask.choose('What should setup do with it?', [
      { key: 'keep', label: 'keep it and stop here — edit that file by hand instead (recommended)' },
      { key: 'replace', label: 'start over — the old table is copied aside first, then replaced' },
    ], 'keep');
    if (what === 'keep') {
      ask.say('Nothing was changed.');
      return { configPath, envPath, kept: true };
    }
    ask.say('The old table will be copied aside just before the new one is written.');
    replacing = true;
  }

  ask.say('Angelia setup. Two ways to use it:');
  const kind = await ask.choose('Which one?', [
    { key: 'quick', label: 'quick — one chat, one directory: your coding CLI reachable from your phone' },
    { key: 'advanced', label: 'advanced — a herd of assistants: several profiles, each with its own chats' },
  ], 'quick');

  const which = await ask.choose('Which chat app will you write from?', [
    { key: 'telegram', label: 'Telegram — a bot of your own, the simplest to set up (recommended)' },
    { key: 'whatsapp', label: 'WhatsApp — Angelia links to a second WhatsApp number, like WhatsApp Web' },
    { key: 'both', label: 'both' },
  ], 'telegram');
  const apps: App[] = which === 'both' ? ['telegram', 'whatsapp'] : [which];
  const link: Link = { authDir: join(dir, 'wa') };
  if (apps.includes('telegram')) link.token = await telegramToken(d, envPath);
  if (apps.includes('whatsapp')) await whatsappLink(d, link.authDir);
  const voice = await voiceQuestions(d.ask, d.hasBin);

  const profiles: ProfileDraft[] = [];
  const routes: RouteDraft[] = [];
  /** One or more chats for a profile, each confirmed by the person, each in the app they pick. */
  const chatsFor = async (name: string, first: boolean): Promise<void> => {
    let another = true;
    while (another) {
      const chat = await pairChat(d, apps, link, kind === 'quick' ? undefined : name, first);
      routes.push(routeFor(chat, name, await openGroup(d, chat)));
      first = false;
      another = kind === 'advanced' && await ask.confirm(`Another chat for "${name}"?`, false);
    }
  };
  if (kind === 'quick') {
    profiles.push(await profileQuestions(d, 'main', profileDir('main', dir)));
    await chatsFor('main', true);
  } else {
    let more = true;
    while (more) {
      const name = await ask.text('Profile name (short, one word, e.g. coding, family, side)', profiles.length ? undefined : 'coding');
      profiles.push(await profileQuestions(d, name, profileDir(name, dir)));
      await chatsFor(name, profiles.length === 1);
      more = await ask.confirm('Add another profile?', false);
    }
    const dev = await selfDevProfile(d, dir, profiles);
    if (dev) { profiles.push(dev); await chatsFor(dev.name, false); }
  }

  const cfg = {
    profiles: Object.fromEntries(profiles.map((p) => [p.name, { cwd: p.cwd, ...(p.backend !== 'claude-code' ? { backend: p.backend } : {}), permission_mode: p.permission_mode, ...(p.model ? { model: p.model } : {}), ...(p.add_dirs?.length ? { add_dirs: p.add_dirs } : {}), ...(p.shell ? { shell: true } : {}) }])),
    routes,
    ...(apps.includes('whatsapp') ? { whatsapp: { auth_dir: link.authDir } } : {}),
    ...(apps.includes('telegram') ? { telegram: { token_env: 'TELEGRAM_BOT_TOKEN' } } : {}),
    defaults: { unmatched: 'drop', max_out_per_min: 10, idle_exit_minutes: 30 },
  };
  Config.parse(cfg);
  // The skeleton first: the workspace is where the table belongs, so it has to exist before the
  // table is written into it. Only profiles that live inside the workspace get a directory here;
  // one pointed at an existing project of yours is left exactly as it is.
  const skel = buildSkeleton(profiles.filter((p) => isInside(p.cwd, profilesDir(dir))).map((p) => p.name), dir);
  for (const p of profiles) ensureProfileDir(p, voice);
  // Taken here rather than when the question was answered, so abandoning the wizard half way
  // leaves no stray copies behind.
  // Replacing an existing table rewrites it where it already is, even if that is the old place
  // beside the credentials: moving someone's config without being asked is its own surprise.
  // A first table always goes in the workspace.
  const writeTo = replacing ? configPath : skel.configPath;
  if (replacing) ask.say(`Old table saved as ${backupConfig(configPath)}`);
  // Owner phone numbers and chat ids live in it: readable by this user only, like the env file.
  writeFileSync(writeTo, stringify(cfg), { mode: 0o600 });
  ask.say(`Wrote ${writeTo}`);
  // Each new profile's file tools are kept off Angelia's own secrets before its agent ever starts, and
  // the daemon starts no agent whose profile was never compiled. A profile pointed at a folder of yours
  // outside the workspace is not written into unasked.
  const loaded = loadConfig(writeTo);
  for (const p of profiles) {
    if (!isInside(p.cwd, profilesDir(dir)) && !(await ask.confirm(`${p.name} lives outside the workspace, in ${p.cwd}. Write Angelia's deny rules into its .claude/settings.json? Its agent does not start without them.`, true))) {
      ask.say(`Later: angelia compile ${p.name} --write`);
      continue;
    }
    const plan = planProfile(loaded, p.name, { stateDir: dir });
    if (plan.conflicts.length) ask.say(`${p.name}: deny rules not written (${plan.conflicts.join('; ')})`);
    else plan.apply();
  }
  for (const p of profiles.filter((x) => x.backend === 'grok')) await grokTrust(d, p);
  await workspaceGit(d, skel.workspace);
  // Without a running daemon the chat just paired answers nothing, and a closed terminal looks like
  // a broken bot: the wizard offers the service rather than leaving it to a line in the README.
  if (d.startService && await ask.confirm('Keep Angelia running? It starts now, at every login, and comes back after a crash.', true)) {
    try {
      await d.startService(writeTo);
      ask.say('Done. Send your chat a message: the agent answers from its folder.');
    } catch (e) {
      ask.say(`The service was not installed: ${(e as Error).message}`);
      ask.say('Start it with:  angelia service install ' + writeTo);
    }
  } else {
    ask.say('Start it with:  angelia daemon ' + configPath);
    if (d.startService) ask.say('Or keep it running, at every login:  angelia service install ' + writeTo);
  }
  return { configPath, envPath };
}

/** How the wizard reaches each app: the Telegram bot's token, and where the WhatsApp login is kept. */
interface Link { token?: string; authDir: string }

/**
 * Wait for a message, then make the user confirm it is theirs: a stranger could write to the bot, or
 * to the WhatsApp number, during the window. `profile` names the profile in the advanced path.
 */
async function pairChat(d: InitDeps, apps: App[], link: Link, profile: string | undefined, first: boolean): Promise<PairedChat & { platform: App }> {
  const { ask } = d;
  const app = apps.length === 1 ? apps[0] : await ask.choose(profile ? `Which app is the chat for "${profile}" in?` : 'Which app will you write from?', [
    { key: 'telegram', label: 'Telegram' }, { key: 'whatsapp', label: 'WhatsApp' },
  ], 'telegram');
  const to = app === 'telegram' ? 'the bot' : 'the linked WhatsApp number';
  if (profile) ask.say(`Send a message to ${to} from the chat that should reach "${profile}" (a DM, or a group ${app === 'telegram' ? 'the bot' : 'that number'} is in). Waiting...`);
  else if (app === 'telegram') ask.say(`${first ? 'Now open' : 'Open'} Telegram, find your bot and send it any message. Waiting...`);
  else ask.say('Now, from your own WhatsApp, send any message to the linked number. Waiting...');
  for (;;) {
    const chat = app === 'telegram' ? await d.waitForChat(link.token!) : await d.waitForWhatsAppChat(link.authDir);
    const what = chat.isGroup ? `group "${chat.title}"` : `DM with ${chat.title}`;
    if (await ask.confirm(`Got a message from ${what} (id ${chat.id}). Pair it?`, true)) return { ...chat, platform: app };
    ask.say('Ignored. Waiting for the next message...');
  }
}

/**
 * Link the WhatsApp account, or keep the link already there. The warning comes first: on the
 * person's own number Angelia would not hear them (it ignores what its own account sends) and
 * would answer as them, and a brand-new number that behaves like a robot gets banned.
 */
async function whatsappLink(d: InitDeps, authDir: string): Promise<void> {
  const { ask } = d;
  if (existsSync(join(authDir, 'creds.json'))) {
    ask.say(`WhatsApp is already linked (${authDir}). To link another number: angelia unpair, then angelia pair.`);
    return;
  }
  ask.say('WhatsApp: Angelia becomes a linked device of a WhatsApp account, like WhatsApp Web. Use a second, established number, not your own: Angelia ignores what its own account sends, so on your number it would not hear you, and it would answer as you. A new number that acts like a robot is often banned within hours.');
  ask.say('A page with a QR code opens now. On the phone with that number: WhatsApp > Settings > Linked devices > Link a device, and scan it.');
  for (;;) {
    try { await d.linkWhatsApp(authDir); ask.say('WhatsApp linked.'); return; }
    catch (e) {
      ask.say(`WhatsApp was not linked: ${(e as Error).message}`);
      if (!(await ask.confirm('Try again?', true))) throw new Error('WhatsApp not linked. Run angelia init again, or choose Telegram.');
    }
  }
}

/** grok reads CLAUDE.md only in a folder it trusts, and a chat cannot answer grok's trust question. */
async function grokTrust(d: InitDeps, p: ProfileDraft): Promise<void> {
  const { ask } = d;
  const later = `Later: run grok --trust in ${p.cwd} once.`;
  if (!(await ask.confirm(`grok reads ${p.name}'s CLAUDE.md only in a folder it trusts. Mark ${p.cwd} as trusted in grok now?`, true))) { ask.say(later); return; }
  ask.say((await d.trustGrok(expandHome(p.cwd))) ? `grok trusts ${p.cwd}.` : `grok did not confirm the trust. ${later}`);
}

/**
 * The profile that works on Angelia itself, default no. The source is cloned into projects/, beside
 * the workspace; the profile lives in the workspace like any other and reaches the clone through
 * add_dirs. The clone is a code project with its own remote: the daemon keeps running the installed
 * package, and the instructions say so, so a half-finished change is never what answers the chats.
 */
async function selfDevProfile(d: InitDeps, dir: string, profiles: ProfileDraft[]): Promise<ProfileDraft | undefined> {
  const { ask } = d;
  if (profiles.some((p) => p.name === SELF_DEV)) return undefined;
  if (!(await ask.confirm('Add a profile that can work on Angelia itself? Its source is cloned into a projects folder for it.', false))) return undefined;
  const src = join(dir, 'projects', 'angelia');
  if (existsSync(src)) ask.say(`Using the copy already in ${src}.`);
  else {
    try { ask.say(d.cloneAngelia(src)); }
    catch (e) { ask.say(`Could not clone Angelia (${(e as Error).message}). No ${SELF_DEV} profile. Clone Angelia's repository into ${src}, then add the profile by hand.`); return undefined; }
  }
  const draft = await profileQuestions(d, SELF_DEV, profileDir(SELF_DEV, dir));
  return { ...draft, add_dirs: [src], instructions: selfDevInstructions(src) };
}

export function selfDevInstructions(src: string): string {
  return [
    `# ${SELF_DEV}`,
    'You are reached from a phone chat through Angelia. Reply in plain text, no markdown headings. Keep answers short unless asked for detail.',
    `This profile works on Angelia itself. The source is a git clone in ${src}, with its own remote. Read its README.md and CONTRIBUTING.md (if there is one) before the first change.`,
    'The daemon that delivers this chat is the installed package, not this clone. Never point the service, PATH or `angelia update --from` at the clone unless the owner asks for exactly that: a half-finished change would then be what answers every chat.',
    'Run the tests (npm test) before you say a change works, and show their output.',
  ].join('\n\n') + '\n';
}

/**
 * Groups answer only when mentioned, and only the person who paired them may use /sh or approve tools.
 * Who may talk to the agent there at all is asked, with "only me" as the default: a member who can
 * talk to an agent can steer it to read files and run whatever its permission mode allows.
 */
function routeFor(chat: PairedChat & { platform: App }, profile: string, open = false): RouteDraft {
  const { platform } = chat;
  if (!chat.isGroup) return { platform, chat: chat.id, profile };
  const me = chat.sender ? [chat.sender] : [];
  return { platform, chat: chat.id, profile, mention: 'required', owners: me, ...(open || !me.length ? { allow_from: ['*'] } : {}) };
}

async function openGroup(d: InitDeps, chat: PairedChat): Promise<boolean> {
  if (!chat.isGroup || !chat.sender) return false;
  return d.ask.confirm(`Let every member of "${chat.title}" talk to this agent? Anyone it listens to can steer it to read your files and run what its permission mode allows. No: only you.`, false);
}

async function telegramToken(d: InitDeps, envPath: string): Promise<string> {
  const { ask } = d;
  const existing = readEnvToken(envPath);
  if (existing) {
    try {
      const u = await d.verifyToken(existing);
      if (await ask.confirm(`Found a Telegram token for @${u}. Keep it?`, true)) return existing;
    } catch { ask.say('The stored Telegram token no longer works.'); }
  }
  ask.say('Telegram: open @BotFather, send /newbot, follow the two prompts, and copy the token it gives you.');
  for (;;) {
    const token = (await ask.secret('Paste the bot token (input hidden)')).trim();
    try {
      const u = await d.verifyToken(token);
      setEnvVar(envPath, 'TELEGRAM_BOT_TOKEN', token);
      ask.say(`Token works: @${u}. Stored in ${envPath} (mode 600).`);
      return token;
    } catch (e) {
      ask.say(`That token was rejected (${(e as Error).message}). Try again.`);
    }
  }
}

/** One question when more than one supported CLI is installed; otherwise the one that is, or Claude Code. */
async function backendQuestion(d: InitDeps, name: string): Promise<Backend> {
  const found = BACKENDS.filter((b) => d.hasBin(b.bin));
  if (found.length === 0) return 'claude-code';
  if (found.length === 1) return found[0].key;
  return d.ask.choose(`Which CLI answers "${name}"?`, found.map((b) => ({ key: b.key, label: b.label })), found[0].key);
}

async function profileQuestions(d: InitDeps, name: string, defCwd: string): Promise<ProfileDraft> {
  const { ask } = d;
  const backend = await backendQuestion(d, name);
  const instructions = BACKENDS.find((b) => b.key === backend)!.instructions;
  const cwd = await ask.text(`Directory for "${name}" (the agent's home: its ${instructions}, settings, memory live there)`, defCwd);
  const permission_mode = await ask.choose('Permission mode', MODES.map((m) => ({ key: m.key, label: m.label })), 'acceptEdits');
  // pi falls back to its own default provider, which may be one the owner has no login for (or, for a
  // Claude subscription, one billed as extra usage), so its model is asked for.
  const model = backend === 'pi' ? (await ask.text('Model for pi, as provider/model (empty: pi\'s own default)', '')).trim() || undefined : undefined;
  const shell = await ask.confirm('Enable /sh (run raw shell commands from the chat, no agent)? Only for chats you alone can write to.', false);
  return { name, cwd, permission_mode, shell, backend, ...(model ? { model } : {}) };
}

/**
 * Put the workspace under git, and offer a private remote when `gh` is already signed in.
 *
 * Only ever the workspace. Running git one directory up would put the bot token, the WhatsApp auth
 * store and the session state in range, which is the single failure this layout exists to prevent.
 * Setup never signs anyone in: an authenticated `gh` is a fact about the machine, and its absence
 * is simply a no.
 */
async function workspaceGit(d: InitDeps, workspace: string): Promise<void> {
  const { ask } = d;
  if (isRepo(workspace)) { ask.say(`Workspace is already a git repo: ${workspace}`); return; }
  ask.say('Your profiles, their instructions and the routing table live in the workspace. Nothing else does - the token and the WhatsApp login stay outside it, so the workspace is safe to keep in git.');
  if (!(await ask.confirm('Put the workspace under git?', true))) { ask.say('Not version controlled. You can run git init in it later.'); return; }
  ask.say(initRepo(workspace));
  if (!(d.ghReady ?? ghReady)()) { ask.say('No GitHub remote: `gh` is not signed in on this Mac. Sign in with `gh auth login` and push it yourself whenever you like.'); return; }
  if (!(await ask.confirm('gh is signed in. Create a PRIVATE GitHub repo and push the workspace to it?', false))) return;
  const name = await ask.text('Repository name', 'angelia-workspace');
  ask.say((d.createRepo ?? createPrivateRepo)(workspace, name));
}

/** The starter instruction file. Only the capabilities this install actually has are described. */
export function instructionFile(name: string, voice: VoiceTools): string {
  const parts = [
    `# ${name}`,
    'You are reached from a phone chat through Angelia. Reply in plain text, no markdown headings. Keep answers short unless asked for detail.',
    'Files from the chat arrive as `[file: path]` lines; read them when they matter.',
  ];
  parts.push(...voiceLines(voice));
  return parts.join('\n\n') + '\n';
}

export function ensureProfileDir(p: ProfileDraft, voice: VoiceTools = { transcribe: '', speak: '' }): void {
  const cwd = expandHome(p.cwd);
  mkdirSync(cwd, { recursive: true });
  const claudeMd = join(cwd, BACKENDS.find((b) => b.key === p.backend)!.instructions);
  if (!existsSync(claudeMd)) writeFileSync(claudeMd, p.instructions ?? instructionFile(p.name, voice));
}

/** The token as the daemon reads it: `export` and quotes allowed (core/env.ts). */
export function readEnvToken(envPath: string): string | undefined {
  return readEnvFile(envPath).TELEGRAM_BOT_TOKEN || undefined;
}
