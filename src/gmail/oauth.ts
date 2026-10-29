import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { env, googleConfigured, oauthRedirectUrl } from '../config/env.js'
import { newId, prisma } from '../platform/db.js'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../platform/errors.js'
import { audit, log } from '../platform/log.js'
import { open, seal } from '../platform/secretBox.js'
import type { Principal } from '../auth/users.js'

// GMAIL SENDER ACCOUNTS, AUTHORIZED WITH GOOGLE (OAuth 2.0, authorization-code flow with PKCE).
//
// A member clicks "Connect Gmail", signs in to Google and allows this app to send email
// as them. Google sends the browser back with a one-time code; the code is exchanged here
// (server to server) for a refresh token, which is stored ENCRYPTED. No password is ever
// seen or kept. The state value ties the answer to the person who started it, can be used
// once, and expires after 10 minutes. A nonce in an httpOnly cookie ties it to the browser
// that started it too, so a sign-in link cannot be finished in someone else's browser.
//
// Scopes: openid + email (to know which address was connected) + gmail.send (send only:
// this app cannot read the mailbox). GMAIL_READONLY_CHECK=true adds gmail.readonly, used
// only to look up in Sent an email whose result is unknown.

export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
export const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const STATE_TTL_MS = 10 * 60_000

export const requestedScopes = () => ['openid', 'email', SEND_SCOPE, ...(env.GMAIL_READONLY_CHECK ? [READONLY_SCOPE] : [])]

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Thrown when an account can no longer get a token (revoked, password changed, consent removed). */
export class AccountAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountAuthError'
  }
}

/** The Google page to send the person to, and the nonce the route keeps in the browser's cookie. */
export async function startConnect(user: Principal, now = new Date()): Promise<{ url: string; browserNonce: string }> {
  if (!googleConfigured()) throw new ConflictError('Gmail sign-in is not set up yet: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing in the configuration.')
  const state = randomBytes(32).toString('base64url')
  const codeVerifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const browserNonce = randomBytes(32).toString('base64url')
  await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: now } } })
  await prisma.oAuthState.create({ data: { id: newId(), stateHash: sha256(state), userId: user.id, codeVerifier, browserNonceHash: sha256(browserNonce), expiresAt: new Date(now.getTime() + STATE_TTL_MS) } })
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: oauthRedirectUrl(),
    response_type: 'code',
    scope: requestedScopes().join(' '),
    access_type: 'offline',
    // Always ask, so Google always returns a refresh token (also when reconnecting).
    prompt: 'consent select_account',
    include_granted_scopes: 'false',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return { url: `${env.GOOGLE_AUTH_URL}?${q.toString()}`, browserNonce }
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  id_token?: string
  error?: string
  error_description?: string
}

async function tokenRequest(body: Record<string, string>): Promise<{ status: number; json: TokenResponse }> {
  const res = await fetch(env.GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  let json: TokenResponse = {}
  try {
    json = (await res.json()) as TokenResponse
  } catch {
    // not JSON
  }
  return { status: res.status, json }
}

/** The email in an ID token that came straight from Google's token endpoint over HTTPS (OpenID Connect allows reading it without re-checking the signature). */
function emailFromIdToken(idToken: string | undefined): string | null {
  const part = idToken?.split('.')[1]
  if (!part) return null
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { email?: string; email_verified?: boolean | string; aud?: string }
    if (claims.aud && claims.aud !== env.GOOGLE_CLIENT_ID) return null
    if (claims.email_verified !== true && claims.email_verified !== 'true') return null
    return typeof claims.email === 'string' ? claims.email.toLowerCase() : null
  } catch {
    return null
  }
}

