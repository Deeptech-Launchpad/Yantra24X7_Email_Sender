import { createHash } from 'node:crypto'
import { env } from '../config/env.js'
import { prisma } from '../platform/db.js'
import { BadRequestError, ConflictError } from '../platform/errors.js'
import type { Principal } from '../auth/users.js'
import { checkMatchedTotal, matchCompanyFiles, type CompanyMatch, type ZipFile, type ZipScan } from './companyZip.js'
import { composeEmail, MAX_TEMPLATES_PER_CAMPAIGN, pickTemplate, prepareTemplate, type PreparedTemplate, type TemplateOrder } from './content.js'
import { readSpreadsheet } from './excel.js'
import { extractContacts, greetingName, perPerson, recipientsOf, strictEmail, type Extraction } from './extract.js'
import { MAX_COMMON_FILES, MAX_EMAIL_ATTACHMENT_BYTES, readStaged, scanStagedZip, stagedCommon, stagedZipInfo, type FileInfo, type StagedZip } from './files.js'
import { fmtLocal, localToUtc, planSequential } from './schedule.js'
import { trackingStatus } from './tracking.js'
import { readiness, usableAccount } from './senders.js'
import { suppressedSet } from './suppression.js'

// THE REVIEW: from the uploaded Excel and the choices made on the screen to the exact
// email every recipient gets — and, for each one that is not sent, the reason. Nothing is
// written here; Start runs the same review again and stores exactly what it shows.
// (Workflow adapted from the Marketing AI Agent's Bulk Email, 2026-10-29.)
//
// One email per company: the first named person is the recipient, colleagues are copied
// (when "copy colleagues" is on), plus the campaign's own CC addresses. A recipient is
//   ready     — will be sent;
//   skipped   — not sent, with a category: invalid (cannot be personalised), duplicate
//               (the address is already in this campaign) or excluded (Status column,
//               do-not-email list, already queued, already sent the same email, outcome
//               unknown, excluded by hand, or no company PDF and "exclude" chosen);
//   blocked   — its company PDF is missing, ambiguous, damaged or too large: the campaign
//               cannot start until the ZIP is corrected or these recipients are excluded.

export const MAX_RECIPIENTS = 5000
export const MAX_CC = 10

export type RecipientMode = 'company' | 'person'

export interface CampaignSetup {
  excelFileId: string
  allowWebmail?: boolean
  /** The worksheet to read (default: the first with an email heading). */
  sheet?: string
  /**
   * Several worksheets in ONE campaign, each with its OWN template: sheets[i] is sent with templates[i]
   * (for example "Mailer 1" → template 1, "Mailer 2" → template 2). Replaces `sheet` and the rotation.
   */
  sheets?: string[]
  /** One email per company (colleagues copied; the default) or one per person. */
  onePer?: RecipientMode
  /** Where replies go, when not to the sender. */
  replyTo?: string
  /** Detect whether each email is opened (needs open tracking to be set up on the server). */
  trackOpens?: boolean
  senderAccountId: string
  /** 1-3 templates: a saved one (templateId) or written here (subject + bodyHtml). */
  templates: Array<{ templateId?: string; subject?: string; bodyHtml?: string }>
  templateOrder?: TemplateOrder
  shuffleSeed?: number
  cc?: string[]
  copyColleagues?: boolean
  attachmentIds?: string[]
  companyZipId?: string
  excludeUnmatched?: boolean
  /** Recipients the user chose to leave out (row positions of the review). */
  excludePositions?: number[]
  startDate: string
  startTime: string
  intervalMinutes: number
  name?: string
}

export type CompanyFileStatus = 'matched' | 'missing' | 'ambiguous' | 'invalid' | 'too_large' | 'excluded'

export interface ReviewRow {
  position: number
  companyName: string
  /** The worksheet of the Excel file this recipient came from. */
  sheet: string | null
  contactName: string | null
  toEmail: string | null
  ccEmails: string[]
  rows: number[]
  status: 'ready' | 'skipped' | 'blocked'
  category: 'invalid' | 'duplicate' | 'excluded' | null
  reason: string | null
  subject: string | null
  html: string | null
  text: string | null
  templateNumber: number | null
  companyFile: { status: CompanyFileStatus; fileName: string | null; sizeBytes: number | null; detail: string | null } | null
  note: string | null
  scheduledAt: string | null
  scheduledLocal: string | null
}

