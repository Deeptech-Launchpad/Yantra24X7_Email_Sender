import { randomBytes } from 'node:crypto'
import { env } from '../config/env.js'
import { fromJson, prisma, toJson } from '../platform/db.js'
import { audit, log } from '../platform/log.js'
import { buildMime, makeMessageId, type OutgoingFile } from '../mail/mime.js'
import { transport } from '../mail/transport.js'
import { findSentByMessageId } from '../gmail/api.js'
import { companyFileKey, fileKey } from './companyZip.js'
import { inlineImages } from './content.js'
import { campaignCommonFiles, companyFileForSend } from './files.js'
import { sentLast24h } from './senders.js'
import { suppressedReason, suppressedSet } from './suppression.js'
import { addPixel, hashToken, newTrackingToken, trackingStatus } from './tracking.js'

// THE SENDER: runs every DISPATCH_TICK_SECONDS. For each sender account, only its oldest
// running campaign sends, one email at a time, at least `intervalMinutes` apart, never
// more than the account's daily limit in any 24 hours. A campaign sends only in the mode
// it was approved in (a test campaign never sends for real).
//
// Each email: claimed (scheduled → sending, only while its campaign is running) so no
// second sender can take it; checked against the do-not-email list again (its CC too); its files loaded and checked (common attachments
// exactly as approved, and its own company PDF, intact and named after ITS company);
// then handed to the transport. The answer decides what happens (see gmail/api.ts):
//   sent → sent;   invalid → failed (a person may retry);   quota or permission → not sent,
//   back to scheduled, the campaign pauses with the reason;   unknown → unknown, NEVER resent
//   automatically (looked up in Sent when allowed, otherwise a person checks and resolves).

const LEASE_MS = 120_000
const STUCK_MS = 15 * 60_000
const HOLDER = `${process.pid}-${randomBytes(4).toString('hex')}`

type Campaign = Awaited<ReturnType<typeof prisma.campaign.findFirst>> & {}
type Recipient = Awaited<ReturnType<typeof prisma.recipient.findFirst>> & {}

/** Only one sender loop runs at a time, even with two processes. */
async function takeLease(now: Date): Promise<boolean> {
  const until = new Date(now.getTime() + LEASE_MS)
  const r = await prisma.lease.updateMany({ where: { name: 'dispatcher', OR: [{ holder: HOLDER }, { expiresAt: { lt: now } }] }, data: { holder: HOLDER, expiresAt: until } })
  if (r.count === 1) return true
  try {
    await prisma.lease.create({ data: { name: 'dispatcher', holder: HOLDER, expiresAt: until } })
    return true
  } catch {
    return false
  }
}

export interface TickResult {
  sent: number
  failed: number
  unknown: number
  waiting: number
}

export async function dispatchTick(now = new Date()): Promise<TickResult> {
  const result: TickResult = { sent: 0, failed: 0, unknown: 0, waiting: 0 }
  if (!(await takeLease(now))) return result
  await recoverStuck(now)
  const campaigns = await prisma.campaign.findMany({ where: { status: 'running' }, orderBy: { createdAt: 'asc' } })
  const turn = new Set<string>()
  for (const c of campaigns) {
    if (turn.has(c.senderAccountId)) continue // one campaign at a time per account
    turn.add(c.senderAccountId)
    try {
      const outcome = await dispatchCampaign(c, now)
      if (outcome) result[outcome]++
      await completeIfDone(c.id, now)
    } catch (err) {
      log.error('dispatch: a campaign could not be processed; it is tried again next time', { campaignId: c.id, err: String((err as Error).message ?? err).slice(0, 300) })
    }
  }
  if (env.GMAIL_READONLY_CHECK) await reconcileUnknown(now)
  return result
}

/** An email left "sending" by a crash: never handed over → back in the queue; handed over → unknown (never resent). */
async function recoverStuck(now: Date) {
  const stuck = await prisma.recipient.findMany({ where: { status: 'sending', updatedAt: { lt: new Date(now.getTime() - STUCK_MS) } }, select: { id: true, campaignId: true, attemptedAt: true, messageIdHeader: true } })
  for (const r of stuck) {
    if (r.attemptedAt && r.messageIdHeader) {
      await prisma.recipient.updateMany({ where: { id: r.id, status: 'sending' }, data: { status: 'unknown', reason: 'The app stopped while this email was being sent. It may have been sent — it is not sent again automatically. Check the Sent folder.' } })
    } else {
      await release(r.campaignId, r.id)
    }
  }
}

