// Sanity-checks one quarter of uploaded data before anyone reports off it.
//
// The reports themselves classify by pattern — discount-code families, course
// names, ASAP's demographic labels — and ASAP relabels things constantly. A
// renamed code or course does not error; it quietly lands in an "unmatched"
// bucket, or worse, in "No Response". This script surfaces exactly those cases
// for a single quarter, plus the structural checks (orphans, duplicates,
// tuition-free consistency) that would indicate a bad upload.
//
// Rules are extracted verbatim from the report files rather than reimplemented
// here — a reimplementation can agree with itself and still be wrong.
//
// Usage: node scripts/quarter-audit.mjs ["Fall Quarter 2026"]
//        (with no argument, audits the most recently starting quarter)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { sb } from './db.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src  = f => readFileSync(join(root, 'src/reports', f), 'utf8')

// ─── extract the reports' own rules verbatim ────────────────────────────────
function slice(text, startRe, endRe, what) {
  const s = text.search(startRe)
  if (s < 0) throw new Error(`quarter-audit: could not find ${what} — has the report been restructured?`)
  const rest = text.slice(s)
  const e = rest.search(endRe)
  if (e < 0) throw new Error(`quarter-audit: could not find the end of ${what}`)
  return rest.slice(0, e + rest.match(endRe)[0].length)
}

const dt    = src('DiscountTrends.jsx')
const piano = src('PianoInspiresGrant.jsx')
const choir = src('NeighborhoodChoirDemographics.jsx')
const liyp  = src('LowIncomeYouthProgram.jsx')
const board = src('UniqueGroupClassesBoard.jsx')

const moduleSrc = [
  slice(dt,    /^const FAMILY_RULES = \[/m,        /^\]/m,   'FAMILY_RULES in DiscountTrends.jsx'),
  slice(dt,    /^const EXCLUDED_RULES = \[/m,      /^\]/m,   'EXCLUDED_RULES in DiscountTrends.jsx'),
  slice(dt,    /^const UNMATCHED = /m,             /\n/,     'UNMATCHED in DiscountTrends.jsx'),
  slice(dt,    /^function familyOf\(/m,            /^\}/m,   'familyOf in DiscountTrends.jsx'),
  slice(piano, /^function isPianoKeyboard\(/m,     /^\}/m,   'isPianoKeyboard in PianoInspiresGrant.jsx'),
  slice(choir, /^const COURSE_RE = /m,             /\n/,     'COURSE_RE in NeighborhoodChoirDemographics.jsx'),
  slice(choir, /^function isNeighborhoodChoir\(/m, /^\}/m,   'isNeighborhoodChoir in NeighborhoodChoirDemographics.jsx'),
  slice(liyp,  /^const SLIDING_RE = /m,            /\n/,     'SLIDING_RE in LowIncomeYouthProgram.jsx'),
  slice(liyp,  /^const MERIT_RE = /m,              /\n/,     'MERIT_RE in LowIncomeYouthProgram.jsx'),
  slice(liyp,  /^function isSlidingOrMerit\(/m,    /^\}/m,   'isSlidingOrMerit in LowIncomeYouthProgram.jsx'),
  slice(liyp,  /^const YMP_COURSES = new Set\(\[/m,/^\]\)/m, 'YMP_COURSES in LowIncomeYouthProgram.jsx'),
  slice(board, /^const DEPARTMENT_ALIASES = \{/m,  /^\}/m,   'DEPARTMENT_ALIASES in UniqueGroupClassesBoard.jsx'),
  slice(board, /^function departmentCategory\(/m,  /^\}/m,   'departmentCategory in UniqueGroupClassesBoard.jsx'),
  slice(board, /^const CATEGORY_MAP = \{/m,        /^\}/m,   'CATEGORY_MAP in UniqueGroupClassesBoard.jsx'),
  slice(board, /^const YMP_PREFIX = /m,            /\n/,     'YMP_PREFIX in UniqueGroupClassesBoard.jsx'),
  `import { INCOME_MAP, incomeCategoryFor, ethnicityLabelFor, genderLabelFor, ETHNICITY_ALIASES, GENDER_ALIASES } from '${join(root, 'src/reports/demographicCategories.js')}'`,
  'export { familyOf, UNMATCHED, isPianoKeyboard, isNeighborhoodChoir, isSlidingOrMerit, YMP_COURSES, YMP_PREFIX, CATEGORY_MAP, departmentCategory, INCOME_MAP, incomeCategoryFor, ethnicityLabelFor, genderLabelFor, ETHNICITY_ALIASES, GENDER_ALIASES }',
].join('\n\n')

const modPath = join(mkdtempSync(join(tmpdir(), 'quarter-audit-')), 'rules.mjs')
writeFileSync(modPath, moduleSrc)
const R = await import(modPath)

