import { sb } from './db.mjs'

const SLIDING_RE = /(?:^|[ _])Child\d+(?:[ _]|$)/
function ageAtDate(bd, ref) {
  if (!bd || !ref) return null
  const [by, bm, bd2] = bd.split('-').map(Number)
  const [ry, rm, rd] = ref.split('-').map(Number)
  let a = ry - by; if (rm < bm || (rm === bm && rd < bd2)) a--; return a
}

const PAGE = 1000
let from = 0, all = []
while (true) {
  const { data } = await sb.from('enrollments')
    .select('customer_id, fiscal_year, time_period, discount_type, events(class_start_date), students(birthdate)')
    .range(from, from + PAGE - 1)
  all = all.concat(data)
  if (data.length < PAGE) break
  from += PAGE
}

const isSliding = e => SLIDING_RE.test(e.discount_type ?? '')
const isYouth = e => {
  const a = ageAtDate(e.students?.birthdate, e.events?.class_start_date)
  return a !== null && a >= 4 && a <= 18
}
const fys = [...new Set(all.map(e => e.fiscal_year).filter(Boolean))].sort()

console.log('=== Sliding-scale by fiscal year ===')
console.log('FY     youth(4-18)  anyAge   applications   allEnroll(FY)')
for (const fy of fys) {
  const rows = all.filter(e => e.fiscal_year === fy)
  const sl = rows.filter(isSliding)
  const youth = new Set(sl.filter(isYouth).map(e => e.customer_id))
  const anyAge = new Set(sl.map(e => e.customer_id))
  console.log(`${fy}      ${String(youth.size).padStart(4)}       ${String(anyAge.size).padStart(4)}      ${String(sl.length).padStart(5)}         ${String(rows.length).padStart(5)}`)
}

console.log('\n=== FY25 vs FY26 sliding youth, by quarter ===')
for (const fy of ['FY25', 'FY26']) {
  console.log(`\n${fy}:`)
  const rows = all.filter(e => e.fiscal_year === fy)
  const tps = [...new Set(rows.map(e => e.time_period).filter(Boolean))].sort()
  for (const tp of tps) {
    const q = rows.filter(e => e.time_period === tp)
    const slYouth = new Set(q.filter(e => isSliding(e) && isYouth(e)).map(e => e.customer_id))
    const slApp = q.filter(isSliding).length
    console.log(`  ${tp.padEnd(20)} allEnroll=${String(q.length).padStart(5)}  slidingApps=${String(slApp).padStart(4)}  youthStudents=${slYouth.size}`)
  }
}

console.log('\n=== FY26 sliding codes vs FY25 (application counts) ===')
for (const fy of ['FY25', 'FY26']) {
  const sl = all.filter(e => e.fiscal_year === fy && isSliding(e))
  const codes = {}
  for (const e of sl) { const k = e.discount_type; codes[k] = (codes[k]||0)+1 }
  console.log(`\n${fy}:`)
  for (const [k,v] of Object.entries(codes).sort()) console.log(`  ${String(v).padStart(4)}  ${k}`)
}
