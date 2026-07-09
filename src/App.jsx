import { useState, useEffect, useRef } from 'react'
import { NavLink, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import Upload               from './pages/Upload'
import Enrollment           from './pages/Enrollment'
import Retention            from './pages/Retention'
import Classes              from './pages/Classes'
import SpecializedReporting from './pages/SpecializedReporting'
import ReportDetail         from './pages/ReportDetail'
import Login                from './pages/Login'

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
  const didInitialRedirect = useRef(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  // On the first authenticated load, always land on Reports regardless of the
  // entry URL (e.g. a bookmarked /upload or a browser-restored tab). Runs once
  // per app load, so navigating to Upload later in the session still works.
  useEffect(() => {
    if (session && !didInitialRedirect.current) {
      didInitialRedirect.current = true
      navigate('/reports', { replace: true })
    }
  }, [session, navigate])

  // Still resolving session — render nothing to avoid flash
  if (session === undefined) return null

  if (!session) return <Login />

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
        </Routes>
      </main>
    </div>
  )
}
