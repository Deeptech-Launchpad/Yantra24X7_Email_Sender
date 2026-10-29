import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { env } from '../../src/config/env.js'
import { prisma } from '../../src/platform/db.js'
import { dispatchTick } from '../../src/bulk/dispatcher.js'
import { accessToken, AccountAuthError } from '../../src/gmail/oauth.js'
import { classifySmtpError } from '../../src/gmail/smtp.js'
import { startFakeSmtp, type FakeSmtp } from '../helpers/fakeSmtp.js'
import { Client, makeUser, resetDb, startApp, type Harness } from '../helpers/harness.js'

// A GMAIL ACCOUNT THAT SENDS WITH AN APP PASSWORD (SMTP), a list of PEOPLE on one sheet of a
// workbook, one email per person, and replies going to another address — against a FAKE mail
// server on this machine. Nothing ever reaches Gmail and nothing is ever sent.

let app: Harness
let smtp: FakeSmtp
let member: Client
let clock = Date.now()
const tick = async (minutes = 1.05) => {
  clock += minutes * 60_000
  return dispatchTick(new Date(clock))
}

const SENDER = 'sales.team@gmail.example'
const APP_PW = 'abcd efgh ijkl mnop' // as Google shows it
const PEOPLE = ['Email', 'First Name', 'Last Name', 'Job Title', 'Company', 'Mailer']

async function workbook(sheets: Record<string, unknown[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  for (const [name, rows] of Object.entries(sheets)) wb.addWorksheet(name).addRows(rows)
  return Buffer.from(await wb.xlsx.writeBuffer())
}
const LIST = () =>
  workbook({
    Summary: [['Rotoplas 2026 — Phase 1'], ['Mailer 1', 3]],
    'Mailer 1 - Discovery': [
      PEOPLE,
      ['ann@alpha.example', 'Mary Ann', 'Lee', 'CEO', 'Alpha Rotomolding', 'Mailer 1'],
      ['abe@alpha.example', 'abe', 'Cole', 'CFO', 'Alpha Rotomolding', 'Mailer 1'], // same company: still their own email
      ['bob@bravo.example', 'Bob', 'Ray', 'Owner', 'Bravo Tanks', 'Mailer 1'],
    ],
    'Mailer 2 - PiatIQ RotoSight': [PEOPLE, ['cy@charlie.example', 'Cy', 'Fox', 'MD', 'Charlie Plastics', 'Mailer 2']],
  })
const TEMPLATE = { subject: 'Invitation: Rotoplas booth 323', bodyHtml: '<p>Dear [First Name],</p><p>We would welcome the chance to meet <u>you</u> at booth 323.</p><ul><li><b>Molds</b> in 6–8 weeks</li></ul>' }

let accountId = ''
async function addAccount(c: Client = member, pw = APP_PW) {
  return c.post('/api/senders/app-password', { email: SENDER, appPassword: pw, displayName: 'Sales Team' })
}
async function upload() {
  return (await member.upload('/api/files/excel', 'Phase1 List.xlsx', await LIST())).body.id as string
}
const setup = (excelFileId: string, extra: Record<string, unknown> = {}) => ({
  excelFileId,
  sheet: 'Mailer 1 - Discovery',
  onePer: 'person',
  replyTo: 'bharath@whiteplast.example',
  senderAccountId: accountId,
  templates: [TEMPLATE],
  cc: [],
  startDate: '2026-01-01',
  startTime: '09:00',
  intervalMinutes: 1,
  ...extra,
})
const header = (mime: string, name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi').exec(mime.split('\r\n\r\n')[0]!.replace(/\r\n[ \t]+/g, ' '))?.[1]?.trim() ?? null
const rec = (email: string) => prisma.recipient.findFirstOrThrow({ where: { toEmail: email }, orderBy: { createdAt: 'desc' } })

beforeAll(async () => {
  app = await startApp()
  smtp = await startFakeSmtp()
})
afterAll(async () => {
  await app.close()
  await smtp.close()
})
beforeEach(async () => {
  await resetDb()
  smtp.accounts.clear()
  smtp.accounts.set(SENDER, 'abcdefghijklmnop')
  smtp.logins.length = 0
  smtp.sent.length = 0
  smtp.script.length = 0
  env.SEND_MODE = 'live'
  clock = Date.now()
  await makeUser('admin@yanthara.example', 'admin', 'Admin')
  await makeUser('sam@yanthara.example', 'member', 'Sam Sales')
  member = new Client(app.base)
  await member.login('sam@yanthara.example')
})
afterEach(() => {
  env.SEND_MODE = 'test'
})

describe('adding a Gmail account with an app password', () => {
  it('checks the password by signing in to the mail server (no email sent), stores it ENCRYPTED, and never shows it again', async () => {
    expect((await addAccount(member, 'MyNormalPass-2026')).body.error.message).toMatch(/16 letters Google shows/)
    expect((await addAccount(member, 'zzzz zzzz zzzz zzzz')).body.error.message).toMatch(/did not accept this app password/)
    const r = await addAccount()
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ email: SENDER, authType: 'app_password', status: 'connected', canSend: true, canCheckSent: false, displayName: 'Sales Team' })
    expect(smtp.logins.at(-1)).toEqual({ user: SENDER, ok: true })
    expect(smtp.sent).toHaveLength(0)
    const stored = await prisma.senderAccount.findUniqueOrThrow({ where: { email: SENDER } })
    expect(stored.refreshTokenEnc).not.toContain('abcdefghijklmnop')
    const list = await member.get('/api/senders')
    expect(JSON.stringify(list.body)).not.toMatch(/abcdefghijklmnop|abcd efgh/)
    // An app password is never sent to Google's sign-in service.
    await expect(accessToken(stored.id)).rejects.toBeInstanceOf(AccountAuthError)
  })

  it('a viewer cannot add one; someone else\'s account cannot be taken over; a new app password replaces the old one', async () => {
    await makeUser('vic@yanthara.example', 'viewer', 'Vic Viewer')
    const viewer = new Client(app.base)
    await viewer.login('vic@yanthara.example')
    expect((await addAccount(viewer)).status).toBe(403)
    expect((await addAccount()).status).toBe(201)
    await makeUser('tia@yanthara.example', 'member', 'Tia Other')
    const other = new Client(app.base)
    await other.login('tia@yanthara.example')
    expect((await addAccount(other)).status).toBe(403)
    smtp.accounts.set(SENDER, 'qrstuvwxyzabcdef')
    expect((await addAccount(member, 'qrst uvwx yzab cdef')).status).toBe(201)
    expect(await prisma.senderAccount.count()).toBe(1)
  })
})

