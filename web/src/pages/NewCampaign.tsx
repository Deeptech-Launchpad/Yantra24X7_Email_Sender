import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type Account, type FileInfo, type Template } from '../api'
import { canSend, useSession } from '../App'
import { Banner, Chip, EmailList, formatSize, Html, HtmlEditor, Panel, useAction, useLoad, visibleText } from '../ui'
import { uploadZipInPieces, type UploadedZip } from '../zipUpload'

// A NEW BULK EMAIL in three steps, as in the Marketing AI Agent's Bulk Email:
//   1. Upload Excel      — the list, the email(s), who it is sent from, replies and CC
//   2. Review emails     — every email with the reason for each one that is not sent; attachments and the company ZIP
//   3. Date, time, start — when, how far apart, and the explicit approval

type Step = 'upload' | 'review' | 'schedule'
const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'upload', label: '1. Upload Excel' },
  { key: 'review', label: '2. Review emails' },
  { key: 'schedule', label: '3. Date, time and start' },
]
const MATCH_LABEL: Record<string, string> = { matched: 'Matched', missing: 'No matching PDF', ambiguous: 'Several files match', invalid: 'File not usable', too_large: 'Too large for one email', excluded: 'Excluded' }
const MATCH_TONE: Record<string, 'ok' | 'danger' | 'neutral'> = { matched: 'ok', missing: 'danger', ambiguous: 'danger', invalid: 'danger', too_large: 'danger', excluded: 'neutral' }

type OnePer = 'company' | 'person'

interface Analysis {
  file: FileInfo
  /** Every worksheet, and the one read. */
  sheets: string[]
  sheet: string
  onePer: OnePer
  totalRows: number
  companies: Array<{ key: string; companyName: string; people: Array<{ name: string | null; email: string }>; skip: string | null }>
  noAddress: Array<{ row: number; companyName: string; reason: string }>
  duplicates: Array<{ row: number; companyName: string; email: string }>
  columns: { company: string | null; status: string | null; contacts: Array<{ email: string }> }
}
/** One sheet of the workbook in the "each sheet with its own email" mode. */
interface SheetPlan {
  sheet: string
  use: boolean
  templateId: string
  /** People with a usable address on this sheet; null while it is being read. */
  people: number | null
  /** Why the sheet cannot be used (no Company / Email columns …). */
  problem: string | null
}

/** The saved template that belongs to a sheet: "Mailer 1 - Discovery" ↔ "Mailer 1 – Discovery" (by its number, else by its name). */
function matchTemplate(sheet: string, templates: Template[]): string {
  const num = (s: string) => /mailer\s*(\d+)/i.exec(s)?.[1] ?? null
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const n = num(sheet)
  const byNumber = n ? templates.filter((t) => num(t.name) === n) : []
  if (byNumber.length === 1) return byNumber[0]!.id
  const byName = templates.filter((t) => norm(t.name) === norm(sheet))
  return byName.length === 1 ? byName[0]!.id : ''
}

interface ReviewRow {
  position: number
  companyName: string
  sheet: string | null
  contactName: string | null
  toEmail: string | null
  ccEmails: string[]
  status: 'ready' | 'skipped' | 'blocked'
  category: string | null
  reason: string | null
  subject: string | null
  html: string | null
  templateNumber: number | null
  companyFile: { status: string; fileName: string | null; detail: string | null } | null
  note: string | null
  scheduledLocal: string | null
}
interface Review {
  /** What was reviewed; Start sends it back and is refused if anything changed since. */
  fingerprint: string
  counts: { rowsWithCompany: number; companies: number; eligible: number; invalid: number; duplicate: number; excluded: number; blocked: number }
  rows: ReviewRow[]
  noAddress: Array<{ row: number; companyName: string; reason: string }>
  templates: Array<{ number: number; subject: string; removed: string[] }>
  templateOrder: string | null
  cc: string[]
  replyTo: string | null
  trackOpens: boolean
  onePer: OnePer
  sheet: string
  sheets: string[]
  copyColleagues: boolean
  sender: { id: string; email: string; ready: boolean; problems: string[]; remainingToday: number; dailyLimit: number }
  sendMode: 'test' | 'live'
  attachments: FileInfo[]
  companyZip: { fileName: string; files: Array<{ name: string; path: string; status: string; reason: string | null; used: boolean }>; problems: string[]; counts: Record<string, number> } | null
  blockedProblem: string | null
  schedule: { timezone: string; firstLocal: string | null; lastLocal: string | null; intervalMinutes: number; limitNote: string | null }
}
interface TemplateChoice {
  key: number
  source: 'saved' | 'own'
  templateId: string
  subject: string
  bodyHtml: string
}

