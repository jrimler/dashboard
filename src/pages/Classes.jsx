import { useState, useEffect, useMemo, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import {
  parseQuarter, quarterFYLabel,
  quarterSortKey, fySortKey,
  periodLabel,
} from '../utils/periodUtils'

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function fmtDate(d) {
  if (!d) return null
  const [y, m, day] = d.split('-').map(Number)
  return new Date(y, m - 1, day).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

function fmtDateRange(start, end) {
  const s = fmtDate(start), e = fmtDate(end)
  if (!s) return '—'
  if (!e || s === e) return s
  return `${s} – ${e}`
}

function esc(v) { return `"${String(v ?? '').replace(/"/g, '""')}"` }

function triggerDownload(csv, filename) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  URL.revokeObjectURL(url)
}

function today() { return new Date().toISOString().slice(0, 10) }

// ─────────────────────────────────────────────────────────────────────────────
// Period selector (same pattern as Enrollment.jsx)
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
// Build class list from separate events + enrollments arrays
// ─────────────────────────────────────────────────────────────────────────────

function buildClassList(eventsData, enrollmentsData) {
  const byEvent = {}
  for (const ev of eventsData) {
    byEvent[ev.event_id] = {
      eventId:           ev.event_id,
      courseName:        ev.course_name,
      department:        ev.department,
      location:          ev.location?.trim() ?? null,
      facility:          ev.facility,
      instructor:        ev.primary_instructor,
      classStartDate:    ev.class_start_date,
      classEndDate:      ev.class_end_date,
      lessonDurationMin: ev.lesson_duration_minutes,
      allMeetings:       ev.all_meetings,
      eventFiscalYear:   ev.fiscal_year,
      eventTimePeriod:   ev.time_period,
      enrollments:       [],
    }
  }

  for (const e of enrollmentsData) {
    if (!byEvent[e.event_id]) continue
    byEvent[e.event_id].enrollments.push({
      eid:          e.event_enrollment_id,
      cid:          e.customer_id,
      firstName:    e.students?.first_name ?? null,
      lastName:     e.students?.last_name  ?? null,
      amount:       e.amount,
      discountType: e.discount_type,
      isTuitionFree: e.is_tuition_free,
    })
  }

  return Object.values(byEvent).map(cls => {
    const freeCount = cls.enrollments.filter(e => e.isTuitionFree).length
    return {
      ...cls,
      enrollmentCount: cls.enrollments.length,
      tuitFreeCount:   freeCount,
      // tuition-free class = every enrollment is free
      isTuitionFree:   cls.enrollments.length > 0 && freeCount === cls.enrollments.length,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Sorting
// ─────────────────────────────────────────────────────────────────────────────

function sortClasses(classes, col, dir) {
  return [...classes].sort((a, b) => {
    let va, vb
    switch (col) {
      case 'courseName': va = a.courseName ?? ''; vb = b.courseName ?? ''; break
      case 'department': va = a.department ?? ''; vb = b.department ?? ''; break
      case 'instructor': va = a.instructor ?? ''; vb = b.instructor ?? ''; break
      case 'location':   va = a.location        ?? ''; vb = b.location        ?? ''; break
      case 'quarter':    va = a.eventTimePeriod ?? ''; vb = b.eventTimePeriod ?? ''; break
      case 'enrolled':   va = a.enrollmentCount;  vb = b.enrollmentCount;  break
      case 'tuitFree':   va = a.tuitFreeCount;    vb = b.tuitFreeCount;    break
      case 'startDate':  va = a.classStartDate ?? ''; vb = b.classStartDate ?? ''; break
      case 'sessions':   va = a.allMeetings ?? 0; vb = b.allMeetings ?? 0; break
      default: return 0
    }
    if (va < vb) return dir === 'asc' ? -1 : 1
    if (va > vb) return dir === 'asc' ?  1 : -1
    return 0
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV exports
// ─────────────────────────────────────────────────────────────────────────────

function exportTableCSV(classes) {
  const headers = [
    'Course Name', 'Department', 'Instructor', 'Location', 'Quarter',
    'Enrolled', 'Tuition Free', 'Fee Based',
    'Start Date', 'End Date', 'Sessions',
  ]
  const rows = classes.map(c => [
    c.courseName, c.department, c.instructor, c.location, c.eventTimePeriod ?? '',
    c.enrollmentCount, c.tuitFreeCount, c.enrollmentCount - c.tuitFreeCount,
    c.classStartDate ?? '', c.classEndDate ?? '', c.allMeetings ?? '',
  ])
  triggerDownload(
    [headers, ...rows].map(r => r.map(esc).join(',')).join('\n'),
    `cmc-classes-${today()}.csv`
  )
}

function exportDrilldownCSV(cls) {
  const headers = ['Last Name', 'First Name', 'Customer ID', 'Amount', 'Discount Type', 'Tuition Free']
  const rows = cls.enrollments
    .slice()
    .sort((a, b) => (a.lastName ?? '').localeCompare(b.lastName ?? ''))
    .map(e => [
      e.lastName, e.firstName, e.cid,
      e.amount ?? '', e.discountType ?? '',
      e.isTuitionFree ? 'Yes' : 'No',
    ])
  triggerDownload(
    [headers, ...rows].map(r => r.map(esc).join(',')).join('\n'),
    `cmc-class-${cls.eventId}-${today()}.csv`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sortable header cell
// ─────────────────────────────────────────────────────────────────────────────

function SortTh({ col, label, align, sortCol, sortDir, onSort }) {
  const active = sortCol === col
  return (
    <th
      className={`cls-th${active ? ' sorted' : ''}`}
      style={{ textAlign: align ?? 'left' }}
      onClick={() => onSort(col)}
    >
      {label}
      <span className="sort-arrow">{active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ' ↕'}</span>
    </th>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Drilldown expanded row
// ─────────────────────────────────────────────────────────────────────────────

function DrilldownRow({ cls, colCount }) {
  const sortedStudents = cls.enrollments
    .slice()
    .sort((a, b) => (a.lastName ?? '').localeCompare(b.lastName ?? ''))

  return (
    <tr className="cls-drilldown-row">
      <td colSpan={colCount} className="cls-drilldown-cell">
        <div className="cls-drilldown">

          {/* Left: class details */}
          <div className="cls-drilldown-left">
            <div className="cls-drilldown-header">
              <span className="cls-drilldown-label">Class Details</span>
            </div>
            <dl className="cls-detail-grid">
              <dt>Course</dt>       <dd>{cls.courseName ?? '—'}</dd>
              <dt>Department</dt>   <dd>{cls.department ?? '—'}</dd>
              <dt>Instructor</dt>   <dd>{cls.instructor ?? '—'}</dd>
              <dt>Location</dt>     <dd>{cls.location ?? '—'}</dd>
              <dt>Facility</dt>     <dd>{cls.facility ?? '—'}</dd>
              <dt>Dates</dt>        <dd>{fmtDateRange(cls.classStartDate, cls.classEndDate)}</dd>
              <dt>Sessions</dt>     <dd>{cls.allMeetings ?? '—'}</dd>
              <dt>Duration</dt>     <dd>{cls.lessonDurationMin ? `${cls.lessonDurationMin} min` : '—'}</dd>
              <dt>Period</dt>       <dd>{cls.eventTimePeriod ?? '—'}</dd>
              <dt>Fiscal Year</dt>  <dd>{cls.eventFiscalYear ?? '—'}</dd>
              <dt>Enrolled</dt>     <dd>{cls.enrollmentCount} ({cls.tuitFreeCount} tuition-free)</dd>
            </dl>
          </div>

          {/* Right: enrolled students */}
          <div className="cls-drilldown-right">
            <div className="cls-drilldown-header">
              <span className="cls-drilldown-label">
                Enrolled Students ({cls.enrollments.length})
              </span>
              <button
                className="btn-secondary cls-dd-export"
                onClick={() => exportDrilldownCSV(cls)}
              >
                Export CSV
              </button>
            </div>
            <div className="cls-student-scroll">
              <table className="cls-student-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Customer ID</th>
                    <th>Amount</th>
                    <th>Discount Type</th>
                    <th>Tuition Free</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedStudents.map(e => (
                    <tr key={e.eid}>
                      <td>{[e.lastName, e.firstName].filter(Boolean).join(', ') || '—'}</td>
                      <td className="cls-mono">{e.cid}</td>
                      <td className="cls-num-sm">{e.amount != null ? `$${Number(e.amount).toLocaleString()}` : '—'}</td>
                      <td>{e.discountType ?? '—'}</td>
                      <td>{e.isTuitionFree ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </td>
    </tr>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function Classes() {
  const [availableEvents, setAvailableEvents] = useState([])  // lightweight: just for period pills
  const [classes, setClasses]                 = useState([])
  const [periodsLoading, setPeriodsLoading]   = useState(true)
  const [loading, setLoading]                 = useState(false)
  const [error, setError]                     = useState(null)
  const [selected, setSelected]               = useState([])
  const [tuitFilter, setTuitFilter]           = useState({ free: true, fee: true })
  const [sortCol, setSortCol]                 = useState('courseName')
  const [sortDir, setSortDir]                 = useState('asc')
  const [expandedId, setExpandedId]           = useState(null)

  // On mount: lightweight fetch to populate period pills only
  useEffect(() => { loadPeriods() }, [])

  async function loadPeriods() {
    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await supabase
        .from('events')
        .select('event_id, time_period, fiscal_year')
        .eq('activity_type', 'CLASS')
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setPeriodsLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }
    setAvailableEvents(all)
    setPeriodsLoading(false)
  }

  // On period selection: fetch scoped events then scoped enrollments
  useEffect(() => {
    if (selected.length === 0) {
      setClasses([])
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

    // Fetch CLASS events filtered server-side by selected periods
    let eventsQuery = supabase
      .from('events')
      .select(`
        event_id, course_name, department, location, facility,
        primary_instructor, class_start_date, class_end_date,
        lesson_duration_minutes, all_meetings, fiscal_year, time_period
      `)
      .eq('activity_type', 'CLASS')

    if (quarters.length > 0 && fys.length > 0) {
      const qList = quarters.map(q => `"${q}"`).join(',')
      const fList = fys.map(f => `"${f}"`).join(',')
      eventsQuery = eventsQuery.or(`time_period.in.(${qList}),fiscal_year.in.(${fList})`)
    } else if (quarters.length > 0) {
      eventsQuery = eventsQuery.in('time_period', quarters)
    } else {
      eventsQuery = eventsQuery.in('fiscal_year', fys)
    }

    const { data: eventsData, error: eventsError } = await eventsQuery
    if (eventsError) { setError(eventsError.message); setLoading(false); return }

    const eventIds = eventsData.map(e => e.event_id)
    if (eventIds.length === 0) {
      setClasses([])
      setLoading(false)
      return
    }

    // Fetch enrollments scoped to those event IDs only
    const PAGE = 1000
    let from = 0, allEnrollments = []
    while (true) {
      const { data, error } = await supabase
        .from('enrollments')
        .select('event_enrollment_id, event_id, customer_id, is_tuition_free, amount, discount_type, students(first_name, last_name)')
        .in('event_id', eventIds)
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setLoading(false); return }
      allEnrollments = allEnrollments.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }

    setClasses(buildClassList(eventsData, allEnrollments))
    setLoading(false)
  }

  // Derive period pills from lightweight availableEvents
  const { fyPeriods, quarterGroups } = useMemo(() => {
    const qSet = new Set(), fySet = new Set()
    for (const e of availableEvents) {
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
  }, [availableEvents])

  const visibleClasses = useMemo(() => {
    let cls = classes
    if (!tuitFilter.free) cls = cls.filter(c => !c.isTuitionFree)
    if (!tuitFilter.fee)  cls = cls.filter(c =>  c.isTuitionFree)
    return sortClasses(cls, sortCol, sortDir)
  }, [classes, tuitFilter, sortCol, sortDir])

  function togglePeriod(p) {
    setSelected(prev => {
      const has = prev.some(x => x.type === p.type && x.value === p.value)
      return has ? prev.filter(x => !(x.type === p.type && x.value === p.value)) : [...prev, p]
    })
  }
  const isSelected = p => selected.some(x => x.type === p.type && x.value === p.value)

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  function toggleRow(id) {
    setExpandedId(prev => prev === id ? null : id)
  }

  const totalEnrolled = visibleClasses.reduce((s, c) => s + c.enrollmentCount, 0)
  const totalFree     = visibleClasses.reduce((s, c) => s + c.tuitFreeCount, 0)
  const COL_COUNT     = 9

  if (periodsLoading) return <div className="page"><p className="coming-soon">Loading…</p></div>
  if (error && !loading) return <div className="page"><div className="error-banner">{error}</div></div>

  const hasData = fyPeriods.length > 0 || quarterGroups.length > 0

  return (
    <div className="page classes-page">
      <div className="enroll-header">
        <h1>Class Info</h1>
        {visibleClasses.length > 0 && (
          <button className="btn-secondary" onClick={() => exportTableCSV(visibleClasses)}>
            Export CSV
          </button>
        )}
      </div>

      {!hasData ? (
        <p className="coming-soon">No class data yet. Upload reports to get started.</p>
      ) : (
        <>
          <PeriodSelector
            fyPeriods={fyPeriods}
            quarterGroups={quarterGroups}
            isSelected={isSelected}
            toggle={togglePeriod}
            onClear={() => setSelected([])}
            hasSelection={selected.length > 0}
          />

          <div className="cls-tuit-filter">
            <button
              className={`period-pill${tuitFilter.free ? ' active' : ''}`}
              onClick={() => setTuitFilter(f => ({ ...f, free: !f.free }))}
            >
              Tuition Free
            </button>
            <button
              className={`period-pill${tuitFilter.fee ? ' active' : ''}`}
              onClick={() => setTuitFilter(f => ({ ...f, fee: !f.fee }))}
            >
              Fee Based
            </button>
          </div>

          {error && <div className="error-banner">{error}</div>}

          {loading ? (
            <p className="coming-soon">Loading classes…</p>
          ) : selected.length === 0 ? (
            <p className="coming-soon">Select one or more periods above to view classes.</p>
          ) : visibleClasses.length === 0 ? (
            <p className="coming-soon">No classes match the current filters.</p>
          ) : (
            <div className="report-scroll">
              <table className="cls-table">
                <thead>
                  <tr>
                    <SortTh col="courseName" label="Course"       sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                    <SortTh col="department" label="Department"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                    <SortTh col="instructor" label="Instructor"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                    <SortTh col="location"   label="Location"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                    <SortTh col="quarter"    label="Quarter"      sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                    <SortTh col="enrolled"   label="Enrolled"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                    <SortTh col="tuitFree"   label="Tuition Free" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                    <SortTh col="startDate"  label="Dates"        sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                    <SortTh col="sessions"   label="Sessions"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {visibleClasses.map(cls => (
                    <Fragment key={cls.eventId}>
                      <tr
                        className={`cls-row${expandedId === cls.eventId ? ' expanded' : ''}`}
                        onClick={() => toggleRow(cls.eventId)}
                      >
                        <td className="cls-course">{cls.courseName ?? '—'}</td>
                        <td>{cls.department ?? '—'}</td>
                        <td>{cls.instructor ?? '—'}</td>
                        <td>{cls.location ?? '—'}</td>
                        <td className="cls-quarter">{cls.eventTimePeriod ?? '—'}</td>
                        <td className="cls-num">{cls.enrollmentCount}</td>
                        <td className="cls-num">
                          <span className={cls.isTuitionFree ? 'cls-badge-free' : ''}>
                            {cls.tuitFreeCount} / {cls.enrollmentCount}
                          </span>
                        </td>
                        <td className="cls-dates">{fmtDateRange(cls.classStartDate, cls.classEndDate)}</td>
                        <td className="cls-num">{cls.allMeetings ?? '—'}</td>
                      </tr>
                      {expandedId === cls.eventId && (
                        <DrilldownRow cls={cls} colCount={COL_COUNT} />
                      )}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="cls-total-row">
                    <td colSpan={5}>
                      {visibleClasses.length} section{visibleClasses.length !== 1 ? 's' : ''}
                    </td>
                    <td className="cls-num">{totalEnrolled}</td>
                    <td className="cls-num">{totalFree} / {totalEnrolled}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
