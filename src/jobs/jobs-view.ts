import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../instance/config/schema.js';
import { installedJobs, jobChat, jobLabel, readJobs } from './jobs.js';

/** One job as a client shows it: when, what, where to, and how its last runs went. */
export interface JobView {
  name: string;
  when: string;
  kind: 'turn' | 'send' | 'run';
  /** The prompt, the message or the command, at most WHAT_MAX characters. */
  what: string;
  chat: string | null;
  enabled: boolean;
  /** Its timer is in launchd for this instance (`angelia jobs` says whether it is up to date). */
  installed: boolean;
  /** Newest first, at most RUNS_MAX, from jobs.log. */
  runs: { at: string; result: string }[];
}

export interface JobsView { file: string; jobs: JobView[]; error?: string }

const WHAT_MAX = 2000;
const RUNS_MAX = 5;
/** The end of jobs.log that is read for last runs; older ones are not listed. */
const LOG_TAIL_BYTES = 512 * 1024;

/** The last runs of every job, by `profile/job`, newest first, from the end of jobs.log. */
export function lastRuns(stateDir: string, max = RUNS_MAX): Map<string, { at: string; result: string }[]> {
  const out = new Map<string, { at: string; result: string }[]>();
  let text = '';
  try {
    const fd = openSync(join(stateDir, 'jobs.log'), 'r');
    try {
      const size = fstatSync(fd).size;
      const from = Math.max(0, size - LOG_TAIL_BYTES);
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      text = buf.toString('utf8');
      if (from > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return out;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(\S+) ([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+) (.*)$/.exec(lines[i] ?? '');
    if (!m) continue;
    const key = m[2] ?? '';
    const list = out.get(key) ?? [];
    if (list.length >= max) continue;
    list.push({ at: m[1] ?? '', result: (m[3] ?? '').slice(0, 300) });
    out.set(key, list);
  }
  return out;
}

/** A profile's jobs for a client. A jobs file that does not load is reported, not thrown. */
export function jobsView(cfg: Config, profile: string, stateDir: string, home = homedir()): JobsView {
  let read;
  try {
    read = readJobs(cfg, profile);
  } catch (e) {
    return { file: join(cfg.profiles[profile]?.cwd ?? '', 'angelia-jobs.yaml'), jobs: [], error: (e as Error).message };
  }
  const have = installedJobs(stateDir, home);
  const runs = lastRuns(stateDir);
  const jobs = Object.entries(read.jobs).map(([name, j]): JobView => {
    let chat: string | null = null;
    try { chat = jobChat(cfg, profile, name, j); } catch { /* readJobs checked it already */ }
    const kind = j.turn ? 'turn' : j.send ? 'send' : 'run';
    return {
      name,
      when: j.every ? `every ${j.every}` : `cron ${j.schedule ?? ''}`,
      kind,
      what: (j.turn ?? j.send ?? j.run ?? '').slice(0, WHAT_MAX),
      chat,
      enabled: j.enabled,
      installed: have.has(jobLabel(profile, name)),
      runs: runs.get(`${profile}/${name}`) ?? [],
    };
  });
  return { file: read.file, jobs };
}
