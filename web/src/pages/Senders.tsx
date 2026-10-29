import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, type Account } from '../api'
import { canSend, useSession } from '../App'
import { Banner, Html, HtmlEditor, Status, useAction, useLoad } from '../ui'

// The Gmail accounts the team sends from. "Connect Gmail" opens Google's own page, where the person
// signs in and allows this app to SEND email as them (it cannot read their mailbox). No password is
// ever given to this app; the permission is kept encrypted and can be removed at any time.

export function Senders() {
  const { user, config } = useSession()
  const [params, setParams] = useSearchParams()
  const list = useLoad(() => api.get<{ accounts: Account[]; googleConfigured: boolean }>('/senders'))
  const act = useAction()
  const [checks, setChecks] = useState<Record<string, { ready: boolean; problems: string[]; remainingToday: number; dailyLimit: number }>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [signature, setSignature] = useState('')
  const [limit, setLimit] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const connected = params.get('connected')
  const error = params.get('error')
  const may = canSend(user)

  return (
    <>
      <div className="topbar">
        <h1>Sender accounts</h1>
        {may && (
          <button
            type="button"
            className="btn primary"
            disabled={!config.googleConfigured || Boolean(act.busy)}
            onClick={() =>
              void act.run('connect', async () => {
                const r = await api.post<{ url: string }>('/senders/connect')
                window.location.assign(r.url)
              })
            }
          >
            Connect Gmail
          </button>
        )}
      </div>
      {!config.googleConfigured && <Banner kind="warn">Gmail sign-in is not set up yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET). An administrator sets it up once — see the README.</Banner>}
      {connected && (
        <Banner kind="ok">
          {connected} is connected.{' '}
          <button type="button" className="btn small quiet" onClick={() => setParams({})}>
            OK
          </button>
        </Banner>
      )}
      {error && (
        <Banner kind="err">
          The account was not connected: {error}{' '}
          <button type="button" className="btn small quiet" onClick={() => setParams({})}>
            OK
          </button>
        </Banner>
      )}
      {(list.error || act.error) && <Banner kind="err">{list.error ?? act.error}</Banner>}
      {note && <Banner kind="ok">{note}</Banner>}
      <p className="note">
        Each person connects their own Gmail or Google Workspace account. You can send from the accounts you connected, and from accounts an admin has shared with the team. Google allows about 2,000 emails a day from a Workspace
        account and 500 from a free Gmail account; set each account&rsquo;s daily limit below that.
      </p>
      {list.data?.accounts.length === 0 && (
        <div className="card">
          <p className="muted">No account is connected yet.</p>
        </div>
      )}
      {list.data?.accounts.map((a) => {
        const check = checks[a.id]
        const mine = user.role === 'admin' || a.connectedByUserId === user.id
        return (
          <div key={a.id} className="card accent">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h3>{a.email}</h3>
                <div className="row">
                  <Status value={a.status} />
                  {a.shared && <span className="badge brand">shared with the team</span>}
                  {!a.usable && <span className="badge">not yours</span>}
                  <span className="muted">
                    {a.sentLast24h} sent in the last 24 hours · {a.remainingToday} of {a.dailyLimit} left
                  </span>
                </div>
                {a.statusReason && <div className="muted">{a.statusReason}</div>}
              </div>
              <div className="row">
                {a.usable && (
                  <button
                    type="button"
                    className="btn small"
                    disabled={Boolean(act.busy)}
                    onClick={() => void act.run('check', async () => setChecks({ ...checks, [a.id]: await api.post(`/senders/${a.id}/check`) }))}
                  >
                    Check readiness
                  </button>
                )}
                {may && a.status === 'needs_reconnect' && mine && (
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() =>
                      void act.run('connect', async () => {
                        window.location.assign((await api.post<{ url: string }>('/senders/connect')).url)
                      })
                    }
                  >
                    Reconnect
                  </button>
                )}
                {may && mine && (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      setEditing(editing === a.id ? null : a.id)
                      setSignature(a.signatureHtml)
                      setLimit(String(a.dailyLimit))
                    }}
                  >
                    Settings
                  </button>
                )}
                {may && mine && (
                  <button
                    type="button"
                    className="btn small danger"
                    onClick={() =>
                      window.confirm(`Disconnect ${a.email}? The permission is removed at Google too. You can connect it again later.`) &&
                      void act.run('disconnect', async () => {
                        await api.post(`/senders/${a.id}/disconnect`)
                        setNote(`${a.email} was disconnected.`)
                        list.refresh()
                      })
                    }
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </div>
            {check && (
              <div style={{ marginTop: 8 }}>
                {check.ready ? <Banner kind="ok">Ready to send. {check.remainingToday} emails left in the next 24 hours.</Banner> : <Banner kind="warn">Not ready: {check.problems.join(' ')}</Banner>}
              </div>
            )}
            {editing === a.id && (
              <div style={{ marginTop: 12 }}>
                <span className="field">Signature (added under every email from this account)</span>
                <HtmlEditor key={a.id} label="Signature" initialHtml={a.signatureHtml} onChange={setSignature} />
                <div className="grid2" style={{ marginTop: 8 }}>
                  <label className="field">
                    Daily limit
                    <input type="number" min={1} max={2000} value={limit} onChange={(e) => setLimit(e.target.value)} />
                  </label>
                  {user.role === 'admin' && (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={a.shared}
                        onChange={(e) =>
                          void act.run('share', async () => {
                            await api.patch(`/senders/${a.id}`, { shared: e.target.checked })
                            list.refresh()
                          })
                        }
                      />
                      Let every member send from this account
                    </label>
                  )}
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={Boolean(act.busy)}
                    onClick={() =>
                      void act.run('save', async () => {
                        const r = await api.patch<{ signatureRemoved: string[] }>(`/senders/${a.id}`, { signatureHtml: signature, dailyLimit: Number(limit) })
                        setNote(`Saved.${r.signatureRemoved.length ? ` Taken out of the signature for safety: ${r.signatureRemoved.join('; ')}.` : ''}`)
                        setEditing(null)
                        list.refresh()
                      })
                    }
                  >
                    Save
                  </button>
                </div>
                {a.signatureHtml && (
                  <>
                    <p className="note">Current signature:</p>
                    <Html html={a.signatureHtml} label="Current signature" />
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
