/**
 * Live measure (recheck-keymiss2): what the pane shows while another Stop hook of the session still
 * runs (20 s) after Angelia's own wrote its marker. The follow of an untaken message counts the pane
 * quiet after QUIET_MS idle (followAbsorbed); this says whether a long Stop hook reads busy (spinner)
 * or idle. A real `claude` in a throwaway pane, its own tmux server, the cheapest model.
 *
 *   ANGELIA_TMUX_SOCKET=a0410-test npx tsx tests/live-stop-hook-screen.mts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socket = process.env.ANGELIA_TMUX_SOCKET && process.env.ANGELIA_TMUX_SOCKET !== 'angelia' ? process.env.ANGELIA_TMUX_SOCKET : `angelia-live-stophook-${process.pid}`;
process.env.ANGELIA_TMUX_SOCKET = socket;
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-live-stophook-state-'));
const cwd = join(mkdtempSync(join(tmpdir(), 'angelia-live-stophook-')), 'stophook-live');
mkdirSync(join(cwd, '.claude'), { recursive: true });
writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sleep 20', timeout: 60 }] }] } }));
const { TuiBrain } = await import('../src/brain/tui.js');
const { TMUX_SOCKET, paneIdle, paneBusy } = await import('../src/brain/tmux.js');
if (TMUX_SOCKET !== socket || TMUX_SOCKET === 'angelia') throw new Error('refusing to run on the live tmux socket');
const b = new TuiBrain(
  { cwd, permission_mode: 'bypassPermissions', add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60,
    chrome: false, backend: 'claude-code', tui: true, model: process.env.LIVE_MODEL ?? 'haiku' } as never,
  { id: crypto.randomUUID(), started: false }, { idlePollMs: 300 },
);
const bb = b as any;
b.on('log', (l: string) => console.log('log |', l));
let ended = 0;
try {
  b.start();
  for await (const e of b.turn('Reply with exactly: ok')) { console.log(e.kind, '|', JSON.stringify((e as { text?: string }).text ?? '').slice(0, 60)); if (e.kind === 'result') ended = Date.now(); }
  const seen: string[] = [];
  for (let i = 0; i < 26; i++) {
    const pane = await bb.capture(30);
    const s = `${Math.round((Date.now() - ended) / 1000)}s idle=${paneIdle(pane)} busy=${paneBusy(pane)}`;
    console.log('screen |', s, '|', JSON.stringify(pane.split('\n').filter((l: string) => l.trim()).slice(-6).join(' / ').slice(0, 300)));
    seen.push(s);
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await b.stop().catch(() => {});
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
}
process.exit(0);
