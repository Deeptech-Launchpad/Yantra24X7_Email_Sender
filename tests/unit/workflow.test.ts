import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { env } from '../../src/config/env.js'
import { prisma } from '../../src/platform/db.js'
import { dispatchTick } from '../../src/bulk/dispatcher.js'
import { startFakeGoogle, type FakeGoogle } from '../helpers/fakeGoogle.js'
import { Client, connectGmail, HEADER, makeUser, resetDb, startApp, xlsx, type Harness } from '../helpers/harness.js'
import { makeZip, pdf } from '../helpers/makeZip.js'

// THE WHOLE WORKFLOW through the real API, as the screens use it, with sending going to a
// FAKE Gmail (nothing is ever sent): Excel upload and validation, a template, CC, a common
// attachment and company-wise PDFs, review, explicit approval, sending, failures, retries,
// unknown outcomes, limits, the do-not-email list, reports and tracking.

let app: Harness
let google: FakeGoogle
let member: Client
let clock = Date.now()
const tick = async (minutes = 1.05) => {
  clock += minutes * 60_000
  return dispatchTick(new Date(clock))
}

const ROWS = [
  HEADER,
  ['Alpha Industries', 'alpha.example', 'Ann Lee', 'CEO', 'ann@alpha.example', 'Abe Cole', 'CFO', 'abe@alpha.example', ''],
  ['Bravo Ltd', 'bravo.example', 'Bob Ray', 'Owner', 'bob@bravo.example', '', '', '', ''],
  ['Charlie Corp', 'charlie.example', 'Cy Fox', 'MD', 'cy@charlie.example', '', '', '', ''],
  ['Delta Co', 'delta.example', 'Dee Day', 'CEO', '', '', '', '', ''], // no address → invalid
  ['Echo LLC', 'echo.example', 'Eve Ng', 'CEO', 'eve@echo.example', '', '', '', 'Outreach - 01/10/2026'], // Status → excluded
  ['Foxtrot', 'foxtrot.example', '', '', 'info@foxtrot.example', '', '', '', ''], // no name → invalid
  ['Golf Group', 'golf.example', 'Gil Moss', 'CEO', 'gil.moss@gmail.com', '', '', '', ''], // webmail only → invalid
  ['Hotel Inc', 'hotel.example', 'Hal Ito', 'CEO', 'bob@bravo.example', '', '', '', ''], // same address as Bravo → duplicate
  ['India Pvt', 'india.example', 'Ivy Rao', 'CEO', 'ivy@india.example', 'Ivy Rao', 'CEO', 'ivy@india.example', ''], // repeated address → merged (duplicate)
]
const PDFS = { alpha: pdf('Alpha Industries proposal'), bravo: pdf('Bravo Ltd proposal'), charlie: pdf('Charlie Corp proposal'), india: pdf('India Pvt proposal') }
const COMMON = pdf('Company brochure for everyone')
const zipAll = () =>
  makeZip([
    { name: 'Alpha Industries.pdf', data: PDFS.alpha },
    { name: 'bravo ltd.PDF', data: PDFS.bravo },
    { name: 'Charlie Corp.pdf', data: PDFS.charlie },
    { name: 'India Pvt.pdf', data: PDFS.india },
  ])

