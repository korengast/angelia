import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync, statSync } from 'node:fs';
import { workspaceDir } from '../instance/instance.js';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig, configWarnings } from '../instance/config/load.js';
import { cliWarnings, pathWithBins, type BackendName } from '../brain/index.js';
import { scrubTmuxServer, sweepPanes, tmuxWarnings, tuiHookWarnings } from '../brain/tui.js';
import { STRIP_ENV } from '../brain/argv.js';
import { profileEnv, readEnvFile, SESSION_ENV, tableSecrets } from '../core/env.js';
import { Orchestrator, type Sender } from '../core/orchestrator.js';
import { TelegramAdapter } from '../adapters/telegram/adapter.js';
import { WhatsAppAdapter } from '../adapters/whatsapp/adapter.js';
import { matchRoute } from '../core/router/match.js';
import { gate as routeGate } from '../core/router/gate.js';
import { API_SOCKET, ApiServer, claimSocket, loadOrMintToken, sessionToken } from './api/server.js';
import { selfPrompt, selfOverrideWarning, upsertSelfBlock, FILE_BACKENDS } from './self.js';
import { blockText, floorWarnings, launchCheck, nestingWarnings, readRecord, seedGuards } from '../capabilities/compile.js';
import { launchChatRestart, takeRestartNote } from './restart.js';
import { onboardChat } from '../instance/onboard.js';
import { switchBackend as switchProfileBackend } from '../instance/switch-backend.js';
import type { Inbound } from '../core/types.js';

export const STATE_DIR = process.env.ANGELIA_STATE_DIR ?? join(homedir(), '.angelia');

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' && !!process.env.CODEX_SANDBOX; }
}

/** `~/.angelia/env`: the bot token and the secrets capabilities name. See core/env.ts. */
export function envFile(stateDir = STATE_DIR): Record<string, string> {
  return readEnvFile(join(stateDir, 'env'));
}

/** Past this size the log moves to daemon.log.1, replacing the one before: two files at most. */
const LOG_MAX = 10 << 20;
let logSize = -1;

export function logLine(line: string): void {
  const stamp = new Date().toISOString();
  const file = join(STATE_DIR, 'daemon.log'), text = `${stamp} ${line}\n`;
  try {
    if (logSize < 0) logSize = existsSync(file) ? statSync(file).size : 0;
    if (logSize + text.length > LOG_MAX) { renameSync(file, `${file}.1`); logSize = 0; }
    appendFileSync(file, text, { mode: 0o600 });
    logSize += Buffer.byteLength(text);
  } catch {}
  if (process.stdout.isTTY) console.log(`${stamp} ${line}`);
}

