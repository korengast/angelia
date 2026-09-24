import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Config, Profile } from '../instance/config/schema.js';
import { sessionKey } from '../core/types.js';
import { profileEnv, tableSecrets } from '../core/env.js';
import { capabilityEnv } from '../capabilities/resolve.js';

/**
 * Scheduled jobs (design §4). A profile keeps its jobs in `angelia-jobs.yaml` in its own folder, so
 * they move with it and are version controlled. `angelia jobs install` turns each one into an
 * operating-system timer (a LaunchAgent on macOS) that runs `angelia jobs run <profile> <job>`.
 *
 * The daemon still contains no scheduler: it never wakes anything up. The OS does the timing, the
 * profile holds the definitions, and delivery goes through the daemon's loopback API like
 * `angelia send` and `angelia turn`.
 *
 * A timer runs the definition it was installed with. The plist carries a hash of the job, and a
 * run refuses a job that changed since: an agent that edits the file cannot change what a timer
 * does until someone installs again and sees the list.
 */

export const JOBS_FILE = 'angelia-jobs.yaml';
export const JOB_PREFIX = 'angelia.job.';

const NAME = /^[A-Za-z0-9_-]{1,40}$/;

export const Job = z.object({
  /** Five-field cron: minute hour day-of-month month day-of-week. Lists, ranges and steps work. */
  schedule: z.string().optional(),
  /** Or a fixed interval: 30m, 2h, 1d. */
  every: z.string().regex(/^\d+[mhd]$/, 'every: a number and m, h or d (30m, 2h, 1d)').optional(),
  /** Where the result goes. Defaults to the profile's one routed chat. */
  chat: z.string().optional(),
  /** Exactly one of these three. */
  turn: z.string().min(1).optional(),
  send: z.string().min(1).optional(),
  run: z.string().min(1).optional(),
  /** For `run`: seconds before the command is stopped. */
  timeout_seconds: z.number().positive().default(600),
  enabled: z.boolean().default(true),
}).strict().superRefine((j, ctx) => {
  if (!!j.schedule === !!j.every) ctx.addIssue({ code: 'custom', message: 'give schedule or every, not both and not neither' });
  if ([j.turn, j.send, j.run].filter(Boolean).length !== 1) ctx.addIssue({ code: 'custom', message: 'give exactly one of turn, send or run' });
  if (j.schedule) { try { cronCalendar(j.schedule); } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); } }
});
export type Job = z.infer<typeof Job>;

export const JobsFile = z.object({ jobs: z.record(z.string().regex(NAME, 'job names: letters, digits, - and _'), Job).default({}) }).strict();

export interface ProfileJobs { profile: string; file: string; jobs: Record<string, Job> }

export function readJobs(cfg: Config, profile: string): ProfileJobs {
  const p = cfg.profiles[profile];
  if (!p) throw new Error(`unknown profile "${profile}"`);
  const file = join(p.cwd, JOBS_FILE);
  if (!existsSync(file)) return { profile, file, jobs: {} };
  const parsed = JobsFile.safeParse(parse(readFileSync(file, 'utf8')) ?? {});
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ')}`);
  for (const [name, j] of Object.entries(parsed.data.jobs)) {
    if (j.run && !p.shell) throw new Error(`${file}: job ${name} runs a command, and profile ${profile} does not have shell: true`);
    jobChat(cfg, profile, name, j);
  }
  return { profile, file, jobs: parsed.data.jobs };
}

/** The chat a job reports to: its own `chat`, which must be routed to this profile, or the one chat routed to it. */
export function jobChat(cfg: Config, profile: string, name: string, j: Job): string {
  const mine = cfg.routes.filter((r) => r.profile === profile).map((r) => sessionKey(r));
  if (j.chat) {
    if (!mine.includes(j.chat)) throw new Error(`job ${name}: chat ${j.chat} is not routed to profile ${profile} (routed: ${mine.join(', ') || 'none'})`);
    return j.chat;
  }
  if (mine.length !== 1) throw new Error(`job ${name}: profile ${profile} has ${mine.length} routed chats; name one with chat:`);
  return mine[0];
}

