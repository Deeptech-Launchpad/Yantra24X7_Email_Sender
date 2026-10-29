import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { api, getToken, SESSION_EXPIRED, setToken, type AppConfig, type User } from './api'
import { Banner } from './ui'
import { Login } from './pages/Login'
import { Campaigns } from './pages/Campaigns'
import { NewCampaign } from './pages/NewCampaign'
import { CampaignDetail } from './pages/CampaignDetail'
import { Templates } from './pages/Templates'
import { Senders } from './pages/Senders'
import { DoNotEmail } from './pages/DoNotEmail'
import { Users } from './pages/Users'

interface Session {
  user: User
  config: AppConfig
  signOut: () => void
}
const SessionContext = createContext<Session | null>(null)
export const useSession = () => {
  const s = useContext(SessionContext)
  if (!s) throw new Error('No session')
  return s
}
export const canSend = (u: User) => u.role === 'admin' || u.role === 'member'

function Layout({ children }: { children: ReactNode }) {
  const { user, config, signOut } = useSession()
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            {config.companyName.slice(0, 1).toUpperCase()}
          </span>
          <span>
            {config.companyName}
            <span className="brand-sub">Bulk email</span>
          </span>
        </div>
        <nav className="nav" aria-label="Main">
          <NavLink to="/campaigns" end={false}>
            Bulk email
          </NavLink>
          <NavLink to="/templates">Templates</NavLink>
          <NavLink to="/senders">Sender accounts</NavLink>
          <NavLink to="/do-not-email">Do-not-email list</NavLink>
          {user.role === 'admin' && <NavLink to="/users">Users</NavLink>}
        </nav>
        <div className="side-foot">
          <div>{user.name}</div>
          <div>
            {user.email} · {user.role}
          </div>
          <button type="button" className="btn quiet small" onClick={signOut} style={{ paddingLeft: 0 }}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        {config.sendMode === 'test' && (
          <Banner kind="test">TEST MODE — no email is sent. Every email is written to the server's outbox folder instead, so you can check exactly what would go.</Banner>
        )}
        {children}
      </main>
    </div>
  )
}

export function App() {
  const [session, setSession] = useState<{ user: User; config: AppConfig } | null>(null)
  const [checking, setChecking] = useState(Boolean(getToken()))

  const load = async () => {
    const [{ user }, config] = await Promise.all([api.get<{ user: User }>('/auth/me'), api.get<AppConfig>('/config')])
    setSession({ user, config })
  }
  useEffect(() => {
    if (getToken()) load().catch(() => setToken(null)).finally(() => setChecking(false))
    const expired = () => setSession(null)
    window.addEventListener(SESSION_EXPIRED, expired)
    return () => window.removeEventListener(SESSION_EXPIRED, expired)
  }, [])

  if (checking) return <p className="muted" style={{ padding: 24 }}>Loading…</p>
  if (!session) return <Login onSignedIn={() => load()} />
  const signOut = () => {
    setToken(null)
    setSession(null)
  }
  return (
    <SessionContext.Provider value={{ ...session, signOut }}>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Navigate to="/campaigns" replace />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/campaigns/new" element={<NewCampaign />} />
            <Route path="/campaigns/:id" element={<CampaignDetail />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/senders" element={<Senders />} />
            <Route path="/do-not-email" element={<DoNotEmail />} />
            <Route path="/users" element={<Users />} />
            <Route path="*" element={<Navigate to="/campaigns" replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </SessionContext.Provider>
  )
}
