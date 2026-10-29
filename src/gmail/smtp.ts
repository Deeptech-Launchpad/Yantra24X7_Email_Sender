import { Readable } from 'node:stream'
import nodemailer from 'nodemailer'
import { env } from '../config/env.js'
import { prisma } from '../platform/db.js'
import { open } from '../platform/secretBox.js'
import type { SendOutcome } from './api.js'

// SENDING THROUGH GMAIL'S MAIL SERVER WITH AN APP PASSWORD (SMTP), AND SAYING EXACTLY WHAT HAPPENED.
//
// For an account added with a Gmail app password instead of Google's sign-in page. The
// password is stored encrypted, like a refresh token, and is only ever sent to Gmail's mail
// server (SMTP_HOST, over TLS). The answers mean the same as with the Gmail API:
//   sent    → the server accepted the email (250).
//   refused → the server answered and did NOT take it:
//               auth    (534/535: the app password no longer works) → the campaign pauses
//               quota   (4xx, or Gmail's sending limit 5.4.5; or no connection at all) → back in the queue, the campaign pauses
//               invalid (any other 5xx)                              → failed; a person may retry it
//   unknown → the connection ended after the email was handed over, before the server
//             confirmed it. It may have been sent, so it is NEVER sent again automatically.
// Whether it was handed over is known from the message itself (the server started reading
// it), not from the error: a connection that closes reports the same error before and after.

export const APP_PASSWORD = /^[a-z]{16}$/

/** Google shows an app password as four groups of four letters; spaces are not part of it. */
export const normalizeAppPassword = (raw: string) => raw.replace(/\s+/g, '').toLowerCase()

const isLocal = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '::1'

function transportFor(email: string, password: string) {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    // Never a password over a connection without TLS (except to a test server on this machine).
    requireTLS: !env.SMTP_SECURE && !isLocal(env.SMTP_HOST),
    auth: { user: email, pass: password },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  })
}

/** What an error from the mail server means (see the top of this file). handedOver: whether any of the message was read. */
export function classifySmtpError(err: unknown, handedOver = true): Exclude<SendOutcome, { outcome: 'sent' }> {
  const e = (err ?? {}) as { code?: string; responseCode?: number; command?: string; response?: string; message?: string }
  const said = String(e.response ?? e.message ?? 'no answer').replace(/\s+/g, ' ').trim().slice(0, 200)
  const code = typeof e.responseCode === 'number' ? e.responseCode : null
  if (e.code === 'EAUTH' || code === 534 || code === 535)
    return { outcome: 'refused', kind: 'auth', reason: `Gmail did not accept the app password (${said}). Create a new app password in the Google account and update it under Sender accounts.` }
  if (code !== null && (/\b5\.4\.5\b|quota|limit exceeded|rate limit/i.test(said) || (code >= 400 && code < 500)))
    return { outcome: 'refused', kind: 'quota', reason: `Gmail is not taking more emails from this account right now (${said}).` }
  if (code !== null && code >= 500) return { outcome: 'refused', kind: 'invalid', reason: `Gmail refused this email (${said}).` }
  if (!handedOver) return { outcome: 'refused', kind: 'quota', reason: `The connection to Gmail's mail server failed before the email was handed over (${said}); nothing was sent.` }
  return { outcome: 'unknown', reason: `The connection to Gmail ended before it confirmed the email (${said}). It may have been sent — it is not sent again automatically. Check the Sent folder.` }
}

/** Signs in to the mail server with the app password and signs out again. No email is sent. */
export async function verifyAppPassword(email: string, password: string): Promise<{ ok: true } | { ok: false; kind: 'auth' | 'quota' | 'invalid' | 'unknown'; reason: string }> {
  const t = transportFor(email, password)
  try {
    await t.verify()
    return { ok: true }
  } catch (err) {
    const c = classifySmtpError(err, false)
    return { ok: false, kind: c.outcome === 'refused' ? c.kind : 'unknown', reason: c.reason }
  } finally {
    t.close()
  }
}

/** The stored app password of an account, or null when it cannot be used. */
export async function appPasswordOf(accountId: string): Promise<{ email: string; password: string } | null> {
  const a = await prisma.senderAccount.findUnique({ where: { id: accountId } })
  if (!a || a.authType !== 'app_password' || a.status === 'disconnected' || !a.refreshTokenEnc) return null
  try {
    return { email: a.email, password: open(a.refreshTokenEnc) }
  } catch {
    return null
  }
}

/** Sends one complete message (as built) to the envelope's recipients. */
export async function sendViaSmtp(accountId: string, mime: Buffer, envelope: { from: string; to: string[] }): Promise<SendOutcome> {
  const cred = await appPasswordOf(accountId)
  if (!cred) return { outcome: 'refused', kind: 'auth', reason: 'The app password of this account cannot be used (it is missing, or the encryption key changed). Update it under Sender accounts.' }
  const t = transportFor(cred.email, cred.password)
  let handedOver = false
  const raw = new Readable({
    read() {
      handedOver = true
      this.push(mime)
      this.push(null)
    },
  })
  try {
    await t.sendMail({ envelope, raw })
    return { outcome: 'sent', gmailId: null, threadId: null }
  } catch (err) {
    return classifySmtpError(err, handedOver)
  } finally {
    t.close()
  }
}
