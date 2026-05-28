import { NavLink, Routes, Route, Navigate } from 'react-router-dom'
import Upload               from './pages/Upload'
import Enrollment           from './pages/Enrollment'
import Students             from './pages/Students'
import Retention            from './pages/Retention'
import Classes              from './pages/Classes'
import SpecializedReporting from './pages/SpecializedReporting'

const NAV_ITEMS = [
  { to: '/upload',     label: 'Upload'     },
  { to: '/enrollment', label: 'Enrollment' },
  { to: '/students',   label: 'Students'   },
  { to: '/retention',  label: 'Retention'  },
  { to: '/classes',    label: 'Classes'    },
  { to: '/reports',    label: 'Reports'    },
]

export default function App() {
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
      </aside>

      <main className="main-content">
        <Routes>
          <Route path="/"           element={<Navigate to="/upload" replace />} />
          <Route path="/upload"     element={<Upload />} />
          <Route path="/enrollment" element={<Enrollment />} />
          <Route path="/students"   element={<Students />} />
          <Route path="/retention"  element={<Retention />} />
          <Route path="/classes"    element={<Classes />} />
          <Route path="/reports"    element={<SpecializedReporting />} />
        </Routes>
      </main>
    </div>
  )
}
