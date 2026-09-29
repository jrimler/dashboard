// Ad-hoc: figures for the FY25–FY26 review of Mission Branch fee-based group
// classes (a one-time document, not a dashboard report). Re-run to reproduce
// every number quoted in it.
//
// Definitions match the Enrollment page's Mission "Fee Based — Group Classes"
// row: location = Mission Branch, activity_type = CLASS, is_tuition_free = false.
import { sb } from './db.mjs'
import { fetchAll, fetchByIds, joinBy } from '../src/utils/fetchAll.js'
import { quarterSortKey } from '../src/utils/periodUtils.js'

const FYS = ['FY25', 'FY26']
const SEASONS = ['Summer', 'Fall', 'Winter', 'Spring']
const MISSION = 'Mission Branch'

// Every enrollment on file — new-vs-returning needs history before the window.
const enr = await fetchAll(sb, 'enrollments', {
  select: 'event_enrollment_id, event_id, customer_id, time_period, fiscal_year, is_tuition_free',
  orderBy: 'event_enrollment_id',
})
const events = await fetchAll(sb, 'events', {
  select: 'event_id, location, activity_type, course_name, department',
  orderBy: 'event_id',
})
joinBy(enr, events, { on: 'event_id', as: 'ev' })
const orphans = enr.filter(e => !e.ev).length
if (orphans) throw new Error(`${orphans} enrollments have no event`)

const isMGF = e => e.ev.location?.trim() === MISSION && e.ev.activity_type === 'CLASS' && !e.is_tuition_free
const mgf = enr.filter(isMGF)
const inFY = fy => mgf.filter(e => e.fiscal_year === fy)
const inQ = q => mgf.filter(e => e.time_period === q)
const uniq = (rows, k = 'customer_id') => new Set(rows.map(r => r[k]))
const pct = (a, b) => b ? `${((a - b) / b * 100).toFixed(1)}%` : '—'
const sign = v => (v > 0 ? '+' : '') + v

// Reconcile the three-way split of all Mission CLASS rows in the window.
const win = enr.filter(e => FYS.includes(e.fiscal_year) && e.ev.location?.trim() === MISSION && e.ev.activity_type === 'CLASS')
const winFee = win.filter(e => !e.is_tuition_free).length, winFree = win.filter(e => e.is_tuition_free).length
console.log(`\nReconcile: Mission CLASS rows FY25+FY26 ${win.length} = fee ${winFee} + free ${winFree} (${winFee + winFree === win.length ? 'OK' : 'MISMATCH'})`)
const mgfWin = mgf.filter(e => FYS.includes(e.fiscal_year)).length
console.log(`fee rows in window ${mgfWin} = FY25 ${inFY('FY25').length} + FY26 ${inFY('FY26').length}`)
// Every quarter row is in exactly one FY of the window and one quarter.
const qs = [...new Set(mgf.filter(e => FYS.includes(e.fiscal_year)).map(e => e.time_period))].sort((a, b) => quarterSortKey(a) - quarterSortKey(b))
console.log('quarters in window:', qs.join(', '))

// ── Fiscal year + quarter table ────────────────────────────────────────────
function stats(rows) {
  const sections = uniq(rows, 'event_id').size
  return { enr: rows.length, stu: uniq(rows).size, sections, perSection: sections ? rows.length / sections : 0 }
}
const line = (label, a, b) =>
  console.log(`${label.padEnd(22)} enr ${a.enr} → ${b.enr} (${sign(b.enr - a.enr)}, ${pct(b.enr, a.enr)}) | stu ${a.stu} → ${b.stu} (${sign(b.stu - a.stu)}, ${pct(b.stu, a.stu)}) | sections ${a.sections} → ${b.sections} (${sign(b.sections - a.sections)}) | per section ${a.perSection.toFixed(1)} → ${b.perSection.toFixed(1)}`)

