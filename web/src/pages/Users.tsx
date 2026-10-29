import { useState } from 'react'
import { api, type Role, type User } from '../api'
import { useSession } from '../App'
import { Banner, useAction, useLoad } from '../ui'

// Admins only: the people who can sign in, and what each may do.

export function Users() {
  const { user } = useSession()
  const list = useLoad(() => api.get<{ users: Array<User & { status: string }> }>('/users'), [])
  const act = useAction()
  const [form, setForm] = useState({ email: '', name: '', role: 'member' as Role, password: '' })
  const [done, setDone] = useState<string | null>(null)
  if (user.role !== 'admin') return <Banner kind="err">Only an admin can manage users.</Banner>
  const change = (id: string, patch: Record<string, unknown>, what: string) =>
    void act.run('change', async () => {
      await api.patch(`/users/${id}`, patch)
      setDone(what)
      list.refresh()
    })
  return (
    <>
      <h1>Users</h1>
      <p className="note">
        <strong>admin</strong> — everything, including users and every sender account · <strong>member</strong> — campaigns, templates and their own sender accounts · <strong>viewer</strong> — can look, cannot change or send.
      </p>
      {(list.error || act.error) && <Banner kind="err">{list.error ?? act.error}</Banner>}
      {done && <Banner kind="ok">{done}</Banner>}
      <div className="card accent">
        <h2>Add a user</h2>
        <div className="grid2">
          <label className="field">
            Name
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            Email
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="field">
            Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="member">member</option>
              <option value="viewer">viewer</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <label className="field">
            First password (at least 10 characters, letters and digits)
            <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={!form.email || !form.name || !form.password || Boolean(act.busy)}
          onClick={() =>
            void act.run('add', async () => {
              await api.post('/users', form)
              setDone(`${form.email} can now sign in. Give them their password in person, not by email.`)
              setForm({ email: '', name: '', role: 'member', password: '' })
              list.refresh()
            })
          }
        >
          Add user
        </button>
      </div>
      <div className="card">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data?.users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>
                  <select aria-label={`Role of ${u.email}`} value={u.role} disabled={u.id === user.id} onChange={(e) => change(u.id, { role: e.target.value }, `${u.email} is now ${e.target.value}.`)}>
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                    <option value="viewer">viewer</option>
                  </select>
                </td>
                <td>{u.status}</td>
                <td className="row">
                  {u.id !== user.id && (
                    <button type="button" className="btn small" onClick={() => change(u.id, { status: u.status === 'active' ? 'disabled' : 'active' }, `${u.email} is now ${u.status === 'active' ? 'disabled' : 'active'}.`)}>
                      {u.status === 'active' ? 'Disable' : 'Enable'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn small quiet"
                    onClick={() => {
                      const pw = window.prompt(`New password for ${u.email} (at least 10 characters, letters and digits):`)
                      if (pw) change(u.id, { password: pw }, `The password of ${u.email} was changed.`)
                    }}
                  >
                    Reset password
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
