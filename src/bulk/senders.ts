import { env, googleConfigured } from '../config/env.js'
import { newId, prisma } from '../platform/db.js'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../platform/errors.js'
import { seal } from '../platform/secretBox.js'
import { APP_PASSWORD, appPasswordOf, normalizeAppPassword, verifyAppPassword } from '../gmail/smtp.js'
import { strictEmail } from './extract.js'
import { audit } from '../platform/log.js'
import { accessToken, AccountAuthError, READONLY_SCOPE, SEND_SCOPE } from '../gmail/oauth.js'
import type { Principal } from '../auth/users.js'
import { prepareSignature } from './content.js'

// SENDER ACCOUNTS: which Gmail accounts are connected, who may use them, and whether
// one is ready to send (permission works, the send permission was given, the daily
// limit has room). A member may send from the accounts they connected and from shared
// ones; an admin from any.

type Account = Awaited<ReturnType<typeof prisma.senderAccount.findFirst>> & {}

/** Emails sent from an account in the last 24 hours (all campaigns of the current mode: test emails never use up the real limit). */
export async function sentLast24h(accountId: string, now = new Date()): Promise<number> {
  return prisma.recipient.count({
    where: { campaign: { senderAccountId: accountId, sendMode: env.SEND_MODE }, status: { in: ['sent', 'unknown', 'sending'] }, attemptedAt: { gte: new Date(now.getTime() - 24 * 3600_000) } },
  })
}

export const mayUse = (user: Principal, a: { connectedByUserId: string; shared: boolean }) => user.role === 'admin' || a.connectedByUserId === user.id || a.shared

export async function accountView(a: Account, now = new Date()) {
  const used = await sentLast24h(a.id, now)
  const scopes = a.scopes.split(/\s+/)
  const appPassword = a.authType === 'app_password'
  return {
    id: a.id,
    email: a.email,
    displayName: a.displayName,
    authType: a.authType,
    status: a.status,
    statusReason: a.statusReason,
    signatureHtml: a.signatureHtml,
    dailyLimit: a.dailyLimit,
    sentLast24h: used,
    remainingToday: Math.max(0, a.dailyLimit - used),
    shared: a.shared,
    connectedByUserId: a.connectedByUserId,
    connectedAt: a.connectedAt.toISOString(),
    lastCheckedAt: a.lastCheckedAt?.toISOString() ?? null,
    canSend: appPassword || scopes.includes(SEND_SCOPE),
    // Looking an email up in Sent needs Google's read permission; an app password cannot.
    canCheckSent: !appPassword && scopes.includes(READONLY_SCOPE),
  }
}

export async function listAccounts(user: Principal) {
  const all = await prisma.senderAccount.findMany({ where: { status: { not: 'disconnected' } }, orderBy: { email: 'asc' } })
  const out = []
  for (const a of all) out.push({ ...(await accountView(a)), usable: mayUse(user, a) })
  return { accounts: out, googleConfigured: googleConfigured(), sendMode: env.SEND_MODE }
}

export async function usableAccount(user: Principal, id: string) {
  const a = await prisma.senderAccount.findUnique({ where: { id } })
  if (!a || a.status === 'disconnected') throw new NotFoundError('Sender account not found. Connect it again.')
  if (!mayUse(user, a)) throw new ForbiddenError('You may not send from this account (it was connected by someone else and is not shared).')
  return a
}

/**
 * Whether the account can send right now, and why not. In live mode the permission is tried
 * (a fresh access token is requested from Google); in test mode nothing is contacted.
 */
export async function readiness(accountId: string, now = new Date()): Promise<{ ready: boolean; problems: string[]; remainingToday: number; dailyLimit: number }> {
  const a = await prisma.senderAccount.findUnique({ where: { id: accountId } })
  if (!a || a.status === 'disconnected') return { ready: false, problems: ['The account is not connected.'], remainingToday: 0, dailyLimit: 0 }
  const problems: string[] = []
  if (a.status === 'needs_reconnect') problems.push(a.statusReason ?? 'The account must be reconnected.')
  if (a.authType === 'oauth' && !a.scopes.split(/\s+/).includes(SEND_SCOPE)) problems.push('Permission to send email was not given. Reconnect and allow sending.')
  if (env.SEND_MODE === 'live' && !problems.length && a.authType === 'app_password') {
    // Signs in to Gmail's mail server and out again (no email is sent).
    const cred = await appPasswordOf(a.id)
    const v = cred ? await verifyAppPassword(cred.email, cred.password) : ({ ok: false, kind: 'auth', reason: 'The stored app password cannot be read. Update it.' } as const)
    if (v.ok) await prisma.senderAccount.update({ where: { id: a.id }, data: { lastCheckedAt: now } })
    else {
      problems.push(v.reason)
      if (v.kind === 'auth') await prisma.senderAccount.update({ where: { id: a.id }, data: { status: 'needs_reconnect', statusReason: v.reason } })
    }
  } else if (env.SEND_MODE === 'live' && !problems.length) {
    try {
      await accessToken(a.id)
      await prisma.senderAccount.update({ where: { id: a.id }, data: { lastCheckedAt: now } })
    } catch (err) {
      problems.push(err instanceof AccountAuthError ? err.message : `Google could not be reached to check the account: ${(err as Error).message}`)
    }
  }
  const used = await sentLast24h(a.id, now)
  const remainingToday = Math.max(0, a.dailyLimit - used)
  if (remainingToday === 0) problems.push(`The daily limit of ${a.dailyLimit} emails for this account has been reached; sending continues as the 24-hour window moves on.`)
  return { ready: problems.length === 0, problems, remainingToday, dailyLimit: a.dailyLimit }
}

