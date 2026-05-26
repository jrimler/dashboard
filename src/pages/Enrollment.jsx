import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import {
  parseQuarter, quarterFY, quarterFYLabel,
  quarterSortKey, fySortKey, periodSortKey,
  fyRange, periodLabel,
} from '../utils/periodUtils'

// ─────────────────────────────────────────────────────────────────────────────
// Row definitions
// ─────────────────────────────────────────────────────────────────────────────

const M = 'Mission Branch', R = 'Richmond Branch'
const loc = v => e => e.location     === v
const act = v => e => e.activityType === v
const tfr = v => e => e.isTuitionFree === v
const and = (...fns) => e => fns.every(f => f(e))

// ROWS mixes section headers and data rows.
// DATA_ROWS filters to only data rows for computation and CSV.
const ROWS = [
  { type: 'section', label: 'All Branches' },
  { type: 'row', key: 'all_total',        top: true,  f: null,                              label: 'Total' },
  { type: 'row', key: 'all_fee',          top: false, f: tfr(false),                        label: '— Fee Based' },
  { type: 'row', key: 'all_free',         top: false, f: tfr(true),                         label: '— Tuition Free' },
  { type: 'row', key: 'all_lessons',      top: false, f: act('LESSON'),                     label: '— Lessons' },
  { type: 'row', key: 'all_group',        top: false, f: act('CLASS'),                      label: '— Group Classes' },
  { type: 'row', key: 'all_fee_lessons',  top: false, f: and(tfr(false), act('LESSON')),    label: '— Fee Based — Lessons' },
  { type: 'row', key: 'all_fee_group',    top: false, f: and(tfr(false), act('CLASS')),     label: '— Fee Based — Group Classes' },
  { type: 'row', key: 'all_free_lessons', top: false, f: and(tfr(true),  act('LESSON')),    label: '— Tuition Free — Lessons' },
  { type: 'row', key: 'all_free_group',   top: false, f: and(tfr(true),  act('CLASS')),     label: '— Tuition Free — Group Classes' },

  { type: 'section', label: 'Mission Branch' },
  { type: 'row', key: 'm_all',            top: true,  f: loc(M),                            label: 'Mission Branch — All' },
  { type: 'row', key: 'm_fee',            top: false, f: and(loc(M), tfr(false)),            label: '— Fee Based' },
  { type: 'row', key: 'm_free',           top: false, f: and(loc(M), tfr(true)),             label: '— Tuition Free' },
  { type: 'row', key: 'm_lessons',        top: false, f: and(loc(M), act('LESSON')),         label: '— Lessons' },
  { type: 'row', key: 'm_group',          top: false, f: and(loc(M), act('CLASS')),          label: '— Group Classes' },
  { type: 'row', key: 'm_fee_lessons',    top: false, f: and(loc(M), tfr(false), act('LESSON')), label: '— Fee Based — Lessons' },
  { type: 'row', key: 'm_fee_group',      top: false, f: and(loc(M), tfr(false), act('CLASS')),  label: '— Fee Based — Group Classes' },
  { type: 'row', key: 'm_free_lessons',   top: false, f: and(loc(M), tfr(true),  act('LESSON')), label: '— Tuition Free — Lessons' },
  { type: 'row', key: 'm_free_group',     top: false, f: and(loc(M), tfr(true),  act('CLASS')),  label: '— Tuition Free — Group Classes' },

  { type: 'section', label: 'Richmond Branch' },
  { type: 'row', key: 'r_all',            top: true,  f: loc(R),                            label: 'Richmond Branch — All' },
  { type: 'row', key: 'r_fee',            top: false, f: and(loc(R), tfr(false)),            label: '— Fee Based' },
  { type: 'row', key: 'r_free',           top: false, f: and(loc(R), tfr(true)),             label: '— Tuition Free' },
  { type: 'row', key: 'r_lessons',        top: false, f: and(loc(R), act('LESSON')),         label: '— Lessons' },
  { type: 'row', key: 'r_group',          top: false, f: and(loc(R), act('CLASS')),          label: '— Group Classes' },
  { type: 'row', key: 'r_fee_lessons',    top: false, f: and(loc(R), tfr(false), act('LESSON')), label: '— Fee Based — Lessons' },
  { type: 'row', key: 'r_fee_group',      top: false, f: and(loc(R), tfr(false), act('CLASS')),  label: '— Fee Based — Group Classes' },
  { type: 'row', key: 'r_free_lessons',   top: false, f: and(loc(R), tfr(true),  act('LESSON')), label: '— Tuition Free — Lessons' },
  { type: 'row', key: 'r_free_group',     top: false, f: and(loc(R), tfr(true),  act('CLASS')),  label: '— Tuition Free — Group Classes' },

  { type: 'section', label: 'Retention' },
  { type: 'row', key: 'new',              top: true,  f: 'NEW',       label: 'New Students' },
  { type: 'row', key: 'returning',        top: true,  f: 'RETURNING', label: 'Returning Students' },
]