/** Google came back with a code: store the account (or refresh the tokens of one already connected). */
export async function finishConnect(input: { code?: string; state?: string; error?: string; browserNonce?: string }, now = new Date()) {
  if (input.error) throw new BadRequestError(input.error === 'access_denied' ? 'Access was not allowed on the Google page, so no account was connected.' : `Google answered: ${input.error}.`)
  if (!input.code || !input.state) throw new BadRequestError('The answer from Google is incomplete. Start "Connect Gmail" again.')
  const st = await prisma.oAuthState.findUnique({ where: { stateHash: sha256(input.state) } })
  // Single use: removed before anything else, so the same answer can never be used twice.
  if (st) await prisma.oAuthState.delete({ where: { id: st.id } }).catch(() => undefined)
  if (!st || st.expiresAt < now) throw new BadRequestError('This sign-in has expired or was already used. Start "Connect Gmail" again.')
  if (!input.browserNonce || !timingSafeEqual(Buffer.from(sha256(input.browserNonce)), Buffer.from(st.browserNonceHash)))
    throw new BadRequestError('This sign-in was started in another browser. Click "Connect Gmail" again in this browser.')
  const user = await prisma.user.findUnique({ where: { id: st.userId } })
  if (!user || user.status !== 'active' || user.role === 'viewer') throw new ForbiddenError('This account may not connect a sender.')

  const { status, json } = await tokenRequest({
    code: input.code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: oauthRedirectUrl(),
    grant_type: 'authorization_code',
    code_verifier: st.codeVerifier,
  })
  if (status !== 200 || !json.access_token) throw new BadRequestError(`Google did not accept the sign-in (${json.error ?? status}). Start "Connect Gmail" again.`)
  const granted = (json.scope ?? '').split(/\s+/)
  if (!granted.includes(SEND_SCOPE)) throw new BadRequestError('Permission to send email was not given on the Google page. Connect again and tick "Send email on your behalf".')
  const email = emailFromIdToken(json.id_token)
  if (!email) throw new BadRequestError('Google did not confirm which email address was connected. Connect again.')
  const existing = await prisma.senderAccount.findUnique({ where: { email } })
  if (!json.refresh_token && !existing?.refreshTokenEnc) throw new BadRequestError('Google did not give a lasting permission. Remove this app at myaccount.google.com/permissions and connect again.')

  const tokenEnc = json.refresh_token ? seal(json.refresh_token) : existing!.refreshTokenEnc
  const account = existing
    ? await prisma.senderAccount.update({
        where: { id: existing.id },
        data: { refreshTokenEnc: tokenEnc, scopes: granted.join(' '), status: 'connected', statusReason: null, connectedByUserId: existing.status === 'disconnected' ? user.id : existing.connectedByUserId, connectedAt: now, lastCheckedAt: now },
      })
    : await prisma.senderAccount.create({
        data: {
          id: newId(),
          email,
          displayName: user.name,
          refreshTokenEnc: tokenEnc,
          scopes: granted.join(' '),
          status: 'connected',
          dailyLimit: env.DEFAULT_DAILY_LIMIT,
          connectedByUserId: user.id,
          connectedAt: now,
          lastCheckedAt: now,
        },
      })
  if (json.expires_in) ACCESS.set(account.id, { token: json.access_token, expiresAt: now.getTime() + (json.expires_in - 60) * 1000 })
  await audit({ userId: user.id, action: 'sender.connected', summary: `Gmail account ${email} ${existing ? 'reconnected' : 'connected'}` })
  return { account, userId: user.id }
}

// Access tokens live about an hour; they are kept in memory only, never stored.
const ACCESS = new Map<string, { token: string; expiresAt: number }>()

/** For tests and after a disconnect. */
export function forgetAccessTokens(id?: string) {
  if (id) ACCESS.delete(id)
  else ACCESS.clear()
}

/** A valid access token for the account (refreshed when needed). Throws AccountAuthError when the account must be reconnected. */
export async function accessToken(accountId: string, now = Date.now()): Promise<string> {
  const cached = ACCESS.get(accountId)
  if (cached && cached.expiresAt > now) return cached.token
  const acc = await prisma.senderAccount.findUnique({ where: { id: accountId } })
  if (!acc || acc.status === 'disconnected' || !acc.refreshTokenEnc) throw new AccountAuthError('This sender account is not connected.')
  let refresh: string
  try {
    refresh = open(acc.refreshTokenEnc)
  } catch {
    throw new AccountAuthError('The stored permission cannot be read (the encryption key changed). Reconnect the account.')
  }
  const { status, json } = await tokenRequest({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' })
  if (status === 200 && json.access_token) {
    ACCESS.set(accountId, { token: json.access_token, expiresAt: now + ((json.expires_in ?? 3600) - 60) * 1000 })
    return json.access_token
  }
  if (json.error === 'invalid_grant' || json.error === 'unauthorized_client' || status === 401) {
    await prisma.senderAccount.update({
      where: { id: accountId },
      data: { status: 'needs_reconnect', statusReason: 'Google no longer accepts the permission (it was removed, or the password changed). Reconnect the account.' },
    })
    throw new AccountAuthError('Google no longer accepts the permission for this account. Reconnect it.')
  }
  // Google unavailable: a temporary problem, the account stays as it is.
  throw new Error(`Google's sign-in service did not answer (${json.error ?? status}). Try again shortly.`)
}

/** Disconnects: the permission is revoked at Google (best effort) and the stored token is erased. */
export async function disconnect(user: Principal, accountId: string) {
  const acc = await prisma.senderAccount.findUnique({ where: { id: accountId } })
  if (!acc) throw new NotFoundError('Sender account not found.')
  if (user.role !== 'admin' && acc.connectedByUserId !== user.id) throw new ForbiddenError('Only the person who connected this account, or an admin, can disconnect it.')
  const active = await prisma.campaign.count({ where: { senderAccountId: accountId, status: { in: ['running', 'paused'] } } })
  if (active) throw new ConflictError('A campaign is still using this account. Cancel or finish it first.')
  if (acc.refreshTokenEnc) {
    try {
      const token = open(acc.refreshTokenEnc)
      await fetch(`${env.GOOGLE_REVOKE_URL}?${new URLSearchParams({ token })}`, { method: 'POST', signal: AbortSignal.timeout(10_000) })
    } catch (err) {
      log.warn('revoking a Gmail permission failed (the stored token is erased anyway)', { account: acc.email, err: String((err as Error).message).slice(0, 120) })
    }
  }
  await prisma.senderAccount.update({ where: { id: accountId }, data: { status: 'disconnected', statusReason: 'Disconnected.', refreshTokenEnc: '' } })
  forgetAccessTokens(accountId)
  await audit({ userId: user.id, action: 'sender.disconnected', summary: `Gmail account ${acc.email} disconnected` })
  return { id: accountId, status: 'disconnected' as const }
}
