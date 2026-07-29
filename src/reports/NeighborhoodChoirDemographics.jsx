import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { fySortKey } from '../utils/periodUtils'
import {
  NO_RESPONSE, INCOME_ORDER, LOW_INCOME,
  incomeCategoryFor, ethnicityLabelFor, genderLabelFor,
} from './demographicCategories'

// ─── pure logic (verified by scripts/neighborhood-choir-check.mjs) ───────────

// The program's full ASAP course name is "Neighborhood Choirs for Older Adults
// and Adults with Disabilities". ASAP relabels courses regularly, so match on
// the distinguishing words rather than the exact string — nothing else in the
// catalog pairs "neighborhood" with "choir" (the only other choir course on
// file is "R&B Choir and More"). Whatever matched is listed on screen, so a
// rename that widens or narrows the match is visible rather than silent.
const COURSE_RE = /neighborhood\s*choirs?/i

function isNeighborhoodChoir(courseName) {
  return COURSE_RE.test(courseName ?? '')
}

// The three dimensions this report breaks down, in display order. Category
// labels come from demographicCategories.js, shared with the Demographics
// report. `order` fixes the row order for income (a logical scale); ethnicity
// and gender order by count, which varies year to year.
const DIMENSIONS = [
  { id: 'income',    title: 'Household income', order: INCOME_ORDER, valueOf: s => incomeCategoryFor(s.income) },
  { id: 'ethnicity', title: 'Ethnicity',        order: null,         valueOf: s => ethnicityLabelFor(s.ethnicity) },
  { id: 'gender',    title: 'Gender',           order: null,         valueOf: s => genderLabelFor(s.gender) },
]

// Unique students in one fiscal year, keyed by customer_id. A student in three
// quarters of the choir is one student; demographic fields are backfilled from
// whichever enrollment row has them (they come from the same student record, so
// this only guards against a missing join).
function collectStudents(enrollments) {
  const students = new Map()
  for (const e of enrollments) {
    const cid = e.customer_id
    if (!cid) continue
    if (!isNeighborhoodChoir(e.events?.course_name)) continue
    const s = e.students ?? {}
    const cur = students.get(cid)
    if (!cur) {
      students.set(cid, {
        gender:    s.gender           ?? null,
        ethnicity: s.ethnicity        ?? null,
        income:    s.household_income ?? null,
      })
      continue
    }
    if (cur.gender    == null && s.gender           != null) cur.gender    = s.gender
    if (cur.ethnicity == null && s.ethnicity        != null) cur.ethnicity = s.ethnicity
    if (cur.income    == null && s.household_income != null) cur.income    = s.household_income
  }
  return students
}

// Counts per category for one dimension. Percentages are out of the students
// who gave a meaningful response (No Response counted and shown, but excluded
// from the base), exactly as in the Demographics report.
function dimensionBreakdown(students, dim) {
  const counts = {}
  for (const s of students.values()) {
    const label = dim.valueOf(s)
    counts[label] = (counts[label] ?? 0) + 1
  }
  const total = students.size
  const base  = total - (counts[NO_RESPONSE] ?? 0)
  return { total, base, counts }
}

function buildReport(enrollments) {
  const students = collectStudents(enrollments)
  const dims = {}
  for (const d of DIMENSIONS) dims[d.id] = dimensionBreakdown(students, d)
  const lowCount = dims.income.counts[LOW_INCOME] ?? 0
  return {
    uniqueStudents: students.size,
    dims,
    lowIncome: {
      count: lowCount,
      base:  dims.income.base,
      pct:   dims.income.base === 0 ? null : (lowCount / dims.income.base) * 100,
    },
  }
}

function pctFor(label, count, base) {
  if (label === NO_RESPONSE || base === 0) return null
  return (count / base) * 100
}

