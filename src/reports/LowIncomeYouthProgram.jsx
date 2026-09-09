import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { fySortKey, classStartDate } from '../utils/periodUtils'
import {
  NO_RESPONSE, INCOME_ORDER,
  INCOME_PCT_EXCLUDED, RESPONSE_PCT_EXCLUDED, pctBase, bucketPct,
  incomeCategoryFor, ethnicityLabelFor, genderLabelFor,
} from './demographicCategories'

// ─── pure logic (verified by scripts/liyp-check.mjs) ─────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Group definitions (LIYP grant categories)
// ─────────────────────────────────────────────────────────────────────────────

// Sliding-scale discount codes. Matches the clean pattern (Child26_2023,
// Child37_2024-2025, …) AND the older Mission/Richmond satellite variants that
// embed the same tier (e.g. "Mission_FA2022 Child46_2022_Private"). Any code
// containing a whole-word "Child<NN>" token qualifies. "Children's Chorus"-style
// codes do NOT match because "Child" there is not followed by digits.
const SLIDING_RE = /(?:^|[ _])Child\d+(?:[ _]|$)/

// Merit scholarship codes. Every year labels them differently ("Merit - Fall
// 2025", "Merit Winter_2026", "MERIT Richmond_Summer_2022", "Mission Merit
// Scholars FA2022_Private", …), so any code containing the word "Merit"
// qualifies. No Merit code also carries a Child<NN> token, so the two rules
// never double-count the same enrollment.
const MERIT_RE = /merit/i

// An enrollment qualifies a student for the sliding-scale/merit youth group.
function isSlidingOrMerit(discountType) {
  const dt = discountType ?? ''
  return SLIDING_RE.test(dt) || MERIT_RE.test(dt)
}

const YMP_COURSES = new Set([
  'Young Musicians Program / Saturday Play! (Ensemble)',
  'Young Musicians Program / Saturday Play! (Theory)',
  'Mission District Young Musicians Program / Saturday Play!',
])

const CHILDRENS_CHORUS = "Children's Chorus"
const TEEN_JAZZ        = 'Teen Jazz Orchestra'

// Age window for the sliding-scale group (inclusive).
const MIN_AGE = 4
const MAX_AGE = 18
// Ages outside this range are treated as an unknown/placeholder birthdate
// (ASAP writes 1900-01-01 → age ~126 when a birthdate is missing).
const MAX_PLAUSIBLE_AGE = 100

const GROUPS = [
  { id: 'sliding', title: 'Sliding-Scale & Merit Youth (ages 4–18)', ageFiltered: true  },
  { id: 'ymp',     title: 'Young Musicians Program (YMP)',    ageFiltered: false },
  { id: 'chorus',  title: "Children's Chorus",               ageFiltered: false },
  { id: 'teen',    title: 'Teen Jazz Orchestra',             ageFiltered: false },
]

// ─────────────────────────────────────────────────────────────────────────────
// Dimensions
//
// The three breakdowns each group reports, in display order. Category labels
// and percentage bases come from demographicCategories.js, shared with the
// Demographics and Neighborhood Choir reports — a grant report that disagreed
// with Demographics about what counts as "Low" income would be a bug. `order`
// fixes the row order for income (a logical scale); ethnicity and gender order
// by count, which varies year to year. `excluded` is what the percentage base
// leaves out — income also drops "Decline to State", so income percentages
// cover only students who named a bracket.
// ─────────────────────────────────────────────────────────────────────────────

