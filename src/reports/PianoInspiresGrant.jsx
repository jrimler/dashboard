import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  parseQuarter, quarterFYLabel,
  quarterSortKey, fySortKey,
  periodLabel,
} from '../utils/periodUtils'

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function esc(v) { return `"${String(v ?? '').replace(/"/g, '""')}"` }

function triggerDownload(csv, filename) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  URL.revokeObjectURL(url)
}

function isPianoKeyboard(courseName) {
  if (!courseName) return false
  const lower = courseName.toLowerCase()
  return lower.includes('piano') || lower.includes('keyboard')
}

// ─────────────────────────────────────────────────────────────────────────────
// Period selector (same as Enrollment / Classes)
// ─────────────────────────────────────────────────────────────────────────────

function PeriodSelector({ fyPeriods, quarterGroups, isSelected, toggle, onClear, hasSelection }) {
  return (
    <div className="period-selector">
      <div className="period-selector-header">
        <span className="period-selector-title">Select Periods</span>
        {hasSelection && (
          <button className="period-clear-btn" onClick={onClear}>Clear</button>
        )}
      </div>

      {fyPeriods.length > 0 && (
        <div className="period-section">
          <div className="period-section-label">Fiscal Years</div>
          <div className="period-pills">
            {fyPeriods.map(p => (
              <button
                key={p.value}
                className={`period-pill${isSelected(p) ? ' active' : ''}`}
                onClick={() => toggle(p)}
              >
                {p.value}
              </button>
            ))}
          </div>
        </div>
      )}

      {quarterGroups.length > 0 && (
        <div className="period-section">
          <div className="period-section-label">Quarters</div>
          <div className="quarter-groups">
            {quarterGroups.map(({ fy, quarters }) => (
              <div key={fy} className="quarter-group">
                <div className="quarter-group-fy">{fy}</div>
                <div className="period-pills">
                  {quarters.map(p => (
                    <button
                      key={p.value}
                      className={`period-pill${isSelected(p) ? ' active' : ''}`}
                      onClick={() => toggle(p)}
                      title={p.value}
                    >
                      {periodLabel(p)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function exportRosterCSV(roster, periodLabel) {
  const headers = [
    'First Name', 'Last Name', 'Customer ID',
    'Enrollments', 'Tuition Free?', 'Discount Amount', 'Assistance Received',
  ]
  const rows = roster.map(s => [
    s.firstName,
    s.lastName,
    s.customerId,
    s.courseNames.join('; '),
    s.isTuitionFree ? 'Yes' : 'No',
    s.totalDiscount,
    s.assistanceReceived ? 'Yes' : 'No',
  ])
  triggerDownload(
    [headers, ...rows].map(r => r.map(esc).join(',')).join('\n'),
    `piano-inspires-grant-${periodLabel}.csv`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Data processing
// ─────────────────────────────────────────────────────────────────────────────

function buildRoster(enrollments) {
  const byCustomer = {}

  for (const e of enrollments) {
    const cid = e.customer_id
    if (!byCustomer[cid]) {
      byCustomer[cid] = {
        customerId:    cid,
        firstName:     e.students?.first_name ?? '',
        lastName:      e.students?.last_name  ?? '',
        courseNames:   [],
        isTuitionFree: false,
        totalDiscount: 0,
        assistanceReceived: false,
      }
    }
    const s = byCustomer[cid]
    const course = e.events?.course_name ?? null
    if (course && !s.courseNames.includes(course)) s.courseNames.push(course)
    if (e.is_tuition_free) s.isTuitionFree = true
    const disc = Number(e.total_discount ?? 0)
    s.totalDiscount += disc
    if (e.is_tuition_free || disc > 0) s.assistanceReceived = true
  }

  return Object.values(byCustomer).sort((a, b) =>
    (a.lastName ?? '').localeCompare(b.lastName ?? '') ||
    (a.firstName ?? '').localeCompare(b.firstName ?? '')
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main report component
// ─────────────────────────────────────────────────────────────────────────────

export default function PianoInspiresGrant() {
  const [availableData, setAvailableData] = useState([])
  const [enrollments, setEnrollments]     = useState([])
  const [periodsLoading, setPeriodsLoading] = useState(true)
  const [loading, setLoading]             = useState(false)
  const [error, setError]                 = useState(null)
  const [selected, setSelected]           = useState([])
  const [coursesOpen, setCoursesOpen]     = useState(false)

  useEffect(() => { loadPeriods() }, [])

  async function loadPeriods() {
    // Lightweight: fetch only the period columns from enrollments that join to
    // piano/keyboard events, so the period pills only show relevant periods.
    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await supabase
        .from('enrollments')
        .select('customer_id, time_period, fiscal_year, events(activity_type, course_name)')
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setPeriodsLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }
    // Keep only rows that match piano/keyboard criteria
    const relevant = all.filter(e => {
      const at = e.events?.activity_type
      const cn = e.events?.course_name
      if (at === 'LESSON' || at === 'CLASS') return isPianoKeyboard(cn)
      return false
    })
    setAvailableData(relevant)
    setPeriodsLoading(false)
  }

  useEffect(() => {
    if (selected.length === 0) {
      setEnrollments([])
      setError(null)
      return
    }
    loadData(selected)
  }, [selected])

  async function loadData(selectedPeriods) {
    setLoading(true)
    setError(null)

    const quarters = selectedPeriods.filter(p => p.type === 'quarter').map(p => p.value)
    const fys      = selectedPeriods.filter(p => p.type === 'fiscal_year').map(p => p.value)

    let query = supabase
      .from('enrollments')
      .select(`
        event_enrollment_id, customer_id, time_period, fiscal_year,
        is_tuition_free, total_discount,
        events(activity_type, course_name),
        students(first_name, last_name)
      `)

    if (quarters.length > 0 && fys.length > 0) {
      const qList = quarters.map(q => `"${q}"`).join(',')
      const fList = fys.map(f => `"${f}"`).join(',')
      query = query.or(`time_period.in.(${qList}),fiscal_year.in.(${fList})`)
    } else if (quarters.length > 0) {
      query = query.in('time_period', quarters)
    } else {
      query = query.in('fiscal_year', fys)
    }

    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await query.range(from, from + PAGE - 1)
      if (error) { setError(error.message); setLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }

    // Filter client-side to piano/keyboard lessons and classes only
    const piano = all.filter(e => {
      const at = e.events?.activity_type
      const cn = e.events?.course_name
      if (at === 'LESSON' || at === 'CLASS') return isPianoKeyboard(cn)
      return false
    })

    setEnrollments(piano)
    setLoading(false)
  }

  const { fyPeriods, quarterGroups } = useMemo(() => {
    const qSet = new Set(), fySet = new Set()
    for (const e of availableData) {
      if (e.time_period) qSet.add(e.time_period)
      if (e.fiscal_year) fySet.add(e.fiscal_year)
    }
    const fyPeriods = [...fySet]
      .map(v => ({ type: 'fiscal_year', value: v }))
      .sort((a, b) => fySortKey(a.value) - fySortKey(b.value))
    const byFY = {}
    for (const qv of qSet) {
      const q = parseQuarter(qv)
      if (!q) continue
      const fy = quarterFYLabel(q.season, q.year)
      if (!byFY[fy]) byFY[fy] = []
      byFY[fy].push({ type: 'quarter', value: qv })
    }
    const quarterGroups = Object.entries(byFY)
      .sort(([a], [b]) => fySortKey(a) - fySortKey(b))
      .map(([fy, quarters]) => ({
        fy,
        quarters: quarters.sort((a, b) => quarterSortKey(a.value) - quarterSortKey(b.value)),
      }))
    return { fyPeriods, quarterGroups }
  }, [availableData])

  const roster = useMemo(() => buildRoster(enrollments), [enrollments])

  const matchedCourses = useMemo(() => {
    const names = new Set()
    for (const e of enrollments) {
      const cn = e.events?.course_name
      if (cn) names.add(cn)
    }
    return [...names].sort()
  }, [enrollments])

  const totalStudents    = roster.length
  const assistedStudents = roster.filter(s => s.assistanceReceived).length
  const assistedPct      = totalStudents === 0 ? null : (assistedStudents / totalStudents * 100)

  const periodFileLabel = selected
    .map(p => p.value.replace(/\s+/g, '-'))
    .join('_') || 'export'

  function toggle(p) {
    setSelected(prev => {
      const has = prev.some(x => x.type === p.type && x.value === p.value)
      return has
        ? prev.filter(x => !(x.type === p.type && x.value === p.value))
        : [...prev, p]
    })
  }
  const isSelected = p => selected.some(x => x.type === p.type && x.value === p.value)

  const hasData = fyPeriods.length > 0 || quarterGroups.length > 0

  if (periodsLoading) return <p className="coming-soon">Loading…</p>

  return (
    <div className="pig-report">
      {error && <div className="error-banner">{error}</div>}

      {!hasData ? (
        <p className="coming-soon">No piano or keyboard enrollment data found.</p>
      ) : (
        <>
          <PeriodSelector
            fyPeriods={fyPeriods}
            quarterGroups={quarterGroups}
            isSelected={isSelected}
            toggle={toggle}
            onClear={() => setSelected([])}
            hasSelection={selected.length > 0}
          />

          {loading ? (
            <p className="coming-soon">Loading data…</p>
          ) : selected.length === 0 ? (
            <p className="coming-soon">Select one or more periods above to generate the report.</p>
          ) : (
            <>
              {/* Summary cards */}
              <div className="pig-summary">
                <div className="pig-stat-card">
                  <div className="pig-stat-value">{totalStudents.toLocaleString()}</div>
                  <div className="pig-stat-label">Total piano/keyboard students</div>
                </div>
                <div className="pig-stat-card">
                  <div className="pig-stat-value">{assistedStudents.toLocaleString()}</div>
                  <div className="pig-stat-label">Students with tuition assistance</div>
                </div>
                <div className="pig-stat-card pig-stat-card--accent">
                  <div className="pig-stat-value">
                    {assistedPct === null ? '—' : `${assistedPct.toFixed(1)}%`}
                  </div>
                  <div className="pig-stat-label">Receiving assistance</div>
                </div>
              </div>

              {/* Methodology */}
              <div className="pig-methodology">
                <div className="pig-methodology-title">How this number is calculated</div>
                <p>
                  This report counts unique students enrolled in any private piano or keyboard
                  lesson, or any group class with "piano" or "keyboard" in the course name,
                  during the selected period(s). Each student is counted once regardless of how
                  many qualifying classes they attended.
                </p>
                <p>
                  A student is marked as receiving tuition assistance if any of their qualifying
                  enrollments had a net cost of $15 or less (tuition-free) OR if any discount
                  was applied to a qualifying enrollment.
                </p>
                <p>
                  Matching course names include any course containing "piano" or "keyboard"
                  (case-insensitive). To verify which courses were matched, see the Course
                  Coverage section below.
                </p>
              </div>

              {/* Course coverage */}
              <div className="pig-courses">
                <button
                  className="pig-courses-toggle"
                  onClick={() => setCoursesOpen(o => !o)}
                >
                  <span>
                    Matched {matchedCourses.length} course{matchedCourses.length !== 1 ? 's' : ''}
                    {matchedCourses.length > 0 && !coursesOpen && (
                      <span className="pig-courses-preview">
                        : {matchedCourses.slice(0, 3).join(', ')}
                        {matchedCourses.length > 3 && '…'}
                      </span>
                    )}
                  </span>
                  <span className="pig-courses-chevron">{coursesOpen ? '▲' : '▼'}</span>
                </button>
                {coursesOpen && (
                  <div className="pig-courses-list">
                    {matchedCourses.map(name => (
                      <span key={name} className="pig-course-chip">{name}</span>
                    ))}
                  </div>
                )}
              </div>

              {/* Roster table */}
              <div className="pig-roster-header">
                <span className="pig-roster-title">
                  Student Roster ({totalStudents.toLocaleString()})
                </span>
                <button
                  className="btn-secondary"
                  onClick={() => exportRosterCSV(roster, periodFileLabel)}
                >
                  Export CSV
                </button>
              </div>

              <div className="report-scroll">
                <table className="pig-table">
                  <thead>
                    <tr>
                      <th>First Name</th>
                      <th>Last Name</th>
                      <th>Customer ID</th>
                      <th>Enrollments</th>
                      <th className="pig-num">Tuition Free?</th>
                      <th className="pig-num">Discount Amount</th>
                      <th className="pig-num">Assistance Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.map(s => (
                      <tr key={s.customerId}>
                        <td>{s.firstName || '—'}</td>
                        <td>{s.lastName  || '—'}</td>
                        <td className="pig-mono">{s.customerId}</td>
                        <td className="pig-courses-cell">{s.courseNames.join(', ') || '—'}</td>
                        <td className={`pig-num${s.isTuitionFree ? ' pig-yes' : ''}`}>
                          {s.isTuitionFree ? 'Yes' : 'No'}
                        </td>
                        <td className="pig-num">
                          {s.totalDiscount > 0
                            ? `$${s.totalDiscount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
                            : '—'
                          }
                        </td>
                        <td className={`pig-num${s.assistanceReceived ? ' pig-yes' : ''}`}>
                          {s.assistanceReceived ? 'Yes' : 'No'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