const DATA_ROWS = ROWS.filter(r => r.type === 'row')

// ─────────────────────────────────────────────────────────────────────────────
// Computation
// ─────────────────────────────────────────────────────────────────────────────

function makeStats(arr) {
  return { enr: arr.length, stu: new Set(arr.map(e => e.cid)).size }
}

function getPeriodEnrollments(records, period) {
  return period.type === 'quarter'
    ? records.filter(r => r.timePeriod === period.value)
    : records.filter(r => r.fiscalYear === period.value)
}

function rowStats(pEnr, row, firstKey, minK, maxK) {
  if (row.f === 'NEW') {
    return makeStats(pEnr.filter(r => {
      const k = firstKey[r.cid]
      return k !== undefined && k >= minK && k <= maxK
    }))
  }
  if (row.f === 'RETURNING') {
    return makeStats(pEnr.filter(r => {
      const k = firstKey[r.cid]
      return k !== undefined && k < minK
    }))
  }
  return makeStats(row.f ? pEnr.filter(row.f) : pEnr)
}

function buildReport(records, periods, firstKey) {
  return periods.map(period => {
    const pEnr = getPeriodEnrollments(records, period)
    const [minK, maxK] = period.type === 'quarter'
      ? (() => { const k = quarterSortKey(period.value); return [k, k] })()
      : fyRange(period.value)
    const rowData = {}
    for (const row of DATA_ROWS) {
      rowData[row.key] = rowStats(pEnr, row, firstKey, minK, maxK)
    }
    return { period, rowData }
  })
}

