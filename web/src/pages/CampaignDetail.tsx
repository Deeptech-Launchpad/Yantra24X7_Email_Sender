import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type FileInfo } from '../api'
import { canSend, useSession } from '../App'
import { Banner, formatSize, Html, Status, Tile, useAction, useLoad } from '../ui'

interface RecipientRow {
  id: string
  position: number
  companyName: string
  contactName: string | null
  toEmail: string | null
  cc: string[]
  status: string
  category: string | null
  reason: string | null
  subject: string | null
  templateNumber: number | null
  companyFile: FileInfo | null
  attempts: number
  scheduledLocal: string | null
  sentLocal: string | null
  openCount: number
  trackingEnabled: boolean
}
interface View {
  campaign: {
    id: string
    name: string
    status: string
    statusReason: string | null
    sendMode: string
    createdByUserId: string
    fromEmail: string
    replyTo: string | null
    recipientMode: string
    sheetName: string | null
    cc: string[]
    copyColleagues: boolean
    intervalMinutes: number
    startLocal: string
    sourceFileName: string | null
    companyZipName: string | null
    templates: Array<{ number: number; subject: string }>
    review: { totalRows: number; eligible: number; invalid: number; duplicate: number; excluded: number }
  }
  counts: { scheduled: number; sending: number; sent: number; failed: number; unknown: number; skipped: number; cancelled: number; skippedInvalid: number; skippedDuplicate: number; skippedExcluded: number; total: number; opens: { tracked: number; opened: number } }
  attachments: FileInfo[]
  recipients: RecipientRow[]
  tracking: { enabled: boolean; reason: string | null }
  canCheckSent: boolean
}

const FILTERS = ['all', 'sent', 'scheduled', 'failed', 'unknown', 'skipped', 'cancelled'] as const