// ─── load everything (paginated — an unpaginated query silently caps at 1000) ─
async function fetchAll(table, columns) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + 999)
    if (error) { console.error(`${table}: ${error.message}`); process.exit(1) }
    out.push(...data)
    if (data.length < 1000) return out
  }
}

const enrollments = await fetchAll('enrollments',
  'event_enrollment_id,event_id,customer_id,time_period,fiscal_year,amount,total_discount,discount_type,is_tuition_free')
const events   = await fetchAll('events', 'event_id,course_name,department,activity_type,location,class_start_date,fiscal_year')
const students = await fetchAll('students', 'customer_id,birthdate,gender,ethnicity,household_income')
const evById = new Map(events.map(e => [e.event_id, e]))
const stById = new Map(students.map(s => [s.customer_id, s]))

// ─── pick the quarter ───────────────────────────────────────────────────────
const startOf = tp => {
  const dates = enrollments.filter(e => e.time_period === tp)
    .map(e => evById.get(e.event_id)?.class_start_date).filter(Boolean).sort()
  return dates[0] ?? ''
}
const periods = [...new Set(enrollments.map(e => e.time_period).filter(Boolean))]
const TP = process.argv[2] ?? periods.sort((a, b) => startOf(a).localeCompare(startOf(b))).at(-1)
if (!periods.includes(TP)) {
  console.error(`No enrollments for ${JSON.stringify(TP)}. Known periods:\n  ${periods.sort().join('\n  ')}`)
  process.exit(1)
}
// Same quarter one year earlier, for comparison.
const PREV = TP.replace(/\d{4}$/, y => String(+y - 1))

const rows  = enrollments.filter(e => e.time_period === TP)
const prev  = enrollments.filter(e => e.time_period === PREV)
const cids  = [...new Set(rows.map(e => e.customer_id))].filter(Boolean)
const evs   = [...new Set(rows.map(e => e.event_id))].map(i => evById.get(i)).filter(Boolean)

let problems = 0, notes = 0
const problem = m => { problems++; console.log(`  NEEDS ATTENTION  ${m}`) }
const note    = m => { notes++;    console.log(`  note             ${m}`) }
const ok      = m =>               console.log(`  ok               ${m}`)

console.log(`\n═══ Quarter audit: ${TP} ═══`)
console.log(`${rows.length.toLocaleString()} enrollments · ${cids.length.toLocaleString()} students · ${evs.length.toLocaleString()} sections` +
            (prev.length ? `   (${PREV}: ${prev.length.toLocaleString()} · ${new Set(prev.map(e=>e.customer_id)).size.toLocaleString()})` : ''))

// ─── 1. structural integrity ────────────────────────────────────────────────
console.log('\n── Structure ──')
const orphanEv = rows.filter(e => !evById.has(e.event_id)).length
const orphanSt = rows.filter(e => !stById.has(e.customer_id)).length
const dupes    = rows.length - new Set(rows.map(e => e.event_enrollment_id)).size
const nullFy   = rows.filter(e => !e.fiscal_year).length
orphanEv ? problem(`${orphanEv} enrollments reference an event that isn't in the events table`) : ok('every enrollment has a matching event')
orphanSt ? problem(`${orphanSt} enrollments reference a student that isn't in the students table`) : ok('every enrollment has a matching student')
dupes    ? problem(`${dupes} duplicate event_enrollment_id`)  : ok('no duplicate enrollment IDs')
nullFy   ? problem(`${nullFy} enrollments have no fiscal_year`) : ok('every enrollment has a fiscal year')

const flagMismatch = rows.filter(e => (((+e.amount || 0) - (+e.total_discount || 0)) <= 15) !== e.is_tuition_free).length
flagMismatch ? problem(`${flagMismatch} rows where is_tuition_free disagrees with (amount - discount <= 15)`)
             : ok('is_tuition_free matches the rule on every row')
// ASAP writes a placeholder far-future start date when the real one is missing,
// the mirror of the 1900-01-01 birthdate. It matters because both the Board
// report and LIYP compute a student's age *at the class start date*, so a
// placeholder start silently ages a youth into the adult bucket.
const badStart = evs.filter(e => e.class_start_date && (e.class_start_date < '2015-01-01' || e.class_start_date > '2030-01-01'))
badStart.length
  ? problem(`${badStart.length} section(s) with an implausible class_start_date (ages are computed from it): ` +
            badStart.map(e => `${e.class_start_date} ${JSON.stringify(e.course_name)}`).join(', '))
  : ok('every section has a plausible class start date')

