import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from './App'
import { setToken } from './api'

// The screens against a stub of the API: sign-in, the four steps of a new campaign, the
// approval gate, campaign actions, sender accounts and roles.

interface Call {
  method: string
  url: string
  body: any
}
let calls: Call[] = []
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.url === `/api${path}`)

const CONFIG = {
  companyName: 'Yanthara',
  sendMode: 'test',
  timezone: 'Asia/Kolkata',
  minIntervalMinutes: 1,
  googleConfigured: true,
  tracking: { enabled: false, reason: 'Open tracking is off.' },
  readonlyCheck: false,
  limits: { maxCommonFiles: 5, maxFileBytes: 10485760, maxEmailAttachmentBytes: 18874368, maxZipBytes: 1073741824, maxExcelBytes: 5242880, maxCc: 10, maxTemplates: 3 },
}
const ACCOUNT = { id: 'acc1', email: 'sales.one@yanthara.example', displayName: 'Sam', authType: 'oauth', status: 'connected', statusReason: null, signatureHtml: '', dailyLimit: 400, sentLast24h: 3, remainingToday: 397, shared: false, connectedByUserId: 'u1', usable: true, canSend: true, canCheckSent: false }
const ROWS: any[] = [
  { position: 0, companyName: 'Alpha Industries', contactName: 'Ann Lee', toEmail: 'ann@alpha.example', ccEmails: ['abe@alpha.example'], status: 'ready', category: null, reason: null, subject: 'A proposal for Alpha Industries', html: '<div><p>Hi Ann,</p><script>alert(1)</script><img src="x" onerror="alert(1)"></div>', templateNumber: null, companyFile: null, note: null, scheduledLocal: 'now' },
  { position: 1, companyName: 'Bravo Ltd', contactName: 'Bob Ray', toEmail: 'bob@bravo.example', ccEmails: [], status: 'ready', category: null, reason: null, subject: 'A proposal for Bravo Ltd', html: '<p>Hi Bob,</p>', templateNumber: null, companyFile: null, note: null, scheduledLocal: 'later' },
  { position: 2, companyName: 'Echo LLC', contactName: 'Eve', toEmail: 'eve@echo.example', ccEmails: [], status: 'skipped', category: 'excluded', reason: 'Already contacted', subject: null, html: null, templateNumber: null, companyFile: null, note: null, scheduledLocal: null },
]
function reviewFor(body: any, opts: { blocked?: boolean }) {
  const excluded = new Set<number>(body.excludePositions ?? [])
  let rows = ROWS.map((r) => (excluded.has(r.position) ? { ...r, status: 'skipped', category: 'excluded', reason: 'Excluded by you on the review.' } : r))
  if (opts.blocked && body.companyZipId && !body.excludeUnmatched) rows = rows.map((r) => (r.position === 1 ? { ...r, status: 'blocked', reason: 'No PDF in the ZIP is named after this company.', companyFile: { status: 'missing', fileName: null, detail: 'missing' } } : r))
  if (opts.blocked && body.companyZipId && body.excludeUnmatched) rows = rows.map((r) => (r.position === 1 ? { ...r, status: 'skipped', category: 'excluded', reason: 'Excluded — missing' } : r))
  const n = (s: string) => rows.filter((r) => r.status === s).length
  return {
    fingerprint: 'f'.repeat(64),
    counts: { rowsWithCompany: 3, companies: 3, eligible: n('ready'), invalid: 0, duplicate: 0, excluded: rows.filter((r) => r.category === 'excluded').length, blocked: n('blocked') },
    rows,
    noAddress: [],
    templates: [{ number: 1, subject: 'A proposal for [Company Name]', removed: [] }],
    templateOrder: null,
    cc: body.cc ?? [],
    replyTo: body.replyTo ?? null,
    onePer: body.onePer ?? 'company',
    sheet: 'Sheet1',
    copyColleagues: body.copyColleagues,
    sender: { id: 'acc1', email: ACCOUNT.email, ready: true, problems: [], remainingToday: 397, dailyLimit: 400 },
    sendMode: 'test',
    attachments: [],
    companyZip: body.companyZipId ? { fileName: 'pdfs.zip', files: [], problems: [], counts: { matched: 1, missing: opts.blocked ? 1 : 0, ambiguous: 0, invalid: 0, tooLarge: 0, excluded: 0, unused: 0 } } : null,
    blockedProblem: n('blocked') ? `${n('blocked')} recipient has no usable company PDF.` : null,
    schedule: { timezone: 'Asia/Kolkata', firstLocal: 'Tue, Nov 3, 2026, 10:00 AM', lastLocal: 'Tue, Nov 3, 2026, 10:02 AM', intervalMinutes: body.intervalMinutes, limitNote: null },
  }
}

