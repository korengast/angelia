import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../../src/instance/config/schema.js';
import { JOBS_FILE, runJob } from '../../src/jobs/jobs.js';

// Slow: each launcher is given time to start something, and Terminal's refusal takes seconds.

const tmp = () => mkdtempSync(join(tmpdir(), 'angelia-jobs-slow-'));

function rig(yaml: string, profile: Record<string, unknown>) {
  const cwd = tmp();
  writeFileSync(join(cwd, JOBS_FILE), yaml);
  return { cwd, cfg: Config.parse({ profiles: { p: { cwd, ...profile } }, routes: [{ platform: 'whatsapp', chat: 'g@g.us', profile: 'p' }] }) };
}

async function compiled(cfg: Config, state: string): Promise<void> {
  const { planProfile } = await import('../../src/capabilities/compile.js');
  planProfile(cfg, 'p', { stateDir: state, home: tmp() }).apply();
}

const deliver = async () => {};

test('a sandboxed job reaches no launcher that would run its code outside the sandbox', { skip: process.platform !== 'darwin', timeout: 200_000 }, async () => {
  const { existsSync, realpathSync, unlinkSync } = await import('node:fs');
  const state = realpathSync(tmp());
  // Outside the job's folders: only a process started outside the sandbox can leave it.
  const marker = join(dirname(fileURLToPath(import.meta.url)), `.launch-probe-${process.pid}`);
  const routes: Record<string, string> = {
    launchctl: `launchctl submit -l test.angelia.jobprobe${process.pid} -- /usr/bin/touch ${marker}; sleep 2`,
    osascript: `osascript -e 'do shell script "touch ${marker}"'`,
    terminal: `osascript -e 'tell application "Terminal" to do script "touch ${marker}"'`,
    tmux: `tmux -L jobprobe${process.pid} new-session -d 'touch ${marker}'; sleep 1; tmux -L jobprobe${process.pid} kill-server`,
    at: `echo 'touch ${marker}' | at now`,
    python: `python3 -c 'import subprocess; subprocess.run(["touch", "${marker}"])'`,
  };
  const { cfg, cwd } = rig('jobs:\n' + Object.keys(routes).map((n) => `  ${n}: {every: 1h, run: "sh ${n}.sh", timeout_seconds: 10}`).join('\n') + '\n', { shell: true, sandbox: true });
  for (const [n, cmd] of Object.entries(routes)) writeFileSync(join(cwd, `${n}.sh`), cmd + '\n');
  await compiled(cfg, state);
  const escaped: string[] = [];
  for (const n of Object.keys(routes)) {
    await runJob(cfg, 'p', n, deliver, { stateDir: state });
    await new Promise((res) => setTimeout(res, 2500));
    if (existsSync(marker)) { escaped.push(n); unlinkSync(marker); }
  }
  spawnSync('launchctl', ['remove', `test.angelia.jobprobe${process.pid}`]);
  // An osascript blocked on an Automation prompt outlives its job: stop it, or it stays for hours.
  spawnSync('pkill', ['-f', `launch-probe-${process.pid}`]);
  assert.deepEqual(escaped, []);
});

test('a sandboxed job cannot start a program outside the sandbox, may write its extra folders, and gets the chat token', { skip: process.platform !== 'darwin' }, async () => {
  const { existsSync, realpathSync, rmSync, readFileSync } = await import('node:fs');
  const state = realpathSync(tmp());
  const extra = realpathSync(tmp());
  const marker = join(dirname(fileURLToPath(import.meta.url)), `.open-probe-${process.pid}`);
  const { cfg, cwd } = rig([
    'jobs:',
    '  launch: {every: 1h, run: "sh make-app.sh && open -g -j probe.app; sleep 3"}',
    `  extra: {every: 1h, run: "echo in > ${join(extra, 'f')} && echo $ANGELIA_SESSION_KEY"}`,
    '  widen: {every: 1h, run: "echo {} > .claude/settings.local.json"}',
  ].join('\n'), { shell: true, sandbox: true });
  // The job writes an app in its own folder and asks LaunchServices to start it: the app would run
  // outside the sandbox and leave the marker.
  writeFileSync(join(cwd, 'make-app.sh'), [
    'mkdir -p probe.app/Contents/MacOS',
    `printf '#!/bin/sh\\ntouch ${marker}\\n' > probe.app/Contents/MacOS/probe`,
    'chmod +x probe.app/Contents/MacOS/probe',
    `cat > probe.app/Contents/Info.plist <<'EOF'`,
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>test.angelia.jobprobe${process.pid}</string><key>LSUIElement</key><true/></dict></plist>`,
    'EOF',
  ].join('\n') + '\n');
  await compiled(cfg, state);
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { additionalDirectories: [extra] } }));
  const calls: string[] = [];
  const r = { deliver: async (_k: string, _c: string, text: string) => { calls.push(text); } };
  const opts = { stateDir: state, chatToken: () => 'chat-token' };
  await runJob(cfg, 'p', 'launch', r.deliver, opts);
  await new Promise((res) => setTimeout(res, 2000));
  const escaped = existsSync(marker);
  if (escaped) rmSync(marker);
  assert.equal(escaped, false, 'open started the app outside the sandbox');
  assert.match(await runJob(cfg, 'p', 'extra', r.deliver, opts), /^ran/);
  assert.equal(readFileSync(join(extra, 'f'), 'utf8'), 'in\n');
  assert.equal(calls.at(-1), 'whatsapp:g@g.us', 'the chat key (and its token) reach the command');
  assert.match(await runJob(cfg, 'p', 'widen', r.deliver, opts), /^failed/, 'a job cannot rewrite the settings its next run reads');
  assert.match(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'), /additionalDirectories/);
});

