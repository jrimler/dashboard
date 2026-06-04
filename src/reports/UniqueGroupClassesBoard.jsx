import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { quarterSortKey, fySortKey } from '../utils/periodUtils'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Display category overrides keyed on exact course name.
// If a course name is not listed here, the ASAP department value is used.
// Whitespace is trimmed from all values. Update this map as courses change.
const CATEGORY_MAP = {
  'Brazilian Candomblé Drumming':                        'Latin',
  'CMC Chamber Music Camp':                              'Camp',
  'CMC Sparks Camp':                                     'Camp',
  'CMC Summer Jazz Workshop':                            'Camp',
  'Camp CMC':                                            'Camp',
  'Chamber Music Ensemble':                              'Chamber Music',
  'Composition Workshop':                                'Music Theory',
  'Girls Rock & Pop Band':                               'Rock & Pop',
  'Intro to Chamber Music':                              'Chamber Music',
  'Introduction to Guitar I (Ages 6-8)':                 'Guitar',
  'Introduction to Guitar I (Ages 8\u201312)':           'Guitar',
  'Introduction to Guitar II (Ages 8\u201312)':          'Guitar',
  'Introduction to Jazz Theory and Composition':         'Music Theory',
  'Jazz Manouche Ensemble':                              'Latin',
  'Mariachi Camp':                                       'Camp',
  'Music for Children':                                  'Early Childhood',
  'Music Theory Mixtape':                                'Music Theory',
  'Old Time & Bluegrass Jam':                            'Bluegrass',
  'Rhythm and Roots Camp':                               'Camp',
  'Rock & Pop Band':                                     'Rock & Pop',
  'Son Jarocho Music':                                   'Latin',
  'Sparks Guitar Orchestra':                             'Guitar',
  'Strings Ensemble II: Sinfonia':                       'Strings',
  'String Orchestra Workshop II':                        'Strings',
  'Theory of Rock/Pop: Beatles & Beach Boys':            'Music Theory',
  'Ukulele for Beginners for Adults':                    'Guitar: Ukulele',
  'Young Musicians Program / Saturday Play! (Ensemble)': 'Young Musicians Program',
  'Young Musicians Program / Saturday Play! (Theory)':   'Young Musicians Program',
}

// Any course whose name starts with this prefix is unconditionally tuition-free.
const YMP_PREFIX = 'Young Musicians Program'

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function esc(v) { return `"${String(v ?? '').replace(/"/g, '""')}"` }

function triggerDownload(csv, filename) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  URL.revokeObjectURL(url)
}

function today() { return new Date().toISOString().slice(0, 10) }

// Age in full years of a person born on birthdateStr as of referenceDateStr.
// Both strings in "YYYY-MM-DD". Returns null if either is missing.
function ageAtDate(birthdateStr, referenceDateStr) {
  if (!birthdateStr || !referenceDateStr) return null
  const [by, bm, bd] = birthdateStr.split('-').map(Number)
  const [ry, rm, rd] = referenceDateStr.split('-').map(Number)
  let age = ry - by
  if (rm < bm || (rm === bm && rd < bd)) age--
  return age
}

