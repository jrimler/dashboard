// Verifies the Low-Income Youth Program report against the live database.
// Rather than reimplementing the logic (a reimplementation can agree with
// itself and still be wrong), this extracts the report file's own pure logic
// block — everything between the "pure logic" markers in
// LowIncomeYouthProgram.jsx — and runs those exact functions.
//
// Usage: node scripts/liyp-check.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { sb } from './db.mjs'

const root       = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = join(root, 'src/reports/LowIncomeYouthProgram.jsx')
const reportDir  = join(root, 'src/reports')

// ─── extract the report's pure logic verbatim ───────────────────────────────
const src   = readFileSync(reportPath, 'utf8')
const start = src.indexOf('// ─── pure logic')
const end   = src.indexOf('// ─── end pure logic')
if (start < 0 || end < 0) {
  console.error('Could not find the pure-logic markers in LowIncomeYouthProgram.jsx')
  process.exit(1)
}
const block = src.slice(start, end)

// Reuse the report's own imports verbatim apart from the module specifier, so
// a name added to any of them can't leave this check behind. Every relative
// import except React and the browser Supabase client is carried across —
// the pure-logic block draws on the shared category definitions and the date
// helpers alike, and hardcoding one of them silently broke this check when the
// block started using another.
const imports = [...src.matchAll(/^import\s*\{[^}]*\}\s*from\s*'(\.[^']*)'/gm)]
  .filter(m => !/lib\/supabase/.test(m[1]))
  .map(m => m[0].replace(`'${m[1]}'`, `'${resolve(reportDir, m[1])}.js'`.replace('.js.js', '.js')))
if (!imports.length) {
  console.error('Could not find any relative import in LowIncomeYouthProgram.jsx')
  process.exit(1)
}

const moduleSrc = [
  ...imports,
  block,
  'export { buildReport, buildComparison, cellDelta, DIMENSIONS, GROUPS, isSlidingOrMerit, ageAtDate }',
].join('\n')

const dir = mkdtempSync(join(tmpdir(), 'liyp-check-'))
const modPath = join(dir, 'liyp-logic.mjs')
writeFileSync(modPath, moduleSrc)
const R = await import(modPath)

// ─── load every enrollment (paginated — an unpaginated query caps at 1000) ──
const PAGE = 1000
let from = 0, all = []
while (true) {
  const { data, error } = await sb
    .from('enrollments')
    .select(`
      customer_id, fiscal_year, discount_type,
      events(course_name, class_start_date),
      students(birthdate, ethnicity, gender, household_income)
    `)
    .range(from, from + PAGE - 1)
  if (error) { console.error(error.message); process.exit(1) }
  all = all.concat(data)
  if (data.length < PAGE) break
  from += PAGE
}
console.log(`Enrollments loaded: ${all.length.toLocaleString()}`)

const fys = [...new Set(all.map(e => e.fiscal_year).filter(Boolean))].sort()
console.log(`Fiscal years: ${fys.join(', ')}\n`)

let failures = 0
function check(ok, label) {
  if (!ok) { failures++; console.log(`  FAIL  ${label}`) }
}

// ─── per-year reports ───────────────────────────────────────────────────────
const byFY = new Map(fys.map(fy => [fy, []]))
for (const e of all) byFY.get(e.fiscal_year)?.push(e)
const reports = fys.map(fy => ({ fy, report: R.buildReport(byFY.get(fy) ?? []) }))

// 1. Group membership is unchanged by this report's demographic breakdowns —
//    counted here independently of buildReport, straight off the raw rows.
console.log('── Unique students per group (independent recount) ──')
for (const { fy, report } of reports) {
  const rows = byFY.get(fy) ?? []
  const ind = { sliding: new Set(), ymp: new Set(), chorus: new Set(), teen: new Set() }
  const union = new Set()
  for (const e of rows) {
    const cid = e.customer_id
    if (!cid) continue
    const s = e.students ?? {}
    const course = e.events?.course_name ?? null
    let hit = null
    if (R.isSlidingOrMerit(e.discount_type ?? '')) {
      const age = R.ageAtDate(s.birthdate, e.events?.class_start_date)
      if (age !== null && age >= 4 && age <= 18 && age <= 100) hit = 'sliding'
    }
    if (hit) { ind.sliding.add(cid); union.add(cid) }
    if (course === 'Young Musicians Program / Saturday Play! (Ensemble)' ||
        course === 'Young Musicians Program / Saturday Play! (Theory)' ||
        course === 'Mission District Young Musicians Program / Saturday Play!') { ind.ymp.add(cid); union.add(cid) }
    if (course === "Children's Chorus")   { ind.chorus.add(cid); union.add(cid) }
    if (course === 'Teen Jazz Orchestra') { ind.teen.add(cid);   union.add(cid) }
  }
  const line = []
  for (const g of report.groups) {
    check(g.uniqueStudents === ind[g.id].size, `${fy} ${g.id}: report ${g.uniqueStudents} vs independent ${ind[g.id].size}`)
    line.push(`${g.id} ${g.uniqueStudents}`)
  }
  check(report.combined.uniqueStudents === union.size,
    `${fy} combined: report ${report.combined.uniqueStudents} vs independent ${union.size}`)
  console.log(`  ${fy}  ${line.join(' · ')} · combined ${report.combined.uniqueStudents}`)
}

