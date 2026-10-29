import { env } from '../config/env.js'
import { fromJson, newId, prisma, toJson } from '../platform/db.js'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../platform/errors.js'
import { audit } from '../platform/log.js'
import type { Principal } from '../auth/users.js'
import { extractFile } from './companyZip.js'
import { campaignFileInfos, discardCampaignFiles, discardFiles, dropStagedZip, linkFiles, storeCompanyFile, withStagedZip } from './files.js'
import { prepareReview, type CampaignSetup } from './review.js'
import { fmtLocal, planSequential } from './schedule.js'
import { readiness } from './senders.js'
import { trackingStatus } from './tracking.js'
import { findSentByMessageId } from '../gmail/api.js'

// CAMPAIGNS: approval and start, the list, one campaign in detail, pause / resume /
// cancel, retrying failed emails, resolving emails whose outcome is unknown, and the
// recipient report (CSV). Every campaign and its history belong to this app only.
//
// Safety rules (from the Marketing AI Agent's Bulk Email):
//   - Nothing starts without the explicit confirmation, and Start re-checks everything.
//   - One campaign at a time per sender account.
//   - Each email is claimed before it is sent, so it can never go twice.
//   - An email whose outcome is unknown is NEVER sent again automatically.
//   - Only a definite refusal ("failed") may be retried, by a person.

/** Problems that stop a campaign from sending (the daily limit only makes it wait). */
async function blockingSenderProblems(accountId: string, now: Date): Promise<string[]> {
  const r = await readiness(accountId, now)
  return r.problems.filter((p) => !/daily limit/i.test(p))
}

