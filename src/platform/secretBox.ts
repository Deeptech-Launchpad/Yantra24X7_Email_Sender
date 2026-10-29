import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from '../config/env.js'

// SECRETS AT REST: Gmail refresh tokens are stored encrypted with AES-256-GCM
// using TOKEN_ENCRYPTION_KEY (32 random bytes, base64) from this app's own .env.
// A stolen database file alone does not reveal any token. Format: v1.<iv>.<tag>.<ciphertext> (base64url).

function key(): Buffer {
  const k = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64')
  if (k.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY is not set to 32 bytes (base64).')
  return k
}

export function seal(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.')
}

export function open(sealed: string): string {
  const [v, iv, tag, body] = sealed.split('.')
  if (v !== 'v1' || !iv || !tag || body === undefined) throw new Error('A stored secret is in an unknown format.')
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8')
}
