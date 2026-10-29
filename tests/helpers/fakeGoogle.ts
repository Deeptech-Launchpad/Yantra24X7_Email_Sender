import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { env } from '../../src/config/env.js'

// A FAKE GOOGLE, on 127.0.0.1, for tests: the OAuth token endpoint, revoke, Gmail "send"
// and Gmail "search". Nothing ever reaches Google and nothing is ever sent.
// A test can script what Gmail answers to each send.

export type SendScript = 'ok' | 'drop' | 'hang' | { status: number; reason?: string; message?: string }

export interface FakeGoogle {
  base: string
  sent: Array<{ mime: string; token: string }>
  revoked: string[]
  sendScript: SendScript[]
  tokenScript: { scope: string; email: string; emailVerified: boolean; refreshToken: string | null; refreshError: string | null; aud?: string }
  close: () => Promise<void>
}

const jwtPart = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const app = express()
  const fake: FakeGoogle = {
    base: '',
    sent: [],
    revoked: [],
    sendScript: [],
    tokenScript: {
      scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send',
      email: 'sales.one@yanthara.example',
      emailVerified: true,
      refreshToken: 'refresh-token-1',
      refreshError: null,
    },
    close: async () => undefined,
  }
  app.use(express.urlencoded({ extended: false }))
  app.post('/token', (req, res) => {
    const b = req.body as Record<string, string>
    if (b.client_id !== env.GOOGLE_CLIENT_ID || b.client_secret !== env.GOOGLE_CLIENT_SECRET) return res.status(401).json({ error: 'invalid_client' })
    if (b.grant_type === 'authorization_code') {
      if (b.code !== 'good-code' || !b.code_verifier) return res.status(400).json({ error: 'invalid_grant' })
      const t = fake.tokenScript
      const idToken = `${jwtPart({ alg: 'none' })}.${jwtPart({ aud: t.aud ?? env.GOOGLE_CLIENT_ID, email: t.email, email_verified: t.emailVerified })}.`
      return res.json({ access_token: 'access-1', expires_in: 3600, scope: t.scope, id_token: idToken, ...(t.refreshToken ? { refresh_token: t.refreshToken } : {}) })
    }
    if (b.grant_type === 'refresh_token') {
      if (fake.tokenScript.refreshError) return res.status(400).json({ error: fake.tokenScript.refreshError })
      return res.json({ access_token: `access-for-${b.refresh_token}`, expires_in: 3600 })
    }
    return res.status(400).json({ error: 'unsupported_grant_type' })
  })
  app.post('/revoke', (req, res) => {
    fake.revoked.push(String(req.query.token ?? ''))
    res.json({})
  })
  app.post('/upload/gmail/v1/users/me/messages/send', express.raw({ type: 'message/rfc822', limit: '40mb' }), (req, res) => {
    const step = fake.sendScript.shift() ?? 'ok'
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (step === 'drop') {
      // Gmail received it (it IS sent) but the answer never arrives.
      fake.sent.push({ mime: (req.body as Buffer).toString('latin1'), token })
      req.socket.destroy()
      return
    }
    if (step === 'hang') return // no answer at all
    if (step !== 'ok') {
      return res.status(step.status).json({ error: { code: step.status, message: step.message ?? 'refused', errors: [{ reason: step.reason ?? 'failedPrecondition' }] } })
    }
    fake.sent.push({ mime: (req.body as Buffer).toString('latin1'), token })
    res.json({ id: `gmail-${fake.sent.length}`, threadId: `thread-${fake.sent.length}`, labelIds: ['SENT'] })
  })
  app.get('/gmail/v1/users/me/messages', (req, res) => {
    const q = String(req.query.q ?? '')
    const id = q.replace(/^rfc822msgid:/, '')
    // Headers are read unfolded, as Gmail does.
    const i = fake.sent.findIndex((s) => s.mime.split('\r\n\r\n')[0]!.replace(/\r\n[ \t]+/g, ' ').includes(`Message-ID: <${id}>`))
    res.json(i >= 0 ? { messages: [{ id: `gmail-${i + 1}`, threadId: `thread-${i + 1}` }] } : { resultSizeEstimate: 0 })
  })
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  Object.assign(env, { GOOGLE_AUTH_URL: `${fake.base}/auth`, GOOGLE_TOKEN_URL: `${fake.base}/token`, GOOGLE_REVOKE_URL: `${fake.base}/revoke`, GMAIL_API_BASE: fake.base })
  return fake
}