function stub(opts: { role?: string; blocked?: boolean; campaign?: any } = {}) {
  calls = []
  const zipGot: Record<string, number> = {}
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const u = String(url)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body ? { blob: (init.body as Blob).size } : null
    calls.push({ method, url: u, body })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    const p = u.replace(/\?.*$/, '')
    if (p === '/api/auth/login') return body.password === 'right-password-1' ? json({ token: 't1', user: {} }) : json({ error: { message: 'The email or the password is not right.' } }, 401)
    if (p === '/api/auth/me') return json({ user: { id: 'u1', email: 'sam@yanthara.example', name: 'Sam Sales', role: opts.role ?? 'member' } })
    if (p === '/api/config') return json(CONFIG)
    if (p === '/api/campaigns' && method === 'GET') return json({ campaigns: [] })
    if (p === '/api/senders' && method === 'GET') return json({ accounts: [ACCOUNT], googleConfigured: true })
    if (p === '/api/senders/connect') return json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc' })
    if (p === '/api/senders/app-password') return json({ ...ACCOUNT, id: 'acc2', email: body.email, authType: 'app_password', displayName: body.displayName ?? null }, 201)
    if (p === '/api/templates' && method === 'GET') return json({ templates: [{ id: 'tpl1', name: 'Intro', subject: 'A proposal for [Company Name]', bodyHtml: '<p>Hi [First Name]</p>', createdByUserId: 'u1', updatedAt: '' }] })
    if (p === '/api/files/excel') return json({ id: 'xls1', fileName: 'Leads.xlsx', sizeBytes: 6000 }, 201)
    if (p === '/api/campaigns/analyze') return json({ file: { id: 'xls1', fileName: 'Leads.xlsx', sizeBytes: 6000 }, sheets: ['Summary', 'Mailer 1 - Discovery'], sheet: body.sheet ?? 'Mailer 1 - Discovery', onePer: body.onePer ?? 'company', totalRows: 4, companies: [{ companyName: 'Alpha', people: [{ email: 'a@a.example' }], skip: null }, { companyName: 'Bravo', people: [{ email: 'b@b.example' }], skip: null }, { companyName: 'Echo', people: [{ email: 'e@e.example' }], skip: 'Already contacted' }], noAddress: [{ row: 5, companyName: 'Delta', reason: 'No email address' }], duplicates: [], columns: {} })
    if (p === '/api/files/attachments') return json({ id: 'att1', fileName: 'Brochure.pdf', sizeBytes: 2048 }, 201)
    if (p === '/api/files/zip/start') return json({ id: 'zip1', chunkBytes: 1024, fileName: body.fileName, sizeBytes: body.sizeBytes }, 201)
    if (/^\/api\/files\/zip\/zip1\/chunk$/.test(p)) {
      zipGot.zip1 = (zipGot.zip1 ?? 0) + body.blob
      return json({ receivedBytes: zipGot.zip1 })
    }
    if (p === '/api/files/zip/zip1/finish') return json({ id: 'zip1', fileName: 'pdfs.zip', sizeBytes: zipGot.zip1 }, 201)
    if (p === '/api/campaigns/review') return json(reviewFor(body, opts))
    if (p === '/api/campaigns/start') return json({ campaignId: 'c1', scheduled: 2 }, 201)
    if (p === '/api/campaigns/c1') return json(opts.campaign ?? CAMPAIGN)
    if (p.startsWith('/api/campaigns/c1/')) return json({ retried: 1, skipped: 0, status: 'failed' })
    return json({ error: { message: 'none' } }, 404)
  })
}

