/**
 * A failed call to the model, as Claude Code reports it. It writes the failure as an assistant row of
 * its own ("Not logged in · Please run /login", "API Error: 500 …"), marked `isApiErrorMessage` in the
 * transcript, so a reader that takes the last assistant text as the answer posts the error to the chat
 * as if the agent had said it (2026-10-24). The mark, not the words, decides: an answer that quotes
 * "please run /login" in a code sample is still an answer.
 *
 * A usage limit is left out on purpose: it comes the same way, and the orchestrator already answers
 * it with how to switch model (deliver/text.ts, isLimitText), which a retry a minute later would not.
 */
import { isLimitText } from '../core/deliver/text.js';

/** The start of a result's reason when the answer was an API error row. */
export const API_ERROR = 'api-error: ';

/** True for a row Claude Code wrote for a failed API call: `isApiErrorMessage` in the transcript, an
 *  `error` on the assistant message in the print-mode stream. */
export function isApiErrorRow(row: unknown): boolean {
  const r = row as { type?: string; isApiErrorMessage?: unknown; error?: unknown } | null;
  if (r?.type !== 'assistant') return false;
  return r.isApiErrorMessage === true || (typeof r.error === 'string' && r.error.length > 0);
}

/** The error text to hold back from the chat, or null when it is no error or a usage limit. */
export function apiErrorText(row: unknown): string | null {
  if (!isApiErrorRow(row)) return null;
  const c = (row as { message?: { content?: unknown } }).message?.content;
  const text = typeof c === 'string' ? c.trim()
    : Array.isArray(c) ? c.map((b: { type?: string; text?: unknown }) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('\n').trim() : '';
  return isLimitText(text) ? null : text;
}

export const apiErrorReason = (text: string): string => `${API_ERROR}${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`;

export const isApiErrorReason = (reason: string | undefined): boolean => String(reason ?? '').startsWith(API_ERROR);

/** The CLI lost its login: only `claude` then `/login` on the host helps, and a retry a minute later
 *  only when someone did that in between. Kept to what Claude Code and the API say for it. */
const LOGIN = /not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_error/i;

export function loginLost(text: string): boolean {
  return LOGIN.test(text);
}

/** What a minute's wait may answer: a 5xx or an overload, a 408 (timeout), 409 (conflict) or 429 (rate
 *  limit), a network failure, a lost login (a refreshed token). Anything else, "Prompt is too long" for
 *  one, fails the same way again. The status code decides when there is one: a 400 whose message holds
 *  "network" or "timeout" is no network failure. The words count only for an error with no code. */
const STATUS = /\bAPI Error:?\s*\(?\s*([1-5]\d\d)\b|"status"\s*:\s*([1-5]\d\d)\b|\bstatus(?: code)?\s+([1-5]\d\d)\b/i;
const RETRY_STATUS = /^(?:5\d\d|408|409|429)$/;
const TRANSIENT = /overloaded|internal server error|bad gateway|service unavailable|gateway time-?out|rate[ _-]?limit|too many requests|connection error|\bnetwork (?:error|failure|is unreachable)\b|fetch failed|socket hang up|\btimed out\b|\btimeout\b|ECONN[A-Z]+|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH/i;

export function retryableApiError(reason: string | undefined): boolean {
  const r = String(reason ?? '');
  if (!isApiErrorReason(r)) return false;
  if (loginLost(r)) return true;
  const m = STATUS.exec(r);
  const code = m?.[1] ?? m?.[2] ?? m?.[3];
  return code ? RETRY_STATUS.test(code) : TRANSIENT.test(r);
}