/** The base64 of a file as it appears in a message (nodemailer wraps lines; removing line breaks makes it contiguous). */
const carries = (mime: string, file: Buffer) => mime.replace(/\r\n/g, '').includes(file.toString('base64'))
/** A header's value, with folded lines joined (as every mail program reads them; long headers are folded). */
const header = (mime: string, name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi').exec(mime.split('\r\n\r\n')[0]!.replace(/\r\n[ \t]+/g, ' '))?.[1]?.trim() ?? null

let accountId = ''
let templateId = ''

async function prepare() {
  const excel = (await member.upload('/api/files/excel', 'Leads Oct.xlsx', await xlsx(ROWS))).body
  const att = (await member.upload('/api/files/attachments', 'Brochure.pdf', COMMON)).body
  return { excelFileId: excel.id as string, attachmentId: att.id as string }
}
const setup = (excelFileId: string, extra: Record<string, unknown> = {}) => ({
  excelFileId,
  senderAccountId: accountId,
  templates: [{ templateId }],
  cc: ['manager@yanthara.example'],
  copyColleagues: true,
  startDate: '2026-01-01',
  startTime: '09:00',
  intervalMinutes: 1,
  ...extra,
})
async function stageZip(c: Client, bytes: Buffer, name = 'company pdfs.zip') {
  const s = (await c.post('/api/files/zip/start', { fileName: name, sizeBytes: bytes.length })).body
  await c.req('POST', `/api/files/zip/${s.id}/chunk?offset=0`, bytes)
  return (await c.post(`/api/files/zip/${s.id}/finish`)).body.id as string
}

beforeAll(async () => {
  app = await startApp()
  google = await startFakeGoogle()
})
afterAll(async () => {
  await app.close()
  await google.close()
})
beforeEach(async () => {
  await resetDb()
  Object.assign(env, { SEND_MODE: 'live', TRACKING_ENABLED: false, TRACKING_BASE_URL: '', GMAIL_READONLY_CHECK: false, REPEAT_COOLDOWN_DAYS: 0 })
  google.sent.length = 0
  google.sendScript.length = 0
  google.revoked.length = 0
  Object.assign(google.tokenScript, { refreshError: null, email: 'sales.one@yanthara.example', refreshToken: 'refresh-token-1', emailVerified: true })
  clock = Date.now()
  await makeUser('admin@yanthara.example', 'admin', 'Admin')
  await makeUser('sam@yanthara.example', 'member', 'Sam Sales')
  member = new Client(app.base)
  await member.login('sam@yanthara.example')
  accountId = await connectGmail(member)
  templateId = (
    await member.post('/api/templates', {
      name: 'Intro',
      subject: 'A proposal for [Company Name]',
      bodyHtml: '<p>Hi [First Name],</p><p>We prepared a proposal for <b>[Company Name]</b> — it is attached.</p>',
    })
  ).body.id
})
afterEach(() => {
  env.SEND_MODE = 'test'
})

describe('the full workflow', () => {
  it('upload → validate → review → approve → send: every email carries its own company PDF and the common file, the right CC and the filled template; reports are complete', async () => {
    const { excelFileId, attachmentId } = await prepare()

    // Validation of the Excel before anything else.
    const a = await member.post('/api/campaigns/analyze', { excelFileId })
    expect(a.status).toBe(200)
    expect(a.body.noAddress.map((r: { companyName: string; reason: string }) => [r.companyName, r.reason])).toEqual([
      ['Delta Co', 'No email address'],
      ['Golf Group', 'Only a personal / webmail address (not used)'],
    ])

    const companyZipId = await stageZip(member, zipAll())
    const s = setup(excelFileId, { attachmentIds: [attachmentId], companyZipId })
    const review = await member.post('/api/campaigns/review', s)
    expect(review.status).toBe(200)
    const r = review.body
    expect(r.counts).toMatchObject({ eligible: 4, invalid: 3, duplicate: 2, excluded: 1, blocked: 0 })
    const byCompany = Object.fromEntries(r.rows.map((x: { companyName: string }) => [x.companyName, x]))
    expect(byCompany['Echo LLC']).toMatchObject({ status: 'skipped', category: 'excluded', reason: 'Already contacted (Status: "Outreach - 01/10/2026")' })
    expect(byCompany['Foxtrot']).toMatchObject({ status: 'skipped', category: 'invalid' })
    expect(byCompany['Hotel Inc']).toMatchObject({ status: 'skipped', category: 'duplicate' })
    expect(byCompany['Alpha Industries']).toMatchObject({ status: 'ready', toEmail: 'ann@alpha.example', ccEmails: ['abe@alpha.example', 'manager@yanthara.example'], subject: 'A proposal for Alpha Industries' })
    expect(byCompany['Alpha Industries'].companyFile).toMatchObject({ status: 'matched', fileName: 'Alpha Industries.pdf' })
    expect(byCompany['Bravo Ltd'].companyFile).toMatchObject({ status: 'matched', fileName: 'bravo ltd.PDF' })
    expect(byCompany['Alpha Industries'].html).toContain('Hi Ann,')
    expect(r.attachments.map((f: { fileName: string }) => f.fileName)).toEqual(['Brochure.pdf'])
    expect(r.sender).toMatchObject({ email: 'sales.one@yanthara.example', ready: true })
    expect(await prisma.campaign.count()).toBe(0) // a review writes nothing

    // Approval is explicit.
    expect((await member.post('/api/campaigns/start', { ...s, confirm: false })).status).toBe(400)
    const started = await member.approve({ ...s })
    expect(started.status).toBe(201)
    expect(started.body.scheduled).toBe(4)
    const id = started.body.campaignId

    for (let i = 0; i < 6; i++) await tick()
    expect(google.sent).toHaveLength(4)
    const byTo = Object.fromEntries(google.sent.map((m) => [header(m.mime, 'To'), m.mime]))
    expect(Object.keys(byTo).sort()).toEqual(['ann@alpha.example', 'bob@bravo.example', 'cy@charlie.example', 'ivy@india.example'])
    const alpha = byTo['ann@alpha.example']!
    expect(header(alpha, 'Cc')).toBe('abe@alpha.example, manager@yanthara.example')
    expect(header(alpha, 'From')).toContain('sales.one@yanthara.example')
    expect(header(alpha, 'Subject')).toBe('A proposal for Alpha Industries')
    expect(header(alpha, 'List-Unsubscribe')).toBe('<mailto:sales.one@yanthara.example?subject=unsubscribe>')
    expect(header(alpha, 'Message-ID')).toMatch(/^<yb\.[a-f0-9]+\.[a-f0-9]+@yanthara\.example>$/)
    // The actual files: its own company PDF and the common brochure — never another company's PDF.
    expect(carries(alpha, PDFS.alpha)).toBe(true)
    expect(carries(alpha, COMMON)).toBe(true)
    expect(carries(alpha, PDFS.bravo) || carries(alpha, PDFS.charlie) || carries(alpha, PDFS.india)).toBe(false)
    expect(carries(byTo['bob@bravo.example']!, PDFS.bravo)).toBe(true)
    expect(carries(byTo['bob@bravo.example']!, PDFS.alpha)).toBe(false)
    expect(alpha).toMatch(/Content-Disposition: attachment; filename="?Alpha Industries\.pdf"?/)
    expect(alpha).not.toMatch(/\/t\/[A-Za-z0-9_-]+\.gif/) // tracking is off
    expect(google.sent.every((m) => m.token === 'access-1' || m.token.startsWith('access-for-'))).toBe(true)

    const view = (await member.get(`/api/campaigns/${id}`)).body
    expect(view.campaign.status).toBe('completed')
    expect(view.counts).toMatchObject({ sent: 4, failed: 0, unknown: 0, scheduled: 0, skipped: 3, skippedInvalid: 1, skippedDuplicate: 1, skippedExcluded: 1 })
    expect(view.campaign.review).toMatchObject({ eligible: 4, invalid: 3, duplicate: 2, excluded: 1 })
    expect(view.recipients.find((x: { toEmail: string }) => x.toEmail === 'ann@alpha.example')).toMatchObject({ status: 'sent', companyFile: { fileName: 'Alpha Industries.pdf' }, attempts: 1 })
    expect(view.attachments.map((f: { fileName: string }) => f.fileName)).toEqual(['Brochure.pdf'])

    const email = await member.get(`/api/campaigns/${id}/recipients/${view.recipients[0].id}`)
    expect(email.body.html).toContain('Hi Ann,')

    const csv = await member.get(`/api/campaigns/${id}/report.csv`)
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-disposition')).toMatch(/attachment; filename=".*report\.csv"/)
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n')
    expect(lines[0]).toBe('Row,Sheet,Company,Contact,To,CC,Status,Category,Reason,Template,Subject,Company PDF,Scheduled,Sent,Attempts,Gmail message id,Opened?,Opens,First opened')
    expect(lines).toHaveLength(1 + 7)
    expect(lines.find((l) => l.startsWith('1,Sheet1,Alpha Industries'))).toMatch(/ann@alpha\.example,abe@alpha\.example; manager@yanthara\.example,sent,,,,A proposal for Alpha Industries,Alpha Industries\.pdf/)
    expect(lines.find((l) => l.includes('Echo LLC'))).toMatch(/skipped,excluded,"?Already contacted/)

    const audit = await prisma.auditEvent.findMany({ where: { campaignId: id } })
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['campaign.started', 'campaign.completed']))
    // The staged ZIP was removed once its PDFs were kept with the campaign.
    expect(await prisma.storedFile.count({ where: { kind: 'company_zip' } })).toBe(0)
  })

  it('test mode (the default) sends nothing: every email is written to the outbox as an .eml file instead', async () => {
    env.SEND_MODE = 'test'
    const { excelFileId } = await prepare()
    const id = (await member.approve({ ...setup(excelFileId) })).body.campaignId
    for (let i = 0; i < 6; i++) await tick()
    expect(google.sent).toHaveLength(0)
    const outbox = path.join(env.DATA_DIR, 'outbox')
    expect(existsSync(outbox)).toBe(true)
    const files = readdirSync(outbox).filter((f) => f.endsWith('.eml'))
    expect(files).toHaveLength(4)
    expect(readFileSync(path.join(outbox, files[0]!), 'latin1')).toMatch(/^Subject: A proposal for /m)
    expect((await member.get(`/api/campaigns/${id}`)).body.counts.sent).toBe(4)
  })
})

