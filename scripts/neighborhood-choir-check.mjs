// Verifies the Neighborhood Choir Program Demographics report against the live
// database. Rather than reimplementing the logic (a reimplementation can agree
// with itself and still be wrong), this extracts the report file's own pure
// logic block — everything between the "pure logic" markers in
// NeighborhoodChoirDemographics.jsx — and runs those exact functions.
//
// Usage: node scripts/neighborhood-choir-check.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { sb } from './db.mjs'

const root       = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = join(root, 'src/reports/NeighborhoodChoirDemographics.jsx')
const sharedPath = join(root, 'src/reports/demographicCategories.js')

// ─── extract the report's pure logic verbatim ───────────────────────────────
const src   = readFileSync(reportPath, 'utf8')
const start = src.indexOf('// ─── pure logic')
const end   = src.indexOf('// ─── end pure logic')
if (start < 0 || end < 0) {
  console.error('Could not find the pure-logic markers in NeighborhoodChoirDemographics.jsx')
  process.exit(1)
}
const block = src.slice(start, end)

const moduleSrc = [
  `import { NO_RESPONSE, INCOME_ORDER, LOW_INCOME, incomeCategoryFor, ethnicityLabelFor, genderLabelFor } from '${sharedPath}'`,
  block,
  'export { isNeighborhoodChoir, collectStudents, buildReport, buildComparison, cellDelta, DIMENSIONS }',
].join('\n')

const scratch = join(mkdtempSync(join(tmpdir(), 'nchoir-')), 'extracted.mjs')
writeFileSync(scratch, moduleSrc)
const { isNeighborhoodChoir, buildReport, buildComparison, DIMENSIONS } = await import(scratch)

// ─── fetch, exactly as the report does (paginated 1000/batch) ───────────────
async function fetchAll(select) {
  const PAGE = 1000
  let from = 0, all = []
  while (true) {
    const { data, error } = await sb.from('enrollments').select(select).range(from, from + PAGE - 1)
    if (error) { console.error(error.message); process.exit(1) }
    all = all.concat(data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return all
}

const enrollments = await fetchAll(`
  customer_id, fiscal_year,
  events(course_name),
  students(gender, ethnicity, household_income)
`)

const fys = [...new Set(enrollments.map(e => e.fiscal_year).filter(Boolean))].sort()
const byFY = new Map(fys.map(fy => [fy, []]))
for (const e of enrollments) byFY.get(e.fiscal_year)?.push(e)
const cols = fys.map(fy => ({ fy, report: buildReport(byFY.get(fy)) }))

console.log(`Fetched ${enrollments.length.toLocaleString()} enrollment rows across ${fys.join(', ')}`)
console.log(`Choir enrollments matched: ${enrollments.filter(e => isNeighborhoodChoir(e.events?.course_name)).length.toLocaleString()}\n`)

// ─── 1. independent unique-student count, joined through event_id ───────────
// The report matches course_name on the embedded events row. This path instead
// pulls choir event IDs from the events table and counts distinct customers on
// those events — a different join, so agreement is meaningful.
const { data: choirEvents, error: evErr } = await sb
  .from('events').select('event_id, fiscal_year').ilike('course_name', '%Neighborhood Choir%')
if (evErr) { console.error(evErr.message); process.exit(1) }
const choirEventIds = new Set(choirEvents.map(e => e.event_id))

// The demographic fetch above doesn't select event_id, so pull it separately.
const independent = {}
const idRows = await fetchAll('customer_id, fiscal_year, event_id')
for (const r of idRows) {
  if (!choirEventIds.has(r.event_id)) continue
  ;(independent[r.fiscal_year] ??= new Set()).add(r.customer_id)
}

console.log('=== 1. Unique students per FY (report vs. independent event_id join) ===')
let ok1 = true
for (const c of cols) {
  const indep = independent[c.fy]?.size ?? 0
  const match = indep === c.report.uniqueStudents
  if (!match) ok1 = false
  console.log(`  ${c.fy}  report ${String(c.report.uniqueStudents).padStart(4)}   event_id join ${String(indep).padStart(4)}   ${match ? 'match' : 'MISMATCH'}`)
}

// ─── 2. reconciliation: every student lands in exactly one category ─────────
console.log('\n=== 2. Reconciliation — categories + No Response = all students ===')
let ok2 = true
for (const c of cols) {
  for (const d of DIMENSIONS) {
    const dim    = c.report.dims[d.id]
    const summed = Object.values(dim.counts).reduce((a, b) => a + b, 0)
    const noResp = dim.counts['No Response'] ?? 0
    const match  = summed === c.report.uniqueStudents && dim.base === summed - noResp
    if (!match) ok2 = false
    console.log(`  ${c.fy} ${d.id.padEnd(10)} counted ${String(summed).padStart(4)} = students ${String(c.report.uniqueStudents).padStart(4)}   responded ${String(dim.base).padStart(4)} + no-response ${String(noResp).padStart(3)}   ${match ? 'ok' : 'MISMATCH'}`)
  }
}

// ─── 3. percentages of responding students sum to 100 ──────────────────────
console.log('\n=== 3. Percentages sum to 100% of responders (per dimension) ===')
const units = buildComparison(cols)
let ok3 = true
for (const u of units) {
  for (let i = 0; i < cols.length; i++) {
    const sum = u.rows
      .filter(r => r.kind === 'category' && r.cells[i].pct !== null)
      .reduce((a, r) => a + r.cells[i].pct, 0)
    const match = Math.abs(sum - 100) < 0.0001 || sum === 0
    if (!match) ok3 = false
    console.log(`  ${cols[i].fy} ${u.id.padEnd(10)} ${sum.toFixed(4)}%  ${match ? 'ok' : 'MISMATCH'}`)
  }
}

// ─── 4. the report's headline numbers ──────────────────────────────────────
console.log('\n=== 4. Report figures ===')
for (const u of units) {
  console.log(`\n${u.title}`)
  console.log(`  ${'Category'.padEnd(46)}${cols.map(c => c.fy.padStart(14)).join('')}`)
  for (const r of u.rows) {
    const cells = r.cells.map(c =>
      (c.pct === null ? String(c.count) : `${c.count} (${c.pct.toFixed(1)}%)`).padStart(14)
    ).join('')
    console.log(`  ${r.label.padEnd(46)}${cells}`)
  }
}

console.log('\n=== Low-income headline ===')
for (const c of cols) {
  const li = c.report.lowIncome
  console.log(`  ${c.fy}  ${li.count} of ${li.base} responding = ${li.pct === null ? '—' : li.pct.toFixed(1) + '%'}  (${c.report.uniqueStudents} students total)`)
}

const allOk = ok1 && ok2 && ok3
console.log(`\n${allOk ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}`)
process.exit(allOk ? 0 : 1)
