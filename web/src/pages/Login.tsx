import { useState, type FormEvent } from 'react'
import { api, setToken } from '../api'
import { Banner } from '../ui'

export function Login({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ token: string }>('/auth/login', { email, password })
      setToken(r.token)
      await onSignedIn()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="login">
      <form className="card accent" onSubmit={submit} aria-label="Sign in">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            Y
          </span>
          <span>Bulk Email</span>
        </div>
        <h1>Sign in</h1>
        {error && <Banner kind="err">{error}</Banner>}
        <label className="field">
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="note">No account yet? Ask your administrator.</p>
      </form>
    </div>
  )
}