describe('approval rules', () => {
  it('a viewer cannot upload or start; a member cannot send from someone else\'s account unless an admin shares it', async () => {
    const { excelFileId } = await prepare()
    await makeUser('vic@yanthara.example', 'viewer')
    const viewer = new Client(app.base)
    await viewer.login('vic@yanthara.example')
    expect((await viewer.upload('/api/files/excel', 'x.xlsx', await xlsx(ROWS))).status).toBe(403)
    expect((await viewer.approve({ ...setup(excelFileId) })).status).toBe(403)

    await makeUser('olga@yanthara.example', 'member')
    const other = new Client(app.base)
    await other.login('olga@yanthara.example')
    const theirExcel = (await other.upload('/api/files/excel', 'x.xlsx', await xlsx(ROWS))).body.id
    expect((await other.post('/api/campaigns/review', setup(theirExcel))).status).toBe(403)
    // Someone else's staged file cannot be used either.
    expect((await other.post('/api/campaigns/review', setup(excelFileId))).status).toBe(403)

    const admin = new Client(app.base)
    await admin.login('admin@yanthara.example')
    expect((await member.req('PATCH', `/api/senders/${accountId}`, { shared: true })).status).toBe(403) // only an admin shares
    expect((await admin.req('PATCH', `/api/senders/${accountId}`, { shared: true })).status).toBe(200)
    expect((await other.post('/api/campaigns/review', setup(theirExcel))).status).toBe(200)
  })

  it('one campaign at a time per sender account', async () => {
    const { excelFileId } = await prepare()
    expect((await member.approve({ ...setup(excelFileId) })).status).toBe(201)
    const second = (await member.upload('/api/files/excel', 'b.xlsx', await xlsx([HEADER, ['Kilo AG', 'k', 'Kim Ko', 'CEO', 'kim@kilo.example', '', '', '', '']]))).body.id
    const r = await member.approve({ ...setup(second) })
    expect(r.status).toBe(409)
    expect(r.body.error.message).toMatch(/One campaign at a time per account/)
  })

  it('company PDFs: a missing or ambiguous file blocks the campaign until the ZIP is fixed or those recipients are explicitly excluded', async () => {
    const { excelFileId } = await prepare()
    const zip = await stageZip(
      member,
      makeZip([
        { name: 'Alpha Industries.pdf', data: PDFS.alpha },
        { name: 'a/Bravo Ltd.pdf', data: PDFS.bravo },
        { name: 'b/bravo  ltd.pdf', data: pdf('another bravo') },
        { name: 'India Pvt.pdf', data: PDFS.india },
      ]),
    )
    const s = setup(excelFileId, { companyZipId: zip })
    const review = (await member.post('/api/campaigns/review', s)).body
    const byCompany = Object.fromEntries(review.rows.map((x: { companyName: string }) => [x.companyName, x]))
    expect(byCompany['Bravo Ltd']).toMatchObject({ status: 'blocked', companyFile: { status: 'ambiguous' } })
    expect(byCompany['Charlie Corp']).toMatchObject({ status: 'blocked', companyFile: { status: 'missing' } })
    // Hotel Inc lists Bravo's address: Bravo's row owns it, even while held back — Hotel is a duplicate, never a second email.
    expect(byCompany['Hotel Inc']).toMatchObject({ status: 'skipped', category: 'duplicate' })
    expect(review.counts.blocked).toBe(2)
    const refused = await member.approve({ ...s })
    expect([refused.status, refused.body.error.message]).toEqual([409, expect.stringMatching(/2 recipients have no usable company PDF/)])
    expect(await prisma.campaign.count()).toBe(0)
    const ok = await member.approve({ ...s, excludeUnmatched: true })
    expect(ok.status).toBe(201)
    for (let i = 0; i < 4; i++) await tick()
    expect(google.sent.map((m) => header(m.mime, 'To')).sort()).toEqual(['ann@alpha.example', 'ivy@india.example'])
  })

  it('recipients can be excluded by hand on the review', async () => {
    const { excelFileId } = await prepare()
    const review = (await member.post('/api/campaigns/review', setup(excelFileId))).body
    const bravo = review.rows.find((x: { companyName: string }) => x.companyName === 'Bravo Ltd').position
    const again = (await member.post('/api/campaigns/review', setup(excelFileId, { excludePositions: [bravo] }))).body
    expect(again.rows[bravo]).toMatchObject({ status: 'skipped', category: 'excluded', reason: 'Excluded by you on the review.' })
    // Excluding a recipient excludes that ADDRESS: Hotel Inc lists the same address and is not sent either.
    expect(again.rows.find((x: { companyName: string }) => x.companyName === 'Hotel Inc')).toMatchObject({ status: 'skipped', category: 'duplicate' })
    // Excluding the second row of that address means "do not email this person": the first row is excluded too.
    const hotel = review.rows.find((x: { companyName: string }) => x.companyName === 'Hotel Inc').position
    const onlyHotel = (await member.post('/api/campaigns/review', setup(excelFileId, { excludePositions: [hotel] }))).body
    expect(onlyHotel.rows[bravo]).toMatchObject({ status: 'skipped', category: 'excluded', reason: 'Excluded by you on the review (the same address).' })
    expect(onlyHotel.counts.eligible).toBe(3)
    expect(again.counts.eligible).toBe(3)
  })
})

