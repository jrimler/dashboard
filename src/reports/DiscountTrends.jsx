import { Fragment, useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { fySortKey } from '../utils/periodUtils'

// ─────────────────────────────────────────────────────────────────────────────
// Discount families
//
// ASAP relabels discount codes nearly every term — 308 distinct spellings across
// FY23–FY26 — but they describe a much smaller set of standing programs. These
// ordered rules collapse the spellings into families; the FIRST match wins, so
// order matters (Merit before the branch-prefixed satellite codes, MDYMP before
// the generic YMP token).
//
// Anything that matches no rule lands in an "Unmatched" row rather than being
// dropped, so a new ASAP label shows up as a number someone can act on instead
// of silently deflating a family. Same principle as INCOME_MAP in Demographics.
// ─────────────────────────────────────────────────────────────────────────────

const FAMILY_RULES = [
  // Sliding scale. Tier number encodes the discount depth; the year suffix
  // (_2023, _2024-2025, _2026-2027) marks which rate schedule was in force, and
  // the FY23 spellings additionally carry a Mission/Richmond branch prefix.
  ['Sliding Scale — Youth', /(?:^|[ _])Child\d+/i],
  ['Sliding Scale — Adult', /(?:^|[ _])Adult\d+/i],

  ['Merit Scholarship',     /merit/i],

  // Mission District YMP is a different class but part of the YMP umbrella, so
  // both rules land in one family.
  ['YMP',                   /MDYMP/i],
  ['YMP',                   /(?:^|[ _])YMP/i],

  // YMP students who pay rather than hold a scholarship. Related to YMP but
  // deliberately kept separate — folding it in would hide the paying share.
  ['CMP (fee-paying YMP)',  /(?:^|[ _])CMP(?:[ _-]|$)/i],

  ['Seniors',               /senior/i],
  ['Faculty / Staff',       /fac(?:ulty)?[ _/]*staff|Fac\d*%/i],
  ['Family $3',             /family \$3/i],
  ['Multiple Classes',      /multi/i],
  ['SFUSD Teacher',         /SFUSD/i],
  ['Promotions',            /open house|refer a friend|promo|survey|PTA|friend of CMC|music for children/i],
  ["Children's Chorus",     /chorus/i],
]

// Codes deliberately left out of the report (one-off or non-program codes).
// Excluded rather than unmatched so the Unmatched row keeps meaning "a code
// nobody has classified yet".
const EXCLUDED_RULES = [
  /^FMS Pay/i,
  /^Bebop!/i,
  /30th Street OAC/i,
]

const UNMATCHED = 'Unmatched'

function familyOf(code) {
  if (EXCLUDED_RULES.some(re => re.test(code))) return null
  const hit = FAMILY_RULES.find(([, re]) => re.test(code))
  return hit ? hit[0] : UNMATCHED
}

// Sub-label shown when a family row is expanded. Sliding-scale codes collapse to
// their tier so the mix across tiers is readable; everything else keeps the raw
// ASAP code, which is what makes rate changes visible (Seniors 30% → 20%).
function subgroupOf(family, code) {
  if (family.startsWith('Sliding Scale')) {
    const m = code.match(/(?:^|[ _])(Child|Adult)(\d+)/i)
    if (m) return `Tier ${m[2]}`
  }
  return code
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

// ASAP writes an empty discount as blank, a single space, or the literal "0".
function normCode(raw) {
  const v = String(raw ?? '').trim()
  if (v === '' || v === '0') return null
  return v
}

function fmtCount(n) { return `${n > 0 ? '+' : ''}${n.toLocaleString()}` }

function fmtPct(pct) {
  if (pct === null) return '—'
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`
}

function deltaClass(raw) {
  if (raw > 0) return 'pos'
  if (raw < 0) return 'neg'
  return 'zero'
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation
//
// Two metrics per family per fiscal year:
//   students     — unique customer_ids who received any code in the family
//   enrollments  — enrollment rows the codes were applied to
// Unique students is the comparable measure across years; enrollments track
// billing practice as much as reality (YMP jumped 124 → 341 enrollments from
// FY23 to FY24 while unique students went 46 → 48, purely because
// "YMP - 100% Group" started being applied per enrollment).
// ─────────────────────────────────────────────────────────────────────────────

function buildTrends(enrollments, fys) {
  const fyIndex = new Map(fys.map((fy, i) => [fy, i]))
  const blank = () => ({ students: fys.map(() => new Set()), apps: fys.map(() => 0) })

  const families = new Map()   // family → { totals, subgroups: Map }
  const anyDiscount = fys.map(() => new Set())
  const allStudents = fys.map(() => new Set())
  const allEnrollments = fys.map(() => 0)
  const unmatchedCodes = new Map()  // code → enrollments

  for (const e of enrollments) {
    const i = fyIndex.get(e.fiscal_year)
    if (i === undefined) continue
    const cid = e.customer_id

    if (cid) allStudents[i].add(cid)
    allEnrollments[i] += 1

    const code = normCode(e.discount_type)
    if (!code) continue
    const family = familyOf(code)
    if (family === null) continue   // deliberately excluded code

    if (family === UNMATCHED) unmatchedCodes.set(code, (unmatchedCodes.get(code) ?? 0) + 1)

    let f = families.get(family)
    if (!f) { f = { totals: blank(), subgroups: new Map() }; families.set(family, f) }
    f.totals.apps[i] += 1
    if (cid) { f.totals.students[i].add(cid); anyDiscount[i].add(cid) }

    const sub = subgroupOf(family, code)
    let s = f.subgroups.get(sub)
    if (!s) { s = blank(); f.subgroups.set(sub, s) }
    s.apps[i] += 1
    if (cid) s.students[i].add(cid)
  }

  const sized = ({ students, apps }) => ({
    students: students.map(s => s.size),
    apps,
  })

  const rows = [...families.entries()]
    .map(([family, f]) => ({
      family,
      ...sized(f.totals),
      subRows: [...f.subgroups.entries()]
        .map(([label, s]) => ({ label, ...sized(s) }))
        .sort((a, b) => sum(b.students) - sum(a.students) || a.label.localeCompare(b.label)),
    }))
    // Unmatched always sits last; everything else by size.
    .sort((a, b) => {
      if (a.family === UNMATCHED) return 1
      if (b.family === UNMATCHED) return -1
      return sum(b.students) - sum(a.students)
    })

  return {
    rows,
    anyDiscount: { students: anyDiscount.map(s => s.size), apps: rows.reduce((acc, r) => acc.map((v, i) => v + r.apps[i]), fys.map(() => 0)) },
    allStudents: { students: allStudents.map(s => s.size), apps: allEnrollments },
    unmatchedCodes: [...unmatchedCodes.entries()].sort((a, b) => b[1] - a[1]),
  }
}

function sum(arr) { return arr.reduce((a, b) => a + b, 0) }

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function exportCSV(trends, fys, metric) {
  const headers = ['Level', 'Family', 'Detail']
  for (const fy of fys) headers.push(fy)
  for (let i = 0; i < fys.length - 1; i++) {
    headers.push(`Δ ${fys[i]}→${fys[i + 1]}`, `Δ ${fys[i]}→${fys[i + 1]} %`)
  }

  const line = (level, family, detail, values) => {
    const cells = [level, family, detail, ...values]
    for (let i = 0; i < values.length - 1; i++) {
      const raw = values[i + 1] - values[i]
      const pct = values[i] === 0 ? '' : ((raw / values[i]) * 100).toFixed(1)
      cells.push(raw, pct)
    }
    return cells
  }

  const pick = r => (metric === 'students' ? r.students : r.apps)
  const rows = []
  for (const r of trends.rows) {
    rows.push(line('Family', r.family, '', pick(r)))
    for (const s of r.subRows) rows.push(line('Detail', r.family, s.label, pick(s)))
  }
  rows.push(line('Summary', 'Any discount (de-duplicated)', '', pick(trends.anyDiscount)))
  rows.push(line('Summary', 'All enrolled', '', pick(trends.allStudents)))

  triggerDownload(
    [headers, ...rows].map(r => r.map(esc).join(',')).join('\n'),
    `discount-trends-${metric}-${fys.join('_')}-${today()}.csv`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation
// ─────────────────────────────────────────────────────────────────────────────

function DeltaCell({ a, b }) {
  const raw = b - a
  const pct = a === 0 ? null : (raw / a) * 100
  return (
    <td className="rt-delta-cell">
      <div className={`delta-line ${deltaClass(raw)}`}>{fmtCount(raw)}</div>
      <div className={`delta-line ${deltaClass(raw)}`}>{fmtPct(pct)}</div>
    </td>
  )
}

function ValueRow({ label, values, cols, className, onClick, expanded, expandable }) {
  return (
    <tr className={className} onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <td className="rt-label">
        {expandable && <span className="pig-courses-chevron">{expanded ? '▾ ' : '▸ '}</span>}
        {label}
      </td>
      {cols.map((col, ci) =>
        col.type === 'fy' ? (
          <td key={ci} className="rt-period-cell">
            <div className="cell-enr">{values[col.i].toLocaleString()}</div>
          </td>
        ) : (
          <DeltaCell key={ci} a={values[col.a]} b={values[col.b]} />
        )
      )}
    </tr>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main report component
// ─────────────────────────────────────────────────────────────────────────────

export default function DiscountTrends() {
  const [periodRows, setPeriodRows]         = useState([])
  const [enrollments, setEnrollments]       = useState([])
  const [periodsLoading, setPeriodsLoading] = useState(true)
  const [loading, setLoading]               = useState(false)
  const [error, setError]                   = useState(null)
  const [selectedFYs, setSelectedFYs]       = useState([])
  const [metric, setMetric]                 = useState('students')
  const [expanded, setExpanded]             = useState({})
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

  // Default to every fiscal year on file — this report is about the trend.
  useEffect(() => {
    if (fyPeriods.length > 0 && selectedFYs.length === 0) setSelectedFYs(fyPeriods)
  }, [fyPeriods])

  const orderedFYs = useMemo(
    () => [...selectedFYs].sort((a, b) => fySortKey(a) - fySortKey(b)),
    [selectedFYs]
  )
  const fyKey = orderedFYs.join('|')

  useEffect(() => {
    if (orderedFYs.length === 0) { setEnrollments([]); setError(null); return }
    loadData(orderedFYs)
  }, [fyKey])

  async function loadData(fys) {
    setLoading(true)
    setError(null)
    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await supabase
        .from('enrollments')
        .select('customer_id, fiscal_year, discount_type')
        .in('fiscal_year', fys)
        .order('event_enrollment_id')
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }
    setEnrollments(all)
    setLoading(false)
  }

  const trends = useMemo(() => buildTrends(enrollments, orderedFYs), [enrollments, fyKey])

  const cols = useMemo(() => {
    const c = []
    orderedFYs.forEach((fy, i) => {
      c.push({ type: 'fy', fy, i })
      if (i < orderedFYs.length - 1) c.push({ type: 'delta', a: i, b: i + 1 })
    })
    return c
  }, [fyKey])

  const pick = r => (metric === 'students' ? r.students : r.apps)

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
              How each kind of discount has grown or shrunk across fiscal years. ASAP relabels
              discount codes nearly every term — 308 distinct spellings across FY23–FY26 — so codes
              are collapsed into <strong>families</strong> that represent the standing programs.
              Click any family to see the individual codes behind it.
            </p>

            <div className="ugcb-info-section-title">How codes become families</div>
            <p>
              Each code is tested against an ordered list of patterns and joins the first family it
              matches. <strong>Sliding Scale</strong> splits Youth (<code>Child&lt;NN&gt;</code>) from
              Adult (<code>Adult&lt;NN&gt;</code>); expanding either shows the tier, where the number
              is the discount depth. <strong>YMP</strong> includes Mission District YMP, a different
              class under the same umbrella. <strong>CMP</strong> is kept separate: those are YMP
              students who pay rather than hold a scholarship, so folding it into YMP would hide the
              paying share. The remaining families — Merit Scholarship, Seniors, Faculty / Staff,
              Family $3, Multiple Classes, SFUSD Teacher, Promotions, Children's Chorus — match on
              the obvious keyword.
            </p>
            <p>
              A code matching no pattern lands in <strong>Unmatched</strong> rather than being
              dropped, so a newly invented ASAP label shows up as a number to act on instead of
              silently deflating a family. Expand that row to see the codes; the fix is a new pattern
              in <code>src/reports/DiscountTrends.jsx</code>. Three known one-offs are deliberately
              excluded from the report entirely: <em>FMS Pay</em>, <em>Bebop!</em>, and{' '}
              <em>30th Street OAC</em>. An enrollment counts as having no discount when the field is
              blank, a single space, or the literal "0" — all three are ASAP's way of writing empty.
            </p>

            <div className="ugcb-info-section-title">Unique students vs. enrollments</div>
            <p>
              <strong>Unique students</strong> counts each student once per family per year, and is
              the measure to compare across years. <strong>Enrollments</strong> counts the enrollment
              rows a code was applied to, so one student taking three discounted classes counts once
              as a student and three times as enrollments. That measure tracks billing practice as
              much as reality: YMP went from 124 to 341 discounted enrollments between FY23 and FY24
              while unique students went 46 to 48, purely because <code>YMP - 100% Group</code>{' '}
              started being applied per enrollment. A student can appear in more than one family, so
              families do not sum to <em>Any discount</em>.
            </p>
            <p>
              Discount <strong>dollar amounts are deliberately not shown</strong>. The
              fully-subsidized programs record <code>$0</code> discounts inconsistently in ASAP —
              a billing-practice artifact rather than a real change in aid — so totals would
              understate them. The same reasoning removed dollar figures from the LIYP report.
            </p>

            <div className="ugcb-info-section-title">Reading the table</div>
            <p>
              One column per selected fiscal year, oldest to newest, with a <strong>Δ</strong> column
              between consecutive years showing the change and the percent change. The two summary
              rows at the bottom give <em>Any discount</em> (unique students holding at least one
              counted discount, de-duplicated across families) and <em>All enrolled</em> (every
              student with an enrollment that year), so a family can be read as a share of the whole.
              <strong> Export CSV</strong> writes every family and its detail codes on the current
              metric.
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
            <p className="coming-soon">Select one or more fiscal years above to view the trend.</p>
          ) : (
            <>
              <div className="pig-roster-header">
                <span className="pig-roster-title">
                  Discount Trends — {orderedFYs.join(' · ')}
                </span>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button
                    className={`period-pill${metric === 'students' ? ' active' : ''}`}
                    onClick={() => setMetric('students')}
                    title="Unique students per family per year"
                  >
                    Unique students
                  </button>
                  <button
                    className={`period-pill${metric === 'enrollments' ? ' active' : ''}`}
                    onClick={() => setMetric('enrollments')}
                    title="Enrollment rows a code was applied to"
                  >
                    Enrollments
                  </button>
                  <button className="btn-secondary" onClick={() => exportCSV(trends, orderedFYs, metric)}>
                    Export CSV
                  </button>
                </div>
              </div>

              <div className="report-scroll">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th className="rt-label-hdr">Discount family</th>
                      {cols.map((col, ci) =>
                        col.type === 'fy' ? (
                          <th key={ci} className="rt-period-hdr">
                            <div className="rt-period-name">{col.fy}</div>
                            <div className="rt-period-sub">
                              {metric === 'students' ? 'Students' : 'Enrollments'}
                            </div>
                          </th>
                        ) : (
                          <th key={ci} className="rt-delta-hdr">Δ</th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {trends.rows.map(r => (
                      <Fragment key={r.family}>
                        <ValueRow
                          label={r.family}
                          values={pick(r)}
                          cols={cols}
                          className="rt-row rt-top-row"
                          expandable={r.subRows.length > 1}
                          expanded={!!expanded[r.family]}
                          onClick={r.subRows.length > 1
                            ? () => setExpanded(e => ({ ...e, [r.family]: !e[r.family] }))
                            : undefined}
                        />
                        {expanded[r.family] && r.subRows.map(s => (
                          <ValueRow
                            key={`${r.family}—${s.label}`}
                            label={s.label}
                            values={pick(s)}
                            cols={cols}
                            className="rt-row rt-sub-row"
                          />
                        ))}
                      </Fragment>
                    ))}

                    <tr className="rt-section-hdr">
                      <td colSpan={1 + cols.length}>Summary</td>
                    </tr>
                    <ValueRow
                      label="Any discount (de-duplicated)"
                      values={pick(trends.anyDiscount)}
                      cols={cols}
                      className="rt-row rt-top-row"
                    />
                    <ValueRow
                      label="All enrolled"
                      values={pick(trends.allStudents)}
                      cols={cols}
                      className="rt-row rt-sub-row"
                    />
                  </tbody>
                </table>
              </div>

              {trends.unmatchedCodes.length > 0 && (
                <div className="pig-methodology">
                  <p style={{ margin: 0 }}>
                    <strong>Unclassified codes:</strong>{' '}
                    {trends.unmatchedCodes.map(([c, n]) => `${c} (${n})`).join(', ')}. Add a pattern
                    in <code>DiscountTrends.jsx</code> to fold these into a family.
                  </p>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
