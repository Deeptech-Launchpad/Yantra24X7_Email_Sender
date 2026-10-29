import { createHash, randomBytes } from 'node:crypto'
import { env } from '../config/env.js'
import { prisma } from '../platform/db.js'

// OPEN TRACKING — OFF until this application has its own public HTTPS domain.
//
// When TRACKING_ENABLED=true and TRACKING_BASE_URL is a public https:// address that
// points at THIS app, each email carries its own invisible 1×1 image
// (TRACKING_BASE_URL/t/<token>.gif). Only a hash of the token is stored. An "open" is
// recorded when the image is fetched (not within 15 seconds of sending — mail scanners —
// and at most once a minute). Until then no image is added and nothing is counted.

const OPEN_IGNORE_AFTER_SEND_MS = 15_000
const OPEN_DEDUPE_MS = 60_000

export const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** Whether new emails get an open-tracking image, and why not. */
export function trackingStatus(): { enabled: boolean; reason: string | null } {
  if (!env.TRACKING_ENABLED) return { enabled: false, reason: 'Open tracking is off (TRACKING_ENABLED=false). It is set up once this app has its own public domain.' }
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/.*)?$/i.test(env.TRACKING_BASE_URL)) return { enabled: false, reason: 'Open tracking needs TRACKING_BASE_URL to be this app\'s public https:// address.' }
  return { enabled: true, reason: null }
}

export const newTrackingToken = () => randomBytes(24).toString('base64url')
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')

export function addPixel(html: string, token: string): string {
  const url = `${env.TRACKING_BASE_URL.replace(/\/+$/, '')}/t/${token}.gif`
  const img = `<img src="${url}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`
  return /<\/div>\s*$/.test(html) ? html.replace(/<\/div>\s*$/, `${img}</div>`) : html + img
}

/** Records an open for this token (when tracking is on). Never throws: the image is always answered. */
export async function recordOpen(token: string, now = new Date()): Promise<void> {
  if (!trackingStatus().enabled || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return
  try {
    const r = await prisma.recipient.findUnique({ where: { trackingTokenHash: hashToken(token) }, select: { id: true, sentAt: true, lastOpenedAt: true, firstOpenedAt: true } })
    if (!r?.sentAt) return
    if (now.getTime() - r.sentAt.getTime() < OPEN_IGNORE_AFTER_SEND_MS) return
    if (r.lastOpenedAt && now.getTime() - r.lastOpenedAt.getTime() < OPEN_DEDUPE_MS) return
    await prisma.recipient.update({ where: { id: r.id }, data: { openCount: { increment: 1 }, lastOpenedAt: now, firstOpenedAt: r.firstOpenedAt ?? now } })
  } catch {
    // An open that cannot be counted is not an error for the person reading the email.
  }
}