describe('never twice', () => {
  it('the same email to the same address is never sent twice; a different follow-up may go; an address still queued is not added again', async () => {
    let { excelFileId } = await prepare()
    const first = (await member.approve({ ...setup(excelFileId) })).body.campaignId
    // While the first is queued, another account's campaign cannot add the same people.
    google.tokenScript.email = 'sales.two@yanthara.example'
    google.tokenScript.refreshToken = 'refresh-token-2'
    const second = await connectGmail(member).then(async () => (await member.get('/api/senders')).body.accounts.find((a: { email: string }) => a.email === 'sales.two@yanthara.example').id)
    ;({ excelFileId } = await prepare())
    const queued = (await member.post('/api/campaigns/review', { ...setup(excelFileId), senderAccountId: second })).body
    expect(queued.rows.filter((x: { reason: string }) => x.reason === 'Already queued in another campaign.')).toHaveLength(4)
    expect(queued.counts.eligible).toBe(0)

    for (let i = 0; i < 6; i++) await tick()
    expect((await member.get(`/api/campaigns/${first}`)).body.campaign.status).toBe('completed')
    const same = (await member.post('/api/campaigns/review', setup(excelFileId))).body
    expect(same.counts.eligible).toBe(0)
    expect(same.rows.filter((x: { reason: string }) => /Already sent this same email/.test(x.reason ?? ''))).toHaveLength(4)

    const follow = (await member.post('/api/campaigns/review', setup(excelFileId, { templates: [{ subject: 'Following up, [Company Name]', bodyHtml: '<p>Hi [First Name], a quick follow-up.</p>' }] }))).body
    expect(follow.counts.eligible).toBe(4)
    expect(follow.rows.find((x: { status: string }) => x.status === 'ready').note).toMatch(/^Follow-up: last emailed on /)
  })

  it('an optional pause between emails to the same person (REPEAT_COOLDOWN_DAYS)', async () => {
    env.REPEAT_COOLDOWN_DAYS = 7
    let { excelFileId } = await prepare()
    await member.approve({ ...setup(excelFileId) })
    for (let i = 0; i < 6; i++) await tick()
    ;({ excelFileId } = await prepare())
    const follow = (await member.post('/api/campaigns/review', setup(excelFileId, { templates: [{ subject: 'Other', bodyHtml: '<p>Hi [First Name]</p>' }] }))).body
    expect(follow.counts.eligible).toBe(0)
    expect(follow.rows.filter((x: { reason: string }) => /within the 7-day pause/.test(x.reason ?? ''))).toHaveLength(4)
  })
})