const negAmt = rows.filter(e => (+e.amount || 0) < 0).length
const overD  = rows.filter(e => (+e.total_discount || 0) > (+e.amount || 0)).length
negAmt ? problem(`${negAmt} enrollments with a negative amount`) : ok('no negative amounts')
overD  ? note(`${overD} enrollments where the discount exceeds the amount`) : ok('no discount exceeds its amount')

// ─── 2. discount codes ──────────────────────────────────────────────────────
console.log('\n── Discount codes (Discount Trends / LIYP) ──')
const unmatched = {}
for (const e of rows) {
  const code = (e.discount_type ?? '').trim()
  if (!code) continue
  if (R.familyOf(code) === R.UNMATCHED) unmatched[code] = (unmatched[code] ?? 0) + 1
}
if (Object.keys(unmatched).length) {
  problem(`${Object.keys(unmatched).length} discount code(s) match no family — they land in the Unmatched row:`)
  for (const [c, n] of Object.entries(unmatched).sort((a, b) => b[1] - a[1])) console.log(`                     ${String(n).padStart(4)}  ${JSON.stringify(c)}`)
} else ok('every discount code classifies into a family')

const priorCodes = new Set(enrollments.filter(e => e.time_period !== TP).map(e => (e.discount_type ?? '').trim()).filter(Boolean))
const newCodes = [...new Set(rows.map(e => (e.discount_type ?? '').trim()).filter(Boolean))].filter(c => !priorCodes.has(c)).sort()
if (newCodes.length) {
  note(`${newCodes.length} discount code(s) new this quarter — confirm each landed in the right family:`)
  for (const c of newCodes) console.log(`                     ${String(R.familyOf(c) ?? '(excluded)').padEnd(26)} ${JSON.stringify(c)}`)
} else ok('no new discount codes this quarter')

// ─── 3. course-name rules ───────────────────────────────────────────────────
console.log('\n── Course-name rules ──')
const courseCount = new Map()
for (const e of rows) {
  const n = evById.get(e.event_id)?.course_name
  if (n) courseCount.set(n, (courseCount.get(n) ?? 0) + 1)
}
const names = [...courseCount.keys()]

for (const c of R.YMP_COURSES) {
  courseCount.has(c) ? ok(`LIYP YMP course present: ${JSON.stringify(c)} (${courseCount.get(c)})`)
                     : note(`LIYP YMP course absent this quarter: ${JSON.stringify(c)}`)
}
const ympish = names.filter(n => /young musicians|saturday play|\bymp\b/i.test(n) && !R.YMP_COURSES.has(n))
ympish.length ? problem(`YMP-looking course(s) NOT in LIYP's exact-match set — LIYP would miss them: ${ympish.map(n => JSON.stringify(n)).join(', ')}`)
              : ok("no YMP-looking course is missing from LIYP's set")

const choirMatches = names.filter(R.isNeighborhoodChoir)
const choirish = names.filter(n => /choir|chorus/i.test(n) && !R.isNeighborhoodChoir(n))
choirMatches.length ? ok(`Neighborhood Choir matches ${choirMatches.length}: ${choirMatches.map(n => JSON.stringify(n)).join(', ')}`)
                    : note('Neighborhood Choir matched no course this quarter')
if (choirish.length) note(`other choir/chorus courses, deliberately not matched: ${choirish.map(n => JSON.stringify(n)).join(', ')}`)

const pianoCourses = names.filter(R.isPianoKeyboard)
ok(`Piano Inspires matches ${pianoCourses.length} course(s), ${pianoCourses.reduce((a, n) => a + courseCount.get(n), 0)} enrollments`)

const priorNames = new Set()
for (const e of enrollments) if (e.time_period !== TP) { const n = evById.get(e.event_id)?.course_name; if (n) priorNames.add(n) }
const newCourses = names.filter(n => !priorNames.has(n)).sort()
if (newCourses.length) {
  note(`${newCourses.length} course(s) enrolled for the first time — check whether any belongs to a report:`)
  for (const n of newCourses) {
    const tags = [R.isPianoKeyboard(n) && 'Piano', R.isNeighborhoodChoir(n) && 'Choir',
                  R.YMP_COURSES.has(n) && 'LIYP-YMP', n.startsWith(R.YMP_PREFIX) && 'Board-YMP'].filter(Boolean)
    console.log(`                     ${(tags.join(',') || '—').padEnd(12)} ${String(courseCount.get(n)).padStart(4)}  ${JSON.stringify(n)}`)
  }
} else ok('no new course names this quarter')

// ─── 4. demographic labels ──────────────────────────────────────────────────
console.log('\n── Demographic labels (Demographics / LIYP / Neighborhood Choir) ──')
const roster = cids.map(c => stById.get(c)).filter(Boolean)