const CAMPAIGN = {
  campaign: { id: 'c1', name: 'Leads — Nov 3', status: 'completed', statusReason: null, sendMode: 'test', createdByUserId: 'u1', fromEmail: ACCOUNT.email, replyTo: null, recipientMode: 'company', sheetName: 'Sheet1', cc: ['manager@yanthara.example'], copyColleagues: true, intervalMinutes: 2, startLocal: 'Tue, Nov 3, 2026, 10:00 AM', sourceFileName: 'Leads.xlsx', companyZipName: null, templates: [{ number: 1, subject: 'A proposal for [Company Name]' }], review: { totalRows: 3, eligible: 2, invalid: 0, duplicate: 0, excluded: 1 } },
  counts: { scheduled: 0, sending: 0, sent: 1, failed: 1, unknown: 1, skipped: 1, cancelled: 0, skippedInvalid: 0, skippedDuplicate: 0, skippedExcluded: 1, total: 4, opens: { tracked: 0, opened: 0 } },
  attachments: [{ id: 'att1', fileName: 'Brochure.pdf', sizeBytes: 2048 }],
  recipients: [
    { id: 'r1', position: 0, companyName: 'Alpha Industries', contactName: 'Ann', toEmail: 'ann@alpha.example', cc: [], status: 'sent', category: null, reason: null, subject: 'S', templateNumber: null, companyFile: null, attempts: 1, scheduledLocal: null, sentLocal: '10:00', openCount: 0, trackingEnabled: false },
    { id: 'r2', position: 1, companyName: 'Bravo Ltd', contactName: 'Bob', toEmail: 'bob@bravo.example', cc: [], status: 'failed', category: null, reason: 'Gmail rejected the email: Invalid To header', subject: 'S', templateNumber: null, companyFile: null, attempts: 1, scheduledLocal: null, sentLocal: null, openCount: 0, trackingEnabled: false },
    { id: 'r3', position: 2, companyName: 'Charlie Corp', contactName: 'Cy', toEmail: 'cy@charlie.example', cc: [], status: 'unknown', category: null, reason: 'Gmail did not confirm the email.', subject: 'S', templateNumber: null, companyFile: null, attempts: 1, scheduledLocal: null, sentLocal: null, openCount: 0, trackingEnabled: false },
  ],
  tracking: { enabled: false, reason: 'Open tracking is off.' },
  canCheckSent: false,
}

const signedIn = async (path = '/campaigns') => {
  setToken('t1')
  window.history.pushState({}, '', path)
  render(<App />)
  await screen.findByRole('navigation', { name: 'Main' })
}

beforeEach(() => {
  window.history.pushState({}, '', '/')
})