export function jobHash(j: Job): string {
  const { enabled: _e, ...what } = j;
  return createHash('sha256').update(JSON.stringify(what, Object.keys(what).sort())).digest('hex').slice(0, 16);
}

/**
 * The files a `run:` line names that sit in the profile's folder or its add_dirs: the places its
 * agent may write without being asked (measured on claude 2.1.280: under acceptEdits a script there
 * is written with no prompt, while .claude/ and .mcp.json always ask). A job that runs one of them
 * would run whatever the agent was talked into writing, so the pin covers their content too.
 */
export function jobScripts(j: Job, p: Profile, home = homedir()): string[] {
  if (!j.run) return [];
  const roots = [p.cwd, ...p.add_dirs].map((d) => resolve(d.startsWith('~/') ? join(home, d.slice(2)) : d));
  const out = new Set<string>();
  const abs = (w: string, from: string) => resolve(from, w.startsWith('~/') ? join(home, w.slice(2)) : w);
  // `cd scripts && python3 card.py` is the common shape: a word is read from the last folder cd named.
  let at = p.cwd;
  const words = j.run.split(/[\s;|&<>()]+/).map((w) => w.replace(/^["']|["']$/g, ''));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 'cd' && words[i + 1]) { at = abs(words[++i], at); continue; }
    if (!w || w.startsWith('-') || !(w.includes('/') || /\.(sh|py|mjs|cjs|js|ts|rb|pl)$/.test(w))) continue;
    const f = abs(w, at);
    if (!roots.some((r) => { const rel = relative(r, f); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); })) continue;
    try { if (statSync(f).isFile()) out.add(f); } catch { /* not a file here: nothing to pin */ }
  }
  return [...out].sort();
}

/** What a timer is installed with and checked against: the job's definition, and the content of
 *  every script of its own it runs. A job that runs none has the definition's hash alone. */
export function jobPin(j: Job, p: Profile, home = homedir()): string {
  const scripts = jobScripts(j, p, home);
  if (!scripts.length) return jobHash(j);
  const h = createHash('sha256');
  for (const f of scripts) h.update(f).update('\0').update(readFileSync(f)).update('\0');
  return `${jobHash(j)}.${h.digest('hex').slice(0, 16)}`;
}

// ---- schedules ------------------------------------------------------------------------------

type Cal = Partial<Record<'Minute' | 'Hour' | 'Day' | 'Month' | 'Weekday', number>>;
const FIELDS: { key: keyof Cal; min: number; max: number }[] = [
  { key: 'Minute', min: 0, max: 59 }, { key: 'Hour', min: 0, max: 23 }, { key: 'Day', min: 1, max: 31 },
  { key: 'Month', min: 1, max: 12 }, { key: 'Weekday', min: 0, max: 7 },
];
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MAX_ENTRIES = 300;

function field(text: string, f: typeof FIELDS[number]): number[] | null {
  if (text === '*') return null;
  const out = new Set<number>();
  for (const part of text.toLowerCase().split(',')) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`schedule: cannot read "${part}"`);
    const num = (s: string) => {
      const v = f.key === 'Weekday' && s in DAYS ? DAYS[s] : Number(s);
      if (!Number.isInteger(v) || v < f.min || v > f.max) throw new Error(`schedule: ${s} is outside ${f.key.toLowerCase()} ${f.min}-${f.max}`);
      return v;
    };
    const [lo, hi] = m[1] === '*' ? [f.min, f.max] : m[1].includes('-') ? m[1].split('-').map(num) : [num(m[1]), m[2] ? f.max : num(m[1])];
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1 || lo > hi) throw new Error(`schedule: bad range "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(f.key === 'Weekday' && v === 7 ? 0 : v);
  }
  return [...out].sort((a, b) => a - b);
}

/** A five-field cron expression as launchd calendar entries: one dict per combination of the
 *  restricted fields, a missing key meaning "every". */
export function cronCalendar(expr: string): Cal[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`schedule: five fields (minute hour day month weekday), got "${expr}"`);
  let out: Cal[] = [{}];
  FIELDS.forEach((f, i) => {
    const vals = field(parts[i], f);
    if (!vals) return;
    out = out.flatMap((c) => vals.map((v) => ({ ...c, [f.key]: v })));
    if (out.length > MAX_ENTRIES) throw new Error(`schedule: "${expr}" makes more than ${MAX_ENTRIES} timer entries; use every: instead`);
  });
  return out;
}

export function everySeconds(every: string): number {
  const n = Number(every.slice(0, -1));
  return n * ({ m: 60, h: 3600, d: 86400 } as const)[every.slice(-1) as 'm' | 'h' | 'd'];
}

// ---- plists -----------------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** launchd labels stay ASCII; a profile name that is not (a Hebrew one, say) gets a short hash so two never collide. */
export function jobLabel(profile: string, job: string): string {
  const safe = profile.replace(/[^A-Za-z0-9_-]/g, '_');
  const id = safe === profile ? safe : `${safe.replace(/_+/g, '_')}${createHash('sha256').update(profile).digest('hex').slice(0, 8)}`;
  return `${JOB_PREFIX}${id}.${job}`;
}
export const jobPlistPath = (label: string, home = homedir()): string => join(home, 'Library', 'LaunchAgents', `${label}.plist`);

export interface JobPlistInput { label: string; node: string; entry: string; profile: string; job: string; hash: string; config: string; stateDir: string; path: string; home: string; cwd: string; j: Job }

export function buildJobPlist(i: JobPlistInput): string {
  const env: Record<string, string> = { PATH: i.path, HOME: i.home, ANGELIA_STATE_DIR: i.stateDir, ANGELIA_CONFIG: i.config };
  const when = i.j.every
    ? `  <key>StartInterval</key><integer>${everySeconds(i.j.every)}</integer>`
    : `  <key>StartCalendarInterval</key>\n  <array>\n${cronCalendar(i.j.schedule!).map((c) => `    <dict>${Object.entries(c).map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`).join('')}</dict>`).join('\n')}\n  </array>`;
  const out = join(i.stateDir, 'jobs.out');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by angelia jobs install from ${esc(join(i.cwd, JOBS_FILE))}. Change the file and install again, not this. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(i.label)}</string>
  <key>ProgramArguments</key>
  <array>