describe('one email per person, from one sheet, replies to another address, sent with the app password', () => {
  beforeEach(async () => {
    accountId = (await addAccount()).body.id
  })

  it('reads the chosen sheet (the summary sheet is skipped by default); every person gets their own email with the First Name as written; nobody is copied', async () => {
    const excelFileId = await upload()
    const a = (await member.post('/api/campaigns/analyze', { excelFileId, onePer: 'person' })).body
    expect(a.sheets).toEqual(['Summary', 'Mailer 1 - Discovery', 'Mailer 2 - PiatIQ RotoSight'])
    expect(a.sheet).toBe('Mailer 1 - Discovery') // the first sheet with an email heading
    expect(a.companies).toHaveLength(3)
    const other = (await member.post('/api/campaigns/analyze', { excelFileId, sheet: 'Mailer 2 - PiatIQ RotoSight', onePer: 'person' })).body
    expect(other.companies.map((c: { companyName: string }) => c.companyName)).toEqual(['Charlie Plastics'])

    const r = (await member.post('/api/campaigns/review', setup(excelFileId))).body
    expect(r).toMatchObject({ onePer: 'person', sheet: 'Mailer 1 - Discovery', replyTo: 'bharath@whiteplast.example', copyColleagues: false })
    expect(r.counts).toMatchObject({ eligible: 3, invalid: 0, duplicate: 0, excluded: 0 })
    expect(r.rows.map((x: { toEmail: string; ccEmails: string[]; contactName: string }) => [x.toEmail, x.ccEmails, x.contactName])).toEqual([
      ['ann@alpha.example', [], 'Mary Ann Lee'],
      ['abe@alpha.example', [], 'abe Cole'],
      ['bob@bravo.example', [], 'Bob Ray'],
    ])
    expect(r.rows[0].html).toContain('Dear Mary Ann,') // the First Name cell, exactly
    expect(r.rows[1].html).toContain('Dear abe,')
    // Per company (the default) the same sheet is one email to Alpha with Abe copied.
    const byCompany = (await member.post('/api/campaigns/review', setup(excelFileId, { onePer: 'company' }))).body
    expect(byCompany.rows[0]).toMatchObject({ toEmail: 'ann@alpha.example', ccEmails: ['abe@alpha.example'] })
  })

  it('sends through the mail server with the app password: To only, Reply-To and unsubscribe to the reply address, the approved content exactly', async () => {
    const excelFileId = await upload()
    const started = await member.approve(setup(excelFileId))
    expect(started.status).toBe(201)
    const view = (await member.get(`/api/campaigns/${started.body.campaignId}`)).body.campaign
    expect(view).toMatchObject({ replyTo: 'bharath@whiteplast.example', recipientMode: 'person', sheetName: 'Mailer 1 - Discovery', sendMode: 'live' })
    for (let i = 0; i < 4; i++) await tick()
    expect(smtp.sent.map((m) => m.to)).toEqual([['ann@alpha.example'], ['abe@alpha.example'], ['bob@bravo.example']])
    const m = smtp.sent[0]!
    expect(m.from).toBe(SENDER)
    expect(header(m.data, 'From')).toBe(`Sales Team <${SENDER}>`)
    expect(header(m.data, 'Reply-To')).toBe('bharath@whiteplast.example')
    expect(header(m.data, 'List-Unsubscribe')).toBe('<mailto:bharath@whiteplast.example?subject=unsubscribe>')
    expect(header(m.data, 'Cc')).toBeNull()
    expect(header(m.data, 'Subject')).toBe('Invitation: Rotoplas booth 323')
    const approved = await rec('ann@alpha.example')
    const body = m.data.replace(/=\r\n/g, '').replace(/=3D/g, '=')
    expect(body).toContain('Dear Mary Ann,')
    expect(body).toContain('<u>you</u>')
    expect(approved).toMatchObject({ status: 'sent' })
    expect((await member.get(`/api/campaigns/${started.body.campaignId}`)).body.campaign.status).toBe('completed')
  })

  it("Gmail's sending limit (550 5.4.5): not sent, back in the queue, the campaign pauses", async () => {
    const excelFileId = await upload()
    const id = (await member.approve(setup(excelFileId))).body.campaignId
    smtp.script.push('550 5.4.5 Daily user sending limit exceeded.')
    await tick()
    expect(await rec('ann@alpha.example')).toMatchObject({ status: 'scheduled', attemptedAt: null })
    expect((await member.get(`/api/campaigns/${id}`)).body.campaign).toMatchObject({ status: 'paused', statusReason: expect.stringMatching(/sending limit exceeded/) })
  })

  it('an app password that stopped working (535): nothing sent, the account must be updated, the campaign pauses', async () => {
    const excelFileId = await upload()
    const id = (await member.approve(setup(excelFileId))).body.campaignId
    smtp.accounts.set(SENDER, 'revokedrevokedxx')
    await tick()
    expect(smtp.sent).toHaveLength(0)
    expect(await prisma.senderAccount.findUniqueOrThrow({ where: { id: accountId } })).toMatchObject({ status: 'needs_reconnect' })
    expect((await member.get(`/api/campaigns/${id}`)).body.campaign.status).toBe('paused')
    expect(await rec('ann@alpha.example')).toMatchObject({ status: 'scheduled' })
  })

  it('no connection at all: nothing was handed over, so the email waits in the queue and the campaign pauses', async () => {
    const excelFileId = await upload()
    const id = (await member.approve(setup(excelFileId))).body.campaignId
    const port = env.SMTP_PORT
    env.SMTP_PORT = 9 // nothing listens there
    try {
      await tick()
    } finally {
      env.SMTP_PORT = port
    }
    expect(await rec('ann@alpha.example')).toMatchObject({ status: 'scheduled', attemptedAt: null })
    expect((await member.get(`/api/campaigns/${id}`)).body.campaign).toMatchObject({ status: 'paused', statusReason: expect.stringMatching(/before the email was handed over/) })
  })

  it('a refused message (550 5.1.1) is failed; a connection lost after the message is UNKNOWN and never sent again', async () => {
    const excelFileId = await upload()
    const id = (await member.approve(setup(excelFileId))).body.campaignId
    smtp.script.push('550 5.1.1 The email account that you tried to reach does not exist.', 'drop')
    await tick()
    await tick()
    expect(await rec('ann@alpha.example')).toMatchObject({ status: 'failed', reason: expect.stringMatching(/does not exist/) })
    expect(await rec('abe@alpha.example')).toMatchObject({ status: 'unknown' })
    for (let i = 0; i < 3; i++) await tick()
    expect(smtp.sent.filter((m) => m.to[0] === 'abe@alpha.example')).toHaveLength(1)
    // Sent cannot be searched with an app password: a person resolves it.
    env.GMAIL_READONLY_CHECK = true
    try {
      expect((await member.post(`/api/campaigns/${id}/reconcile`)).body.error.message).toMatch(/app password, which cannot look in Sent/)
    } finally {
      env.GMAIL_READONLY_CHECK = false
    }
  })

  it('the readiness check signs in again in live mode; a reply-to that is not an address is refused', async () => {
    expect((await member.post(`/api/senders/${accountId}/check`)).body).toMatchObject({ ready: true })
    smtp.accounts.set(SENDER, 'changedchangedxx')
    const r = (await member.post(`/api/senders/${accountId}/check`)).body
    expect(r.ready).toBe(false)
    expect(r.problems.join(' ')).toMatch(/did not accept the app password/)
    const excelFileId = await upload()
    expect((await member.post('/api/campaigns/review', setup(excelFileId, { replyTo: 'not an address' }))).body.error.message).toMatch(/not a valid reply-to/)
  })
})