export interface PreparedSetup {
  templates: PreparedTemplate[]
  order: TemplateOrder
  seed: number
  cc: string[]
  replyTo: string | null
  /** Each sheet has its own template (templates[i] is for sheets[i]). */
  bySheet: boolean
  start: Date
  intervalMinutes: number
}

/** The choices that do not depend on the Excel, checked. */
export async function checkSetup(s: CampaignSetup): Promise<PreparedSetup> {
  const list = Array.isArray(s.templates) ? s.templates : []
  if (!list.length) throw new BadRequestError('Choose or write at least one template.')
  if (list.length > MAX_TEMPLATES_PER_CAMPAIGN) throw new BadRequestError(`At most ${MAX_TEMPLATES_PER_CAMPAIGN} templates in one campaign.`)
  const templates: PreparedTemplate[] = []
  for (const [i, t] of list.entries()) {
    try {
      if (t.templateId) {
        const saved = await prisma.template.findFirst({ where: { id: t.templateId, archived: false } })
        if (!saved) throw new BadRequestError('A chosen template no longer exists.')
        templates.push(prepareTemplate({ subject: saved.subject, bodyHtml: saved.bodyHtml }))
      } else {
        templates.push(prepareTemplate({ subject: t.subject ?? '', bodyHtml: t.bodyHtml ?? '' }))
      }
    } catch (e) {
      if (e instanceof BadRequestError && list.length > 1) throw new BadRequestError(`Template ${i + 1}: ${e.message}`)
      throw e
    }
  }
  const bySheet = Array.isArray(s.sheets) && s.sheets.length > 0
  if (bySheet) {
    if (new Set(s.sheets).size !== s.sheets!.length) throw new BadRequestError('The same sheet is listed twice.')
    if (s.sheets!.length !== templates.length) throw new BadRequestError('Each sheet needs exactly one template: choose a template for every sheet.')
  }
  const order: TemplateOrder = s.templateOrder === 'random' && !bySheet ? 'random' : 'sequential'
  const seed = order === 'random' ? Number(s.shuffleSeed) : 0
  if (order === 'random' && templates.length > 1 && !(Number.isInteger(seed) && seed >= 0 && seed <= 0x7fffffff)) throw new BadRequestError('The random order is missing. Choose Random again.')
  const cc: string[] = []
  for (const raw of s.cc ?? []) {
    const e = strictEmail(raw)
    if (!e) throw new BadRequestError(`"${String(raw).slice(0, 80)}" is not a valid CC address.`)
    if (!cc.includes(e)) cc.push(e)
  }
  if (cc.length > MAX_CC) throw new BadRequestError(`At most ${MAX_CC} CC addresses.`)
  const replyTo = s.replyTo?.trim() ? strictEmail(s.replyTo) : null
  if (s.replyTo?.trim() && !replyTo) throw new BadRequestError(`"${s.replyTo.slice(0, 80)}" is not a valid reply-to address.`)
  if (s.trackOpens === true) {
    const t = trackingStatus()
    if (!t.enabled) throw new ConflictError(`Open tracking cannot be switched on yet: ${t.reason}`)
  }
  const start = localToUtc(s.startDate, s.startTime)
  if (!start) throw new BadRequestError('Choose the date and the time sending starts.')
  const intervalMinutes = Math.round(Number(s.intervalMinutes))
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < env.MIN_INTERVAL_MINUTES || intervalMinutes > 240) {
    throw new BadRequestError(`Minutes between emails must be ${env.MIN_INTERVAL_MINUTES} to 240.`)
  }
  return { templates, order, seed, cc, replyTo, bySheet, start, intervalMinutes }
}

