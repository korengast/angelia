/**
 * What each subcommand accepts, checked before the command runs. `--help` prints the command's usage
 * and exits 0; a flag the command does not know prints the usage and exits 2. Without this, a
 * subcommand that ignores what it does not read runs for real: `workspace sync --help` saved and pushed.
 */

/** One usage line of `angelia --help`; several commands can share one. */
interface Spec {
  line: string;
  /** The full usage, when one line cannot hold it. */
  usage?: string;
  /** Flag name → true when it takes a value (the next word). */
  flags?: Record<string, boolean>;
  /** Free text after the first word: only a leading --help is read, the rest is the message. */
  text?: boolean;
}

const L = {
  init: '  init                                   set up an instance: token, CLI, first profile, first chat',
  daemon: '  daemon | status | restart [--force]    run, inspect, restart the daemon',
  service: '  service <install [table]|uninstall [--force]|status>   the daemon as a LaunchAgent (macOS)',
  config: '  check-config | profiles [--json]       validate the table; list profiles and their chats',
  profile: '  profile add <platform:chat> [name]     a new profile and route, as onboarding makes them',
  compile: '  compile [profile...] [--write|--check] [--config <routing.yaml>]   capabilities into the profile folder',
  jobs: '  jobs [install|remove|run] [profile] [job] [--config <routing.yaml>]   scheduled jobs (angelia guide jobs)',
  workspace: '  workspace sync [--quiet]               commit and push what the profiles changed (run it from a job)\n  workspace commit -m <message> [path...] [--no-push]   one change, after the gates (angelia guide commit)',
  send: '  send <platform:chat> <text>            post into a routed chat',
  media: '  send-media <platform:chat> <path> [caption]   attach a file (--name FILE, --caption TEXT, --no-voice)',
  turn: '  turn <platform:chat> <text|-|@file>    run a prompt in that chat\'s session',
  export: '  export <platform:chat> [--all | --session <id>] [--tools]   the chat\'s turns as JSONL',
  pair: '  pair | unpair                          link or unlink WhatsApp',
  transcribe: '  transcribe <audio> [--language xx] [--model name]   the bundled transcriber (run by agents)',
  speak: '  speak <text> [--voice name] [--rate n] [--out path]   the bundled voice (run by agents)',
  update: '  update [--check] [--from <git URL|folder>] [--head] [--force]   install the newest signed release',
  guide: '  guide [topic]                          the manual agents read before changing the setup',
};

export const COMMANDS: Record<string, Spec> = {
  init: { line: L.init },
  daemon: { line: L.daemon },
  status: { line: L.daemon },
  // --from-daemon: the daemon restarting itself; not for people.
  restart: { line: L.daemon, flags: { '--force': false, '--from-daemon': false } },
  service: { line: L.service, flags: { '--force': false } },
  'check-config': { line: L.config },
  profiles: { line: L.config, flags: { '--json': false } },
  profile: { line: L.profile },
  compile: { line: L.compile, flags: { '--write': false, '--check': false, '--config': true } },
  // --hash: what a timer passes, so a changed job refuses to run from an old timer.
  jobs: { line: L.jobs, flags: { '--config': true, '--hash': true } },
  workspace: { line: L.workspace, usage: 'usage: angelia workspace sync [--quiet]\n       angelia workspace commit -m <message> [path...] [--no-push]', flags: { '--quiet': false, '-m': true, '--message': true, '--no-push': false } },
  send: { line: L.send, text: true },
  'send-media': { line: L.media, flags: { '--name': true, '--caption': true, '--no-voice': false } },
  turn: { line: L.turn, text: true },
  export: { line: L.export, flags: { '--all': false, '--tools': false, '--session': true } },
  pair: { line: L.pair },
  unpair: { line: L.pair },
  transcribe: { line: L.transcribe, flags: { '--language': true, '--lang': true, '--model': true } },
  speak: { line: L.speak, flags: { '--voice': true, '--out': true, '--rate': true } },
  update: { line: L.update, flags: { '--check': false, '--from': true, '--head': false, '--force': false } },
  guide: { line: L.guide },
};

/** Every command's line once, in table order: the body of `angelia --help`. */
export function usageLines(): string[] {
  return [...new Set(Object.values(COMMANDS).map((s) => s.line))];
}

const isHelp = (a: string) => a === '--help' || a === '-h';
/** A word that looks like a flag. A lone `-` is stdin, and `-5` a number, so neither is one. */
const isFlag = (a: string) => a === '-h' || /^--[A-Za-z]/.test(a);

export type ArgCheck = { ok: true } | { help: true; text: string } | { error: string; text: string };

/** Read `argv` (the words after the command) against the command's spec. Unknown commands pass: the caller handles them. */
export function checkArgs(cmd: string, argv: string[]): ArgCheck {
  const spec = COMMANDS[cmd];
  if (!spec) return { ok: true };
  const text = spec.usage ?? `usage: angelia ${spec.line.trim().replace(/\s{2,}.*$/, '')}`;
  if (spec.text) return argv.length && isHelp(argv[0]) ? { help: true, text } : { ok: true };
  const flags = spec.flags ?? {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (isHelp(a)) return { help: true, text };
    if (a in flags) { if (flags[a]) i++; continue; }
    if (!isFlag(a)) continue;
    if (!(a in flags)) return { error: `unknown flag ${a} for angelia ${cmd}`, text };
    if (flags[a]) i++;
  }
  return { ok: true };
}
