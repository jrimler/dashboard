import { useState, useEffect, useMemo, Fragment } from 'react'
import { supabase } from '../lib/supabase'
import {
  fySortKey, quarterSortKey, parseQuarter, quarterFYLabel, periodLabel,
} from '../utils/periodUtils'

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
  'above $145,201':        'High',
  'above $154,700':        'High',
  '$116,040 - $154,700':   'High',
  'below $60,600':         'Low',
  'below $58,000':         'Low',
  'below $60,000':         'Low',
  '$96,700 - $116,040':    'Low',
  '$97,000 - $145,200':    'Low',
  '$58,000 - $96,700':     'Low',
  '$60,600 - $97,000':     'Low',
  '$60,001 - $69,000':     'Low',
  '$69,001 - $78,000':     'Low',
  '$78,001 - $86,000':     'Low',
  '$86,001 - $93,000':     'Low',
  'above $93,001':         'Low',
  'decline to state':      'Decline to State',
}

const INCOME_ORDER = ['High', 'Low', 'Decline to State', 'No Response']

// Ethnicity labels that name the same group and should report as one category.
// Matched case-insensitively against the stored value (each student has one
// ethnicity, coalesced from the three source columns in priority order).
const ETHNICITY_ALIASES = {
  'hispanic': 'Hispanic/Latinx',
  'latinx':   'Hispanic/Latinx',
}

// Gender labels merged into shared categories, matched case-insensitively
// against the stored value.
const GENDER_ALIASES = {
  'trans male':   'Transgender',
  'trans female': 'Transgender',
  'transgender':  'Transgender',
  'nonbinary/gender nonconforming/genderqueer': 'Nonbinary/Gender Nonconforming/Genderqueer',
  'gender non-conforming':                      'Nonbinary/Gender Nonconforming/Genderqueer',
  'decline to state':                           'Decline to State',
}

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

// Ethnicity label with Hispanic/Latinx aliases merged to one category.
function ethnicityLabelFor(raw) {
  const v = String(raw ?? '').trim()
  if (v === '') return NO_RESPONSE
  return ETHNICITY_ALIASES[v.toLowerCase()] ?? v
}

// Gender label with Trans Male/Trans Female/Transgender merged to one category.
function genderLabelFor(raw) {
  const v = String(raw ?? '').trim()
  if (v === '') return NO_RESPONSE
  return GENDER_ALIASES[v.toLowerCase()] ?? v
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
  const totalStudents  = new Map()  // customer_id → student (LESSON + CLASS)
  const lessonStudents = new Map()  // customer_id → student (LESSON only)
  const groupStudents  = new Map()  // customer_id → student (CLASS only)
  const classStudents  = new Map()  // course_name → (customer_id → student)

  for (const e of enrollments) {
    const cid = e.customer_id
    if (!cid) continue
    const ev      = e.events   ?? null
    const student = e.students ?? {}
    const start   = ev?.class_start_date ?? null

    // Total Students: every unique student with any enrollment in the period,
    // across LESSON and CLASS alike, counted once.
    upsertStudent(totalStudents, cid, student, start)

    if (ev?.activity_type === 'LESSON') {
      // Lesson Students: flat aggregate, no per-course/teacher split.
      upsertStudent(lessonStudents, cid, student, start)
    } else if (ev?.activity_type === 'CLASS') {
      // Group Class Students: flat aggregate across all group classes.
      upsertStudent(groupStudents, cid, student, start)
      // Per-class units: one per course_name.
      if (ev.course_name) {
        let m = classStudents.get(ev.course_name)
        if (!m) { m = new Map(); classStudents.set(ev.course_name, m) }
        upsertStudent(m, cid, student, start)
      }
    }
  }

  return {
    totalBreakdown:  buildBreakdown(totalStudents),
    lessonBreakdown: buildBreakdown(lessonStudents),
    groupBreakdown:  buildBreakdown(groupStudents),
    classRows: [...classStudents.entries()].map(([courseName, m]) => ({
      courseName,
      breakdown: buildBreakdown(m),
    })),
  }
}

