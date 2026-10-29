import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { env } from '../../src/config/env.js'
import { open, seal } from '../../src/platform/secretBox.js'
import { csvCell } from '../../src/bulk/campaigns.js'
import { Client, HEADER, makeUser, PASSWORD, resetDb, startApp, xlsx, type Harness } from '../helpers/harness.js'

// SIGN-IN, ROLES AND THE EDGES AN ATTACKER WOULD TRY.

let app: Harness
let admin: Client

beforeAll(async () => {
  app = await startApp()
})
afterAll(async () => {
  await app.close()
})
beforeEach(async () => {
  await resetDb()
  await makeUser('admin@yanthara.example', 'admin', 'Admin')
  admin = new Client(app.base)
  await admin.login('admin@yanthara.example')
})

describe('signing in', () => {
  it('a wrong password and an unknown email get the same answer; a session is needed for everything else', async () => {
    const c = new Client(app.base)
    const a = await c.req('POST', '/api/auth/login', { email: 'admin@yanthara.example', password: 'wrong-password-1' })
    const b = await c.req('POST', '/api/auth/login', { email: 'nobody@yanthara.example', password: 'wrong-password-1' })
    expect([a.status, b.status]).toEqual([401, 401])
    expect(a.body.error.message).toBe(b.body.error.message)
    for (const p of ['/api/campaigns', '/api/senders', '/api/templates', '/api/config', '/api/users']) expect((await c.get(p)).status).toBe(401)
    expect((await admin.get('/api/auth/me')).body.user).toMatchObject({ email: 'admin@yanthara.example', role: 'admin' })
  })

  it('a token that is forged, expired, or from another issuer is refused; a disabled account stops at once', async () => {
    const c = new Client(app.base)
    const user = (await admin.get('/api/users')).body.users[0]
    c.token = jwt.sign({}, 'not-the-secret', { subject: user.id, issuer: 'yanthara-bulk-email' })
    expect((await c.get('/api/auth/me')).status).toBe(401)
    c.token = jwt.sign({}, env.SESSION_SECRET, { subject: user.id, issuer: 'yanthara-bulk-email', expiresIn: -10 })
    expect((await c.get('/api/auth/me')).status).toBe(401)
    c.token = jwt.sign({}, env.SESSION_SECRET, { subject: user.id, issuer: 'another-app' })
    expect((await c.get('/api/auth/me')).status).toBe(401)
    const sam = await makeUser('sam@yanthara.example', 'member')
    const s = new Client(app.base)
    await s.login('sam@yanthara.example')
    expect((await admin.req('PATCH', `/api/users/${sam.id}`, { status: 'disabled' })).status).toBe(200)
    expect((await s.get('/api/auth/me')).status).toBe(403)
    expect((await s.req('POST', '/api/auth/login', { email: 'sam@yanthara.example', password: PASSWORD })).status).toBe(403)
  })

  it('users: only admins manage them; passwords must be strong; the last admin cannot be removed', async () => {
    const sam = await makeUser('sam@yanthara.example', 'member')
    const s = new Client(app.base)
    await s.login('sam@yanthara.example')
    expect((await s.get('/api/users')).status).toBe(403)
    expect((await admin.post('/api/users', { email: 'new@yanthara.example', name: 'New', role: 'member', password: 'short' })).status).toBe(400)
    expect((await admin.post('/api/users', { email: 'new@yanthara.example', name: 'New', role: 'member', password: 'long-enough-password-1' })).status).toBe(201)
    expect((await admin.post('/api/users', { email: 'new@yanthara.example', name: 'New', role: 'member', password: 'long-enough-password-1' })).status).toBe(409)
    const me = (await admin.get('/api/auth/me')).body.user
    expect((await admin.req('PATCH', `/api/users/${me.id}`, { role: 'member' })).status).toBe(400)
    expect((await admin.req('PATCH', `/api/users/${sam.id}`, { role: 'superadmin' })).status).toBe(400)
    const list = (await admin.get('/api/users')).body.users
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|\$2[aby]\$/)
  })
})

describe('files and inputs', () => {
  it('uploads: only .xlsx for the list, no programs as attachments, sizes enforced, names checked', async () => {
    expect((await admin.upload('/api/files/excel', 'list.csv', Buffer.from('a,b'))).status).toBe(400)
    expect((await admin.upload('/api/files/excel', 'list.xlsx', Buffer.from('not really excel'))).body.error.message).toMatch(/not an \.xlsx file/)
    expect((await admin.upload('/api/files/excel', 'list.xlsx', await xlsx([HEADER]))).status).toBe(201)
    expect((await admin.upload('/api/files/attachments', 'run.exe', Buffer.from('MZ'))).body.error.message).toMatch(/\.exe files cannot be attached/)
    expect((await admin.upload('/api/files/attachments', 'page.html', Buffer.from('<script>'))).status).toBe(400)
    expect((await admin.upload('/api/files/attachments', '../../etc/passwd', Buffer.from('x'))).status).toBe(400)
    expect((await admin.upload('/api/files/attachments', 'big.pdf', Buffer.alloc(11 * 1024 * 1024))).body.error.message).toMatch(/larger than 10 MB/)
    expect((await admin.req('POST', '/api/files/attachments', { fileName: 'x.pdf' })).status).toBe(400) // JSON instead of the file
  })

  it('a staged file belongs to the person who uploaded it; ids cannot point outside the folder', async () => {
    await makeUser('sam@yanthara.example', 'member')
    const sam = new Client(app.base)
    await sam.login('sam@yanthara.example')
    const f = (await sam.upload('/api/files/attachments', 'mine.pdf', Buffer.from('%PDF-1.4 x'))).body
    await makeUser('olga@yanthara.example', 'member')
    const olga = new Client(app.base)
    await olga.login('olga@yanthara.example')
    expect((await olga.req('DELETE', `/api/files/${f.id}`)).status).toBe(403)
    expect((await olga.req('DELETE', '/api/files/..%2F..%2Fdb')).status).toBe(404)
    expect((await sam.req('DELETE', `/api/files/${f.id}`)).status).toBe(200)
  })

  it('unknown fields are refused, the API answers in JSON for unknown routes', async () => {
    expect((await admin.post('/api/templates', { name: 'x', subject: 's', bodyHtml: '<p>b</p>', extra: 1 })).status).toBe(400)
    const r = await admin.get('/api/nothing-here')
    expect([r.status, r.body.error.code]).toEqual([404, 'not_found'])
  })

  it('security headers are set', async () => {
    const r = await fetch(`${app.base}/health`)
    expect(r.headers.get('content-security-policy')).toMatch(/default-src 'self'/)
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('x-powered-by')).toBeNull()
  })
})

describe('secrets and reports', () => {
  it('a sealed secret is unreadable without the key and any change to it is detected', () => {
    const s = seal('refresh-token-xyz')
    expect(s).not.toContain('refresh-token-xyz')
    expect(open(s)).toBe('refresh-token-xyz')
    const parts = s.split('.')
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith('A') ? 'B' : 'A') + parts[3]!.slice(-1)
    expect(() => open(parts.join('.'))).toThrow()
    expect(seal('same')).not.toBe(seal('same')) // a fresh IV every time
  })

  it('report cells can never run as spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`)
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('-2')).toBe("'-2")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('a, b')).toBe('"a, b"')
    expect(csvCell(null)).toBe('')
    expect(csvCell('Alpha Industries')).toBe('Alpha Industries')
  })
})
