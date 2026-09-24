import { ClaudeBrain as Brain } from '../src/brain/claude.js';
const b = new Brain({ cwd: '/tmp/angelia-demo/coding', permission_mode: 'acceptEdits', add_dirs: [], unsafe_ok: false, model: 'claude-haiku-4-5-20251001' }, { id: crypto.randomUUID(), started: false });
const t0 = Date.now();
b.start();
console.log('spawned', Date.now() - t0, 'ms');
for (const text of ['[telegram dm 1 · Sam]\n\nsay ok', 'שלום\nתגיד ok', 'Use the Bash tool to run exactly: mkdir -p permtest && date > permtest/stamp.txt && echo done']) {
  const t1 = Date.now();
  for await (const e of b.turn(text)) {
    if (e.kind === 'permission') { console.log('PERMISSION', e.tool, e.preview); b.answerPermission(e.id, true); }
    else console.log(e.kind, JSON.stringify(e.text).slice(0, 80), Date.now() - t1, 'ms');
  }
}
await b.stop();
console.log('alive after stop:', b.alive);