describe('signing in', () => {
  it('a wrong password is said in words; the right one opens the app, in TEST MODE with the orange banner', async () => {
    stub()
    render(<App />)
    await userEvent.type(screen.getByLabelText('Email'), 'sam@yanthara.example')
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The email or the password is not right.')
    await userEvent.clear(screen.getByLabelText('Password'))
    await userEvent.type(screen.getByLabelText('Password'), 'right-password-1')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(/TEST MODE — no email is sent/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Campaigns' })).toBeInTheDocument()
  })
})

describe('a new campaign, step by step', () => {
  const toEmailStep = async () => {
    await signedIn('/campaigns/new')
    await userEvent.upload(screen.getByLabelText('Excel file'), new File(['PK..'], 'Leads.xlsx'))
    expect(await screen.findByText('With a usable address')).toBeInTheDocument()
    expect(screen.getByText(/Row 5, Delta: No email address/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Next: email' }))
    await screen.findByRole('heading', { name: 'Send from' })
  }

  it('recipients → email → review → approve: the request carries everything chosen, and nothing starts without the explicit confirmation', async () => {
    stub()
    await toEmailStep()
    const next = screen.getByRole('button', { name: /Next: review every email/ })
    expect(next).toBeDisabled() // no sender, no template yet
    await userEvent.selectOptions(screen.getByLabelText('Sender account'), 'acc1')
    await userEvent.selectOptions(await screen.findByLabelText('Saved template 1'), 'tpl1')
    await userEvent.type(screen.getByLabelText('CC address'), 'manager@yanthara.example{Enter}')
    await userEvent.upload(screen.getByLabelText('Choose files to attach'), new File(['%PDF'], 'Brochure.pdf', { type: 'application/pdf' }))
    expect(await screen.findByText('Brochure.pdf')).toBeInTheDocument()
    await userEvent.click(next)

    expect(await screen.findByText('Will be sent')).toBeInTheDocument()
    const preview = screen.getByLabelText('Email preview')
    expect(within(preview).getByText('A proposal for Alpha Industries')).toBeInTheDocument()
    const content = within(preview).getByLabelText('Email content')
    expect(content.innerHTML).toContain('Hi Ann,')
    expect(content.innerHTML).not.toMatch(/script|onerror/) // a preview can never run code
    const review = posts('/campaigns/review').at(-1)!.body
    expect(review).toMatchObject({ excelFileId: 'xls1', senderAccountId: 'acc1', templates: [{ templateId: 'tpl1' }], cc: ['manager@yanthara.example'], copyColleagues: true, attachmentIds: ['att1'], excludePositions: [] })

    // Leave one recipient out by hand: reviewed again with that exclusion.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Send to Bravo Ltd' }))
    await waitFor(() => expect(posts('/campaigns/review').at(-1)!.body.excludePositions).toEqual([1]))

    await userEvent.click(screen.getByRole('button', { name: /Next: schedule & approve/ }))
    const approve = await screen.findByRole('button', { name: 'Approve and start sending' })
    expect(await screen.findByText(/I reviewed these 1 emails/)).toBeInTheDocument()
    expect(approve).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: /I reviewed these 1 emails/ }))
    expect(approve).toBeEnabled()
    await userEvent.click(approve)
    await waitFor(() => expect(posts('/campaigns/start')).toHaveLength(1))
    expect(posts('/campaigns/start')[0]!.body).toMatchObject({ confirm: true, reviewFingerprint: 'f'.repeat(64), excludePositions: [1], templates: [{ templateId: 'tpl1' }], senderAccountId: 'acc1' })
    expect(await screen.findByRole('heading', { name: 'Leads — Nov 3 TEST' })).toBeInTheDocument() // the campaign page, marked as approved in test mode
  })

  it('a list of people: the sheet, one email per person and a reply-to address are part of the review and the approval', async () => {
    stub()
    await signedIn('/campaigns/new')
    await userEvent.upload(screen.getByLabelText('Excel file'), new File(['PK..'], 'List.xlsx'))
    expect(await screen.findByText('With a usable address')).toBeInTheDocument()
    expect(screen.getByLabelText('Sheet')).toHaveValue('Mailer 1 - Discovery') // the server's choice: not the summary sheet
    await userEvent.click(screen.getByRole('radio', { name: /One email per person/ }))
    await waitFor(() => expect(posts('/campaigns/analyze').at(-1)!.body).toMatchObject({ onePer: 'person', sheet: 'Mailer 1 - Discovery' }))
    expect(await screen.findByText('People')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Next: email' }))
    await userEvent.selectOptions(await screen.findByLabelText('Sender account'), 'acc1')
    await userEvent.selectOptions(await screen.findByLabelText('Saved template 1'), 'tpl1')
    expect(screen.queryByText(/Copy the other contacts of the same company/)).toBeNull() // nobody is copied per person
    await userEvent.type(screen.getByLabelText(/Replies go to/), 'bharath@whiteplast.example')
    await userEvent.click(screen.getByRole('button', { name: /Next: review every email/ }))
    expect(await screen.findByText('Reply-To bharath@whiteplast.example')).toBeInTheDocument()
    expect(posts('/campaigns/review').at(-1)!.body).toMatchObject({ sheet: 'Mailer 1 - Discovery', onePer: 'person', replyTo: 'bharath@whiteplast.example' })
    await userEvent.click(screen.getByRole('button', { name: /Next: schedule & approve/ }))
    expect(await screen.findByText(/one email per person/)).toBeInTheDocument()
    expect(screen.getAllByText('bharath@whiteplast.example').length).toBeGreaterThan(0)
  })

  it('a template can be written for the campaign; two templates offer in-order or random', async () => {
    stub()
    await toEmailStep()
    await userEvent.selectOptions(screen.getByLabelText('Sender account'), 'acc1')
    await userEvent.click(screen.getAllByRole('radio', { name: 'Write one for this campaign' })[0]!)
    await userEvent.type(screen.getByLabelText('Template 1 subject'), 'Hello [[Company Name]')
    const box = screen.getByRole('textbox', { name: 'Template 1 body' })
    box.innerHTML = '<p>Hi [First Name]</p>'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await userEvent.click(screen.getByRole('button', { name: 'Add another template' }))
    await userEvent.selectOptions(screen.getByLabelText('Saved template 2'), 'tpl1')
    await userEvent.click(screen.getByRole('radio', { name: /Random/ }))
    await userEvent.click(screen.getByRole('button', { name: /Next: review every email/ }))
    await screen.findByText('Will be sent')
    const b = posts('/campaigns/review').at(-1)!.body
    expect(b.templates).toEqual([{ subject: 'Hello [Company Name]', bodyHtml: '<p>Hi [First Name]</p>' }, { templateId: 'tpl1' }])
    expect(b.templateOrder).toBe('random')
    expect(Number.isInteger(b.shuffleSeed)).toBe(true)
  })

  it('company ZIP: uploaded in pieces with progress; a recipient without a PDF blocks the campaign until explicitly excluded', async () => {
    stub({ blocked: true })
    await toEmailStep()
    await userEvent.selectOptions(screen.getByLabelText('Sender account'), 'acc1')
    await userEvent.selectOptions(await screen.findByLabelText('Saved template 1'), 'tpl1')
    await userEvent.upload(screen.getByLabelText('Choose the ZIP of company PDFs'), new File([new Uint8Array(3000)], 'pdfs.zip', { type: 'application/zip' }))
    expect(await screen.findByText('pdfs.zip')).toBeInTheDocument()
    expect(calls.filter((c) => c.url.startsWith('/api/files/zip/zip1/chunk')).map((c) => c.url)).toEqual(['/api/files/zip/zip1/chunk?offset=0', '/api/files/zip/zip1/chunk?offset=1024', '/api/files/zip/zip1/chunk?offset=2048'])
    await userEvent.click(screen.getByRole('button', { name: /Next: review every email/ }))
    expect(await screen.findByText('1 recipient has no usable company PDF.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Next: schedule & approve/ })).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: /Exclude the recipients without a usable PDF/ }))
    await waitFor(() => expect(posts('/campaigns/review').at(-1)!.body).toMatchObject({ companyZipId: 'zip1', excludeUnmatched: true }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Next: schedule & approve/ })).toBeEnabled())
  })

  it('a viewer cannot create campaigns (no link, and the page says so)', async () => {
    stub({ role: 'viewer' })
    await signedIn('/campaigns/new')
    expect(screen.queryByRole('link', { name: 'New campaign' })).not.toBeInTheDocument()
    expect(screen.getByText(/Your role \(viewer\) cannot create campaigns/)).toBeInTheDocument()
  })
})

describe('a campaign', () => {
  it('shows each recipient with the reason, retries failed emails, and asks before resolving an unknown outcome', async () => {
    stub()
    await signedIn('/campaigns/c1')
    expect(await screen.findByText('Gmail rejected the email: Invalid To header')).toBeInTheDocument()
    expect(screen.getByText(/Gmail did not confirm them; they may have been sent/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry failed' }))
    await waitFor(() => expect(posts('/campaigns/c1/retry')).toHaveLength(1))
    expect(await screen.findByText(/1 failed emails scheduled again/)).toBeInTheDocument()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    await userEvent.click(screen.getByRole('button', { name: 'Not sent' }))
    expect(posts('/campaigns/c1/recipients/r3/resolve')).toHaveLength(0) // declined: nothing changed
    await userEvent.click(screen.getByRole('button', { name: 'Not sent' }))
    await waitFor(() => expect(posts('/campaigns/c1/recipients/r3/resolve')[0]!.body).toEqual({ outcome: 'not_sent' }))
    confirm.mockRestore()
  })
})

describe('sender accounts', () => {
  it('"Connect Gmail" goes to Google; a failed connection is explained', async () => {
    stub()
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { value: { ...window.location, assign, pathname: '/senders', search: '?error=Access%20was%20not%20allowed' }, writable: true, configurable: true })
    await signedIn('/senders?error=Access%20was%20not%20allowed')
    expect(await screen.findByText(/The account was not connected: Access was not allowed/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'sales.one@yanthara.example' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Connect Gmail' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=abc'))
  })

  it('an account can be added with an app password: typed in a hidden field, sent once, never shown', async () => {
    stub()
    await signedIn('/senders')
    await userEvent.click(await screen.findByRole('button', { name: 'Add with app password' }))
    const pw = screen.getByLabelText('App password')
    expect(pw).toHaveAttribute('type', 'password')
    await userEvent.type(screen.getByLabelText('Gmail address'), 'sales.team@gmail.example')
    await userEvent.type(pw, 'abcd efgh ijkl mnop')
    await userEvent.type(screen.getByLabelText(/Sender name/), 'Sales Team')
    await userEvent.click(screen.getByRole('button', { name: 'Check and add' }))
    await waitFor(() => expect(posts('/senders/app-password')).toHaveLength(1))
    expect(posts('/senders/app-password')[0]!.body).toEqual({ email: 'sales.team@gmail.example', appPassword: 'abcd efgh ijkl mnop', displayName: 'Sales Team' })
    expect(await screen.findByText(/sales\.team@gmail\.example can now send with its app password/)).toBeInTheDocument()
    expect(screen.queryByLabelText('App password')).toBeNull() // the form is gone, and with it the password
    expect(document.body.textContent).not.toContain('abcd efgh')
  })
})