/** A claimed email that was NOT handed over goes back in the queue — or, when its campaign was cancelled meanwhile, is cancelled too. */
async function release(campaignId: string, recipientId: string, reason?: string) {
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } })
  const requeue = c?.status === 'running' || c?.status === 'paused'
  const clear = { attemptedAt: null, messageIdHeader: null, trackingTokenHash: null, trackingEnabled: false }
  await prisma.recipient.updateMany({
    where: { id: recipientId, status: 'sending' },
    data: requeue ? { status: 'scheduled', ...clear, ...(reason ? { reason } : {}) } : { status: 'cancelled', ...clear, reason: 'Cancelled before it was sent.' },
  })
}

async function completeIfDone(campaignId: string, now: Date) {
  const open = await prisma.recipient.count({ where: { campaignId, status: { in: ['scheduled', 'sending'] } } })
  if (open === 0) {
    const r = await prisma.campaign.updateMany({ where: { id: campaignId, status: 'running' }, data: { status: 'completed', statusReason: null, completedAt: now } })
    if (r.count) await audit({ campaignId, action: 'campaign.completed', summary: 'Campaign completed' })
  }
}

async function dispatchCampaign(c: Campaign, now: Date): Promise<keyof TickResult | null> {
  if (c.sendMode !== env.SEND_MODE) {
    await pause(c, `Paused — this campaign was approved in ${c.sendMode} mode and the app now runs in ${env.SEND_MODE} mode, so nothing is sent.`)
    return null
  }
  // Spacing: at least intervalMinutes since this campaign's last attempt (a few seconds of slack).
  const last = await prisma.recipient.findFirst({ where: { campaignId: c.id, attemptedAt: { not: null } }, orderBy: { attemptedAt: 'desc' }, select: { attemptedAt: true } })
  if (last?.attemptedAt && now.getTime() - last.attemptedAt.getTime() < c.intervalMinutes * 60_000 - 5_000) return null
  const next = await prisma.recipient.findFirst({ where: { campaignId: c.id, status: 'scheduled', scheduledAt: { lte: now } }, orderBy: [{ scheduledAt: 'asc' }, { position: 'asc' }] })
  if (!next) return null
  const account = await prisma.senderAccount.findUnique({ where: { id: c.senderAccountId } })
  if (!account || account.status !== 'connected') {
    await pause(c, `Paused — the sender account ${c.fromEmail} must be reconnected.${account?.statusReason ? ` ${account.statusReason}` : ''}`)
    return null
  }
  if ((await sentLast24h(account.id, now)) >= account.dailyLimit) {
    await prisma.campaign.update({ where: { id: c.id }, data: { statusReason: `Waiting — ${c.fromEmail} has sent its daily limit of ${account.dailyLimit} emails in the last 24 hours; sending continues as the limit allows.` } })
    return 'waiting'
  }
  if (c.statusReason?.startsWith('Waiting')) await prisma.campaign.update({ where: { id: c.id }, data: { statusReason: null } })
  return sendOne(c, next, now)
}

async function pause(c: Campaign, reason: string) {
  await prisma.campaign.updateMany({ where: { id: c.id, status: 'running' }, data: { status: 'paused', statusReason: reason } })
  await audit({ campaignId: c.id, action: 'campaign.paused', summary: `Campaign "${c.name}" paused: ${reason}` })
}

async function fail(r: Recipient, reason: string): Promise<'failed'> {
  await prisma.recipient.update({ where: { id: r.id }, data: { status: 'failed', reason } })
  return 'failed'
}

