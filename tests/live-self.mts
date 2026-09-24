// Live probe: does each backend actually have the self prompt in context?
// Run: npx tsx tests/live-self.mts /path/to/dir [claude-code|grok]
// Claude Code gets it on argv. grok gets it from the block in <dir>/CLAUDE.md, which grok loads only
// when <dir> is a folder it trusts (`grok inspect` in <dir>); in an untrusted one it answers blind.
import { join } from 'node:path';
import { ClaudeBrain } from '../src/brain/claude.js';
import { GrokBrain } from '../src/brain/grok.js';
import { Config } from '../src/instance/config/schema.js';
import { selfPrompt, upsertSelfBlock } from '../src/daemon/self.js';
const cwd = process.argv[2] ?? process.cwd();
// A name no model could guess, so a right answer can only come from the prompt.
const system = selfPrompt({ profile: 'zephyr-seven', table: '/nowhere/routing.yaml' });
const ask = 'Do not use any tools. Answer in one line from what is already in your context: which Angelia profile are you, and which command do you run before changing the setup?';
for (const backend of (process.argv[3] ? [process.argv[3]] : ['claude-code', 'grok']) as ('claude-code' | 'grok')[]) {
  const p = Config.parse({ profiles: { x: { cwd, backend, ...(backend === 'claude-code' ? { model: 'haiku' } : {}) } }, routes: [] }).profiles.x;
  let b;
  if (backend === 'grok') { console.log('CLAUDE.md block', upsertSelfBlock(join(cwd, 'CLAUDE.md'), system)); b = new GrokBrain(p, { id: 'unused', started: false }); }
  else b = new ClaudeBrain(p, { id: crypto.randomUUID(), started: false }, { system });
  b.start();
  for await (const e of b.turn(ask)) if (e.kind === 'result') console.log(backend, '->', JSON.stringify(e.text));
  await b.stop();
}