export function CampaignDetail() {
  const { id = '' } = useParams()
  const { user } = useSession()
  const { data, error, refresh } = useLoad(() => api.get<View>(`/campaigns/${id}`), [id])
  const act = useAction()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const [open, setOpen] = useState<{ id: string; html: string; subject: string; to: string } | null>(null)
  const [done, setDone] = useState<string | null>(null)

  // A running campaign refreshes itself every 30 seconds.
  useEffect(() => {
    if (data?.campaign.status !== 'running') return
    const t = setInterval(refresh, 30_000)
    return () => clearInterval(t)
  }, [data?.campaign.status, refresh])

  if (error && !data) return <Banner kind="err">{error}</Banner>
  if (!data) return <p className="muted">Loading…</p>
  const c = data.campaign
  const k = data.counts
  // Only the person who started it, or an admin, controls a campaign (the server checks this too).
  const may = canSend(user) && (user?.role === 'admin' || c.createdByUserId === user?.id)
  const control = (to: string) => act.run(to, async () => {
    await api.post(`/campaigns/${id}/${to}`)
    refresh()
  })
  const rows = data.recipients.filter((r) => filter === 'all' || r.status === filter)

  return (
    <>
      <div className="topbar">
        <div>
          <Link to="/campaigns" className="muted">
            ← All campaigns
          </Link>
          <h1>
            {c.name} {c.sendMode === 'test' && <span className="badge brand" title="Approved in test mode: nothing was sent, each email was written to the outbox.">TEST</span>}
          </h1>
          <div className="row">
            <Status value={c.status} />
            <span className="muted">
              From {c.fromEmail} · started {c.startLocal} · one every {c.intervalMinutes} min
            </span>
          </div>
        </div>
        <div className="row">
          <button type="button" className="btn small" onClick={() => void act.run('csv', () => api.download(`/campaigns/${id}/report.csv`, 'report.csv'))}>
            Download report (CSV)
          </button>
          {may && c.status === 'running' && (
            <button type="button" className="btn small" onClick={() => void control('pause')} disabled={Boolean(act.busy)}>
              Pause
            </button>
          )}
          {may && c.status === 'paused' && (
            <button type="button" className="btn small primary" onClick={() => void control('resume')} disabled={Boolean(act.busy)}>
              Resume
            </button>
          )}
          {may && (c.status === 'running' || c.status === 'paused') && (
            <button type="button" className="btn small danger" onClick={() => window.confirm('Cancel this campaign? Emails not yet sent will not be sent.') && void control('cancel')} disabled={Boolean(act.busy)}>
              Cancel
            </button>
          )}
        </div>
      </div>
      {c.statusReason && <Banner kind={c.status === 'paused' ? 'warn' : 'ok'}>{c.statusReason}</Banner>}
      {act.error && <Banner kind="err">{act.error}</Banner>}
      {done && <Banner kind="ok">{done}</Banner>}

      <div className="tiles">
        <Tile n={k.sent} label="Sent" brand />
        <Tile n={k.scheduled + k.sending} label="Waiting to send" />
        <Tile n={k.failed} label="Failed" />
        <Tile n={k.unknown} label="Outcome unknown" />
        <Tile n={k.skippedInvalid} label="Invalid" />
        <Tile n={k.skippedDuplicate} label="Duplicate" />
        <Tile n={k.skippedExcluded} label="Excluded" />
        <Tile n={k.cancelled} label="Cancelled" />
        {data.tracking.enabled ? <Tile n={`${k.opens.opened}/${k.opens.tracked}`} label="Opened (tracked)" /> : null}
      </div>
      {!data.tracking.enabled && <p className="note">{data.tracking.reason}</p>}

      {may && (k.failed > 0 || k.unknown > 0) && (
        <div className="card">
          {k.failed > 0 && (
            <div className="row" style={{ marginBottom: 8 }}>
              <strong>{k.failed} failed</strong>
              <span className="muted">— certainly not sent (see the reason against each). They can be sent again.</span>
              <button
                type="button"
                className="btn small primary"
                disabled={Boolean(act.busy)}
                onClick={() =>
                  void act.run('retry', async () => {
                    const r = await api.post<{ retried: number; skipped: number }>(`/campaigns/${id}/retry`, {})
                    setDone(`${r.retried} failed emails scheduled again${r.skipped ? ` (${r.skipped} already received this email elsewhere and were left out)` : ''}.`)
                    refresh()
                  })
                }
              >
                Retry failed
              </button>
            </div>
          )}
          {k.unknown > 0 && (
            <div className="row">
              <strong>{k.unknown} with an unknown outcome</strong>
              <span className="muted">— Gmail did not confirm them; they may have been sent, so they are never sent again automatically. Check {c.fromEmail}&rsquo;s Sent folder and mark each one below.</span>
              {data.canCheckSent && (
                <button
                  type="button"
                  className="btn small"
                  disabled={Boolean(act.busy)}
                  onClick={() =>
                    void act.run('reconcile', async () => {
                      const r = await api.post<{ checked: number; found: number }>(`/campaigns/${id}/reconcile`)
                      setDone(`Looked up ${r.checked} in Sent: ${r.found} found and marked sent.`)
                      refresh()
                    })
                  }
                >
                  Look them up in Sent
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid2">
        <div className="card">
          <h3>What was approved</h3>
          <p className="muted">
            Excel: {c.sourceFileName ?? '—'}{c.sheetName ? ` (sheet "${c.sheetName}")` : ''}{c.recipientMode === 'person' ? ' · one email per person' : ''} · {c.review.eligible} to send · {c.review.invalid} invalid · {c.review.duplicate} duplicate · {c.review.excluded} excluded
          </p>
          <p className="muted">Replies go to: {c.replyTo ?? c.fromEmail}</p>
          <p className="muted">CC: {[...(c.copyColleagues ? ['colleagues from the Excel'] : []), ...c.cc].join(', ') || 'none'}</p>
          <p className="muted">Templates: {c.templates.map((t) => `${t.number}. ${t.subject}`).join(' · ')}</p>
        </div>
        <div className="card">
          <h3>Attachments</h3>
          {data.attachments.length === 0 && !c.companyZipName && <p className="muted">None.</p>}
          {data.attachments.map((f) => (
            <div key={f.id} className="muted">
              📎 {f.fileName} ({formatSize(f.sizeBytes)}) — on every email
            </div>
          ))}
          {c.companyZipName && <div className="muted">📦 Company PDFs from {c.companyZipName} — each recipient gets only their own</div>}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h2>Recipients</h2>
          <label className="row muted">
            Show
            <select value={filter} onChange={(e) => setFilter(e.target.value as (typeof FILTERS)[number])} aria-label="Filter recipients">
              {FILTERS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Company</th>
                <th>To / CC</th>
                <th>Status</th>
                <th>Reason</th>
                <th>When</th>
                <th>PDF</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.companyName}
                    <div className="muted">
                      {r.contactName ?? ''}
                      {r.templateNumber ? ` · template ${r.templateNumber}` : ''}
                    </div>
                  </td>
                  <td>
                    {r.toEmail ?? '—'}
                    {r.cc.length > 0 && <div className="muted">CC: {r.cc.join(', ')}</div>}
                  </td>
                  <td>
                    <Status value={r.status} />
                    {r.category && <div className="muted">{r.category}</div>}
                    {r.trackingEnabled && r.openCount > 0 && <div className="muted">opened {r.openCount}×</div>}
                  </td>
                  <td className="muted">{r.reason ?? ''}</td>
                  <td className="muted">{r.sentLocal ?? r.scheduledLocal ?? '—'}</td>
                  <td className="muted">{r.companyFile?.fileName ?? ''}</td>
                  <td>
                    {r.subject && (
                      <button
                        type="button"
                        className="btn small quiet"
                        onClick={() =>
                          void act.run('view', async () => {
                            const e = await api.get<{ html: string; subject: string; toEmail: string }>(`/campaigns/${id}/recipients/${r.id}`)
                            setOpen({ id: r.id, html: e.html, subject: e.subject, to: e.toEmail })
                          })
                        }
                      >
                        View email
                      </button>
                    )}
                    {may && r.status === 'unknown' && (
                      <div className="row">
                        <button
                          type="button"
                          className="btn small"
                          onClick={() =>
                            window.confirm(`Is the email to ${r.toEmail} in the Sent folder of ${c.fromEmail}?`) &&
                            void act.run('resolve', async () => {
                              await api.post(`/campaigns/${id}/recipients/${r.id}/resolve`, { outcome: 'sent' })
                              refresh()
                            })
                          }
                        >
                          It was sent
                        </button>
                        <button
                          type="button"
                          className="btn small"
                          onClick={() =>
                            window.confirm(`You checked the Sent folder of ${c.fromEmail} and the email to ${r.toEmail} is NOT there? It can then be retried.`) &&
                            void act.run('resolve', async () => {
                              await api.post(`/campaigns/${id}/recipients/${r.id}/resolve`, { outcome: 'not_sent' })
                              refresh()
                            })
                          }
                        >
                          Not sent
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {open && (
        <div className="card accent" aria-label="Email">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>{open.subject}</strong>
              <div className="muted">To {open.to}</div>
            </div>
            <button type="button" className="btn small" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          <Html html={open.html} label="Email content" />
        </div>
      )}
    </>
  )
}