${[i.node, i.entry, 'jobs', 'run', i.profile, i.job, '--hash', i.hash].map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${esc(i.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${esc(v)}</string>`).join('\n')}
  </dict>
${when}
  <key>StandardOutPath</key><string>${esc(out)}</string>
  <key>StandardErrorPath</key><string>${esc(out)}</string>
</dict>
</plist>
`;
}

const stripPath = (plist: string): string => plist
  .replace(/<key>PATH<\/key><string>[^<]*<\/string>/, '')
  .replace(/(<key>ProgramArguments<\/key>\s*<array>\s*)<string>[^<]*<\/string>\s*<string>[^<]*<\/string>/, '$1');
/** Two job plists do the same thing: equal apart from what is read off the installer's shell (the
 *  PATH, and which node and angelia paths it resolves to). */
export function sameJob(a: string, b: string): boolean { return stripPath(a) === stripPath(b); }

const plistState = (plist: string): string | undefined => /<key>ANGELIA_STATE_DIR<\/key><string>([^<]*)<\/string>/.exec(plist)?.[1].replace(/&amp;/g, '&');

/** Job plists on disk that belong to this instance, by label. Another instance's are never touched. */
export function installedJobs(stateDir: string, home = homedir()): Map<string, string> {
  const dir = join(home, 'Library', 'LaunchAgents');
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(JOB_PREFIX) || !f.endsWith('.plist')) continue;
    const text = readFileSync(join(dir, f), 'utf8');
    if (plistState(text) === resolve(stateDir)) out.set(f.slice(0, -'.plist'.length), text);
  }
  return out;
}

// ---- running ----------------------------------------------------------------------------------

export interface Deliver { (kind: 'send' | 'turn', key: string, text: string): Promise<void> }

const SILENT = '[SILENT]';

