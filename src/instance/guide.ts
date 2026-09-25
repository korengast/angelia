import { usageLines } from '../cli/cli-args.js';
/**
 * `angelia guide`: the manual an agent reads before it changes the setup. It describes how Angelia
 * is built, never one instance's contents (`angelia profiles` and `angelia status` do that), so it
 * ships with the code and changes only when the code does. The self prompt (self.ts) points here.
 *
 * Kept in code rather than as loose files so it can never be left out of the package or read from
 * the wrong install. A topic describes what works today; a design that is not built yet stays out.
 */
export const GUIDE: Record<string, { title: string; body: string }> = {
  layout: {
    title: 'where everything lives',
    body: `One instance is one folder, ~/.angelia by default (ANGELIA_STATE_DIR moves it).

workspace/            the brain half. A git repo; safe to push to a PRIVATE remote.
  routing.yaml        profiles and routes (\`angelia status\` prints which table is live)
  profiles/<name>/    one profile's home: its instruction file, memory, prompts, and
                      scripts/ with angelia-jobs.yaml beside it
  _shared/            doctrine several profiles import: read it, change it only on purpose
  _common/            co-working files: every profile that is not isolated may read and write here
  _capabilities/       what several profiles share: skills/<name>/ (a skill's folder) and
                      tools/<name>/ (the script behind a command); \`angelia guide capabilities\`
everything else       credentials and state: env (bot token), wa/ (WhatsApp login), sessions,
                      logs. Never in git, never printed, never copied into the workspace.

A profile's cwd may also point outside the workspace; then its files are not in this repo.
Code: the installed package (\`npm root -g\`/angelia-gateway). Never edit it in place; changes go through
the source repo and a new install.`,
  },
  profiles: {
    title: 'what a profile is, and adding one',
    body: `A profile is one agent setup: a folder (cwd) and the CLI that runs there. Several chats can
share one profile; each chat still gets its own session.

The easy way: \`angelia guide onboard\`. A new chat an owner writes in gets its profile by itself,
or \`angelia profile add <platform:chat> [name]\` makes one before anyone writes.

By hand:
1. Create workspace/profiles/<name>/ with its instruction file, CLAUDE.md (every backend reads it).
2. Add it under \`profiles:\` in routing.yaml. Fields: cwd, backend (claude-code | grok | pi | codex),
   permission_mode (default | acceptEdits | bypassPermissions | plan), model, effort, add_dirs,
   shell, shell_timeout_seconds, chrome, tui (claude-code only), media_tags, bin (the CLI's full
   path when it is not found), unsafe_ok, agent_commands (CLI slash commands every group member
   may send, e.g. [compact]), sandbox (claude-code: the CLI's own sandbox on, no escape; shell
   network only to sandbox.network.allowedDomains in settings.local.json; codex: on unless false),
   isolated (cut off from the other profiles and from _common/: for a profile other people talk
   to), and capabilities, except, deny (\`angelia guide capabilities\`).
   grok reads CLAUDE.md only in a folder it trusts: run \`grok --trust\` there once;
   \`grok inspect\` then says "Project trusted: yes".
   pi has no permission prompt of its own: Angelia loads a small extension into it that asks the
   chat and holds the compiled deny rules; in acceptEdits pi's own read and search tools and plain
   read-only commands run unasked, other shell commands ask. pi has no MCP and no sandbox. Its
   login is its own (\`pi\`, then /login); set model: as provider/model (e.g. from
   \`pi --list-models\`). A Claude subscription through pi draws on extra usage or fails.
   pi loads a folder's .pi/ settings and extensions only once you trust the folder in pi; Angelia
   needs neither, and compile denies the agent writes to .pi/ and .agents/ in its folder.
   Codex runs inside its own sandbox (the OS enforces it, shell included): it writes only in its
   folder, add_dirs, _common/ and temp, cannot read the denied paths, and has network. A command
   the sandbox stops is the cue to add a folder to add_dirs (then compile and restart).
   \`sandbox: false\` gives it full access. It asks in the chat only to run something outside the
   sandbox. It reads CLAUDE.md (as a fallback for AGENTS.md). Its login is its own (\`codex login\`).
3. Route a chat to it (\`angelia guide routing\`).
4. \`angelia compile <name> --write\`: the deny floor. The daemon starts no agent for a profile
   that was never compiled.
5. \`angelia check-config\`, then a restart.

bypassPermissions skips every prompt. Only on a folder with no secrets in reach, and never on a
group open to everyone (allow_from: "*") without the sandbox. A profile no route names is dead
config: check-config says so.

Profiles talk to each other. An agent asks another profile with
  angelia turn <its platform:chat> "<text>"
and the answer lands in that profile's chat; \`angelia send\` posts a line there instead. The message
arrives labelled "profile <name>", and the receiving agent weighs it as a request, not as the
owner. 30 messages an hour from one chat to another at most. Neither works to or from an isolated
profile. Profiles never read each other's folders: they ask, or share files in _common/.
\`angelia profiles\` lists what exists.`,
  },
  routing: {
    title: 'which chat reaches which profile',
    body: `routes: in routing.yaml, one entry per chat:
  platform: whatsapp | telegram
  chat: the chat id (WhatsApp groups end in @g.us; Telegram groups are negative numbers)
  thread: optional, a Telegram topic
  profile: a name from profiles:
  mention: required | any (in groups: must the bot be mentioned?)
  allow_from: who may talk to the agent besides the owners: sender ids, or "*" for everyone in
          the chat (check-config warns). Empty, the default: the owners only. In a DM, the
          chat's own user.
  owners: sender ids that may use /new /stop /resume /model /effort /backend /sh /restart, send the CLI's own
          slash commands, and answer permission prompts

An unknown chat is dropped (defaults.unmatched), or with unmatched: onboard an owner's first message
there (in a group, one that mentions the bot) makes its profile (\`angelia guide onboard\`). The daemon reads the table only at start:
after any edit run \`angelia check-config\`, then an owner sends /restart in the chat (it checks the
table first and refuses a broken one) or runs \`angelia restart\` from a terminal. An agent must never
restart the daemon it runs under: \`angelia restart\` refuses, and /sh cannot do it either.`,
  },
  onboard: {
    title: 'a new chat gets its own profile',
    body: `With this in routing.yaml, an owner who writes in a chat no route knows gets a new profile for it:

defaults: { unmatched: onboard }
onboard:
  owners: ["15551234567"]          who may start one; anyone else is dropped without a reply.
                                   In a group the message must mention the bot or reply to it.
  allow_from: ["15551234567", ...] who may talk to it (default: the owners)
  folder: ~/agents                 where new folders go (default: workspace/profiles)
  mention: any                     the new route's mention setting
  skip: ["whatsapp:1203…@g.us"]    chats never onboarded: ones another gateway still serves, or
                                   archived ones. Fill it before turning onboard on, since every
                                   chat not in routes: counts as new. Take a key off when it moves.
  profile: { backend: claude-code, permission_mode: acceptEdits, model: ..., capabilities: [...] }
  prompt: ~/.angelia/workspace/_shared/onboarding.md   your own prompt (default: the one shipped)

On that first message Angelia names the profile after the chat (the group's name), makes its folder
and a starter CLAUDE.md, adds the profile and the route to routing.yaml (the old table is kept as a
.bak, and a table that would not load is put back), compiles its capabilities, and starts using it at
once, with no restart. In the default folder the new profile is committed to the workspace repo (made
if missing) and pushed when the repo has a remote. The first turn carries the onboarding prompt: the agent asks what the chat is
for and writes its own instructions and memory. The shipped prompt is prompts/onboarding.md in the
Angelia package; copy it and point onboard.prompt at the copy to change it.

\`angelia profile add <platform:chat> [name]\` does the same by hand, for a chat nobody has written in
yet; the daemon picks it up at the next restart. Adding the bot to a group is not enough to get an
agent: only an owner's message is.`,
  },
  capabilities: {
    title: 'skills, scripts and tools: where each one lives',
    body: `A capability is something a profile may use: a skill, a command, an MCP server, or a folder.
It is defined once under capabilities: in routing.yaml, given to profiles by name, and written
into each profile's folder by \`angelia compile <profile> --write\`. The daemon never reads it.

Where the files go:
1. A skill is a capability. Its folder lives in workspace/_capabilities/skills/<name>/ and the
   table names it relative to the workspace, so it is in git and moves with the instance:
     capabilities:
       fitness-coach: { kind: skill, path: _capabilities/skills/fitness-coach, when: "..." }
   A relative path is read from the folder that holds routing.yaml. check-config warns about a
   skill that lives outside the workspace.
2. A script only one profile uses is not a capability. It lives in profiles/<name>/scripts/,
   next to that profile's angelia-jobs.yaml, and moves with the profile.
3. A script several profiles use is a capability: either inside the skill that documents it
   (_capabilities/skills/<skill>/scripts/), or a command with its file in _capabilities/tools/<name>/:
     weather: { kind: command, run: "python3 ~/.angelia/workspace/_capabilities/tools/weather/forecast.py", when: "..." }
   run is a shell line the agent types from its own folder, so name the file from ~ or in full.
4. Tokens, logins and the data a script reads stay outside git: in the instance folder beside
   the workspace, or where the tool keeps them. A capability lists such files under secrets:,
   and a profile that denies the capability is denied those files too.

A folder capability (kind: directory) is usually data, such as documents a profile may read; it
may point anywhere and is added to the profile's reachable folders.

defaults.capabilities goes to every profile, defaults.deny to none; a profile adds with
capabilities:, drops a default with except:, and denies with deny:, which wins over everything.
Without --write, compile only prints what it would change. After a write, a restart.

Starter skills ship with Angelia and \`angelia init\` copies them into _capabilities/skills/
(an existing folder of the same name is left alone): checkout (build the cart, hand the owner a
checkout link to pay on the phone) and mfa (one-time codes from email or SMS). They are gentle
suggestions for a good personal assistant, not rules; give them to a profile like any other
skill, edit them freely, or leave them out.`,
  },
  commit: {
    title: 'saving a change to the workspace',
    body: `angelia workspace commit -m "<what changed and why>" [path...] [--no-push]

The way an agent saves its own change. Paths are relative to where you run it (your profile
folder: \`.\` is your own files); with none, every change in the workspace goes in. Only the
paths named are committed: another profile's pending edit stays out of your commit.

Before committing it checks, and on any failure unstages everything and commits nothing (the
files stay as they are, to fix and try again):
- secret scan: an added line holding a key-, token- or private-key-shaped value. Removing one
  is never blocked. The value is never printed.
- check-config: the routing table loads.
- compile --check: each profile the commit touches matches the table (angelia compile <p>
  --write). A commit of routing.yaml or of anything outside profiles/ checks every profile.
- jobs: the job timers of those profiles match their files (angelia jobs install), macOS only.
Then it pushes when the workspace has a remote.

angelia workspace sync saves everything under a dated message, after the secret scan only (a
flagged file is left out and named): run it from a job
(angelia guide jobs) if you want it nightly. It is not a way to record one change.

To make this the only way a Claude Code profile commits, its .claude/settings.json holds:
  "allow": ["Bash(angelia workspace commit:*)"],
  "deny":  ["Bash(git commit:*)", "Bash(git push:*)"]
A deny rule matches the command's start, so it stops the plain forms, not every spelling of git.
It keeps a careful agent on the checked path; it is not a wall against a hostile one.`,
  },
  doctrine: {
    title: 'where a rule belongs',
    body: `Three places, narrowest first:
- The profile's own instruction file: rules for that one agent. Yours to write.
- _shared/<topic>.md: a rule several profiles follow. Each profile imports it explicitly
  (\`@../../_shared/<topic>.md\` in CLAUDE.md). A change there reaches every importer, so say who
  imports it before you change it.
- Angelia's own self prompt: product text, not for editing. An owner may replace it with
  workspace/_shared/angelia-self.md; status and check-config then warn it no longer follows upgrades.

Keep instruction files short: they load on every turn. Detail an agent needs only sometimes goes
in a separate file the instruction file points to by path, read when needed.`,
  },
  jobs: {
    title: 'scheduled jobs',
    body: `A profile's jobs live in angelia-jobs.yaml in its own folder, so they move with it:

jobs:
  morning-card:
    schedule: "0 8 * * mon-fri"     # five-field cron; or every: 30m / 2h / 1d
    turn: "Write today's card."      # or send: <text>, or run: <shell command>
  # chat: whatsapp:<id>              # needed only when the profile has more than one routed chat

turn asks the agent, in the chat's own session; send posts text; run executes a command in the
profile folder (the profile needs shell: true) and posts what it prints. Printing nothing, or
[SILENT], posts nothing; a failure is posted as one line.

angelia jobs                 lists jobs and whether their timers match the file
angelia jobs install [p]     writes and loads the timers (a LaunchAgent each, macOS)
angelia jobs run <p> <job>   runs one now
angelia jobs remove <p> [job]

The daemon has no scheduler; the operating system runs the timers. A timer runs the job as it
was when installed: after editing the file, install again, or the timer refuses and says so.`,
  },
  commands: {
    title: 'the angelia command',
    // The same list `angelia --help` prints (cli/cli-args.ts), so the two never drift apart.
    get body() {
      return `${usageLines().join('\n')}

In a chat the router itself answers /new /stop /resume /status /model /effort /backend /sh /restart /help;
those never reach the agent. angelia restart from a terminal is owner only; in a chat the owner
sends /restart.`;
    },
  },
};

export function guideText(topic?: string): string {
  if (!topic) {
    const rows = Object.entries(GUIDE).map(([k, t]) => `  ${k.padEnd(10)} ${t.title}`);
    return ['angelia guide <topic>', '', ...rows].join('\n');
  }
  const t = GUIDE[topic];
  if (!t) throw new Error(`no guide topic "${topic}". Topics: ${Object.keys(GUIDE).join(', ')}`);
  return `${topic}: ${t.title}\n\n${t.body}`;
}
