import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '../../src/config/env.js'
import { dispatchTick } from '../../src/bulk/dispatcher.js'
import { startFakeSmtp, type FakeSmtp } from '../helpers/fakeSmtp.js'
import { Client, HEADER, makeUser, resetDb, startApp, xlsx, type Harness } from '../helpers/harness.js'

// CC, end to end, through a FAKE mail server (an account added with an app password): who is in the To and Cc
// headers, and — what really decides who gets a copy — who the mail server is told to deliver to (the envelope).

let app: Harness
let smtp: FakeSmtp
let member: Client
let clock = Date.now()
const tick = async (minutes = 1.05) => {
  clock += minutes * 60_000
  return dispatchTick(new Date(clock))
}

const SENDER = 'sales.team@gmail.example'
const header = (mime: string, name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi').exec(mime.split('\r\n\r\n')[0]!.replace(/\r\n[ \t]+/g, ' '))?.[1]?.trim() ?? null
let accountId = ''
let templateId = ''

const base = (excelFileId: string, extra: Record<string, unknown> = {}) => ({
  excelFileId,
  senderAccountId: accountId,
  templates: [{ templateId }],
  cc: [],
  startDate: '2026-01-01',
  startTime: '09:00',
  intervalMinutes: 1,
  ...extra,
})
// Companies with colleagues: the first named person receives it, the others are copied.
const companies = async () =>
  (await member.upload('/api/files/excel', 'companies.xlsx', await xlsx([
    HEADER,
    ['Alpha Industries', 'a', 'Ann Lee', 'CEO', 'ann@alpha.example', 'Abe Cole', 'CFO', 'abe@alpha.example', ''],
    ['Bravo Ltd', 'b', 'Bob Ray', 'Owner', 'bob@bravo.example', '', '', '', ''],
  ]))).body.id as string
// People: one email each.
const people = async () =>
  (await member.upload('/api/files/excel', 'people.xlsx', await xlsx([
    ['Email', 'First Name', 'Last Name', 'Job Title', 'Company'],
    ['ann@alpha.example', 'Ann', 'Lee', 'CEO', 'Alpha Industries'],
    ['bob@bravo.example', 'Bob', 'Ray', 'Owner', 'Bravo Ltd'],
  ]))).body.id as string
const recipientsOf = (i: number) => smtp.sent[i]!.to

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
  await makeUser('admin@yanthara.example', 'admin', 'Admin')
  await makeUser('sam@yanthara.example', 'member', 'Sam Sales')
  member = new Client(app.base)
  await member.login('sam@yanthara.example')
  accountId = (await member.post('/api/senders/app-password', { email: SENDER, appPassword: 'abcd efgh ijkl mnop' })).body.id
  templateId = (await member.post('/api/templates', { name: 'Intro', subject: 'Hello [Company Name]', bodyHtml: '<p>Hi [First Name],</p><p>Text.</p>' })).body.id
})
afterEach(() => {
  env.SEND_MODE = 'test'
})

describe('CC', () => {
  it('one email per company: the first person is To; colleagues and the extra CC are in Cc AND are delivered to; nobody twice; the To address is never copied', async () => {
    const excel = await companies()
    const cc = ['manager@yantra.example', 'abe@alpha.example', 'ann@alpha.example', 'MANAGER@yantra.example'] // a repeat of a colleague, of the To address, and of itself
    const review = (await member.post('/api/campaigns/review', base(excel, { cc }))).body
    expect(review.cc).toEqual(['manager@yantra.example', 'abe@alpha.example', 'ann@alpha.example']) // lower-cased, no repeats
    expect(review.rows.map((r: { toEmail: string; ccEmails: string[] }) => [r.toEmail, r.ccEmails])).toEqual([
      ['ann@alpha.example', ['abe@alpha.example', 'manager@yantra.example']], // colleague first, then the extra; Ann herself and Abe once only
      ['bob@bravo.example', ['manager@yantra.example', 'abe@alpha.example', 'ann@alpha.example']],
    ])
    expect((await member.approve(base(excel, { cc }))).status).toBe(201)
    for (let i = 0; i < 3; i++) await tick()
    expect(smtp.sent).toHaveLength(2)
    const first = smtp.sent[0]!
    expect(header(first.data, 'To')).toBe('ann@alpha.example')
    expect(header(first.data, 'Cc')).toBe('abe@alpha.example, manager@yantra.example')
    expect(header(first.data, 'Bcc')).toBeNull()
    // The mail server is told to deliver to the To address and every Cc address — exactly once each.
    expect(recipientsOf(0)).toEqual(['ann@alpha.example', 'abe@alpha.example', 'manager@yantra.example'])
    expect(recipientsOf(1)).toEqual(['bob@bravo.example', 'manager@yantra.example', 'abe@alpha.example', 'ann@alpha.example'])
  })

  it('"copy the other contacts" can be switched off: only the extra CC addresses are copied', async () => {
    const excel = await companies()
    await member.approve(base(excel, { cc: ['manager@yantra.example'], copyColleagues: false }))
    await tick()
    expect(header(smtp.sent[0]!.data, 'Cc')).toBe('manager@yantra.example')
    expect(recipientsOf(0)).toEqual(['ann@alpha.example', 'manager@yantra.example'])
  })

  it('one email per person: nobody is copied except the CC you chose', async () => {
    const excel = await people()
    await member.approve(base(excel, { onePer: 'person', cc: ['manager@yantra.example'] }))
    await tick()
    await tick()
    expect(smtp.sent.map((m) => [header(m.data, 'To'), header(m.data, 'Cc'), m.to])).toEqual([
      ['ann@alpha.example', 'manager@yantra.example', ['ann@alpha.example', 'manager@yantra.example']],
      ['bob@bravo.example', 'manager@yantra.example', ['bob@bravo.example', 'manager@yantra.example']],
    ])
  })

  it('without any CC there is no Cc header at all, and the mail server is told to deliver to the person only', async () => {
    const excel = await people()
    await member.approve(base(excel, { onePer: 'person' }))
    await tick()
    expect(header(smtp.sent[0]!.data, 'Cc')).toBeNull()
    expect(header(smtp.sent[0]!.data, 'To')).toBe('ann@alpha.example')
    expect(recipientsOf(0)).toEqual(['ann@alpha.example'])
  })

  it('a CC address put on the do-not-email list after approval is left out of the header AND of the delivery', async () => {
    const excel = await companies()
    await member.approve(base(excel, { cc: ['manager@yantra.example'] }))
    await member.post('/api/suppressions', { values: ['manager@yantra.example', 'abe@alpha.example'] })
    await tick()
    expect(header(smtp.sent[0]!.data, 'Cc')).toBeNull()
    expect(recipientsOf(0)).toEqual(['ann@alpha.example'])
  })

  it('a bad CC address, or more than 10, is refused before anything is approved', async () => {
    const excel = await companies()
    const msg = async (cc: string[]) => (await member.post('/api/campaigns/review', base(excel, { cc }))).body.error?.message as string
    expect(await msg(['not an address'])).toMatch(/not a valid CC address/)
    expect(await msg(['a b@c.example'])).toMatch(/not a valid CC address/)
    expect(await msg(Array.from({ length: 11 }, (_, i) => `cc${i}@yantra.example`))).toBeTruthy() // too many (refused by the request check)
    expect(await msg(['ok@yantra.example\r\nBcc: evil@x.example'])).toMatch(/not a valid CC address/) // a header cannot be smuggled in
  })
})