// One table per dimension: a bold unique-students row, then a row per category
// with a column per fiscal year. Category rows are the union across the selected
// years, so a category present in only one year still gets a row (0 elsewhere).
// cols: [{ fy, report }] in chronological order.
function buildComparison(cols) {
  if (cols.length === 0) return []

  return DIMENSIONS.map(dim => {
    const perYear = cols.map(c => c.report.dims[dim.id])

    let labels
    if (dim.order) {
      labels = dim.order
    } else {
      const totals = new Map()
      for (const d of perYear) {
        for (const [label, count] of Object.entries(d.counts)) {
          totals.set(label, (totals.get(label) ?? 0) + count)
        }
      }
      labels = [...totals.entries()]
        .sort(([la, ca], [lb, cb]) => {
          if (la === NO_RESPONSE) return 1
          if (lb === NO_RESPONSE) return -1
          return cb - ca || la.localeCompare(lb)
        })
        .map(([l]) => l)
    }

    const rows = [
      {
        label: 'Unique students',
        kind:  'total',
        cells: cols.map(c => ({ count: c.report.uniqueStudents, pct: null })),
      },
      ...labels.map(label => ({
        label,
        kind: 'category',
        cells: perYear.map(d => {
          const count = d.counts[label] ?? 0
          return { count, pct: pctFor(label, count, d.base) }
        }),
      })),
    ]

    return { id: dim.id, title: dim.title, rows }
  })
}

// Change between two cells. The unique-students row reports a relative %
// change; category rows report the shift in share in percentage points, since a
// category can grow in headcount while shrinking as a share of the program.
function cellDelta(a, b, kind) {
  const count = b.count - a.count
  if (kind === 'total') {
    return { count, change: a.count === 0 ? null : (count / a.count) * 100, unit: '%' }
  }
  const change = a.pct === null || b.pct === null ? null : b.pct - a.pct
  return { count, change, unit: 'pp' }
}

// ─── end pure logic ─────────────────────────────────────────────────────────

function esc(v) { return `"${String(v ?? '').replace(/"/g, '""')}"` }

function triggerDownload(csv, filename) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  URL.revokeObjectURL(url)
}

function today() { return new Date().toISOString().slice(0, 10) }

function fmtCount(n) { return `${n > 0 ? '+' : ''}${n.toLocaleString()}` }

function fmtChange(change, unit) {
  if (change === null) return '—'
  return `${change > 0 ? '+' : ''}${change.toFixed(1)}${unit === 'pp' ? ' pp' : '%'}`
}