async function assertAccountFree(accountId: string, exceptId?: string) {
  const busy = await prisma.campaign.findFirst({ where: { senderAccountId: accountId, status: { in: ['running', 'paused'] }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { name: true, status: true } })
  if (busy) throw new ConflictError(`"${busy.name}" is still ${busy.status} on this sender account. One campaign at a time per account: finish or cancel it first.`)
}

export async function startCampaign(user: Principal, s: CampaignSetup & { confirm?: boolean; reviewFingerprint?: string }, now = new Date()) {
  if (s.confirm !== true) throw new BadRequestError('Tick the confirmation that you reviewed every email of this campaign.')
  const review = await prepareReview(user, s, now)
  if (!s.reviewFingerprint || s.reviewFingerprint !== review.fingerprint)
    throw new ConflictError('Not started — something changed since your review (the recipients, an email, a file or the sender). Review the campaign again, then approve it.')
  const problems = await blockingSenderProblems(review.sender.id, now)
  if (problems.length) throw new ConflictError(`Not started — ${problems.join(' ')}`)
  await assertAccountFree(review.sender.id)
  if (review.counts.blocked > 0) throw new ConflictError(`Not started — ${review.blockedProblem}`)
  const ready = review.rows.filter((r) => r.status === 'ready')
  if (!ready.length) throw new ConflictError('Nothing can be sent from this file — see the reason against each recipient.')

  // Each matched company PDF is stored FIRST (read from the ZIP again and checked against the review), so the campaign
  // is never live while its files are still being stored.
  const fileIds = new Map<number, string>()
  try {
    if (s.companyZipId && review.companyFiles.size) {
      await withStagedZip(s.companyZipId, async (src) => {
        for (const [position, file] of review.companyFiles) fileIds.set(position, await storeCompanyFile(user, file, await extractFile(src, file)))
      })
    }
  } catch (err) {
    await discardFiles([...fileIds.values()])
    throw err
  }

  const id = newId()
  const name = (s.name ?? '').trim().slice(0, 120) || `${review.excel.fileName.replace(/\.xlsx$/i, '')} — ${fmtLocal(now).replace(/, \d{1,2}:\d{2}\s[AP]M.*$/, '')}`
  let created = false
  try {
    await prisma.campaign.create({
      data: {
        id,
        name,
        status: 'running',
        sendMode: env.SEND_MODE,
        senderAccountId: review.sender.id,
        fromEmail: review.sender.email,
        fromName: review.sender.displayName,
        templateMode: review.templateOrder ?? 'single',
        templatesJson: toJson(review.setup.templates.map((t) => ({ subject: t.subject, html: t.html }))),
        ccJson: toJson(review.cc),
        copyColleagues: review.copyColleagues,
        intervalMinutes: review.setup.intervalMinutes,
        startAt: review.setup.start,
        timezone: env.APP_TIMEZONE,
        attachmentCount: review.attachments.length,
        companyZipName: review.companyZip?.fileName ?? null,
        sourceFileName: review.excel.fileName,
        totalRows: review.counts.rowsWithCompany,
        eligibleCount: review.counts.eligible,
        invalidCount: review.counts.invalid,
        duplicateCount: review.counts.duplicate,
        excludedCount: review.counts.excluded,
        createdByUserId: user.id,
        approvedByUserId: user.id,
        approvedAt: now,
      },
    })
    created = true
    await linkFiles(review.attachments.map((a) => a.id), id)
    await linkFiles([review.excel.id], id)
    await linkFiles([...fileIds.values()], id)
    await prisma.recipient.createMany({
      data: review.rows.map((r) => ({
        id: newId(),
        campaignId: id,
        position: r.position,
        companyName: r.companyName,
        contactName: r.contactName,
        toEmail: r.toEmail,
        ccJson: toJson(r.ccEmails),
        sourceRowsJson: toJson(r.rows),
        subject: r.subject,
        bodyText: r.status === 'ready' ? r.text : null,
        bodyHtml: r.status === 'ready' ? r.html : null,
        templateNumber: r.templateNumber,
        companyFileId: fileIds.get(r.position) ?? null,
        status: r.status === 'ready' ? 'scheduled' : 'skipped',
        category: r.category,
        reason: r.reason,
        scheduledAt: r.scheduledAt ? new Date(r.scheduledAt) : null,
      })),
    })
  } catch (err) {
    await discardFiles([...fileIds.values()]).catch(() => undefined)
    if (created) {
      await prisma.recipient.deleteMany({ where: { campaignId: id } }).catch(() => undefined)
      await discardCampaignFiles(id).catch(() => undefined)
      await prisma.campaign.update({ where: { id }, data: { status: 'cancelled', statusReason: 'It could not be started; nothing was sent.', completedAt: new Date() } }).catch(() => undefined)
    }
    throw err
  }
  if (s.companyZipId) await dropStagedZip(s.companyZipId).catch(() => undefined)
  await audit({
    userId: user.id,
    campaignId: id,
    action: 'campaign.started',
    summary: `Campaign "${name}" approved by ${user.email}: ${ready.length} emails from ${review.sender.email} (${env.SEND_MODE} mode), first ${review.schedule.firstLocal}, ${review.setup.intervalMinutes} min apart; ${review.counts.invalid} invalid, ${review.counts.duplicate} duplicate, ${review.counts.excluded} excluded${review.attachments.length ? `; attachments: ${review.attachments.map((a) => a.fileName).join(', ')}` : ''}${review.companyZip ? `; company PDFs from ${review.companyZip.fileName}: ${fileIds.size}` : ''}`,
  })
  return { campaignId: id, scheduled: ready.length }
}

// ── Reading ────────────────────────────────────────────────────────────────

async function countsOf(campaignId: string) {
  const groups = await prisma.recipient.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } })
  const n = (st: string) => groups.find((g) => g.status === st)?._count._all ?? 0
  const cats = await prisma.recipient.groupBy({ by: ['category'], where: { campaignId, status: 'skipped' }, _count: { _all: true } })
  const c = (cat: string) => cats.find((g) => g.category === cat)?._count._all ?? 0
  const opened = await prisma.recipient.count({ where: { campaignId, status: 'sent', openCount: { gt: 0 } } })
  const tracked = await prisma.recipient.count({ where: { campaignId, status: 'sent', trackingEnabled: true } })
  return {
    scheduled: n('scheduled'),
    sending: n('sending'),
    sent: n('sent'),
    failed: n('failed'),
    unknown: n('unknown'),
    skipped: n('skipped'),
    cancelled: n('cancelled'),
    skippedInvalid: c('invalid'),
    skippedDuplicate: c('duplicate'),
    skippedExcluded: c('excluded'),
    total: groups.reduce((s, g) => s + g._count._all, 0),
    opens: { tracked, opened },
  }
}