describe('failures, retries and unknown outcomes', () => {
  const startOne = async () => {
    const excel = (await member.upload('/api/files/excel', 'one.xlsx', await xlsx([HEADER, ['Alpha Industries', 'a', 'Ann Lee', 'CEO', 'ann@alpha.example', '', '', '', ''], ['Bravo Ltd', 'b', 'Bob Ray', 'CEO', 'bob@bravo.example', '', '', '', '']]))).body.id
    return (await member.approve({ ...setup(excel, { cc: [] }) })).body.campaignId as string
  }
  const rec = async (email: string) => prisma.recipient.findFirstOrThrow({ where: { toEmail: email }, orderBy: { createdAt: 'desc' } })

  it('a refused email (Gmail 400) is failed with Gmail\'s reason, the rest go on, and a person can retry it', async () => {
    google.sendScript.push({ status: 400, reason: 'invalidArgument', message: 'Invalid To header' })
    const id = await startOne()
    await tick()
    await tick()
    expect(await rec('ann@alpha.example')).toMatchObject({ status: 'failed', reason: 'Gmail rejected the email: Invalid To header' })
    expect((await rec('bob@bravo.example')).status).toBe('sent')
    expect((await member.get(`/api/campaigns/${id}`)).body.campaign.status).toBe('completed')
    const retry = await member.post(`/api/campaigns/${id}/retry`, {})
    expect(retry.body).toMatchObject({ retried: 1 })
    await tick()
    expect(await rec('ann@alpha.example')).toMatchObject({ status: 'sent', attempts: 2 })
    expect(google.sent).toHaveLength(2)
  })

  it('Gmail\'s sending limit (429): nothing is lost — the email goes back in the queue and the campaign pauses until resumed', async () => {
    google.sendScript.push({ status: 429, reason: 'rateLimitExceeded', message: 'Too many messages' })
    const id = await startOne()
    await tick()
    const c = (await member.get(`/api/campaigns/${id}`)).body
    expect(c.campaign.status).toBe('paused')
    expect(c.campaign.statusReason).toMatch(/sending limit was reached/)
    expect(await rec('ann@alpha.example')).toMatchObject({ status: 'scheduled', attemptedAt: null })
    await tick()
    expect(google.sent).toHaveLength(0) // paused: nothing more
    expect((await member.post(`/api/campaigns/${id}/resume`)).status).toBe(200)
    clock = Date.now()
    await tick()
    await tick()
    expect(google.sent.map((m) => header(m.mime, 'To'))).toEqual(['ann@alpha.example', 'bob@bravo.example'])
  })

  it('an unknown outcome (the answer was lost) is NEVER sent again automatically; it blocks new campaigns to that address until a person resolves it', async () => {
    google.sendScript.push('drop')
    const id = await startOne()
    await tick()
    const ann = await rec('ann@alpha.example')
    expect(ann.status).toBe('unknown')
    expect(ann.reason).toMatch(/It may have been sent — it is not sent again automatically/)
    for (let i = 0; i < 5; i++) await tick()
    expect(google.sent.filter((m) => header(m.mime, 'To') === 'ann@alpha.example')).toHaveLength(1) // Gmail got it once, and only once
    expect((await member.post(`/api/campaigns/${id}/retry`, {})).body.error.message).toMatch(/no failed emails/)

    const excel = (await member.upload('/api/files/excel', 'again.xlsx', await xlsx([HEADER, ['Alpha Industries', 'a', 'Ann Lee', 'CEO', 'ann@alpha.example', '', '', '', '']]))).body.id
    const blocked = (await member.post('/api/campaigns/review', setup(excel, { templates: [{ subject: 'Other', bodyHtml: '<p>Hi [First Name]</p>' }] }))).body
    expect(blocked.rows[0].reason).toMatch(/^Possibly already emailed/)

    // A person checked the Sent folder: it was not there → it may be retried.
    expect((await member.post(`/api/campaigns/${id}/recipients/${ann.id}/resolve`, { outcome: 'not_sent' })).body.status).toBe('failed')
    expect((await member.post(`/api/campaigns/${id}/retry`, {})).body.retried).toBe(1)
  })

  it('with read access allowed, an unknown outcome is looked up in Sent by its Message-ID and marked sent when found', async () => {
    env.GMAIL_READONLY_CHECK = true
    google.sendScript.push('drop')
    await startOne()
    await tick()
    expect((await rec('ann@alpha.example')).status).toBe('unknown')
    await tick(3) // more than two minutes later the sender looks it up
    expect(await rec('ann@alpha.example')).toMatchObject({ status: 'sent', reason: 'Found in the Sent folder.' })
  })

  it('a Gmail server error (500) is unknown, not failed', async () => {
    google.sendScript.push({ status: 500, reason: 'backendError', message: 'Backend Error' })
    await startOne()
    await tick()
    expect((await rec('ann@alpha.example')).status).toBe('unknown')
  })

  it('a removed permission (invalid_grant): nothing is sent, the account must be reconnected, the campaign pauses', async () => {
    const id = await startOne()
    google.tokenScript.refreshError = 'invalid_grant'
    const { forgetAccessTokens } = await import('../../src/gmail/oauth.js')
    forgetAccessTokens()
    await tick()
    expect(google.sent).toHaveLength(0)
    expect((await prisma.senderAccount.findUniqueOrThrow({ where: { id: accountId } })).status).toBe('needs_reconnect')
    const c = (await member.get(`/api/campaigns/${id}`)).body
    expect(c.campaign.status).toBe('paused')
    expect(await rec('ann@alpha.example')).toMatchObject({ status: 'scheduled' })
    // Resuming is refused until the account is reconnected.
    expect((await member.post(`/api/campaigns/${id}/resume`)).status).toBe(409)
    google.tokenScript.refreshError = null
    await connectGmail(member)
    expect((await member.post(`/api/campaigns/${id}/resume`)).status).toBe(200)
  })

  it('an email left "sending" by a crash is never sent again if it was handed over; otherwise it goes back in the queue', async () => {
    await startOne()
    const ann = await rec('ann@alpha.example')
    const bob = await rec('bob@bravo.example')
    const old = new Date(Date.now() - 30 * 60_000)
    await prisma.recipient.update({ where: { id: ann.id }, data: { status: 'sending', attemptedAt: old, messageIdHeader: '<x@y>' } })
    await prisma.recipient.update({ where: { id: bob.id }, data: { status: 'sending' } })
    await prisma.$executeRawUnsafe(`UPDATE "Recipient" SET "updatedAt" = ${old.getTime()} WHERE "id" IN ('${ann.id}', '${bob.id}')`)
    await tick()
    expect((await rec('ann@alpha.example')).status).toBe('unknown')
    expect(['scheduled', 'sent']).toContain((await rec('bob@bravo.example')).status)
  })
})

