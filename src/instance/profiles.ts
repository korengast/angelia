import { existsSync, readFileSync } from 'node:fs';
import type { Config } from './config/schema.js';
import { sessionKey, type SessionMapFile } from '../core/types.js';

/** `angelia profiles`: what this instance has, for an agent that needs to know its neighbours.
 *  Kept out of the self prompt on purpose: the list changes more often than the code. */
export function profilesText(cfg: Config): string {
  const rows = Object.entries(cfg.profiles).map(([name, p]) => {
    const backend = p.backend === 'claude-code' && p.tui ? 'claude-code (tui)' : p.backend;
    // The same key send, turn, export and a job's chat: take, so a line can be copied from here.
    const chats = cfg.routes.filter((r) => r.profile === name).map((r) => sessionKey(r));
    return [`${name}`, `  backend  ${backend}${p.model ? ` · ${p.model}` : ''}`, `  folder   ${p.cwd}`, `  chats    ${chats.length ? chats.join(', ') : '(none: no route names it)'}`].join('\n');
  });
  return rows.join('\n') || 'no profiles';
}

export interface ProfileJson {
  name: string;
  backend: string;
  tui: boolean;
  model: string | null;
  folder: string;
  chats: { chat: string; session: string | null; sessions: string[] }[];
}

/** `angelia profiles --json`: the same facts for a script, plus each chat's session ids (active first
 *  as `session`, every one it has had in `sessions`, oldest first). Scripts read this instead of the
 *  routing table and the session store, whose shapes are Angelia's own and may change. */
export function profilesJson(cfg: Config, sessions: SessionMapFile): { version: 1; profiles: ProfileJson[] } {
  const profiles = Object.entries(cfg.profiles).map(([name, p]) => ({
    name,
    backend: p.backend,
    tui: p.backend === 'claude-code' && !!p.tui,
    model: p.model ?? null,
    folder: p.cwd,
    chats: cfg.routes.filter((r) => r.profile === name).map((r) => {
      const chat = sessionKey(r);
      const c = sessions.chats[chat];
      return { chat, session: c?.active ?? null, sessions: c?.history.map((h) => h.id) ?? [] };
    }),
  }));
  return { version: 1, profiles };
}

export function readSessions(path: string): SessionMapFile {
  if (!existsSync(path)) return { version: 1, chats: {} };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionMapFile>;
  return { version: 1, chats: raw.chats ?? {} };
}
