import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { loadConfig } from '../instance/config/load.js';
import { effectiveTable } from '../instance/accepted.js';
import type { Config, Profile } from '../instance/config/schema.js';
import { STATE_DIR, envFile } from '../daemon/daemon.js';
import { configPath } from '../instance/instance.js';
import { pathWithBins } from '../brain/locate.js';
import { entry, servicePath, stableNode } from '../daemon/service.js';
import { apiCall, ownerToken, post } from '../daemon/api/client.js';
import { sessionToken } from '../daemon/api/server.js';
import { sessionKey } from '../core/types.js';
import {
  buildJobPlist, installedJobs, jobChat, jobLabel, jobPin, jobLoaded, jobPlistPath, loadJob, logJob,
  atDate, jobSandboxed, onceRan, onceState, readJobs, recordOnce, runJob, sameJob, unloadJob, AT_EARLY_MS, AT_GRACE_MS, JobEarly, JobMissed, JOBS_FILE,
  type Deliver, type Job,
} from './jobs.js';
import { lastRuns } from './jobs-view.js';

/** What a job delivers: its own definition (`send:`, `turn:`) with the owner's token, as written in
 *  the table's folder and pinned at install; a command's output with the chat's token, so the daemon
 *  holds its MEDIA: lines to the profile's rules like anything else the agent could have written. */
const jobDeliver = async (kind: 'send' | 'turn', key: string, text: string, asChat?: boolean): Promise<void> => {
  if (!asChat) return apiCall(kind, key, text);
  await post(`/${kind}`, { token: sessionToken(ownerToken(), key), key, text });
};

const USAGE = `usage: angelia jobs [profile...]            list jobs and whether their timers match
       angelia jobs install [profile...]    write and load the timers (all profiles when none named)
       angelia jobs remove <profile> [job]  unload and delete timers
       angelia jobs run <profile> <job>     run one job now`;

function tableOf(argv: string[]): { table: string; words: string[] } {
  const at = argv.indexOf('--config');
  const table = resolve(configPath(at >= 0 ? argv[at + 1] : undefined));
  const words = argv.filter((a, i) => !(at >= 0 && (i === at || i === at + 1)));
  return { table, words };
}

/** What a timer does, without what is copied from the installer's shell: comparing that would call a
 *  timer out of date merely because another shell looked at it. */
const same = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && sameJob(a, b);

/** What a job does; a command on a sandboxed profile says it runs in the agent's sandbox. */
const what = (j: Job, p?: Profile): string => (j.turn ? `turn "${j.turn.slice(0, 50)}"` : j.send ? `send "${j.send.slice(0, 50)}"` : `run ${j.run!.slice(0, 60)}${p && jobSandboxed(p) ? ' (sandboxed)' : ''}`);
const when = (j: Job): string => (j.every ? `every ${j.every}` : j.at ? `at ${j.at}` : `cron ${j.schedule}`);

/** Where timers and their log live, and the time now: the real ones, or a test's. */
export interface Place { stateDir: string; home: string; now?: Date }
const here = (): Place => ({ stateDir: STATE_DIR, home: homedir() });

function plan(cfg: Config, table: string, profile: string, at: Place = here()) {
  const { jobs, file } = readJobs(cfg, profile);
  const extra = [...pathWithBins(cfg).path.split(delimiter), dirname(process.execPath)];
  const path = servicePath(process.env, extra);
  const want = new Map<string, { plist: string; name: string; j: Job }>();
  // A one-time job after its moment gets no timer, and says whether it ran.
  const past = new Map<string, { name: string; j: Job; state: 'done' | 'passed' }>();
  const runs = lastRuns(at.stateDir);
  const ran = onceRan(at.stateDir);
  for (const [name, j] of Object.entries(jobs)) {
    if (!j.enabled) continue;
    const label = jobLabel(profile, name);
    const once = onceState(j, runs.get(`${profile}/${name}`) ?? [], at.now, ran[`${profile}/${name}`]);
    if (once) { past.set(label, { name, j, state: once }); continue; }
    want.set(label, { name, j, plist: buildJobPlist({ label, node: stableNode(), entry: entry(), profile, job: name, hash: jobPin(j, cfg.profiles[profile]), config: table, stateDir: at.stateDir, path, home: at.home, cwd: cfg.profiles[profile].cwd, j }) });
  }
  const prefix = jobLabel(profile, '');
  const have = new Map([...installedJobs(at.stateDir, at.home)].filter(([l]) => l.startsWith(prefix)));
  return { file, jobs, want, have, past };
}

/** What the timers are done with; launchctl itself, or a test's stand-in. */
export interface Timers { load(label: string): void; unload(label: string): void; loaded(label: string): boolean }
const launchd = (home: string): Timers => ({ load: (l) => loadJob(l, home), unload: (l) => unloadJob(l, home), loaded: jobLoaded });