const campaignRow = (c: Awaited<ReturnType<typeof prisma.campaign.findFirst>> & {}) => ({
  id: c.id,
  name: c.name,
  status: c.status,
  statusReason: c.statusReason,
  sendMode: c.sendMode,
  fromEmail: c.fromEmail,
  templateMode: c.templateMode,
  cc: fromJson<string[]>(c.ccJson, []),
  copyColleagues: c.copyColleagues,
  intervalMinutes: c.intervalMinutes,
  startLocal: fmtLocal(c.startAt, c.timezone),
  approvedAt: c.approvedAt.toISOString(),
  approvedByUserId: c.approvedByUserId,
  createdByUserId: c.createdByUserId,
  completedAt: c.completedAt?.toISOString() ?? null,
  sourceFileName: c.sourceFileName,
  companyZipName: c.companyZipName,
  review: { totalRows: c.totalRows, eligible: c.eligibleCount, invalid: c.invalidCount, duplicate: c.duplicateCount, excluded: c.excludedCount },
})

export async function listCampaigns() {
  const rows = await prisma.campaign.findMany({ orderBy: { createdAt: 'desc' }, take: 200 })
  const out = []
  for (const c of rows) out.push({ ...campaignRow(c), counts: await countsOf(c.id) })
  return { campaigns: out, sendMode: env.SEND_MODE, tracking: trackingStatus() }
}

export async function getCampaign(id: string) {
  const c = await prisma.campaign.findUnique({ where: { id } })
  if (!c) throw new NotFoundError('Campaign not found.')
  return c
}

export async function campaignView(id: string) {
  const c = await getCampaign(id)
  const recipients = await prisma.recipient.findMany({ where: { campaignId: id }, orderBy: { position: 'asc' } })
  const files = await campaignFileInfos(id)
  const next = await prisma.recipient.findFirst({ where: { campaignId: id, status: 'scheduled' }, orderBy: { scheduledAt: 'desc' }, select: { scheduledAt: true } })
  return {
    campaign: { ...campaignRow(c), templates: fromJson<Array<{ subject: string }>>(c.templatesJson, []).map((t, i) => ({ number: i + 1, subject: t.subject })), lastScheduledLocal: next?.scheduledAt ? fmtLocal(next.scheduledAt, c.timezone) : null },
    counts: await countsOf(id),
    attachments: files.common,
    recipients: recipients.map((r) => ({
      id: r.id,
      position: r.position,
      companyName: r.companyName,
      contactName: r.contactName,
      toEmail: r.toEmail,
      cc: fromJson<string[]>(r.ccJson, []),
      status: r.status,
      category: r.category,
      reason: r.reason,
      subject: r.subject,
      templateNumber: r.templateNumber,
      companyFile: r.companyFileId ? (files.companyFiles.get(r.companyFileId) ?? null) : null,
      attempts: r.attempts,
      scheduledLocal: r.scheduledAt ? fmtLocal(r.scheduledAt, c.timezone) : null,
      sentLocal: r.sentAt ? fmtLocal(r.sentAt, c.timezone) : null,
      gmailMessageId: r.gmailMessageId,
      openCount: r.openCount,
      firstOpenedLocal: r.firstOpenedAt ? fmtLocal(r.firstOpenedAt, c.timezone) : null,
      trackingEnabled: r.trackingEnabled,
    })),
    sendMode: env.SEND_MODE,
    tracking: trackingStatus(),
    canCheckSent: env.GMAIL_READONLY_CHECK,
  }
}

/** One email exactly as it was approved (for the screen's preview). */
export async function recipientEmail(id: string, recipientId: string) {
  const r = await prisma.recipient.findFirst({ where: { id: recipientId, campaignId: id } })
  if (!r) throw new NotFoundError('Recipient not found.')
  return { id: r.id, toEmail: r.toEmail, cc: fromJson<string[]>(r.ccJson, []), subject: r.subject, html: r.bodyHtml, text: r.bodyText, status: r.status, reason: r.reason }
}

// ── Controls ───────────────────────────────────────────────────────────────

/** A campaign the person may control: one they started, or any for an admin. */
async function controlledCampaign(user: Principal, id: string) {
  const c = await getCampaign(id)
  if (user.role !== 'admin' && c.createdByUserId !== user.id) throw new ForbiddenError('Only the person who started this campaign, or an admin, can change it.')
  return c
}

/** A campaign approved in the other mode cannot be resumed or retried here (a test campaign never sends for real). */
function assertSameMode(c: { sendMode: string }) {
  if (c.sendMode !== env.SEND_MODE) throw new ConflictError(`This campaign was approved in ${c.sendMode} mode and the app now runs in ${env.SEND_MODE} mode, so it cannot send. Start a new campaign instead.`)
}

