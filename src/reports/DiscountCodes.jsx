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

function today() { return new Date().toISOString().slice(0, 10) }

// Ages outside this range are treated as an unknown birthdate — ASAP writes a
// 1900-01-01 placeholder (age ~126) when the real date is missing.
const MAX_PLAUSIBLE_AGE = 100

// Age in full years of a person born on birthdateStr as of referenceDateStr.
// Returns null if missing or implausible (placeholder birthdate).
function ageAtDate(birthdateStr, referenceDateStr) {
  if (!birthdateStr || !referenceDateStr) return null
  const [by, bm, bd] = birthdateStr.split('-').map(Number)
  const [ry, rm, rd] = referenceDateStr.split('-').map(Number)
  let age = ry - by
  if (rm < bm || (rm === bm && rd < bd)) age--
  if (age < 0 || age > MAX_PLAUSIBLE_AGE) return null
  return age
}

// Normalize a discount_type into a real code or null (no discount). ASAP writes
// blanks as an empty string, a single space, or the literal "0".
function normCode(raw) {
  const v = String(raw ?? '').trim()
  if (v === '' || v === '0') return null
  return v
}

// ─────────────────────────────────────────────────────────────────────────────
// Period selector — Fiscal Year + Quarter pills, multi-select
// ─────────────────────────────────────────────────────────────────────────────