function companyFileView(m: CompanyMatch, common: { count: number; bytes: number }) {
  if (m.status === 'missing' || m.status === 'ambiguous') return { status: m.status, fileName: null, sizeBytes: null, detail: m.detail }
  const f = m.file!
  if (m.status === 'invalid') return { status: 'invalid' as const, fileName: f.fileName, sizeBytes: f.sizeBytes, detail: m.detail }
  if (common.count + 1 > MAX_COMMON_FILES + 1) return { status: 'too_large' as const, fileName: f.fileName, sizeBytes: f.sizeBytes, detail: 'Too many files for one email.' }
  if (common.bytes + f.sizeBytes > MAX_EMAIL_ATTACHMENT_BYTES) {
    return { status: 'too_large' as const, fileName: f.fileName, sizeBytes: f.sizeBytes, detail: `"${f.fileName}" with the other attachments is over the ${MAX_EMAIL_ATTACHMENT_BYTES / 1024 / 1024} MB limit for one email.` }
  }
  return { status: 'matched' as const, fileName: f.fileName, sizeBytes: f.sizeBytes, detail: null }
}

/** What the uploaded Excel contains (no choices needed yet). */
export async function analyzeExcel(user: Principal, excelFileId: string, opts: { allowWebmail?: boolean; sheet?: string; onePer?: RecipientMode } = {}) {
  const { info, bytes } = await readStaged(user, excelFileId, 'excel')
  const book = await readSpreadsheet(bytes, opts.sheet)
  const onePer: RecipientMode = opts.onePer === 'person' ? 'person' : 'company'
  const read = extractContacts(book.rows, { allowWebmail: opts.allowWebmail === true })
  const x = onePer === 'person' ? perPerson(read) : read
  if (!x.columns.company || x.columns.contacts.length === 0) {
    throw new BadRequestError(`No "Company" and "Email" columns were found in the sheet "${book.sheet}". Check the headings row, or choose another sheet.`)
  }
  if (x.companies.length > MAX_RECIPIENTS) throw new BadRequestError(`At most ${MAX_RECIPIENTS} ${onePer === 'person' ? 'people' : 'companies'} per campaign.`)
  return { file: info, sheets: book.sheets, sheet: book.sheet, onePer, ...x }
}

type Analysed = Extraction & { file: FileInfo; sheet: string; sheets: string[]; onePer: RecipientMode; bySheet: boolean }

/** The list of one sheet, or — with several sheets in one campaign — the lists of every chosen sheet one after the other. */
async function analyseForSetup(user: Principal, s: CampaignSetup): Promise<Analysed> {
  const opts = { allowWebmail: s.allowWebmail === true, onePer: s.onePer }
  if (!s.sheets?.length) return { ...(await analyzeExcel(user, s.excelFileId, { ...opts, sheet: s.sheet })), bySheet: false }
  const parts: Array<Awaited<ReturnType<typeof analyzeExcel>>> = []
  for (const name of s.sheets) parts.push(await analyzeExcel(user, s.excelFileId, { ...opts, sheet: name }))
  const total = parts.reduce((n, p) => n + p.companies.length, 0)
  if (total > MAX_RECIPIENTS) throw new BadRequestError(`At most ${MAX_RECIPIENTS} recipients per campaign (these sheets have ${total}).`)
  return {
    file: parts[0]!.file,
    sheets: parts[0]!.sheets,
    sheet: parts.map((p) => p.sheet).join(' + '),
    onePer: parts[0]!.onePer,
    bySheet: true,
    headerRow: parts[0]!.headerRow,
    columns: parts[0]!.columns,
    totalRows: parts.reduce((n, p) => n + p.totalRows, 0),
    companies: parts.flatMap((p, i) => p.companies.map((c) => ({ ...c, key: `${p.sheet}|${c.key}`, sheet: p.sheet, sheetIdx: i }))),
    noAddress: parts.flatMap((p) => p.noAddress.map((r) => ({ ...r, companyName: `${r.companyName} (${p.sheet})` }))),
    duplicates: parts.flatMap((p) => p.duplicates.map((r) => ({ ...r, companyName: `${r.companyName} (${p.sheet})` }))),
  }
}

