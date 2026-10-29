import { useState } from 'react'
import { api } from '../api'
import { canSend, useSession } from '../App'
import { Banner, useAction, useLoad } from '../ui'

// Addresses or whole domains that are never emailed — checked at the review and again at the moment of sending.

export function DoNotEmail() {
  const { user } = useSession()
  const list = useLoad(() => api.get<{ suppressions: Array<{ id: string; value: string; reason: string; createdAt: string }> }>('/suppressions'))
  const act = useAction()
  const [values, setValues] = useState('')
  const [reason, setReason] = useState('')
  const [done, setDone] = useState<string | null>(null)
  return (
    <>
      <h1>Do-not-email list</h1>
      <p className="note">Anyone on this list is never emailed by any campaign — checked at the review and again at the moment each email is sent. Add an address (name@company.com) or a whole domain (@company.com).</p>
      {(list.error || act.error) && <Banner kind="err">{list.error ?? act.error}</Banner>}
      {done && <Banner kind="ok">{done}</Banner>}
      {canSend(user) && (
        <div className="card accent">
          <label className="field">
            Addresses or domains (one per line, or separated by commas)
            <textarea rows={4} value={values} onChange={(e) => setValues(e.target.value)} placeholder={'someone@company.com\n@another-company.com'} />
          </label>
          <label className="field">
            Reason (optional)
            <input type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: asked not to be contacted" />
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={!values.trim() || Boolean(act.busy)}
            onClick={() =>
              void act.run('add', async () => {
                const r = await api.post<{ added: number; skipped: number }>('/suppressions', { values: values.split(/[\s,;]+/).filter(Boolean), reason })
                setDone(`${r.added} added${r.skipped ? `, ${r.skipped} were already on the list` : ''}.`)
                setValues('')
                setReason('')
                list.refresh()
              })
            }
          >
            Add to the list
          </button>
        </div>
      )}
      <div className="card">
        {list.data?.suppressions.length === 0 && <p className="muted">The list is empty.</p>}
        {list.data && list.data.suppressions.length > 0 && (
          <table className="data">
            <thead>
              <tr>
                <th>Address or domain</th>
                <th>Reason</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.suppressions.map((s) => (
                <tr key={s.id}>
                  <td>{s.value}</td>
                  <td className="muted">{s.reason}</td>
                  <td className="muted">{new Date(s.createdAt).toLocaleDateString()}</td>
                  <td>
                    {user.role === 'admin' && (
                      <button
                        type="button"
                        className="btn small quiet"
                        onClick={() =>
                          window.confirm(`Take ${s.value} off the do-not-email list?`) &&
                          void act.run('remove', async () => {
                            await api.del(`/suppressions/${s.id}`)
                            list.refresh()
                          })
                        }
                      >
                        Remove<span className="sr-only"> {s.value}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
