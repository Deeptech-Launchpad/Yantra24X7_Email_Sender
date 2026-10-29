import { env } from '../config/env.js'
import { newId, prisma } from './db.js'

// A small structured log (one JSON line per event) and the audit trail.
// Never log a token, a password, an email body or an attachment.

type Level = 'info' | 'warn' | 'error'

function write(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (env.NODE_ENV === 'test' && level !== 'error') return
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields })
  if (level === 'error') console.error(line)
  else console.log(line)
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
}

/** Records who did what. Never fails the action it describes. */
export async function audit(e: { userId?: string | null; campaignId?: string | null; action: string; summary: string }): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: { id: newId(), userId: e.userId ?? null, campaignId: e.campaignId ?? null, action: e.action, summary: e.summary.slice(0, 2000) },
    })
  } catch (err) {
    log.warn('audit event could not be stored', { action: e.action, err: String((err as Error)?.message ?? err).slice(0, 200) })
  }
}
