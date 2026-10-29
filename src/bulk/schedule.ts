import { env } from '../config/env.js'

// WHEN EACH EMAIL GOES. Pure. The date and time are chosen in APP_TIMEZONE
// (default Asia/Kolkata); email 1 goes at the start, then one every
// `intervalMinutes`, one after another, until the list is done.

/** The offset of a time zone at an instant, in minutes (e.g. +330 for India). */
function offsetMinutes(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return Math.round((asUtc - at.getTime()) / 60_000)
}

/** "2026-11-03" + "10:00" in the time zone → the UTC instant (null when not a real date/time). */
export function localToUtc(date: string, time: string, timeZone = env.APP_TIMEZONE): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim())
  const t = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time ?? '').trim())
  if (!d || !t) return null
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]))
  const check = new Date(wall)
  if (check.getUTCMonth() !== Number(d[2]) - 1 || check.getUTCDate() !== Number(d[3])) return null
  // Two passes settle the offset around a daylight-saving change.
  let at = wall - offsetMinutes(new Date(wall), timeZone) * 60_000
  at = wall - offsetMinutes(new Date(at), timeZone) * 60_000
  return new Date(at)
}

/** "Tue, Nov 3, 2026, 10:05 AM" in the time zone, with its short name. */
export function fmtLocal(at: Date, timeZone = env.APP_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }).format(at)
}

/** Each email's time: the start, then every `intervalMinutes` after it. */
export function planSequential(start: Date, count: number, intervalMinutes: number): Date[] {
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * intervalMinutes * 60_000))
}
