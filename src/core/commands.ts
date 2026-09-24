import type { SessionMap } from './session/map.js';

export type Command =
  | { name: 'new' } | { name: 'stop' } | { name: 'status' } | { name: 'help' } | { name: 'restart' }
  | { name: 'resume'; selector?: string }
  | { name: 'model'; value?: string } | { name: 'effort'; value?: string }
  | { name: 'sh'; script: string };

/** Router-handled commands (0 Claude tokens). Anything else starting with "/" is passed to Claude as text. */
export function parseCommand(text: string): Command | null {
  const sh = /^\/sh(?:@\w+)?(?:\s+|\n)([\s\S]+)$/i.exec(text.trim());
  if (sh) return { name: 'sh', script: sh[1].trim() };
  const m = /^\/(new|stop|status|help|resume|model|effort|restart)(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase() as Exclude<Command['name'], 'sh'>;
  if (name === 'resume') return { name, selector: m[2] };
  if (name === 'model' || name === 'effort') return { name, value: m[2] };
  return { name };
}

/** One list feeds /help and Telegram's command menu (setMyCommands). */
export const COMMANDS: { command: string; args?: string; description: string }[] = [
  { command: 'new', description: 'start a fresh session (the old one stays in history)' },
  { command: 'stop', description: 'interrupt the current turn' },
  { command: 'status', description: 'active session, turns, last use' },
  { command: 'resume', args: '[N | id prefix]', description: 'list recent sessions, or switch to one' },
  { command: 'model', args: '[name | default]', description: 'show or set the model for this session only' },
  { command: 'effort', args: '[low..max | default]', description: 'show or set the effort for this session only' },
  { command: 'sh', args: '<command>', description: 'run a shell command in the profile directory, no agent involved' },
  { command: 'restart', description: 'check the routing table, then restart Angelia (owner only)' },
  { command: 'help', description: 'this list' },
];

export const HELP = COMMANDS.map((c) => `/${c.command}${c.args ? ' ' + c.args : ''} — ${c.description}`).join('\n');

export function statusText(map: SessionMap, key: string, profile: string, alive: boolean, queued: number): string {
  const a = map.getActive(key);
  if (!a) return `angelia · profile ${profile} · no active session yet`;
  return [
    `angelia · profile ${profile} · session ${a.id.slice(0, 8)} · ${a.turns} turns${a.backend && a.backend !== 'claude-code' ? ` · ${a.backend}` : ''}${a.model ? ` · model ${a.model}` : ''}${a.effort ? ` · effort ${a.effort}` : ''}`,
    `last used ${a.last_used_at.slice(0, 16).replace('T', ' ')} · ${alive ? 'warm' : 'cold'} · ${queued} queued`,
    `${map.list(key, 100).length} sessions in history`,
  ].join('\n');
}

export function resumeListText(map: SessionMap, key: string): string {
  const rows = map.list(key);
  if (!rows.length) return 'No sessions yet.';
  const active = map.getActive(key)?.id;
  return rows
    .map((r, i) => `${i + 1}. ${r.id.slice(0, 8)}${r.id === active ? ' *' : ''} · ${r.turns} turns · ${r.label || '(no label)'}`)
    .join('\n');
}