/** `angelia jobs install`: each profile's timers made to match its file. Returns the lines it says. */
export function installTimers(cfg: Config, table: string, profiles: string[], at: Place = here(), t: Timers = launchd(at.home)): string[] {
  const out: string[] = [];
  for (const profile of profiles) {
    const { want, have, past } = plan(cfg, table, profile, at);
    for (const label of have.keys()) {
      if (want.has(label)) continue;
      t.unload(label);
      const p = past.get(label);
      out.push(p ? `removed ${label}: at ${p.j.at} has passed${p.state === 'done' ? '' : ', and it did not run (missed)'}` : `removed ${label}`);
    }
    for (const [label, w] of want) {
      if (same(have.get(label), w.plist) && t.loaded(label)) continue;
      mkdirSync(dirname(jobPlistPath(label, at.home)), { recursive: true });
      writeFileSync(jobPlistPath(label, at.home), w.plist, { mode: 0o644 });
      t.load(label);
      out.push(`installed ${label}: ${when(w.j)} → ${jobChat(cfg, profile, w.name, w.j)}, ${what(w.j, cfg.profiles[profile])}`);
    }
  }
  out.push('Timers match the job files.');
  return out;
}

/** `angelia jobs run`: one run, logged, and from a timer said in the chat when it did not run. A
 *  one-time job's timer (`hash` and `once`, its date, given) is removed after it fires, whatever
 *  happened, except when it fired before that date. The date comes from the timer, not the file: a
 *  file that broke or changed since must not keep a timer that would fire again every year. */
export async function runAndReport(cfg: Config, profile: string, job: string, hash: string | undefined, d: { stateDir: string; deliver: Deliver; unload: (label: string) => void; once?: string; print?: (line: string) => void; now?: Date; secrets?: Record<string, string>; chatToken?: (key: string) => string }): Promise<string> {
  // Read before the run, so a file edited during it cannot turn a run that happened into a failure.
  let def: Job | undefined;
  try { def = readJobs(cfg, profile).jobs[job]; } catch { /* runJob says what is wrong */ }
  const once = hash ? d.once : undefined;
  // Last, after the log and the chat line: a timer's bootout of its own label stops this process.
  const done = () => { if (once) d.unload(jobLabel(profile, job)); };
  const log = (line: string) => logJob(d.stateDir, `${profile}/${job} ${line}`);
  // Where a timer's refusal is said: the job's chat, or with no job to read, the profile's one chat.
  const chat = (): string | undefined => {
    if (def) return jobChat(cfg, profile, job, def);
    const mine = cfg.routes.filter((r) => r.profile === profile).map((r) => sessionKey(r));
    return mine.length === 1 ? mine[0] : undefined;
  };
  let late = 0;
  try { if (once) late = (d.now ?? new Date()).getTime() - atDate(once).getTime(); } catch { /* not a date: the run below says what is wrong */ }
  let line: string;
  try {
    // The timer's own date first, before the file is checked: a year-early fire stays quiet and
    // keeps its timer even when the file changed since.
    if (late < -AT_EARLY_MS) throw new JobEarly(`job ${profile}/${job} is due at ${once}, not before`);
    if (late > AT_GRACE_MS) throw new JobMissed(`job ${profile}/${job} was due at ${once}; its timer fired more than ${AT_GRACE_MS / 3600_000} h after that, so it does not run`);
    line = await runJob(cfg, profile, job, d.deliver, { hash, secrets: d.secrets, stateDir: d.stateDir, chatToken: d.chatToken, now: d.now });
  } catch (e) {
    const msg = (e as Error).message;
    // A year-early fire is launchd's, not news: logged, and the timer kept for the real date.
    if (hash && e instanceof JobEarly) { log(`early: ${msg}`); d.print?.(`early: ${msg}`); return `early: ${msg}`; }
    log(`${e instanceof JobMissed ? 'missed' : 'error'}: ${msg}`);
    // A timer has nobody watching its output: say it in the chat, when there is one to say it to.
    if (hash) {
      // As the chat, never the owner: the message can echo text the job printed (a daemon error
      // quoting a MEDIA: path), and the owner's token would attach it past the profile's rules.
      const text = e instanceof JobMissed
        ? `Scheduled job ${job} missed its time, ${once ?? def?.at}: the Mac was asleep, off or logged out then, so it does not run.`
        : `Scheduled job ${job} did not run: ${msg}`;
      try { const to = chat(); if (to) await d.deliver('send', to, text, true); } catch { /* the log line is all we can do */ }
    }
    done();
    throw e;
  }
  log(line);
  // Before the unload, which may end this process: the list says done from this, after the log moves on.
  const at = once ?? def?.at;
  if (at) recordOnce(d.stateDir, `${profile}/${job}`, at, d.now);
  d.print?.(line);
  done();
  return line;
}

