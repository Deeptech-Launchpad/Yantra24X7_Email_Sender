import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { env } from '../../src/config/env.js'
import { prisma } from '../../src/platform/db.js'
import { dispatchTick } from '../../src/bulk/dispatcher.js'
import { startFakeSmtp, type FakeSmtp } from '../helpers/fakeSmtp.js'
import { Client, makeUser, resetDb, startApp, type Harness } from '../helpers/harness.js'

// ONE WORKBOOK, SEVERAL SHEETS, EACH SHEET WITH ITS OWN EMAIL — in one reviewed campaign (the Rotoplas list:
// "Mailer 1" sheet → Mailer 1 email, "Mailer 2" sheet → Mailer 2 email, "Mailer 3" sheet → Mailer 3 email).
// Sent through a FAKE mail server: nothing ever reaches Gmail.

let app: Harness
let smtp: FakeSmtp
let member: Client
let clock = Date.now()
const tick = async (minutes = 1.05) => {
  clock += minutes * 60_000
  return dispatchTick(new Date(clock))
}

const SENDER = 'sales.team@gmail.example'
const S1 = 'Mailer 1 - Discovery'
const S2 = 'Mailer 2 - PiatIQ RotoSight'
const S3 = 'Mailer 3 - Material suppliers'
const PEOPLE = ['Email', 'First Name', 'Last Name', 'Job Title', 'Company', 'Mailer']

async function workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.addWorksheet('Summary').addRows([['Rotoplas 2026 — Phase 1'], ['Mailer 1', 2]])
  wb.addWorksheet(S1).addRows([PEOPLE, ['ann@alpha.example', 'Ann', 'Lee', 'CEO', 'Alpha Rotomolding', 'Mailer 1'], ['bob@bravo.example', 'Bob', 'Ray', 'Owner', 'Bravo Tanks', 'Mailer 1']])
  wb.addWorksheet(S2).addRows([PEOPLE, ['cy@charlie.example', 'Cy', 'Fox', 'MD', 'Charlie Plastics', 'Mailer 2'], ['ann@alpha.example', 'Ann', 'Lee', 'CEO', 'Alpha Rotomolding', 'Mailer 2']]) // Ann is on two sheets
  wb.addWorksheet(S3).addRows([PEOPLE, ['dee@delta.example', 'Dee', 'Day', 'Sales', 'Delta Resins', 'Mailer 3']])
  return Buffer.from(await wb.xlsx.writeBuffer())
}
const header = (mime: string, name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi').exec(mime.split('\r\n\r\n')[0]!.replace(/\r\n[ \t]+/g, ' '))?.[1]?.trim() ?? null

let accountId = ''
let templates: string[] = []
const setup = (excelFileId: string, extra: Record<string, unknown> = {}) => ({
  excelFileId,
  sheets: [S1, S2, S3],
  onePer: 'person',
  replyTo: 'bharath@whiteplast.example',
  senderAccountId: accountId,
  templates: templates.map((templateId) => ({ templateId })),
  cc: [],
  startDate: '2026-01-01',
  startTime: '09:00',
  intervalMinutes: 1,
  ...extra,
})

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
  smtp.sent.length = 0
  smtp.script.length = 0
  env.SEND_MODE = 'live'
  clock = Date.now()
  await makeUser('sam@yanthara.example', 'member', 'Sam Sales')
  member = new Client(app.base)
  await member.login('sam@yanthara.example')
  accountId = (await member.post('/api/senders/app-password', { email: SENDER, appPassword: 'abcd efgh ijkl mnop' })).body.id
  templates = []
  for (const n of [1, 2, 3]) {
    templates.push((await member.post('/api/templates', { name: `Mailer ${n}`, subject: `Subject of Mailer ${n}`, bodyHtml: `<p>Dear [First Name],</p><p>This is the text of <b>Mailer ${n}</b>.</p>` })).body.id)
  }
})
afterEach(() => {
  env.SEND_MODE = 'test'
})

const upload = async () => (await member.upload('/api/files/excel', 'Phase1 List.xlsx', await workbook())).body.id as string

