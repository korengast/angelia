import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { loadConfig } from '../instance/config/load.js';
import type { Config } from '../instance/config/schema.js';
import { STATE_DIR, envFile } from '../daemon/daemon.js';
import { configPath } from '../instance/instance.js';
import { pathWithBins } from '../brain/locate.js';
import { entry, servicePath, stableNode } from '../daemon/service.js';
import { apiCall } from '../daemon/api/client.js';
import {
  buildJobPlist, installedJobs, jobChat, jobLabel, jobPin, jobLoaded, jobPlistPath, loadJob, logJob,
  readJobs, runJob, sameJob, unloadJob, JOBS_FILE, type Job,
} from './jobs.js';

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

const what = (j: Job): string => (j.turn ? `turn "${j.turn.slice(0, 50)}"` : j.send ? `send "${j.send.slice(0, 50)}"` : `run ${j.run!.slice(0, 60)}`);
const when = (j: Job): string => (j.every ? `every ${j.every}` : `cron ${j.schedule}`);

function plan(cfg: Config, table: string, profile: string) {
  const { jobs, file } = readJobs(cfg, profile);
  const extra = [...pathWithBins(cfg).path.split(delimiter), dirname(process.execPath)];
  const path = servicePath(process.env, extra);
  const want = new Map<string, { plist: string; name: string; j: Job }>();
  for (const [name, j] of Object.entries(jobs)) {
    if (!j.enabled) continue;
    const label = jobLabel(profile, name);
    want.set(label, { name, j, plist: buildJobPlist({ label, node: stableNode(), entry: entry(), profile, job: name, hash: jobPin(j, cfg.profiles[profile]), config: table, stateDir: STATE_DIR, path, home: homedir(), cwd: cfg.profiles[profile].cwd, j }) });
  }
  const prefix = jobLabel(profile, '');
  const have = new Map([...installedJobs(STATE_DIR)].filter(([l]) => l.startsWith(prefix)));
  return { file, jobs, want, have };
}

export async function jobsCommand(argv: string[]): Promise<void> {
  const { table, words } = tableOf(argv);
  const [sub, ...all] = words;
  // --hash is what a timer passes to jobs run. Taken out here for every subcommand, so it is never read
  // as a profile name, and refused anywhere it means nothing.
  const hashAt = all.indexOf('--hash');
  const hash = hashAt >= 0 ? all[hashAt + 1] : undefined;
  const rest = all.filter((_, i) => !(hashAt >= 0 && (i === hashAt || i === hashAt + 1)));
  if (hashAt >= 0 && sub !== 'run') throw new Error(`--hash is what a timer passes to angelia jobs run; it means nothing to jobs ${sub ?? ''}`.trim());
  const cfg = loadConfig(table);
  const names = (list: string[]) => {
    for (const n of list) if (!cfg.profiles[n]) throw new Error(`unknown profile "${n}"`);
    return list.length ? list : Object.keys(cfg.profiles);
  };
  const needMac = () => { if (process.platform !== 'darwin') throw new Error('angelia jobs installs launchd timers, so macOS only for now. On Linux, call angelia jobs run <profile> <job> from a systemd timer or cron.'); };

  switch (sub) {
    case 'run': {
      const [profile, job] = rest;
      if (!profile || !job) throw new Error(USAGE);
      try {
        const line = await runJob(cfg, profile, job, apiCall, { hash, secrets: envFile(STATE_DIR) });
        logJob(STATE_DIR, `${profile}/${job} ${line}`);
        console.log(line);
      } catch (e) {
        const msg = (e as Error).message;
        logJob(STATE_DIR, `${profile}/${job} error: ${msg}`);
        // A timer has nobody watching its output: say it in the chat, when there is one to say it to.
        if (hash) {
          try {
            const j = readJobs(cfg, profile).jobs[job];
            if (j) await apiCall('send', jobChat(cfg, profile, job, j), `Scheduled job ${job} did not run: ${msg}`);
          } catch { /* the log line is all we can do */ }
        }
        throw e;
      }
      return;
    }
    case 'install': {
      needMac();
      for (const profile of names(rest)) {
        const { want, have } = plan(cfg, table, profile);
        for (const label of have.keys()) if (!want.has(label)) { unloadJob(label); console.log(`removed ${label}`); }
        for (const [label, w] of want) {
          if (same(have.get(label), w.plist) && jobLoaded(label)) continue;
          mkdirSync(dirname(jobPlistPath(label)), { recursive: true });
          writeFileSync(jobPlistPath(label), w.plist, { mode: 0o644 });
          loadJob(label);
          console.log(`installed ${label}: ${when(w.j)} → ${jobChat(cfg, profile, w.name, w.j)}, ${what(w.j)}`);
        }
      }
      console.log('Timers match the job files.');
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
export function jobsState(cfg: Config, table: string, profiles: string[]): { lines: string[]; drift: number } {
  const lines: string[] = [];
  let drift = 0;
  for (const profile of profiles) {
    let p;
    try { p = plan(cfg, table, profile); } catch (e) { lines.push(`${profile}: ${(e as Error).message}`); drift++; continue; }
    if (!Object.keys(p.jobs).length && !p.have.size) continue;
    lines.push(`${profile}  (${join(cfg.profiles[profile].cwd, JOBS_FILE)})`);
    for (const [name, j] of Object.entries(p.jobs)) {
      const label = jobLabel(profile, name);
      const state = !j.enabled ? 'disabled' : !p.have.has(label) ? 'not installed' : !same(p.have.get(label), p.want.get(label)?.plist) ? 'out of date' : 'installed';
      if (state === 'not installed' || state === 'out of date' || (state === 'disabled' && p.have.has(label))) drift++;
      lines.push(`  ${name.padEnd(18)} ${when(j).padEnd(22)} ${state.padEnd(13)} ${what(j)}`);
    }
    for (const label of p.have.keys()) if (![...p.want.keys()].includes(label) && !Object.keys(p.jobs).some((n) => jobLabel(profile, n) === label)) { lines.push(`  ${label}: a timer with no job in the file (angelia jobs install removes it)`); drift++; }
  }
  return { lines, drift };
}