describe("what the mail server's answers mean", () => {
  it('only a definite answer is "not sent"; anything after the message without an answer is unknown', () => {
    expect(classifySmtpError({ code: 'EAUTH', responseCode: 535, response: '535 5.7.8 not accepted' })).toMatchObject({ outcome: 'refused', kind: 'auth' })
    expect(classifySmtpError({ code: 'EMESSAGE', responseCode: 550, response: '550 5.4.5 Daily user sending limit exceeded', command: 'DATA' })).toMatchObject({ kind: 'quota' })
    expect(classifySmtpError({ code: 'EMESSAGE', responseCode: 421, response: '421 4.7.0 Try again later', command: 'DATA' })).toMatchObject({ kind: 'quota' })
    expect(classifySmtpError({ code: 'EENVELOPE', responseCode: 553, response: '553 5.1.3 bad address', command: 'RCPT TO' })).toMatchObject({ kind: 'invalid' })
    // The same error before and after the message was handed over: only "before" is certainly not sent.
    expect(classifySmtpError({ code: 'ECONNECTION', command: 'CONN', message: 'Connection closed unexpectedly' }, false)).toMatchObject({ outcome: 'refused', kind: 'quota' })
    expect(classifySmtpError({ code: 'ECONNECTION', command: 'CONN', message: 'Connection closed unexpectedly' }, true)).toMatchObject({ outcome: 'unknown' })
    expect(classifySmtpError({ code: 'ETIMEDOUT', command: 'DATA', message: 'Timeout' })).toMatchObject({ outcome: 'unknown' })
    expect(classifySmtpError({ code: 'ESOCKET', message: 'socket closed' })).toMatchObject({ outcome: 'unknown' })
  })
})