describe('each sheet with its own template, in one campaign', () => {
  it('the review gives every sheet\'s people THEIR template, in sheet order, and shows the sheet each came from', async () => {
    const excelFileId = await upload()
    const r = (await member.post('/api/campaigns/review', setup(excelFileId))).body
    expect(r).toMatchObject({ templateOrder: 'by_sheet', sheets: [S1, S2, S3], copyColleagues: false })
    expect(r.counts).toMatchObject({ eligible: 4, duplicate: 1 })
    const rows = r.rows.map((x: { sheet: string; toEmail: string; status: string; templateNumber: number; subject: string; category: string }) => [x.sheet, x.toEmail, x.status, x.templateNumber, x.subject])
    expect(rows).toEqual([
      [S1, 'ann@alpha.example', 'ready', 1, 'Subject of Mailer 1'],
      [S1, 'bob@bravo.example', 'ready', 1, 'Subject of Mailer 1'],
      [S2, 'cy@charlie.example', 'ready', 2, 'Subject of Mailer 2'],
      [S2, 'ann@alpha.example', 'skipped', null, null], // Ann already has the Mailer 1 email in this campaign: never twice
      [S3, 'dee@delta.example', 'ready', 3, 'Subject of Mailer 3'],
    ])
    expect(r.rows[3]).toMatchObject({ category: 'duplicate', reason: expect.stringMatching(/already/i) })
    expect(r.rows[0].html).toContain('Mailer 1')
    expect(r.rows[2].html).toContain('Mailer 2')
    expect(r.rows[4].html).toContain('Mailer 3')
    expect(r.rows[0].html).toContain('Dear Ann,')
    expect(r.rows.every((x: Record<string, unknown>) => !('text' in x))).toBe(true) // the screen only needs the HTML
  })

  it('refuses a sheet without exactly one template, the same sheet twice, a sheet that does not exist, and too many sheets', async () => {
    const excelFileId = await upload()
    const message = async (extra: Record<string, unknown>) => (await member.post('/api/campaigns/review', setup(excelFileId, extra))).body.error?.message as string
    expect(await message({ templates: templates.slice(0, 2).map((templateId) => ({ templateId })) })).toMatch(/Each sheet needs exactly one template/)
    expect(await message({ sheets: [S1, S1, S3] })).toMatch(/listed twice/)
    expect(await message({ sheets: [S1, 'No such sheet', S3] })).toMatch(/no sheet named "No such sheet"/)
    expect(await message({ sheets: ['Summary', S2, S3] })).toMatch(/No "Company" and "Email" columns were found in the sheet "Summary"/)
    expect((await member.post('/api/campaigns/review', { ...setup(excelFileId), sheets: [S1, S2, S3, 'Summary'] })).status).toBe(400)
  })

  it('one approval sends each sheet\'s people their own email, in order, from the app-password account; the record and the report show the sheet', async () => {
    const excelFileId = await upload()
    const started = await member.approve(setup(excelFileId))
    expect(started.status).toBe(201)
    const id = started.body.campaignId as string
    for (let i = 0; i < 6; i++) await tick()
    expect(smtp.sent.map((m) => [m.to[0], header(m.data, 'Subject')])).toEqual([
      ['ann@alpha.example', 'Subject of Mailer 1'],
      ['bob@bravo.example', 'Subject of Mailer 1'],
      ['cy@charlie.example', 'Subject of Mailer 2'],
      ['dee@delta.example', 'Subject of Mailer 3'],
    ])
    expect(header(smtp.sent[0]!.data, 'Reply-To')).toBe('bharath@whiteplast.example')
    const view = (await member.get(`/api/campaigns/${id}`)).body
    expect(view.campaign).toMatchObject({ status: 'completed', templateMode: 'by_sheet', sheetName: `${S1} + ${S2} + ${S3}` })
    expect(view.recipients.map((x: { sheet: string; toEmail: string; status: string }) => [x.sheet, x.toEmail, x.status])).toEqual([
      [S1, 'ann@alpha.example', 'sent'],
      [S1, 'bob@bravo.example', 'sent'],
      [S2, 'cy@charlie.example', 'sent'],
      [S2, 'ann@alpha.example', 'skipped'],
      [S3, 'dee@delta.example', 'sent'],
    ])
    const csv = (await member.get(`/api/campaigns/${id}/report.csv`)).text
    expect(csv).toContain('Row,Sheet,Company,Contact,To')
    expect(csv).toContain(`2,${S1},Bravo Tanks`)
  })

  it('Start is refused if a sheet\'s template is changed after the review', async () => {
    const excelFileId = await upload()
    const reviewed = (await member.post('/api/campaigns/review', setup(excelFileId))).body
    const swapped = [templates[1]!, templates[0]!, templates[2]!].map((templateId) => ({ templateId }))
    const r = await member.post('/api/campaigns/start', { ...setup(excelFileId, { templates: swapped }), confirm: true, reviewFingerprint: reviewed.fingerprint })
    expect(r.status).toBe(409)
    expect(await prisma.campaign.count()).toBe(0)
  })
})