function computeDelta(a, b) {
  const enrRaw = b.enr - a.enr
  const stuRaw = b.stu - a.stu
  return {
    enrRaw, stuRaw,
    enrPct: a.enr === 0 ? null : (enrRaw / a.enr * 100),
    stuPct: a.stu === 0 ? null : (stuRaw / a.stu * 100),
  }
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
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function exportCSV(reportData) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`

  const headers = ['Category']
  reportData.forEach(pd => {
    headers.push(`${pd.period.value} — Enrollments`, `${pd.period.value} — Unique Students`)
  })
  for (let i = 0; i < reportData.length - 1; i++) {
    const a = reportData[i].period.value, b = reportData[i + 1].period.value
    headers.push(`Δ ${a}→${b} Enr`, `Δ Enr %`, `Δ ${a}→${b} Stu`, `Δ Stu %`)
  }

  const lines = [headers.map(esc).join(',')]
  for (const row of DATA_ROWS) {
    const cells = [row.label]
    reportData.forEach(pd => {
      const s = pd.rowData[row.key]
      cells.push(s.enr, s.stu)
    })
    for (let i = 0; i < reportData.length - 1; i++) {
      const d = computeDelta(reportData[i].rowData[row.key], reportData[i + 1].rowData[row.key])
      cells.push(
        d.enrRaw,
        d.enrPct === null ? '' : d.enrPct.toFixed(1),
        d.stuRaw,
        d.stuPct === null ? '' : d.stuPct.toFixed(1),
      )
    }
    lines.push(cells.map(esc).join(','))
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `cmc-enrollment-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ─────────────────────────────────────────────────────────────────────────────
// Period selector
// ─────────────────────────────────────────────────────────────────────────────

function PeriodSelector({ fyPeriods, quarterGroups, isSelected, toggle, onClear, hasSelection }) {
  return (
    <div className="period-selector">
      <div className="period-selector-header">
        <span className="period-selector-title">Select Periods</span>
        {hasSelection && (
          <button className="period-clear-btn" onClick={onClear}>
            Clear
          </button>
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
                <div className="rt-period-sub">Enr / Stu</div>
              </th>
            ) : (
              <th key={i} className="rt-delta-hdr">Δ</th>
            )
          )}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row, ri) => {
          if (row.type === 'section') {
            return (
              <tr key={`section-${ri}`} className="rt-section-hdr">
                <td colSpan={1 + cols.length}>{row.label}</td>
              </tr>
            )
          }
          return (
            <tr key={row.key} className={row.top ? 'rt-row rt-top-row' : 'rt-row rt-sub-row'}>
              <td className="rt-label">{row.label}</td>
              {cols.map((col, ci) => {
                if (col.type === 'period') {
                  const s = col.pd.rowData[row.key]
                  return (
                    <td key={ci} className="rt-period-cell">
                      <div className="cell-enr">{s.enr.toLocaleString()}</div>
                      <div className="cell-stu">{s.stu.toLocaleString()} stu</div>
                    </td>
                  )
                }
                const a = col.a.rowData[row.key]
                const b = col.b.rowData[row.key]
                const d = computeDelta(a, b)
                return (
                  <td key={ci} className="rt-delta-cell">
                    <div className={`delta-line ${deltaClass(d.enrRaw)}`}>{fmtDelta(d.enrRaw, d.enrPct)}</div>
                    <div className={`delta-line ${deltaClass(d.stuRaw)}`}>{fmtDelta(d.stuRaw, d.stuPct)}</div>
                  </td>
                )
              })}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function Enrollment() {
  const [allRecords, setAllRecords] = useState([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)
  const [selected, setSelected]     = useState([])

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    const PAGE = 1000
    let from = 0, all = []
    while (true) {
      const { data, error } = await supabase
        .from('enrollments')
        .select('event_enrollment_id, customer_id, time_period, fiscal_year, is_tuition_free, events(location, activity_type)')
        .range(from, from + PAGE - 1)
      if (error) { setError(error.message); setLoading(false); return }
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }

    const records = all.map(e => ({
      eid:           e.event_enrollment_id,
      cid:           e.customer_id,
      timePeriod:    e.time_period,
      fiscalYear:    e.fiscal_year,
      isTuitionFree: e.is_tuition_free,
      location:      e.events?.location?.trim() ?? null,
      activityType:  e.events?.activity_type ?? null,
      qSortKey:      quarterSortKey(e.time_period),
    }))

    const distinctLocations = [...new Set(records.map(r => r.location).filter(Boolean))].sort()
    console.log('[CMC] Distinct location values in events:', distinctLocations)

    setAllRecords(records)
    setLoading(false)
  }

  // Derive available periods from loaded data
  const { fyPeriods, quarterGroups } = useMemo(() => {
    const qSet = new Set(), fySet = new Set()
    for (const r of allRecords) {
      if (r.timePeriod) qSet.add(r.timePeriod)
      if (r.fiscalYear) fySet.add(r.fiscalYear)
    }

    const fyPeriods = [...fySet]
      .map(v => ({ type: 'fiscal_year', value: v }))
      .sort((a, b) => fySortKey(a.value) - fySortKey(b.value))

    // Group quarters by FY label
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
  }, [allRecords])

  // Each customer's earliest quarter sort key (for New vs Returning)
  const firstKey = useMemo(() => {
    const map = {}
    for (const r of allRecords) {
      if (!r.cid || r.qSortKey === 99999) continue
      if (map[r.cid] === undefined || r.qSortKey < map[r.cid]) map[r.cid] = r.qSortKey
    }
    return map
  }, [allRecords])

  // Sort selected periods chronologically for column order
  const columns = useMemo(
    () => [...selected].sort((a, b) => periodSortKey(a) - periodSortKey(b)),
    [selected]
  )

  const reportData = useMemo(
    () => buildReport(allRecords, columns, firstKey),
    [allRecords, columns, firstKey]
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

  if (loading) return <div className="page"><p className="coming-soon">Loading enrollment data…</p></div>
  if (error)   return <div className="page"><div className="error-banner">{error}</div></div>

  const hasData = fyPeriods.length > 0 || quarterGroups.length > 0

  return (
    <div className="page enroll-page">
      <div className="enroll-header">
        <h1>Enrollment Numbers</h1>
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