describe('limits and the do-not-email list', () => {
  it('the daily limit of an account: the campaign waits instead of sending more', async () => {
    await prisma.senderAccount.update({ where: { id: accountId }, data: { dailyLimit: 1 } })
    const { excelFileId } = await prepare()
    const id = (await member.approve({ ...setup(excelFileId) })).body.campaignId
    for (let i = 0; i < 4; i++) await tick()
    expect(google.sent).toHaveLength(1)
    const c = (await member.get(`/api/campaigns/${id}`)).body
    expect(c.campaign.status).toBe('running')
    expect(c.campaign.statusReason).toMatch(/^Waiting — sales\.one@yanthara\.example has sent its daily limit of 1/)
  })

  it('emails are spaced by the chosen minutes', async () => {
    const { excelFileId } = await prepare()
    await member.approve({ ...setup(excelFileId, { intervalMinutes: 5 }) })
    await tick(5.1)
    await tick(1) // too soon
    await tick(1)
    expect(google.sent).toHaveLength(1)
    await tick(3.5)
    expect(google.sent).toHaveLength(2)
  })

  it('an address put on the do-not-email list after approval is skipped at the moment of sending', async () => {
    const { excelFileId } = await prepare()
    const id = (await member.approve({ ...setup(excelFileId) })).body.campaignId
    expect((await member.post('/api/suppressions', { values: ['@bravo.example'], reason: 'asked to stop' })).status).toBe(201)
    for (let i = 0; i < 6; i++) await tick()
    expect(google.sent.map((m) => header(m.mime, 'To'))).not.toContain('bob@bravo.example')
    const bob = (await member.get(`/api/campaigns/${id}`)).body.recipients.find((x: { toEmail: string }) => x.toEmail === 'bob@bravo.example')
    expect(bob).toMatchObject({ status: 'skipped', category: 'excluded', reason: 'On the do-not-email list (@bravo.example: asked to stop)' })
    // …and the next review excludes it before anything is approved.
    const { excelFileId: e2 } = await prepare()
    const r = (await member.post('/api/campaigns/review', setup(e2, { templates: [{ subject: 'X', bodyHtml: '<p>Hi [First Name]</p>' }] }))).body
    expect(r.rows.find((x: { toEmail: string }) => x.toEmail === 'bob@bravo.example').category).toBe('excluded')
  })

  it('a CC address on the do-not-email list is left out of the copy, not the email', async () => {
    await member.post('/api/suppressions', { values: ['abe@alpha.example'] })
    const { excelFileId } = await prepare()
    const r = (await member.post('/api/campaigns/review', setup(excelFileId))).body
    expect(r.rows.find((x: { companyName: string }) => x.companyName === 'Alpha Industries').ccEmails).toEqual(['manager@yanthara.example'])
  })

  it('pause, resume and cancel', async () => {
    const { excelFileId } = await prepare()
    const id = (await member.approve({ ...setup(excelFileId) })).body.campaignId
    await tick()
    expect((await member.post(`/api/campaigns/${id}/pause`)).body.status).toBe('paused')
    await tick()
    expect(google.sent).toHaveLength(1)
    expect((await member.post(`/api/campaigns/${id}/cancel`)).body.status).toBe('cancelled')
    const c = (await member.get(`/api/campaigns/${id}`)).body
    expect(c.counts).toMatchObject({ sent: 1, cancelled: 3 })
    expect((await member.post(`/api/campaigns/${id}/resume`)).status).toBe(409)
  })
})