export async function runDaemon(configPath: string): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  // A folder that existed before keeps whatever mode it had; the secrets inside are only as private as it is.
  const mode = statSync(STATE_DIR).mode & 0o777;
  if (mode & 0o077) { chmodSync(STATE_DIR, 0o700); logLine(`${STATE_DIR} was mode ${mode.toString(8)}; set to 700`); }
  const pidFile = join(STATE_DIR, 'daemon.pid');
  if (existsSync(pidFile)) {
    const old = Number(readFileSync(pidFile, 'utf8'));
    if (old && pidAlive(old)) throw new Error(`another angelia daemon is running (pid ${old})`);
  }
  writeFileSync(pidFile, String(process.pid));

  // Held in memory, never copied into process.env: everything this process starts inherits that.
  const secrets = envFile();
  const cfg = loadConfig(configPath);
  for (const w of configWarnings(cfg, workspaceDir(STATE_DIR))) logLine(`config warning: ${w}`);
  for (const w of [...tuiHookWarnings(cfg.profiles), ...tmuxWarnings(cfg.profiles), ...floorWarnings(cfg, STATE_DIR), ...nestingWarnings(cfg)]) logLine(`config warning: ${w}`);
  const missing = cliWarnings(cfg);
  for (const w of missing) logLine(`CLI MISSING: ${w}`);
  // Agents and a later /restart inherit this environment, so a CLI found outside PATH goes onto it.
  const fixed = pathWithBins(cfg);
  if (fixed.added.length) { process.env.PATH = fixed.path; logLine(`PATH: added ${fixed.added.join(', ')} (the shell that started the daemon did not have it)`); }
  const senders: Record<string, Sender> = {};
  const adapters: { stop(): Promise<void> }[] = [];

  const table = resolve(configPath);
  const self = (profile: string) => selfPrompt({ profile, table, instance: STATE_DIR });
  const overridden = selfOverrideWarning(STATE_DIR);
  if (overridden) logLine(`config warning: ${overridden}`);
  // grok takes no system prompt at launch, so their copy lives between markers in the file they read.
  for (const [name, p] of Object.entries(cfg.profiles)) {
    const file = FILE_BACKENDS[p.backend];
    if (!file) continue;
    try {
      // A compiled profile's capability lines share the block; rewriting it with the self text alone would drop them.
      const r = upsertSelfBlock(join(p.cwd, file), blockText(self(name), readRecord(p.cwd)?.blockLines ?? []));
      if (r === 'broken') logLine(`self prompt: ${name}: ${file} has one angelia:self marker without the other; left alone`);
      else if (r !== 'unchanged') logLine(`self prompt: ${name}: ${file} ${r}`);
    } catch (e) {
      logLine(`self prompt: ${name}: ${(e as Error).message}`);
    }
  }
  // Before a session starts: what would make it start with less than its last compile gave it. Fails
  // closed: a profile never compiled, or whose check cannot run, is not started (compile.ts, launchCheck).
  const seeded = seedGuards(cfg, STATE_DIR);
  if (seeded.length) logLine(`launch guard: took the compiled deny rules of ${seeded.join(', ')} from their own records (first start with the state-side guard)`);
  const launchGuard = (name: string): string[] => {
    try { return launchCheck(cfg, name, STATE_DIR); }
    catch (e) { logLine(`launch check ${name}: ${(e as Error).message}`); return [`the check failed: ${(e as Error).message}`]; }
  };
  // The owner's API token; each agent gets one derived from it that works only for its own chat.
  const apiToken = loadOrMintToken(join(STATE_DIR, 'api.token'), (mode) => logLine(`api.token was mode ${mode.toString(8)}; set back to 600`));
  const restart = {
    check: () => { try { loadConfig(configPath); return undefined; } catch (e) { return (e as Error).message; } },
    launch: (key: string) => launchChatRestart(key, table, (why) => {
      logLine(`restart failed key=${key}: ${why}`);
      void orch.notify(key, `The restart failed. Angelia is still running as before (pid ${process.pid}).\n${why}`)
        .catch((e) => logLine(`restart failure note: ${(e as Error).message}`));
    }),
  };
  const onboard = (i: Inbound, chatName?: string) => onboardChat({ table, cfg, platform: i.platform, chat: i.chat, chatName, instance: STATE_DIR, self });
  const switchBackend = (profile: string, backend: BackendName) => switchProfileBackend({ table, cfg, profile, backend, instance: STATE_DIR, self });
  const orch = new Orchestrator(cfg, senders, { stateDir: STATE_DIR, log: logLine, selfPrompt: self, restart, onboard, switchBackend, transcripts: true, secrets, sessionToken: (key) => sessionToken(apiToken, key), launchGuard });
  // A tmux server outlives the daemon and keeps the environment it was started with. One started by an
  // older build still carries the bot token and hands it to every new pane: take the secrets out.
  if (Object.values(cfg.profiles).some((p) => p.tui)) {
    const hidden = tableSecrets(cfg);
    const removed = await scrubTmuxServer([...hidden, ...Object.keys(secrets), ...STRIP_ENV, ...SESSION_ENV], profileEnv(process.env, secrets, hidden).env);
    if (removed.length) logLine(`tmux: took ${removed.join(', ')} out of the tmux server's environment; panes started before keep them until they relaunch`);
  }
  // Where an adapter may put a file from a chat: the profile folder, and only for a message that would
  // pass routing and gating. Nothing is downloaded for anyone else.
  const inboxFor = (i: Omit<Inbound, 'media'>) => { const r = matchRoute(cfg, i); return r && routeGate(i, r).ok ? cfg.profiles[r.profile].cwd : undefined; };
  const onInbound = (i: Inbound) => orch.handle(i).catch((e) => logLine(`handle error: ${(e as Error).message}`));
  const api = new ApiServer({
    send: (key, text, fromKey) => orch.notify(key, text, fromKey), turn: (key, text, fromAgent, fromKey) => orch.injectTurn(key, text, fromAgent, fromKey), routed: (key) => orch.routed(key),
    reach: (from, to) => orch.reach(from, to),
    sendMedia: (key, m) => orch.sendMediaTo(key, m),
  }, apiToken);
  const socket = join(STATE_DIR, API_SOCKET);
  await claimSocket(socket);
  await api.listen(socket);
  adapters.push({ stop: () => api.close() });

  let tgState = 'off';
  if (cfg.telegram) {
    const token = process.env[cfg.telegram.token_env] ?? secrets[cfg.telegram.token_env];
    if (!token) throw new Error(`telegram: ${cfg.telegram.token_env} is not set`);
    const tg = new TelegramAdapter({ token, log: logLine, inboxFor, onInbound, menuChats: cfg.routes.filter((r) => r.platform === 'telegram').map((r) => r.chat) });
    senders.telegram = tg;
    await tg.start();
    adapters.push(tg);
    tgState = 'polling';
  }
  let waState = 'off';
  let waAdapter: WhatsAppAdapter | undefined;
  if (cfg.whatsapp) {
    const wa = new WhatsAppAdapter({ authDir: cfg.whatsapp.auth_dir, pairing: cfg.whatsapp.pairing, phone: cfg.whatsapp.phone, log: logLine, inboxFor, onInbound });
    senders.whatsapp = wa;
    waAdapter = wa;
    wa.on('open', () => { waState = 'connected'; });
    wa.on('logged-out', () => { waState = 'logged out: run angelia pair'; });
    await wa.start();
    adapters.push(wa);
    waState = wa.connected ? 'connected' : 'connecting (pairing code on the terminal if not paired yet)';
  }

  // Written aside and renamed into place: a reader (angelia status, a restart looking for the table
  // it should use) must never catch half a file. A failure is logged once, not every ten seconds.
  let statusError = '';
  const writeStatus = () => {
    const path = join(STATE_DIR, 'status.json');
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), config: resolve(configPath), tg: tgState, wa: waState, sessions: orch.status() }, null, 2));
      renameSync(`${path}.tmp`, path);
      statusError = '';
    } catch (e) {
      if ((e as Error).message !== statusError) logLine(`status write failed: ${(statusError = (e as Error).message)}`);
    }
  };
  writeStatus();
  const statusTimer = setInterval(writeStatus, 10_000);
  const tmuxEnv = profileEnv(process.env, secrets, tableSecrets(cfg)).env;
  const reap = async () => {
    await orch.reapIdle();
    const { keep, prefixes } = orch.tuiPanes();
    const gone = await sweepPanes(keep, prefixes, tmuxEnv);
    if (gone.length) logLine(`tmux: ended ${gone.length} idle pane(s) no chat uses any more: ${gone.join(', ')}`);
  };
  const reapTimer = setInterval(() => reap().catch((e) => logLine(`idle reap failed: ${(e as Error).message}`)), 60_000);
  // A /restart asked for this: tell that chat we are back, once its platform can deliver.
  const note = takeRestartNote(STATE_DIR);
  if (note) {
    const back = () => void orch.notify(note.key, `Angelia is back up (pid ${process.pid}).`).catch((e) => logLine(`restart note: ${(e as Error).message}`));
    if (note.key.startsWith('whatsapp:') && waAdapter && !waAdapter.connected) waAdapter.once('open', back);
    else back();
  }
  logLine(`daemon up pid=${process.pid} profiles=${Object.keys(cfg.profiles).length} routes=${cfg.routes.length} tg=${tgState} wa=${waState} api=${API_SOCKET}${missing.length ? ` cli_missing=${missing.length}` : ''}`);

  const shutdown = async (sig: string) => {
    logLine(`shutdown on ${sig}`);
    clearInterval(statusTimer); clearInterval(reapTimer);
    await Promise.allSettled(adapters.map((a) => a.stop()));
    await orch.shutdown();
    try { unlinkSync(pidFile); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // One process carries every chat on every platform. A transient error in one of them - a socket
  // that closed mid-write, a promise nobody awaited - must not be the end of all of them. Node's
  // default for both of these is to print and exit.
  process.on('unhandledRejection', (reason) => logLine(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`));
  process.on('uncaughtException', (err) => logLine(`uncaught exception: ${err.message}`));
  await new Promise(() => {});
}

export function readStatus(): string {
  const p = join(STATE_DIR, 'status.json');
  if (!existsSync(p)) return 'no daemon status file';
  const s = JSON.parse(readFileSync(p, 'utf8'));
  const alive = pidAlive(Number(s.pid));
  const lines = [`daemon pid ${s.pid} ${alive ? 'alive' : 'DEAD'} · written ${s.at}`, `telegram: ${s.tg} · whatsapp: ${s.wa}`];
  for (const x of s.sessions ?? []) lines.push(`  ${x.key} ${x.alive ? 'warm' : 'cold'} queued=${x.queued}`);
  return lines.join('\n');
}

