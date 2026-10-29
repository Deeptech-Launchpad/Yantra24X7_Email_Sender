import { Link } from 'react-router-dom'
import { api } from '../api'
import { canSend, useSession } from '../App'
import { Banner, Status, useLoad } from '../ui'

interface Counts {
  scheduled: number
  sent: number
  failed: number
  unknown: number
  skipped: number
  cancelled: number
  total: number
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

export function Campaigns() {
  const { user } = useSession()
  const { data, error, loading, refresh } = useLoad(() => api.get<{ campaigns: CampaignRow[] }>('/campaigns'))
  return (
    <>
      <div className="topbar">
        <h1>Campaigns</h1>
        <div className="row">
          <button type="button" className="btn small" onClick={refresh}>
            Refresh
          </button>
          {canSend(user) && (
            <Link className="btn primary" to="/campaigns/new" style={{ textDecoration: 'none' }}>
              New campaign
            </Link>
          )}
        </div>
      </div>
      {error && <Banner kind="err">{error}</Banner>}
      {loading && !data && <p className="muted">Loading…</p>}
      {data && data.campaigns.length === 0 && (
        <div className="card accent">
          <h2>No campaigns yet</h2>
          <p className="note">Upload an Excel list of recipients, choose a template, review every email and approve it.</p>
        </div>
      )}
      {data && data.campaigns.length > 0 && (
        <div className="card">
          <table className="data">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>From</th>
                <th>Sent</th>
                <th>Waiting</th>
                <th>Failed</th>
                <th>Unknown</th>
                <th>Not sent</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.campaigns.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.name}</strong> {c.sendMode === 'test' && <span className="badge brand">TEST</span>}
                    <div className="muted">Started {c.startLocal}</div>
                    {c.statusReason && <div className="muted">{c.statusReason}</div>}
                  </td>
                  <td>
                    <Status value={c.status} />
                  </td>
                  <td>{c.fromEmail}</td>
                  <td>{c.counts.sent}</td>
                  <td>{c.counts.scheduled}</td>
                  <td>{c.counts.failed}</td>
                  <td>{c.counts.unknown}</td>
                  <td>{c.counts.skipped + c.counts.cancelled}</td>
                  <td>
                    <Link className="btn small" to={`/campaigns/${c.id}`} style={{ textDecoration: 'none' }}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
