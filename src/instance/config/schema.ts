import { z } from 'zod';

export const PermissionMode = z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']);
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

/** An environment variable's name, never its value: secrets stay in ~/.angelia/env, outside git. */
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name, not a value (secrets stay in ~/.angelia/env)');

/**
 * A tool, skill, MCP server or folder a profile may use, compiled into the profile's own files by
 * `angelia compile`. The daemon never reads these; see src/capabilities/.
 */
export const Capability = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), run: z.string().min(1), when: z.string().min(1) }),
  z.object({ kind: z.literal('skill'), path: z.string().min(1), when: z.string().optional(), secrets: z.array(z.string()).default([]) }),
  z.object({
    kind: z.literal('mcp'),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    url: z.string().url().optional(),
    env: z.array(EnvName).default([]),
    when: z.string().optional(),
    secrets: z.array(z.string()).default([]),
  }).refine((c) => !!c.command !== !!c.url, 'an mcp capability has either command or url'),
  z.object({ kind: z.literal('directory'), path: z.string().min(1), when: z.string().optional() }),
]);

export const Profile = z.object({
  cwd: z.string(),
  /** Capabilities this profile gets on top of defaults.capabilities; they also lift a default deny. */
  capabilities: z.array(z.string()).default([]),
  /** Default capabilities this profile does not get. */
  except: z.array(z.string()).default([]),
  /** Denied on top of defaults.deny. A profile's own deny beats everything. */
  deny: z.array(z.string()).default([]),
  permission_mode: PermissionMode.default('acceptEdits'),
  model: z.string().optional(),
  effort: Effort.optional(),
  add_dirs: z.array(z.string()).default([]),
  unsafe_ok: z.boolean().default(false),
  shell: z.boolean().default(false),
  shell_timeout_seconds: z.number().positive().default(60),
  /** Launch the agent with Claude in Chrome (--chrome): browser tools inside the user's everyday Chrome. */
  chrome: z.boolean().default(false),
  /** Which local CLI answers this profile. claude-code: Claude Code. grok: Grok Build. pi: pi. codex: Codex. */
  backend: z.enum(['claude-code', 'grok', 'pi', 'codex']).default('claude-code'),
  /** The backend's executable, when it is not `claude` / `grok` / `pi` / `codex` on PATH or in the usual
   *  install folders. A full path; `~` is allowed. */
  bin: z.string().optional(),
  /** Claude Code only: run the agent as a real interactive session in tmux instead of print mode.
   *  Remote Control then reaches the Claude app, the session survives a daemon restart, MCP servers
   *  stay warm and slash commands behave as they do in a terminal. Print mode stays the default:
   *  it is the one with a clean permission channel. */
  tui: z.boolean().default(false),
  /** Read `MEDIA:<absolute path>` lines in the agent's own replies and attach that file, instead of
   *  letting the line through as text. Off by default: a model that quotes such a line in prose would
   *  otherwise send a file nobody asked for. Turn it on for a chat whose instructions use the convention. */
  media_tags: z.boolean().default(false),
  /** CLI slash commands every member of a group may send as commands, such as `compact`. Owners may
   *  send any; from anyone else, a message that starts with a slash is text in the envelope. */
  agent_commands: z.array(z.string().regex(/^[a-z0-9:_-]+$/i).transform((s) => s.toLowerCase())).default([]),
  /** Claude Code only: compile the CLI's own sandbox on (`sandbox.enabled`, no unsandboxed escape). The
   *  OS then holds every command the agent runs to the deny rules and to its own folder for writes, so
   *  the deny floor stops a program, not only the file tools. Network from the shell is blocked except
   *  what `sandbox.network.allowedDomains` lists in the profile's settings.local.json.
   *  Codex: its own sandbox is on unless this is `false` (then full access); see codex-config.ts. */
  sandbox: z.boolean().optional(),
  /** Cut off from the other profiles: it cannot message them and they cannot message it, and it does
   *  not get the shared co-working folder (workspace/_common). For a profile other people talk to. */
  isolated: z.boolean().default(false),
});

const Id = z.union([z.string(), z.number()]).transform(String);

export const Route = z.object({
  platform: z.enum(['whatsapp', 'telegram']),
  chat: Id,
  thread: Id.optional(),
  profile: z.string(),
  mention: z.enum(['required', 'any']).optional(),
  /** Who may talk to the agent besides the owners: sender ids, or "*" for everyone in the chat.
   *  Empty (the default): the owners only. */
  allow_from: z.array(Id).default([]),
  /** Sender ids that may use /sh and answer permission prompts. In a DM the chat's own user always may. */
  owners: z.array(Id).default([]),
});

export const Config = z.object({
  capabilities: z.record(z.string(), Capability).default({}),
  profiles: z.record(z.string(), Profile),
  routes: z.array(Route),
  whatsapp: z
    .object({
      auth_dir: z.string().default('~/.angelia/wa'),
      pairing: z.enum(['code', 'qr']).default('qr'),
      phone: z.string().optional(),
    })
    .optional(),
  telegram: z.object({ token_env: z.string().default('TELEGRAM_BOT_TOKEN') }).optional(),
  /**
   * `defaults.unmatched: onboard`: an owner writing in a chat no route knows gets a new profile for it.
   * Angelia makes the folder and the starter instruction file, adds the profile and the route to this
   * table, and hands that first message to its agent together with the onboarding prompt.
   */
  onboard: z.object({
    /** Who may start a new profile by writing in an unknown chat. Anyone else is dropped, quietly. Also the new route's owners. */
    owners: z.array(Id).min(1, 'onboard.owners: at least one sender id; without it anyone who adds the bot to a group gets a profile'),
    /** Who may talk to a new profile's agent. Default: the owners. */
    allow_from: z.array(Id).optional(),
    /** Where new profile folders are made. Default: the workspace's profiles/ folder. */
    folder: z.string().optional(),
    /** Fields every new profile starts with (backend, model, permission_mode, shell, capabilities...). */
    profile: z.record(z.string(), z.unknown()).default({}),
    /** The new route's mention setting. */
    mention: z.enum(['required', 'any']).optional(),
    /** Chats that are never onboarded, as platform:chat: ones another gateway still serves, or archived
     *  ones. An owner's message there is dropped as before. Take a key off when its chat moves here. */
    skip: z.array(z.string().regex(/^(whatsapp|telegram):\S+$/, 'onboard.skip: platform:chat, like whatsapp:120363000000000001@g.us')).default([]),
    /** Your own onboarding prompt. Default: prompts/onboarding.md, shipped with Angelia. */
    prompt: z.string().optional(),
  }).optional(),
  defaults: z
    .object({
      /** drop: say nothing. reply: one line an hour. onboard: an owner's message makes a new profile (needs onboard:). */
      unmatched: z.enum(['drop', 'reply', 'onboard']).default('drop'),
      /** Messages out per minute, per platform. Progress lines always leave one free for the answer. */
      max_out_per_min: z.number().int().positive().default(10),
      idle_exit_minutes: z.number().positive().default(30),
      permission_timeout_minutes: z.number().positive().default(10),
      /** Capabilities every profile gets, unless it lists them under except. */
      capabilities: z.array(z.string()).default([]),
      /** Denied to every profile, unless it lists them under its own capabilities. */
      deny: z.array(z.string()).default([]),
    })
    .prefault({}),
});

export type Capability = z.infer<typeof Capability>;
export type Profile = z.infer<typeof Profile>;
export type Route = z.infer<typeof Route>;
export type Config = z.infer<typeof Config>;