// Turns a deduped student Map into the four dimension breakdowns.
// Counts include "No Response", but percentages are relative to the count of
// students with a meaningful response for that dimension (No Response excluded
// from the base and shown with no percentage).
function buildBreakdown(studentsMap) {
  const total = studentsMap.size
  const age = {}, gender = {}, ethnicity = {}, income = {}
  for (const s of studentsMap.values()) {
    bump(age,       ageBracketFor(s.birthdate, s.earliestStart))
    bump(gender,    genderLabelFor(s.gender))
    bump(ethnicity, ethnicityLabelFor(s.ethnicity))
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

// Percentage base: students with a meaningful response (total minus No Response).
function respondedBase(counts, total) { return total - (counts[NO_RESPONSE] ?? 0) }

// Percentages are out of the responded base; No Response shows count but no pct.
function bucketPct(label, count, base) {
  return label === NO_RESPONSE ? null : pctOf(count, base)
}

// Fixed logical bucket order (age, income); zero-count buckets stay visible.
function fixedBuckets(order, counts, total) {
  const base = respondedBase(counts, total)
  return order.map(label => ({
    label,
    count: counts[label] ?? 0,
    pct:   bucketPct(label, counts[label] ?? 0, base),
  }))
}

// Descending count with No Response last (gender, ethnicity); only present values.
function countOrderedBuckets(counts, total) {
  const base = respondedBase(counts, total)
  return Object.entries(counts)
    .sort(([la, ca], [lb, cb]) => {
      if (la === NO_RESPONSE) return 1
      if (lb === NO_RESPONSE) return -1
      return cb - ca || la.localeCompare(lb)
    })
    .map(([label, count]) => ({ label, count, pct: bucketPct(label, count, base) }))
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

function exportCSV({ totalBreakdown, lessonBreakdown, groupBreakdown }, classRows, period) {
  const units = [
    { label: 'Total Students',       breakdown: totalBreakdown },
    { label: 'Lesson Students',      breakdown: lessonBreakdown },
    { label: 'Group Class Students', breakdown: groupBreakdown },
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
        row.push(b?.count ?? 0, b?.pct == null ? '' : b.pct.toFixed(1))
      }
    }
    return row
  })

  triggerDownload(
    [headers, ...rows].map(r => r.map(esc).join(',')).join('\n'),
    `demographics-${period.replace(/\s+/g, '-')}-${today()}.csv`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Period selector — Fiscal Year + Quarter pills, single-select
// ─────────────────────────────────────────────────────────────────────────────

function PeriodSelector({ fyPeriods, quarterGroups, selected, onToggle, onClear }) {
  const isSel = p => selected && selected.type === p.type && selected.value === p.value
  return (
    <div className="period-selector">
      <div className="period-selector-header">
        <span className="period-selector-title">Select Fiscal Year or Quarter</span>
        {selected && (
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
                className={`period-pill${isSel(p) ? ' active' : ''}`}
                onClick={() => onToggle(p)}
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
                      className={`period-pill${isSel(p) ? ' active' : ''}`}
                      onClick={() => onToggle(p)}
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
// Scope tabs — Total · Lessons · Group Classes
// ─────────────────────────────────────────────────────────────────────────────

const SCOPES = [
  { id: 'total',  label: 'Total',         key: 'totalBreakdown'  },
  { id: 'lesson', label: 'Lessons',       key: 'lessonBreakdown' },
  { id: 'group',  label: 'Group Classes', key: 'groupBreakdown'  },
]

function ScopeTabs({ scope, onScope, counts }) {
  return (
    <div className="demo-scope-tabs">
      {SCOPES.map(s => (
        <button
          key={s.id}
          className={`demo-scope-tab${scope === s.id ? ' active' : ''}`}
          onClick={() => onScope(s.id)}
        >
          <span className="demo-scope-tab-count">{counts[s.id].toLocaleString()}</span>
          <span className="demo-scope-tab-label">{s.label}</span>
        </button>
      ))}
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
              <td className="demo-dim-pct">{b.pct === null ? '—' : `${b.pct.toFixed(1)}%`}</td>
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

const SCOPE_META = {
  total:  { title: 'Total Students',       noun: 'students' },
  lesson: { title: 'Lesson Students',      noun: 'lesson students' },
  group:  { title: 'Group Class Students', noun: 'group-class students' },
}

export default function Demographics() {
  const [periodRows, setPeriodRows]         = useState([])
  const [enrollments, setEnrollments]       = useState([])
  const [periodsLoading, setPeriodsLoading] = useState(true)
  const [loading, setLoading]               = useState(false)
  const [error, setError]                   = useState(null)
  const [selectedPeriod, setSelectedPeriod] = useState(null) // { type, value } | null
  const [scope, setScope]                   = useState('total')
  const [sortCol, setSortCol]               = useState('courseName')
  const [sortDir, setSortDir]               = useState('asc')
  const [expandedKey, setExpandedKey]       = useState(null)

  // Phase 1: lightweight mount fetch of time_period + fiscal_year for pills only
  useEffect(() => { loadPeriods() }, [])

  async function loadPeriods() {
    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await supabase
        .from('enrollments')
        .select('time_period, fiscal_year')
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setPeriodsLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }
    setPeriodRows(all.map(e => ({ timePeriod: e.time_period, fiscalYear: e.fiscal_year })))
    setPeriodsLoading(false)
  }

  const { fyPeriods, quarterGroups } = useMemo(() => {
    const fySet = new Set(), qSet = new Set()
    for (const r of periodRows) {
      if (r.fiscalYear) fySet.add(r.fiscalYear)
      if (r.timePeriod) qSet.add(r.timePeriod)
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
  }, [periodRows])

  // Phase 2: full fetch on period selection
  useEffect(() => {
    setExpandedKey(null)
    if (!selectedPeriod) { setEnrollments([]); setError(null); return }
    loadData(selectedPeriod)
  }, [selectedPeriod])

  async function loadData(period) {
    setLoading(true)
    setError(null)

    const column = period.type === 'fiscal_year' ? 'fiscal_year' : 'time_period'
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
        .eq(column, period.value)
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }

    setEnrollments(all)
    setLoading(false)
  }

  const breakdowns = useMemo(() => buildUnits(enrollments), [enrollments])
  const { totalBreakdown, lessonBreakdown, groupBreakdown, classRows } = breakdowns

  const sortedRows = useMemo(
    () => sortRows(classRows, sortCol, sortDir),
    [classRows, sortCol, sortDir]
  )

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const COL_COUNT = 2
  const hasPeriods = fyPeriods.length > 0 || quarterGroups.length > 0

  const scopeCounts = {
    total:  totalBreakdown.total,
    lesson: lessonBreakdown.total,
    group:  groupBreakdown.total,
  }
  const activeBreakdown = { total: totalBreakdown, lesson: lessonBreakdown, group: groupBreakdown }[scope]
  const meta = SCOPE_META[scope]
  const periodDisplay = selectedPeriod?.value ?? ''

  if (periodsLoading) return <p className="coming-soon">Loading…</p>

  return (
    <div className="pig-report">
      {error && <div className="error-banner">{error}</div>}

      {/* On-page description */}
      <div className="pig-methodology">
        <div className="pig-methodology-title">About this report</div>
        <p>
          The Demographics report summarizes the age, gender, ethnicity, and household income
          of <strong>unique students</strong> for a selected fiscal year or quarter. Use the
          tabs to switch between <strong>Total</strong> (lessons + classes), <strong>Lessons</strong>,
          and <strong>Group Classes</strong>; the Group Classes view also lists a per-class breakdown
          (one row per course name). Every figure is shown as a raw unique-student count;
          percentages are out of only the students who gave a meaningful response for that dimension
          (the "No Response" count is shown but excluded from the percentage base).
          No student names or other identifying details are shown.
        </p>
      </div>

      {!hasPeriods ? (
        <p className="coming-soon">No enrollment data yet. Upload reports to get started.</p>
      ) : (
        <>
          <PeriodSelector
            fyPeriods={fyPeriods}
            quarterGroups={quarterGroups}
            selected={selectedPeriod}
            onToggle={p => setSelectedPeriod(prev =>
              prev && prev.type === p.type && prev.value === p.value ? null : p)}
            onClear={() => setSelectedPeriod(null)}
          />

          {loading ? (
            <p className="coming-soon">Loading…</p>
          ) : !selectedPeriod ? (
            <p className="coming-soon">Select a fiscal year or quarter above to view the report.</p>
          ) : totalBreakdown.total === 0 ? (
            <p className="coming-soon">No enrollments found for {periodDisplay}.</p>
          ) : (
            <>
              <ScopeTabs scope={scope} onScope={setScope} counts={scopeCounts} />

              <div className="demo-total-block">
                <div className="pig-roster-header">
                  <span className="pig-roster-title">
                    {meta.title} — {periodDisplay} · {activeBreakdown.total.toLocaleString()} unique students
                  </span>
                  <button
                    className="btn-secondary"
                    onClick={() => exportCSV(breakdowns, sortedRows, periodDisplay)}
                  >
                    Export CSV
                  </button>
                </div>
                {activeBreakdown.total === 0 ? (
                  <p className="coming-soon">No {meta.noun} found for {periodDisplay}.</p>
                ) : (
                  <DimensionGrid breakdown={activeBreakdown} />
                )}
              </div>

              {/* Per-class table — only in the Group Classes view */}
              {scope === 'group' && (
                <>
                  <div className="pig-roster-header">
                    <span className="pig-roster-title">
                      {classRows.length} unique group class{classRows.length !== 1 ? 'es' : ''}
                    </span>
                  </div>

                  {classRows.length === 0 ? (
                    <p className="coming-soon">No group classes found for {periodDisplay}.</p>
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
        </>
      )}
    </div>
  )
}
