import { useState, useEffect, useMemo, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase'
import { fetchAll, joinBy } from '../utils/fetchAll'
import { parseQuarter, quarterSortKey, quarterFYLabel, SEASON_SHORT } from '../utils/periodUtils'

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment Trends
//
// The Enrollment page answers "what were the numbers in the periods I picked?".
// This report answers "what shape is the program in?" — every quarter on file at
// once, which is the one thing a column-per-period table cannot show.
//
// Series colours are the two leading slots of the validated categorical palette
// (blue #2a78d6, orange #eb6834), not the CMC green. Green stays UI chrome: it is
// a brand colour, never checked for colour-vision separation, and these two are —
// they clear the adjacent-pair gate with a wide margin.
// ─────────────────────────────────────────────────────────────────────────────

const S1 = '#2a78d6'
const S2 = '#eb6834'

// A breakdown always partitions the quarter: the two series sum to its total, so
// the stacked column can never disagree with the line chart above it.
const MODES = {
  total: {
    name: 'Total',
    series: [{ key: 'enrollments', label: 'All enrollments', color: S1 }],
    caption: 'One line, every enrollment. The sawtooth is the summer term, which is genuinely shorter — not a collapse.',
  },
  branch: {
    name: 'Branch',
    series: [
      { key: 'mission',  label: 'Mission Branch',  color: S1 },
      { key: 'richmond', label: 'Richmond Branch', color: S2 },
    ],
    caption: 'Mission climbs steadily; Richmond drifts down. The gap between the two has roughly doubled since FY23.',
  },
  type: {
    name: 'Lessons vs. classes',
    series: [
      { key: 'lesson', label: 'Private lessons', color: S1 },
      { key: 'klass',  label: 'Group classes',   color: S2 },
    ],
    caption: 'Private lessons are essentially flat across four years. Group classes have nearly doubled — that line is the whole growth story.',
  },
  tuition: {
    name: 'Tuition status',
    series: [
      { key: 'feeBased',    label: 'Fee-based',    color: S1 },
      { key: 'tuitionFree', label: 'Tuition-free', color: S2 },
    ],
    caption: 'Tuition-free enrollments grew alongside fee-based ones, holding a roughly steady share of a larger whole.',
  },
}
const MODE_ORDER = ['total', 'branch', 'type', 'tuition']
const SEASONS = ['Summer', 'Fall', 'Winter', 'Spring']

// ─── pure logic (verified by scripts/enrollment-trends-check.mjs) ────────────

// One bucket per quarter. Every split below partitions the same enrollment rows,
// so mission + richmond, lesson + klass, and feeBased + tuitionFree each sum back
// to `enrollments` — the reconciliation the check script asserts.
export function buildQuarterSeries(rows) {
  const buckets = new Map()

  for (const r of rows) {
    const tp = r.time_period
    const q = parseQuarter(tp)
    if (!q) continue

    let b = buckets.get(tp)
    if (!b) {
      b = {
        timePeriod: tp,
        label: `${SEASON_SHORT[q.season] ?? q.season.slice(0, 3)} ${q.year}`,
        season: q.season,
        fy: quarterFYLabel(q.season, q.year),
        sortKey: quarterSortKey(tp),
        enrollments: 0,
        studentSet: new Set(),
        mission: 0, richmond: 0, otherLocation: 0,
        lesson: 0, klass: 0, otherType: 0,
        tuitionFree: 0, feeBased: 0,
      }
      buckets.set(tp, b)
    }

    b.enrollments += 1
    if (r.customer_id) b.studentSet.add(r.customer_id)

    // Richmond arrives from ASAP with trailing spaces; trim before comparing.
    const loc = (r.events?.location ?? '').trim()
    if (loc === 'Mission Branch') b.mission += 1
    else if (loc === 'Richmond Branch') b.richmond += 1
    else b.otherLocation += 1

    const type = r.events?.activity_type
    if (type === 'LESSON') b.lesson += 1
    else if (type === 'CLASS') b.klass += 1
    else b.otherType += 1

    if (r.is_tuition_free) b.tuitionFree += 1
    else b.feeBased += 1
  }

  return [...buckets.values()]
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ studentSet, ...b }) => ({ ...b, students: studentSet.size }))
}

