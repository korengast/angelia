import { execFile } from 'node:child_process';
import type { Profile } from '../instance/config/schema.js';
import type { ToolRequest } from '../core/permission-rules.js';
import { grokArgv, childEnv } from './argv.js';
import type { BrainOptions, BrainSession } from './brain.js';
import { AcpBrain, type Msg } from './acp.js';
import { grokRequest } from './tool-request.js';

/**
 * Mark a folder trusted in grok. grok reads a folder's CLAUDE.md only once it is trusted, and a chat
 * has no screen to answer its trust question on. `--trust` records the trust without opening the TUI
 * when a subcommand follows, and `inspect` then prints whether it holds (grok 1.0.40). Never rejects:
 * false when grok is missing, does not answer in time, or still says no.
 */
export function trustFolder(bin: string, cwd: string, timeoutMs = 30_000): Promise<boolean> {
  return new Promise((done) => {
    execFile(bin, ['--trust', 'inspect'], { cwd, env: childEnv(), timeout: timeoutMs }, (err, out) => done(!err && /Project trusted:\s*yes/i.test(String(out))));
  });
}

/**
 * One long-lived `grok agent stdio` child (Grok Build) per session key, driven over ACP
 * (Agent Client Protocol, JSON-RPC 2.0 on stdio). Measured 2026-09-15 against grok 1.0.13 / 1.0.30:
 * `initialize` -> `session/new` (the agent mints the id) or `session/load` (resume, capability
 * `loadSession`) -> `session/prompt` per turn. Text arrives as `session/update` notifications
 * (`agent_message_chunk`, `tool_call`); permission prompts as `session/request_permission` requests
 * the client answers with an option id. `--always-approve` on argv is the bypass stance.
 * The protocol itself is in AcpBrain (acp.ts).
 */
export class GrokBrain extends AcpBrain {
  static override startTimeoutMs = 60_000;
  protected readonly cliName = 'grok';

  constructor(profile: Profile, session: BrainSession, opts: BrainOptions = {}) { super(profile, session, opts); }

  protected argv(): string[] { return grokArgv(this.profile, this.opts.bin ?? 'grok'); }

  protected toolName(tc: Msg): string { return String(tc._meta?.['x.ai/tool']?.name ?? tc.title ?? tc.kind ?? '?'); }

  protected override toolRequest(tc: Msg): ToolRequest | undefined { return grokRequest(tc); }

  protected async openSession(): Promise<string> {
    const base = { cwd: this.profile.cwd, mcpServers: [] };
    if (this.session.started) {
      await this.loadDroppingReplay({ ...base, sessionId: this.session.id });
      this.backendSessionId = this.session.id;
    } else {
      const s = await this.call('session/new', base);
      this.backendSessionId = String(s.sessionId);
    }
    return this.backendSessionId;
  }
}
