// Verifies the Enrollment Trends report against the live database. Rather than
// reimplementing the bucketing (a reimplementation can agree with itself and
// still be wrong), this extracts the report file's own pure logic block —
// everything between the "pure logic" markers in EnrollmentTrends.jsx — and runs
// those exact functions over real data.
//
// Usage: node scripts/enrollment-trends-check.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { sb } from './db.mjs'

const root       = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = join(root, 'src/reports/EnrollmentTrends.jsx')
const utilsPath  = join(root, 'src/utils/periodUtils.js')

// ─── extract the report's pure logic verbatim ───────────────────────────────
const src   = readFileSync(reportPath, 'utf8')
const start = src.indexOf('// ─── pure logic')
const end   = src.indexOf('// ─── end pure logic')
if (start < 0 || end < 0) {
  console.error('Could not find the pure-logic markers in EnrollmentTrends.jsx')
  process.exit(1)
}
const block = src.slice(start, end)

// Reuse the report's own periodUtils import, verbatim apart from the module
// specifier — so a helper added there can't leave this check behind.
const utilsImport = src.match(/import\s*\{[^}]*\}\s*from\s*'\.\.\/utils\/periodUtils'/)
if (!utilsImport) {
  console.error("Could not find the '../utils/periodUtils' import in EnrollmentTrends.jsx")
  process.exit(1)
}

const moduleSrc = [
  utilsImport[0].replace("'../utils/periodUtils'", `'${utilsPath}'`),
  block,
].join('\n')

const scratch = join(mkdtempSync(join(tmpdir(), 'entrends-')), 'extracted.mjs')
writeFileSync(scratch, moduleSrc)
const { buildQuarterSeries, applySummerFilter } = await import(scratch)

// ─── fetch, exactly as the report does ──────────────────────────────────────
// Mirrors src/utils/fetchAll.js: both tables flat and paginated in parallel,
// ordered by a unique column so the pages can't overlap, joined client-side.
async function fetchTable(table, select, orderBy) {
  const PAGE = 1000
  const { count, error: countError } =
    await sb.from(table).select('*', { count: 'exact', head: true })
  if (countError) { console.error(countError.message); process.exit(1) }
  const pages = Math.ceil(count / PAGE)
  const parts = await Promise.all(Array.from({ length: pages }, (_, i) =>
    sb.from(table).select(select).order(orderBy)
      .range(i * PAGE, i * PAGE + PAGE - 1)
      .then(r => { if (r.error) { console.error(r.error.message); process.exit(1) } return r.data })
  ))
  return { rows: parts.flat(), count }
}

const enr = await fetchTable('enrollments', 'event_enrollment_id, customer_id, time_period, is_tuition_free, event_id', 'event_enrollment_id')
const evs = await fetchTable('events', 'event_id, location, activity_type', 'event_id')

// Parallel pagination is only safe if it returns every row exactly once.
const uniqueIds = new Set(enr.rows.map(r => r.event_enrollment_id))
if (enr.rows.length !== enr.count || uniqueIds.size !== enr.count) {
  console.error(`\n❌ paginated fetch is unstable: ${enr.rows.length} rows / ${uniqueIds.size} unique vs ${enr.count} expected`)
  process.exit(1)
}

const eventById = new Map(evs.rows.map(e => [e.event_id, e]))
for (const r of enr.rows) r.events = eventById.get(r.event_id)
const rows = enr.rows
const series = buildQuarterSeries(rows)

let failures = 0
const check = (ok, msg) => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`)
}

console.log(`\nFetched ${rows.length.toLocaleString()} enrollment rows → ${series.length} quarters\n`)

// ── 1. Every row lands in a quarter ─────────────────────────────────────────
console.log('Coverage')
const bucketed = series.reduce((a, q) => a + q.enrollments, 0)
const unparseable = rows.filter(r => !/^\w+\s+Quarter\s+\d{4}$/i.test(r.time_period ?? '')).length
check(bucketed + unparseable === rows.length,
  `bucketed ${bucketed.toLocaleString()} + unparseable ${unparseable} = ${rows.length.toLocaleString()} fetched`)
check(unparseable === 0, `every time_period parses as a quarter (${unparseable} did not)`)

// ── 2. Each breakdown partitions its quarter ────────────────────────────────
// This is the property the stacked columns rely on: whichever split is showing,
// the two segments must add up to the same quarter total.
console.log('\nEach breakdown partitions the quarter')
const splits = [
  ['branch',  q => q.mission + q.richmond + q.otherLocation],
  ['type',    q => q.lesson + q.klass + q.otherType],
  ['tuition', q => q.tuitionFree + q.feeBased],
]
for (const [name, total] of splits) {
  const bad = series.filter(q => total(q) !== q.enrollments)
  check(bad.length === 0,
    `${name.padEnd(8)} sums to the quarter total in all ${series.length} quarters` +
    (bad.length ? ` — off in ${bad.map(q => q.label).join(', ')}` : ''))
}
const unclassified = series.reduce((a, q) => a + q.otherLocation + q.otherType, 0)
check(unclassified === 0, `nothing falls outside a known branch or activity type (${unclassified} did)`)

// ── 3. Unique students counted independently ────────────────────────────────
console.log('\nUnique students')
const independent = new Map()
for (const r of rows) {
  if (!independent.has(r.time_period)) independent.set(r.time_period, new Set())
  independent.get(r.time_period).add(r.customer_id)
}
const mismatched = series.filter(q => independent.get(q.timePeriod).size !== q.students)
check(mismatched.length === 0,
  `report's per-quarter unique students match an independent count in all ${series.length} quarters`)