describe('what is approved is exactly what is sent', () => {
  const first = async (campaignId: string) => (await prisma.recipient.findFirstOrThrow({ where: { campaignId, status: 'scheduled' }, orderBy: { scheduledAt: 'asc' } })).scheduledAt!

  it('Start refuses when anything changed since the review (here: an address put on the do-not-email list), and without a review', async () => {
    const { excelFileId } = await prepare()
    const s = setup(excelFileId)
    const review = (await member.post('/api/campaigns/review', s)).body
    expect(review.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect((await member.post('/api/campaigns/start', { ...s, confirm: true })).status).toBe(400)
    await member.post('/api/suppressions', { values: ['bob@bravo.example'] })
    const stale = await member.post('/api/campaigns/start', { ...s, confirm: true, reviewFingerprint: review.fingerprint })
    expect(stale.status).toBe(409)
    expect(stale.body.error.message).toMatch(/something changed since your review/)
    expect(await prisma.campaign.count()).toBe(0)
    expect((await member.approve(s)).status).toBe(201) // reviewed again → it starts
  })

  it('a paused campaign sends nothing; an email of a cancelled campaign is never put back in the queue', async () => {
    const { excelFileId } = await prepare()
    const id = (await member.approve(setup(excelFileId))).body.campaignId
    await prisma.campaign.update({ where: { id }, data: { status: 'paused' } })
    await tick()
    expect(google.sent).toHaveLength(0)
    expect(await prisma.recipient.count({ where: { campaignId: id, status: 'sending' } })).toBe(0)
    // One email was picked (never handed over) when the app stopped; meanwhile the campaign is cancelled.
    const bob = await prisma.recipient.findFirstOrThrow({ where: { campaignId: id, toEmail: 'bob@bravo.example' } })
    await prisma.recipient.update({ where: { id: bob.id }, data: { status: 'sending' } })
    const old = new Date(Date.now() - 30 * 60_000)
    await prisma.$executeRawUnsafe(`UPDATE "Recipient" SET "updatedAt" = ${old.getTime()} WHERE "id" = '${bob.id}'`)
    expect((await member.post(`/api/campaigns/${id}/cancel`)).body.status).toBe('cancelled')
    await tick()
    expect(await prisma.recipient.findUniqueOrThrow({ where: { id: bob.id } })).toMatchObject({ status: 'cancelled' })
    expect(google.sent).toHaveLength(0)
  })

  it('a CC address put on the do-not-email list after approval is left out when the email goes, and the record shows who really got it', async () => {
    const { excelFileId } = await prepare()
    const id = (await member.approve(setup(excelFileId))).body.campaignId
    await member.post('/api/suppressions', { values: ['abe@alpha.example'] })
    for (let i = 0; i < 4; i++) await tick()
    const toAnn = google.sent.find((m) => header(m.mime, 'To') === 'ann@alpha.example')!
    expect(header(toAnn.mime, 'Cc')).toBe('manager@yanthara.example')
    const ann = (await member.get(`/api/campaigns/${id}`)).body.recipients.find((x: { toEmail: string }) => x.toEmail === 'ann@alpha.example')
    expect(ann).toMatchObject({ status: 'sent', cc: ['manager@yanthara.example'] })
  })

  it('resuming before the planned start keeps the planned times (a resume never brings sending forward)', async () => {
    const { excelFileId } = await prepare()
    const startDate = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
    const id = (await member.approve(setup(excelFileId, { startDate, startTime: '10:00' }))).body.campaignId
    const planned = await first(id)
    await member.post(`/api/campaigns/${id}/pause`)
    expect((await member.post(`/api/campaigns/${id}/resume`)).body.status).toBe('running')
    expect((await first(id)).getTime()).toBe(planned.getTime())
    await tick()
    expect(google.sent).toHaveLength(0)
  })

  it('only the person who started a campaign, or an admin, can pause, resume, cancel, retry or resolve it', async () => {
    const { excelFileId } = await prepare()
    const id = (await member.approve(setup(excelFileId))).body.campaignId
    await makeUser('tia@yanthara.example', 'member', 'Tia Other')
    const other = new Client(app.base)
    await other.login('tia@yanthara.example')
    expect((await other.get(`/api/campaigns/${id}`)).status).toBe(200) // everyone may see it
    for (const action of ['pause', 'resume', 'cancel', 'retry', 'reconcile']) expect((await other.post(`/api/campaigns/${id}/${action}`)).status).toBe(403)
    const ann = await prisma.recipient.findFirstOrThrow({ where: { campaignId: id, toEmail: 'ann@alpha.example' } })
    expect((await other.post(`/api/campaigns/${id}/recipients/${ann.id}/resolve`, { outcome: 'sent' })).status).toBe(403)
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id } })).status).toBe('running')
    const admin = new Client(app.base)
    await admin.login('admin@yanthara.example')
    expect((await admin.post(`/api/campaigns/${id}/pause`)).body.status).toBe('paused')
  })

  it('a campaign approved in test mode never sends for real: with the app switched to live it pauses; test emails neither use up the real daily limit nor block real emails', async () => {
    env.SEND_MODE = 'test'
    const { excelFileId } = await prepare()
    const id = (await member.approve(setup(excelFileId))).body.campaignId
    expect((await member.get(`/api/campaigns/${id}`)).body.campaign.sendMode).toBe('test')
    await tick() // one email written to the outbox
    expect(await prisma.recipient.count({ where: { campaignId: id, status: 'sent' } })).toBe(1)
    env.SEND_MODE = 'live'
    await tick()
    expect(google.sent).toHaveLength(0)
    expect((await member.get(`/api/campaigns/${id}`)).body.campaign).toMatchObject({ status: 'paused', statusReason: expect.stringMatching(/approved in test mode/) })
    expect((await member.post(`/api/campaigns/${id}/resume`)).status).toBe(409)
    expect((await member.get('/api/senders')).body.accounts[0].sentLast24h).toBe(0)
    const { excelFileId: e2 } = await prepare()
    const live = (await member.post('/api/campaigns/review', setup(e2))).body
    expect(live.counts.eligible).toBe(4) // the test email to Ann does not count as "already sent"
  })
})

