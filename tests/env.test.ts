import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../src/instance/config/schema.js';
import { profileEnv, readEnvFile, tableSecrets } from '../src/core/env.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { runJob, JOBS_FILE } from '../src/jobs/jobs.js';
import type { Inbound } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fake-claude.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'angelia-env-'));

/** A bank capability that only `money` is given; `family` must never see its login. */
function table(money = tmp(), family = tmp()) {
  return Config.parse({
    capabilities: { bank: { kind: 'mcp', command: 'bank', env: ['CANARY_BANK'] } },
    profiles: { money: { cwd: money, capabilities: ['bank'], shell: true }, family: { cwd: family, shell: true } },
    routes: [{ platform: 'telegram', chat: 1, profile: 'money' }, { platform: 'telegram', chat: 2, profile: 'family' }],
    telegram: { token_env: 'TELEGRAM_BOT_TOKEN' },
    defaults: { max_out_per_min: 1000 },
  });
}
/** What `~/.angelia/env` holds. */
const SECRETS = { TELEGRAM_BOT_TOKEN: 'canary-token', CANARY_BANK: 'canary-bank', CANARY_OTHER: 'canary-other' };
/** The daemon's own environment, as a shell that exported too much would leave it. */
const BASE = { PATH: process.env.PATH, HOME: process.env.HOME, TELEGRAM_BOT_TOKEN: 'canary-token', ANTHROPIC_API_KEY: 'canary-billing', CANARY_PLAIN: 'plain' };
const dm = (chat: string, text: string): Inbound => ({ platform: 'telegram', chat, sender: 'u1', senderName: 'Owner', text, isGroup: false, mentioned: false, media: [] });
const CANARIES = 'env | grep -E "^CANARY_" | sort; env | grep -oE "^(TELEGRAM_BOT_TOKEN|ANTHROPIC_API_KEY)="';

test('the env file is read as the daemon reads it: export and quotes allowed, anything else skipped', () => {
  const f = join(tmp(), 'env');
  writeFileSync(f, 'export A=1\nB="two"\nC=\'three\'\n# a comment\nnot a line\n');
  assert.deepEqual(readEnvFile(f), { A: '1', B: 'two', C: 'three' });
  assert.deepEqual(readEnvFile(join(tmp(), 'missing')), {});
});

test('a child gets no bot token, no billing variable, and only the secrets its capabilities name', () => {
  const cfg = table();
  const money = profileEnv(BASE, SECRETS, tableSecrets(cfg), ['CANARY_BANK']);
  assert.equal(money.env.CANARY_BANK, 'canary-bank');
  assert.equal(money.env.CANARY_PLAIN, 'plain', 'an ordinary variable passes');
  for (const k of ['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'CANARY_OTHER']) assert.equal(money.env[k], undefined, k);
  assert.deepEqual(money.granted, ['CANARY_BANK']);
  assert.deepEqual(money.withheld, ['CANARY_OTHER', 'TELEGRAM_BOT_TOKEN']);

  // A capability variable the daemon's shell exported is still that capability's: no other profile gets it.
  const family = profileEnv({ ...BASE, CANARY_BANK: 'from-the-shell' }, {}, tableSecrets(cfg));
  assert.equal(family.env.CANARY_BANK, undefined);
  assert.ok(family.withheld.includes('CANARY_BANK'));

  // A capability that names a billing variable does not get it: that would move the CLI off the subscription.
  assert.equal(profileEnv(BASE, { ANTHROPIC_API_KEY: 'k' }, [], ['ANTHROPIC_API_KEY']).env.ANTHROPIC_API_KEY, undefined);
});

test('print mode and /sh: each profile sees its own secrets and nothing else', async (t) => {
  const cfg = table();
  const sent: string[] = [];
  const o = new Orchestrator(cfg, { telegram: { send: async (_c: string, text: string) => { sent.push(text); } } }, { stateDir: tmp(), bins: { 'claude-code': FAKE }, env: BASE, secrets: SECRETS });
  t.after(() => o.shutdown());
  await o.handle(dm('1', 'ENVDUMP'));
  await o.handle(dm('2', 'ENVDUMP'));
  assert.deepEqual(sent, ['env: CANARY_BANK=canary-bank CANARY_PLAIN=plain', 'env: CANARY_PLAIN=plain']);

  sent.length = 0;
  await o.handle(dm('1', `/sh ${CANARIES}`));
  await o.handle(dm('2', `/sh ${CANARIES}`));
  assert.match(sent[0], /CANARY_BANK=canary-bank/);
  assert.doesNotMatch(sent[0], /TELEGRAM_BOT_TOKEN|ANTHROPIC_API_KEY|CANARY_OTHER/);
  assert.doesNotMatch(sent[1], /CANARY_BANK|TELEGRAM_BOT_TOKEN|ANTHROPIC_API_KEY|CANARY_OTHER/);
});

test('a job\'s command gets what its profile\'s agent gets', async () => {
  const money = tmp(), family = tmp();
  for (const cwd of [money, family]) writeFileSync(join(cwd, JOBS_FILE), `jobs:\n  dump: {every: 1h, run: '${CANARIES}; true'}\n`);
  const cfg = table(money, family);
  const got: string[] = [];
  const deliver = async (_k: 'send' | 'turn', _key: string, text: string) => { got.push(text); };
  await runJob(cfg, 'money', 'dump', deliver, { env: BASE, secrets: SECRETS });
  await runJob(cfg, 'family', 'dump', deliver, { env: BASE, secrets: SECRETS });
  assert.deepEqual(got, ['CANARY_BANK=canary-bank\nCANARY_PLAIN=plain', 'CANARY_PLAIN=plain']);
});
