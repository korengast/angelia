import { existsSync, readFileSync } from 'node:fs';
import { permissionPolicy, type Config } from './config/schema.js';
import { sessionKey, type SessionMapFile } from '../core/types.js';
import { untilText } from './connect.js';

/** `angelia profiles`: what this instance has, for an agent that needs to know its neighbours.
 *  Kept out of the self prompt on purpose: the list changes more often than the code. */
/** `armed`: what `angelia profile connect` armed (instance/connect.ts), shown next to its profile. */
export function profilesText(cfg: Config, armed: { profile: string; platform: string; until: string }[] = []): string {
  const rows = Object.entries(cfg.profiles).map(([name, p]) => {
    const waits = armed.filter((a) => a.profile === name).map((a) => `  armed    takes the next new ${a.platform} chat an owner writes in, until ${untilText(a.until)}`);
    const backend = p.backend === 'claude-code' && p.tui ? 'claude-code (tui)' : p.backend;
    // The same key send, turn, export and a job's chat: take, so a line can be copied from here.
    const chats = cfg.routes.filter((r) => r.profile === name).map((r) => sessionKey(r));
    return [`${name}`, `  backend  ${backend}${p.model ? ` · ${p.model}` : ''}`, `  folder   ${p.cwd}`, `  chats    ${chats.length ? chats.join(', ') : '(none: no route names it)'}`, ...waits].join('\n');
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

/** The same list for a client that shows each profile's setup (the API's `/profiles`): the table's
 *  settings for it too, in the table's order. Routes and secrets' values stay out; a capability is its name. */
export function profilesDetail(cfg: Config, sessions: SessionMapFile): { version: 1; profiles: (ProfileJson & { settings: Record<string, unknown> })[] } {
  const { profiles } = profilesJson(cfg, sessions);
  return {
    version: 1,
    profiles: profiles.map((row) => {
      const p = cfg.profiles[row.name];
      return { ...row, settings: {
        permission_mode: p.permission_mode, permission_prompts: permissionPolicy(p).default === 'refuse' ? 'deny' : 'chat', permissions: permissionPolicy(p), effort: p.effort ?? null, capabilities: p.capabilities, except: p.except, deny: p.deny,
        add_dirs: p.add_dirs, sandbox: p.sandbox ?? null, isolated: p.isolated, chrome: p.chrome, shell: p.shell, media_tags: p.media_tags,
      } };
    }),
  };
}

export function readSessions(path: string): SessionMapFile {
  if (!existsSync(path)) return { version: 1, chats: {} };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionMapFile>;
  return { version: 1, chats: raw.chats ?? {} };
}
