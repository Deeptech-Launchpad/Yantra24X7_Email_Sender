import { skipStatusWords } from '../config/env.js'

// FROM AN UPLOADED SPREADSHEET TO ONE EMAIL PER COMPANY (adapted from the Marketing AI Agent's Bulk Email, 2026-10-29).
//
// Pure: rows of text in, companies out. The rules Sales agreed:
//
//   · Columns are found by their headings ("Company Name", "Contact Person 1",
//     "Email Id1", "Contact Person 2", "Email 2", "Status" …), wherever they
//     are, so a sheet laid out differently still reads.
//   · Only a WORK address is used: the one marked "Primary", or one on a
//     company's own domain. An address marked "Personal", or on free webmail
//     (gmail, yahoo, comcast …), is never emailed.
//   · People of the same company — on one row or several — become ONE email:
//     the first named person is the recipient, the others are copied.
//   · A company is skipped when its Status contains one of the words in
//     EXCEL_SKIP_STATUS_WORDS (default "outreach": already contacted); any other
//     Status is processed normally.
// Nothing is guessed: no address is made from a name, and no name from an
// address.

export interface Person {
  name: string | null
  title: string | null
  email: string
  row: number
}

export interface Company {
  key: string
  companyName: string
  /** Spreadsheet row numbers (1-based, as Excel shows them). */
  rows: number[]
  people: Person[]
  status: string | null
  /** Why no email is sent to this company; null when one is. */
  skip: string | null
}

export interface Extraction {
  headerRow: number
  columns: { company: string | null; status: string | null; contacts: Array<{ name: string | null; title: string | null; email: string }> }
  companies: Company[]
  /** Rows with a company but no usable work address, and why. */
  noAddress: Array<{ row: number; companyName: string; reason: string }>
  /** Addresses that appeared again for the same company (merged into one person). */
  duplicates: Array<{ row: number; companyName: string; email: string }>
  totalRows: number
}

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'sbcglobal.net', 'att.net', 'verizon.net', 'bellsouth.net', 'cox.net',
  'charter.net', 'earthlink.net', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'frontier.com',
  'windstream.net', 'centurylink.net', 'roadrunner.com', 'rr.com', 'columbus.rr.com', 'twc.com', 'optonline.net', 'juno.com',
])

/** A strict address: plain characters only — no spaces, quotes, commas or line breaks can reach the mail server. */
const STRICT_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/
const FIND_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

export function strictEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? '').trim().toLowerCase()
  return e.length <= 254 && STRICT_EMAIL.test(e) ? e : null
}

export function isFreeMail(email: string): boolean {
  const domain = email.split('@')[1] ?? ''
  return FREE_MAIL.has(domain) || [...FREE_MAIL].some((d) => domain.endsWith(`.${d}`))
}

/**
 * The work address in one cell, or null with the reason.
 * "Primary: jeff@acme.com Personal: jeff@gmail.com" → jeff@acme.com.
 */