// Summer runs about half the size of the other terms, so a summer point sitting
// between two full quarters reads as a crash that never happened. Dropping the
// summers is the quickest way to see the underlying trend.
export function applySummerFilter(series, excludeSummer) {
  return excludeSummer ? series.filter(q => q.season !== 'Summer') : series
}

// Earliest vs. latest occurrence of each season — the only honest single number
// for "is this growing?", because it never compares a summer with a full term.
// Shown on the PDF cover page, so it lives here where the check script sees it.
export function seasonSummary(series) {
  const seasons = ['Summer', 'Fall', 'Winter', 'Spring']
  return seasons.flatMap(season => {
    const qs = series.filter(q => q.season === season)
    if (qs.length < 2) return []
    const first = qs[0]
    const last = qs[qs.length - 1]
    const change = last.enrollments - first.enrollments
    return [{
      season,
      first, last,
      change,
      pct: first.enrollments === 0 ? null : (change / first.enrollments) * 100,
    }]
  })
}

// ─── end pure logic ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Chart plumbing
// ─────────────────────────────────────────────────────────────────────────────

// Returns [callbackRef, width]. It has to be a *callback* ref, not a useRef:
// the measured element only mounts after the data has loaded, so an effect keyed
// on a (stable) ref object runs once while the element is still the "Loading…"
// placeholder, measures null, and never re-runs — which left both charts at
// width 0 and rendering nothing at all. A callback ref sets state when the node
// actually attaches, so the effect re-runs against a real element.
function useElementWidth() {
  const [node, setNode] = useState(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!node) return
    const measure = () => setWidth(node.clientWidth)
    const ro = new ResizeObserver(measure)
    ro.observe(node)
    measure()
    return () => ro.disconnect()
  }, [node])
  return [setNode, width]
}

// Round the axis up to a clean maximum with no more than five gridlines.
function niceScale(maxVal) {
  const steps = [50, 100, 200, 250, 500, 1000, 2000]
  for (const step of steps) {
    const n = Math.ceil(maxVal / step)
    if (n <= 5) return { max: n * step || step, step }
  }
  return { max: maxVal, step: maxVal }
}

// 4px rounded data-end, square where the column meets the baseline.
function roundedTopPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  if (rr === 0) return `M${x} ${y}h${w}v${h}h${-w}Z`
  return `M${x} ${y + h}V${y + rr}Q${x} ${y} ${x + rr} ${y}` +
         `H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${y + h}Z`
}

function fmt(n) { return n.toLocaleString() }

function Tooltip({ tip, series, showTotal }) {
  if (!tip) return null
  return (
    <div className="et-tip" style={{ left: tip.left, top: tip.top }}>
      <div className="et-tip-head">
        {tip.q.label}<span className="et-tip-sub"> {tip.q.fy}</span>
      </div>
      {series.map(s => (
        <div className="et-tip-row" key={s.key}>
          <span className="et-tip-key" style={{ background: s.color }} />
          <span className="et-tip-name">{s.label}</span>
          <span className="et-tip-val">{fmt(tip.q[s.key])}</span>
        </div>
      ))}
      {showTotal && (
        <div className="et-tip-row">
          <span className="et-tip-key" />
          <span className="et-tip-name">Total</span>
          <span className="et-tip-val">{fmt(tip.q.enrollments)}</span>
        </div>
      )}
    </div>
  )
}

