#!/usr/bin/env node
import { loadConfig, ConfigError, configWarnings } from '../instance/config/load.js';
import { runDaemon, readStatus, STATE_DIR } from '../daemon/daemon.js';
import { configPath, describeInstance, workspaceDir } from '../instance/instance.js';
import { join, resolve } from 'node:path';
import { initCommand } from '../instance/init-terminal.js';
import { selfOverrideWarning } from '../daemon/self.js';
import { cliWarnings } from '../brain/index.js';
import { tmuxWarnings, tuiHookWarnings } from '../brain/tui.js';
import { floorWarnings, nestingWarnings } from '../capabilities/compile.js';
import { guideText } from '../instance/guide.js';
import { profilesText, profilesJson, readSessions } from '../instance/profiles.js';
import { checkArgs, usageLines } from './cli-args.js';
import { parseSessionKey } from '../core/types.js';
import { readFileSync } from 'node:fs';
import { packageRoot, readBuild } from '../daemon/update.js';

const [cmd, ...rest] = process.argv.slice(2);

/** Asked for: exit 0. Reached by an unknown command: exit 2, so a typo in a script fails loudly. */
function usage(code = 2): never {
  console.log(['usage: angelia <command> [arguments]', ...usageLines()].join('\n'));
  process.exit(code);
}

// Before any command runs: `--help` and a flag the command does not know must never reach it.
const checked = checkArgs(cmd, rest);
if ('help' in checked) { console.log(checked.text); process.exit(0); }
if ('error' in checked) { console.error(`${checked.error}\n${checked.text}`); process.exit(2); }