export async function setCampaignState(user: Principal, id: string, to: 'pause' | 'resume' | 'cancel', now = new Date()) {
  const c = await controlledCampaign(user, id)
  if (c.status === 'completed' || c.status === 'cancelled') throw new ConflictError(`This campaign is already ${c.status}.`)
  if (to === 'pause') {
    await prisma.campaign.update({ where: { id }, data: { status: 'paused', statusReason: `Paused by ${user.email}.` } })
    await audit({ userId: user.id, campaignId: id, action: 'campaign.paused', summary: `Campaign "${c.name}" paused` })
    return { id, status: 'paused' }
  }
  if (to === 'resume') {
    assertSameMode(c)
    const problems = await blockingSenderProblems(c.senderAccountId, now)
    if (problems.length) throw new ConflictError(`Not resumed — ${problems.join(' ')}`)
    await assertAccountFree(c.senderAccountId, id)
    // The rest are re-timed one interval apart, so a long pause never ends in a burst — from now, or from the
    // first planned time when the campaign has not reached it yet (a resume never brings a start forward).
    const remaining = await prisma.recipient.findMany({ where: { campaignId: id, status: 'scheduled' }, orderBy: [{ scheduledAt: 'asc' }, { position: 'asc' }], select: { id: true, scheduledAt: true } })
    const first = remaining[0]?.scheduledAt
    const slots = planSequential(first && first > now ? first : now, remaining.length, c.intervalMinutes)
    for (const [i, r] of remaining.entries()) await prisma.recipient.update({ where: { id: r.id }, data: { scheduledAt: slots[i] } })
    await prisma.campaign.update({ where: { id }, data: { status: 'running', statusReason: null } })
    await audit({ userId: user.id, campaignId: id, action: 'campaign.resumed', summary: `Campaign "${c.name}" resumed; ${remaining.length} emails re-timed` })
    return { id, status: 'running' }
  }
  const cancelled = await prisma.recipient.updateMany({ where: { campaignId: id, status: 'scheduled' }, data: { status: 'cancelled', reason: `Cancelled by ${user.email} before it was sent.` } })
  await prisma.campaign.update({ where: { id }, data: { status: 'cancelled', statusReason: `Cancelled by ${user.email}.`, completedAt: now } })
  await audit({ userId: user.id, campaignId: id, action: 'campaign.cancelled', summary: `Campaign "${c.name}" cancelled; ${cancelled.count} emails not sent` })
  return { id, status: 'cancelled' }
}

/** Sends failed emails again (only failed: they were certainly not sent). */
export async function retryFailed(user: Principal, id: string, recipientIds: string[] | undefined, now = new Date()) {
  const c = await controlledCampaign(user, id)
  if (c.status === 'cancelled') throw new ConflictError('This campaign was cancelled.')
  assertSameMode(c)
  const problems = await blockingSenderProblems(c.senderAccountId, now)
  if (problems.length) throw new ConflictError(`Not retried — ${problems.join(' ')}`)
  await assertAccountFree(c.senderAccountId, id)
  const failed = await prisma.recipient.findMany({
    where: { campaignId: id, status: 'failed', ...(recipientIds?.length ? { id: { in: recipientIds } } : {}) },
    orderBy: { position: 'asc' },
  })
  if (!failed.length) throw new BadRequestError('There are no failed emails to retry (only failed emails can be retried; an email with an unknown outcome must be resolved first).')
  // Never twice: an address that has since received this same email elsewhere is not retried.
  const ok: typeof failed = []
  for (const r of failed) {
    const already = await prisma.recipient.findFirst({ where: { toEmail: r.toEmail, status: { in: ['sent', 'unknown', 'scheduled', 'sending'] }, subject: r.subject, bodyText: r.bodyText, id: { not: r.id }, campaign: { sendMode: c.sendMode } } })
    if (!already) ok.push(r)
  }
  if (!ok.length) throw new ConflictError('These addresses already have this email (or it is queued); nothing to retry.')
  const lastScheduled = await prisma.recipient.findFirst({ where: { campaignId: id, status: 'scheduled' }, orderBy: { scheduledAt: 'desc' }, select: { scheduledAt: true } })
  const from = lastScheduled?.scheduledAt && lastScheduled.scheduledAt > now ? new Date(lastScheduled.scheduledAt.getTime() + c.intervalMinutes * 60_000) : now
  const slots = planSequential(from, ok.length, c.intervalMinutes)
  for (const [i, r] of ok.entries()) await prisma.recipient.update({ where: { id: r.id }, data: { status: 'scheduled', scheduledAt: slots[i], reason: `Retry requested by ${user.email}.` } })
  await prisma.campaign.update({ where: { id }, data: { status: 'running', statusReason: null, completedAt: null } })
  await audit({ userId: user.id, campaignId: id, action: 'campaign.retry', summary: `${ok.length} failed emails of "${c.name}" scheduled again` })
  return { id, retried: ok.length, skipped: failed.length - ok.length }
}