function PeriodSelector({ fyPeriods, quarterGroups, isSelected, toggle, onClear, hasSelection }) {
  return (
    <div className="period-selector">
      <div className="period-selector-header">
        <span className="period-selector-title">Select Fiscal Years or Quarters</span>
        {hasSelection && <button className="period-clear-btn" onClick={onClear}>Clear</button>}
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
// Data processing
// ─────────────────────────────────────────────────────────────────────────────

function buildSummary(enrollments) {
  // Per discount code: applications (enrollment rows) and unique students.
  const codes = new Map() // code → { applications, students:Set }
  // Per student: name, enrollments, and the codes they received.
  const students = new Map() // customer_id → { firstName, lastName, enrollments, withDiscount, codes:Map(code→n) }

  for (const e of enrollments) {
    const cid = e.customer_id
    const code = normCode(e.discount_type)

    if (code) {
      let c = codes.get(code)
      if (!c) { c = { applications: 0, students: new Set() } ; codes.set(code, c) }
      c.applications += 1
      if (cid) c.students.add(cid)
    }

    if (!cid) continue
    let s = students.get(cid)
    if (!s) {
      s = {
        firstName: e.students?.first_name ?? '',
        lastName:  e.students?.last_name  ?? '',
        birthdate: e.students?.birthdate  ?? null,
        earliestStart: null,
        enrollments: 0,
        withDiscount: 0,
        codes: new Map(),
      }
      students.set(cid, s)
    }
    if (s.birthdate == null && e.students?.birthdate != null) s.birthdate = e.students.birthdate
    const start = e.events?.class_start_date ?? null
    if (start && (!s.earliestStart || start < s.earliestStart)) s.earliestStart = start
    s.enrollments += 1
    if (code) {
      s.withDiscount += 1
      s.codes.set(code, (s.codes.get(code) ?? 0) + 1)
    }
  }

  const codeRows = [...codes.entries()]
    .map(([code, c]) => ({ code, applications: c.applications, uniqueStudents: c.students.size }))

  const studentRows = [...students.entries()].map(([customerId, s]) => ({
    customerId,
    firstName: s.firstName,
    lastName: s.lastName,
    age: ageAtDate(s.birthdate, s.earliestStart),
    enrollments: s.enrollments,
    withDiscount: s.withDiscount,
    codeCount: s.codes.size,
    codes: [...s.codes.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  }))

  return { codeRows, studentRows }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sorting
// ─────────────────────────────────────────────────────────────────────────────

function sortBy(rows, col, dir, cols) {
  return [...rows].sort((a, b) => {
    const va = cols[col](a), vb = cols[col](b)
    if (va < vb) return dir === 'asc' ? -1 : 1
    if (va > vb) return dir === 'asc' ?  1 : -1
    return 0
  })
}

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
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function exportCodeCSV(rows, label) {
  const headers = ['Discount Code', 'Applications', 'Unique Students']
  const csv = [headers, ...rows.map(r => [r.code, r.applications, r.uniqueStudents])]
    .map(r => r.map(esc).join(',')).join('\n')
  triggerDownload(csv, `discount-codes-summary-${label}-${today()}.csv`)
}

function exportStudentCSV(rows, label) {
  const headers = ['Customer ID', 'First Name', 'Last Name', 'Age at Enrollment', 'Enrollments', 'Enrollments w/ Discount', 'Discount Codes']
  const csv = [
    headers,
    ...rows.map(r => [
      r.customerId, r.firstName, r.lastName, r.age ?? '', r.enrollments, r.withDiscount,
      r.codes.map(([code, n]) => (n > 1 ? `${code} (x${n})` : code)).join('; '),
    ]),
  ].map(r => r.map(esc).join(',')).join('\n')
  triggerDownload(csv, `discount-codes-students-${label}-${today()}.csv`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Main report component
// ─────────────────────────────────────────────────────────────────────────────

export default function DiscountCodes() {
  const [periodRows, setPeriodRows]         = useState([])
  const [enrollments, setEnrollments]       = useState([])
  const [periodsLoading, setPeriodsLoading] = useState(true)
  const [loading, setLoading]               = useState(false)
  const [error, setError]                   = useState(null)
  const [selected, setSelected]             = useState([])
  const [discountedOnly, setDiscountedOnly] = useState(false)
  const [codeSort, setCodeSort]             = useState({ col: 'applications', dir: 'desc' })
  const [studentSort, setStudentSort]       = useState({ col: 'lastName', dir: 'asc' })

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
    setPeriodRows(all)
    setPeriodsLoading(false)
  }

  const { fyPeriods, quarterGroups } = useMemo(() => {
    const fySet = new Set(), qSet = new Set()
    for (const r of periodRows) {
      if (r.fiscal_year) fySet.add(r.fiscal_year)
      if (r.time_period) qSet.add(r.time_period)
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

  useEffect(() => {
    if (selected.length === 0) { setEnrollments([]); setError(null); return }
    loadData(selected)
  }, [selected])

  async function loadData(selectedPeriods) {
    setLoading(true)
    setError(null)

    const quarters = selectedPeriods.filter(p => p.type === 'quarter').map(p => p.value)
    const fys      = selectedPeriods.filter(p => p.type === 'fiscal_year').map(p => p.value)

    let query = supabase
      .from('enrollments')
      .select('customer_id, discount_type, time_period, fiscal_year, events(class_start_date), students(first_name, last_name, birthdate)')

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

    setEnrollments(all)
    setLoading(false)
  }

  const { codeRows, studentRows } = useMemo(() => buildSummary(enrollments), [enrollments])

  const sortedCodeRows = useMemo(() => sortBy(codeRows, codeSort.col, codeSort.dir, {
    code:           r => r.code.toLowerCase(),
    applications:   r => r.applications,
    uniqueStudents: r => r.uniqueStudents,
  }), [codeRows, codeSort])

  const visibleStudentRows = useMemo(() => {
    const rows = discountedOnly ? studentRows.filter(r => r.withDiscount > 0) : studentRows
    return sortBy(rows, studentSort.col, studentSort.dir, {
      lastName:     r => `${(r.lastName ?? '').toLowerCase()} ${(r.firstName ?? '').toLowerCase()}`,
      age:          r => (r.age == null ? -1 : r.age),
      enrollments:  r => r.enrollments,
      withDiscount: r => r.withDiscount,
      codeCount:    r => r.codeCount,
    })
  }, [studentRows, discountedOnly, studentSort])

  function toggle(p) {
    setSelected(prev => {
      const has = prev.some(x => x.type === p.type && x.value === p.value)
      return has ? prev.filter(x => !(x.type === p.type && x.value === p.value)) : [...prev, p]
    })
  }
  const isSelected = p => selected.some(x => x.type === p.type && x.value === p.value)

  function sortCode(col) {
    setCodeSort(s => s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' })
  }
  function sortStudent(col) {
    setStudentSort(s => s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' })
  }

  const fileLabel = selected.map(p => p.value.replace(/\s+/g, '-')).join('_') || 'export'
  const totalApplications = codeRows.reduce((s, r) => s + r.applications, 0)
  const hasData = fyPeriods.length > 0 || quarterGroups.length > 0

  if (periodsLoading) return <p className="coming-soon">Loading…</p>

  return (
    <div className="pig-report">
      {error && <div className="error-banner">{error}</div>}

      <div className="pig-methodology">
        <div className="pig-methodology-title">About this report</div>
        <p>
          Select one or more fiscal years and/or quarters. The <strong>Discount Code Summary</strong>{' '}
          lists every discount code applied to an enrollment in that timeframe, with how many times it
          was applied (applications) and how many unique students received it. The{' '}
          <strong>Student List</strong> shows every student with an enrollment in the timeframe, their
          age at their earliest enrollment in that timeframe, and the discount codes they received
          (a missing or placeholder birthdate shows as "—"). Both tables are downloadable as CSVs.
          "Applications" counts
          enrollment rows, so a student enrolled in several classes with the same code is counted once
          per enrollment in the summary but once overall in the unique-student column.
        </p>
      </div>

      {!hasData ? (
        <p className="coming-soon">No enrollment data yet. Upload reports to get started.</p>
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
            <p className="coming-soon">Loading…</p>
          ) : selected.length === 0 ? (
            <p className="coming-soon">Select one or more periods above to generate the report.</p>
          ) : (
            <>
              {/* Discount Code Summary */}
              <div className="pig-roster-header">
                <span className="pig-roster-title">
                  Discount Code Summary — {codeRows.length} code{codeRows.length !== 1 ? 's' : ''},{' '}
                  {totalApplications.toLocaleString()} application{totalApplications !== 1 ? 's' : ''}
                </span>
                <button className="btn-secondary" onClick={() => exportCodeCSV(sortedCodeRows, fileLabel)}>
                  Export CSV
                </button>
              </div>
              {codeRows.length === 0 ? (
                <p className="coming-soon">No discount codes were applied in this timeframe.</p>
              ) : (
                <div className="report-scroll">
                  <table className="cls-table">
                    <thead>
                      <tr>
                        <SortTh col="code"           label="Discount Code"   sortCol={codeSort.col} sortDir={codeSort.dir} onSort={sortCode} />
                        <SortTh col="applications"   label="Applications"    sortCol={codeSort.col} sortDir={codeSort.dir} onSort={sortCode} align="right" />
                        <SortTh col="uniqueStudents" label="Unique Students" sortCol={codeSort.col} sortDir={codeSort.dir} onSort={sortCode} align="right" />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedCodeRows.map(r => (
                        <tr key={r.code}>
                          <td className="cls-course">{r.code}</td>
                          <td className="cls-num">{r.applications.toLocaleString()}</td>
                          <td className="cls-num">{r.uniqueStudents.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Student List */}
              <div className="pig-roster-header" style={{ marginTop: 28 }}>
                <span className="pig-roster-title">
                  Student List — {visibleStudentRows.length.toLocaleString()} student{visibleStudentRows.length !== 1 ? 's' : ''}
                </span>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button
                    className={`period-pill${discountedOnly ? ' active' : ''}`}
                    onClick={() => setDiscountedOnly(v => !v)}
                    title="Show only students who received at least one discount code"
                  >
                    With a discount only
                  </button>
                  <button className="btn-secondary" onClick={() => exportStudentCSV(visibleStudentRows, fileLabel)}>
                    Export CSV
                  </button>
                </div>
              </div>
              <div className="report-scroll">
                <table className="cls-table">
                  <thead>
                    <tr>
                      <th className="cls-th">Customer ID</th>
                      <SortTh col="lastName"     label="Student"                 sortCol={studentSort.col} sortDir={studentSort.dir} onSort={sortStudent} />
                      <SortTh col="age"          label="Age"                     sortCol={studentSort.col} sortDir={studentSort.dir} onSort={sortStudent} align="right" />
                      <SortTh col="enrollments"  label="Enrollments"             sortCol={studentSort.col} sortDir={studentSort.dir} onSort={sortStudent} align="right" />
                      <SortTh col="withDiscount" label="With Discount"           sortCol={studentSort.col} sortDir={studentSort.dir} onSort={sortStudent} align="right" />
                      <th className="cls-th">Discount Codes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleStudentRows.map(r => (
                      <tr key={r.customerId}>
                        <td className="pig-mono">{r.customerId}</td>
                        <td>{`${r.lastName ?? ''}${r.firstName ? ', ' + r.firstName : ''}`.trim() || '—'}</td>
                        <td className="cls-num">{r.age ?? '—'}</td>
                        <td className="cls-num">{r.enrollments}</td>
                        <td className="cls-num">{r.withDiscount}</td>
                        <td>{r.codes.map(([code, n]) => (n > 1 ? `${code} (x${n})` : code)).join('; ') || '—'}</td>
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