function today(tz: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((p) => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

export function NewCampaign() {
  const { user, config } = useSession()
  const navigate = useNavigate()
  const act = useAction()
  const accounts = useLoad(() => api.get<{ accounts: Account[] }>('/senders'))
  const saved = useLoad(() => api.get<{ templates: Template[] }>('/templates'))
  const excelInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const zipInput = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('upload')
  const [excel, setExcel] = useState<FileInfo | null>(null)
  const [allowWebmail, setAllowWebmail] = useState(false)
  const [sheet, setSheet] = useState('')
  // 'one': one sheet (the template(s) below); 'sheets': several sheets in one campaign, each with its own email.
  const [mode, setMode] = useState<'one' | 'sheets'>('one')
  const [plans, setPlans] = useState<SheetPlan[]>([])
  const [onePer, setOnePer] = useState<OnePer>('company')
  const [replyTo, setReplyTo] = useState('')
  const [trackOpens, setTrackOpens] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [senderId, setSenderId] = useState('')
  const [templates, setTemplates] = useState<TemplateChoice[]>([{ key: 1, source: 'saved', templateId: '', subject: '', bodyHtml: '' }])
  const [order, setOrder] = useState<'sequential' | 'random'>('sequential')
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 0x7fffffff))
  const [cc, setCc] = useState<string[]>([])
  const [copyColleagues, setCopyColleagues] = useState(true)
  const [attachments, setAttachments] = useState<FileInfo[]>([])
  const [zip, setZip] = useState<UploadedZip | null>(null)
  const [zipProgress, setZipProgress] = useState<{ sent: number; total: number } | null>(null)
  const [excludeUnmatched, setExcludeUnmatched] = useState(false)
  const [excluded, setExcluded] = useState<number[]>([])
  const [review, setReview] = useState<Review | null>(null)
  const [previewPos, setPreviewPos] = useState<number | null>(null)
  const start = today(config.timezone)
  const [startDate, setStartDate] = useState(start.date)
  const [startTime, setStartTime] = useState(start.time)
  const [interval, setIntervalMinutes] = useState(String(Math.max(config.minIntervalMinutes, 2)))
  const [name, setName] = useState('')
  const [confirmed, setConfirmed] = useState(false)

  const usable = (accounts.data?.accounts ?? []).filter((a) => a.usable && a.status === 'connected')
  const usedPlans = plans.filter((p) => p.use && !p.problem)
  const templateOk =
    mode === 'sheets'
      ? usedPlans.length > 0 && usedPlans.length <= config.limits.maxTemplates && usedPlans.every((p) => Boolean(p.templateId))
      : templates.every((t) => (t.source === 'saved' ? Boolean(t.templateId) : Boolean(t.subject.trim() && visibleText(t.bodyHtml))))
  const sendable = mode === 'sheets' ? usedPlans.reduce((n, p) => n + (p.people ?? 0), 0) : analysis ? analysis.companies.filter((c) => !c.skip && c.people.length > 0).length : 0

  const setup = (over: { excludeUnmatched?: boolean; excludePositions?: number[] } = {}) => ({
    excelFileId: excel!.id,
    allowWebmail,
    ...(mode === 'sheets' ? { sheets: usedPlans.map((p) => p.sheet) } : sheet ? { sheet } : {}),
    onePer,
    ...(replyTo.trim() ? { replyTo: replyTo.trim() } : {}),
    ...(trackOpens ? { trackOpens: true } : {}),
    senderAccountId: senderId,
    templates:
      mode === 'sheets'
        ? usedPlans.map((p) => ({ templateId: p.templateId }))
        : templates.map((t) => (t.source === 'saved' ? { templateId: t.templateId } : { subject: t.subject.trim(), bodyHtml: t.bodyHtml })),
    ...(mode === 'one' && templates.length > 1 ? { templateOrder: order, ...(order === 'random' ? { shuffleSeed: seed } : {}) } : {}),
    cc,
    copyColleagues,
    attachmentIds: attachments.map((a) => a.id),
    ...(zip ? { companyZipId: zip.id, excludeUnmatched: over.excludeUnmatched ?? excludeUnmatched } : {}),
    excludePositions: over.excludePositions ?? excluded,
    startDate,
    startTime,
    intervalMinutes: Number(interval),
    ...(name.trim() ? { name: name.trim() } : {}),
  })
  const loadReview = (over: Parameters<typeof setup>[0] = {}) =>
    act.run('review', async () => {
      const r = await api.post<Review>('/campaigns/review', setup(over))
      setReview(r)
      setConfirmed(false)
      setPreviewPos((p) => (p !== null && r.rows[p]?.status === 'ready' ? p : (r.rows.find((x) => x.status === 'ready')?.position ?? null)))
    })
  const invalidate = () => {
    setReview(null)
    setConfirmed(false)
  }

  // Every sheet of the workbook is read, to show how many people it has and to pick its email by name.
  const refreshPlans = async (excelId: string, sheets: string[], webmail: boolean, per: OnePer, keep: SheetPlan[] = []) => {
    const list = saved.data?.templates ?? (await api.get<{ templates: Template[] }>('/templates')).templates
    const next: SheetPlan[] = []
    for (const name of sheets) {
      const before = keep.find((p) => p.sheet === name)
      try {
        const a = await api.post<Analysis>('/campaigns/analyze', { excelFileId: excelId, sheet: name, allowWebmail: webmail, onePer: per })
        const people = a.companies.filter((c) => !c.skip && c.people.length > 0).length
        next.push({ sheet: name, use: before ? before.use : people > 0, templateId: before?.templateId || matchTemplate(name, list), people, problem: null })
      } catch (e) {
        next.push({ sheet: name, use: false, templateId: '', people: null, problem: (e as Error).message })
      }
    }
    setPlans(next)
  }
  const uploadExcel = (f: File | undefined) => {
    if (!f) return
    void act.run('excel', async () => {
      const stored = await api.upload<FileInfo>('/files/excel', f, f.name)
      setExcel(stored)
      setExcluded([])
      invalidate()
      // A new file: the server picks the first sheet with an email heading.
      const a = await api.post<Analysis>('/campaigns/analyze', { excelFileId: stored.id, allowWebmail, onePer })
      setSheet(a.sheet)
      setAnalysis(a)
      if (mode === 'sheets') await refreshPlans(stored.id, a.sheets, allowWebmail, onePer)
    })
  }
  const chooseMode = (next: 'one' | 'sheets') => {
    setMode(next)
    invalidate()
    if (next === 'sheets' && excel && analysis) void act.run('excel', () => refreshPlans(excel.id, analysis.sheets, allowWebmail, onePer, plans))
  }
  const setPlan = (name: string, patch: Partial<SheetPlan>) => {
    setPlans((ps) => ps.map((p) => (p.sheet === name ? { ...p, ...patch } : p)))
    invalidate()
  }
  const reanalyze = (over: { webmail?: boolean; sheet?: string; onePer?: OnePer }) => {
    const next = { webmail: over.webmail ?? allowWebmail, sheet: over.sheet ?? sheet, onePer: over.onePer ?? onePer }
    setAllowWebmail(next.webmail)
    setSheet(next.sheet)
    setOnePer(next.onePer)
    // The rows change, so exclusions made by row number no longer point at the same people.
    setExcluded([])
    invalidate()
    if (excel)
      void act.run('excel', async () => {
        const a = await api.post<Analysis>('/campaigns/analyze', { excelFileId: excel.id, allowWebmail: next.webmail, onePer: next.onePer, ...(next.sheet ? { sheet: next.sheet } : {}) })
        setAnalysis(a)
        if (mode === 'sheets') await refreshPlans(excel.id, a.sheets, next.webmail, next.onePer, plans)
      })
  }
  const addFiles = (files: FileList | null) => {
    if (!files?.length) return
    void act.run('attach', async () => {
      let next = attachments
      for (const f of Array.from(files)) {
        if (next.length >= config.limits.maxCommonFiles) throw new Error(`At most ${config.limits.maxCommonFiles} attachments.`)
        if (f.size > config.limits.maxFileBytes) throw new Error(`"${f.name}" is larger than ${formatSize(config.limits.maxFileBytes)}.`)
        next = [...next, await api.upload<FileInfo>('/files/attachments', f, f.name)]
        setAttachments(next)
      }
      filesChanged()
    })
    if (fileInput.current) fileInput.current.value = ''
  }
  const removeFile = (id: string) =>
    void act.run('attach', async () => {
      await api.del(`/files/${id}`).catch(() => undefined)
      setAttachments((a) => a.filter((x) => x.id !== id))
      filesChanged()
    })
  const addZip = (f: File | undefined) => {
    if (zipInput.current) zipInput.current.value = ''
    if (!f) return
    if (!/\.zip$/i.test(f.name)) return act.setError(`"${f.name}" is not a .zip file.`)
    if (f.size > config.limits.maxZipBytes) return act.setError(`"${f.name}" is larger than ${formatSize(config.limits.maxZipBytes)}.`)
    void act.run('zip', async () => {
      setZipProgress({ sent: 0, total: f.size })
      try {
        const z = await uploadZipInPieces(f, (sent) => setZipProgress({ sent, total: f.size }))
        if (zip) void api.del(`/files/${zip.id}`).catch(() => undefined)
        setZip(z)
        filesChanged()
      } finally {
        setZipProgress(null)
      }
    })
  }

  const counts = review?.counts
  const go = (to: Step) => {
    act.setError(null)
    setStep(to)
    if (to === 'review' || to === 'schedule') void loadReview()
  }
  // Files added or removed on the review step: the review is made again with the latest choices (after this render).
  const [reloadTick, setReloadTick] = useState(0)
  const filesChanged = () => {
    invalidate()
    setReloadTick((t) => t + 1)
  }
  useEffect(() => {
    if (reloadTick > 0 && step === 'review') void loadReview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTick])
  const preview = review?.rows.find((r) => r.position === previewPos) ?? null
  const intervalOk = /^\d+$/.test(interval) && Number(interval) >= config.minIntervalMinutes && Number(interval) <= 240
  
  // Each template box keeps its key, so a body being typed is never reset when another template changes.
  const templateEditor = templates.map((t, i) => (
        <div key={t.key} className="bulk-template-item">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{templates.length > 1 ? `Template ${i + 1}` : 'Template'}</strong>
            {templates.length > 1 && (
              <button
                type="button"
                className="btn small quiet"
                onClick={() => {
                  setTemplates((ts) => ts.filter((x) => x.key !== t.key))
                  invalidate()
                }}
              >
                Remove<span className="sr-only"> template {i + 1}</span>
              </button>
            )}
          </div>
          <div className="row" role="radiogroup" aria-label={`Template ${i + 1} source`}>
            <label className="check">
              <input type="radio" checked={t.source === 'saved'} onChange={() => (setTemplates((ts) => ts.map((x) => (x.key === t.key ? { ...x, source: 'saved' } : x))), invalidate())} />
              A saved template
            </label>
            <label className="check">
              <input type="radio" checked={t.source === 'own'} onChange={() => (setTemplates((ts) => ts.map((x) => (x.key === t.key ? { ...x, source: 'own' } : x))), invalidate())} />
              Write one for this campaign
            </label>
          </div>
          {t.source === 'saved' ? (
            <label className="field">
              Saved template
              <select
                aria-label={`Saved template ${i + 1}`}
                value={t.templateId}
                onChange={(e) => {
                  setTemplates((ts) => ts.map((x) => (x.key === t.key ? { ...x, templateId: e.target.value } : x)))
                  invalidate()
                }}
              >
                <option value="">Choose…</option>
                {(saved.data?.templates ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.subject}
                  </option>
                ))}
              </select>
              {saved.data && saved.data.templates.length === 0 && (
                <span className="note">
                  No saved templates yet — <Link to="/templates">create one</Link> or write one here.
                </span>
              )}
            </label>
          ) : (
            <>
              <label className="field">
                Subject
                <input
                  type="text"
                  aria-label={`Template ${i + 1} subject`}
                  maxLength={200}
                  value={t.subject}
                  placeholder="For example: A proposal for [Company Name]"
                  onChange={(e) => {
                    const v = e.target.value.replace(/[\r\n]+/g, ' ')
                    setTemplates((ts) => ts.map((x) => (x.key === t.key ? { ...x, subject: v } : x)))
                    invalidate()
                  }}
                />
              </label>
              <span className="field" style={{ marginBottom: 4 }}>
                Email body
              </span>
              <HtmlEditor
                label={`Template ${i + 1} body`}
                initialHtml={t.bodyHtml}
                onChange={(html) => {
                  setTemplates((ts) => ts.map((x) => (x.key === t.key ? { ...x, bodyHtml: html } : x)))
                  invalidate()
                }}
              />
            </>
          )}
        </div>
      ))

  if (!canSend(user)) return <Banner kind="err">Your role ({user.role}) cannot create campaigns.</Banner>

  const sendableRows = analysis ? analysis.companies.filter((c) => !c.skip && c.people.length > 0) : []

  return (
    <Panel
      title="New bulk email"
      subtitle="Upload an Excel list, review the emails, choose when to start — they go one after another."
      actions={
        <Link to="/campaigns" className="btn small quiet" style={{ textDecoration: 'none' }}>
          ← Back
        </Link>
      }
    >
      <ol className="bulk-steps" aria-label="Steps">
        {STEPS.map((s) => (
          <li key={s.key} className={s.key === step ? 'is-current' : undefined} aria-current={s.key === step ? 'step' : undefined}>
            {s.label}
          </li>
        ))}
      </ol>
      {act.error && (
        <p className="otr-err" role="alert">
          {act.error}
        </p>
      )}

      {step === 'upload' && (
        <>
          <p className="note">
            Upload the Excel file (.xlsx) with a <strong>Company</strong> column and one or more contact / email columns (Contact Person 1, Email Id1, Contact Person 2, Email 2 — or Email, First Name, Last Name for a list of people).
            Up to {formatSize(config.limits.maxExcelBytes)}.
          </p>
          <div className="row">
            <input ref={excelInput} type="file" hidden accept=".xlsx" aria-label="Excel file" onChange={(e) => uploadExcel(e.target.files?.[0])} />
            <button type="button" className="btn" disabled={act.busy === 'excel'} onClick={() => excelInput.current?.click()}>
              {act.busy === 'excel' ? 'Reading…' : excel ? 'Choose another file' : 'Choose Excel file'}
            </button>
            {excel && (
              <span className="cell-dim">
                {excel.fileName} ({formatSize(excel.sizeBytes)})
              </span>
            )}
          </div>
          {analysis && analysis.sheets.length > 1 && (
            <fieldset className="field" style={{ border: 0, padding: 0 }}>
              <legend>Sheets</legend>
              <label className="check">
                <input type="radio" name="mode" checked={mode === 'one'} onChange={() => chooseMode('one')} />
                <span>One sheet</span>
              </label>
              <label className="check">
                <input type="radio" name="mode" checked={mode === 'sheets'} onChange={() => chooseMode('sheets')} />
                <span>Several sheets in one campaign — each sheet is sent with its own email (for example the Mailer 1, 2 and 3 sheets)</span>
              </label>
            </fieldset>
          )}
          {analysis && analysis.sheets.length > 1 && mode === 'one' && (
            <label className="field">
              Sheet
              <select value={sheet} onChange={(e) => reanalyze({ sheet: e.target.value })}>
                {analysis.sheets.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          )}
          <fieldset className="field" style={{ border: 0, padding: 0 }}>
            <legend>Send</legend>
            <label className="check">
              <input type="radio" name="onePer" checked={onePer === 'company'} onChange={() => reanalyze({ onePer: 'company' })} />
              <span>One email per company — the first named person receives it, colleagues are copied</span>
            </label>
            <label className="check">
              <input type="radio" name="onePer" checked={onePer === 'person'} onChange={() => reanalyze({ onePer: 'person' })} />
              <span>One email per person — every row gets its own email, nobody is copied; [First Name] is the First Name column as written</span>
            </label>
          </fieldset>
          <label className="bulk-test">
            <input type="checkbox" checked={allowWebmail} onChange={(e) => reanalyze({ webmail: e.target.checked })} />
            <span>
              Include personal / webmail addresses (gmail, yahoo …) — <strong>for a test with your own team&rsquo;s addresses</strong>. Leave this off for a real list: only work addresses are used.
            </span>
          </label>

          {mode === 'sheets' && analysis && (
            <section className="bulk-section" aria-label="Sheets and their emails">
              <h3>Sheets and their emails</h3>
              <p className="note">
                Each sheet is sent with the saved template you choose for it — nothing is mixed. The email is picked by name where it can be (&ldquo;Mailer 1&rdquo; sheet ↔ &ldquo;Mailer 1&rdquo; template). The review shows, for every person, the
                sheet and the email. At most {config.limits.maxTemplates} sheets in one campaign.
              </p>
              {saved.data && saved.data.templates.length === 0 && (
                <p className="note">
                  No saved templates yet — <Link to="/templates">create them</Link> first (one per sheet).
                </p>
              )}
              <div className="otr-scroll">
                <table className="otr-table">
                  <thead>
                    <tr>
                      <th>Send</th>
                      <th>Sheet</th>
                      <th>People</th>
                      <th>Email for this sheet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plans.map((p) => (
                      <tr key={p.sheet}>
                        <td>
                          <input type="checkbox" aria-label={`Send sheet ${p.sheet}`} checked={p.use} disabled={Boolean(p.problem) || p.people === 0} onChange={(e) => setPlan(p.sheet, { use: e.target.checked })} />
                        </td>
                        <td>{p.sheet}</td>
                        <td>{p.problem ? <span className="cell-dim">{p.problem}</span> : p.people === null ? '…' : p.people}</td>
                        <td>
                          {p.problem ? (
                            '—'
                          ) : (
                            <select aria-label={`Email for ${p.sheet}`} value={p.templateId} disabled={!p.use} onChange={(e) => setPlan(p.sheet, { templateId: e.target.value })}>
                              <option value="">Choose…</option>
                              {(saved.data?.templates ?? []).map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name} — {s.subject}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {usedPlans.length > config.limits.maxTemplates && <p className="otr-warn">Choose at most {config.limits.maxTemplates} sheets for one campaign.</p>}
            </section>
          )}

          {mode === 'one' && (
          <section className="bulk-section" aria-label="Email">
            <h3>Email</h3>
            <p className="note">
              <strong>[First Name]</strong> and <strong>[Company Name]</strong> are filled for each person from the Excel. Up to {config.limits.maxTemplates} templates per campaign.
            </p>
            {templateEditor}
            <div className="row">
              {templates.length < config.limits.maxTemplates && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setTemplates((ts) => [...ts, { key: Math.max(...ts.map((x) => x.key)) + 1, source: 'saved', templateId: '', subject: '', bodyHtml: '' }])
                    invalidate()
                  }}
                >
                  Add another template
                </button>
              )}
            </div>
            {templates.length > 1 && (
              <div role="radiogroup" aria-label="How the templates are given out" style={{ marginTop: 8 }}>
                <label className="check">
                  <input type="radio" checked={order === 'sequential'} onChange={() => (setOrder('sequential'), invalidate())} />
                  In order: template {templates.map((_, i) => i + 1).join(' → ')} → 1 … down the list
                </label>
                <label className="check">
                  <input type="radio" checked={order === 'random'} onChange={() => (setOrder('random'), setSeed(Math.floor(Math.random() * 0x7fffffff)), invalidate())} />
                  Random: each person gets one of the templates at random (fixed when you review)
                </label>
              </div>
            )}
          </section>
          )}

          <section className="bulk-section" aria-label="Sender">
            <h3>Sender</h3>
            {usable.length === 0 ? (
              <Banner kind="warn">
                No Gmail account is connected that you may send from. <Link to="/senders">Connect one</Link> first.
              </Banner>
            ) : (
              <div className="otr-grid">
                <label>
                  <span className="field-label">Send from</span>
                  <select
                    aria-label="Sender account"
                    value={senderId}
                    onChange={(e) => {
                      setSenderId(e.target.value)
                      invalidate()
                    }}
                  >
                    <option value="">Choose…</option>
                    {usable.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.email} — {a.remainingToday} of {a.dailyLimit} left today
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="field-label">Replies go to (Reply-To; empty = the sender&rsquo;s own address)</span>
                  <input type="email" aria-label="Replies go to" maxLength={254} placeholder="name@company.com" value={replyTo} onChange={(e) => (setReplyTo(e.target.value), invalidate())} />
                </label>
              </div>
            )}
            {onePer === 'company' && (
              <label className="check">
                <input type="checkbox" checked={copyColleagues} onChange={(e) => (setCopyColleagues(e.target.checked), invalidate())} />
                Copy the other contacts of the same company (from the Excel)
              </label>
            )}
            <span className="field-label" style={{ display: 'block', marginTop: 12 }}>
              CC on every email (optional, up to {config.limits.maxCc})
            </span>
            <EmailList value={cc} onChange={(v) => (setCc(v), invalidate())} max={config.limits.maxCc} label="CC address" />
          </section>

          {analysis && mode === 'sheets' && (
            <ul className="otr-list">
              <li>
                <strong>{sendable}</strong> {onePer === 'person' ? 'people' : 'companies'} on {usedPlans.length} sheet{usedPlans.length === 1 ? '' : 's'}, each with its own email. The review lists every one of them.
              </li>
            </ul>
          )}
          {analysis && mode === 'one' && (
            <>
              <ul className="otr-list">
                <li>
                  <strong>{sendableRows.length}</strong> {analysis.onePer === 'person' ? 'people' : 'companies'} with a valid email address · {analysis.companies.filter((c) => c.skip).length} skipped by Status ·{' '}
                  {analysis.noAddress.length} rows with no usable address · {analysis.duplicates.length} repeated addresses ({analysis.totalRows} rows in the sheet)
                </li>
              </ul>
              {analysis.noAddress.length > 0 && (
                <details>
                  <summary>Rows that cannot be used ({analysis.noAddress.length})</summary>
                  <ul className="muted">
                    {analysis.noAddress.map((r) => (
                      <li key={r.row}>
                        Row {r.row}, {r.companyName}: {r.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="otr-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table className="otr-table">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>To</th>
                      <th>CC</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.companies
                      .filter((c) => c.people.length > 0 || c.skip)
                      .map((c) => (
                        <tr key={c.key}>
                          <td>{c.companyName}</td>
                          <td>
                            {c.people[0] ? (
                              <>
                                {c.people[0].name ?? <span className="cell-dim">no name</span>}
                                <div className="cell-dim">{c.people[0].email}</div>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="cell-dim">{c.people.slice(1).map((p) => p.email).join(', ') || '—'}</td>
                          <td>{c.skip ? <Chip>Skipped — {c.skip}</Chip> : null}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="row" style={{ marginTop: 'var(--s3)' }}>
            <button type="button" className="btn primary" disabled={!analysis || (mode === 'sheets' ? sendable === 0 : sendableRows.length === 0) || !senderId || !templateOk || Boolean(act.busy)} onClick={() => go('review')}>
              Next: review emails
            </button>
          </div>
        </>
      )}

      {step === 'review' && (
        <>
          {!review ? (
            <p className="muted">{act.busy === 'review' || act.busy === 'zip' || act.busy === 'attach' ? 'Preparing every email…' : 'The review could not be prepared.'}</p>
          ) : (
            <>
              <p className="note">
                <strong>{counts!.eligible} emails</strong> will be sent · {counts!.invalid} invalid · {counts!.duplicate} duplicate · {counts!.excluded} excluded{counts!.blocked > 0 ? ` · ${counts!.blocked} blocked` : ''}. Click Preview to
                read any email exactly as it will be sent.
              </p>
              {review.templates.some((t) => t.removed.length > 0) && (
                <p className="otr-warn">Taken out of the templates for safety: {review.templates.flatMap((t) => t.removed.map((r) => (review.templates.length > 1 ? `template ${t.number}: ${r}` : r))).join('; ')}.</p>
              )}
              {review.companyZip && (
                <section className="bulk-zip-check" aria-label="Company PDF check">
                  <p className="note">
                    <strong>{review.companyZip.fileName}</strong> · {review.companyZip.counts.matched} matched to their PDF
                    {review.companyZip.counts.missing ? ` · ${review.companyZip.counts.missing} with no matching PDF` : ''}
                    {review.companyZip.counts.ambiguous ? ` · ${review.companyZip.counts.ambiguous} with several matching files` : ''}
                    {review.companyZip.counts.invalid ? ` · ${review.companyZip.counts.invalid} with a file that cannot be used` : ''}
                    {review.companyZip.counts.tooLarge ? ` · ${review.companyZip.counts.tooLarge} too large for one email` : ''}
                    {review.companyZip.counts.unused ? ` · ${review.companyZip.counts.unused} files not used` : ''}
                  </p>
                  {review.companyZip.problems.map((p) => (
                    <p key={p} className="otr-warn">
                      {p}
                    </p>
                  ))}
                  {review.blockedProblem && (
                    <p className="otr-err" role="alert">
                      {review.blockedProblem}
                    </p>
                  )}
                  {(counts!.blocked > 0 || excludeUnmatched) && (
                    <label className="bulk-test">
                      <input
                        type="checkbox"
                        checked={excludeUnmatched}
                        disabled={act.busy === 'review'}
                        onChange={(e) => {
                          setExcludeUnmatched(e.target.checked)
                          void loadReview({ excludeUnmatched: e.target.checked })
                        }}
                      />
                      <span>
                        Exclude the recipients without a usable PDF — <strong>they will not be emailed</strong>. Or upload a corrected ZIP instead.
                      </span>
                    </label>
                  )}
                </section>
              )}
              <div className="otr-scroll" style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table className="otr-table">
                  <thead>
                    <tr>
                      <th>Send</th>
                      {review.sheets.length > 1 && <th>Sheet</th>}
                      <th>Company</th>
                      <th>Person</th>
                      <th>Template</th>
                      <th>To</th>
                      <th>CC</th>
                      {review.companyZip && (
                        <>
                          <th>PDF file</th>
                          <th>Match</th>
                        </>
                      )}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {review.rows.map((r) => {
                      const manually = excluded.includes(r.position)
                      return (
                        <tr key={r.position} aria-selected={r.position === previewPos}>
                          <td>
                            {(r.status === 'ready' || manually) && (
                              <input
                                type="checkbox"
                                aria-label={`Send to ${r.companyName}`}
                                checked={!manually}
                                disabled={act.busy === 'review'}
                                onChange={() => {
                                  const next = manually ? excluded.filter((x) => x !== r.position) : [...excluded, r.position]
                                  setExcluded(next)
                                  void loadReview({ excludePositions: next })
                                }}
                              />
                            )}
                          </td>
                          {review.sheets.length > 1 && <td className="cell-dim">{r.sheet}</td>}
                          <td>{r.companyName}</td>
                          <td>
                            {r.contactName ?? '—'}
                            {r.status === 'ready' && r.note && <div className="cell-dim">{r.note}</div>}
                          </td>
                          <td>{r.status === 'ready' ? (review.templates.length > 1 && r.templateNumber ? `Template ${r.templateNumber}` : 'Template') : '—'}</td>
                          <td>{r.toEmail ?? '—'}</td>
                          <td className="cell-dim">{r.ccEmails.join(', ') || '—'}</td>
                          {review.companyZip && (
                            <>
                              <td>{r.companyFile?.fileName ?? '—'}</td>
                              <td>
                                {r.companyFile ? (
                                  <Chip tone={MATCH_TONE[r.companyFile.status] ?? 'neutral'} title={r.companyFile.detail ?? undefined}>
                                    {MATCH_LABEL[r.companyFile.status] ?? r.companyFile.status}
                                  </Chip>
                                ) : (
                                  <span className="cell-dim">—</span>
                                )}
                              </td>
                            </>
                          )}
                          <td>
                            {r.status === 'ready' ? (
                              <button type="button" className="btn small quiet" onClick={() => setPreviewPos(r.position)}>
                                Preview<span className="sr-only"> {r.companyName}</span>
                              </button>
                            ) : (
                              <span className={r.status === 'blocked' ? 'otr-err' : 'cell-dim'} style={r.status === 'blocked' ? { padding: 0, border: 0, background: 'none' } : undefined}>
                                {r.status === 'blocked' ? 'Blocked' : 'Skipped'} — {r.reason}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {review.noAddress.length > 0 && <p className="note">Also {review.noAddress.length} rows without a usable address (listed on step 1) are counted as invalid.</p>}
              {preview && (
                <article className="bulk-email" aria-label="Email preview">
                  <p className="cell-dim">
                    From: {review.sender.email}
                    {review.replyTo ? ` · Reply-To ${review.replyTo}` : ''}
                  </p>
                  <p className="cell-dim">
                    To: {preview.toEmail}
                    {preview.ccEmails.length ? ` · CC: ${preview.ccEmails.join(', ')}` : ''}
                  </p>
                  <p>
                    {preview.templateNumber && review.templates.length > 1 && <Chip tone="info">Template {preview.templateNumber}</Chip>}{' '}
                    {review.sheets.length > 1 && preview.sheet && <Chip>Sheet: {preview.sheet}</Chip>}{' '}
                    <span className="field-label" style={{ display: 'inline', margin: 0 }}>
                      Subject
                    </span>{' '}
                    <strong>{preview.subject}</strong>
                  </p>
                  {(review.attachments.length > 0 || preview.companyFile?.fileName) && (
                    <p className="cell-dim">📎 {[...(preview.companyFile?.fileName ? [preview.companyFile.fileName] : []), ...review.attachments.map((a) => a.fileName)].join(', ')}</p>
                  )}
                  <Html html={preview.html ?? ''} label="Email content" />
                </article>
              )}
            </>
          )}

          <section className="bulk-section" aria-label="Attachments">
            <h3>Attachments (optional)</h3>
            <p className="note">
              Files on every email: up to {config.limits.maxCommonFiles}, {formatSize(config.limits.maxFileBytes)} each, {formatSize(config.limits.maxEmailAttachmentBytes)} per email in all. Programs and scripts are blocked. The real files
              are attached — never links.
            </p>
            {attachments.map((a) => (
              <div key={a.id} className="row">
                📎 {a.fileName} <span className="cell-dim">({formatSize(a.sizeBytes)})</span>
                <button type="button" className="btn small quiet" onClick={() => removeFile(a.id)}>
                  Remove<span className="sr-only"> {a.fileName}</span>
                </button>
              </div>
            ))}
            <input ref={fileInput} type="file" hidden multiple aria-label="Choose files to attach" onChange={(e) => addFiles(e.target.files)} />
            <input ref={zipInput} type="file" hidden accept=".zip" aria-label="Choose the ZIP of company PDFs" onChange={(e) => addZip(e.target.files?.[0])} />
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" className="btn small" disabled={Boolean(act.busy) || attachments.length >= config.limits.maxCommonFiles} onClick={() => fileInput.current?.click()}>
                Add attachments
              </button>
              <button type="button" className="btn small" disabled={Boolean(act.busy)} onClick={() => zipInput.current?.click()}>
                Upload ZIP (Company-Wise Attachments)
              </button>
            </div>
            <p className="note">
              Company-wise PDFs: one ZIP with a PDF for each company, named after the company (e.g. &ldquo;ABC Limited.pdf&rdquo;). Each recipient gets only their own company&rsquo;s PDF. Up to {formatSize(config.limits.maxZipBytes)}; keep this page
              open while a large ZIP uploads.
            </p>
            {zipProgress && (
              <p role="status">{zipProgress.sent >= zipProgress.total ? 'Checking the PDFs in the ZIP…' : `Uploading the ZIP — ${Math.floor((zipProgress.sent / zipProgress.total) * 100)}% (${formatSize(zipProgress.sent)} of ${formatSize(zipProgress.total)})`}</p>
            )}
            {zip && (
              <div className="row">
                📦 {zip.fileName} <span className="cell-dim">({formatSize(zip.sizeBytes)})</span>
                <button
                  type="button"
                  className="btn small quiet"
                  onClick={() =>
                    void act.run('zip', async () => {
                      await api.del(`/files/${zip.id}`).catch(() => undefined)
                      setZip(null)
                      setExcludeUnmatched(false)
                      filesChanged()
                    })
                  }
                >
                  Remove<span className="sr-only"> {zip.fileName}</span>
                </button>
              </div>
            )}
          </section>
          <div className="row" style={{ marginTop: 'var(--s3)' }}>
            <button type="button" className="btn quiet" onClick={() => setStep('upload')}>
              Back
            </button>
            <button type="button" className="btn primary" disabled={!review || counts!.eligible === 0 || counts!.blocked > 0 || Boolean(act.busy)} onClick={() => go('schedule')}>
              Next: date and time
            </button>
          </div>
        </>
      )}

      {step === 'schedule' && (
        <>
          <div className="otr-grid">
            <label>
              <span className="field-label">Date</span>
              <input type="date" aria-label="Date" value={startDate} onChange={(e) => (setStartDate(e.target.value), invalidate())} />
            </label>
            <label>
              <span className="field-label">Time, {config.timezone}</span>
              <input type="time" aria-label="Time" value={startTime} onChange={(e) => (setStartTime(e.target.value), invalidate())} />
            </label>
            <label>
              <span className="field-label">Minutes between emails</span>
              <input type="number" aria-label="Minutes between emails" min={config.minIntervalMinutes} max={240} value={interval} onChange={(e) => (setIntervalMinutes(e.target.value), invalidate())} />
            </label>
            <label>
              <span className="field-label">Name (optional)</span>
              <input type="text" aria-label="Name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: November proposals" />
            </label>
          </div>
          <label className="otr-check">
            <input type="checkbox" aria-label="Track opens" checked={trackOpens} disabled={!config.tracking.enabled} onChange={(e) => (setTrackOpens(e.target.checked), invalidate())} />
            <span>
              <strong>Track opens</strong> — see which recipients opened the email.{' '}
              {config.tracking.enabled ? (
                <span className="cell-dim">An open is detected when the email&rsquo;s invisible image loads. Some mail programs block images, and some privacy features and security scanners load them without anyone reading — so it is a signal, not proof of reading or of interest. Recipients are not told that opens are recorded.</span>
              ) : (
                <span className="cell-dim">Not available yet: {config.tracking.reason}</span>
              )}
            </span>
          </label>
          {!review ? (
            <div className="row" style={{ marginTop: 'var(--s3)' }}>
              <button type="button" className="btn quiet" onClick={() => go('review')}>
                Back
              </button>
              <button type="button" className="btn primary" disabled={!startDate || !startTime || !intervalOk || Boolean(act.busy)} onClick={() => void loadReview()}>
                {act.busy === 'review' ? 'Working…' : 'Show the sending times'}
              </button>
            </div>
          ) : (
            <>
              <ul className="otr-list">
                <li>
                  <strong>{review.counts.eligible} emails</strong>, one every {review.schedule.intervalMinutes} minutes, from <strong>{review.schedule.firstLocal}</strong> until <strong>{review.schedule.lastLocal}</strong>.
                </li>
                <li>
                  From: <strong>{review.sender.email}</strong>{' '}
                  {review.sender.ready ? <Chip tone="ok">Authorized</Chip> : <Chip tone="danger">Not ready</Chip>}
                  {review.sender.problems.length > 0 && <div className="cell-dim">{review.sender.problems.join(' ')}</div>}
                </li>
                {review.schedule.limitNote && <li className="cell-dim">{review.schedule.limitNote}</li>}
                <li>
                  Recipients: {review.sheets.length > 1 ? 'sheets' : 'sheet'} <strong>{review.sheet}</strong>, {review.onePer === 'person' ? 'one email per person' : 'one email per company'}
                </li>
                {review.templateOrder === 'by_sheet' && (
                  <li>
                    Each sheet with its own email:{' '}
                    {review.sheets
                      .map((name, i) => {
                        const plan = usedPlans[i]
                        const t = (saved.data?.templates ?? []).find((x) => x.id === plan?.templateId)
                        const n = review.rows.filter((r) => r.status === 'ready' && r.sheet === name).length
                        return `${name} → ${t ? t.name : `template ${i + 1}`} (${n} emails)`
                      })
                      .join(' · ')}
                  </li>
                )}
                <li>
                  Replies go to: <strong>{review.replyTo ?? review.sender.email}</strong>
                </li>
                <li>
                  Open tracking: <strong>{review.trackOpens ? 'on' : 'off'}</strong>
                </li>
                <li>CC: {[...(review.copyColleagues ? ['colleagues from the Excel'] : []), ...review.cc].join(', ') || 'none'}</li>
                <li>
                  Templates: {review.templates.map((t) => `${review.templates.length > 1 ? `${t.number}. ` : ''}${t.subject}`).join(' · ')}
                  {review.templateOrder && review.templateOrder !== 'by_sheet' ? ` (${review.templateOrder === 'random' ? 'at random' : 'in order'})` : ''}
                </li>
                {review.attachments.length > 0 && <li>Attachments on every email: {review.attachments.map((a) => `${a.fileName} (${formatSize(a.sizeBytes)})`).join(', ')}</li>}
                {review.companyZip && <li>Company PDFs from {review.companyZip.fileName}: each email carries only its own company&rsquo;s PDF.</li>}
                <li className="cell-dim">
                  Not sent: {review.counts.invalid} invalid · {review.counts.duplicate} duplicate · {review.counts.excluded} excluded.
                </li>
                {review.sendMode === 'test' && (
                  <li>
                    <Chip tone="accent">TEST MODE</Chip> <span className="cell-dim">nothing is sent; each email is written to the outbox.</span>
                  </li>
                )}
              </ul>
              <div className="otr-scroll" style={{ maxHeight: 220, overflowY: 'auto' }}>
                <table className="otr-table">
                  <tbody>
                    {review.rows
                      .filter((r) => r.status === 'ready')
                      .map((r) => (
                        <tr key={r.position}>
                          <td className="cell-dim">{r.scheduledLocal}</td>
                          <td>{r.companyName}</td>
                          <td className="cell-dim">{r.toEmail}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <label className="otr-check">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>I reviewed these {review.counts.eligible} emails and approve sending them at these times.</span>
              </label>
              <div className="row" style={{ marginTop: 'var(--s3)' }}>
                <button type="button" className="btn quiet" onClick={() => go('review')}>
                  Back
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!confirmed || !intervalOk || (!review.sender.ready && review.sender.problems.some((p) => !/daily limit/i.test(p))) || review.counts.eligible === 0 || review.counts.blocked > 0 || Boolean(act.busy)}
                  onClick={() =>
                    void act.run('start', async () => {
                      const r = await api.post<{ campaignId: string }>('/campaigns/start', { ...setup(), confirm: confirmed, reviewFingerprint: review.fingerprint })
                      navigate(`/campaigns/${r.campaignId}`)
                    })
                  }
                >
                  {act.busy === 'start' ? 'Starting…' : 'Approve and start sending'}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Panel>
  )
}