console.log('\n── FY25 vs FY26 ──')
line('Fiscal year', stats(inFY('FY25')), stats(inFY('FY26')))
console.log('\n── Same quarter, year over year ──')
for (const s of SEASONS) {
  const [y1, y2] = s === 'Summer' || s === 'Fall' ? [2024, 2025] : [2025, 2026]
  line(`${s} ${y1}→${y2}`, stats(inQ(`${s} Quarter ${y1}`)), stats(inQ(`${s} Quarter ${y2}`)))
}
const quarterSum = FYS.map(fy => qs.filter(q => inQ(q)[0]?.fiscal_year === fy).reduce((s, q) => s + inQ(q).length, 0))
console.log('quarter enrollments sum to FY:', quarterSum.join(' / '))

// Earlier years for context (not in the window, but shows the run-up).
console.log('\n── Context: all FYs on file ──')
for (const fy of [...new Set(mgf.map(e => e.fiscal_year))].sort()) {
  const s = stats(inFY(fy)); const quarters = new Set(inFY(fy).map(e => e.time_period)).size
  console.log(`${fy}: ${s.enr} enr, ${s.stu} stu, ${s.sections} sections, ${quarters} quarters`)
}

// ── Class-size distribution ────────────────────────────────────────────────
console.log('\n── Section size (fee-based enrollments per section) ──')
for (const fy of FYS) {
  const bySec = {}; for (const e of inFY(fy)) bySec[e.event_id] = (bySec[e.event_id] ?? 0) + 1
  const v = Object.values(bySec).sort((a, b) => a - b)
  const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
  const small = v.filter(x => x < 5).length
  console.log(`${fy}: ${v.length} sections, median ${med}, under 5 fee-based students: ${small}, 15+: ${v.filter(x => x >= 15).length}`)
}

// ── More sections, or fuller sections? ─────────────────────────────────────
// Splits the FY change into: extra sections at FY25's average size, plus the
// change in average size across FY26's sections. The two parts sum exactly.
{
  const a = stats(inFY('FY25')), b = stats(inFY('FY26'))
  const fromSections = (b.sections - a.sections) * a.perSection
  const fromSize = b.sections * (b.perSection - a.perSection)
  console.log(`\nBridge: ${a.enr} + ${fromSections.toFixed(1)} (more sections) + ${fromSize.toFixed(1)} (fuller sections) = ${(a.enr + fromSections + fromSize).toFixed(1)} vs ${b.enr}`)
  // Whole-class size, counting the tuition-free students in those same sections.
  for (const fy of FYS) {
    const secs = uniq(inFY(fy), 'event_id')
    const all = enr.filter(e => e.fiscal_year === fy && secs.has(e.event_id))
    console.log(`${fy}: ${all.length} enrollments of any tuition status in those ${secs.size} sections (${(all.length / secs.size).toFixed(1)} per section)`)
  }
}

// ── Departments ────────────────────────────────────────────────────────────
// Same folding the Board report applies: ASAP has filed string sections under
// "Violin" as well as "Strings". The only blank-department sections here are
// YMP's paying (CMP) families, so they are named rather than left as "(blank)".
const DEPARTMENT_ALIASES = { violin: 'Strings' }
function keyOf(e, key) {
  const v = (e.ev[key] ?? '').trim()
  if (key !== 'department') return v || '(blank)'
  if (!v) return /young musicians program/i.test(e.ev.course_name ?? '') ? 'YMP (paying families)' : '(blank)'
  return DEPARTMENT_ALIASES[v.toLowerCase()] ?? v
}
function groupBy(fy, key) {
  const out = {}
  for (const e of inFY(fy)) {
    const k = keyOf(e, key)
    ;(out[k] ??= { enr: 0, stu: new Set(), sec: new Set() })
    out[k].enr++; out[k].stu.add(e.customer_id); out[k].sec.add(e.event_id)
  }
  return out
}
for (const key of ['department', 'course_name']) {
  const a = groupBy('FY25', key), b = groupBy('FY26', key)
  const rows = [...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => ({
    k, e1: a[k]?.enr ?? 0, e2: b[k]?.enr ?? 0, s1: a[k]?.sec.size ?? 0, s2: b[k]?.sec.size ?? 0,
    u1: a[k]?.stu.size ?? 0, u2: b[k]?.stu.size ?? 0,
  }))
  const sumA = rows.reduce((s, r) => s + r.e1, 0), sumB = rows.reduce((s, r) => s + r.e2, 0)
  console.log(`\n── By ${key} (sums ${sumA} / ${sumB}) ──`)
  const sorted = key === 'department' ? rows.sort((x, y) => y.e2 - x.e2) : rows.sort((x, y) => (y.e2 - y.e1) - (x.e2 - x.e1))
  const show = key === 'department' ? sorted : [...sorted.slice(0, 12), { k: '…' }, ...sorted.slice(-12)]
  for (const r of show) {
    if (r.k === '…') { console.log('  …'); continue }
    console.log(`  ${r.k.slice(0, 55).padEnd(56)} ${String(r.e1).padStart(4)} → ${String(r.e2).padStart(4)} (${sign(r.e2 - r.e1)})  sec ${r.s1}→${r.s2}  stu ${r.u1}→${r.u2}`)
  }
  if (key === 'course_name') {
    console.log(`  courses: FY25 ${rows.filter(r => r.e1).length}, FY26 ${rows.filter(r => r.e2).length}, only FY25 ${rows.filter(r => r.e1 && !r.e2).length} (${rows.filter(r => r.e1 && !r.e2).reduce((s, r) => s + r.e1, 0)} enr), only FY26 ${rows.filter(r => r.e2 && !r.e1).length} (${rows.filter(r => r.e2 && !r.e1).reduce((s, r) => s + r.e2, 0)} enr)`)
  }
}

