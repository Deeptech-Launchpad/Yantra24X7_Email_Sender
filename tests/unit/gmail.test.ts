import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '../../src/config/env.js'
import { prisma } from '../../src/platform/db.js'
import { open } from '../../src/platform/secretBox.js'
import { classifyGmailError } from '../../src/gmail/api.js'
import { startFakeGoogle, type FakeGoogle } from '../helpers/fakeGoogle.js'
import { Client, connectGmail, makeUser, resetDb, startApp, type Harness } from '../helpers/harness.js'

// GMAIL SENDER ACCOUNTS: authorization with Google (against a fake Google — nothing real is contacted).

let app: Harness
let google: FakeGoogle
let member: Client

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
  Object.assign(google.tokenScript, { scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send', email: 'sales.one@yanthara.example', emailVerified: true, refreshToken: 'refresh-token-1', refreshError: null, aud: undefined })
  google.revoked.length = 0
  env.GMAIL_READONLY_CHECK = false
  await makeUser('admin@yanthara.example', 'admin')
  await makeUser('sam@yanthara.example', 'member')
  member = new Client(app.base)
  await member.login('sam@yanthara.example')
})

const startState = async () => {
  const r = await member.post('/api/senders/connect')
  expect(r.status).toBe(200)
  return new URL(r.body.url)
}
const callback = (q: string) => member.req('GET', `/api/oauth/google/callback?${q}`)
const errorOf = (res: { headers: Headers }) => decodeURIComponent(new URL(res.headers.get('location')!).searchParams.get('error') ?? '')

