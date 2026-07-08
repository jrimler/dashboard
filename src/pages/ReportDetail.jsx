import { useParams, useNavigate, Navigate } from 'react-router-dom'
import { REPORTS } from '../reports/registry'

export default function ReportDetail() {
  const { reportId } = useParams()
  const navigate = useNavigate()

  const report = REPORTS.find(r => r.id === reportId)
  if (!report) return <Navigate to="/reports" replace />

  return (
    <div className="page sr-page">
      <div className="enroll-header sr-detail-header">
        <button className="back-btn" onClick={() => navigate('/reports')}>
          ← Back to Reports
        </button>
        <h1>{report.label}</h1>
      </div>

      <div className="sr-report-body">
        <report.component />
      </div>
    </div>
  )
}