const unmappedIncome = {}
for (const s of roster) {
  const raw = String(s.household_income ?? '').trim(), key = raw.toLowerCase()
  if (key === '' || key === '0') continue
  if (!Object.prototype.hasOwnProperty.call(R.INCOME_MAP, key)) unmappedIncome[raw] = (unmappedIncome[raw] ?? 0) + 1
}
if (Object.keys(unmappedIncome).length) {
  problem(`income bracket(s) not in INCOME_MAP — these students are silently counted as "No Response":`)
  for (const [k, n] of Object.entries(unmappedIncome).sort((a, b) => b[1] - a[1])) console.log(`                     ${String(n).padStart(4)}  ${JSON.stringify(k)}`)
} else ok('every income bracket label is mapped')

// Ethnicity/gender fall through to their own category rather than vanishing, so
// a new label is a judgement call (a real new category, or a spelling to merge)
// rather than an outright error.
for (const [field, labelFor, aliases] of [['ethnicity', R.ethnicityLabelFor, R.ETHNICITY_ALIASES],
                                          ['gender',    R.genderLabelFor,    R.GENDER_ALIASES]]) {
  const priorVals = new Set()
  for (const s of students) {
    const enrolledBefore = enrollments.some(e => e.customer_id === s.customer_id && e.time_period !== TP)
    if (enrolledBefore) { const v = String(s[field] ?? '').trim(); if (v) priorVals.add(v) }
  }
  const fresh = [...new Set(roster.map(s => String(s[field] ?? '').trim()).filter(Boolean))].filter(v => !priorVals.has(v))
  if (fresh.length) {
    note(`${field}: value(s) not seen before — each becomes its own row unless aliased:`)
    for (const v of fresh.sort()) console.log(`                     -> ${labelFor(v).padEnd(44)} ${JSON.stringify(v)}`)
  } else ok(`${field}: no new label this quarter`)
}

// ─── 5. departments (Board report categories) ───────────────────────────────
console.log('\n── Departments (Unique Group Classes for Board) ──')
const deptRaw = {}
for (const e of evs.filter(e => e.activity_type === 'CLASS')) {
  const d = (e.department ?? '').trim()
  deptRaw[d] = (deptRaw[d] ?? 0) + 1
}
const priorDepts = new Set(events.filter(e => e.fiscal_year !== evs[0]?.fiscal_year).map(e => (e.department ?? '').trim()).filter(Boolean))
for (const [d, n] of Object.entries(deptRaw).sort((a, b) => b[1] - a[1])) {
  if (d === '') { note(`${n} CLASS section(s) with a blank department — they show as category "—" unless CATEGORY_MAP overrides the course`); continue }
  const cat = R.departmentCategory(d)
  if (cat !== d) ok(`department ${JSON.stringify(d)} folds into ${JSON.stringify(cat)} (${n} sections)`)
  else if (!priorDepts.has(d)) note(`department ${JSON.stringify(d)} is new (${n} sections) — check it isn't another spelling of an existing category`)
}

// ─── 6. completeness ────────────────────────────────────────────────────────
console.log('\n── Completeness ──')
const starts = evs.map(e => e.class_start_date).filter(Boolean).sort()
console.log(`  class starts span ${starts[0]} .. ${starts.at(-1)}`)
if (prev.length) {
  const prevEvs = [...new Set(prev.map(e => e.event_id))].map(i => evById.get(i)).filter(Boolean)
  const prevStarts = prevEvs.map(e => e.class_start_date).filter(Boolean).sort()
  console.log(`  ${PREV} spanned  ${prevStarts[0]} .. ${prevStarts.at(-1)}`)
  // Sections that started after this quarter's last start, one year earlier —
  // a quarter pulled from ASAP mid-term simply has not got them yet.
  const cutoff = starts.at(-1)
  const latePrev = prev.filter(e => {
    const d = evById.get(e.event_id)?.class_start_date
    return d && d.slice(5) > cutoff.slice(5)
  }).length
  if (latePrev > 0) {
    note(`${PREV} had ${latePrev} enrollment(s) in sections starting later in the term than anything here ` +
         `(after ${cutoff.slice(5)}). If that term is still in progress, expect this quarter to grow — re-upload later to true it up.`)
  } else ok('no later-starting sections in the comparison quarter; this looks like a full term')
  const delta = ((rows.length - prev.length) / prev.length) * 100
  console.log(`  volume vs ${PREV}: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`)
}

// ─── verdict ────────────────────────────────────────────────────────────────
console.log(`\n═══ ${problems} needing attention · ${notes} to eyeball ═══`)
if (problems) console.log('Resolve the NEEDS ATTENTION items before reporting off this quarter.\n')
else console.log('No rule failed on this quarter. Read the notes, then report with confidence.\n')
process.exit(problems ? 1 : 0)