export async function prepareReview(user: Principal, s: CampaignSetup, now = new Date()) {
  const setup = await checkSetup(s)
  const account = await usableAccount(user, s.senderAccountId)
  const sender = await readiness(account.id, now)
  const upload = await analyseForSetup(user, s)
  const attachments = await stagedCommon(user, s.attachmentIds)
  const commonFiles = { count: attachments.length, bytes: attachments.reduce((n, a) => n + a.sizeBytes, 0) }
  const zip: (StagedZip & { sha256: string }) | null = s.companyZipId ? await stagedZipInfo(user, s.companyZipId) : null
  const scan: ZipScan | null = zip ? await scanStagedZip(zip) : null
  const eligible = upload.companies.map((c) => !c.skip && c.people.length > 0 && Boolean(recipientsOf(c).to))
  const matches = scan ? matchCompanyFiles(upload.companies.map((c) => c.companyName), scan.files, eligible) : null
  const companyFiles = new Map<number, ZipFile>()
  const excludeSet = new Set((s.excludePositions ?? []).filter((n) => Number.isInteger(n)))
  // Excluding a recipient excludes that ADDRESS in this campaign (another company row may list the same person).
  // Every company with an address becomes exactly one row, so its row position is its place among those companies.
  const excludedAddresses = new Set(
    upload.companies
      .filter((c) => c.people.length > 0)
      .map((c, position) => (excludeSet.has(position) ? recipientsOf(c).to?.email : undefined))
      .filter((e): e is string => Boolean(e)),
  )

  // Earlier campaigns of THIS app: queued or sending, unknown outcomes, and what each address already received.
  const addresses = [...new Set(upload.companies.map((c) => recipientsOf(c).to?.email).filter((e): e is string => Boolean(e)))]
  const others = addresses.length
    ? await prisma.recipient.findMany({
        // Only campaigns of the current mode: test campaigns never block real ones (and the other way round).
        where: { toEmail: { in: addresses }, status: { in: ['scheduled', 'sending', 'unknown', 'sent'] }, campaign: { sendMode: env.SEND_MODE } },
        select: { toEmail: true, status: true, subject: true, bodyText: true, sentAt: true, attemptedAt: true },
      })
    : []
  const suppressed = await suppressedSet([...addresses, ...upload.companies.flatMap((c) => c.people.map((p) => p.email)), ...setup.cc])
  const cooldownSince = env.REPEAT_COOLDOWN_DAYS > 0 ? new Date(now.getTime() - env.REPEAT_COOLDOWN_DAYS * 86_400_000) : null
  const used = new Set<string>()

  const rows: ReviewRow[] = []
  let readyCount = 0
  for (const [ci, c] of upload.companies.entries()) {
    const { to, cc } = recipientsOf(c)
    const base = {
      position: rows.length,
      companyName: c.companyName,
      sheet: c.sheet ?? upload.sheet,
      contactName: to?.name ?? null,
      toEmail: to?.email ?? c.people[0]?.email ?? null,
      ccEmails: [] as string[],
      rows: c.rows,
      subject: null,
      html: null,
      text: null,
      templateNumber: null,
      companyFile: null,
      note: null,
      scheduledAt: null,
      scheduledLocal: null,
    }
    const skip = (category: 'invalid' | 'duplicate' | 'excluded', reason: string, extra: Partial<ReviewRow> = {}) => rows.push({ ...base, status: 'skipped', category, reason, ...extra })
    if (!c.people.length) continue // no usable address at all: listed under "no usable address"
    if (c.skip) {
      skip('excluded', c.skip)
      continue
    }
    if (!to) {
      skip('invalid', 'No contact name, so the greeting [First Name] cannot be filled.')
      continue
    }
    // The FIRST row that lists an address owns it in this campaign, whatever happens to that row: a later row with the same
    // address is a duplicate (so a person is never emailed under a second company's name because the first was held back).
    if (used.has(to.email)) {
      skip('duplicate', `${to.email} is already in this campaign (listed under another company); it is emailed at most once.`)
      continue
    }
    used.add(to.email)
    if (excludeSet.has(base.position)) {
      skip('excluded', 'Excluded by you on the review.')
      continue
    }
    if (excludedAddresses.has(to.email)) {
      skip('excluded', 'Excluded by you on the review (the same address).')
      continue
    }
    const sup = suppressed.get(to.email)
    if (sup) {
      skip('excluded', sup)
      continue
    }
    const mine = others.filter((o) => o.toEmail === to.email)
    if (mine.some((o) => o.status === 'scheduled' || o.status === 'sending')) {
      skip('excluded', 'Already queued in another campaign.')
      continue
    }
    const unknown = mine.find((o) => o.status === 'unknown')
    if (unknown) {
      skip('excluded', `Possibly already emailed: an earlier email to ${to.email} has an unknown outcome, so it is not sent again. Check the sender's Sent folder and resolve it in that campaign.`)
      continue
    }
    if (cooldownSince) {
      const recent = mine.find((o) => o.status === 'sent' && o.sentAt && o.sentAt >= cooldownSince)
      if (recent) {
        skip('excluded', `Emailed on ${recent.sentAt!.toISOString().slice(0, 10)}, within the ${env.REPEAT_COOLDOWN_DAYS}-day pause between emails.`)
        continue
      }
    }

    // The CC: colleagues (unless turned off) and the campaign's own CC; nobody on the do-not-email list.
    const ccOk: string[] = []
    if (s.copyColleagues !== false) for (const p of cc) if (p.email !== to.email && !suppressed.has(p.email) && !ccOk.includes(p.email)) ccOk.push(p.email)
    for (const e of setup.cc) if (e !== to.email && !suppressed.has(e) && !ccOk.includes(e)) ccOk.push(e)

    // Company PDF (ZIP): this company's own file, or the reason it cannot be sent — never another company's file.
    let companyFile: ReviewRow['companyFile'] = null
    if (matches) {
      const view = companyFileView(matches[ci]!, commonFiles)
      if (view.status !== 'matched') {
        if (s.excludeUnmatched) skip('excluded', `Excluded — ${view.detail}`, { contactName: to.name, toEmail: to.email, companyFile: { ...view, status: 'excluded' } })
        else rows.push({ ...base, contactName: to.name, toEmail: to.email, status: 'blocked', category: null, reason: view.detail, companyFile: view })
        continue
      }
      companyFile = view
    }

    // One template per sheet (sheet i → template i), or the rotation of the campaign's templates.
    const pick = setup.bySheet ? (c.sheetIdx ?? 0) : pickTemplate(setup.order, setup.templates.length, readyCount, setup.seed)
    const email = composeEmail({ template: setup.templates[pick]!, firstName: greetingName(to), companyName: c.companyName, signatureHtml: account.signatureHtml })
    if (email.draft.length) {
      skip('invalid', `The template still contains draft text that is not filled in: ${email.draft.slice(0, 3).join(' ')}${email.draft.length > 3 ? ' …' : ''} Edit the template (only [First Name] and [Company Name] are filled).`, { contactName: to.name, toEmail: to.email })
      continue
    }
    if (email.unfilled.length) {
      skip('invalid', `Could not fill ${email.unfilled.join(', ')}.`, { contactName: to.name, toEmail: to.email })
      continue
    }
    if (mine.some((o) => o.status === 'sent' && o.subject === email.subject && o.bodyText === email.text)) {
      skip('excluded', 'Already sent this same email; a follow-up needs different content.', { contactName: to.name, toEmail: to.email })
      continue
    }
    if (matches) companyFiles.set(base.position, matches[ci]!.file!)
    readyCount++
    const last = mine.filter((o) => o.status === 'sent').sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))[0]
    rows.push({
      ...base,
      contactName: to.name,
      toEmail: to.email,
      ccEmails: ccOk,
      status: 'ready',
      category: null,
      reason: null,
      subject: email.subject,
      html: email.html,
      text: email.text,
      templateNumber: setup.templates.length > 1 ? pick + 1 : null,
      companyFile,
      note: last ? `Follow-up: last emailed on ${last.sentAt?.toISOString().slice(0, 10)}.` : null,
    })
  }
  checkMatchedTotal([...companyFiles.values()])

  const begin = setup.start.getTime() < now.getTime() ? now : setup.start
  const ready = rows.filter((r) => r.status === 'ready')
  planSequential(begin, ready.length, setup.intervalMinutes).forEach((at, i) => {
    ready[i]!.scheduledAt = at.toISOString()
    ready[i]!.scheduledLocal = fmtLocal(at)
  })
  const last = ready.length ? new Date(ready[ready.length - 1]!.scheduledAt!) : null
  const count = (cat: string) => rows.filter((r) => r.category === cat).length
  const blocked = rows.filter((r) => r.status === 'blocked').length
  const fileCount = (st: CompanyFileStatus) => rows.filter((r) => r.companyFile?.status === st).length
  const usedFiles = new Set<ZipFile>(companyFiles.values())

  // What the person approves: who gets which email, with which files, from which account (not the times). Start
  // recomputes it and refuses when anything differs from what was reviewed.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        sender: account.email,
        sendMode: env.SEND_MODE,
        replyTo: setup.replyTo,
        trackOpens: s.trackOpens === true,
        attachments: attachments.map((a) => [a.id, a.sizeBytes]),
        rows: rows.map((r) => [r.position, r.status, r.category, r.toEmail, r.ccEmails, r.subject, r.html, r.text, r.templateNumber, r.sheet, companyFiles.get(r.position)?.sha256 ?? r.companyFile?.fileName ?? null]),
      }),
    )
    .digest('hex')

  return {
    fingerprint,
    companyFiles,
    excel: upload.file,
    columns: upload.columns,
    counts: {
      rowsWithCompany: upload.totalRows,
      companies: upload.companies.length,
      eligible: ready.length,
      invalid: count('invalid') + upload.noAddress.length,
      duplicate: count('duplicate') + upload.duplicates.length,
      excluded: count('excluded'),
      blocked,
    },
    rows,
    noAddress: upload.noAddress,
    duplicates: upload.duplicates,
    templates: setup.templates.map((t, i) => ({ number: i + 1, subject: t.subject, removed: t.removed })),
    templateOrder: setup.bySheet ? ('by_sheet' as const) : setup.templates.length > 1 ? setup.order : null,
    cc: setup.cc,
    replyTo: setup.replyTo,
    trackOpens: s.trackOpens === true,
    sheet: upload.sheet,
    sheets: upload.bySheet ? (s.sheets ?? []) : [upload.sheet],
    onePer: upload.onePer,
    copyColleagues: upload.onePer === 'company' && s.copyColleagues !== false,
    sender: { id: account.id, email: account.email, displayName: account.displayName, ...sender },
    sendMode: env.SEND_MODE,
    attachments,
    companyZip:
      zip && scan
        ? {
            id: zip.id,
            fileName: zip.fileName,
            sizeBytes: zip.sizeBytes,
            files: scan.files.map((f) => ({ name: f.fileName, path: f.path, sizeBytes: f.sizeBytes, status: f.status, reason: f.reason, used: usedFiles.has(f) })),
            problems: scan.problems,
            counts: { matched: fileCount('matched'), missing: fileCount('missing'), ambiguous: fileCount('ambiguous'), invalid: fileCount('invalid'), tooLarge: fileCount('too_large'), excluded: fileCount('excluded'), unused: scan.files.filter((f) => f.status === 'ok' && !usedFiles.has(f)).length },
          }
        : null,
    blockedProblem: blocked ? `${blocked} ${blocked === 1 ? 'recipient has' : 'recipients have'} no usable company PDF. Upload a corrected ZIP, or exclude ${blocked === 1 ? 'that recipient' : 'those recipients'}.` : null,
    schedule: {
      timezone: env.APP_TIMEZONE,
      startLocal: fmtLocal(begin),
      firstLocal: ready[0]?.scheduledLocal ?? null,
      lastLocal: last ? fmtLocal(last) : null,
      intervalMinutes: setup.intervalMinutes,
      limitNote:
        ready.length > sender.remainingToday
          ? `This account can send ${sender.remainingToday} more email${sender.remainingToday === 1 ? '' : 's'} in the next 24 hours (daily limit ${sender.dailyLimit}); the rest wait and go as the limit allows.`
          : null,
    },
    setup,
  }
}

/** The review as the screen gets it (without the internal parts). */
export async function reviewCampaign(user: Principal, s: CampaignSetup, now = new Date()) {
  const { companyFiles: _f, setup: _s, ...view } = await prepareReview(user, s, now)
  void _f
  void _s
  // The screen shows the HTML of an email; the plain-text copy is only for sending (and would double a big review).
  return { ...view, rows: view.rows.map(({ text: _t, ...row }) => (void _t, row)) }
}
