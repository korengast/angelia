import type { Orchestrator } from '../src/core/orchestrator.js';

/**
 * A brain that asks for permission, put in a chat's place in the orchestrator: a turn whose text holds
 * `ASK:<id>,<id>` opens one request per id and ends when all are answered (or `end()` is called); any
 * other turn answers `echo: <last line>`. It keeps the answers it got and every turn's text, so a test
 * can tell an answer taken from a message handed to the agent.
 */
export function asker(o: Orchestrator, key: string) {
  const pending = new Set<string>();
  const hits = (p: string) => [...pending].filter((id) => id.startsWith(p.toLowerCase()));
  const f = {
    name: 'asker', alive: true, lastUsedAt: 0,
    answers: [] as [string, boolean][],
    turns: [] as string[],
    /** Ends the running turn with requests still open. */
    end: () => {},
    get pendingPermissionCount() { return pending.size; },
    on() { return f; }, start() {}, kill() {},
    async release() { f.end(); }, async stop() { f.end(); },
    hasPendingPermission: (p: string) => hits(p).length === 1,
    answerPermission(p: string, allow: boolean) {
      const h = hits(p);
      if (h.length !== 1) return false;
      pending.delete(h[0]);
      f.answers.push([h[0], allow]);
      if (!pending.size) f.end();
      return true;
    },
    async *turn(text: string) {
      f.turns.push(text);
      const ids = /ASK:(\S+)/.exec(text)?.[1].split(',') ?? [];
      if (!ids.length) { yield { kind: 'result', text: `echo: ${text.split('\n').at(-1)}`, isError: false }; return; }
      const from = f.answers.length;
      const done = new Promise<void>((r) => { f.end = r; });
      for (const id of ids) { pending.add(id); yield { kind: 'permission', id, tool: 'Bash', preview: `touch ${id.slice(0, 4)}` }; }
      await done;
      pending.clear();
      yield { kind: 'result', text: `done: ${f.answers.slice(from).map(([id, allow]) => `${id.slice(0, 4)}=${allow ? 'yes' : 'no'}`).join(' ') || 'nothing answered'}`, isError: false };
    },
  };
  (o as unknown as { brains: Map<string, unknown> }).brains.set(key, f);
  return f;
}

/** The ids of the requests open in a chat. */
export function openAsks(o: Orchestrator, key: string): string[] {
  return o.waitingPermissions().filter((w) => w.key === key).map((w) => w.id);
}