function Legend({ series, block }) {
  // One series needs no legend — the chart title already names it.
  if (series.length < 2) return null
  return (
    <div className="et-legend">
      {series.map(s => (
        <span className="et-legend-item" key={s.key}>
          <span className={`et-legend-key${block ? ' block' : ''}`} style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart 1 — every quarter on one line
// ─────────────────────────────────────────────────────────────────────────────

function TimelineChart({ data, series, width, plotHeight = 300 }) {
  const [tip, setTip] = useState(null)
  if (!width || data.length === 0) return null

  const mL = 56, mR = 68, mT = 14, plotH = plotHeight, axisH = 46
  const H = mT + plotH + axisH
  const x0 = mL, x1 = Math.max(mL + 60, width - mR)
  const axisY = mT + plotH

  const maxVal = Math.max(...data.flatMap(d => series.map(s => d[s.key])), 1)
  const sc = niceScale(maxVal)
  const yOf = v => mT + plotH - (v / sc.max) * plotH
  const stepX = data.length > 1 ? (x1 - x0) / (data.length - 1) : 0
  const xOf = i => (data.length > 1 ? x0 + i * stepX : (x0 + x1) / 2)

  const ticks = []
  for (let v = 0; v <= sc.max; v += sc.step) ticks.push(v)

  // Fiscal-year bands under the axis — real structure in the data, not decoration.
  const bands = []
  data.forEach((d, i) => {
    const last = bands[bands.length - 1]
    if (last && last.fy === d.fy) last.to = i
    else bands.push({ fy: d.fy, from: i, to: i })
  })

  // End-of-line labels, nudged apart only when they would otherwise collide.
  const ends = series.map(s => ({
    key: s.key, color: s.color,
    value: data[data.length - 1][s.key],
    y: yOf(data[data.length - 1][s.key]),
  })).sort((a, b) => a.y - b.y)
  if (ends.length === 2 && ends[1].y - ends[0].y < 14) {
    const mid = (ends[0].y + ends[1].y) / 2
    ends[0].y = mid - 7
    ends[1].y = mid + 7
  }

  function onMove(e) {
    const rect = e.currentTarget.ownerSVGElement.getBoundingClientRect()
    const rel = (e.clientX - rect.left) * (width / rect.width)
    const i = Math.max(0, Math.min(data.length - 1, Math.round((rel - x0) / (stepX || 1))))
    const host = e.currentTarget.ownerSVGElement.parentNode.getBoundingClientRect()
    setTip({
      q: data[i], i,
      left: Math.min(e.clientX - host.left + 16, host.width - 170),
      top: Math.max(0, e.clientY - host.top - 90),
    })
  }

  return (
    <div className="et-plot">
      <svg viewBox={`0 0 ${width} ${H}`} height={H} role="img"
           aria-label="Enrollments by quarter">
        {ticks.map(v => (
          <g key={v}>
            <line className="et-grid" x1={x0} x2={x1} y1={yOf(v)} y2={yOf(v)} />
            <text className="et-tick" x={x0 - 10} y={yOf(v) + 4} textAnchor="end">{fmt(v)}</text>
          </g>
        ))}

        {bands.map((b, bi) => (
          <g key={b.fy}>
            {bi > 0 && (
              <line className="et-axis"
                    x1={(xOf(b.from) + xOf(b.from - 1)) / 2} x2={(xOf(b.from) + xOf(b.from - 1)) / 2}
                    y1={mT} y2={axisY + 34} />
            )}
            <text className="et-band" x={(xOf(b.from) + xOf(b.to)) / 2} y={axisY + 40}
                  textAnchor="middle">
              {b.fy}{b.fy === 'FY27' ? ' (partial)' : ''}
            </text>
          </g>
        ))}

        {data.map((d, i) => (
          <text className="et-xlabel" key={d.timePeriod} x={xOf(i)} y={axisY + 17} textAnchor="middle">
            {SEASON_SHORT[d.season] ?? d.season.slice(0, 3)}
          </text>
        ))}

        {tip && <line className="et-cross" x1={xOf(tip.i)} x2={xOf(tip.i)} y1={mT} y2={axisY} />}

        {series.map(s => {
          const pts = data.map((d, i) => [xOf(i), yOf(d[s.key])])
          const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
          return (
            <g key={s.key}>
              {series.length === 1 && (
                <path d={`${line} L${pts[pts.length - 1][0].toFixed(1)} ${axisY} L${pts[0][0].toFixed(1)} ${axisY} Z`}
                      fill={s.color} opacity={0.1} />
              )}
              <path d={line} fill="none" stroke={s.color} strokeWidth={2}
                    strokeLinejoin="round" strokeLinecap="round" />
            </g>
          )
        })}

        {ends.map(e => (
          <g key={e.key}>
            <circle cx={xOf(data.length - 1)} cy={yOf(e.value)} r={4} fill={e.color}
                    className="et-dot" />
            <text className="et-endlabel" x={xOf(data.length - 1) + 11} y={e.y + 4}>{fmt(e.value)}</text>
          </g>
        ))}

        {tip && series.map(s => (
          <circle key={s.key} cx={xOf(tip.i)} cy={yOf(tip.q[s.key])} r={4.5}
                  fill={s.color} className="et-dot" />
        ))}

        <line className="et-axis" x1={x0} x2={x1} y1={axisY} y2={axisY} />

        <rect x={x0 - stepX / 2} y={mT} width={(x1 - x0) + stepX} height={plotH}
              fill="transparent" style={{ cursor: 'crosshair' }}
              onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
      </svg>
      <Tooltip tip={tip} series={series} showTotal={series.length > 1} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart 2 — the same quarters regrouped so each season faces only itself
// ─────────────────────────────────────────────────────────────────────────────

function SeasonChart({ data, series, width, plotHeight = 280 }) {
  const [tip, setTip] = useState(null)
  if (!width || data.length === 0) return null

  const seasons = SEASONS.filter(s => data.some(d => d.season === s))
  const mL = 56, mR = 16, mT = 14, plotH = plotHeight, axisH = 52
  const H = mT + plotH + axisH
  const x0 = mL, x1 = Math.max(mL + 60, width - mR)
  const axisY = mT + plotH
  const GAP = 2

  // Every stack sums to its quarter total, so one scale serves all breakdowns.
  const sc = niceScale(Math.max(...data.map(d => d.enrollments), 1))
  const yOf = v => mT + plotH - (v / sc.max) * plotH

  const ticks = []
  for (let v = 0; v <= sc.max; v += sc.step) ticks.push(v)

  const groupGap = 26
  const groupW = ((x1 - x0) - groupGap * (seasons.length - 1)) / seasons.length

  function onMove(e, q) {
    const host = e.currentTarget.ownerSVGElement.parentNode.getBoundingClientRect()
    setTip({
      q,
      left: Math.min(e.clientX - host.left + 16, host.width - 170),
      top: Math.max(0, e.clientY - host.top - 90),
    })
  }

  return (
    <div className="et-plot">
      <svg viewBox={`0 0 ${width} ${H}`} height={H} role="img"
           aria-label="Enrollments grouped by season and fiscal year">
        {ticks.map(v => (
          <g key={v}>
            <line className="et-grid" x1={x0} x2={x1} y1={yOf(v)} y2={yOf(v)} />
            <text className="et-tick" x={x0 - 10} y={yOf(v) + 4} textAnchor="end">{fmt(v)}</text>
          </g>
        ))}

        {seasons.map((season, gi) => {
          const rows = data.filter(d => d.season === season)
          const gx = x0 + gi * (groupW + groupGap)
          const slot = groupW / rows.length
          const barW = Math.min(24, Math.max(6, slot - 8))

          return (
            <g key={season}>
              {rows.map((d, ri) => {
                const cx = gx + slot * (ri + 0.5)
                const bx = cx - barW / 2
                let cum = 0
                return (
                  <g key={d.timePeriod}>
                    {series.map((s, si) => {
                      const v = d[s.key]
                      if (v <= 0) { return null }
                      // Lay the stack out in value space, then convert — the 2px
                      // surface gap comes out of the drawn height so the stack
                      // still ends at the quarter's true total.
                      let yBottom = yOf(cum)
                      const yTop = yOf(cum + v)
                      cum += v
                      if (si > 0) yBottom -= GAP
                      const h = Math.max(1, yBottom - yTop)
                      const isTop = si === series.length - 1
                      return (
                        <path key={s.key}
                              d={roundedTopPath(bx, yBottom - h, barW, h, isTop ? 4 : 0)}
                              fill={s.color} />
                      )
                    })}
                    {/* Hit target spans the whole slot — never make the pointer find a 24px bar. */}
                    <rect x={gx + slot * ri} y={mT} width={slot} height={plotH}
                          fill="transparent" style={{ cursor: 'pointer' }}
                          onMouseMove={e => onMove(e, d)} onMouseLeave={() => setTip(null)} />
                    <text className={`et-xlabel${d.fy === 'FY27' ? ' partial' : ''}`}
                          x={cx} y={axisY + 16} textAnchor="middle">{d.fy}</text>
                  </g>
                )
              })}
              <text className="et-band" x={gx + groupW / 2} y={axisY + 40} textAnchor="middle">
                {season.toUpperCase()}
              </text>
            </g>
          )
        })}

        <line className="et-axis" x1={x0} x2={x1} y1={axisY} y2={axisY} />
      </svg>
      <Tooltip tip={tip} series={series} showTotal={series.length > 1} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF export
//
// No PDF library: the charts are already SVG, so the browser's own print engine
// writes them as vectors — crisp at any zoom, text still selectable — and the
// bundle doesn't grow. "Export PDF" renders every variation into a packet and
// calls window.print(); the viewer picks "Save as PDF" in the print dialog.
//
// The packet is rendered into a portal on <body> rather than inside the report,
// so print CSS can simply hide #root. And it is positioned off-screen rather
// than display:none — a hidden element has clientWidth 0, which is exactly what
// left the on-screen charts blank once already. Print charts are given an
// explicit width instead of measuring anything.
// ─────────────────────────────────────────────────────────────────────────────

const PRINT_WIDTH = 940        // letter landscape, 0.5in margins, at 96dpi
// Letter landscape at 0.5in margins gives a 720px-tall page. Measured under
// print media, a variation came to 739px — every one spilled onto a second
// sheet, turning a 10-page packet into 18. These heights plus dropping the
// print-only bottom padding bring a section to ~685px, leaving real headroom
// for printers that scale slightly.
const PRINT_TIMELINE_H = 210
const PRINT_SEASON_H = 200

function PrintPacket({ quarters }) {
  const generated = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
  const summary = seasonSummary(quarters)
  const coverage = quarters.length
    ? `${quarters[0].label} – ${quarters[quarters.length - 1].label}`
    : '—'

  // Every combination of breakdown × summer handling, all quarters first.
  const views = []
  for (const excludeSummer of [false, true]) {
    for (const key of MODE_ORDER) {
      views.push({ key, excludeSummer, data: applySummerFilter(quarters, excludeSummer) })
    }
  }

  return (
    <div className="et-print">
      {/* Cover */}
      <section className="et-print-page et-print-cover">
        <div className="et-print-eyebrow">CMC Dashboard</div>
        <h1>Enrollment Trends</h1>
        <p className="et-print-coverage">
          {coverage} · {quarters.length} quarters · {generated}
        </p>

        <div className="et-print-section-title">Growth by season</div>
        <p className="et-print-note">
          Each season compared with the earliest year it appears — the only honest
          single figure for growth, because it never measures a summer term against
          a full one.
        </p>
        <table className="et-print-table">
          <thead>
            <tr>
              <th>Season</th><th>Earliest</th><th></th><th>Most recent</th><th></th>
              <th className="n">Change</th><th className="n">%</th>
            </tr>
          </thead>
          <tbody>
            {summary.map(s => (
              <tr key={s.season}>
                <td>{s.season}</td>
                <td>{s.first.fy}</td>
                <td className="n">{fmt(s.first.enrollments)}</td>
                <td>{s.last.fy}</td>
                <td className="n">{fmt(s.last.enrollments)}</td>
                <td className="n">{s.change >= 0 ? '+' : ''}{fmt(s.change)}</td>
                <td className="n">{s.pct === null ? '—' : `${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(1)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="et-print-section-title">What follows</div>
        <p className="et-print-note">
          Every way this report can be read: four breakdowns — total, branch,
          lessons vs. group classes, and tuition status — each shown across all
          quarters and again with summer quarters excluded, then the full data
          table. Summer runs about half the size of the other terms, so the
          summers-excluded pages are the ones to read for trend.
        </p>
      </section>

      {/* One page per variation */}
      {views.map(v => {
        const cfg = MODES[v.key]
        return (
          <section className="et-print-page" key={`${v.key}-${v.excludeSummer}`}>
            <header className="et-print-head">
              <div>
                <h2>{cfg.name}{v.excludeSummer ? ' · summers excluded' : ''}</h2>
                <p className="et-print-sub">{cfg.caption}</p>
              </div>
              <Legend series={cfg.series} />
            </header>

            <div className="et-print-chart-title">
              Enrollments by quarter — {v.data.length} quarters
            </div>
            <TimelineChart data={v.data} series={cfg.series} width={PRINT_WIDTH}
                           plotHeight={PRINT_TIMELINE_H} />

            <div className="et-print-chart-title">Same season, year over year</div>
            <SeasonChart data={v.data} series={cfg.series} width={PRINT_WIDTH}
                         plotHeight={PRINT_SEASON_H} />

            <footer className="et-print-foot">
              CMC Dashboard · Enrollment Trends · {generated}
            </footer>
          </section>
        )
      })}

      {/* Data table */}
      <section className="et-print-page">
        <header className="et-print-head">
          <div><h2>All quarters</h2>
            <p className="et-print-sub">
              Counts are enrollment rows; a student in three classes counts three
              times. Students is the unique headcount for that quarter.
            </p>
          </div>
        </header>
        <table className="et-print-table wide">
          <thead>
            <tr>
              <th>Quarter</th><th>FY</th>
              <th className="n">Enrollments</th><th className="n">Students</th>
              <th className="n">Mission</th><th className="n">Richmond</th>
              <th className="n">Lessons</th><th className="n">Group Classes</th>
              <th className="n">Fee-Based</th><th className="n">Tuition-Free</th>
            </tr>
          </thead>
          <tbody>
            {quarters.map(q => (
              <tr key={q.timePeriod}>
                <td>{q.label}</td><td>{q.fy}</td>
                <td className="n">{fmt(q.enrollments)}</td>
                <td className="n">{fmt(q.students)}</td>
                <td className="n">{fmt(q.mission)}</td>
                <td className="n">{fmt(q.richmond)}</td>
                <td className="n">{fmt(q.lesson)}</td>
                <td className="n">{fmt(q.klass)}</td>
                <td className="n">{fmt(q.feeBased)}</td>
                <td className="n">{fmt(q.tuitionFree)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <footer className="et-print-foot">
          CMC Dashboard · Enrollment Trends · {generated}
        </footer>
      </section>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

function esc(v) { return `"${String(v ?? '').replace(/"/g, '""')}"` }

function triggerDownload(csv, filename) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  URL.revokeObjectURL(url)
}

function today() { return new Date().toISOString().slice(0, 10) }

function exportCSV(rows, excludeSummer) {
  const headers = [
    'Quarter', 'Fiscal Year', 'Enrollments', 'Unique Students',
    'Mission Branch', 'Richmond Branch', 'Private Lessons', 'Group Classes',
    'Fee-Based', 'Tuition-Free',
  ]
  const body = rows.map(q => [
    q.timePeriod, q.fy, q.enrollments, q.students,
    q.mission, q.richmond, q.lesson, q.klass, q.feeBased, q.tuitionFree,
  ])
  triggerDownload(
    [headers, ...body].map(r => r.map(esc).join(',')).join('\n'),
    `enrollment-trends${excludeSummer ? '-no-summer' : ''}-${today()}.csv`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main report component
// ─────────────────────────────────────────────────────────────────────────────

export default function EnrollmentTrends() {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [mode, setMode]       = useState('total')
  const [excludeSummer, setExcludeSummer] = useState(false)
  const [infoOpen, setInfoOpen]           = useState(false)
  const [printing, setPrinting]           = useState(false)

  // Each chart measures its own container rather than sharing one width, so a
  // future layout change to either card can't silently mis-size the other.
  const [timelineRef, timelineWidth] = useElementWidth()
  const [seasonRef, seasonWidth]     = useElementWidth()

  useEffect(() => { loadData() }, [])

  async function loadData() {
    setLoading(true)
    setError(null)
    try {
      // Both tables flat and in parallel, joined here rather than by PostgREST —
      // measured 3,643 ms → 499 ms against live data. See src/utils/fetchAll.js.
      const [enrollments, events] = await Promise.all([
        fetchAll(supabase, 'enrollments', {
          select: 'customer_id, time_period, is_tuition_free, event_id',
          orderBy: 'event_enrollment_id',
        }),
        fetchAll(supabase, 'events', {
          select: 'event_id, location, activity_type',
          orderBy: 'event_id',
        }),
      ])
      setRows(joinBy(enrollments, events, { on: 'event_id', as: 'events' }))
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  const allQuarters = useMemo(() => buildQuarterSeries(rows), [rows])
  const shown = useMemo(
    () => applySummerFilter(allQuarters, excludeSummer),
    [allQuarters, excludeSummer]
  )

  const cfg = MODES[mode]
  const summerCount = allQuarters.length - applySummerFilter(allQuarters, true).length

  // The packet is 16 charts, so it is only mounted while printing. Two frames of
  // wait let it lay out and paint before the print dialog snapshots the page;
  // 'afterprint' — not a timer — decides when it can come back out of the DOM,
  // so a viewer who sits in the dialog doesn't get a half-rendered PDF.
  useEffect(() => {
    if (!printing) return
    const done = () => setPrinting(false)
    window.addEventListener('afterprint', done)
    let raf2
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => window.print())
    })
    return () => {
      window.removeEventListener('afterprint', done)
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [printing])

  if (loading) return <p className="coming-soon">Loading every quarter on file…</p>

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
              Every enrollment on file, one point per quarter, from the earliest quarter in
              the database to the most recent. The Enrollment page reports the periods you
              select as table columns; this report exists to show the <em>shape</em> across
              all of them at once, which a column-per-period table cannot do.
              Counts are enrollment rows — a student taking three classes in a quarter counts
              three times. The <strong>unique students</strong> figure for each quarter is in
              the table view and the CSV.
            </p>

            <div className="ugcb-info-section-title">How a quarter is built</div>
            <p>
              Enrollments are bucketed by <code>time_period</code> and ordered with the same
              sort key the rest of the dashboard uses, so the axis runs
              Summer → Fall → Winter → Spring within each fiscal year rather than
              alphabetically. Each breakdown <strong>partitions</strong> the quarter:
              Mission + Richmond, lessons + group classes, and fee-based + tuition-free each
              add back up to that quarter's total, which is why the stacked columns in the
              second chart always reach the same height whichever breakdown is showing.
              Branch comes from the event's <code>location</code>, trimmed — Richmond arrives
              from ASAP with trailing spaces.
            </p>

            <div className="ugcb-info-section-title">Why "Exclude summer quarters" exists</div>
            <p>
              Summer is a genuinely short term — around 1,100 enrollments against roughly
              2,300 in the other three — so a summer point sitting between two full quarters
              reads as a collapse that never happened, and any quarter-over-quarter change
              that straddles one is mostly seasonality. Two ways to read past it:
              turn on <strong>Exclude summer quarters</strong> to drop them from both charts,
              or use the second chart, which regroups the same quarters so each season is
              compared only with itself. Excluding summers also removes any fiscal year whose
              only quarter on file is a summer one.
            </p>

            <div className="ugcb-info-section-title">Reading the most recent year</div>
            <p>
              The newest fiscal year on file is normally <strong>incomplete</strong> — it holds
              only the quarters uploaded so far, and a year with one quarter in it cannot be
              compared to a year with four. Partial years are marked on the axis. Judge growth
              by comparing a season to the same season in an earlier year, not by the height of
              the last bar.
            </p>
          </div>
        )}
      </div>

      {allQuarters.length === 0 ? (
        <p className="coming-soon">No enrollment data yet. Upload reports to get started.</p>
      ) : (
        <>
          {/* One filter row, scoping everything below it */}
          <div className="period-selector">
            <div className="period-selector-header">
              <span className="period-selector-title">Break Down By</span>
              <div className="et-export-actions">
                <button className="period-clear-btn" onClick={() => exportCSV(shown, excludeSummer)}>
                  Export CSV
                </button>
                <button
                  className="period-clear-btn"
                  onClick={() => setPrinting(true)}
                  disabled={printing}
                  title="Every breakdown, with and without summer quarters, plus the data table — save as PDF from the print dialog"
                >
                  {printing ? 'Preparing…' : 'Export PDF'}
                </button>
              </div>
            </div>
            <div className="period-pills">
              {MODE_ORDER.map(k => (
                <button key={k}
                        className={`period-pill${mode === k ? ' active' : ''}`}
                        onClick={() => setMode(k)}>
                  {MODES[k].name}
                </button>
              ))}
              <span className="et-pill-divider" />
              <button
                className={`period-pill${excludeSummer ? ' active' : ''}`}
                onClick={() => setExcludeSummer(v => !v)}
                title={`Drop the ${summerCount} summer quarter${summerCount === 1 ? '' : 's'} — summer runs about half the size of the other terms`}
              >
                Exclude summer quarters
              </button>
            </div>
          </div>

          <div className="et-card">
            <div className="et-card-head">
              <span className="et-card-title">
                Enrollments by quarter
                {excludeSummer && <span className="et-card-flag"> · summers excluded</span>}
              </span>
              <Legend series={cfg.series} />
            </div>
            <p className="et-card-sub">{cfg.caption}</p>
            <div ref={timelineRef}>
              <TimelineChart data={shown} series={cfg.series} width={timelineWidth} />
            </div>
          </div>

          <div className="et-card">
            <div className="et-card-head">
              <span className="et-card-title">Same season, year over year</span>
              <Legend series={cfg.series} block />
            </div>
            <p className="et-card-sub">
              The same quarters regrouped so each season is compared only with itself — the
              honest way to read growth when summer runs about half the size of the other terms.
            </p>
            <div ref={seasonRef}>
              <SeasonChart data={shown} series={cfg.series} width={seasonWidth} />
            </div>
          </div>

          <div className="pig-roster-header">
            <span className="pig-roster-title">
              Table view — {shown.length} quarter{shown.length === 1 ? '' : 's'}
              {excludeSummer && `, ${summerCount} summer quarter${summerCount === 1 ? '' : 's'} excluded`}
            </span>
          </div>
          <div className="report-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th className="et-th">Quarter</th>
                  <th className="et-th">FY</th>
                  <th className="et-th-num">Enrollments</th>
                  <th className="et-th-num">Students</th>
                  <th className="et-th-num">Mission</th>
                  <th className="et-th-num">Richmond</th>
                  <th className="et-th-num">Lessons</th>
                  <th className="et-th-num">Group Classes</th>
                  <th className="et-th-num">Fee-Based</th>
                  <th className="et-th-num">Tuition-Free</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(q => (
                  <tr key={q.timePeriod}>
                    <td className="rt-label">{q.label}</td>
                    <td className="et-td-muted">{q.fy}</td>
                    <td className="et-td-num">{fmt(q.enrollments)}</td>
                    <td className="et-td-num">{fmt(q.students)}</td>
                    <td className="et-td-num">{fmt(q.mission)}</td>
                    <td className="et-td-num">{fmt(q.richmond)}</td>
                    <td className="et-td-num">{fmt(q.lesson)}</td>
                    <td className="et-td-num">{fmt(q.klass)}</td>
                    <td className="et-td-num">{fmt(q.feeBased)}</td>
                    <td className="et-td-num">{fmt(q.tuitionFree)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {printing && createPortal(<PrintPacket quarters={allQuarters} />, document.body)}
        </>
      )}
    </div>
  )
}