export function workAddress(cell: string | null | undefined, opts: { allowWebmail?: boolean } = {}): { email: string | null; reason: string | null } {
  // The test option: webmail allowed (a sheet of the team's own addresses).
  // An address labelled "Personal" is still never used.
  const ok = (e: string) => opts.allowWebmail || !isFreeMail(e)
  const text = (cell ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return { email: null, reason: 'No email address' }
  const primary = /primary\s*:?\s*\[?\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/i.exec(text)
  if (primary) {
    const e = strictEmail(primary[1])
    if (e && ok(e)) return { email: e, reason: null }
  }
  // Every address in the cell, minus any labelled personal.
  const labelledPersonal = new Set(
    [...text.matchAll(/personal\s*:?\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/gi)].map((m) => m[1]!.toLowerCase()),
  )
  const found = (text.match(FIND_EMAIL) ?? []).map((e) => e.toLowerCase())
  for (const raw of found) {
    const e = strictEmail(raw)
    if (e && !labelledPersonal.has(e) && ok(e)) return { email: e, reason: null }
  }
  return { email: null, reason: found.length ? 'Only a personal / webmail address (not used)' : 'No valid email address' }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** "hank Rossman" → "Hank"; "Mr. John T" → "John". Null when there is no name. */
export function firstNameOf(name: string | null | undefined): string | null {
  const words = (name ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  while (words.length && /^(mr|mrs|ms|miss|dr|prof)\.?$/i.test(words[0]!)) words.shift()
  const first = words[0]?.replace(/[^A-Za-z'’-]/g, '') ?? ''
  if (first.length < 2) return null
  return first === first.toLowerCase() ? first[0]!.toUpperCase() + first.slice(1) : first
}

function cleanName(raw: string | null | undefined): string | null {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim()
  return t && /[A-Za-z]/.test(t) && !t.includes('@') ? t.slice(0, 120) : null
}

/** Which column holds what, from the headings. */
function detectColumns(header: string[]) {
  const h = header.map((x) => norm(x ?? ''))
  const isEmail = (x: string) => /\be ?mail\b|\bmail id\b/.test(x)
  const isCompany = (x: string) => /\bcompany\b|\borgani[sz]ation\b|\baccount name\b/.test(x) && !isEmail(x)
  const isName = (x: string) => /\bcontact\b|\bperson\b|\bname\b/.test(x) && !isEmail(x) && !isCompany(x)
  const isTitle = (x: string) => /\btitle\b|\bdesignation\b|\bposition\b|\brole\b/.test(x)
  const company = h.findIndex(isCompany)
  const status = h.findIndex((x) => /^status\b/.test(x))
  const emails = h.map((x, i) => (isEmail(x) ? i : -1)).filter((i) => i >= 0)
  const pairs = emails.map((email, n) => {
    const from = n === 0 ? 0 : emails[n - 1]! + 1
    let name: number | null = null
    let title: number | null = null
    for (let i = from; i < email; i++) {
      if (i === company) continue
      if (isTitle(h[i]!)) title = i
      else if (isName(h[i]!)) name = i
    }
    // A sheet that puts the email first: the name and title follow it.
    if (name === null) {
      const to = emails[n + 1] ?? h.length
      for (let i = email + 1; i < to; i++) {
        if (i === company) continue
        if (title === null && isTitle(h[i]!)) title = i
        else if (name === null && isName(h[i]!)) name = i
      }
    }
    return { name, title, email }
  })
  return { company: company >= 0 ? company : null, status: status >= 0 ? status : null, pairs }
}

/** The Status words that mean "do not email this company" (from the configuration). */
const skipRules = (): Array<[RegExp, string]> =>
  skipStatusWords().map((w) => [new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), w === 'outreach' ? 'Already contacted' : `Status says "${w}"`])

export function extractContacts(rows: string[][], opts: { allowWebmail?: boolean } = {}): Extraction {
  // The heading row: the first with both a company and an email heading.
  let headerRow = rows.findIndex((r) => {
    const c = detectColumns(r)
    return c.company !== null && c.pairs.length > 0
  })
  if (headerRow < 0) headerRow = 0
  const header = rows[headerRow] ?? []
  const cols = detectColumns(header)
  const label = (i: number | null) => (i === null ? null : String(header[i] ?? '').trim() || null)

  const companies = new Map<string, Company>()
  const noAddress: Extraction['noAddress'] = []
  const duplicates: Extraction['duplicates'] = []
  const rules = skipRules()
  let totalRows = 0

  rows.slice(headerRow + 1).forEach((r, idx) => {
    const row = headerRow + 2 + idx
    const companyName = (cols.company === null ? '' : String(r[cols.company] ?? '')).replace(/\s+/g, ' ').trim()
    if (!companyName) return
    totalRows++
    const key = norm(companyName)
    let c = companies.get(key)
    if (!c) {
      c = { key, companyName, rows: [], people: [], status: null, skip: null }
      companies.set(key, c)
    }
    c.rows.push(row)
    const status = cols.status === null ? '' : String(r[cols.status] ?? '').replace(/\s+/g, ' ').trim()
    if (status) c.status = c.status ? `${c.status} | ${status}` : status
    for (const [re, why] of rules) {
      if (!c.skip && re.test(status)) c.skip = `${why} (Status: "${status.slice(0, 80)}")`
    }
    let any = false
    const reasons: string[] = []
    for (const p of cols.pairs) {
      const cell = String(r[p.email] ?? '')
      const { email, reason } = workAddress(cell, opts)
      if (!email) {
        if (cell.trim()) reasons.push(reason ?? 'No valid email address')
        continue
      }
      any = true
      if (c.people.some((x) => x.email === email)) {
        duplicates.push({ row, companyName, email })
        continue
      }
      c.people.push({ name: p.name === null ? null : cleanName(r[p.name]), title: p.title === null ? null : cleanName(r[p.title]), email, row })
    }
    if (!any) noAddress.push({ row, companyName, reason: reasons[0] ?? 'No email address' })
  })

  return {
    headerRow: headerRow + 1,
    columns: {
      company: label(cols.company),
      status: label(cols.status),
      contacts: cols.pairs.map((p) => ({ name: label(p.name), title: label(p.title), email: label(p.email)! })),
    },
    companies: [...companies.values()],
    noAddress,
    duplicates,
    totalRows,
  }
}

/** One email per company: the first named person receives it, the others are copied. */
export function recipientsOf(c: Company): { to: Person | null; cc: Person[] } {
  const to = c.people.find((p) => firstNameOf(p.name)) ?? null
  return { to, cc: to ? c.people.filter((p) => p !== to) : [] }
}
