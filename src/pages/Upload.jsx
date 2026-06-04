import { useState, useRef } from 'react'
import { uploadReports } from '../utils/uploadReports'
import { supabase } from '../lib/supabase'

export default function Upload() {
  const [regularFile, setRegularFile]   = useState(null)
  const [superFile, setSuperFile]       = useState(null)
  const [studentFile, setStudentFile]   = useState(null)
  const [classFile, setClassFile]       = useState(null)
  const [log, setLog]                   = useState([])
  const [uploading, setUploading]       = useState(false)
  const [testing, setTesting]           = useState(false)
  const [done, setDone]                 = useState(false)
  const [error, setError]               = useState(null)
  const logEndRef                       = useRef(null)

  function appendLog(msg) {
    setLog(prev => {
      const next = [...prev, msg]
      setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 0)
      return next
    })
  }

  async function handleTestConnection() {
    setTesting(true)
    setError(null)
    setLog([])
    setDone(false)

    const url = import.meta.env.VITE_SUPABASE_URL
    appendLog(`VITE_SUPABASE_URL: ${url ?? '(undefined)'}`)
    appendLog(`VITE_SUPABASE_ANON_KEY: ${import.meta.env.VITE_SUPABASE_ANON_KEY ? '(set)' : '(undefined)'}`)

    try {
      // Simple ping: select 1 row from students (will succeed even if table is empty)
      const { error: err } = await supabase.from('students').select('customer_id').limit(1)
      if (err) {
        appendLog(`ERROR: ${err.message} (code: ${err.code}, status: ${err.status ?? 'n/a'})`)
        appendLog(`Hint: ${err.hint ?? 'none'}`)
        setError(`Connection failed: ${err.message}`)
      } else {
        appendLog('Connection OK — Supabase is reachable and students table exists.')
      }
    } catch (e) {
      appendLog(`ERROR (network): ${e.message}`)
      setError(`Network error: ${e.message}`)
    } finally {
      setTesting(false)
    }
  }

  async function handleUpload() {
    if (!regularFile && !superFile && !studentFile && !classFile) {
      setError('Please select at least one file before uploading.')
      return
    }
    setError(null)
    setLog([])
    setDone(false)
    setUploading(true)

    try {
      await uploadReports(regularFile, superFile, studentFile, appendLog, classFile)
      setDone(true)
    } catch (err) {
      setError(err.message)
      appendLog(`ERROR: ${err.message}`)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="page">
      <h1>Upload Reports</h1>
      <p className="subtitle">
        Upload the four ASAP exports to refresh all dashboard data.
        Files may be real XLSX or HTML-disguised-as-XLS.
      </p>

      <div className="upload-form">
        <ReportSection
          label="Enrollment Report"
          url="https://app.asapconnected.com/Reports/EnrollmentsReport.aspx"
          instructions="Choose a wide range to capture all enrollments. Enrollment Status: Enrolled And Pending. Choose the latest time period. Everything else stays as-is."
          file={regularFile}
          onChange={setRegularFile}
          disabled={uploading}
        />
        <ReportSection
          label="Super Enrollment Report"
          url="https://app.asapconnected.com/reports/SuperEnrollment.aspx?ReportID=30209"
          instructions="Choose a wide range to capture all enrollments. Enrollment Status: Enrolled And Pending. Choose the latest time period. Everything else stays as-is."
          file={superFile}
          onChange={setSuperFile}
          disabled={uploading}
        />
        <ReportSection
          label="Student Report"
          url="https://app.asapconnected.com/Reports/StudentReport.aspx"
          instructions="Select Template: Age/Gender/Ethnicity. Status: Enrolled And Pending. Choose the latest time period. Everything else stays as-is."
          file={studentFile}
          onChange={setStudentFile}
          disabled={uploading}
        />
        <ReportSection
          label="Super Class Summary Report"
          url="https://app.asapconnected.com/reports/CustomQuery.aspx?ReportID=29315"
          instructions="Choose time period only."
          file={classFile}
          onChange={setClassFile}
          disabled={uploading}
        />

        {error && <div className="error-banner">{error}</div>}

        <div className="button-row">
          <button
            className="btn-primary"
            onClick={handleUpload}
            disabled={uploading || testing}
          >
            {uploading ? 'Uploading...' : 'Upload'}
          </button>
          <button
            className="btn-secondary"
            onClick={handleTestConnection}
            disabled={uploading || testing}
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
        </div>

        {done && (
          <div className="success-banner">Upload complete! Dashboard data has been refreshed.</div>
        )}
      </div>

      {log.length > 0 && (
        <div className="log-box">
          <div className="log-header">Log</div>
          <div className="log-body">
            {log.map((line, i) => (
              <div key={i} className={line.startsWith('ERROR') ? 'log-line error' : 'log-line'}>
                {line}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  )
}

function ReportSection({ label, url, instructions, file, onChange, disabled }) {
  return (
    <div className="file-input-group">
      <label className="file-label">{label}</label>
      <a href={url} target="_blank" rel="noreferrer" className="report-link">{url}</a>
      <p className="report-instructions">{instructions}</p>
      <div className="file-row">
        <label className={`file-btn ${disabled ? 'disabled' : ''}`}>
          {file ? 'Change file' : 'Choose file'}
          <input
            type="file"
            accept=".xlsx,.xls,.html,.htm"
            hidden
            disabled={disabled}
            onChange={e => onChange(e.target.files[0] ?? null)}
          />
        </label>
        <span className="file-name">{file ? file.name : 'No file selected'}</span>
      </div>
    </div>
  )
}
