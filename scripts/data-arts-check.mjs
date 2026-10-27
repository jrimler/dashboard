// Verifies the Data Arts Report against the live database. Like the other check
// scripts it extracts the report file's own pure-logic block — everything
// between the "pure logic" markers in DataArtsReport.jsx — and runs those exact
// functions, then reconciles each figure against a count taken a different way.
//
// Usage: node scripts/data-arts-check.mjs [FY26]
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { sb } from './db.mjs'
import { fetchAll, fetchByIds } from '../src/utils/fetchAll.js'
import { loadDataArtsInput } from '../src/utils/dataArtsInput.js'

const FY = process.argv[2] ?? 'FY26'

const root       = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = join(root, 'src/reports/DataArtsReport.jsx')

// ─── extract the report's pure logic verbatim ───────────────────────────────
const src   = readFileSync(reportPath, 'utf8')
const start = src.indexOf('// ─── pure logic')
const end   = src.indexOf('// ─── end pure logic')
if (start < 0 || end < 0) {
  console.error('Could not find the pure-logic markers in DataArtsReport.jsx')
  process.exit(1)
}

const moduleSrc = [
  `import { classStartDate, quarterWeeks, timePeriodSeason, QUARTER_WEEKS } from '${join(root, 'src/utils/periodUtils.js')}'`,
  `import { isCamp, campDays, weekdaysBetween, CAMP_MAX_DAYS } from '${join(root, 'src/utils/camps.js')}'`,
  `import { DATA_ARTS_FIELDS } from '${join(root, 'src/utils/dataArtsInput.js')}'`,
  src.slice(start, end),
  'export { buildReport, reportSections, weekdaysBetween, isCamp, campDays, AUDIENCE_YOUTH_SHARE }',
].join('\n')
const scratch = join(mkdtempSync(join(tmpdir(), 'data-arts-')), 'extracted.mjs')
writeFileSync(scratch, moduleSrc)
const { buildReport, reportSections, weekdaysBetween, isCamp, campDays, AUDIENCE_YOUTH_SHARE } = await import(scratch)

// CMC's quarter lengths as CMC stated them, written out here rather than
// imported so a slip in QUARTER_WEEKS is caught instead of agreed with.
const LAW_WEEKS = { summer: 8, fall: 14, winter: 12, spring: 10 }

// ─── fetch, exactly as the report does ──────────────────────────────────────
const [events, enrollments] = await Promise.all([
  fetchAll(sb, 'events', {
    select: 'event_id, course_name, activity_type, location, facility, primary_instructor, class_start_date, class_end_date, all_meetings, time_period',
    orderBy: 'event_id',
    apply: q => q.eq('fiscal_year', FY),
  }),
  fetchAll(sb, 'enrollments', {
    select: 'event_enrollment_id, event_id, customer_id, is_tuition_free',
    orderBy: 'event_enrollment_id',
    apply: q => q.eq('fiscal_year', FY),
  }),
])
const students = await fetchByIds(sb, 'students', {
  column: 'customer_id', values: enrollments.map(e => e.customer_id), select: 'customer_id, birthdate',
})
const birthdates = new Map(students.map(s => [s.customer_id, s.birthdate]))
const live = await loadDataArtsInput(sb, FY)

console.log(`${FY}: ${events.length.toLocaleString()} events, ${enrollments.length.toLocaleString()} enrollments, ${students.length.toLocaleString()} students`)
console.log(`Data Arts Input: ${live.missingTable ? 'table not created yet (migration 005)' : live.row ? 'entered' : 'not entered'}\n`)

