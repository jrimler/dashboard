import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  parseQuarter, quarterFYLabel,
  quarterSortKey, fySortKey, periodSortKey,
  fyRange, periodLabel,
} from '../utils/periodUtils'

// ─────────────────────────────────────────────────────────────────────────────
// Preceding quarter sort key
// Sort key = quarterFY(season, year) * 10 + SEASON_ORDER[season]
// Consecutive FY order: Summer(1) → Fall(2) → Winter(3) → Spring(4)
//   Summer Q Y  key=(Y+1)*10+1  ← preceded by Spring Q Y   key=Y*10+4
//   Fall   Q Y  key=(Y+1)*10+2  ← preceded by Summer Q Y   key=(Y+1)*10+1
//   Winter Q Y  key=Y*10+3      ← preceded by Fall Q Y-1   key=Y*10+2
//   Spring Q Y  key=Y*10+4      ← preceded by Winter Q Y   key=Y*10+3
// ─────────────────────────────────────────────────────────────────────────────

function precedingQuarterSortKey(timePeriod) {
  const q = parseQuarter(timePeriod)
  if (!q) return null
  const { season, year } = q
  switch (season) {
    case 'Summer': return year * 10 + 4          // Spring (year)
    case 'Fall':   return (year + 1) * 10 + 1    // Summer (year)
    case 'Winter': return year * 10 + 2          // Fall (year-1), same quarterFY
    case 'Spring': return year * 10 + 3          // Winter (year)
    default:       return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Student classification for one period
// Returns { period, total, new, continuing, returning }
// continuing is null when no preceding quarter data exists in the DB
// ─────────────────────────────────────────────────────────────────────────────

function classifyPeriod(period, allCustomerPeriods, firstKey, allSortKeys) {
  const isQuarter = period.type === 'quarter'
  let minKey, maxKey
  const periodCids = new Set()

  if (isQuarter) {
    const qKey = quarterSortKey(period.value)
    minKey = maxKey = qKey
    for (const r of allCustomerPeriods) {
      if (r.qSortKey === qKey && r.cid) periodCids.add(r.cid)
    }
  } else {
    ;[minKey, maxKey] = fyRange(period.value)
    for (const r of allCustomerPeriods) {
      if (r.qSortKey >= minKey && r.qSortKey <= maxKey && r.cid) periodCids.add(r.cid)
    }
  }

  const total = periodCids.size

  // New: first-ever enrollment falls within this period
  let newCount = 0
  for (const cid of periodCids) {
    const k = firstKey[cid]
    if (k !== undefined && k >= minKey && k <= maxKey) newCount++
  }

  // Continuing: not new, AND appeared in the immediately preceding quarter.
  // Only computed for quarter periods where preceding quarter exists in the data.
  let continuing = null
  if (isQuarter) {
    const precKey = precedingQuarterSortKey(period.value)
    if (precKey !== null && allSortKeys.has(precKey)) {
      const precCids = new Set()
      for (const r of allCustomerPeriods) {
        if (r.qSortKey === precKey && r.cid) precCids.add(r.cid)
      }
      continuing = 0
      for (const cid of periodCids) {
        const k = firstKey[cid]
        const isNew = k !== undefined && k >= minKey && k <= maxKey
        if (!isNew && precCids.has(cid)) continuing++
      }
    }
  }

  // Returning: in this period, not new, not continuing (lapsed then came back)
  const returning = total - newCount - (continuing ?? 0)

  return { period, total, new: newCount, continuing, returning }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function esc(v) { return `"${String(v ?? '').replace(/"/g, '""')}"` }

function exportCSV(reportData) {
  const headers = ['Category']
  reportData.forEach(pd => headers.push(`${pd.period.value} — Students`))
  for (let i = 0; i < reportData.length - 1; i++) {
    const a = reportData[i].period.value, b = reportData[i + 1].period.value
    headers.push(`Δ ${a}→${b}`, 'Δ %')
  }

  const ROWS = [
    { label: 'Total Students', fn: pd => pd.total },
    { label: 'New',            fn: pd => pd.new },
    { label: 'Continuing',     fn: pd => pd.continuing },
    { label: 'Returning',      fn: pd => pd.returning },
  ]

  const lines = [headers.map(esc).join(',')]
  for (const row of ROWS) {
    const cells = [row.label]
    reportData.forEach(pd => cells.push(row.fn(pd) ?? ''))
    for (let i = 0; i < reportData.length - 1; i++) {
      const a = row.fn(reportData[i])
      const b = row.fn(reportData[i + 1])
      if (a == null || b == null) {
        cells.push('', '')
      } else {
        const raw = b - a
        cells.push(
          raw > 0 ? `+${raw}` : raw,
          a === 0 ? '—' : `${(raw / a * 100).toFixed(1)}%`
        )
      }
    }
    lines.push(cells.map(esc).join(','))
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  Object.assign(document.createElement('a'), { href: url, download: `cmc-retention-${new Date().toISOString().slice(0, 10)}.csv` }).click()
  URL.revokeObjectURL(url)
}

// ─────────────────────────────────────────────────────────────────────────────
// Delta helpers (same pattern as Enrollment)
// ─────────────────────────────────────────────────────────────────────────────

function computeDelta(a, b) {
  const raw = b - a
  return { raw, pct: a === 0 ? null : (raw / a * 100) }
}

function fmtDelta(raw, pct) {
  const sign = raw > 0 ? '+' : ''
  const pctStr = pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`
  return `${sign}${raw.toLocaleString()} / ${pctStr}`
}

function deltaClass(raw) {
  if (raw > 0) return 'pos'
  if (raw < 0) return 'neg'
  return 'zero'
}

// ─────────────────────────────────────────────────────────────────────────────
// Period selector (same pattern as Enrollment)
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
// Report table
// ─────────────────────────────────────────────────────────────────────────────

const REPORT_ROWS = [
  { key: 'total',      label: 'Total Students', top: true,  fn: pd => pd.total },
  { key: 'new',        label: 'New',            top: false, fn: pd => pd.new },
  { key: 'continuing', label: 'Continuing',     top: false, fn: pd => pd.continuing },
  { key: 'returning',  label: 'Returning',      top: false, fn: pd => pd.returning },
]

function ReportTable({ reportData }) {
  const cols = []
  reportData.forEach((pd, i) => {
    cols.push({ type: 'period', pd })
    if (i < reportData.length - 1) cols.push({ type: 'delta', a: pd, b: reportData[i + 1] })
  })

  return (
    <table className="report-table">
      <thead>
        <tr>
          <th className="rt-label-hdr">Category</th>
          {cols.map((col, i) =>
            col.type === 'period' ? (
              <th key={i} className="rt-period-hdr" title={col.pd.period.value}>
                <div className="rt-period-name">{periodLabel(col.pd.period)}</div>
                <div className="rt-period-sub">Students</div>
              </th>
            ) : (
              <th key={i} className="rt-delta-hdr">Δ</th>
            )
          )}
        </tr>
      </thead>
      <tbody>
        {REPORT_ROWS.map(row => (
          <tr key={row.key} className={row.top ? 'rt-row rt-top-row' : 'rt-row rt-sub-row'}>
            <td className="rt-label">{row.label}</td>
            {cols.map((col, ci) => {
              if (col.type === 'period') {
                const val = row.fn(col.pd)
                if (val === null) {
                  // Continuing with no preceding quarter — omit this cell
                  return (
                    <td key={ci} className="rt-period-cell">
                      <div className="cell-enr">—</div>
                    </td>
                  )
                }
                const pct = row.key !== 'total' && col.pd.total > 0
                  ? (val / col.pd.total * 100)
                  : null
                return (
                  <td key={ci} className="rt-period-cell">
                    <div className="cell-enr">{val.toLocaleString()}</div>
                    {pct !== null && <div className="cell-stu">{pct.toFixed(1)}%</div>}
                  </td>
                )
              }
              // Delta cell
              const aVal = row.fn(col.a)
              const bVal = row.fn(col.b)
              if (aVal === null || bVal === null) {
                return (
                  <td key={ci} className="rt-delta-cell">
                    <div className="delta-line zero">—</div>
                  </td>
                )
              }
              const d = computeDelta(aVal, bVal)
              return (
                <td key={ci} className="rt-delta-cell">
                  <div className={`delta-line ${deltaClass(d.raw)}`}>
                    {fmtDelta(d.raw, d.pct)}
                  </div>
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function Retention() {
  const [allCustomerPeriods, setAllCustomerPeriods] = useState([])
  const [periodsLoading, setPeriodsLoading]         = useState(true)
  const [error, setError]                           = useState(null)
  const [selected, setSelected]                     = useState([])

  useEffect(() => { loadPeriods() }, [])

  async function loadPeriods() {
    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await supabase
        .from('enrollments')
        .select('customer_id, time_period, fiscal_year')
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setPeriodsLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }
    setAllCustomerPeriods(all.map(e => ({
      cid:        e.customer_id,
      timePeriod: e.time_period,
      fiscalYear: e.fiscal_year,
      qSortKey:   quarterSortKey(e.time_period),
    })))
    setPeriodsLoading(false)
  }

  const { fyPeriods, quarterGroups } = useMemo(() => {
    const qSet = new Set(), fySet = new Set()
    for (const r of allCustomerPeriods) {
      if (r.timePeriod) qSet.add(r.timePeriod)
      if (r.fiscalYear) fySet.add(r.fiscalYear)
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
  }, [allCustomerPeriods])

  // Per-customer earliest quarter (global, for New/Returning accuracy)
  const firstKey = useMemo(() => {
    const map = {}
    for (const r of allCustomerPeriods) {
      if (!r.cid || r.qSortKey === 99999) continue
      if (map[r.cid] === undefined || r.qSortKey < map[r.cid]) map[r.cid] = r.qSortKey
    }
    return map
  }, [allCustomerPeriods])

  // Set of all quarter sort keys present in the DB (to check if preceding quarter exists)
  const allSortKeys = useMemo(() => {
    const s = new Set()
    for (const r of allCustomerPeriods) {
      if (r.qSortKey !== 99999) s.add(r.qSortKey)
    }
    return s
  }, [allCustomerPeriods])

  const columns = useMemo(
    () => [...selected].sort((a, b) => periodSortKey(a) - periodSortKey(b)),
    [selected]
  )

  const reportData = useMemo(
    () => columns.map(p => classifyPeriod(p, allCustomerPeriods, firstKey, allSortKeys)),
    [columns, allCustomerPeriods, firstKey, allSortKeys]
  )

  function toggle(p) {
    setSelected(prev => {
      const has = prev.some(x => x.type === p.type && x.value === p.value)
      return has
        ? prev.filter(x => !(x.type === p.type && x.value === p.value))
        : [...prev, p]
    })
  }
  const isSelected = p => selected.some(x => x.type === p.type && x.value === p.value)

  if (periodsLoading) return <div className="page"><p className="coming-soon">Loading…</p></div>
  if (error)          return <div className="page"><div className="error-banner">{error}</div></div>

  const hasData = fyPeriods.length > 0 || quarterGroups.length > 0

  return (
    <div className="page enroll-page">
      <div className="enroll-header">
        <h1>Retention</h1>
        {columns.length > 0 && (
          <button className="btn-secondary" onClick={() => exportCSV(reportData)}>
            Export CSV
          </button>
        )}
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

          {columns.length === 0 ? (
            <p className="coming-soon">Select one or more periods above to view the report.</p>
          ) : (
            <div className="report-scroll">
              <ReportTable reportData={reportData} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