export async function jobsCommand(argv: string[]): Promise<void> {
  const { table, words } = tableOf(argv);
  const [sub, ...all] = words;
  // --hash and --once are what a timer passes to jobs run. Taken out here for every subcommand, so they
  // are never read as a profile name, and refused anywhere they mean nothing.
  let rest = all;
  const take = (flag: string): string | undefined => {
    const at = rest.indexOf(flag);
    if (at < 0) return undefined;
    if (sub !== 'run') throw new Error(`${flag} is what a timer passes to angelia jobs run; it means nothing to jobs ${sub ?? ''}`.trim());
    const v = rest[at + 1];
    rest = rest.filter((_, i) => i !== at && i !== at + 1);
    return v;
  };
  const hash = take('--hash');
  const onceAt = take('--once');
  // A job runs on the table the owner accepted, as the daemon does (instance/accepted.ts): a timer
  // must not take a sandbox an agent switched off in the table, or a secret it added.
  const live = loadConfig(table);
  const cfg = sub === 'run' ? effectiveTable(live, STATE_DIR).cfg : live;
  const names = (list: string[]) => {
    for (const n of list) if (!cfg.profiles[n]) throw new Error(`unknown profile "${n}"`);
    return list.length ? list : Object.keys(cfg.profiles);
  };
  const needMac = () => { if (process.platform !== 'darwin') throw new Error('angelia jobs installs launchd timers, so macOS only for now. On Linux, call angelia jobs run <profile> <job> from a systemd timer or cron.'); };

  switch (sub) {
    case 'run': {
      const [profile, job] = rest;
      if (!profile || !job) throw new Error(USAGE);
      // Printed from inside: a one-time timer's unload comes after, and may end this process.
      await runAndReport(cfg, profile, job, hash, {
        once: onceAt, stateDir: STATE_DIR, deliver: jobDeliver, secrets: envFile(STATE_DIR), chatToken: (key) => sessionToken(ownerToken(), key),
        print: (line) => console.log(line),
        unload: (label) => { console.log(`${profile}/${job}: one-time job, its timer is removed`); unloadJob(label); },
      });
      return;
    }
    case 'install': {
      needMac();
      for (const line of installTimers(cfg, table, names(rest))) console.log(line);
      return;
    }
    case 'remove': {
      needMac();
      const [profile, job] = rest;
      if (!profile) throw new Error(USAGE);
      names([profile]);
      const prefix = jobLabel(profile, job ?? '');
      const labels = [...installedJobs(STATE_DIR).keys()].filter((l) => (job ? l === prefix : l.startsWith(prefix)));
      for (const l of labels) { unloadJob(l); console.log(`removed ${l}`); }
      if (!labels.length) console.log('no timers to remove');
      return;
    }
    case undefined: case 'list': default: {
      const list = sub && sub !== 'list' ? [sub, ...rest] : rest;
      const { lines, drift } = jobsState(cfg, table, names(list));
      console.log(lines.join('\n') || `No jobs. A profile's jobs go in ${JOBS_FILE} in its folder; angelia guide jobs explains.`);
      if (drift) { console.log(`\n${drift} out of step. angelia jobs install brings the timers in line.`); process.exitCode = 1; }
    }
  }
}

/** Each profile's jobs and whether its timers match the file; `drift` counts the ones that do not. */
export function jobsState(cfg: Config, table: string, profiles: string[], at: Place = here()): { lines: string[]; drift: number } {
  const lines: string[] = [];
  let drift = 0;
  for (const profile of profiles) {
    let p;
    try { p = plan(cfg, table, profile, at); } catch (e) { lines.push(`${profile}: ${(e as Error).message}`); drift++; continue; }
    if (!Object.keys(p.jobs).length && !p.have.size) continue;
    lines.push(`${profile}  (${join(cfg.profiles[profile].cwd, JOBS_FILE)})`);
    for (const [name, j] of Object.entries(p.jobs)) {
      const label = jobLabel(profile, name);
      // A one-time job after its moment is done or passed, and a timer still left for it is drift.
      const once = p.past.get(label)?.state;
      const state = !j.enabled ? 'disabled' : once ?? (!p.have.has(label) ? 'not installed' : !same(p.have.get(label), p.want.get(label)?.plist) ? 'out of date' : 'installed');
      if (state === 'not installed' || state === 'out of date' || ((state === 'disabled' || once) && p.have.has(label))) drift++;
      lines.push(`  ${name.padEnd(18)} ${when(j).padEnd(22)} ${state.padEnd(13)} ${what(j, cfg.profiles[profile])}`);
    }
    for (const label of p.have.keys()) if (![...p.want.keys()].includes(label) && !Object.keys(p.jobs).some((n) => jobLabel(profile, n) === label)) { lines.push(`  ${label}: a timer with no job in the file (angelia jobs install removes it)`); drift++; }
  }
  return { lines, drift };
}
