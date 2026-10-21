import { useState, useEffect, useRef } from 'react'
import { NavLink, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { supabase, authLinkType } from './lib/supabase'
import Upload               from './pages/Upload'
import Enrollment           from './pages/Enrollment'
import Retention            from './pages/Retention'
import Classes              from './pages/Classes'
import SpecializedReporting from './pages/SpecializedReporting'
import ReportDetail         from './pages/ReportDetail'
import Login                from './pages/Login'
import SetPassword          from './pages/SetPassword'

const NAV_ITEMS = [
  { to: '/reports',    label: 'Reports'         },
  { to: '/enrollment', label: 'Enrollment'      },
  { to: '/retention',  label: 'Retention'       },
  { to: '/classes',    label: 'Classes'         },
  { to: '/upload',     label: 'Upload'          },
]

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = loading
  const navigate = useNavigate()
  const location = useLocation()
  const didInitialRedirect = useRef(false)
  // Arrived via a reset/invite link: signed in, but no password chosen yet.
  // Seeded from the URL fragment because the PASSWORD_RECOVERY event can fire
  // during client start-up, before this component subscribes.
  const [mustSetPassword, setMustSetPassword] = useState(authLinkType !== null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setMustSetPassword(true)
      setSession(session ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  // Deep links (e.g. /reports/enrollment-trends) are honored on first load,
  // including after signing in from one. The one exception is Upload: a
  // bookmarked or browser-restored /upload tab should open on Reports, not on
  // the page that writes to the database. Runs once per app load, so
  // navigating to Upload later in the session still works.
  useEffect(() => {
    if (session && !didInitialRedirect.current) {
      didInitialRedirect.current = true
      if (location.pathname === '/upload') navigate('/reports', { replace: true })
    }
  }, [session, navigate, location.pathname])

  // Still resolving session — render nothing to avoid flash
  if (session === undefined) return null

  if (!session) return <Login />

  if (mustSetPassword) {
    return <SetPassword isInvite={authLinkType === 'invite'} onDone={() => setMustSetPassword(false)} />
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-logo">CMC</span>
          <span className="sidebar-title">Dashboard</span>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            className="signout-btn"
            onClick={() => supabase.auth.signOut()}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="main-content">
        <Routes>
          <Route path="/"           element={<Navigate to="/reports" replace />} />
          <Route path="/upload"     element={<Upload />} />
          <Route path="/enrollment" element={<Enrollment />} />
          <Route path="/retention"  element={<Retention />} />
          <Route path="/classes"    element={<Classes />} />
          <Route path="/reports"    element={<SpecializedReporting />} />
          <Route path="/reports/:reportId" element={<ReportDetail />} />
          <Route path="*"           element={<Navigate to="/reports" replace />} />
        </Routes>
      </main>
    </div>
  )
}
