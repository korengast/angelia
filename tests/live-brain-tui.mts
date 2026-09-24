import { TuiBrain } from '../src/brain/tui.js';

const cwd = process.env.TUI_DEMO_DIR ?? '/tmp/angelia-tui-demo';
const b = new TuiBrain(
  { cwd, permission_mode: 'bypassPermissions', add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60,
    chrome: false, backend: 'claude-code', tui: true,
    model: 'claude-haiku-4-5-20251001' } as never,
  { id: crypto.randomUUID(), started: false },
);
const t0 = Date.now();
b.start();
console.log('tmux session', b.name);
for (const text of ['say exactly: ok', 'run the Bash tool: date > stamp.txt && echo wrote', 'שלום, תגיד ok']) {
  const t1 = Date.now();
  for await (const e of b.turn(text)) {
    if (e.kind === 'permission') { console.log('PERMISSION', e.tool, '|', e.preview); b.answerPermission(e.id, true); }
    else console.log(e.kind, JSON.stringify(e.text).slice(0, 90), Date.now() - t1, 'ms');
  }
}
console.log('alive', b.alive, 'total', Date.now() - t0, 'ms');
if (!process.env.TUI_KEEP) { await b.stop(); console.log('stopped; alive =', b.alive); }
