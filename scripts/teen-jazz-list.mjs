// List the unique Teen Jazz Orchestra students the LIYP report counts for a
// fiscal year (default FY26), with their enrollments, so the count can be
// reconciled against a hand-built list.
import { sb } from './db.mjs'

const FY = process.argv[2] ?? 'FY26'
const COURSE = 'Teen Jazz Orchestra'

const PAGE = 1000
let from = 0, rows = []
while (true) {
  const { data, error } = await sb
    .from('enrollments')
    .select(`
      event_enrollment_id, event_id, customer_id, fiscal_year, time_period,
      amount, total_discount, discount_type, is_tuition_free, instructor_name,
      events(course_name, class_start_date, class_end_date),
      students(first_name, last_name, birthdate, ethnicity)
    `)
    .eq('fiscal_year', FY)
    .range(from, from + PAGE - 1)
  if (error) { console.error(error); process.exit(1) }
  rows = rows.concat(data)
  if (data.length < PAGE) break
  from += PAGE
}

const teen = rows.filter(r => r.events?.course_name === COURSE)

const byStudent = new Map()
for (const r of teen) {
  if (!byStudent.has(r.customer_id)) byStudent.set(r.customer_id, [])
  byStudent.get(r.customer_id).push(r)
}

console.log(`${FY}: ${teen.length} Teen Jazz Orchestra enrollments, ${byStudent.size} unique customer_ids\n`)

const sorted = [...byStudent.entries()].sort((a, b) => {
  const sa = a[1][0].students ?? {}, sb_ = b[1][0].students ?? {}
  return `${sa.last_name} ${sa.first_name}`.localeCompare(`${sb_.last_name} ${sb_.first_name}`)
})

let i = 0
for (const [cid, es] of sorted) {
  const s = es[0].students ?? {}
  i++
  const bd = s.birthdate ?? '?'
  const start = es[0].events?.class_start_date
  let age = '?'
  if (bd !== '?' && start) {
    const [by, bm, bdd] = bd.split('-').map(Number)
    const [ry, rm, rd] = start.split('-').map(Number)
    age = ry - by - (rm < bm || (rm === bm && rd < bdd) ? 1 : 0)
  }
  console.log(
    `${String(i).padStart(2)}. ${s.first_name ?? '?'} ${s.last_name ?? '?'}  (customer_id ${cid}, born ${bd}, age ${age})`
  )
  for (const e of es) {
    console.log(
      `      ${e.time_period} | event ${e.event_id} | ${e.events?.class_start_date}→${e.events?.class_end_date}` +
      ` | $${e.amount} | disc $${e.total_discount} "${(e.discount_type ?? '').trim()}"` +
      ` | free=${e.is_tuition_free} | ${e.instructor_name ?? ''}`
    )
  }
}

// Name collisions / possible duplicate records
const byName = new Map()
for (const [cid, es] of byStudent) {
  const s = es[0].students ?? {}
  const key = `${(s.first_name ?? '').trim().toLowerCase()} ${(s.last_name ?? '').trim().toLowerCase()}`
  if (!byName.has(key)) byName.set(key, [])
  byName.get(key).push(cid)
}
const dupes = [...byName.entries()].filter(([, cids]) => cids.length > 1)
console.log(`\nUnique names: ${byName.size}`)
if (dupes.length) {
  console.log('Same name under multiple customer_ids:')
  for (const [n, cids] of dupes) console.log(`  ${n}: ${cids.join(', ')}`)
}

// Distinct events, in case the course name covers more sections than expected
const byEvent = new Map()
for (const r of teen) {
  const k = `${r.event_id}`
  if (!byEvent.has(k)) byEvent.set(k, { n: 0, tp: r.time_period, start: r.events?.class_start_date, instr: r.instructor_name })
  byEvent.get(k).n++
}
console.log('\nSections:')
for (const [id, v] of byEvent) console.log(`  event ${id} | ${v.tp} | ${v.start} | ${v.instr} | ${v.n} enrollments`)