async function sendOne(c: Campaign, r: Recipient, now: Date): Promise<keyof TickResult | null> {
  // Claimed first (and only while the campaign is still running): two senders can never send the same email.
  const claim = await prisma.recipient.updateMany({ where: { id: r.id, status: 'scheduled', campaign: { status: 'running' } }, data: { status: 'sending' } })
  if (claim.count !== 1) return null

  // Re-checked at the moment of sending: someone may have been added to the do-not-email list since.
  const sup = await suppressedReason(r.toEmail)
  if (sup || !r.toEmail || !r.subject || !r.bodyHtml || !r.bodyText) {
    await prisma.recipient.update({ where: { id: r.id }, data: { status: 'skipped', category: 'excluded', reason: sup ?? 'Nothing to send.' } })
    return null
  }

  // The files, exactly as approved — or the email does not go.
  const files: OutgoingFile[] = []
  if (r.companyFileId) {
    const own = await companyFileForSend(c.id, r.companyFileId)
    if (!own || fileKey(own.filename) !== companyFileKey(r.companyName)) return fail(r, 'Its company PDF could not be verified, so it was not sent.')
    files.push(own)
  }
  if (c.attachmentCount > 0) {
    const common = await campaignCommonFiles(c.id)
    if (!common || common.length !== c.attachmentCount) return fail(r, 'Its attachments could not be loaded (missing or changed), so it was not sent.')
    files.push(...common)
  }

  // Embedded signature pictures travel as inline images; the open-tracking image only when tracking is set up.
  const inline = inlineImages(r.bodyHtml)
  let html = inline.html
  let trackingHash: string | null = null
  if (trackingStatus().enabled) {
    const token = newTrackingToken()
    trackingHash = hashToken(token)
    html = addPixel(html, token)
  }
  // A CC address put on the do-not-email list since the review is left out (and the record says who really got it).
  const ccApproved = fromJson<string[]>(r.ccJson, [])
  const ccBlocked = await suppressedSet(ccApproved)
  const cc = ccApproved.filter((e) => !ccBlocked.has(e))
  if (cc.length !== ccApproved.length) await prisma.recipient.update({ where: { id: r.id }, data: { ccJson: toJson(cc) } })

  const messageId = makeMessageId(r.id, c.fromEmail, randomBytes(8).toString('hex'))
  let mime: Buffer
  try {
    mime = await buildMime({
      from: c.fromEmail,
      fromName: c.fromName,
      to: r.toEmail,
      cc,
      subject: r.subject,
      html,
      text: r.bodyText,
      attachments: [...files, ...inline.images.map((i) => ({ filename: i.filename, contentType: i.contentType, content: i.content, cid: i.cid }))],
      messageId,
      listUnsubscribeMailto: env.LIST_UNSUBSCRIBE_MAILTO,
    })
  } catch (err) {
    return fail(r, `The email could not be put together: ${String((err as Error).message).slice(0, 200)}`)
  }

  // Paused or cancelled while this email was being prepared: it is not handed over.
  const still = await prisma.campaign.findUnique({ where: { id: c.id }, select: { status: true } })
  if (still?.status !== 'running') {
    await release(c.id, r.id)
    return null
  }

  // Recorded BEFORE handing it over, so its outcome can always be looked up.
  await prisma.recipient.update({ where: { id: r.id }, data: { attemptedAt: now, attempts: { increment: 1 }, messageIdHeader: messageId, trackingTokenHash: trackingHash, trackingEnabled: Boolean(trackingHash) } })
  let res
  try {
    res = await transport().send({ accountId: c.senderAccountId, recipientId: r.id, mime })
  } catch (err) {
    res = { outcome: 'unknown' as const, reason: `Sending stopped unexpectedly (${String((err as Error).message).slice(0, 200)}). It may have been sent — it is not sent again automatically.` }
  }

  if (res.outcome === 'sent') {
    await prisma.recipient.update({ where: { id: r.id }, data: { status: 'sent', sentAt: now, gmailMessageId: res.gmailId, gmailThreadId: res.threadId, reason: null } })
    return 'sent'
  }
  if (res.outcome === 'unknown') {
    await prisma.recipient.update({ where: { id: r.id }, data: { status: 'unknown', reason: res.reason } })
    log.warn('an email has an unknown outcome; it is not sent again', { campaignId: c.id, recipientId: r.id })
    return 'unknown'
  }
  if (res.kind === 'invalid') return fail(r, res.reason)
  // Quota or permission: certainly not sent. It goes back in the queue; the campaign pauses with the reason.
  await release(c.id, r.id, res.reason)
  if (res.kind === 'auth') {
    await prisma.senderAccount.updateMany({ where: { id: c.senderAccountId, status: 'connected' }, data: { status: 'needs_reconnect', statusReason: res.reason } })
    await pause(c, `Paused — ${res.reason}`)
  } else {
    await pause(c, `Paused — ${res.reason} Nothing was lost: resume later (for example tomorrow) and it continues where it stopped.`)
  }
  return 'waiting'
}

/** Unknown outcomes looked up in the sender's Sent folder (only with GMAIL_READONLY_CHECK). Found → sent; not found → stays unknown. */
async function reconcileUnknown(now: Date) {
  const rows = await prisma.recipient.findMany({
    where: { status: 'unknown', messageIdHeader: { not: null }, attemptedAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
    include: { campaign: { select: { senderAccountId: true } } },
    take: 10,
  })
  for (const r of rows) {
    const found = await findSentByMessageId(r.campaign.senderAccountId, r.messageIdHeader!)
    if (found.result === 'found') {
      await prisma.recipient.update({ where: { id: r.id }, data: { status: 'sent', sentAt: r.attemptedAt ?? now, gmailMessageId: found.gmailId ?? null, gmailThreadId: found.threadId ?? null, reason: 'Found in the Sent folder.' } })
    }
  }
}

let timer: NodeJS.Timeout | null = null

export function startDispatcher() {
  if (timer) return
  const run = () => {
    dispatchTick().catch((err) => log.error('dispatch tick failed', { err: String((err as Error).message ?? err).slice(0, 300) }))
  }
  timer = setInterval(run, env.DISPATCH_TICK_SECONDS * 1000)
  timer.unref()
  run()
  log.info('sender started', { mode: env.SEND_MODE, everySeconds: env.DISPATCH_TICK_SECONDS })
}

export function stopDispatcher() {
  if (timer) clearInterval(timer)
  timer = null
}