try {
  switch (cmd) {
    case '--help': case '-h': case 'help':
      usage(0);
    case '--version': case '-v': case 'version': {
      // The package's version, and the commit and tag the build stamp names (none for a copy built by hand).
      const root = packageRoot();
      const b = readBuild(root);
      const v = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? '?';
      console.log(`angelia ${v}${b?.commit ? ` (${b.commit.slice(0, 7)}${b.tag ? `, ${b.tag}` : ''}${b.dirty ? ', modified' : ''})` : ''}`);
      break;
    }
    case 'init':
      await initCommand();
      break;
    case 'check-config': {
      const path = configPath(rest[0]);
      const cfg = loadConfig(path);
      // Name the table that was actually checked. The instance summary describes the default one,
      // which is the wrong thing to print when a path was given.
      console.log(rest[0] ? `table    ${resolve(path)}` : describeInstance());
      const warnings = [...configWarnings(cfg, workspaceDir(STATE_DIR)), ...cliWarnings(cfg), ...tuiHookWarnings(cfg.profiles), ...tmuxWarnings(cfg.profiles), ...floorWarnings(cfg, STATE_DIR), ...nestingWarnings(cfg)];
      const overridden = selfOverrideWarning();
      if (overridden) warnings.push(overridden);
      for (const w of warnings) console.log(`warning: ${w}`);
      console.log(`ok: ${Object.keys(cfg.profiles).length} profiles, ${cfg.routes.length} routes${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
      break;
    }
    case 'daemon':
      await runDaemon(configPath(rest[0]));
      break;
    case 'send': case 'turn': {
      const { localCall } = await import('../daemon/api/client.js');
      await localCall(cmd, rest);
      break;
    }
    case 'export': {
      const all = rest.includes('--all'), tools = rest.includes('--tools');
      const at = rest.indexOf('--session');
      const session = at >= 0 ? rest[at + 1] : undefined;
      const [chat] = rest.filter((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1));
      if (!chat) throw new Error('usage: angelia export <platform:chat> [--all | --session <id>] [--tools]');
      const { exportChat } = await import('../instance/export.js');
      const cfg = loadConfig(configPath());
      for (const row of exportChat(cfg, readSessions(join(STATE_DIR, 'sessions.json')), chat, { all, session, tools })) process.stdout.write(JSON.stringify(row) + '\n');
      break;
    }
    case 'jobs': {
      const { jobsCommand } = await import('../jobs/jobs-cli.js');
      await jobsCommand(rest);
      break;
    }
    case 'send-media': {
      const { sendMediaCall } = await import('../daemon/api/client.js');
      await sendMediaCall(rest);
      break;
    }
    case 'pair': {
      const { pairWhatsApp } = await import('../adapters/whatsapp/pair.js');
      await pairWhatsApp(configPath(rest[0]));
      break;
    }
    case 'unpair': {
      const { unpairWhatsApp } = await import('../adapters/whatsapp/pair.js');
      await unpairWhatsApp(configPath(rest[0]));
      break;
    }
    case 'profiles': {
      const json = rest.includes('--json');
      const cfg = loadConfig(configPath(rest.find((a) => !a.startsWith('--'))));
      if (!json) { console.log(profilesText(cfg)); break; }
      console.log(JSON.stringify(profilesJson(cfg, readSessions(join(STATE_DIR, 'sessions.json'))), null, 2));
      break;
    }
    case 'profile': {
      // The same steps onboarding takes, by hand: for a chat that should get an agent before anyone writes in it.
      const [sub, chat, ...words] = rest;
      const { platform, chat: id, thread } = parseSessionKey(chat ?? '');
      if (sub !== 'add' || !id || (platform !== 'whatsapp' && platform !== 'telegram')) throw new Error('usage: angelia profile add <whatsapp|telegram:chat> [name]');
      if (thread) throw new Error('profile add takes a chat, not a topic: a topic gets its own route under the chat\'s profile, by hand (angelia guide routing)');
      const table = resolve(configPath());
      const cfg = loadConfig(table);
      if (!cfg.onboard) throw new Error('profile add takes the new profile\'s settings from the onboard: block in the routing table; add one first (angelia guide onboard)');
      if (cfg.routes.some((r) => r.platform === platform && r.chat === id)) throw new Error(`${chat} is already routed`);
      const { onboardChat } = await import('../instance/onboard.js');
      const { selfPrompt } = await import('../daemon/self.js');
      const made = onboardChat({ table, cfg, platform, chat: id, chatName: words.join(' ') || undefined, instance: STATE_DIR, self: (p) => selfPrompt({ profile: p, table, instance: STATE_DIR }) });
      console.log(`Made profile ${made.name} in ${made.folder}, routed to ${chat}.${made.git ? ` Workspace git: ${await made.git}.` : ''}\nIts starter instructions ask it to set itself up on the first message. The daemon picks it up at the next restart (/restart in a chat you own, or angelia restart).`);
      break;
    }
    case 'guide':
      console.log(guideText(rest[0]));
      break;
    case 'workspace': {
      if (rest[0] === 'commit') {
        const { commitWorkspace } = await import('../instance/workspace-commit.js');
        const { workspaceGates } = await import('../instance/workspace-gates.js');
        const at = rest.findIndex((a) => a === '-m' || a === '--message');
        const paths = rest.slice(1).filter((a, i) => !a.startsWith('--') && !(at >= 0 && (i + 1 === at || i + 1 === at + 1)));
        console.log(commitWorkspace({ workspace: workspaceDir(STATE_DIR), message: at >= 0 ? rest[at + 1] ?? '' : '', paths, push: !rest.includes('--no-push'), gates: workspaceGates(configPath(), workspaceDir(STATE_DIR)) }));
        break;
      }
      if (rest[0] !== 'sync') throw new Error('usage: angelia workspace sync [--quiet] | angelia workspace commit -m <message> [path...] [--no-push]');
      const { syncWorkspace } = await import('../instance/instance.js');
      const done = syncWorkspace(workspaceDir(STATE_DIR));
      if (done || !rest.includes('--quiet')) console.log(done || 'nothing to save');
      break;
    }
    case 'status': {
      console.log(describeInstance());
      const overridden = selfOverrideWarning();
      if (overridden) console.log(`warning: ${overridden}`);
      console.log(readStatus());
      break;
    }
    case 'restart': {
      const { restartCommand } = await import('../daemon/restart.js');
      await restartCommand(rest);
      break;
    }
    case 'transcribe': {
      const { transcribe } = await import('../voice/transcribe.js');
      process.exit(transcribe(rest));
    }
    case 'speak': {
      const { speak } = await import('../voice/speak.js');
      process.exit(speak(rest));
    }
    case 'compile': {
      const { compileCommand } = await import('../capabilities/cli.js');
      await compileCommand(rest);
      break;
    }
    case 'update': {
      const { updateCommand } = await import('../daemon/update.js');
      await updateCommand(rest);
      break;
    }
    case 'service': {
      const { serviceCommand } = await import('../daemon/service.js');
      await serviceCommand(rest);
      break;
    }
    default:
      usage();
  }
} catch (e) {
  console.error(e instanceof ConfigError ? `config error: ${e.message}` : (e as Error).message);
  process.exit(1);
}
