# ADR 0002 — WhatsApp: Baileys in-process, pairing code, mention-required groups

Status: accepted 2026-09-13; implemented 2026-09-17 (`angelia pair`), running groups daily since.
Historical in part: QR became the default pairing once WhatsApp began rejecting pairing codes from third-party clients; the code is still an option (`pairing: code`). The code now lives in `src/adapters/whatsapp/`.

Library `@whiskeysockets/baileys` 7.0.0-rc14 (MIT), one socket per daemon, auth dir
`~/.angelia/wa`, pidfile lock. Pairing by code (QR fallback), printed to daemon stdout only.
Groups default `mention: required` (@mention of our jid in `mentionedJid`, or a reply to our
message). Sender ids resolved via `participantAlt`/`remoteJidAlt` and `signalRepository.lidMapping`, with the auth dir's `lid-mapping-*.json` as fallback. Link an established number, not a fresh one: fresh numbers are reported banned within hours. Outbound ceiling 10/min,
1.5-4 s randomised gap between chunks, presence `composing` while a turn runs, never a proactive send.
Disconnect: 401 stop+notify, 515 reconnect now, 440 backoff + one notice per 6 h, else backoff ≤30 s.
Media inbound to `<cwd>/.inbox/`; voice = file, no STT; outbound files v1.1.
Rejected: whatsapp-web.js (Chromium), whatsmeow (Go), Evolution API (server product), Cloud API
(business number, no personal groups).
