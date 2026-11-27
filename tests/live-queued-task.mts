/**
 * Live measure (late-answers L3): the row Claude Code writes when a background task ends while a turn
 * still runs, so the end is queued into that turn (a queued_command attachment). Prints its shape (keys,
 * the origin it carries, the tag its prompt starts with) and the marker's origin. A real `claude` in a
 * throwaway pane, its own tmux server (ANGELIA_TMUX_SOCKET), the cheapest model. Not part of `npm test`.
 *
 *   ANGELIA_TMUX_SOCKET=a0410-test npx tsx tests/live-queued-task.mts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const socket = process.env.ANGELIA_TMUX_SOCKET && process.env.ANGELIA_TMUX_SOCKET !== 'angelia' ? process.env.ANGELIA_TMUX_SOCKET : `angelia-live-queued-${process.pid}`;
process.env.ANGELIA_TMUX_SOCKET = socket;
process.env.ANGELIA_STATE_DIR = mkdtempSync(join(tmpdir(), 'angelia-live-queued-state-'));
const cwd = join(mkdtempSync(join(tmpdir(), 'angelia-live-queued-')), 'queued-live');
mkdirSync(cwd);
const { TuiBrain } = await import('../src/brain/tui.js');
const { TMUX_SOCKET } = await import('../src/brain/tmux.js');
if (TMUX_SOCKET !== socket || TMUX_SOCKET === 'angelia') throw new Error('refusing to run on the live tmux socket');
const b = new TuiBrain(
  { cwd, permission_mode: 'bypassPermissions', add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60,
    chrome: false, backend: 'claude-code', tui: true, model: process.env.LIVE_MODEL ?? 'haiku' } as never,
  { id: crypto.randomUUID(), started: false }, { idlePollMs: 300 },
);
const bb = b as any;
const markers: Record<string, unknown>[] = [];
const read = bb.readMarker.bind(bb);
bb.readMarker = () => { const m = read(); if (m && !markers.some((x) => x.at === m.at)) { const { text, transcript_path: _t, ...rest } = m; markers.push({ ...rest, chars: String(text ?? '').length }); } return m; };
b.on('log', (l: string) => console.log('log |', l));
b.on('unasked', (a: { answer: string; text: string }) => console.log('unasked |', a.answer, JSON.stringify(a.text).slice(0, 80)));
try {
  b.start();
  for await (const e of b.turn('Use the Bash tool with run_in_background set to true to run: sleep 5 && echo bg-finished. Right after that, use the Bash tool in the foreground (not in the background) to run exactly: node -e "setTimeout(() => {}, 25000)" Then reply with exactly: done')) {
    console.log(e.kind, '|', JSON.stringify((e as { text?: string }).text ?? '').slice(0, 80));
  }
  await new Promise((r) => setTimeout(r, 20_000));
  for (const line of readFileSync(bb.transcript, 'utf8').split('\n')) {
    let row: any; try { row = JSON.parse(line); } catch { continue; }
    if ((row.type === 'attachment' && row.attachment?.type === 'queued_command') || row.type === 'queue-operation' || (row.type === 'user' && /task-notification/.test(JSON.stringify(row.message?.content ?? '')))) {
      const a = row.attachment ?? {};
      const p = typeof a.prompt === 'string' ? a.prompt : JSON.stringify(a.prompt ?? row.content ?? row.message?.content ?? '');
      console.log('row |', JSON.stringify({ type: row.type, operation: row.operation, keys: Object.keys(row), attachmentKeys: Object.keys(a), attachmentType: a.type, origin: a.origin ?? row.origin, rowSource: row.rowSource, isMeta: row.isMeta, head: p.slice(0, 40) }));
    }
  }
  console.log('markers |', JSON.stringify(markers));
} finally {
  await b.stop().catch(() => {});
  try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
}
process.exit(0);