function formatTime(startTime, endTime) {
  if (startTime === '—' && endTime === '—') return '—'
  return `${startTime} – ${endTime}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Period selector — FY pills only
// ─────────────────────────────────────────────────────────────────────────────

function PeriodSelector({ fyPeriods, isSelected, toggle, onClear, hasSelection }) {
  return (
    <div className="period-selector">
      <div className="period-selector-header">
        <span className="period-selector-title">Select Fiscal Year</span>
        {hasSelection && (
          <button className="period-clear-btn" onClick={onClear}>Clear</button>
        )}
      </div>
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
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Data processing: group by (course_name, instructor, days_of_week, start_time, end_time)
// ─────────────────────────────────────────────────────────────────────────────

function buildGroups(eventsData, scheduleByEventId, enrollmentsData) {
  // Build customer_id → birthdate from the students join on enrollments
  const studentBirthdates = {}
  for (const e of enrollmentsData) {
    if (e.customer_id && e.students?.birthdate) {
      studentBirthdates[e.customer_id] = e.students.birthdate
    }
  }

  // Group enrollments by event_id
  const enrollmentsByEvent = {}
  for (const e of enrollmentsData) {
    if (!enrollmentsByEvent[e.event_id]) enrollmentsByEvent[e.event_id] = []
    enrollmentsByEvent[e.event_id].push(e)
  }

  // Build group map keyed on (course_name, instructor, days_of_week, start_time, end_time)
  const groups = {}
  for (const ev of eventsData) {
    const sched      = scheduleByEventId[ev.event_id] ?? {}
    const daysOfWeek = sched.days_of_week ?? '—'
    const startTime  = sched.start_time  ?? '—'
    const endTime    = sched.end_time    ?? '—'

    const courseName = ev.course_name ?? '—'
    const instructor = ev.primary_instructor  // keep null for display

    const key = [courseName, instructor ?? '—', daysOfWeek, startTime, endTime].join('||')

    if (!groups[key]) {
      groups[key] = {
        key,
        courseName,
        instructor,
        daysOfWeek,
        startTime,
        endTime,
        department:          ev.department,
        timePeriods:         new Set(),
        enrichedEnrollments: [],
      }
    }

    const g = groups[key]
    if (ev.time_period) g.timePeriods.add(ev.time_period)
    for (const enr of (enrollmentsByEvent[ev.event_id] ?? [])) {
      g.enrichedEnrollments.push({ ...enr, _class_start_date: ev.class_start_date })
    }
  }

  return Object.values(groups).map(g => {
    // Category: hardcoded override map first, then ASAP department (both trimmed)
    const category = (CATEGORY_MAP[g.courseName] ?? (g.department ?? '')).trim() || '—'

    // Tuition-free: YMP prefix override OR every enrollment is free
    const isYMP    = g.courseName.startsWith(YMP_PREFIX)
    const allFree  = g.enrichedEnrollments.length > 0 && g.enrichedEnrollments.every(e => e.is_tuition_free)
    const isTuitionFree = isYMP || allFree

    // Youth vs. Adult: check each enrollment's student at that event's class_start_date.
    // Students with no birthdate excluded. Default Adult if none are known.
    let hasAnyBirthdate = false
    let anyAdult        = false
    for (const enr of g.enrichedEnrollments) {
      if (anyAdult) break
      const bd = studentBirthdates[enr.customer_id]
      if (!bd) continue
      hasAnyBirthdate = true
      const age = ageAtDate(bd, enr._class_start_date)
      if (age !== null && age >= 19) anyAdult = true
    }
    const ageGroup = (hasAnyBirthdate && !anyAdult) ? 'Youth' : 'Adult'

    // Quarters offered: sorted distinct time_period values
    const quartersOffered = [...g.timePeriods]
      .sort((a, b) => quarterSortKey(a) - quarterSortKey(b))
      .join(', ')

    const totalEnrolled = g.enrichedEnrollments.length
    const totalFree     = g.enrichedEnrollments.filter(e => e.is_tuition_free).length

    return {
      key: g.key,
      courseName: g.courseName,
      category,
      instructor: g.instructor,
      daysOfWeek: g.daysOfWeek,
      startTime:  g.startTime,
      endTime:    g.endTime,
      quartersOffered,
      ageGroup,
      isTuitionFree,
      totalEnrolled,
      totalFree,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Sorting
// ─────────────────────────────────────────────────────────────────────────────

function sortRows(rows, col, dir) {
  return [...rows].sort((a, b) => {
    let va, vb
    switch (col) {
      case 'courseName':      va = a.courseName ?? '';       vb = b.courseName ?? '';       break
      case 'category':        va = a.category ?? '';         vb = b.category ?? '';         break
      case 'instructor':      va = a.instructor ?? '';       vb = b.instructor ?? '';       break
      case 'daysOfWeek':      va = a.daysOfWeek ?? '';       vb = b.daysOfWeek ?? '';       break
      case 'time':            va = a.startTime ?? '';        vb = b.startTime ?? '';        break
      case 'quartersOffered': va = a.quartersOffered ?? '';  vb = b.quartersOffered ?? '';  break
      case 'ageGroup':        va = a.ageGroup ?? '';         vb = b.ageGroup ?? '';         break
      case 'tuitStatus':      va = a.isTuitionFree ? 0 : 1; vb = b.isTuitionFree ? 0 : 1; break
      case 'totalEnrolled':   va = a.totalEnrolled;          vb = b.totalEnrolled;          break
      case 'totalFree':       va = a.totalFree;              vb = b.totalFree;              break
      default: return 0
    }
    if (va < vb) return dir === 'asc' ? -1 : 1
    if (va > vb) return dir === 'asc' ?  1 : -1
    return 0
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function exportCSV(rows) {
  const headers = [
    'Course Name', 'Category', 'Instructor', 'Days of Week', 'Time',
    'Quarters Offered', 'Age Group', 'Tuition Status', 'Total Enrolled', 'Total Tuition Free',
  ]
  const csvRows = rows.map(r => [
    r.courseName ?? '',
    r.category,
    r.instructor ?? '',
    r.daysOfWeek,
    formatTime(r.startTime, r.endTime),
    r.quartersOffered,
    r.ageGroup,
    r.isTuitionFree ? 'Tuition Free' : 'Fee Based',
    r.totalEnrolled,
    r.totalFree,
  ])
  triggerDownload(
    [headers, ...csvRows].map(r => r.map(esc).join(',')).join('\n'),
    `ugcb-report-${today()}.csv`
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
// Main report component
// ─────────────────────────────────────────────────────────────────────────────

export default function UniqueGroupClassesBoard() {
  const [availableEvents, setAvailableEvents] = useState([])
  const [rows, setRows]                       = useState([])
  const [periodsLoading, setPeriodsLoading]   = useState(true)
  const [loading, setLoading]                 = useState(false)
  const [error, setError]                     = useState(null)
  const [selected, setSelected]               = useState([])
  const [tuitFilter, setTuitFilter]           = useState({ free: true, fee: true })
  const [ageFilter, setAgeFilter]             = useState({ youth: true, adult: true })
  const [sortCol, setSortCol]                 = useState('courseName')
  const [sortDir, setSortDir]                 = useState('asc')
  const [infoOpen, setInfoOpen]               = useState(false)

  // Phase 1: lightweight mount fetch to populate FY pills only
  useEffect(() => { loadPeriods() }, [])

  async function loadPeriods() {
    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await supabase
        .from('events')
        .select('fiscal_year')
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

  // Phase 2: full fetch on FY selection
  useEffect(() => {
    if (selected.length === 0) { setRows([]); setError(null); return }
    loadData(selected)
  }, [selected])

  async function loadData(selectedPeriods) {
    setLoading(true)
    setError(null)

    const fys = selectedPeriods.map(p => p.value)

    // 1. Fetch CLASS events for the selected FYs
    const { data: eventsData, error: eventsError } = await supabase
      .from('events')
      .select('event_id, course_name, department, primary_instructor, class_start_date, time_period, fiscal_year')
      .eq('activity_type', 'CLASS')
      .in('fiscal_year', fys)

    if (eventsError) { setError(eventsError.message); setLoading(false); return }

    const eventIds = eventsData.map(e => e.event_id)
    if (eventIds.length === 0) { setRows([]); setLoading(false); return }

    // 2. Fetch class_schedule for those event_ids (batched to avoid URL length limits)
    const SCHED_BATCH = 500
    let scheduleData = []
    for (let i = 0; i < eventIds.length; i += SCHED_BATCH) {
      const { data, error } = await supabase
        .from('class_schedule')
        .select('event_id, days_of_week, start_time, end_time')
        .in('event_id', eventIds.slice(i, i + SCHED_BATCH))
      if (error) { setError(error.message); setLoading(false); return }
      scheduleData = scheduleData.concat(data)
    }

    const scheduleByEventId = {}
    for (const s of scheduleData) scheduleByEventId[s.event_id] = s

    // 3. Fetch enrollments (paginated), joining student birthdate for age classification
    const PAGE = 1000
    let from = 0, allEnrollments = []
    while (true) {
      const { data, error } = await supabase
        .from('enrollments')
        .select('event_enrollment_id, event_id, customer_id, is_tuition_free, students(birthdate)')
        .in('event_id', eventIds)
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setLoading(false); return }
      allEnrollments = allEnrollments.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }

    setRows(buildGroups(eventsData, scheduleByEventId, allEnrollments))
    setLoading(false)
  }

  // Derive FY pills from the lightweight availableEvents
  const fyPeriods = useMemo(() => {
    const fySet = new Set()
    for (const e of availableEvents) {
      if (e.fiscal_year) fySet.add(e.fiscal_year)
    }
    return [...fySet]
      .map(v => ({ type: 'fiscal_year', value: v }))
      .sort((a, b) => fySortKey(a.value) - fySortKey(b.value))
  }, [availableEvents])

  const visibleRows = useMemo(() => {
    let r = rows
    if (!tuitFilter.free)  r = r.filter(i => !i.isTuitionFree)
    if (!tuitFilter.fee)   r = r.filter(i =>  i.isTuitionFree)
    if (!ageFilter.youth)  r = r.filter(i => i.ageGroup !== 'Youth')
    if (!ageFilter.adult)  r = r.filter(i => i.ageGroup !== 'Adult')
    return sortRows(r, sortCol, sortDir)
  }, [rows, tuitFilter, ageFilter, sortCol, sortDir])

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

  const totalEnrolled = visibleRows.reduce((s, r) => s + r.totalEnrolled, 0)
  const totalFree     = visibleRows.reduce((s, r) => s + r.totalFree, 0)

  if (periodsLoading) return <p className="coming-soon">Loading…</p>

  return (
    <div className="pig-report">
      {error && <div className="error-banner">{error}</div>}

      {/* Collapsible explanatory block */}
      <div className="pig-courses ugcb-info-block">
        <button
          className="pig-courses-toggle"
          onClick={() => setInfoOpen(o => !o)}
        >
          <span>About this report</span>
          <span className="pig-courses-chevron">{infoOpen ? '▲' : '▼'}</span>
        </button>
        {infoOpen && (
          <div className="ugcb-info-body">
            <div className="ugcb-info-section-title">Rows</div>
            <p>
              Each row is one unique class, identified by the combination of <strong>course name</strong>,{' '}
              <strong>instructor</strong>, <strong>days of week</strong>, <strong>start time</strong>,
              and <strong>end time</strong>. The same course running at a different time or with a different
              instructor will appear as a separate row. Counts aggregate across all quarters in the
              selected fiscal year.
            </p>

            <div className="ugcb-info-section-title">Youth vs. Adult</div>
            <p>
              Each enrolled student's age is calculated as of their event's <strong>class start date</strong>.
              Students with no birthdate on record are excluded from the age check.
              If every student with a known birthdate is under 19 across all matching events, the class is
              classified as <strong>Youth</strong>; otherwise <strong>Adult</strong>.
              If no enrolled students have a birthdate on record, the class defaults to Adult
              (conservative fallback).
            </p>

            <div className="ugcb-info-section-title">Tuition-Free Status</div>
            <p>
              A class is tuition-free if every enrollment across all of its matching events has a net cost
              of $15 or less (the dashboard-wide threshold). Additionally, any course whose name begins
              with <em>"Young Musicians Program"</em> is unconditionally marked tuition-free, regardless
              of enrollment amounts.
            </p>

            <div className="ugcb-info-section-title">Category</div>
            <p>
              The Category column may differ from ASAP's Department field. A hardcoded override map assigns
              display categories to specific course names. If no override exists, the ASAP department value
              is used. The map is defined at the top of{' '}
              <code>src/reports/UniqueGroupClassesBoard.jsx</code> and is easy to update.
            </p>
          </div>
        )}
      </div>

      {fyPeriods.length === 0 ? (
        <p className="coming-soon">No class data yet. Upload reports to get started.</p>
      ) : (
        <>
          <PeriodSelector
            fyPeriods={fyPeriods}
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
            <span style={{ display: 'inline-block', width: 1, background: 'var(--color-border, #ddd)', margin: '0 8px', alignSelf: 'stretch' }} />
            <button
              className={`period-pill${ageFilter.youth ? ' active' : ''}`}
              onClick={() => setAgeFilter(f => ({ ...f, youth: !f.youth }))}
            >
              Youth
            </button>
            <button
              className={`period-pill${ageFilter.adult ? ' active' : ''}`}
              onClick={() => setAgeFilter(f => ({ ...f, adult: !f.adult }))}
            >
              Adult
            </button>
          </div>

          {loading ? (
            <p className="coming-soon">Loading…</p>
          ) : selected.length === 0 ? (
            <p className="coming-soon">Select a fiscal year above to view the report.</p>
          ) : visibleRows.length === 0 ? (
            <p className="coming-soon">No classes match the current filters.</p>
          ) : (
            <>
              <div className="pig-roster-header">
                <span className="pig-roster-title">
                  {visibleRows.length} unique class{visibleRows.length !== 1 ? 'es' : ''}
                </span>
                <button className="btn-secondary" onClick={() => exportCSV(visibleRows)}>
                  Export CSV
                </button>
              </div>

              <div className="report-scroll">
                <table className="cls-table ugcb-table">
                  <thead>
                    <tr>
                      <SortTh col="courseName"      label="Course Name"        sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="category"        label="Category"           sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="instructor"      label="Instructor"         sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="daysOfWeek"      label="Days of Week"       sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="time"            label="Time"               sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="quartersOffered" label="Quarters Offered"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="ageGroup"        label="Age Group"          sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="tuitStatus"      label="Tuition Status"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="totalEnrolled"   label="Total Enrolled"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortTh col="totalFree"       label="Total Tuition Free" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map(r => (
                      <tr key={r.key}>
                        <td className="cls-course">{r.courseName ?? '—'}</td>
                        <td>{r.category}</td>
                        <td>{r.instructor ?? '—'}</td>
                        <td>{r.daysOfWeek}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatTime(r.startTime, r.endTime)}</td>
                        <td>{r.quartersOffered || '—'}</td>
                        <td>
                          <span className={`ugcb-badge ugcb-badge--${r.ageGroup.toLowerCase()}`}>
                            {r.ageGroup}
                          </span>
                        </td>
                        <td>
                          <span className={r.isTuitionFree ? 'cls-badge-free' : ''}>
                            {r.isTuitionFree ? 'Tuition Free' : 'Fee Based'}
                          </span>
                        </td>
                        <td className="cls-num">{r.totalEnrolled}</td>
                        <td className="cls-num">{r.totalFree}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="cls-total-row">
                      <td colSpan={8}>
                        {visibleRows.length} unique class{visibleRows.length !== 1 ? 'es' : ''}
                      </td>
                      <td className="cls-num">{totalEnrolled}</td>
                      <td className="cls-num">{totalFree}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