/**
 * Adds a Gmail account that sends with an APP PASSWORD (Google account → Security → 2-Step
 * Verification → App passwords), or gives an existing one a new app password. The password is
 * checked by signing in to Gmail's mail server (no email is sent), then stored encrypted; it is
 * never shown again.
 */
export async function connectAppPassword(user: Principal, input: { email: string; appPassword: string; displayName?: string }, now = new Date()) {
  if (user.role === 'viewer') throw new ForbiddenError('Viewers cannot add a sender account.')
  const email = strictEmail(input.email)
  if (!email) throw new BadRequestError('Enter the full Gmail address of the account.')
  const password = normalizeAppPassword(input.appPassword)
  if (!APP_PASSWORD.test(password)) throw new BadRequestError('An app password is the 16 letters Google shows (spaces do not matter). It is not the account\'s normal password.')
  const existing = await prisma.senderAccount.findUnique({ where: { email } })
  if (existing && existing.status !== 'disconnected' && user.role !== 'admin' && existing.connectedByUserId !== user.id)
    throw new ForbiddenError('This account was added by someone else. Ask them, or an admin, to update it.')
  if (existing && existing.authType === 'oauth' && existing.status !== 'disconnected')
    throw new ConflictError('This account is connected with Google\'s sign-in already. Disconnect it first to use an app password instead.')
  const v = await verifyAppPassword(email, password)
  if (!v.ok) throw new BadRequestError(v.kind === 'auth' ? 'Gmail did not accept this app password for this address. Check both, or create a new app password.' : v.reason)
  const displayName = input.displayName === undefined ? undefined : input.displayName.trim().slice(0, 80) || null
  const data = { authType: 'app_password', refreshTokenEnc: seal(password), scopes: '', status: 'connected', statusReason: null, connectedAt: now, lastCheckedAt: now }
  const account = existing
    ? await prisma.senderAccount.update({ where: { id: existing.id }, data: { ...data, ...(displayName !== undefined ? { displayName } : {}), connectedByUserId: existing.status === 'disconnected' ? user.id : existing.connectedByUserId } })
    : await prisma.senderAccount.create({ data: { ...data, id: newId(), email, displayName: displayName ?? null, dailyLimit: env.DEFAULT_DAILY_LIMIT, connectedByUserId: user.id } })
  await audit({ userId: user.id, action: 'sender.connected', summary: `Gmail account ${email} ${existing ? 'given a new app password' : 'added with an app password'}` })
  return accountView(account, now)
}

export async function updateAccount(user: Principal, id: string, patch: { signatureHtml?: string; dailyLimit?: number; shared?: boolean; displayName?: string }) {
  const a = await prisma.senderAccount.findUnique({ where: { id } })
  if (!a || a.status === 'disconnected') throw new NotFoundError('Sender account not found.')
  if (user.role !== 'admin' && a.connectedByUserId !== user.id) throw new ForbiddenError('Only the person who connected this account, or an admin, can change it.')
  const data: Record<string, unknown> = {}
  let removed: string[] = []
  if (patch.signatureHtml !== undefined) {
    const sig = prepareSignature(patch.signatureHtml)
    data.signatureHtml = sig.html
    removed = sig.removed
  }
  if (patch.dailyLimit !== undefined) {
    const n = Math.round(Number(patch.dailyLimit))
    if (!Number.isFinite(n) || n < 1 || n > 2000) throw new BadRequestError('The daily limit must be between 1 and 2,000 (Google Workspace allows 2,000 a day; free Gmail 500).')
    data.dailyLimit = n
  }
  if (patch.shared !== undefined) {
    if (user.role !== 'admin') throw new ForbiddenError('Only an admin can share an account with the whole team.')
    data.shared = Boolean(patch.shared)
  }
  if (patch.displayName !== undefined) data.displayName = String(patch.displayName).trim().slice(0, 80) || null
  const updated = await prisma.senderAccount.update({ where: { id }, data })
  await audit({ userId: user.id, action: 'sender.updated', summary: `Sender ${a.email} settings changed (${Object.keys(data).join(', ')})` })
  return { ...(await accountView(updated)), signatureRemoved: removed }
}