function deltaClass(raw) {
  if (raw > 0) return 'pos'
  if (raw < 0) return 'neg'
  return 'zero'
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export — tall format: one row per (dimension, category), a column pair
// per fiscal year, and Δ pairs between consecutive years.
// ─────────────────────────────────────────────────────────────────────────────

function exportCSV(units, fys) {
  const headers = ['Dimension', 'Category']
  for (const fy of fys) headers.push(`${fy} Students`, `${fy} %`)
  for (let i = 0; i < fys.length - 1; i++) {
    headers.push(`Δ ${fys[i]}→${fys[i + 1]} Students`, `Δ ${fys[i]}→${fys[i + 1]} % / pp`)
  }

  const rows = []
  for (const u of units) {
    for (const r of u.rows) {
      const cells = [u.title, r.label]
      for (const c of r.cells) cells.push(c.count, c.pct === null ? '' : c.pct.toFixed(1))
      for (let i = 0; i < r.cells.length - 1; i++) {
        const d = cellDelta(r.cells[i], r.cells[i + 1], r.kind)
        cells.push(d.count, d.change === null ? '' : d.change.toFixed(1))
      }
      rows.push(cells)
    }
  }

  triggerDownload(
    [headers, ...rows].map(r => r.map(esc).join(',')).join('\n'),
    `neighborhood-choir-demographics-${fys.join('_')}-${today()}.csv`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation
// ─────────────────────────────────────────────────────────────────────────────

function UnitCard({ unit, fys }) {
  // Column layout: each fiscal year, with a Δ column between consecutive years.
  const cols = []
  fys.forEach((fy, i) => {
    cols.push({ type: 'fy', fy, i })
    if (i < fys.length - 1) cols.push({ type: 'delta', a: i, b: i + 1 })
  })

  return (
    <div className="liyp-group-card">
      <div className="pig-roster-header">
        <span className="pig-roster-title">{unit.title}</span>
      </div>
      <div className="report-scroll">
        <table className="report-table">
          <thead>
            <tr>
              <th className="rt-label-hdr">Category</th>
              {cols.map((col, ci) =>
                col.type === 'fy' ? (
                  <th key={ci} className="rt-period-hdr">
                    <div className="rt-period-name">{col.fy}</div>
                    <div className="rt-period-sub">Students / %</div>
                  </th>
                ) : (
                  <th key={ci} className="rt-delta-hdr">Δ</th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {unit.rows.map(row => (
              <tr key={row.label} className={row.kind === 'total' ? 'rt-row rt-top-row' : 'rt-row rt-sub-row'}>
                <td className="rt-label">{row.label}</td>
                {cols.map((col, ci) => {
                  if (col.type === 'fy') {
                    const c = row.cells[col.i]
                    return (
                      <td key={ci} className="rt-period-cell">
                        <div className="cell-enr">{c.count.toLocaleString()}</div>
                        {row.kind !== 'total' && (
                          <div className="cell-stu">{c.pct === null ? '—' : `${c.pct.toFixed(1)}%`}</div>
                        )}
                      </td>
                    )
                  }
                  const d = cellDelta(row.cells[col.a], row.cells[col.b], row.kind)
                  return (
                    <td key={ci} className="rt-delta-cell">
                      <div className={`delta-line ${deltaClass(d.count)}`}>{fmtCount(d.count)}</div>
                      <div className={`delta-line ${deltaClass(d.change ?? 0)}`}>
                        {fmtChange(d.change, d.unit)}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main report component
// ─────────────────────────────────────────────────────────────────────────────

export default function NeighborhoodChoirDemographics() {
  const [periodRows, setPeriodRows]         = useState([])
  const [enrollments, setEnrollments]       = useState([])
  const [periodsLoading, setPeriodsLoading] = useState(true)
  const [loading, setLoading]               = useState(false)
  const [error, setError]                   = useState(null)
  const [selectedFYs, setSelectedFYs]       = useState([])
  const [infoOpen, setInfoOpen]             = useState(false)
  const [coursesOpen, setCoursesOpen]       = useState(false)

  useEffect(() => { loadPeriods() }, [])

  // Phase 1: which fiscal years the program actually ran in, so the pills only
  // offer years with choir enrollments.
  async function loadPeriods() {
    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await supabase
        .from('enrollments')
        .select('fiscal_year, events(course_name)')
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setPeriodsLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }
    setPeriodRows(all.filter(e => isNeighborhoodChoir(e.events?.course_name)))
    setPeriodsLoading(false)
  }

  const fyPeriods = useMemo(() => {
    const s = new Set()
    for (const r of periodRows) if (r.fiscal_year) s.add(r.fiscal_year)
    return [...s].sort((a, b) => fySortKey(a) - fySortKey(b))
  }, [periodRows])

  // Selected years in chronological order — the column order of every table.
  const orderedFYs = useMemo(
    () => [...selectedFYs].sort((a, b) => fySortKey(a) - fySortKey(b)),
    [selectedFYs]
  )
  const fyKey = orderedFYs.join('|')

  useEffect(() => {
    if (orderedFYs.length === 0) { setEnrollments([]); setError(null); return }
    loadData(orderedFYs)
  }, [fyKey])

  // Phase 2: full demographic fetch for the selected years. Course filtering
  // happens client-side in collectStudents (the course name lives on `events`,
  // so filtering it server-side would mean a second round trip for event IDs).
  async function loadData(fys) {
    setLoading(true)
    setError(null)
    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await supabase
        .from('enrollments')
        .select(`
          customer_id, fiscal_year,
          events(course_name),
          students(gender, ethnicity, household_income)
        `)
        .in('fiscal_year', fys)
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }
    setEnrollments(all)
    setLoading(false)
  }

  // One independent report per fiscal year — a student enrolled in two of the
  // selected years is counted once in each year's column.
  const fyReports = useMemo(() => {
    const byFY = new Map(orderedFYs.map(fy => [fy, []]))
    for (const e of enrollments) {
      const bucket = byFY.get(e.fiscal_year)
      if (bucket) bucket.push(e)
    }
    return orderedFYs.map(fy => ({ fy, report: buildReport(byFY.get(fy) ?? []) }))
  }, [enrollments, fyKey])

  const units = useMemo(() => buildComparison(fyReports), [fyReports])

  // Every course name that matched, so an ASAP relabel is visible on screen.
  const matchedCourses = useMemo(() => {
    const names = new Set()
    for (const e of enrollments) {
      const cn = e.events?.course_name
      if (cn && isNeighborhoodChoir(cn)) names.add(cn)
    }
    return [...names].sort()
  }, [enrollments])

  // Headline stats describe the most recent selected year, named explicitly so
  // a multi-year selection can't be misread as a total.
  const latest = fyReports[fyReports.length - 1] ?? null
  const noStudents = fyReports.length > 0 && fyReports.every(f => f.report.uniqueStudents === 0)

  if (periodsLoading) return <p className="coming-soon">Loading…</p>

  return (
    <div className="pig-report">
      {error && <div className="error-banner">{error}</div>}

      {/* Methodology */}
      <div className="pig-courses ugcb-info-block">
        <button className="pig-courses-toggle" onClick={() => setInfoOpen(o => !o)}>
          <span>About this report</span>
          <span className="pig-courses-chevron">{infoOpen ? '▲' : '▼'}</span>
        </button>
        {infoOpen && (
          <div className="ugcb-info-body">
            <div className="ugcb-info-section-title">What this report shows</div>
            <p>
              The ethnicity, gender, and household income of <strong>unique students</strong> enrolled
              in the Neighborhood Choir Program — ASAP course name{' '}
              <em>Neighborhood Choirs for Older Adults and Adults with Disabilities</em>. Pick one or
              more fiscal years; each dimension gets a table with a column per year. A student
              enrolled in several quarters of the choir counts <strong>once</strong> per fiscal year.
              Every enrollment in the database qualifies — only ENROLLED and PEND statuses are
              imported. No student names or other identifying details are shown.
            </p>
            <div className="ugcb-info-section-title">Which classes count</div>
            <p>
              An enrollment counts if its course name contains "neighborhood" followed by "choir" or
              "choirs" (case-insensitive), which picks up every section of the program regardless of
              quarter or instructor. Matching on the distinguishing words rather than the exact title
              is deliberate: ASAP relabels courses regularly. The{' '}
              <strong>matched course names</strong> are listed above the tables so a rename that
              widens or narrows the match shows up rather than passing silently.
            </p>
            <div className="ugcb-info-section-title">Categories and percentages</div>
            <p>
              Ethnicity, gender, and income categories are the same ones the{' '}
              <strong>Demographics</strong> report uses — the definitions are shared in code, so the
              two reports cannot drift apart. Ethnicity is the single value coalesced from ASAP's
              three ethnicity columns on upload, with Hispanic and Latinx merged to Hispanic/Latinx;
              gender merges the trans and gender-nonconforming variants each into one category.
            </p>
            <p>
              <strong>Household income</strong> maps ASAP's bracket labels to High, Low, or Decline to
              State through an explicit lookup table. ASAP has changed those labels several times, so
              a bracket not yet in the table lands in No Response rather than disappearing — a jump in
              No Response is the signal to update the table. The <strong>Low</strong> row is the
              low-income figure: its percentage is the share of responding choir students who reported
              a household income in a low bracket.
            </p>
            <p>
              Percentages are out of the students who gave a meaningful response for{' '}
              <em>that</em> dimension: "No Response" is counted and shown but excluded from the
              percentage base, so the remaining categories sum to 100%. The base is worked out
              separately per dimension, because response rates differ across ethnicity, gender, and
              income. <strong>Decline to State stays in the base</strong> — it is an answer, not a
              missing value — which is what keeps this consistent with the Demographics report.
            </p>
            <p>
              <strong>Reading the low-income share — important.</strong> Because Decline to State is
              in the base, students who decline push the Low percentage <em>down</em>. In this program
              that effect dominates: the Low share fell from 70.7% (FY23) to 56.1% (FY26), but
              essentially every choir student who actually named an income bracket named a low one —
              99–100% in all four years on file (FY26: 206 Low against 2 High). The Decline to State
              row grew over the same span from 83 students to 159. So the falling Low percentage
              reflects <em>more students declining to answer</em>, not choir families getting
              wealthier. When reporting a low-income figure for this program, read the Low, Decline to
              State, and No Response rows together — and say which base the percentage uses.
            </p>
            <div className="ugcb-info-section-title">Comparing years</div>
            <p>
              Select more than one fiscal year to get a column per year (oldest to newest) with a{' '}
              <strong>Δ</strong> column between consecutive years. Each year is aggregated
              independently — a student enrolled in two selected years counts once in <em>each</em>{' '}
              year's column, so columns are not additive and Δ is not a count of the same people
              moving.
            </p>
            <p>
              In a Δ column the top line is the change in students and the bottom line is the change
              in share: a percent change for the <em>Unique students</em> row, and{' '}
              <strong>percentage points (pp)</strong> for category rows, since a category can grow in
              headcount while shrinking as a share of the program. "No Response" has no share, so its
              second line shows "—". Because percentages are taken out of responding students only,
              part of any pp shift can reflect a changing response rate rather than a changing student
              mix — check the No Response row before reading a pp move as a real demographic change.
            </p>
            <div className="ugcb-info-section-title">Export</div>
            <p>
              <strong>Export CSV</strong> produces one file covering all three dimensions: a row per
              dimension and category, a students and % column for each selected year, then Δ students
              and Δ "% / pp" columns between consecutive years.
            </p>
          </div>
        )}
      </div>

      {fyPeriods.length === 0 ? (
        <p className="coming-soon">
          No Neighborhood Choir enrollments found. Upload reports to get started.
        </p>
      ) : (
        <>
          <div className="period-selector">
            <div className="period-selector-header">
              <span className="period-selector-title">Select Fiscal Years</span>
              {selectedFYs.length > 0 && (
                <button className="period-clear-btn" onClick={() => setSelectedFYs([])}>Clear</button>
              )}
            </div>
            <div className="period-pills">
              {fyPeriods.map(fy => (
                <button
                  key={fy}
                  className={`period-pill${selectedFYs.includes(fy) ? ' active' : ''}`}
                  onClick={() => setSelectedFYs(prev =>
                    prev.includes(fy) ? prev.filter(v => v !== fy) : [...prev, fy]
                  )}
                >
                  {fy}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <p className="coming-soon">Loading…</p>
          ) : orderedFYs.length === 0 ? (
            <p className="coming-soon">
              Select one or more fiscal years above to view the report. Selecting several compares
              them side by side.
            </p>
          ) : noStudents ? (
            <p className="coming-soon">
              No Neighborhood Choir enrollments found for {orderedFYs.join(' · ')}.
            </p>
          ) : (
            <>
              {/* Headline stats for the most recent selected year */}
              {latest && (
                <div className="pig-summary">
                  <div className="pig-stat-card">
                    <div className="pig-stat-value">
                      {latest.report.uniqueStudents.toLocaleString()}
                    </div>
                    <div className="pig-stat-label">Unique students — {latest.fy}</div>
                  </div>
                  <div className="pig-stat-card">
                    <div className="pig-stat-value">
                      {latest.report.lowIncome.count.toLocaleString()}
                    </div>
                    <div className="pig-stat-label">
                      Low income — {latest.fy} (of {latest.report.lowIncome.base.toLocaleString()} responding)
                    </div>
                  </div>
                  <div className="pig-stat-card pig-stat-card--accent">
                    <div className="pig-stat-value">
                      {latest.report.lowIncome.pct === null
                        ? '—'
                        : `${latest.report.lowIncome.pct.toFixed(1)}%`}
                    </div>
                    <div className="pig-stat-label">Low income — {latest.fy}</div>
                  </div>
                </div>
              )}

              <div className="pig-roster-header">
                <span className="pig-roster-title">
                  Neighborhood Choir Program — {orderedFYs.join(' · ')}
                </span>
                <button className="btn-secondary" onClick={() => exportCSV(units, orderedFYs)}>
                  Export CSV
                </button>
              </div>

              {/* Course coverage — makes an ASAP relabel visible */}
              <div className="pig-courses">
                <button className="pig-courses-toggle" onClick={() => setCoursesOpen(o => !o)}>
                  <span>
                    Matched {matchedCourses.length} course{matchedCourses.length !== 1 ? 's' : ''}
                    {matchedCourses.length > 0 && !coursesOpen && (
                      <span className="pig-courses-preview">
                        : {matchedCourses.slice(0, 2).join(', ')}
                        {matchedCourses.length > 2 && '…'}
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

              {units.map(u => <UnitCard key={u.id} unit={u} fys={orderedFYs} />)}
            </>
          )}
        </>
      )}
    </div>
  )
}
