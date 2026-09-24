import { standIn } from '../adapters/telegram/adapter.js';
import { locateBin } from '../brain/locate.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Bot } from 'grammy';
import { runInit, type Ask, type PairedChat } from './init.js';

/** Terminal implementation of the wizard's questions. */
export function terminalAsk(): Ask {
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  let muted = false;
  const raw = rl as unknown as { _writeToOutput: (s: string) => void; output: { write(s: string): void } };
  raw._writeToOutput = (s: string) => { if (!muted) raw.output.write(s); };
  return {
    say: (line) => console.log(line),
    async text(q, def) {
      const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
      return a || def || this.text(q, def);
    },
    async secret(q) {
      stdout.write(`${q}: `);
      muted = true;
      try { return (await rl.question('')).trim(); } finally { muted = false; stdout.write('\n'); }
    },
    async choose(q, options, def) {
      console.log(q);
      options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}`));
      const defIdx = def ? options.findIndex((o) => o.key === def) + 1 : 1;
      for (;;) {
        const a = (await rl.question(`Choice [${defIdx}]: `)).trim();
        const n = a ? Number(a) : defIdx;
        if (n >= 1 && n <= options.length) return options[n - 1].key;
      }
    },
    async confirm(q, def = false) {
      const a = (await rl.question(`${q} [${def ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
      return a ? a.startsWith('y') : def;
    },
  };
}

export async function verifyToken(token: string): Promise<string> {
  const me = await new Bot(token).api.getMe();
  return me.username ?? String(me.id);
}

/** Long-poll getUpdates until a message arrives; drain older updates first so a stale one is not paired. */
export async function waitForChat(token: string): Promise<PairedChat> {
  const api = new Bot(token).api;
  let offset = 0;
  const old = await api.getUpdates({ offset: -1, timeout: 0 });
  if (old.length) offset = old[old.length - 1].update_id + 1;
  for (;;) {
    const updates = await api.getUpdates({ offset, timeout: 30, allowed_updates: ['message'] });
    for (const u of updates) {
      offset = u.update_id + 1;
      const m = u.message;
      if (!m) continue;
      // An anonymous admin or a channel post would pair a stand-in id as the owner (adapter.ts).
      if (standIn(m)) { console.log('Ignored a message sent as a channel or by an anonymous admin. Send it from your own account.'); continue; }
      await api.getUpdates({ offset, timeout: 0 }); // acknowledge so the daemon does not replay it
      const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup';
      const title = isGroup ? (m.chat.title ?? String(m.chat.id)) : [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || String(m.chat.id);
      return { id: String(m.chat.id), title, isGroup, sender: m.from ? String(m.from.id) : undefined };
    }
  }
}

export async function initCommand(): Promise<void> {
  const ask = terminalAsk();
  await runInit({ ask, stateDir: process.env.ANGELIA_STATE_DIR, verifyToken, waitForChat, hasBin });
  process.exit(0);
}

/** Found where the daemon would find it: PATH, then the usual install folders (locateBin). The
 *  wizard used to search PATH only and call a CLI, whisper or ffmpeg missing that the daemon finds. */
const hasBin = (bin: string): boolean => !!locateBin(bin);