// 2. Every dimension of every unit reconciles and sums to 100% of its base.
console.log('\n── Reconciliation: base + excluded = total; percentages sum to 100% of base ──')
let combos = 0
for (const { fy, report } of reports) {
  const units = [...report.groups.map(g => [g.title, g]), ['Combined', report.combined]]
  for (const [title, unit] of units) {
    for (const dim of R.DIMENSIONS) {
      const d = unit.dims[dim.id]
      combos++
      const summed = Object.values(d.counts).reduce((a, b) => a + b, 0)
      check(summed === unit.uniqueStudents,
        `${fy} ${title} ${dim.id}: counts sum ${summed} ≠ students ${unit.uniqueStudents}`)
      const excluded = d.excluded.reduce((a, l) => a + (d.counts[l] ?? 0), 0)
      check(d.base + excluded === d.total,
        `${fy} ${title} ${dim.id}: base ${d.base} + excluded ${excluded} ≠ total ${d.total}`)
      if (d.base > 0) {
        let pctSum = 0
        for (const [label, count] of Object.entries(d.counts)) {
          if (!d.excluded.includes(label)) pctSum += (count / d.base) * 100
        }
        check(Math.abs(pctSum - 100) < 1e-9,
          `${fy} ${title} ${dim.id}: percentages sum to ${pctSum.toFixed(6)}%, not 100%`)
      }
      // Every stored value must land in a real category, not vanish.
      check(Object.values(d.counts).every(c => c >= 0), `${fy} ${title} ${dim.id}: negative count`)
    }
  }
}
console.log(`  ${combos} unit × dimension × year combinations checked`)

// 3. The income base rule is the income-only one; ethnicity/gender keep
//    Decline to State in their base and give it a percentage.
console.log('\n── Percentage base rules ──')
for (const { fy, report } of reports) {
  for (const [title, unit] of [...report.groups.map(g => [g.title, g]), ['Combined', report.combined]]) {
    const inc = unit.dims.income
    check(inc.excluded.length === 2 && inc.excluded.includes('No Response') && inc.excluded.includes('Decline to State'),
      `${fy} ${title}: income exclusions are ${JSON.stringify(inc.excluded)}`)
    for (const id of ['ethnicity', 'gender']) {
      const d = unit.dims[id]
      check(d.excluded.length === 1 && d.excluded[0] === 'No Response',
        `${fy} ${title}: ${id} exclusions are ${JSON.stringify(d.excluded)}`)
      if ((d.counts['Decline to State'] ?? 0) > 0) {
        check(d.base > 0 && d.counts['Decline to State'] <= d.base,
          `${fy} ${title}: ${id} Decline to State not inside its own base`)
      }
    }
  }
}
console.log('  income excludes No Response + Decline to State; ethnicity/gender exclude No Response only')

// 4. The rendered table: every row carries a cell per year, and the base row
//    matches the dimension breakdown it heads.
console.log('\n── Rendered comparison table ──')
const units = R.buildComparison(reports)
for (const u of units) {
  for (const row of u.rows) {
    check(row.cells.length === fys.length, `${u.title} / ${row.label}: ${row.cells.length} cells for ${fys.length} years`)
  }
  // Category rows of a dimension must sum to that dimension's total per year.
  for (const dim of R.DIMENSIONS) {
    const base = u.rows.find(r => r.id === `${dim.id}:__base`)
    const cats = u.rows.filter(r => r.kind === 'category' && r.id.startsWith(`${dim.id}:`))
    check(!!base, `${u.title}: no base row for ${dim.id}`)
    fys.forEach((fy, i) => {
      const catSum = cats.reduce((a, r) => a + r.cells[i].count, 0)
      const total  = u.rows[0].cells[i].count
      check(catSum === total, `${u.title} ${fy} ${dim.id}: category rows sum ${catSum} ≠ unique students ${total}`)
      const inBase = cats.reduce((a, r) => a + (r.cells[i].pct === null ? 0 : r.cells[i].count), 0)
      check(inBase === base.cells[i].count,
        `${u.title} ${fy} ${dim.id}: rows with a % sum ${inBase} ≠ header base ${base.cells[i].count}`)
    })
  }
}
console.log(`  ${units.length} unit tables, ${units[0]?.rows.length ?? 0} rows each (first unit), all aligned`)

// ─── headline figures ───────────────────────────────────────────────────────
console.log('\n── Household income: Low as a share of students who named a bracket ──')
for (const { fy, report } of reports) {
  const parts = [...report.groups.map(g => [g.id, g]), ['combined', report.combined]].map(([id, u]) => {
    const d = u.dims.income
    const low = d.counts['Low'] ?? 0
    return `${id} ${low}/${d.base}${d.base ? ` ${(low / d.base * 100).toFixed(1)}%` : ''}`
  })
  console.log(`  ${fy}  ${parts.join(' · ')}`)
}

console.log('\n── Gender: No Response as a share of the group (response quality) ──')
for (const { fy, report } of reports) {
  const parts = [...report.groups.map(g => [g.id, g]), ['combined', report.combined]].map(([id, u]) => {
    const d = u.dims.gender
    const nr = d.counts['No Response'] ?? 0
    return `${id} ${nr}/${d.total}${d.total ? ` ${(nr / d.total * 100).toFixed(0)}%` : ''}`
  })
  console.log(`  ${fy}  ${parts.join(' · ')}`)
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