describe('connecting a Gmail account', () => {
  it('sends the person to Google asking only to send (plus who they are), with PKCE and a state; the callback stores the account with the token ENCRYPTED', async () => {
    const url = await startState()
    expect(url.origin + url.pathname).toBe(`${google.base}/auth`)
    expect(url.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/gmail.send')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:4300/api/oauth/google/callback')
    const res = await callback(`code=good-code&state=${url.searchParams.get('state')}`)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('http://localhost:4300/senders?connected=sales.one%40yanthara.example')
    const acc = await prisma.senderAccount.findFirstOrThrow()
    expect(acc).toMatchObject({ email: 'sales.one@yanthara.example', status: 'connected', dailyLimit: env.DEFAULT_DAILY_LIMIT })
    expect(acc.refreshTokenEnc).not.toContain('refresh-token-1') // never stored in clear
    expect(open(acc.refreshTokenEnc)).toBe('refresh-token-1')
    const list = (await member.get('/api/senders')).body
    expect(list.accounts[0]).toMatchObject({ email: 'sales.one@yanthara.example', usable: true, canSend: true, canCheckSent: false })
    expect(JSON.stringify(list)).not.toMatch(/refresh|access-1/) // no token ever leaves the server
  })

  it('a sign-in can only be finished in the browser that started it (a short-lived httpOnly cookie, sent only to the callback)', async () => {
    const started = await member.post('/api/senders/connect')
    expect(started.headers.get('set-cookie')).toMatch(/^yb_oauth=[A-Za-z0-9_-]{43}; Path=\/api\/oauth; Max-Age=600; HttpOnly; SameSite=Lax$/)
    expect(JSON.stringify(started.body)).not.toContain(member.cookies.get('yb_oauth')!) // the nonce is not in the page's reach
    const state = new URL(started.body.url).searchParams.get('state')!
    const elsewhere = new Client(app.base) // another browser: it has the link but not the cookie
    expect(errorOf(await elsewhere.req('GET', `/api/oauth/google/callback?code=good-code&state=${state}`))).toMatch(/started in another browser/)
    expect(await prisma.senderAccount.count()).toBe(0)
    // The attempt used the sign-in up: even the right browser must start again.
    expect(errorOf(await callback(`code=good-code&state=${state}`))).toMatch(/expired or was already used/)
    const again = await startState()
    expect((await callback(`code=good-code&state=${again.searchParams.get('state')}`)).headers.get('location')).toMatch(/connected=/)
    expect(member.cookies.has('yb_oauth')).toBe(false) // cleared by the callback
  })

  it('a state can be used once; an unknown, reused or expired state connects nothing', async () => {
    const url = await startState()
    const state = url.searchParams.get('state')!
    expect((await callback(`code=good-code&state=${state}`)).headers.get('location')).toMatch(/connected=/)
    expect(errorOf(await callback(`code=good-code&state=${state}`))).toMatch(/expired or was already used/)
    expect(errorOf(await callback('code=good-code&state=made-up'))).toMatch(/expired or was already used/)
    const url2 = await startState()
    await prisma.oAuthState.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(errorOf(await callback(`code=good-code&state=${url2.searchParams.get('state')}`))).toMatch(/expired/)
  })

  it('refuses: access denied on Google\'s page, a bad code, no send permission, an unverified email, a token issued to another app', async () => {
    expect(errorOf(await callback('error=access_denied&state=x'))).toMatch(/Access was not allowed/)
    let u = await startState()
    expect(errorOf(await callback(`code=bad-code&state=${u.searchParams.get('state')}`))).toMatch(/Google did not accept the sign-in/)
    google.tokenScript.scope = 'openid email'
    u = await startState()
    expect(errorOf(await callback(`code=good-code&state=${u.searchParams.get('state')}`))).toMatch(/Permission to send email was not given/)
    google.tokenScript.scope = 'openid email https://www.googleapis.com/auth/gmail.send'
    google.tokenScript.emailVerified = false
    u = await startState()
    expect(errorOf(await callback(`code=good-code&state=${u.searchParams.get('state')}`))).toMatch(/did not confirm which email address/)
    google.tokenScript.emailVerified = true
    google.tokenScript.aud = 'someone-elses-client'
    u = await startState()
    expect(errorOf(await callback(`code=good-code&state=${u.searchParams.get('state')}`))).toMatch(/did not confirm which email address/)
    expect(await prisma.senderAccount.count()).toBe(0)
  })

  it('a viewer cannot connect; Google not configured is said in words', async () => {
    await makeUser('vic@yanthara.example', 'viewer')
    const viewer = new Client(app.base)
    await viewer.login('vic@yanthara.example')
    expect((await viewer.post('/api/senders/connect')).status).toBe(403)
    const id = env.GOOGLE_CLIENT_ID
    env.GOOGLE_CLIENT_ID = ''
    const r = await member.post('/api/senders/connect')
    env.GOOGLE_CLIENT_ID = id
    expect([r.status, r.body.error.message]).toEqual([409, expect.stringMatching(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing/)])
  })

  it('reconnecting refreshes the permission of the same account (no duplicate); the readonly permission is asked only when switched on', async () => {
    await connectGmail(member)
    google.tokenScript.refreshToken = 'refresh-token-NEW'
    await connectGmail(member)
    const all = await prisma.senderAccount.findMany()
    expect(all).toHaveLength(1)
    expect(open(all[0]!.refreshTokenEnc)).toBe('refresh-token-NEW')
    env.GMAIL_READONLY_CHECK = true
    expect((await startState()).searchParams.get('scope')).toContain('https://www.googleapis.com/auth/gmail.readonly')
  })

  it('readiness check: live mode asks Google for a fresh token; a removed permission is reported and marks the account', async () => {
    env.SEND_MODE = 'live'
    try {
      const id = await connectGmail(member)
      const { forgetAccessTokens } = await import('../../src/gmail/oauth.js')
      forgetAccessTokens()
      expect((await member.post(`/api/senders/${id}/check`)).body).toMatchObject({ ready: true, problems: [], remainingToday: env.DEFAULT_DAILY_LIMIT })
      forgetAccessTokens()
      google.tokenScript.refreshError = 'invalid_grant'
      const r = (await member.post(`/api/senders/${id}/check`)).body
      expect(r.ready).toBe(false)
      expect(r.problems.join(' ')).toMatch(/no longer accepts the permission/)
      expect((await prisma.senderAccount.findUniqueOrThrow({ where: { id } })).status).toBe('needs_reconnect')
    } finally {
      env.SEND_MODE = 'test'
    }
  })

  it('disconnecting revokes the permission at Google and erases the stored token; only its owner or an admin may', async () => {
    const id = await connectGmail(member)
    await makeUser('olga@yanthara.example', 'member')
    const other = new Client(app.base)
    await other.login('olga@yanthara.example')
    expect((await other.post(`/api/senders/${id}/disconnect`)).status).toBe(403)
    expect((await member.post(`/api/senders/${id}/disconnect`)).body).toEqual({ id, status: 'disconnected' })
    expect(google.revoked).toEqual(['refresh-token-1'])
    const acc = await prisma.senderAccount.findUniqueOrThrow({ where: { id } })
    expect(acc).toMatchObject({ status: 'disconnected', refreshTokenEnc: '' })
    expect((await member.get('/api/senders')).body.accounts).toEqual([])
  })

  it('settings: signature cleaned (scripts removed, small pictures kept), daily limit bounded, sharing by admins only', async () => {
    const id = await connectGmail(member)
    const pic = `data:image/png;base64,${Buffer.alloc(50).toString('base64')}`
    const r = await member.req('PATCH', `/api/senders/${id}`, { signatureHtml: `<p onclick="x()"><b>Sam Sales</b></p><img src="${pic}"><script>alert(1)</script>`, dailyLimit: 300 })
    expect(r.status).toBe(200)
    expect(r.body.signatureHtml).toContain('<b>Sam Sales</b>')
    expect(r.body.signatureHtml).toContain('data:image/png;base64')
    expect(r.body.signatureHtml).not.toMatch(/onclick|script/)
    expect(r.body.signatureRemoved).toContain('scripts and active content')
    expect(r.body.dailyLimit).toBe(300)
    expect((await member.req('PATCH', `/api/senders/${id}`, { dailyLimit: 5000 })).status).toBe(400)
    expect((await member.req('PATCH', `/api/senders/${id}`, { shared: true })).status).toBe(403)
  })
})

describe('what Gmail\'s answers mean', () => {
  it('quota, permission, rejected, and unknown — only a definite refusal is "not sent"', () => {
    expect(classifyGmailError(429, null)).toMatchObject({ outcome: 'refused', kind: 'quota' })
    expect(classifyGmailError(403, { error: { errors: [{ reason: 'dailyLimitExceeded' }] } })).toMatchObject({ outcome: 'refused', kind: 'quota' })
    expect(classifyGmailError(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } })).toMatchObject({ outcome: 'refused', kind: 'auth' })
    expect(classifyGmailError(401, null)).toMatchObject({ outcome: 'refused', kind: 'auth' })
    expect(classifyGmailError(400, { error: { message: 'Invalid To header' } })).toEqual({ outcome: 'refused', kind: 'invalid', reason: 'Gmail rejected the email: Invalid To header' })
    expect(classifyGmailError(413, null)).toMatchObject({ outcome: 'refused', kind: 'invalid' })
    for (const s of [408, 500, 502, 503, 504]) expect(classifyGmailError(s, null).outcome).toBe('unknown')
  })
})
