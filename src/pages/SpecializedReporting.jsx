import { useNavigate } from 'react-router-dom'
import { REPORTS } from '../reports/registry'

export default function SpecializedReporting() {
  const navigate = useNavigate()

  return (
    <div className="page sr-page">
      <div className="enroll-header">
        <h1>Reports</h1>
      </div>

      <div className="sr-report-list">
        {REPORTS.map(r => (
          <button
            key={r.id}
            className="sr-report-btn"
            onClick={() => navigate(`/reports/${r.id}`)}
          >
            <span className="sr-report-btn-label">{r.label}</span>
            <span className="sr-report-btn-desc">{r.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
