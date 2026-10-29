import { env } from '../config/env.js'
import { accessToken, AccountAuthError, forgetAccessTokens } from './oauth.js'

// SENDING ONE EMAIL THROUGH THE GMAIL API, AND SAYING EXACTLY WHAT HAPPENED.
//
// The answer decides whether the email may ever be tried again:
//   sent     → Gmail accepted it (its id is kept).
//   refused  → Gmail answered and did NOT send it. kind:
//                quota   (rate or daily limit)     → tried again later, the campaign waits
//                auth    (permission lost)          → the campaign pauses until the account is reconnected
//                invalid (the message was rejected) → failed; a person may retry it after fixing the cause
//   unknown  → no clear answer (connection lost, timeout, Gmail server error). Gmail may have
//              sent it, so it is NEVER sent again automatically; it is looked up in Sent (when
//              allowed) or a person checks and decides.

export type SendOutcome =
  | { outcome: 'sent'; gmailId: string | null; threadId: string | null }
  | { outcome: 'refused'; kind: 'quota' | 'auth' | 'invalid'; reason: string }
  | { outcome: 'unknown'; reason: string }

const QUOTA_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded', 'backendRateLimitExceeded'])
const SEND_TIMEOUT_MS = 120_000

interface GoogleError {
  error?: { code?: number; message?: string; status?: string; errors?: Array<{ reason?: string; message?: string }> }
}

const short = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').slice(0, 300)

/** What a non-2xx answer from Gmail means. Pure. */
export function classifyGmailError(status: number, body: GoogleError | null): SendOutcome {
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? ''
  const message = short(body?.error?.message ?? `HTTP ${status}`)
  if (status === 429 || QUOTA_REASONS.has(reason)) return { outcome: 'refused', kind: 'quota', reason: `Gmail's sending limit was reached (${message}).` }
  if (status === 401 || status === 403) return { outcome: 'refused', kind: 'auth', reason: `Gmail refused the account's permission (${message}). Reconnect the account.` }
  if (status === 400 || status === 404 || status === 413 || status === 422) return { outcome: 'refused', kind: 'invalid', reason: `Gmail rejected the email: ${message}` }
  // 408, 5xx and anything unexpected: Gmail may or may not have sent it.
  return { outcome: 'unknown', reason: `Gmail did not confirm the email (${message}). It may have been sent — it is not sent again automatically.` }
}

async function post(token: string, mime: Buffer): Promise<Response> {
  return fetch(`${env.GMAIL_API_BASE}/upload/gmail/v1/users/me/messages/send?uploadType=media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'message/rfc822' },
    body: new Uint8Array(mime),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  })
}

/** Sends one complete message as the account. Never throws for an outcome; only for a bug. */
export async function sendViaGmail(accountId: string, mime: Buffer): Promise<SendOutcome> {
  let token: string
  try {
    token = await accessToken(accountId)
  } catch (err) {
    // Nothing reached Gmail: certainly not sent.
    if (err instanceof AccountAuthError) return { outcome: 'refused', kind: 'auth', reason: err.message }
    return { outcome: 'refused', kind: 'quota', reason: `Google's sign-in service did not answer, so nothing was sent; it is tried again later. (${short((err as Error).message)})` }
  }
  let res: Response
  try {
    res = await post(token, mime)
    if (res.status === 401) {
      // The access token was refused before anything was sent: get a fresh one and try once more.
      forgetAccessTokens(accountId)
      try {
        token = await accessToken(accountId)
      } catch (err) {
        if (err instanceof AccountAuthError) return { outcome: 'refused', kind: 'auth', reason: err.message }
        return { outcome: 'refused', kind: 'quota', reason: `Google's sign-in service did not answer, so nothing was sent; it is tried again later.` }
      }
      res = await post(token, mime)
    }
  } catch (err) {
    return { outcome: 'unknown', reason: `The connection to Gmail was lost while sending (${short((err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message)}). It may have been sent — it is not sent again automatically.` }
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (res.ok) {
    const b = (body ?? {}) as { id?: string; threadId?: string }
    return { outcome: 'sent', gmailId: typeof b.id === 'string' ? b.id : null, threadId: typeof b.threadId === 'string' ? b.threadId : null }
  }
  return classifyGmailError(res.status, body as GoogleError | null)
}

/**
 * Looks for an email in the account's mailbox by its Message-ID (needs GMAIL_READONLY_CHECK and the readonly
 * permission). 'found' / 'not_found' / 'unavailable' (cannot tell — nothing is decided then).
 */
export async function findSentByMessageId(accountId: string, messageId: string): Promise<{ result: 'found' | 'not_found' | 'unavailable'; gmailId?: string; threadId?: string }> {
  if (!env.GMAIL_READONLY_CHECK) return { result: 'unavailable' }
  try {
    const token = await accessToken(accountId)
    const q = new URLSearchParams({ q: `rfc822msgid:${messageId.replace(/^<|>$/g, '')}`, includeSpamTrash: 'true', maxResults: '2' })
    const res = await fetch(`${env.GMAIL_API_BASE}/gmail/v1/users/me/messages?${q}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return { result: 'unavailable' }
    const body = (await res.json()) as { messages?: Array<{ id: string; threadId: string }> }
    const m = body.messages?.[0]
    return m ? { result: 'found', gmailId: m.id, threadId: m.threadId } : { result: 'not_found' }
  } catch {
    return { result: 'unavailable' }
  }
}
