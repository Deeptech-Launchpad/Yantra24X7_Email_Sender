import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import ExcelJS from 'exceljs'
import { createApp } from '../../src/app.js'
import { createUser, type Role } from '../../src/auth/users.js'
import { prisma } from '../../src/platform/db.js'
import { forgetScans } from '../../src/bulk/companyZip.js'
import { forgetAccessTokens } from '../../src/gmail/oauth.js'

// The real application on a random local port, and a small client for it.

export interface Harness {
  base: string
  close: () => Promise<void>
}

export async function startApp(): Promise<Harness> {
  const server: Server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s))
  })
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

/** Empties every table (between tests). */
export async function resetDb() {
  forgetScans()
  forgetAccessTokens()
  await prisma.recipient.deleteMany()
  for (const t of ['campaign', 'storedFile', 'senderAccount', 'oAuthState', 'template', 'suppression', 'auditEvent', 'lease', 'user'] as const) {
    await (prisma[t] as unknown as { deleteMany: () => Promise<unknown> }).deleteMany()
  }
}

export const PASSWORD = 'correct-horse-42'

export class Client {
  token = ''
  /** This "browser's" cookies (the Gmail sign-in cookie). */
  cookies = new Map<string, string>()
  constructor(readonly base: string) {}

  async login(email: string, password = PASSWORD) {
    const r = await this.req('POST', '/api/auth/login', { email, password })
    this.token = (r.body as { token: string }).token
    return r
  }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const isBytes = Buffer.isBuffer(body)
    const res = await fetch(`${this.base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(body !== undefined ? { 'Content-Type': isBytes ? 'application/octet-stream' : 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isBytes ? new Uint8Array(body as Buffer) : JSON.stringify(body),
    })
    for (const c of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = c.split(';')
      const [k = '', v = ''] = pair.trim().split('=')
      if (!v || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.cookies.delete(k)
      else this.cookies.set(k, v)
    }
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // not JSON
    }
    return { status: res.status, body: parsed as any, headers: res.headers, text }
  }

  get = (p: string) => this.req('GET', p)
  post = (p: string, b: unknown = {}) => this.req('POST', p, b)
  upload = (p: string, name: string, bytes: Buffer) => this.req('POST', p, bytes, { 'X-File-Name': encodeURIComponent(name) })

  /** Reviews a campaign and approves exactly what was reviewed (as the screen does). */
  async approve(setup: Record<string, unknown>) {
    const review = await this.post('/api/campaigns/review', setup)
    return this.post('/api/campaigns/start', { ...setup, confirm: true, ...(review.status === 200 ? { reviewFingerprint: review.body.fingerprint } : {}) })
  }
}

export async function makeUser(email: string, role: Role = 'member', name = 'Test User') {
  return createUser({ email, name, role, password: PASSWORD })
}

export const HEADER = ['Company Name', 'Website', 'Contact Person 1', 'Title 1', 'Email Id1', 'Contact Person 2', 'Title 2', 'Email 2', 'Status']

export async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  rows.forEach((r) => ws.addRow(r))
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** Connects a Gmail account through the REAL OAuth path against the fake Google. Returns the account id. */
export async function connectGmail(c: Client): Promise<string> {
  const start = await c.post('/api/senders/connect')
  if (start.status !== 200) throw new Error(`connect failed: ${JSON.stringify(start.body)}`)
  const state = new URL(start.body.url).searchParams.get('state')!
  const cb = await c.req('GET', `/api/oauth/google/callback?code=good-code&state=${encodeURIComponent(state)}`)
  const loc = cb.headers.get('location') ?? ''
  if (!loc.includes('connected=')) throw new Error(`callback failed: ${decodeURIComponent(loc)}`)
  const list = await c.get('/api/senders')
  return list.body.accounts[0].id
}
