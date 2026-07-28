import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { fySortKey } from '../utils/periodUtils'

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

const NO_RESPONSE = 'No Response'

// Ethnicity labels that name the same group and report as one category
// (kept identical to the Demographics report).
const ETHNICITY_ALIASES = {
  'hispanic': 'Hispanic/Latinx',
  'latinx':   'Hispanic/Latinx',
}

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
function ageAtDate(birthdateStr, referenceDateStr) {
  if (!birthdateStr || !referenceDateStr) return null
  const [by, bm, bd] = birthdateStr.split('-').map(Number)
  const [ry, rm, rd] = referenceDateStr.split('-').map(Number)
  let age = ry - by
  if (rm < bm || (rm === bm && rd < bd)) age--
  return age
}

// Ethnicity label with Hispanic/Latinx aliases merged, mirroring Demographics.
function ethnicityLabelFor(raw) {
  const v = String(raw ?? '').trim()
  if (v === '') return NO_RESPONSE
  return ETHNICITY_ALIASES[v.toLowerCase()] ?? v
}

// ─────────────────────────────────────────────────────────────────────────────
// Ethnicity breakdown (descending count, No Response last; percentages out of
// the responded base, matching the Demographics report)
// ─────────────────────────────────────────────────────────────────────────────

function ethnicityBreakdown(studentsMap) {
  const total = studentsMap.size
  const counts = {}
  for (const s of studentsMap.values()) {
    const label = ethnicityLabelFor(s.ethnicity)
    counts[label] = (counts[label] ?? 0) + 1
  }
  const base = total - (counts[NO_RESPONSE] ?? 0)
  return {
    total,
    buckets: Object.entries(counts)
      .sort(([la, ca], [lb, cb]) => {
        if (la === NO_RESPONSE) return 1
        if (lb === NO_RESPONSE) return -1
        return cb - ca || la.localeCompare(lb)
      })
      .map(([label, count]) => ({
        label,
        count,
        pct: label === NO_RESPONSE || base === 0 ? null : (count / base) * 100,
      })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core aggregation
// ─────────────────────────────────────────────────────────────────────────────

function buildReport(enrollments) {
  // Per-group accumulators (customer_id → { ethnicity })
  const acc = {}
  for (const g of GROUPS) acc[g.id] = { students: new Map() }
  const slidingSeen     = new Set()  // any customer with a sliding-scale or merit discount, any age
  const combinedStudents = new Map() // deduped union across all four groups

  function addMember(groupId, cid, student) {
    const a = acc[groupId]
    if (!a.students.has(cid)) a.students.set(cid, { ethnicity: student.ethnicity ?? null })
    else if (a.students.get(cid).ethnicity == null && student.ethnicity != null) {
      a.students.get(cid).ethnicity = student.ethnicity
    }
    if (!combinedStudents.has(cid)) combinedStudents.set(cid, { ethnicity: student.ethnicity ?? null })
    else if (combinedStudents.get(cid).ethnicity == null && student.ethnicity != null) {
      combinedStudents.get(cid).ethnicity = student.ethnicity
    }
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
      const age = ageAtDate(student.birthdate, e.events?.class_start_date)
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
  const slidingExcludedAge = [...slidingSeen].filter(cid => !acc.sliding.students.has(cid)).length

  const groups = GROUPS.map(g => ({
    ...g,
    uniqueStudents: acc[g.id].students.size,
    ethnicity:      ethnicityBreakdown(acc[g.id].students),
  }))

  return {
    groups,
    slidingExcludedAge,
    combined: {
      uniqueStudents: combinedStudents.size,
      ethnicity:      ethnicityBreakdown(combinedStudents),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function exportCSV(report, fy) {
  const units = [
    ...report.groups.map(g => ({
      label: g.title,
      students: g.uniqueStudents,
      ethnicity: g.ethnicity,
    })),
    {
      label: 'Combined (unique across all groups)',
      students: report.combined.uniqueStudents,
      ethnicity: report.combined.ethnicity,
    },
  ]

  // Dynamic ethnicity columns: union across units, in Combined's order.
  const seen = new Set(), ethCols = []
  for (const u of [units[units.length - 1], ...units]) {
    for (const b of u.ethnicity.buckets) if (!seen.has(b.label)) { seen.add(b.label); ethCols.push(b.label) }
  }

  const headers = ['Group', 'Unique Students']
  for (const c of ethCols) headers.push(`Ethnicity ${c} Count`, `Ethnicity ${c} %`)

  const rows = units.map(u => {
    const map = {}
    for (const b of u.ethnicity.buckets) map[b.label] = b
    const row = [u.label, u.students]
    for (const c of ethCols) {
      const b = map[c]
      row.push(b?.count ?? 0, b?.pct == null ? '' : b.pct.toFixed(1))
    }
    return row
  })

  triggerDownload(
    [headers, ...rows].map(r => r.map(esc).join(',')).join('\n'),
    `liyp-${fy}-${today()}.csv`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation
// ─────────────────────────────────────────────────────────────────────────────

function EthnicityCard({ breakdown }) {
  return (
    <div className="demo-dim">
      <div className="demo-dim-title">Ethnicity</div>
      {breakdown.total === 0 ? (
        <p className="coming-soon" style={{ padding: '8px 0' }}>No students.</p>
      ) : (
        <table className="demo-dim-table">
          <tbody>
            {breakdown.buckets.map(b => (
              <tr key={b.label}>
                <td className="demo-dim-label">{b.label}</td>
                <td className="demo-dim-count">{b.count.toLocaleString()}</td>
                <td className="demo-dim-pct">{b.pct === null ? '—' : `${b.pct.toFixed(1)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function GroupCard({ group }) {
  return (
    <div className="liyp-group-card">
      <div className="pig-roster-header">
        <span className="pig-roster-title">{group.title}</span>
      </div>
      <div className="pig-summary">
        <div className="pig-stat-card pig-stat-card--accent">
          <div className="pig-stat-value">{group.uniqueStudents.toLocaleString()}</div>
          <div className="pig-stat-label">Unique students</div>
        </div>
      </div>
      <div className="demo-dims">
        <EthnicityCard breakdown={group.ethnicity} />
      </div>
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
  const [selectedFY, setSelectedFY]         = useState(null)
  const [infoOpen, setInfoOpen]             = useState(false)

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

  useEffect(() => {
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
          customer_id, discount_type,
          events(course_name, class_start_date),
          students(birthdate, ethnicity)
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

  const report = useMemo(() => buildReport(enrollments), [enrollments])

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
                birthdate) are excluded and counted separately below.</li>
              <li><strong>YMP</strong> — students enrolled in Young Musicians Program / Saturday Play!
                (Ensemble or Theory) or Mission District YMP / Saturday Play!.</li>
              <li><strong>Children's Chorus</strong> and <strong>Teen Jazz Orchestra</strong> —
                students enrolled in the class of that name.</li>
            </ul>
            <div className="ugcb-info-section-title">Ethnicity</div>
            <p>
              Categories match the Demographics report (Hispanic and Latinx merged to Hispanic/Latinx).
              Percentages are out of students who gave a response; "No Response" is shown but excluded
              from the percentage base.
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
              <span className="period-selector-title">Select Fiscal Year</span>
              {selectedFY && (
                <button className="period-clear-btn" onClick={() => setSelectedFY(null)}>Clear</button>
              )}
            </div>
            <div className="period-pills">
              {fyPeriods.map(fy => (
                <button
                  key={fy}
                  className={`period-pill${selectedFY === fy ? ' active' : ''}`}
                  onClick={() => setSelectedFY(prev => prev === fy ? null : fy)}
                >
                  {fy}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <p className="coming-soon">Loading…</p>
          ) : !selectedFY ? (
            <p className="coming-soon">Select a fiscal year above to view the report.</p>
          ) : (
            <>
              <div className="pig-roster-header">
                <span className="pig-roster-title">
                  Low-Income Youth Program — {selectedFY} · {report.combined.uniqueStudents.toLocaleString()} unique students across all groups
                </span>
                <button className="btn-secondary" onClick={() => exportCSV(report, selectedFY)}>
                  Export CSV
                </button>
              </div>

              {report.slidingExcludedAge > 0 && (
                <div className="pig-methodology" style={{ marginTop: 0 }}>
                  <p style={{ margin: 0 }}>
                    <strong>Note:</strong> {report.slidingExcludedAge} student
                    {report.slidingExcludedAge !== 1 ? 's' : ''} with a sliding-scale or Merit discount
                    {report.slidingExcludedAge !== 1 ? ' were' : ' was'} excluded from the Sliding-Scale
                    &amp; Merit Youth group because their age couldn't be confirmed as 4–18 (missing or
                    placeholder birthdate).
                  </p>
                </div>
              )}

              {report.groups.map(g => <GroupCard key={g.id} group={g} />)}

              {/* Combined summary */}
              <div className="liyp-group-card">
                <div className="pig-roster-header">
                  <span className="pig-roster-title">Combined — unique students across all groups</span>
                </div>
                <div className="pig-summary">
                  <div className="pig-stat-card pig-stat-card--accent">
                    <div className="pig-stat-value">{report.combined.uniqueStudents.toLocaleString()}</div>
                    <div className="pig-stat-label">Unique students (de-duplicated)</div>
                  </div>
                </div>
                <div className="demo-dims">
                  <EthnicityCard breakdown={report.combined.ethnicity} />
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
