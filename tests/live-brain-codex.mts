// Live probe: the real Codex through CodexBrain, inside its sandbox. Needs a Codex login.
// Run: npx tsx tests/live-brain-codex.mts /path/to/empty/dir [codex binary]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexBrain } from '../src/brain/codex.js';
const cwd = process.argv[2] ?? process.cwd();
const bin = process.argv[3] ?? 'codex';
// A dummy file outside the folder, denied in the profile's settings the way compile writes the floor.
const outside = join(cwd, '..', 'outside-dummy');
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'note.txt'), 'DUMMY-NOTE');
mkdirSync(join(cwd, '.claude'), { recursive: true });
writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [`Read(${outside}/**)`, `Edit(${outside}/**)`] } }));
const profile = { cwd, permission_mode: 'acceptEdits' as const, add_dirs: [], unsafe_ok: false, shell: false, shell_timeout_seconds: 60, chrome: false, backend: 'codex' as const, media_tags: false, agent_commands: [], isolated: false };
const run = async (b: CodexBrain, text: string, allow = false) => {
  const t = Date.now();
  for await (const e of b.turn(text)) {
    if (e.kind === 'permission') { console.log('PERMISSION', e.tool, '|', e.preview.slice(0, 200), allow ? '-> allow' : '-> deny'); b.answerPermission(e.id.slice(0, 8), allow); }
    else console.log(e.kind, JSON.stringify(e.text).slice(0, 220), (e as any).reason ?? '', Date.now() - t, 'ms');
  }
};
const system = 'You are the profile "live" in an Angelia instance. When asked your profile name, answer with it.';
const opts = { bin, system, profileName: 'live', apiSocket: join(cwd, '..', 'state', 'api.sock') }; // a scratch state folder, never the real one
const b = new CodexBrain(profile as any, { id: 'unused', started: false }, opts);
b.start();
await run(b, '[telegram dm 1 · Sam]\n\nReply with exactly the word PONG.');
await run(b, 'What is your profile name? One word.');
await run(b, 'Create a file hello.txt containing hi. Then say done.');
await run(b, 'Run npm config get cache and print its output verbatim.');
await run(b, `Write the text x into ${join(cwd, '..', 'elsewhere.txt')} using the shell. Report exactly what happened and what the owner could do.`);
console.log('thread', b.backendSessionId, 'version', b.version);
await b.stop();
const r = new CodexBrain(profile as any, { id: b.backendSessionId!, started: true }, opts);
r.start();
await run(r, 'In one short line: what was the first thing I asked you?');
await r.stop();
console.log('alive after stop:', r.alive);