// ── New vs returning ───────────────────────────────────────────────────────
// For each FY cohort (unique students with a Mission fee-based group class
// enrollment that year), classify each student once, by their history BEFORE
// the fiscal year starts:
//   returning   — had a Mission fee-based group class in the previous FY
//   came back   — had one before, but not in the previous FY
//   new to MGF, not to CMC — earlier CMC enrollment of some other kind only
//   new to CMC  — no enrollment of any kind on file before this FY
const fyKey = fy => Number(fy.slice(2))
const firstFY = [...new Set(enr.map(e => e.fiscal_year))].sort()[0]
console.log(`\n── New vs returning (history on file from ${firstFY}) ──`)
for (const fy of FYS) {
  const cohort = uniq(inFY(fy)), prev = `FY${fyKey(fy) - 1}`
  const mgfBefore = new Set(mgf.filter(e => fyKey(e.fiscal_year) < fyKey(fy)).map(e => e.customer_id))
  const mgfPrev = uniq(inFY(prev))
  const anyBefore = new Set(enr.filter(e => fyKey(e.fiscal_year) < fyKey(fy)).map(e => e.customer_id))
  const c = { returning: 0, cameBack: 0, newToMgf: 0, newToCmc: 0 }
  for (const id of cohort) {
    if (mgfPrev.has(id)) c.returning++
    else if (mgfBefore.has(id)) c.cameBack++
    else if (anyBefore.has(id)) c.newToMgf++
    else c.newToCmc++
  }
  const tot = Object.values(c).reduce((a, b) => a + b, 0)
  console.log(`${fy}: cohort ${cohort.size} = ${JSON.stringify(c)} sum ${tot} ${tot === cohort.size ? 'OK' : 'MISMATCH'}`)
  console.log(`   shares: ${Object.entries(c).map(([k, v]) => `${k} ${(v / tot * 100).toFixed(1)}%`).join(', ')}`)
  const kept = [...mgfPrev].filter(id => cohort.has(id)).length
  console.log(`   of ${prev}'s ${mgfPrev.size} students, ${kept} came back in ${fy} (${(kept / mgfPrev.size * 100).toFixed(1)}%)`)
}

// Unique students per quarter, how many were in the cohort that quarter for the first time ever at CMC
console.log('\n── New to CMC, by quarter ──')
const firstKey = {}
for (const e of enr) { const k = quarterSortKey(e.time_period); if (k && (!firstKey[e.customer_id] || k < firstKey[e.customer_id])) firstKey[e.customer_id] = k }
for (const q of qs) {
  const ids = uniq(inQ(q)), k = quarterSortKey(q)
  const nw = [...ids].filter(id => firstKey[id] === k).length
  console.log(`${q}: ${ids.size} students, ${nw} first-ever CMC quarter (${(nw / ids.size * 100).toFixed(1)}%)`)
}