const DIMENSIONS = [
  {
    id: 'income', title: 'Household income', order: INCOME_ORDER,
    excluded: INCOME_PCT_EXCLUDED, baseNote: '% of students who named a bracket',
    valueOf: s => incomeCategoryFor(s.income),
  },
  {
    id: 'ethnicity', title: 'Ethnicity', order: null,
    excluded: RESPONSE_PCT_EXCLUDED, baseNote: '% of students who responded',
    valueOf: s => ethnicityLabelFor(s.ethnicity),
  },
  {
    id: 'gender', title: 'Gender', order: null,
    excluded: RESPONSE_PCT_EXCLUDED, baseNote: '% of students who responded',
    valueOf: s => genderLabelFor(s.gender),
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

// Age in full years of a person born on birthdateStr as of referenceDateStr.
function ageAtDate(birthdateStr, referenceDateStr) {
  if (!birthdateStr || !referenceDateStr) return null
  const [by, bm, bd] = birthdateStr.split('-').map(Number)
  const [ry, rm, rd] = referenceDateStr.split('-').map(Number)
  let age = ry - by
  if (rm < bm || (rm === bm && rd < bd)) age--
  return age
}

// Record a student in a group, backfilling demographic fields from whichever
// enrollment row has them (they come from the same student record, so this only
// guards against a missing join).
function remember(map, cid, s) {
  const cur = map.get(cid)
  if (!cur) {
    map.set(cid, {
      ethnicity: s.ethnicity        ?? null,
      gender:    s.gender           ?? null,
      income:    s.household_income ?? null,
    })
    return
  }
  if (cur.ethnicity == null && s.ethnicity        != null) cur.ethnicity = s.ethnicity
  if (cur.gender    == null && s.gender           != null) cur.gender    = s.gender
  if (cur.income    == null && s.household_income != null) cur.income    = s.household_income
}

// Counts per category for one dimension, with the percentage base that
// dimension's exclusions leave. Excluded labels keep their count and get no
// percentage.
function dimensionBreakdown(students, dim) {
  const counts = {}
  for (const s of students.values()) {
    const label = dim.valueOf(s)
    counts[label] = (counts[label] ?? 0) + 1
  }
  const total = students.size
  return { total, base: pctBase(counts, total, dim.excluded), counts, excluded: dim.excluded }
}

function breakdownsFor(students) {
  const dims = {}
  for (const d of DIMENSIONS) dims[d.id] = dimensionBreakdown(students, d)
  return { uniqueStudents: students.size, dims }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core aggregation
// ─────────────────────────────────────────────────────────────────────────────

function buildReport(enrollments) {
  // Per-group accumulators (customer_id → demographic fields)
  const acc = {}
  for (const g of GROUPS) acc[g.id] = new Map()
  const slidingSeen      = new Set()  // any customer with a sliding-scale or merit discount, any age
  const combinedStudents = new Map()  // deduped union across all four groups

  function addMember(groupId, cid, student) {
    remember(acc[groupId], cid, student)
    remember(combinedStudents, cid, student)
  }

  for (const e of enrollments) {
    const cid = e.customer_id
    if (!cid) continue
    const student = e.students ?? {}
    const course  = e.events?.course_name ?? null
    const dt      = e.discount_type ?? ''

    // 1. Sliding-scale/merit youth: has a Child<NN> or Merit discount AND age
    //    4–18 at class start.
    if (isSlidingOrMerit(dt)) {
      slidingSeen.add(cid)
      // classStartDate() nulls ASAP's far-future placeholder; ageAtDate returns
      // null for a missing reference date, which the age range below rejects.
      const age = ageAtDate(student.birthdate, classStartDate(e.events?.class_start_date))
      if (age !== null && age >= MIN_AGE && age <= MAX_AGE && age <= MAX_PLAUSIBLE_AGE) {
        addMember('sliding', cid, student)
      }
    }
    // 2. YMP: enrolled in any of the three named group classes.
    if (course && YMP_COURSES.has(course)) addMember('ymp', cid, student)
    // 3. Children's Chorus.
    if (course === CHILDRENS_CHORUS) addMember('chorus', cid, student)
    // 4. Teen Jazz Orchestra.
    if (course === TEEN_JAZZ) addMember('teen', cid, student)
  }

  // Sliding-scale/merit students dropped because their age couldn't be confirmed 4–18.
  const slidingExcludedAge = [...slidingSeen].filter(cid => !acc.sliding.has(cid)).length

  return {
    groups: GROUPS.map(g => ({ ...g, ...breakdownsFor(acc[g.id]) })),
    slidingExcludedAge,
    combined: breakdownsFor(combinedStudents),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Year-over-year comparison
//
// One "unit" per group plus Combined. Each unit becomes one table: a bold
// unique-students row, then — per dimension — a section header carrying that
// dimension's percentage base for each year, followed by a row per category,
// with a column per selected fiscal year. Keeping all three dimensions in one
// table keeps the year columns aligned and the Δ columns to a single set; the
// per-year base on the section header is what stops a "100.0% Low" cell from
// being read as 100% of the group.
//
// Category rows are the union across the selected years, so a category present
// in only one year still gets a row (0 elsewhere).
// ─────────────────────────────────────────────────────────────────────────────

const TOTAL_ROW_LABEL = 'Unique students'

function unitsOf(fyReport) {
  return [
    ...fyReport.groups.map(g => ({ id: g.id, title: g.title, data: g })),
    {
      id: 'combined',
      title: 'Combined — unique students across all groups',
      data: fyReport.combined,
    },
  ]
}

// Category labels for one dimension across all selected years: the dimension's
// fixed order, or by descending total count with No Response last.
function labelsFor(dim, perYear) {
  if (dim.order) return dim.order
  const totals = new Map()
  for (const d of perYear) {
    for (const [label, count] of Object.entries(d.counts)) {
      totals.set(label, (totals.get(label) ?? 0) + count)
    }
  }
  return [...totals.entries()]
    .sort(([la, ca], [lb, cb]) => {
      if (la === NO_RESPONSE) return 1
      if (lb === NO_RESPONSE) return -1
      return cb - ca || la.localeCompare(lb)
    })
    .map(([l]) => l)
}

// cols: [{ fy, report }] in chronological order.
function buildComparison(cols) {
  if (cols.length === 0) return []
  const unitDefs = unitsOf(cols[0].report)

  return unitDefs.map((def, ui) => {
    // Per-year data for this unit.
    const perUnit = cols.map(c => unitsOf(c.report)[ui].data)

    const rows = [
      {
        id:    'total',
        label: TOTAL_ROW_LABEL,
        kind:  'total',
        dim:   '',
        cells: perUnit.map(d => ({ count: d.uniqueStudents, pct: null })),
      },
    ]

    for (const dim of DIMENSIONS) {
      const perYear = perUnit.map(d => d.dims[dim.id])
      rows.push({
        id:    `${dim.id}:__base`,
        label: dim.title,
        note:  dim.baseNote,
        kind:  'section',
        dim:   dim.title,
        cells: perYear.map(d => ({ count: d.base, pct: null })),
      })
      for (const label of labelsFor(dim, perYear)) {
        rows.push({
          id:    `${dim.id}:${label}`,
          label,
          kind:  'category',
          dim:   dim.title,
          cells: perYear.map(d => {
            const count = d.counts[label] ?? 0
            // A category absent from this year is 0% of that year's base, not
            // "no data". Labels excluded from the base (No Response always,
            // plus Decline to State for income) keep their count and get no
            // percentage, matching the Demographics report.
            return { count, pct: bucketPct(label, count, d.base, d.excluded) }
          }),
        })
      }
    }

    return { id: def.id, title: def.title, rows }
  })
}

// Change between two cells. The unique-students row reports a relative %
// change; category rows report the shift in share in percentage points, since a
// category can grow in headcount while shrinking as a share of the group.
// Section (base) rows report the change in the base headcount only — a
// percentage of a percentage base would mean nothing.
function cellDelta(a, b, kind) {
  const count = b.count - a.count
  if (kind === 'total') {
    return { count, change: a.count === 0 ? null : (count / a.count) * 100, unit: '%' }
  }
  if (kind === 'section') return { count, change: null, unit: '' }
  const change = a.pct === null || b.pct === null ? null : b.pct - a.pct
  return { count, change, unit: 'pp' }
}

// ─── end pure logic ──────────────────────────────────────────────────────────

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
// CSV export — tall format: one row per (group, dimension, category), a column
// pair per fiscal year, and Δ pairs between consecutive years. A dimension's
// percentage base gets its own row so the spreadsheet carries the denominator
// the on-screen section header shows.
// ─────────────────────────────────────────────────────────────────────────────

function exportCSV(units, fys) {
  const headers = ['Group', 'Dimension', 'Category']
  for (const fy of fys) headers.push(`${fy} Students`, `${fy} %`)
  for (let i = 0; i < fys.length - 1; i++) {
    headers.push(`Δ ${fys[i]}→${fys[i + 1]} Students`, `Δ ${fys[i]}→${fys[i + 1]} % / pp`)
  }

  const rows = []
  for (const u of units) {
    for (const r of u.rows) {
      const label = r.kind === 'section' ? `Percentage base (${r.note.replace('% of students who ', '')})` : r.label
      const cells = [u.title, r.dim, label]
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
    `liyp-${fys.join('_')}-${today()}.csv`
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

  const empty = unit.rows[0].cells.every(c => c.count === 0)

  return (
    <div className="liyp-group-card">
      <div className="pig-roster-header">
        <span className="pig-roster-title">{unit.title}</span>
      </div>
      {empty ? (
        <p className="coming-soon" style={{ padding: '8px 0' }}>No students.</p>
      ) : (
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
              {unit.rows.map(row => {
                // Section rows carry the dimension's percentage base per year in
                // the year columns; the Δ columns stay blank there.
                if (row.kind === 'section') {
                  return (
                    <tr key={row.id} className="rt-section-hdr">
                      <td>{row.label} — {row.note}</td>
                      {cols.map((col, ci) =>
                        col.type === 'fy' ? (
                          <td key={ci} className="rt-period-cell liyp-base-cell">
                            of {row.cells[col.i].count.toLocaleString()}
                          </td>
                        ) : (
                          <td key={ci} />
                        )
                      )}
                    </tr>
                  )
                }
                return (
                  <tr key={row.id} className={row.kind === 'total' ? 'rt-row rt-top-row' : 'rt-row rt-sub-row'}>
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
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main report component
// ─────────────────────────────────────────────────────────────────────────────

export default function LowIncomeYouthProgram() {
  const [periodRows, setPeriodRows]         = useState([])
  const [enrollments, setEnrollments]       = useState([])
  const [periodsLoading, setPeriodsLoading] = useState(true)
  const [loading, setLoading]               = useState(false)
  const [error, setError]                   = useState(null)
  const [selectedFYs, setSelectedFYs]       = useState([])
  const [infoOpen, setInfoOpen]             = useState(false)

  // Only the newest demographic fetch may commit its result. Clicking FY pills
  // in quick succession starts overlapping fetches, and the earlier (smaller,
  // but not necessarily faster) one could resolve last and overwrite the newer
  // one — the just-added year then rendered as 0 students in a grant report.
  const loadSeq = useRef(0)

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
    setPeriodRows(all)
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
    // Clearing the selection also supersedes any fetch still in flight, so it
    // can't repopulate the tables after the user emptied them.
    if (orderedFYs.length === 0) {
      loadSeq.current++
      setEnrollments([]); setError(null); setLoading(false)
      return
    }
    loadData(orderedFYs)
  }, [fyKey])

  async function loadData(fys) {
    const seq = ++loadSeq.current
    setLoading(true)
    setError(null)
    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await supabase
        .from('enrollments')
        .select(`
          customer_id, fiscal_year, discount_type,
          events(course_name, class_start_date),
          students(birthdate, ethnicity, gender, household_income)
        `)
        .in('fiscal_year', fys)
        .range(from, from + PAGE - 1)
      if (seq !== loadSeq.current) return          // superseded mid-fetch
      if (error) { setError(error.message); setLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }
    if (seq !== loadSeq.current) return
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

  // Years where sliding-scale/merit students were dropped for unconfirmable age.
  const excludedNotes = fyReports.filter(f => f.report.slidingExcludedAge > 0)

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
              Grant reporting on four low-income youth cohorts. Pick one or more fiscal years; each
              cohort gets a table of <strong>unique students</strong> broken down by{' '}
              <strong>household income</strong>, <strong>ethnicity</strong> and{' '}
              <strong>gender</strong>, followed by a <strong>Combined</strong> table that
              de-duplicates students across all four cohorts (a student in two cohorts is counted
              once in Combined). Every enrollment in the database qualifies — only ENROLLED and PEND
              statuses are imported.
            </p>
            <div className="ugcb-info-section-title">Groups</div>
            <p>
              Students are counted once per fiscal year (unique by enrolled/pending enrollment) in
              each group they qualify for. A student may appear in more than one group.
            </p>
            <ul>
              <li><strong>Sliding-Scale &amp; Merit Youth</strong> — students aged 4–18 with at least
                one enrollment carrying a sliding-scale child discount (any <code>Child&lt;NN&gt;</code>
                code, including the older Mission/Richmond satellite variants) <em>or</em> a Merit
                scholarship (any code containing "Merit"). Age is measured at the enrollment's class
                start date; students whose age can't be confirmed 4–18 (missing or placeholder
                birthdate, or a section carrying ASAP's far-future 2050-01-01 placeholder start
                date) are excluded and counted separately below.</li>
              <li><strong>YMP</strong> — students enrolled in Young Musicians Program / Saturday Play!
                (Ensemble or Theory) or Mission District YMP / Saturday Play!.</li>
              <li><strong>Children's Chorus</strong> and <strong>Teen Jazz Orchestra</strong> —
                students enrolled in the class of that name.</li>
            </ul>
            <div className="ugcb-info-section-title">The three breakdowns</div>
            <p>
              Categories and percentage bases match the Demographics report exactly — they come from
              one shared definitions file, so a relabelling in ASAP is absorbed in one place and this
              report cannot drift from Demographics. Each student's ethnicity is the single value
              coalesced from ASAP's three ethnicity columns on upload; Hispanic and Latinx are merged
              to Hispanic/Latinx, the Pacific Islander spellings merge to Native Hawaiian or Other
              Pacific Islander, and the trans gender labels merge to Transgender.
            </p>
            <p>
              <strong>Each dimension has its own percentage base</strong>, shown on that dimension's
              header row as "of <em>N</em>" for every year. Ethnicity and gender percentages are out
              of the students who <strong>responded</strong> ("No Response" is counted and shown but
              excluded from the base). Household income percentages are out of the students who{' '}
              <strong>named a bracket</strong> — both "No Response" <em>and</em> "Decline to State"
              are excluded there, so a rising number of decliners can't drag the low-income share
              down. Excluded categories keep their count and show "—" instead of a percentage, and
              the categories that do get a percentage sum to 100% of that base.
            </p>
            <p>
              <strong>Read income against its base.</strong> The base is narrow in these cohorts and
              varies a lot by group — in FY26 it was 110 of 220 Sliding-Scale students but only 9 of
              34 Children's Chorus students. A "100.0% Low" cell means 100% of the students who named
              a bracket, not 100% of the group. Note too that the Sliding-Scale figure is close to
              circular: qualifying for a sliding-scale or Merit discount is itself an income test, so
              that group reports 100.0% Low in every year on file. YMP is the group with real
              variation (97.6% → 93.9% → 91.3% → 88.9% across FY23–FY26).
            </p>
            <p>
              <strong>Gender is thinly answered in these cohorts</strong> — far more thinly than
              ethnicity. In FY26, 135 of 220 Sliding-Scale students and 196 of 354 Combined students
              are "No Response", so the gender percentages speak for a minority of each group. Read
              them next to the No Response row.
            </p>
            <p>
              Category rows are the union across the selected years — a category present in only one
              year still gets a row, showing 0 in the others. Income rows stay in fixed logical
              order; ethnicity and gender rows are ordered by total students across the selected
              years, with "No Response" last.
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
              In a Δ column the top line is the change in students and the bottom line is the change in
              share: a percent change for the <em>Unique students</em> row, and{' '}
              <strong>percentage points (pp)</strong> for category rows, since a category can grow in
              headcount while shrinking as a share of the group. Categories excluded from a base have
              no share, so their second line shows "—". Dimension header rows show only the change in
              the base headcount.
            </p>
            <p>
              <strong>Reading pp shifts:</strong> the No Response count has fallen steadily year over
              year as demographic collection improved. Because percentages are taken out of the
              responding students only, part of any share movement reflects a larger response base
              rather than a changed student mix — check the base on the dimension header and the
              No Response row before attributing a pp shift to a real demographic change.
            </p>
            <div className="ugcb-info-section-title">Export</div>
            <p>
              <strong>Export CSV</strong> produces one file covering every group plus Combined: a row
              per group, dimension and category — including a row carrying each dimension's
              percentage base — with a count and % column for each selected year, then Δ count and
              Δ "% / pp" columns between consecutive years.
            </p>
          </div>
        )}
      </div>

      {fyPeriods.length === 0 ? (
        <p className="coming-soon">No enrollment data yet. Upload reports to get started.</p>
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
              Select one or more fiscal years above to view the report. Selecting several compares them
              side by side.
            </p>
          ) : (
            <>
              <div className="pig-roster-header">
                <span className="pig-roster-title">
                  Low-Income Youth Program — {orderedFYs.join(' · ')}
                </span>
                <button className="btn-secondary" onClick={() => exportCSV(units, orderedFYs)}>
                  Export CSV
                </button>
              </div>

              {excludedNotes.length > 0 && (
                <div className="pig-methodology" style={{ marginTop: 0 }}>
                  <p style={{ margin: 0 }}>
                    <strong>Note:</strong> students with a sliding-scale or Merit discount whose age
                    couldn't be confirmed as 4–18 (missing or placeholder birthdate) are excluded from
                    the Sliding-Scale &amp; Merit Youth group
                    {' — '}
                    {excludedNotes.map(f => `${f.fy}: ${f.report.slidingExcludedAge}`).join(', ')}.
                  </p>
                </div>
              )}

              {units.map(u => <UnitCard key={u.id} unit={u} fys={orderedFYs} />)}
            </>
          )}
        </>
      )}
    </div>
  )
}
