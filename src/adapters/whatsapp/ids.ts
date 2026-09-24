import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** `1234:5@s.whatsapp.net` -> `1234@s.whatsapp.net`; `5678:1@lid` -> `5678@lid`. Device suffixes never matter for routing. */
export function normalizeJid(jid: string | undefined | null): string {
  if (!jid) return '';
  return String(jid).replace(/:\d+@/, '@');
}

export function isGroupJid(jid: string): boolean { return jid.endsWith('@g.us'); }

/** The bare number or lid, without server: what a route's allow_from and owners are written with. */
export function bareId(jid: string): string { return normalizeJid(jid).replace(/@.*$/, ''); }

/**
 * WhatsApp now identifies people by LID (`123@lid`) as well as by phone (`15551234567@s.whatsapp.net`).
 * Baileys writes `lid-mapping-<phone>.json` files into the auth dir; this reads them so a sender
 * seen as a lid can be written in routing.yaml as the phone number people actually know.
 */
export class LidMap {
  private lidToPhone = new Map<string, string>();
  constructor(private readonly authDir: string) { this.reload(); }

  reload(): void {
    this.lidToPhone.clear();
    let files: string[] = [];
    try { files = readdirSync(this.authDir); } catch { return; }
    for (const f of files) {
      const m = /^lid-mapping-(\d+)\.json$/.exec(f);
      if (!m) continue;
      try {
        const lid = JSON.parse(readFileSync(join(this.authDir, f), 'utf8'));
        if (lid) this.lidToPhone.set(String(lid).replace(/@.*$/, ''), m[1]);
      } catch { /* a half-written file; next reload */ }
    }
  }

  /** Phone for a lid when known, else the id as given (bare). */
  phoneFor(jid: string): string {
    const bare = bareId(jid);
    return jid.endsWith('@lid') ? (this.lidToPhone.get(bare) ?? bare) : bare;
  }
}