describe('open tracking (off until a domain is configured)', () => {
  it('is off by default: no image in the email and the screens say why', async () => {
    const cfg = (await member.get('/api/config')).body
    expect(cfg.tracking).toEqual({ enabled: false, reason: expect.stringMatching(/Open tracking is off/) })
  })

  const TWO = async () => {
    const bytes = await xlsx([HEADER, ['Alpha Industries', 'a', 'Ann Lee', 'CEO', 'ann@alpha.example', '', '', '', ''], ['Bravo Ltd', 'b', 'Bob Ray', 'Owner', 'bob@bravo.example', '', '', '', '']])
    return (await member.upload('/api/files/excel', 'two.xlsx', bytes)).body.id as string
  }
  const pixelToken = (mime: string) => /https:\/\/mail\.yanthara\.example\/t\/([A-Za-z0-9_-]+)\.gif/.exec(mime.replace(/=\r\n/g, '').replace(/=3D/g, '='))?.[1]

  it('"Track opens" can only be ticked once tracking is set up on the server, and says why not', async () => {
    const excel = await TWO()
    const r = await member.post('/api/campaigns/review', setup(excel, { cc: [], trackOpens: true }))
    expect(r.status).toBe(409)
    expect(r.body.error.message).toMatch(/Open tracking cannot be switched on yet: Open tracking is off/)
    expect(await prisma.campaign.count()).toBe(0)
  })

  it('without the option ticked no image is added, even when the server has tracking set up', async () => {
    Object.assign(env, { TRACKING_ENABLED: true, TRACKING_BASE_URL: 'https://mail.yanthara.example' })
    const excel = await TWO()
    const id = (await member.approve(setup(excel, { cc: [] }))).body.campaignId
    await tick()
    expect(pixelToken(google.sent[0]!.mime)).toBeUndefined()
    const v = (await member.get(`/api/campaigns/${id}`)).body
    expect(v.campaign.trackOpens).toBe(false)
    expect(v.recipients[0]).toMatchObject({ trackingEnabled: false, openCount: 0 })
  })

  it('with the option ticked each email gets its own image; an open is counted, and the report says who opened and who did not', async () => {
    Object.assign(env, { TRACKING_ENABLED: true, TRACKING_BASE_URL: 'https://mail.yanthara.example' })
    const excel = await TWO()
    const id = (await member.approve(setup(excel, { cc: [], trackOpens: true }))).body.campaignId
    await tick()
    await tick()
    expect(google.sent).toHaveLength(2)
    // Opens within 15 seconds of sending are mail scanners: the emails are made to look sent a few minutes ago.
    await prisma.recipient.updateMany({ where: { campaignId: id }, data: { sentAt: new Date(Date.now() - 5 * 60_000) } })
    const [t1, t2] = google.sent.map((m) => pixelToken(m.mime))
    expect(t1).toBeTruthy()
    expect(t2).toBeTruthy()
    expect(t1).not.toBe(t2) // one image per email
    const img = await fetch(`${app.base}/t/${t1}.gif`)
    expect(img.headers.get('content-type')).toBe('image/gif')
    await new Promise((r) => setTimeout(r, 150))
    const v = (await member.get(`/api/campaigns/${id}`)).body
    expect(v.campaign.trackOpens).toBe(true)
    expect(v.recipients.map((x: { toEmail: string; trackingEnabled: boolean; openCount: number }) => [x.toEmail, x.trackingEnabled, x.openCount])).toEqual([['ann@alpha.example', true, 1], ['bob@bravo.example', true, 0]])
    expect(v.recipients[0].firstOpenedLocal).toBeTruthy()
    expect(v.counts.opens).toEqual({ tracked: 2, opened: 1 })
    const csv = (await member.get(`/api/campaigns/${id}/report.csv`)).text
    expect(csv).toMatch(/ann@alpha\.example.*,opened,1,/)
    expect(csv).toMatch(/bob@bravo\.example.*,not opened,0,/)
  })
})