const r = buildReport({ events, enrollments, birthdates, input: live.row })
const failures = []
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures.push(label)
  console.log(`  ${ok ? 'ok      ' : 'MISMATCH'} ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
}

// ─── independent second fetch: nested join, a different path to the same rows
const nested = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from('enrollments')
    .select('event_enrollment_id, customer_id, amount, total_discount, events(activity_type, is_virtual, all_meetings)')
    .eq('fiscal_year', FY).order('event_enrollment_id').range(from, from + 999)
  if (error) { console.error(error.message); process.exit(1) }
  nested.push(...data)
  if (data.length < 1000) break
}
const classEvents = events.filter(e => e.activity_type === 'CLASS')

console.log('=== 1. Online vs physical ===')
check('online + on-site lesson enrollments = all lesson enrollments',
  r.online.lessons.online + r.online.lessons.onsite, nested.filter(e => e.events?.activity_type === 'LESSON').length)
check('online lesson enrollments = stored is_virtual flag (set on upload from facility)',
  r.online.lessons.online, nested.filter(e => e.events?.activity_type === 'LESSON' && e.events.is_virtual).length)
check('online + on-site class sections = all class sections', r.online.classes.online + r.online.classes.onsite, classEvents.length)

console.log('\n=== 2. Group classes ===')
check('classes + camps = all class sections', r.groupClasses.regular.sections + r.groupClasses.camps.sections, classEvents.length)
const regularEvents = classEvents.filter(e => !isCamp(e))
const lawSeason = tp => String(tp ?? '').trim().toLowerCase().match(/^(summer|fall|winter|spring)/)?.[1]
check('every non-camp section has a recognisable quarter', regularEvents.filter(e => !lawSeason(e.time_period)).length, 0)
check('class weeks = Σ CMC quarter length over non-camp sections',
  r.groupClasses.regular.timesOffered, regularEvents.reduce((a, e) => a + (LAW_WEEKS[lawSeason(e.time_period)] ?? 0), 0))
check('quarter rows sum to non-camp sections', r.groupClasses.regular.byQuarter.reduce((a, q) => a + q.sections, 0), r.groupClasses.regular.sections)
check('quarter rows sum to class weeks', r.groupClasses.regular.byQuarter.reduce((a, q) => a + q.timesOffered, 0), r.groupClasses.regular.timesOffered)
check('times offered = class weeks + camp days', r.groupClasses.timesOffered, r.groupClasses.regular.timesOffered + r.groupClasses.camps.days)
// The camp rule's margin: the shortest non-camp section, from raw dates.
const spans = regularEvents.filter(e => e.class_start_date && e.class_end_date)
  .map(e => (Date.parse(e.class_end_date) - Date.parse(e.class_start_date)) / 864e5 + 1)
console.log(`  shortest non-camp section: ${Math.min(...spans)} days; sections without dates: ${r.groupClasses.regular.noDates}`)
for (const q of r.groupClasses.regular.byQuarter) console.log(`    ${q.time_period.padEnd(12)} ${String(q.sections).padStart(4)} sections × ${q.weeks} weeks = ${q.timesOffered}`)
// The weekday counter and camp rule against calendar facts rather than a second implementation.
check('weekdays Mon 2025-06-16 → Fri 2025-06-20 (Camp CMC)', weekdaysBetween('2025-06-16', '2025-06-20'), 5)
check('weekdays Mon 2025-06-30 → Thu 2025-07-03 (Mariachi Camp)', weekdaysBetween('2025-06-30', '2025-07-03'), 4)
check('weekdays Fri 2025-07-18 → Sun 2025-07-20', weekdaysBetween('2025-07-18', '2025-07-20'), 1)
check('weekdays across a weekend, Mon → next Fri', weekdaysBetween('2025-07-14', '2025-07-25'), 10)
const cls = (s, e, m) => ({ activity_type: 'CLASS', class_start_date: s, class_end_date: e, all_meetings: m })
check('Mon–Fri camp, ASAP 1 meeting → 5 days', campDays(cls('2025-06-16', '2025-06-20', 1)), 5)
check('Fri–Sun workshop, 3 meetings → 3 days', campDays(cls('2025-07-18', '2025-07-20', 3)), 3)
check('two-week Mon–Fri camp (12 days) is a camp → 10 days', campDays(cls('2025-07-14', '2025-07-25', 10)), 10)
check('14 days start to end is a camp', isCamp(cls('2025-07-14', '2025-07-27', 10)), true)
check('15 days start to end is not', isCamp(cls('2025-07-14', '2025-07-28', 11)), false)
check('a lesson is never a camp', isCamp({ ...cls('2025-07-14', '2025-07-18', 5), activity_type: 'LESSON' }), false)
check('placeholder end date is not a camp', isCamp(cls('2025-07-14', '2050-01-01', 5)), false)
console.log('  camps counted:')
for (const c of r.groupClasses.camps.rows) console.log(`    ${c.course.padEnd(28)} ${c.start} → ${c.end}   ASAP meetings ${String(c.meetings ?? '—').padStart(2)}   weekdays ${c.weekdays}   days ${c.days}`)

console.log('\n=== 3. Private lessons ===')
const nestedLessons = nested.filter(e => e.events?.activity_type === 'LESSON')
check('lesson enrollments (nested join)', r.privateLessons.enrollments, nestedLessons.length)
check('lessons = sum of All Meetings over lesson enrollments (nested join)',
  r.privateLessons.lessons, nestedLessons.reduce((a, e) => a + (e.events.all_meetings ?? 0), 0))
check('branch × quarter rows sum to the lesson total',
  r.privateLessons.byBranchQuarter.reduce((a, b) => a + b.lessons, 0), r.privateLessons.lessons)
check('branch × quarter rows sum to lesson enrollments',
  r.privateLessons.byBranchQuarter.reduce((a, b) => a + b.enrollments, 0), r.privateLessons.enrollments)

console.log('\n=== 4. Participation ===')
check('tuition-free + fee-based + unclassified = all enrollments',
  r.participation.tuitionFree + r.participation.feeBased + r.participation.unclassified, enrollments.length)
check('tuition-free = (amount − discount) ≤ 15, recomputed from raw amounts',
  r.participation.tuitionFree, nested.filter(e => (Number(e.amount) || 0) - (Number(e.total_discount) || 0) <= 15).length)

console.log('\n=== 5. Students 18 and under ===')
const a = r.youth.ages
check('18 and under + 19 and over + unknown = unique students', a.youth + a.older + a.unknown, a.total)
check('unique students (nested join)', a.total, new Set(nested.map(e => e.customer_id).filter(Boolean)).size)
check('every enrolled student has a students row', students.length, a.total)

// ─── 6. Data Arts Input arithmetic, with a synthetic input row ─────────────
// The live table may be empty, so the combining rules are exercised with known
// numbers: they must add exactly, and withhold totals while a field is blank.
console.log('\n=== 6. Combining with Data Arts Input (synthetic row) ===')
const sample = { partner_schools: 12, partner_classes: 30, partner_times_offered: 600, partner_students: 750,
  partner_instruction_hours: 412.5, paid_audience: 1800, free_audience: 2201 }
const s = buildReport({ events, enrollments, birthdates, input: sample })
check('free students = tuition-free enrollments + partner students', s.participation.freeStudents, r.participation.tuitionFree + 750)
check('audience estimate = round(60% × (paid + free))', s.youth.audienceYouth, Math.round(AUDIENCE_YOUTH_SHARE * 4001))
check('attendees 18 and under = students ≤18 + partner students + audience estimate', s.youth.total, a.youth + 750 + Math.round(0.6 * 4001))
check('partner hours passed through unrounded', s.partner.partner_instruction_hours, 412.5)
const partial = buildReport({ events, enrollments, birthdates, input: { ...sample, free_audience: null } })
check('blank free audience withholds the 18-and-under total', partial.youth.total, null)
check('blank free audience leaves free students intact', partial.participation.freeStudents, s.participation.freeStudents)
const none = buildReport({ events, enrollments, birthdates, input: null })
check('no input → free students withheld', none.participation.freeStudents, null)
check('no input → every field listed as missing', none.missingInput.length, 7)

// ─── the report as it renders ───────────────────────────────────────────────
console.log(`\n=== ${FY} Data Arts Report ===`)
for (const sec of reportSections(r)) {
  console.log(`\n${sec.title}`)
  for (const row of sec.rows) {
    const v = row.value == null ? '—' : row.value.toLocaleString()
    console.log(`  ${(row.top ? '' : '  ') + row.label}`.padEnd(58) + v.padStart(10) + `   ${row.source}${row.note ? `   [${row.note}]` : ''}`)
  }
}

console.log(`\n${failures.length ? `CHECKS FAILED: ${failures.join('; ')}` : 'ALL CHECKS PASSED'}`)
process.exit(failures.length ? 1 : 0)
