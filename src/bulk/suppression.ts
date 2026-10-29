import { newId, prisma } from '../platform/db.js'
import { BadRequestError, ConflictError, NotFoundError } from '../platform/errors.js'
import { audit } from '../platform/log.js'
import type { Principal } from '../auth/users.js'

// THE DO-NOT-EMAIL LIST: addresses (name@company.com) or whole domains (@company.com)
// that this app never emails — checked at the review AND again at the moment of sending.

const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/
const DOMAIN = /^@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/

export function normaliseSuppression(raw: string): string {
  const v = String(raw ?? '').trim().toLowerCase()
  if (ADDRESS.test(v) || DOMAIN.test(v)) return v
  throw new BadRequestError(`"${String(raw).slice(0, 80)}" is not an email address (name@company.com) or a domain (@company.com).`)
}

export async function listSuppressions() {
  const rows = await prisma.suppression.findMany({ orderBy: { createdAt: 'desc' } })
  return rows.map((r) => ({ id: r.id, value: r.value, reason: r.reason, createdAt: r.createdAt.toISOString() }))
}

export async function addSuppressions(user: Principal, values: string[], reason: string) {
  const clean = [...new Set(values.map(normaliseSuppression))]
  if (!clean.length) throw new BadRequestError('Enter at least one address or domain.')
  if (clean.length > 1000) throw new BadRequestError('At most 1,000 at a time.')
  let added = 0
  for (const value of clean) {
    const exists = await prisma.suppression.findUnique({ where: { value } })
    if (exists) continue
    await prisma.suppression.create({ data: { id: newId(), value, reason: (reason || 'Added by hand').trim().slice(0, 200), createdByUserId: user.id } })
    added++
  }
  await audit({ userId: user.id, action: 'suppression.added', summary: `${added} added to the do-not-email list` })
  return { added, skipped: clean.length - added }
}

export async function removeSuppression(user: Principal, id: string) {
  const row = await prisma.suppression.findUnique({ where: { id } })
  if (!row) throw new NotFoundError('Not on the list.')
  if (user.role !== 'admin') throw new ConflictError('Only an admin can take someone off the do-not-email list.')
  await prisma.suppression.delete({ where: { id } })
  await audit({ userId: user.id, action: 'suppression.removed', summary: `${row.value} removed from the do-not-email list` })
  return { id, removed: true }
}

/** Why this address must not be emailed (null = it may be). */
export async function suppressedReason(email: string | null | undefined): Promise<string | null> {
  const e = (email ?? '').trim().toLowerCase()
  if (!e) return null
  const domain = `@${e.split('@')[1] ?? ''}`
  const hit = await prisma.suppression.findFirst({ where: { value: { in: [e, domain] } } })
  return hit ? `On the do-not-email list (${hit.value}${hit.reason ? `: ${hit.reason}` : ''})` : null
}

/** The same check for many addresses at once (the review). */
export async function suppressedSet(emails: string[]): Promise<Map<string, string>> {
  const all = await prisma.suppression.findMany({ select: { value: true, reason: true } })
  const byValue = new Map(all.map((s) => [s.value, s]))
  const out = new Map<string, string>()
  for (const e of emails) {
    const hit = byValue.get(e) ?? byValue.get(`@${e.split('@')[1] ?? ''}`)
    if (hit) out.set(e, `On the do-not-email list (${hit.value}${hit.reason ? `: ${hit.reason}` : ''})`)
  }
  return out
}