/** One run of a job: what the timer calls, and `angelia jobs run` by hand. Returns a log line. */
export async function runJob(cfg: Config, profile: string, name: string, deliver: Deliver, opts: { hash?: string; env?: NodeJS.ProcessEnv; secrets?: Record<string, string> } = {}): Promise<string> {
  const { jobs } = readJobs(cfg, profile);
  const j = jobs[name];
  if (!j) throw new Error(`profile ${profile} has no job "${name}"`);
  // A timer installed before scripts were pinned carries the definition's hash alone: it still runs, and
  // the next install pins its scripts too. One installed since carries the pin, and a changed script
  // fails it.
  if (opts.hash && opts.hash !== jobPin(j, cfg.profiles[profile]) && opts.hash !== jobHash(j)) {
    throw new Error(`job ${profile}/${name}, or a script it runs, changed since it was installed; if that change was yours, run angelia jobs install ${profile}`);
  }
  const chat = jobChat(cfg, profile, name, j);
  if (j.send) { await deliver('send', chat, j.send); return `sent to ${chat}`; }
  if (j.turn) { await deliver('turn', chat, j.turn); return `turn queued in ${chat}`; }
  // What the profile's agent gets: no bot token, no billing variable, and only its own secrets.
  const env = profileEnv(opts.env ?? process.env, opts.secrets ?? {}, tableSecrets(cfg), capabilityEnv(cfg, profile)).env;
  const r = await runCommand(j.run!, cfg.profiles[profile].cwd, j.timeout_seconds * 1000, env);
  if (r.code !== 0) {
    const why = r.timedOut ? `stopped after ${j.timeout_seconds} s` : `exit ${r.code}`;
    const last = r.err.trim().split('\n').pop()?.slice(0, 300) ?? '';
    await deliver('send', chat, `Scheduled job ${name} failed (${why})${last ? `: ${last}` : ''}`);
    return `failed ${why}`;
  }
  const text = r.out.trim();
  if (!text || text === SILENT) return 'ran, nothing to send';
  await deliver('send', chat, text);
  return `ran, sent ${text.length} chars to ${chat}`;
}

function runCommand(cmd: string, cwd: string, ms: number, env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn('/bin/sh', ['-c', cmd], { cwd, env: { ...env, ANGELIA_JOB: '1' }, detached: true });
    let out = '', err = '', timedOut = false;
    // Decoded as text by the stream, so a character split across two chunks is not broken in half.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { if (out.length < 60_000) out += d; });
    child.stderr.on('data', (d: string) => { if (err.length < 20_000) err += d; });
    const group = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch {} };
    // SIGTERM first, so a job can clean up; a job that ignores it gets SIGKILL after a grace, or a
    // hung job would hold angelia jobs run, and its timer, forever.
    let kill: NodeJS.Timeout | undefined;
    const t = setTimeout(() => { timedOut = true; group('SIGTERM'); kill = setTimeout(() => group('SIGKILL'), Math.min(5000, Math.max(500, ms))); }, ms);
    const end = () => { clearTimeout(t); clearTimeout(kill); };
    child.on('error', (e) => { end(); done({ code: 127, out, err: String(e), timedOut }); });
    child.on('close', (code) => { end(); done({ code: code ?? 1, out, err, timedOut }); });
  });
}

export function logJob(stateDir: string, line: string): void {
  try { mkdirSync(stateDir, { recursive: true }); appendFileSync(join(stateDir, 'jobs.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch {}
}

// ---- launchd -----------------------------------------------------------------------------------

const domain = (): string => `gui/${userInfo().uid}`;
function launchctl(args: string[]): { code: number; out: string } {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
export function loadJob(label: string, home = homedir()): void {
  launchctl(['bootout', `${domain()}/${label}`]);
  const r = launchctl(['bootstrap', domain(), jobPlistPath(label, home)]);
  if (r.code !== 0) throw new Error(`launchctl bootstrap ${label} failed: ${r.out || `exit ${r.code}`}`);
}
export function unloadJob(label: string, home = homedir()): void {
  launchctl(['bootout', `${domain()}/${label}`]);
  if (existsSync(jobPlistPath(label, home))) unlinkSync(jobPlistPath(label, home));
}
export function jobLoaded(label: string): boolean {
  return launchctl(['print', `${domain()}/${label}`]).code === 0;
}

