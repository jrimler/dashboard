// Verifies the income percentage base change: "Decline to State" is excluded
// from the income base only, and ethnicity/gender percentages are unchanged.
//
// Runs the shared demographicCategories.js helpers — the same functions both
// income-reporting reports call — over live data, and reconciles each dimension
// (base + excluded categories = all students).
//
// Usage: node scripts/income-base-check.mjs
import { sb } from './db.mjs'
import {
  NO_RESPONSE, DECLINE_TO_STATE, INCOME_ORDER, LOW_INCOME,
  INCOME_PCT_EXCLUDED, RESPONSE_PCT_EXCLUDED, pctBase, bucketPct,
  incomeCategoryFor, ethnicityLabelFor, genderLabelFor,
} from '../src/reports/demographicCategories.js'

const PAGE = 1000
let from = 0, all = []
while (true) {
  const { data, error } = await sb.from('enrollments')
    .select('customer_id, fiscal_year, events(activity_type, course_name), students(gender, ethnicity, household_income)')
    .range(from, from + PAGE - 1)
  if (error) { console.error(error.message); process.exit(1) }
  all = all.concat(data)
  if (data.length < PAGE) break
  from += PAGE
}
console.log(`Fetched ${all.length.toLocaleString()} enrollment rows\n`)

const DIMS = [
  { id: 'income',    excluded: INCOME_PCT_EXCLUDED,   valueOf: s => incomeCategoryFor(s.household_income) },
  { id: 'ethnicity', excluded: RESPONSE_PCT_EXCLUDED, valueOf: s => ethnicityLabelFor(s.ethnicity) },
  { id: 'gender',    excluded: RESPONSE_PCT_EXCLUDED, valueOf: s => genderLabelFor(s.gender) },
]

function breakdown(students, dim) {
  const counts = {}
  for (const s of students.values()) {
    const l = dim.valueOf(s)
    counts[l] = (counts[l] ?? 0) + 1
  }
  const total = students.size
  return { total, counts, base: pctBase(counts, total, dim.excluded) }
}

// Cohorts worth checking: all students per FY (the Demographics "Total" unit)
// and the Neighborhood Choir students per FY.
const CHOIR_RE = /neighborhood\s*choirs?/i
const cohorts = []
const fys = [...new Set(all.map(e => e.fiscal_year).filter(Boolean))].sort()
for (const fy of fys) {
  const rows = all.filter(e => e.fiscal_year === fy)
  cohorts.push({ name: `All students ${fy}`, students: dedupe(rows) })
  cohorts.push({ name: `Choir ${fy}`, students: dedupe(rows.filter(e => CHOIR_RE.test(e.events?.course_name ?? ''))) })
}
function dedupe(rows) {
  const m = new Map()
  for (const e of rows) if (e.customer_id && !m.has(e.customer_id)) m.set(e.customer_id, e.students ?? {})
  return m
}

// ─── 1. income base excludes both; ethnicity/gender exclude only No Response ──
console.log('=== 1. Base composition per dimension ===')
let ok1 = true
for (const c of cohorts) {
  for (const dim of DIMS) {
    const b = breakdown(c.students, dim)
    const noResp  = b.counts[NO_RESPONSE] ?? 0
    const decline = b.counts[DECLINE_TO_STATE] ?? 0
    const expected = dim.id === 'income'
      ? b.total - noResp - decline
      : b.total - noResp
    if (b.base !== expected) { ok1 = false; console.log(`  MISMATCH ${c.name} ${dim.id}: base ${b.base} expected ${expected}`) }
    // Decline to State must have a percentage for ethnicity/gender, none for income.
    const declinePct = bucketPct(DECLINE_TO_STATE, decline, b.base, dim.excluded)
    const wantNull = dim.id === 'income'
    if ((declinePct === null) !== wantNull) {
      ok1 = false
      console.log(`  MISMATCH ${c.name} ${dim.id}: Decline to State pct ${declinePct}, expected ${wantNull ? 'null' : 'a number'}`)
    }
  }
}
console.log(ok1 ? '  income excludes No Response + Decline to State; ethnicity/gender exclude only No Response — ok' : '  FAILED')

// ─── 2. reconciliation + percentages sum to 100 of the base ─────────────────
console.log('\n=== 2. Reconciliation and 100% sums ===')
let ok2 = true
for (const c of cohorts) {
  for (const dim of DIMS) {
    const b = breakdown(c.students, dim)
    const counted = Object.values(b.counts).reduce((a, x) => a + x, 0)
    const excludedCount = dim.excluded.reduce((a, l) => a + (b.counts[l] ?? 0), 0)
    const sumPct = Object.entries(b.counts)
      .map(([l, n]) => bucketPct(l, n, b.base, dim.excluded))
      .filter(p => p !== null)
      .reduce((a, p) => a + p, 0)
    const reconciles = counted === b.total && b.base + excludedCount === b.total
    const sums = Math.abs(sumPct - 100) < 0.0001 || b.base === 0
    if (!reconciles || !sums) {
      ok2 = false
      console.log(`  MISMATCH ${c.name} ${dim.id}: counted ${counted}/${b.total}, base+excluded ${b.base + excludedCount}, pct sum ${sumPct.toFixed(4)}`)
    }
  }
}
console.log(ok2 ? `  all ${cohorts.length * DIMS.length} cohort×dimension combinations reconcile and sum to 100.0000% — ok` : '  FAILED')

// ─── 3. before/after on the low-income figure ──────────────────────────────
console.log('\n=== 3. Low-income share: old base (decliners counted) vs new base ===')
console.log('  Cohort                       Low   High  Decline  NoResp |    old %    new %')
for (const c of cohorts) {
  const b = breakdown(c.students, DIMS[0])
  const low = b.counts[LOW_INCOME] ?? 0
  const high = b.counts['High'] ?? 0
  const noResp = b.counts[NO_RESPONSE] ?? 0
  const decline = b.counts[DECLINE_TO_STATE] ?? 0
  const oldBase = b.total - noResp
  const oldPct = oldBase === 0 ? null : (low / oldBase) * 100
  const newPct = b.base === 0 ? null : (low / b.base) * 100
  console.log(
    `  ${c.name.padEnd(28)}${String(low).padStart(5)}${String(high).padStart(7)}${String(decline).padStart(9)}${String(noResp).padStart(8)} | ` +
    `${(oldPct === null ? '—' : oldPct.toFixed(1) + '%').padStart(8)} ${(newPct === null ? '—' : newPct.toFixed(1) + '%').padStart(8)}`
  )
}

// ─── 4. income categories still cover every stored label ───────────────────
console.log('\n=== 4. Income category coverage ===')
const unmapped = new Set()
for (const e of all) {
  const raw = e.students?.household_income
  if (incomeCategoryFor(raw) === NO_RESPONSE && String(raw ?? '').trim() !== '' && String(raw ?? '').trim() !== '0') {
    unmapped.add(String(raw))
  }
}
console.log(`  INCOME_ORDER: ${INCOME_ORDER.join(', ')}`)
console.log(unmapped.size === 0
  ? '  every stored income label maps to a real category — ok'
  : `  labels falling to No Response (update INCOME_MAP): ${[...unmapped].join(' | ')}`)

const allOk = ok1 && ok2
console.log(`\n${allOk ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}`)
process.exit(allOk ? 0 : 1)
