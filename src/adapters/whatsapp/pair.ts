import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { join } from 'node:path';
import { loadConfig } from '../../instance/config/load.js';
import { WhatsAppAdapter } from './adapter.js';

/** `angelia unpair [routing.yaml]`: log Angelia's linked device out of the WhatsApp account and delete its credentials. Nothing else on that number changes. */
export async function unpairWhatsApp(configPath: string): Promise<void> {
  const cfg = loadConfig(configPath);
  if (!cfg.whatsapp) throw new Error('no whatsapp block in the config');
  const dir = cfg.whatsapp.auth_dir;
  if (!existsSync(join(dir, 'creds.json'))) { console.log('not paired (no credentials); nothing to do'); return; }
  const wa = new WhatsAppAdapter({ authDir: dir, pairing: cfg.whatsapp.pairing, phone: cfg.whatsapp.phone, inboxFor: () => undefined, onInbound: async () => {}, log: (l) => console.log(l) });
  const opened = new Promise<boolean>((resolve) => { wa.once('open', () => resolve(true)); setTimeout(() => resolve(false), 20_000); });
  await wa.start();
  if (await opened) { await wa.logout(); console.log('logged out on the phone side'); }
  else { await wa.stop(); console.log('could not connect within 20 s; credentials deleted locally. Remove "Angelia" under WhatsApp > Linked devices on the phone.'); }
  rmSync(dir, { recursive: true, force: true });
  console.log(`credentials deleted: ${dir}`);
}

const PAIR_TIMEOUT_MS = 10 * 60_000;

interface PairView { stage: 'starting' | 'qr' | 'scanned' | 'linked' | 'failed'; note: string; qr?: string; n: number }

const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Angelia · link WhatsApp</title>
<body style="margin:0;background:#fff;color:#111;display:flex;flex-direction:column;align-items:center;font-family:system-ui,sans-serif;text-align:center">
<h3 style="margin:16px 12px 4px">Link WhatsApp to Angelia</h3>
<p id=s style="margin:4px 12px;max-width:560px">Starting…</p>
<img id=q style="width:min(88vw,520px);display:none">
<ol style="text-align:left;max-width:520px;margin:8px 24px;line-height:1.5"><li>On the phone that owns the number: WhatsApp › Settings › Linked devices › Link a device.</li><li>Point the camera at this code. Do not pick "Link with phone number".</li><li>If the phone asks to create a passkey, do it, then scan again.</li></ol>
<script>let n=-1;setInterval(async()=>{try{const v=await (await fetch('state?t='+Date.now())).json();document.getElementById('s').textContent=v.note;const q=document.getElementById('q');if(v.stage==='qr'){if(v.n!==n){n=v.n;q.src='qr.png?t='+Date.now();}q.style.display='block';}else q.style.display='none';}catch{document.getElementById('s').textContent='Pairing ended. See the terminal.';}},1200)</script>`;

/** Loopback page with the live QR: a phone camera reads a browser image far better than terminal block characters. */
async function servePairPage(view: PairView): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const head = { 'cache-control': 'no-store' };
    if (path === '/state') { res.writeHead(200, { ...head, 'content-type': 'application/json' }); res.end(JSON.stringify({ stage: view.stage, note: view.note, n: view.n })); return; }
    if (path === '/qr.png') {
      if (!view.qr) { res.writeHead(404, head); res.end(); return; }
      void QRCode.toBuffer(view.qr, { width: 560, margin: 2 }).then((png) => { res.writeHead(200, { ...head, 'content-type': 'image/png' }); res.end(png); }, () => { res.writeHead(500, head); res.end(); });
      return;
    }
    res.writeHead(200, { ...head, 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

/** `angelia pair [routing.yaml]`: link this daemon to the WhatsApp account named in the config, then exit. */
export async function pairWhatsApp(configPath: string): Promise<void> {
  const cfg = loadConfig(configPath);
  if (!cfg.whatsapp) throw new Error('no whatsapp block in the config');
  const view: PairView = { stage: 'starting', note: 'Connecting to WhatsApp…', n: 0 };
  const wa = new WhatsAppAdapter({
    authDir: cfg.whatsapp.auth_dir, pairing: cfg.whatsapp.pairing, phone: cfg.whatsapp.phone, pairOnly: true,
    inboxFor: () => undefined, onInbound: async () => {}, log: (l) => console.log(l),
  });
  const done = new Promise<void>((resolve, reject) => {
    wa.once('paired', resolve);
    wa.once('logged-out', () => reject(new Error('WhatsApp refused the link twice. On the phone, remove any "Angelia" entry under Linked devices, then run `angelia pair` again.')));
    wa.once('code-failed', () => reject(new Error('pairing by code failed')));
    setTimeout(() => reject(new Error('no link within 10 minutes. If the phone showed an error, note its exact text; if it asked for a passkey, create one and run `angelia pair` again.')), PAIR_TIMEOUT_MS).unref();
  });
  // ANGELIA_QR_FILE: also write the raw QR payload there, for a helper that renders it as an image elsewhere.
  const qrFile = process.env.ANGELIA_QR_FILE;
  let page: { url: string; close: () => void } | undefined;
  let opening = false;
  // The page starts with the first QR: an account that is already linked never sees one.
  const showPage = async (): Promise<void> => {
    if (opening) return;
    opening = true;
    page = await servePairPage(view);
    console.log(`QR page: ${page.url} (easier for the phone camera than the terminal QR)`);
    if (process.platform === 'darwin' && !process.env.ANGELIA_NO_OPEN) spawn('open', [page.url], { stdio: 'ignore', detached: true }).unref();
  };
  wa.on('qr', (raw: string) => {
    void showPage();
    view.qr = raw; view.n++; view.stage = 'qr'; view.note = `Scan this code with the phone (code ${view.n}; it renews about every 20 seconds).`;
    if (qrFile) try { writeFileSync(qrFile, raw, { mode: 0o600 }); } catch { /* best effort */ }
  });
  wa.on('scanned', () => { view.stage = 'scanned'; view.qr = undefined; view.note = 'The phone accepted the link. Finishing, keep WhatsApp open on the phone…'; });
  wa.on('restart', () => { view.stage = 'starting'; view.note = 'Starting over with clean credentials…'; });
  await wa.start();
  try {
    await done;
    view.stage = 'linked'; view.note = 'Linked. You can close this tab and start the daemon.';
    await new Promise((r) => setTimeout(r, 2500)); // let the page show the result
    console.log('WhatsApp linked. Start the daemon.');
  } catch (e) {
    view.stage = 'failed'; view.note = (e as Error).message;
    throw e;
  } finally {
    await wa.stop();
    page?.close();
  }
}