/** A person has checked the sender's Sent folder for an email whose outcome was unknown. */
export async function resolveUnknown(user: Principal, id: string, recipientId: string, outcome: 'sent' | 'not_sent') {
  await controlledCampaign(user, id)
  const r = await prisma.recipient.findFirst({ where: { id: recipientId, campaignId: id } })
  if (!r) throw new NotFoundError('Recipient not found.')
  if (r.status !== 'unknown') throw new ConflictError('Only an email whose outcome is unknown can be resolved.')
  if (outcome === 'sent') {
    await prisma.recipient.update({ where: { id: r.id }, data: { status: 'sent', sentAt: r.attemptedAt ?? new Date(), reason: `Marked as sent by ${user.email} after checking the Sent folder.` } })
  } else {
    await prisma.recipient.update({ where: { id: r.id }, data: { status: 'failed', reason: `Marked as NOT sent by ${user.email} after checking the Sent folder; it may be retried.` } })
  }
  await audit({ userId: user.id, campaignId: id, action: 'recipient.resolved', summary: `Outcome of the email to ${r.toEmail} set to "${outcome}" by ${user.email}` })
  return { id: r.id, status: outcome === 'sent' ? 'sent' : 'failed' }
}

/** Looks up unknown outcomes in the sender's Sent folder (only with GMAIL_READONLY_CHECK). Found → sent. Not found → stays unknown. */
export async function reconcileCampaign(user: Principal, id: string) {
  const c = await controlledCampaign(user, id)
  if (!env.GMAIL_READONLY_CHECK) throw new ConflictError('Looking up emails in Sent is not switched on (GMAIL_READONLY_CHECK). Check the Sent folder and resolve each email by hand.')
  const unknown = await prisma.recipient.findMany({ where: { campaignId: id, status: 'unknown', messageIdHeader: { not: null } }, take: 100 })
  let found = 0
  for (const r of unknown) {
    const res = await findSentByMessageId(c.senderAccountId, r.messageIdHeader!)
    if (res.result === 'found') {
      found++
      await prisma.recipient.update({ where: { id: r.id }, data: { status: 'sent', sentAt: r.attemptedAt ?? new Date(), gmailMessageId: res.gmailId ?? null, gmailThreadId: res.threadId ?? null, reason: 'Found in the Sent folder.' } })
    }
  }
  return { checked: unknown.length, found }
}

// ── Report ─────────────────────────────────────────────────────────────────

/** A cell that a spreadsheet cannot run as a formula. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function campaignReportCsv(id: string): Promise<{ fileName: string; csv: string }> {
  const v = await campaignView(id)
  const head = ['Row', 'Company', 'Contact', 'To', 'CC', 'Status', 'Category', 'Reason', 'Template', 'Subject', 'Company PDF', 'Scheduled', 'Sent', 'Attempts', 'Gmail message id', 'Opens', 'First opened']
  const lines = [head.map(csvCell).join(',')]
  for (const r of v.recipients) {
    lines.push(
      [r.position + 1, r.companyName, r.contactName, r.toEmail, r.cc.join('; '), r.status, r.category, r.reason, r.templateNumber, r.subject, r.companyFile?.fileName, r.scheduledLocal, r.sentLocal, r.attempts, r.gmailMessageId, r.trackingEnabled ? r.openCount : '', r.firstOpenedLocal]
        .map(csvCell)
        .join(','),
    )
  }
  const safeName = v.campaign.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 60) || 'campaign'
  // A byte-order mark so Excel reads the file as UTF-8.
  return { fileName: `${safeName} - report.csv`, csv: `﻿${lines.join('\r\n')}\r\n` }
}

export function requireSender(user: Principal) {
  if (user.role === 'viewer') throw new ForbiddenError('Viewers cannot change campaigns.')
}
