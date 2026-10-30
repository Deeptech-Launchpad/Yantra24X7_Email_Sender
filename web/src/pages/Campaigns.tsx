import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Account } from '../api'
import { canSend, useSession } from '../App'
import { Banner, Chip, Panel, Status, useLoad } from '../ui'

// THE BULK EMAIL PAGE, as in the Marketing AI Agent: the Sender panel on top, then the list of bulk emails.

interface Counts {
  scheduled: number
  sent: number
  failed: number
  unknown: number
  skipped: number
  cancelled: number
  total: number
  opens?: { tracked: number; opened: number }
}
export interface CampaignRow {
  id: string
  name: string
  status: string
  statusReason: string | null
  sendMode: string
  fromEmail: string
  startLocal: string
  approvedAt: string
  counts: Counts
}
interface Check {
  ready: boolean
  problems: string[]
  remainingToday: number
  dailyLimit: number
}

/** The Gmail accounts emails are sent from: who they are, whether they can send now, how much is left today. */
function SenderPanel() {
  const { user } = useSession()
  const list = useLoad(() => api.get<{ accounts: Account[] }>('/senders'))
  const [checks, setChecks] = useState<Record<string, Check>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const accounts = (list.data?.accounts ?? []).filter((a) => a.usable)
  const check = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      setChecks({ ...checks, [id]: await api.post<Check>(`/senders/${id}/check`) })
      list.refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Panel
      title="Sender"
      subtitle="The Gmail accounts emails are sent from. Customers see the account's address (and name) as the sender."
      actions={
        canSend(user) && (
          <Link to="/senders" className="btn small" style={{ textDecoration: 'none' }}>
            {accounts.length === 0 ? 'Set sender' : 'Manage senders'}
          </Link>
        )
      }
    >
      {list.loading && !list.data ? (
        <p className="muted">Loading…</p>
      ) : list.error ? (
        <p className="otr-err" role="alert">
          {list.error}
        </p>
      ) : accounts.length === 0 ? (
        <p className="muted">
          No sender account yet. Add the Gmail account the emails go from under <Link to="/senders">Sender accounts</Link>.
        </p>
      ) : (
        <ul className="otr-list">
          {accounts.map((a) => {
            const c = checks[a.id]
            return (
              <li key={a.id}>
                <div className="row">
                  <span className="field-label" style={{ margin: 0 }}>
                    From
                  </span>
                  <strong>{a.email}</strong>
                  {a.status === 'connected' ? <Chip tone="ok">Authorized</Chip> : <Chip tone="danger">{a.status === 'needs_reconnect' ? 'Reconnect needed' : 'Not connected'}</Chip>}
                  <span className="cell-dim">
                    {a.authType === 'app_password' ? 'app password' : 'Google sign-in'} · {a.sentLast24h} sent in the last 24 hours · {a.remainingToday} of {a.dailyLimit} left
                  </span>
                  <button type="button" className="btn small quiet" disabled={busy !== null} onClick={() => void check(a.id)}>
                    {busy === a.id ? 'Checking…' : 'Check sender'}
                    <span className="sr-only"> {a.email}</span>
                  </button>
                </div>
                {a.statusReason && a.status !== 'connected' && <div className="otr-warn">{a.statusReason}</div>}
                {c && (c.ready ? <div className="cell-dim">Ready to send. {c.remainingToday} of {c.dailyLimit} emails left today.</div> : <div className="otr-warn">{c.problems.join(' ')}</div>)}
              </li>
            )
          })}
        </ul>
      )}
      {error && (
        <p className="otr-err" role="alert">
          {error}
        </p>
      )}
    </Panel>
  )
}

export function Campaigns() {
  const { user } = useSession()
  const { data, error, loading, refresh } = useLoad(() => api.get<{ campaigns: CampaignRow[] }>('/campaigns'))
  return (
    <>
      <SenderPanel />
      <Panel
        title="Bulk email"
        subtitle="Upload an Excel list, review the emails, choose when to start — they go one after another."
        actions={
          <div className="row">
            <button type="button" className="btn small" onClick={refresh}>
              Refresh
            </button>
            {canSend(user) && (
              <Link className="btn small primary" to="/campaigns/new" style={{ textDecoration: 'none' }}>
                + New bulk email
              </Link>
            )}
          </div>
        }
      >
        {error && <Banner kind="err">{error}</Banner>}
        {loading && !data && <p className="muted">Loading…</p>}
        {data && data.campaigns.length === 0 && (
          <p className="muted">
            <strong>No bulk email yet.</strong> Click New bulk email and upload the Excel list of contacts.
          </p>
        )}
        {data && data.campaigns.length > 0 && (
          <table className="otr-table">
            <thead>
              <tr>
                <th>Bulk email</th>
                <th>Status</th>
                <th>Sent</th>
                <th>Scheduled</th>
                <th>Failed</th>
                <th>Unknown</th>
                <th>Not sent</th>
                <th>Opened</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.campaigns.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.name} {c.sendMode === 'test' && <Chip tone="accent">TEST</Chip>}
                    <div className="cell-dim">
                      From {c.fromEmail} · started {c.startLocal}
                    </div>
                  </td>
                  <td>
                    <Status value={c.status} />
                    {c.statusReason && <div className="cell-dim">{c.statusReason}</div>}
                  </td>
                  <td className="tnum">{c.counts.sent}</td>
                  <td className="tnum">{c.counts.scheduled}</td>
                  <td className="tnum">{c.counts.failed}</td>
                  <td className="tnum">{c.counts.unknown}</td>
                  <td className="tnum">{c.counts.skipped + c.counts.cancelled}</td>
                  <td className="tnum">{c.counts.opens && c.counts.opens.tracked > 0 ? `${c.counts.opens.opened} of ${c.counts.opens.tracked}` : '—'}</td>
                  <td>
                    <Link className="btn small" to={`/campaigns/${c.id}`} style={{ textDecoration: 'none' }}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  )
}
