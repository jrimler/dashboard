import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  parseQuarter, quarterFYLabel,
  quarterSortKey, fySortKey,
  periodLabel,
} from '../utils/periodUtils'

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

// ─────────────────────────────────────────────────────────────────────────────
// Period selector (same pattern as Enrollment / Classes)
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
// Data processing: one row per event_id
// ─────────────────────────────────────────────────────────────────────────────

function buildInstances(eventsData, enrollmentsData) {
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

  return eventsData.map(ev => {
    const enrollments = enrollmentsByEvent[ev.event_id] ?? []

    // Category: hardcoded override map first, then ASAP department (both trimmed)
    const rawCategory = CATEGORY_MAP[ev.course_name] ?? (ev.department ?? '')
    const category = rawCategory.trim() || '—'

    // Tuition-free: YMP prefix override OR every enrollment is free
    const isYMP = (ev.course_name ?? '').startsWith(YMP_PREFIX)
    const allFree = enrollments.length > 0 && enrollments.every(e => e.is_tuition_free)
    const isTuitionFree = isYMP || allFree

    // Youth vs. Adult: age of each unique enrolled student at this event's start date.
    // Students with no birthdate are excluded. Defaults to Adult if none are known.
    const seenCids = new Set()
    let hasAnyBirthdate = false
    let anyAdult = false
    for (const e of enrollments) {
      if (seenCids.has(e.customer_id)) continue
      seenCids.add(e.customer_id)
      const bd = studentBirthdates[e.customer_id]
      if (!bd) continue
      hasAnyBirthdate = true
      const age = ageAtDate(bd, ev.class_start_date)
      if (age !== null && age >= 19) { anyAdult = true; break }
    }
    const ageGroup = (hasAnyBirthdate && !anyAdult) ? 'Youth' : 'Adult'

    const totalEnrolled = enrollments.length
    const totalFree     = enrollments.filter(e => e.is_tuition_free).length

    return {
      key:          ev.event_id,
      courseName:   ev.course_name,
      category,
      instructor:   ev.primary_instructor,
      quarter:      ev.time_period,
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

function sortInstances(instances, col, dir) {
  return [...instances].sort((a, b) => {
    let va, vb
    switch (col) {
      case 'courseName':    va = a.courseName ?? '';        vb = b.courseName ?? '';        break
      case 'category':      va = a.category ?? '';          vb = b.category ?? '';          break
      case 'instructor':    va = a.instructor ?? '';        vb = b.instructor ?? '';        break
      case 'ageGroup':      va = a.ageGroup ?? '';          vb = b.ageGroup ?? '';          break
      case 'tuitStatus':    va = a.isTuitionFree ? 0 : 1;  vb = b.isTuitionFree ? 0 : 1;  break
      case 'quarter':       va = a.quarter ?? '';           vb = b.quarter ?? '';           break
      case 'totalEnrolled': va = a.totalEnrolled;           vb = b.totalEnrolled;           break
      case 'totalFree':     va = a.totalFree;               vb = b.totalFree;               break
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

function exportCSV(instances) {
  const headers = [
    'Course Name', 'Category', 'Instructor', 'Quarter', 'Age Group', 'Tuition Status',
    'Total Enrolled', 'Total Tuition Free',
  ]
  const rows = instances.map(i => [
    i.courseName, i.category, i.instructor, i.quarter ?? '',
    i.ageGroup, i.isTuitionFree ? 'Tuition Free' : 'Fee Based',
    i.totalEnrolled, i.totalFree,
  ])
  triggerDownload(
    [headers, ...rows].map(r => r.map(esc).join(',')).join('\n'),
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
  const [instances, setInstances]             = useState([])
  const [periodsLoading, setPeriodsLoading]   = useState(true)
  const [loading, setLoading]                 = useState(false)
  const [error, setError]                     = useState(null)
  const [selected, setSelected]               = useState([])
  const [tuitFilter, setTuitFilter]           = useState({ free: true, fee: true })
  const [sortCol, setSortCol]                 = useState('courseName')
  const [sortDir, setSortDir]                 = useState('asc')
  const [infoOpen, setInfoOpen]               = useState(false)

  // Phase 1: lightweight mount fetch to populate period pills only
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

  // Phase 2: full fetch on period selection
  useEffect(() => {
    if (selected.length === 0) { setInstances([]); setError(null); return }
    loadData(selected)
  }, [selected])

  async function loadData(selectedPeriods) {
    setLoading(true)
    setError(null)

    const quarters = selectedPeriods.filter(p => p.type === 'quarter').map(p => p.value)
    const fys      = selectedPeriods.filter(p => p.type === 'fiscal_year').map(p => p.value)

    // Fetch CLASS events for the selected periods
    let eventsQuery = supabase
      .from('events')
      .select('event_id, course_name, department, primary_instructor, class_start_date, time_period, fiscal_year')
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
      setInstances([])
      setLoading(false)
      return
    }

    // Fetch enrollments for those events, joining student birthdate for age classification
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

    setInstances(buildInstances(eventsData, allEnrollments))
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

  const visibleInstances = useMemo(() => {
    let inst = instances
    if (!tuitFilter.free) inst = inst.filter(i => !i.isTuitionFree)
    if (!tuitFilter.fee)  inst = inst.filter(i =>  i.isTuitionFree)
    return sortInstances(inst, sortCol, sortDir)
  }, [instances, tuitFilter, sortCol, sortDir])

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

  const totalEnrolled = visibleInstances.reduce((s, i) => s + i.totalEnrolled, 0)
  const totalFree     = visibleInstances.reduce((s, i) => s + i.totalFree, 0)

  if (periodsLoading) return <p className="coming-soon">Loading…</p>

  const hasData = fyPeriods.length > 0 || quarterGroups.length > 0

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
              Each row is one unique class offering, identified by its <strong>event_id</strong> from ASAP.
              Quarter and Instructor are included so that duplicate-looking rows (same course name and
              instructor across multiple quarters) can be identified and manually accounted for when needed.
            </p>

            <div className="ugcb-info-section-title">Youth vs. Adult</div>
            <p>
              Each enrolled student's age is calculated as of this event's <strong>class start date</strong>.
              Students with no birthdate on record are excluded from the age check.
              If every student with a known birthdate is under 19, the class is classified
              as <strong>Youth</strong>; otherwise <strong>Adult</strong>.
              If no enrolled students have a birthdate on record, the class defaults to Adult
              (conservative fallback).
            </p>

            <div className="ugcb-info-section-title">Tuition-Free Status</div>
            <p>
              A class instance is tuition-free if every enrollment across all of its sections
              has a net cost of $15 or less (the dashboard-wide threshold). Additionally, any
              course whose name begins with <em>"Young Musicians Program"</em> is unconditionally
              marked tuition-free, regardless of enrollment amounts.
            </p>

            <div className="ugcb-info-section-title">Category</div>
            <p>
              The Category column may differ from ASAP's Department field. A hardcoded override
              map assigns display categories to specific course names. If no override exists,
              the ASAP department value is used. The map is defined at the top
              of <code>src/reports/UniqueGroupClassesBoard.jsx</code> and is easy to update.
            </p>
          </div>
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

          {loading ? (
            <p className="coming-soon">Loading…</p>
          ) : selected.length === 0 ? (
            <p className="coming-soon">Select one or more periods above to view the report.</p>
          ) : visibleInstances.length === 0 ? (
            <p className="coming-soon">No classes match the current filters.</p>
          ) : (
            <>
              <div className="pig-roster-header">
                <span className="pig-roster-title">
                  {visibleInstances.length} unique class instance{visibleInstances.length !== 1 ? 's' : ''}
                </span>
                <button className="btn-secondary" onClick={() => exportCSV(visibleInstances)}>
                  Export CSV
                </button>
              </div>

              <div className="report-scroll">
                <table className="cls-table ugcb-table">
                  <thead>
                    <tr>
                      <SortTh col="courseName"    label="Course Name"        sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="category"      label="Category"           sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="instructor"    label="Instructor"         sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="quarter"       label="Quarter"            sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="ageGroup"      label="Age Group"          sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="tuitStatus"    label="Tuition Status"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh col="totalEnrolled" label="Total Enrolled"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortTh col="totalFree"     label="Total Tuition Free" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleInstances.map(inst => (
                      <tr key={inst.key}>
                        <td className="cls-course">{inst.courseName ?? '—'}</td>
                        <td>{inst.category}</td>
                        <td>{inst.instructor ?? '—'}</td>
                        <td className="cls-quarter">{inst.quarter ?? '—'}</td>
                        <td>
                          <span className={`ugcb-badge ugcb-badge--${inst.ageGroup.toLowerCase()}`}>
                            {inst.ageGroup}
                          </span>
                        </td>
                        <td>
                          <span className={inst.isTuitionFree ? 'cls-badge-free' : ''}>
                            {inst.isTuitionFree ? 'Tuition Free' : 'Fee Based'}
                          </span>
                        </td>
                        <td className="cls-num">{inst.totalEnrolled}</td>
                        <td className="cls-num">{inst.totalFree}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="cls-total-row">
                      <td colSpan={6}>
                        {visibleInstances.length} instance{visibleInstances.length !== 1 ? 's' : ''}
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