// ── 4. Ordering ─────────────────────────────────────────────────────────────
console.log('\nOrdering')
const keys = series.map(q => q.sortKey)
check(keys.every((k, i) => i === 0 || k > keys[i - 1]), 'quarters are strictly ascending by sort key')
const firstFY = series[0]
check(firstFY.season === 'Summer',
  `the fiscal year opens on Summer (first quarter is ${firstFY.label}, ${firstFY.fy})`)

// ── 5. The summer filter ────────────────────────────────────────────────────
console.log('\nExclude summer quarters')
const noSummer = applySummerFilter(series, true)
const summers  = series.filter(q => q.season === 'Summer')
check(noSummer.length + summers.length === series.length,
  `kept ${noSummer.length} + dropped ${summers.length} = ${series.length} quarters`)
check(noSummer.every(q => q.season !== 'Summer'), 'no summer quarter survives the filter')
check(applySummerFilter(series, false).length === series.length, 'the filter is a no-op when off')
const summerAvg = Math.round(summers.reduce((a, q) => a + q.enrollments, 0) / summers.length)
const otherAvg  = Math.round(noSummer.reduce((a, q) => a + q.enrollments, 0) / noSummer.length)
console.log(`        summer averages ${summerAvg.toLocaleString()} vs ${otherAvg.toLocaleString()} in the other terms ` +
            `(${Math.round((1 - summerAvg / otherAvg) * 100)}% smaller) — the reason the toggle exists`)

// ── 6. The headline claims in the report's own copy ─────────────────────────
console.log('\nSeason-over-season growth (what the charts are meant to show)')
const bySeason = s => series.filter(q => q.season === s)
for (const s of ['Fall', 'Winter', 'Spring']) {
  const qs = bySeason(s)
  const a = qs[0], b = qs[qs.length - 1]
  const pct = ((b.enrollments - a.enrollments) / a.enrollments) * 100
  console.log(`        ${s.padEnd(7)} ${a.fy} ${String(a.enrollments).padStart(5)} → ${b.fy} ${String(b.enrollments).padStart(5)}  ` +
              `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`)
}
const w = bySeason('Winter')
const wa = w[0], wb = w[w.length - 1]
const growth = {
  total:    wb.enrollments - wa.enrollments,
  lesson:   wb.lesson - wa.lesson,
  klass:    wb.klass - wa.klass,
  mission:  wb.mission - wa.mission,
  richmond: wb.richmond - wa.richmond,
}
console.log(`        Winter ${wa.fy}→${wb.fy} breakdown: total ${growth.total >= 0 ? '+' : ''}${growth.total}, ` +
            `lessons ${growth.lesson >= 0 ? '+' : ''}${growth.lesson}, classes ${growth.klass >= 0 ? '+' : ''}${growth.klass}, ` +
            `Mission ${growth.mission >= 0 ? '+' : ''}${growth.mission}, Richmond ${growth.richmond >= 0 ? '+' : ''}${growth.richmond}`)
check(growth.lesson + growth.klass === growth.total,
  'lesson + class growth accounts for the whole change in total')

// ── Per-quarter table ───────────────────────────────────────────────────────
console.log('\nQuarter            FY     Enroll  Studs  Mission   Rich  Lesson   Class   Free    Fee')
for (const q of series) {
  console.log(
    '  ' + q.label.padEnd(11) + q.fy.padEnd(7) +
    String(q.enrollments).padStart(6) + String(q.students).padStart(7) +
    String(q.mission).padStart(9) + String(q.richmond).padStart(7) +
    String(q.lesson).padStart(8) + String(q.klass).padStart(8) +
    String(q.tuitionFree).padStart(7) + String(q.feeBased).padStart(7)
  )
}

console.log(failures === 0
  ? '\n✅ all checks passed\n'
  : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
