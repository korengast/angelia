import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemd, systemdStart, systemdEnable, systemdStop, systemdAvailable, inServiceCgroup, escapeSpecifiers, UNIT, type Run } from '../src/daemon/systemd.js';
import { backend } from '../src/daemon/service.js';

test('render → read round-trips every path exactly', () => {
  for (const p of ['/home/example/My Files/x', '/srv/50%/a', '/a/$HOME/b', '/a/"q"/b', '/a/b\\c', '/א/ב']) {
    const i = { node: `${p}/node`, entry: `${p}/cli.js`, config: `${p}/routing.yaml`, stateDir: `${p}/state`, path: '/usr/bin:/bin', home: '/home/example', lang: 'C.UTF-8' };
    assert.deepEqual(systemd.read(systemd.render(i)), { node: i.node, entry: i.entry, config: i.config, stateDir: i.stateDir });
  }
});

test('the unit: quoted ExecStart, escaped %, $ and quotes, restart policy, output to daemon.out, no secret', () => {
  const u = systemd.render({ node: '/n', entry: '/e', config: '/c/50%/r.yaml', stateDir: '/s', path: '/usr/bin', home: '/h' });
  assert.match(u, /^ExecStart="\/n" "\/e" "daemon" "\/c\/50%%\/r\.yaml"$/m);
  assert.match(u, /^Restart=on-failure$/m); assert.match(u, /^RestartSec=10$/m);
  assert.match(u, /^TimeoutStopSec=20$/m, 'as launchd\'s ExitTimeOut: a stop never blocks for 90 s');
  assert.match(u, /^StandardOutput=append:\/s\/daemon\.out$/m); assert.match(u, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(u, /TOKEN/);
  const q = systemd.render({ node: '/n', entry: '/a/$HOME/"q"/b\\c', config: '/c', stateDir: '/s', path: '/p', home: '/h' });
  assert.match(q, /^ExecStart="\/n" "\/a\/\$\$HOME\/\\"q\\"\/b\\\\c" "daemon" "\/c"$/m);
  assert.match(q, /^Environment="PATH=\/p" "HOME=\/h" "ANGELIA_STATE_DIR=\/s"$/m);
});

test('a newline in any path is refused, never rendered', () => {
  const ok = { node: '/n', entry: '/e', config: '/c', stateDir: '/s', path: '/usr/bin', home: '/h' };
  assert.throws(() => systemd.render({ ...ok, config: '/c\n[Service]' }), /newline/);
  assert.throws(() => systemd.render({ ...ok, home: '/h\r' }), /newline/);
});

test('read: a unit without the angelia line, or with a broken one, is undefined', () => {
  for (const t of ['', '# angelia: {', '# angelia: {"config":1}']) assert.equal(systemd.read(t), undefined);
});

const fake = (codes: Record<string, number[]> = {}, out = '') => {
  const calls: string[][] = [];
  const run: Run = (a) => { calls.push(a); const q = codes[a[0]]; return { code: q ? (q.length > 1 ? q.shift()! : q[0]) : 0, out: codes[a[0]] ? out : '' }; };
  return { calls, run };
};

test("start reloads, enables and starts; a failure carries systemctl's words", () => {
  const f = fake();
  systemdStart(f.run);
  assert.deepEqual(f.calls, [['daemon-reload'], ['enable', UNIT], ['start', UNIT]]);
  assert.throws(() => systemdStart(fake({ start: [1] }, 'boom').run), /systemctl --user start failed: boom/);
});

test('stop waits until the unit is no longer active, and fails loudly after 25 s', () => {
  const f = fake({ 'is-active': [0, 0, 3] });
  const waits: number[] = [];
  systemdStop(f.run, (ms) => waits.push(ms));
  assert.deepEqual(f.calls[0], ['stop', UNIT]); assert.equal(waits.length, 2);
  let total = 0;
  assert.throws(() => systemdStop(fake({ 'is-active': [0] }).run, (ms) => { total += ms; }), /25s/);
  assert.equal(total, 25000);
});

test('enable reloads and enables without starting: a unit written beside a hand-started daemon still starts at boot', () => {
  const f = fake();
  systemdEnable(f.run);
  assert.deepEqual(f.calls, [['daemon-reload'], ['enable', UNIT]]);
  assert.throws(() => systemdEnable(fake({ enable: [1] }, 'nope').run), /systemctl --user enable failed: nope/);
});

test('inServiceCgroup: only a process in angelia.service itself, on cgroup v2 and v1 alike', () => {
  const unit = '/user.slice/user-1000.slice/user@1000.service/app.slice/angelia.service';
  assert.equal(inServiceCgroup(() => `0::${unit}\n`), true);
  assert.equal(inServiceCgroup(() => `12:pids:/user.slice\n1:name=systemd:${unit}\n0::/\n`), true);
  assert.equal(inServiceCgroup(() => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1234.scope\n'), false, 'a tmux scope or an agent shell started by hand');
  assert.equal(inServiceCgroup(() => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/angelia-restart-7.service\n'), false);
  assert.equal(inServiceCgroup(() => '0::/user.slice/user-1000.slice/session-3.scope\n'), false);
  assert.equal(inServiceCgroup(() => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); }), false, 'no /proc: macOS');
});

test('availability, escapeSpecifiers, and the linux backend', () => {
  assert.equal(systemdAvailable(fake().run), true);
  assert.equal(systemdAvailable(fake({ 'show-environment': [1] }).run), false);
  assert.equal(escapeSpecifiers('50%'), '50%%');
  assert.equal(backend('linux'), systemd);
});

test('filePath is always ~/.config, whatever XDG_CONFIG_HOME says: the restarter, the user manager and the deny floor all look there', () => {
  const was = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = '/x/cfg';
    assert.equal(systemd.filePath('/h'), '/h/.config/systemd/user/angelia.service');
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(systemd.filePath('/h'), '/h/.config/systemd/user/angelia.service');
  } finally { if (was === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = was; }
});

test('$ is doubled in ExecStart words only; Environment keeps it literal', () => {
  const u = systemd.render({ node: '/n', entry: '/e', config: '/c/$y.yaml', stateDir: '/a/$x/state', path: '/p', home: '/h' });
  assert.match(u, /^ExecStart=.*"\/c\/\$\$y\.yaml"$/m);
  const env = /^Environment=.*$/m.exec(u)![0];
  assert.ok(env.includes('"ANGELIA_STATE_DIR=/a/$x/state"'));
  assert.ok(!env.includes('$$'));
});
