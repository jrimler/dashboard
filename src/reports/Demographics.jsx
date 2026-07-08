import { useState, useEffect, useMemo, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import { fySortKey } from '../utils/periodUtils'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const AGE_BRACKETS = ['0 – 2', '3 – 35', '36 – 54', '55 – 74', '75+', 'No Response']

// Birthdates before this year are treated as data-entry placeholders → No Response.
const MIN_BIRTH_YEAR = 1905

// Household income: explicit lookup from the raw ASAP text label (matched
// case-insensitively, trimmed) to a reporting category. Any label not in this
// map falls to "No Response" — this map must be updated when ASAP introduces
// new income labels.
const INCOME_MAP = {
  'above $145,201':        'HIGH',
  'above $154,700':        'HIGH',
  '$116,040 - $154,700':   'HIGH',
  'below $60,600':         'LOW',
  'below $58,000':         'LOW',
  'below $60,000':         'LOW',
  '$96,700 - $116,040':    'LOW',
  '$97,000 - $145,200':    'LOW',
  '$58,000 - $96,700':     'LOW',
  '$60,600 - $97,000':     'LOW',
  '$60,001 - $69,000':     'LOW',
  '$69,001 - $78,000':     'LOW',
  '$78,001 - $86,000':     'LOW',
  '$86,001 - $93,000':     'LOW',
  'above $93,001':         'LOW',
  'decline to state':      'DECLINE TO STATE',
}

const INCOME_ORDER = ['HIGH', 'LOW', 'DECLINE TO STATE', 'No Response']

const NO_RESPONSE = 'No Response'

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
// Demographic bucketing
// ─────────────────────────────────────────────────────────────────────────────

function ageBracketFor(birthdate, referenceDate) {
  if (!birthdate) return NO_RESPONSE
  const birthYear = Number(birthdate.slice(0, 4))
  if (!birthYear || birthYear < MIN_BIRTH_YEAR) return NO_RESPONSE
  const age = ageAtDate(birthdate, referenceDate)
  if (age === null || age < 0) return NO_RESPONSE
  if (age <= 2)  return '0 – 2'
  if (age <= 35) return '3 – 35'
  if (age <= 54) return '36 – 54'
  if (age <= 74) return '55 – 74'
  return '75+'
}

function incomeCategoryFor(raw) {
  const key = String(raw ?? '').trim().toLowerCase()
  if (key === '' || key === '0') return NO_RESPONSE
  return INCOME_MAP[key] ?? NO_RESPONSE
}

function rawLabelFor(raw) {
  const v = String(raw ?? '').trim()
  return v === '' ? NO_RESPONSE : v
}

// ─────────────────────────────────────────────────────────────────────────────
// Data processing: dedupe students into units (Total Students + one per course)
// ─────────────────────────────────────────────────────────────────────────────

// Adds/merges one enrollment's student into a Map keyed by customer_id,
// keeping the earliest class_start_date seen and backfilling any student
// fields missing on earlier rows.
function upsertStudent(map, cid, student, startDate) {
  const cur = map.get(cid)
  if (!cur) {
    map.set(cid, {
      birthdate: student.birthdate        ?? null,
      gender:    student.gender           ?? null,
      ethnicity: student.ethnicity        ?? null,
      income:    student.household_income ?? null,
      earliestStart: startDate ?? null,
    })
    return
  }
  if (startDate && (!cur.earliestStart || startDate < cur.earliestStart)) {
    cur.earliestStart = startDate
  }
  if (cur.birthdate == null && student.birthdate        != null) cur.birthdate = student.birthdate
  if (cur.gender    == null && student.gender           != null) cur.gender    = student.gender
  if (cur.ethnicity == null && student.ethnicity        != null) cur.ethnicity = student.ethnicity
  if (cur.income    == null && student.household_income != null) cur.income    = student.household_income
}

function buildUnits(enrollments) {
  const totalStudents = new Map()   // customer_id → student
  const classStudents = new Map()   // course_name → (customer_id → student)

  for (const e of enrollments) {
    const cid = e.customer_id
    if (!cid) continue
    const ev      = e.events   ?? null
    const student = e.students ?? {}
    const start   = ev?.class_start_date ?? null

    // Total Students: every unique student with any enrollment in the FY,
    // across LESSON and CLASS alike, counted once.
    upsertStudent(totalStudents, cid, student, start)

    // Per-class units: one per course_name, CLASS enrollments only.
    if (ev?.activity_type === 'CLASS' && ev.course_name) {
      let m = classStudents.get(ev.course_name)
      if (!m) { m = new Map(); classStudents.set(ev.course_name, m) }
      upsertStudent(m, cid, student, start)
    }
  }

  return {
    totalBreakdown: buildBreakdown(totalStudents),
    classRows: [...classStudents.entries()].map(([courseName, m]) => ({
      courseName,
      breakdown: buildBreakdown(m),
    })),
  }
}

// Turns a deduped student Map into the four dimension breakdowns.
// Every percentage is relative to this unit's own total.
function buildBreakdown(studentsMap) {
  const total = studentsMap.size
  const age = {}, gender = {}, ethnicity = {}, income = {}
  for (const s of studentsMap.values()) {
    bump(age,       ageBracketFor(s.birthdate, s.earliestStart))
    bump(gender,    rawLabelFor(s.gender))
    bump(ethnicity, rawLabelFor(s.ethnicity))
    bump(income,    incomeCategoryFor(s.income))
  }
  return {
    total,
    age:       fixedBuckets(AGE_BRACKETS, age, total),
    income:    fixedBuckets(INCOME_ORDER, income, total),
    gender:    countOrderedBuckets(gender, total),
    ethnicity: countOrderedBuckets(ethnicity, total),
  }
}

function bump(counts, label) { counts[label] = (counts[label] ?? 0) + 1 }

function pctOf(count, total) { return total === 0 ? 0 : (count / total) * 100 }

// Fixed logical bucket order (age, income); zero-count buckets stay visible.
function fixedBuckets(order, counts, total) {
  return order.map(label => ({
    label,
    count: counts[label] ?? 0,
    pct:   pctOf(counts[label] ?? 0, total),
  }))
}

// Descending count with No Response last (gender, ethnicity); only present values.
function countOrderedBuckets(counts, total) {
  return Object.entries(counts)
    .sort(([la, ca], [lb, cb]) => {
      if (la === NO_RESPONSE) return 1
      if (lb === NO_RESPONSE) return -1
      return cb - ca || la.localeCompare(lb)
    })
    .map(([label, count]) => ({ label, count, pct: pctOf(count, total) }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Sorting
// ─────────────────────────────────────────────────────────────────────────────

function sortRows(rows, col, dir) {
  return [...rows].sort((a, b) => {
    let va, vb
    if (col === 'students') { va = a.breakdown.total; vb = b.breakdown.total }
    else                    { va = a.courseName ?? ''; vb = b.courseName ?? '' }
    if (va < vb) return dir === 'asc' ? -1 : 1
    if (va > vb) return dir === 'asc' ?  1 : -1
    return 0
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export — one flat file: Total Students first, then each class
// ─────────────────────────────────────────────────────────────────────────────

function bucketMap(buckets) {
  const m = {}
  for (const b of buckets) m[b.label] = b
  return m
}

// Column order for the dynamic dimensions: the Total Students unit's own
// ordering (descending count, No Response last), plus any stragglers.
function dynamicColumns(units, dim) {
  const seen = new Set()
  const cols = []
  for (const u of units) {
    for (const b of u.breakdown[dim]) {
      if (!seen.has(b.label)) { seen.add(b.label); cols.push(b.label) }
    }
  }
  return cols
}

function exportCSV(totalBreakdown, classRows, fy) {
  const units = [
    { label: 'Total Students', breakdown: totalBreakdown },
    ...classRows.map(r => ({ label: r.courseName, breakdown: r.breakdown })),
  ]

  const genderCols    = dynamicColumns(units, 'gender')
  const ethnicityCols = dynamicColumns(units, 'ethnicity')

  const headers = ['Unit', 'Unique Students']
  for (const b of AGE_BRACKETS)  headers.push(`Age ${b} Count`,       `Age ${b} %`)
  for (const c of INCOME_ORDER)  headers.push(`Income ${c} Count`,    `Income ${c} %`)
  for (const g of genderCols)    headers.push(`Gender ${g} Count`,    `Gender ${g} %`)
  for (const e of ethnicityCols) headers.push(`Ethnicity ${e} Count`, `Ethnicity ${e} %`)

  const rows = units.map(u => {
    const row = [u.label, u.breakdown.total]
    const dims = [
      [AGE_BRACKETS,  bucketMap(u.breakdown.age)],
      [INCOME_ORDER,  bucketMap(u.breakdown.income)],
      [genderCols,    bucketMap(u.breakdown.gender)],
      [ethnicityCols, bucketMap(u.breakdown.ethnicity)],
    ]
    for (const [cols, map] of dims) {
      for (const label of cols) {
        const b = map[label]
        row.push(b?.count ?? 0, (b?.pct ?? 0).toFixed(1))
      }
    }
    return row
  })

  triggerDownload(
    [headers, ...rows].map(r => r.map(esc).join(',')).join('\n'),
    `demographics-${fy.replace(/\s+/g, '-')}-${today()}.csv`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Period selector — FY pills only, single-select
// ─────────────────────────────────────────────────────────────────────────────

function PeriodSelector({ fiscalYears, selectedFY, onSelect, onClear }) {
  return (
    <div className="period-selector">
      <div className="period-selector-header">
        <span className="period-selector-title">Select Fiscal Year</span>
        {selectedFY && (
          <button className="period-clear-btn" onClick={onClear}>Clear</button>
        )}
      </div>
      <div className="period-pills">
        {fiscalYears.map(fy => (
          <button
            key={fy}
            className={`period-pill${selectedFY === fy ? ' active' : ''}`}
            onClick={() => onSelect(fy)}
          >
            {fy}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Dimension breakdown display (shared by Total Students and class drilldowns)
// ─────────────────────────────────────────────────────────────────────────────

function DimensionCard({ title, buckets }) {
  return (
    <div className="demo-dim">
      <div className="demo-dim-title">{title}</div>
      <table className="demo-dim-table">
        <tbody>
          {buckets.map(b => (
            <tr key={b.label}>
              <td className="demo-dim-label">{b.label}</td>
              <td className="demo-dim-count">{b.count.toLocaleString()}</td>
              <td className="demo-dim-pct">{b.pct.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DimensionGrid({ breakdown }) {
  return (
    <div className="demo-dims">
      <DimensionCard title="Age"              buckets={breakdown.age} />
      <DimensionCard title="Gender"           buckets={breakdown.gender} />
      <DimensionCard title="Ethnicity"        buckets={breakdown.ethnicity} />
      <DimensionCard title="Household Income" buckets={breakdown.income} />
    </div>
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

export default function Demographics() {
  const [fyValues, setFyValues]             = useState([])
  const [enrollments, setEnrollments]       = useState([])
  const [periodsLoading, setPeriodsLoading] = useState(true)
  const [loading, setLoading]               = useState(false)
  const [error, setError]                   = useState(null)
  const [selectedFY, setSelectedFY]         = useState(null)
  const [sortCol, setSortCol]               = useState('courseName')
  const [sortDir, setSortDir]               = useState('asc')
  const [expandedKey, setExpandedKey]       = useState(null)

  // Phase 1: lightweight mount fetch of fiscal_year to populate FY pills only
  useEffect(() => { loadPeriods() }, [])

  async function loadPeriods() {
    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await supabase
        .from('enrollments')
        .select('fiscal_year')
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setPeriodsLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }
    const fySet = new Set()
    for (const e of all) {
      if (e.fiscal_year) fySet.add(e.fiscal_year)
    }
    setFyValues([...fySet].sort((a, b) => fySortKey(a) - fySortKey(b)))
    setPeriodsLoading(false)
  }

  // Phase 2: full fetch on FY selection
  useEffect(() => {
    setExpandedKey(null)
    if (!selectedFY) { setEnrollments([]); setError(null); return }
    loadData(selectedFY)
  }, [selectedFY])

  async function loadData(fy) {
    setLoading(true)
    setError(null)

    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await supabase
        .from('enrollments')
        .select(`
          customer_id,
          events(activity_type, course_name, class_start_date),
          students(customer_id, birthdate, gender, ethnicity, household_income)
        `)
        .eq('fiscal_year', fy)
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }

    setEnrollments(all)
    setLoading(false)
  }

  const { totalBreakdown, classRows } = useMemo(
    () => buildUnits(enrollments),
    [enrollments]
  )

  const sortedRows = useMemo(
    () => sortRows(classRows, sortCol, sortDir),
    [classRows, sortCol, sortDir]
  )

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const COL_COUNT = 2

  if (periodsLoading) return <p className="coming-soon">Loading…</p>

  return (
    <div className="pig-report">
      {error && <div className="error-banner">{error}</div>}

      {/* On-page description */}
      <div className="pig-methodology">
        <div className="pig-methodology-title">About this report</div>
        <p>
          The Demographics report summarizes the age, gender, ethnicity, and household income
          of <strong>unique students</strong> for a selected fiscal year. It shows
          a <strong>Total Students</strong> breakdown (every unique student active in the fiscal
          year across all private lessons and group classes, counted once) followed by a per-class
          breakdown for each unique group class (one row per course name). Every figure is shown
          both as a raw unique-student count and as a percentage of that group's own total.
          No student names or other identifying details are shown.
        </p>
      </div>

      {fyValues.length === 0 ? (
        <p className="coming-soon">No enrollment data yet. Upload reports to get started.</p>
      ) : (
        <>
          <PeriodSelector
            fiscalYears={fyValues}
            selectedFY={selectedFY}
            onSelect={fy => setSelectedFY(prev => prev === fy ? null : fy)}
            onClear={() => setSelectedFY(null)}
          />

          {loading ? (
            <p className="coming-soon">Loading…</p>
          ) : !selectedFY ? (
            <p className="coming-soon">Select a fiscal year above to view the report.</p>
          ) : totalBreakdown.total === 0 ? (
            <p className="coming-soon">No enrollments found for {selectedFY}.</p>
          ) : (
            <>
              {/* Total Students headline */}
              <div className="pig-summary">
                <div className="pig-stat-card pig-stat-card--accent">
                  <div className="pig-stat-value">{totalBreakdown.total.toLocaleString()}</div>
                  <div className="pig-stat-label">
                    Total unique students in {selectedFY} (lessons + classes, counted once)
                  </div>
                </div>
              </div>

              <div className="demo-total-block">
                <div className="pig-roster-header">
                  <span className="pig-roster-title">Total Students Breakdown</span>
                  <button
                    className="btn-secondary"
                    onClick={() => exportCSV(totalBreakdown, sortedRows, selectedFY)}
                  >
                    Export CSV
                  </button>
                </div>
                <DimensionGrid breakdown={totalBreakdown} />
              </div>

              {/* Per-class table */}
              <div className="pig-roster-header">
                <span className="pig-roster-title">
                  {classRows.length} unique group class{classRows.length !== 1 ? 'es' : ''}
                </span>
              </div>

              {classRows.length === 0 ? (
                <p className="coming-soon">No group classes found for {selectedFY}.</p>
              ) : (
                <div className="report-scroll">
                  <table className="cls-table">
                    <thead>
                      <tr>
                        <SortTh col="courseName" label="Course Name"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                        <SortTh col="students"   label="Unique Students" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map(r => (
                        <Fragment key={r.courseName}>
                          <tr
                            className={`cls-row${expandedKey === r.courseName ? ' expanded' : ''}`}
                            onClick={() => setExpandedKey(prev => prev === r.courseName ? null : r.courseName)}
                          >
                            <td className="cls-course">{r.courseName}</td>
                            <td className="cls-num">{r.breakdown.total.toLocaleString()}</td>
                          </tr>
                          {expandedKey === r.courseName && (
                            <tr className="cls-drilldown-row">
                              <td colSpan={COL_COUNT}>
                                <div className="demo-drilldown">
                                  <DimensionGrid breakdown={r.breakdown} />
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
