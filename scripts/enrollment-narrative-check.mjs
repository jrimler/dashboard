// Verifies the Enrollment Narrative report against the live database.
//
// This report is prose, which makes a wrong number easier to miss than in a
// table — a sentence reads as authoritative whatever it says. So rather than
// checking the shape of the output, this pulls every figure back out of the
// generated text and reconciles it against an independent count taken straight
// from the raw rows.
//
// Like the other check scripts it extracts the report's own pure-logic block
// and runs those exact functions; a reimplementation can agree with itself and
// still be wrong.
//
// Usage: node scripts/enrollment-narrative-check.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { sb } from './db.mjs'
// Imported directly rather than read back off the report, so the check confirms
// the narrative agrees with the shared rules instead of merely with itself.
import { familyOf } from '../src/reports/discountFamilies.js'
import { quarterSortKey } from '../src/utils/periodUtils.js'

const root       = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = join(root, 'src/reports/EnrollmentNarrative.jsx')
const reportDir  = join(root, 'src/reports')

const src   = readFileSync(reportPath, 'utf8')
const start = src.indexOf('// ─── pure logic')
const end   = src.indexOf('// ─── end pure logic')
if (start < 0 || end < 0) {
  console.error('Could not find the pure-logic markers in EnrollmentNarrative.jsx')
  process.exit(1)
}

// Carry the report's own relative imports, rewritten to absolute paths, so a
// name added to one of them can't leave this check behind.
const imports = [...src.matchAll(/^import\s*\{[^}]*\}\s*from\s*'(\.[^']*)'/gm)]
  .filter(m => !/lib\/supabase|utils\/fetchAll/.test(m[1]))
  .map(m => m[0].replace(`'${m[1]}'`, `'${resolve(reportDir, m[1])}.js'`.replace('.js.js', '.js')))

const modPath = join(mkdtempSync(join(tmpdir(), 'narr-check-')), 'narr.mjs')
writeFileSync(modPath, [...imports, src.slice(start, end)].join('\n'))
const R = await import(modPath)

// ─── load every enrollment (paginated — an unpaginated query caps at 1000) ──
async function fetchAll(table, columns) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).order(columns.split(',')[0].trim()).range(from, from + 999)
    if (error) { console.error(`${table}: ${error.message}`); process.exit(1) }
    out.push(...data)
    if (data.length < 1000) return out
  }
}

const enrollments = await fetchAll('enrollments', 'event_enrollment_id,event_id,customer_id,time_period,is_tuition_free,discount_type')
const events      = await fetchAll('events', 'event_id,location,activity_type,class_start_date')
const evById = new Map(events.map(e => [e.event_id, e]))

const byPeriod = {}
for (const e of enrollments) {
  if (!e.time_period) continue
  const ev = evById.get(e.event_id)
  ;(byPeriod[e.time_period] ??= []).push({
    cid:           e.customer_id,
    isTuitionFree: e.is_tuition_free,
    discountType:  e.discount_type,
    location:      ev?.location ?? null,
    activityType:  ev?.activity_type ?? null,
    classStart:    ev?.class_start_date ?? null,
  })
}
const totals = Object.fromEntries(Object.entries(byPeriod).map(([p, r]) => [p, r.length]))
const quarters = Object.keys(byPeriod).sort()
console.log(`Enrollments loaded: ${enrollments.length.toLocaleString()} across ${quarters.length} quarters\n`)

let failures = 0
const check = (ok, label) => { if (!ok) { failures++; console.log(`  FAIL  ${label}`) } }

// ─── 1. partitions reconcile, every quarter ─────────────────────────────────
// Each split must account for the whole quarter, or the prose would describe
// parts that don't add up to the total it just stated.
console.log('── Partitions reconcile to the quarter total ──')
for (const q of quarters) {
  const s = R.buildQuarterStats(byPeriod[q])
  check(s.fee.enr + s.free.enr === s.total.enr,        `${q}: fee + free != total`)
  check(s.lessons.enr + s.group.enr === s.total.enr,   `${q}: lessons + group != total`)
  check(s.mission.enr + s.richmond.enr === s.total.enr,`${q}: mission + richmond != total`)
  check(s.feeLessons.enr + s.feeGroup.enr === s.fee.enr,   `${q}: fee sub-cells != fee`)
  check(s.freeLessons.enr + s.freeGroup.enr === s.free.enr,`${q}: free sub-cells != free`)
  check(s.feeLessons.enr + s.freeLessons.enr === s.lessons.enr, `${q}: lesson sub-cells != lessons`)
  check(s.feeGroup.enr + s.freeGroup.enr === s.group.enr,       `${q}: group sub-cells != group`)
  // Branch breakdowns must partition their own branch, or the per-branch
  // paragraphs would describe parts that don't add up to the branch total.
  check(s.missionLessons.enr + s.missionGroup.enr === s.mission.enr,    `${q}: Mission lesson/group != Mission`)
  check(s.richmondLessons.enr + s.richmondGroup.enr === s.richmond.enr, `${q}: Richmond lesson/group != Richmond`)
  check(s.missionFree.enr + s.richmondFree.enr === s.free.enr,          `${q}: branch tuition-free != tuition-free`)
  // Unique students can't exceed enrollments, and a subset can't exceed its parent.
  check(s.total.stu <= s.total.enr, `${q}: unique students exceed enrollments`)
  check(s.free.stu <= s.total.stu && s.fee.stu <= s.total.stu, `${q}: subset students exceed total`)
}
console.log(`  ${quarters.length} quarters checked`)

// ─── 2. stats match an independent count off the raw rows ───────────────────
console.log('\n── buildQuarterStats vs. an independent recount ──')
for (const q of quarters) {
  const rows = byPeriod[q]
  const s = R.buildQuarterStats(rows)
  const ind = {
    total:    rows.length,
    fee:      rows.filter(r => !r.isTuitionFree).length,
    free:     rows.filter(r =>  r.isTuitionFree).length,
    lessons:  rows.filter(r => r.activityType === 'LESSON').length,
    group:    rows.filter(r => r.activityType === 'CLASS').length,
    mission:  rows.filter(r => r.location === 'Mission Branch').length,
    richmond: rows.filter(r => r.location === 'Richmond Branch').length,
  }
  for (const [k, v] of Object.entries(ind)) check(s[k].enr === v, `${q} ${k}: report ${s[k].enr} vs independent ${v}`)
  check(s.total.stu === new Set(rows.map(r => r.cid)).size, `${q}: unique student count`)
}
console.log(`  ${quarters.length} quarters × 7 metrics recounted`)

// ─── 3. every number in the prose is real ───────────────────────────────────
// The narrative is generated text, so this is the check that matters most:
// pull each figure back out of the sentences and confirm it appears in the
// stats the report was built from.
console.log('\n── Every figure in the generated prose traces to a real number ──')
const medians = R.seasonMedians(totals)
const statsByPeriod = Object.fromEntries(Object.entries(byPeriod).map(([p, r]) => [p, R.buildQuarterStats(r)]))
// Calendar order, using the app's own key — an alphabetical sort happens to
// agree within one season but not across them.
const ordered = [...quarters].sort((a, b) => quarterSortKey(a) - quarterSortKey(b))
let scanned = 0, quoted = 0

for (const q of ordered) {
  // The report derives both comparisons itself; the check uses that same
  // function rather than a copy, so the two cannot disagree about what a
  // summary was measured against.
  const { yoy: yoyP, seq: seqP } = R.comparisonsFor(q, quarters)
  const unit = p => p && byPeriod[p] ? { period: p, rows: byPeriod[p], stats: R.buildQuarterStats(byPeriod[p]) } : null
  const focus = unit(q)
  const yoy   = unit(yoyP)
  const seq   = unit(seqP)
  const nar   = R.buildNarrative({ focus, yoy, seq, medians, statsByPeriod })
  scanned++

  // Legal figures: any count or delta the report could correctly state.
  const legal = new Set()
  const add = v => { if (Number.isFinite(v)) legal.add(Math.abs(Math.round(v))) }
  for (const u of [focus, yoy, seq].filter(Boolean)) {
    for (const k of Object.keys(u.stats)) { add(u.stats[k].enr); add(u.stats[k].stu) }
  }
  if (yoy) for (const k of Object.keys(focus.stats)) {
    add(focus.stats[k].enr - yoy.stats[k].enr)
    add(focus.stats[k].stu - yoy.stats[k].stu)
  }
  if (seq) for (const k of Object.keys(focus.stats)) add(focus.stats[k].enr - seq.stats[k].enr)
  // Branch trends quote same-season values from other quarters, and their net
  // movement. Recomputed here off the raw rows, not read back from the report.
  for (const key of ['mission', 'richmond']) {
    const fq = q.match(/^(\w+) Quarter (\d{4})$/)
    const series = ordered
      .filter(p => {
        const m = p.match(/^(\w+) Quarter (\d{4})$/)
        return m && fq && m[1] === fq[1] && +m[2] <= +fq[2]
      })
      .map(p => byPeriod[p].filter(r => r.location === (key === 'mission' ? 'Mission Branch' : 'Richmond Branch')).length)
    series.forEach(add)
    if (series.length >= 3) {
      add(series.at(-1) - series[0])
      add(series.length)                       // "across the last N ... quarters"
      const steps = series.slice(1).map((v, i) => v - series[i])
      add(steps.filter(v => v > 0).length)     // "up in N"
      add(steps.filter(v => v < 0).length)     // "down in N"
    }
  }

  // Discount families, recomputed from the codes with the shared rules.
  const famCounts = p => {
    const out = {}
    for (const r of byPeriod[p]) {
      const code = (r.discountType ?? '').trim()
      if (!code) continue
      const f = familyOf(code)
      if (f === null) continue
      out[f] = (out[f] ?? 0) + 1
    }
    return out
  }
  {
    const cur = famCounts(q)
    Object.values(cur).forEach(add)
    add(Object.values(cur).reduce((a, b) => a + b, 0))
    add(Object.keys(cur).length)               // "across N program families"
    if (yoyP && byPeriod[yoyP]) {
      const prev = famCounts(yoyP)
      Object.values(prev).forEach(add)
      const prevTotal = Object.values(prev).reduce((a, b) => a + b, 0)
      add(prevTotal)
      add(Object.values(cur).reduce((a, b) => a + b, 0) - prevTotal)
      for (const f of new Set([...Object.keys(cur), ...Object.keys(prev)])) add((cur[f] ?? 0) - (prev[f] ?? 0))
    }
  }

  // Completeness sentence quotes a count of late enrollments; recompute it.
  if (yoy) {
    const md = s => s.slice(5)
    const latestFocus = focus.rows.map(r => r.classStart).filter(Boolean).sort().at(-1)
    if (latestFocus) add(yoy.rows.filter(r => r.classStart && md(r.classStart) > md(latestFocus)).length)
  }

  const text = nar.plainText

  // Strip everything that carries digits but isn't a count: quarter names
  // ("Winter Quarter 2026"), percentages (checked separately below, and their
  // integer part must not be read as a count), and the MM-DD in the
  // completeness sentence. What remains is data claims only.
  const counts = text
    .replace(/\w+ Quarter \d{4}/g, ' ')
    .replace(/\d+(?:\.\d+)?%/g, ' ')
    .replace(/after \d{2}-\d{2}/g, ' ')
  for (const m of counts.matchAll(/\d[\d,]*/g)) {
    const v = Number(m[0].replace(/,/g, ''))
    quoted++
    check(legal.has(v), `${q}: prose states ${v}, which is not a count or delta of this quarter — "${counts.slice(Math.max(0, m.index - 70), m.index + 40).replace(/\n/g, ' ')}"`)
  }

  // Percentages must equal a real ratio, to one decimal.
  const legalPct = new Set()
  const addPct = (a, b) => { if (b) legalPct.add(Math.abs((a / b) * 100).toFixed(1)) }
  for (const u of [focus, yoy, seq].filter(Boolean)) {
    for (const k of Object.keys(u.stats)) addPct(u.stats[k].enr, u.stats.total.enr)
  }
  if (yoy) for (const k of Object.keys(focus.stats)) {
    addPct(focus.stats[k].enr - yoy.stats[k].enr, yoy.stats[k].enr)
    addPct(focus.stats[k].stu - yoy.stats[k].stu, yoy.stats[k].stu)
  }
  if (seq) for (const k of Object.keys(focus.stats)) addPct(focus.stats[k].enr - seq.stats[k].enr, seq.stats[k].enr)
  for (const key of ['mission', 'richmond']) {
    const fq = q.match(/^(\w+) Quarter (\d{4})$/)
    const series = ordered
      .filter(p => { const m = p.match(/^(\w+) Quarter (\d{4})$/); return m && fq && m[1] === fq[1] && +m[2] <= +fq[2] })
      .map(p => byPeriod[p].filter(r => r.location === (key === 'mission' ? 'Mission Branch' : 'Richmond Branch')).length)
    if (series.length >= 3) addPct(series.at(-1) - series[0], series[0])
  }
  {
    const cur = famCounts(q)
    const curTotal = Object.values(cur).reduce((a, b) => a + b, 0)
    addPct(curTotal, focus.stats.total.enr)
    if (yoyP && byPeriod[yoyP]) {
      const prev = famCounts(yoyP)
      const prevTotal = Object.values(prev).reduce((a, b) => a + b, 0)
      addPct(curTotal - prevTotal, prevTotal)
      for (const f of new Set([...Object.keys(cur), ...Object.keys(prev)])) addPct((cur[f] ?? 0) - (prev[f] ?? 0), prev[f] ?? 0)
    }
  }
  for (const m of text.matchAll(/(\d+\.\d)%/g)) {
    quoted++
    check(legalPct.has(m[1]), `${q}: prose states ${m[1]}%, which is not a ratio of this quarter's numbers`)
  }
}
console.log(`  ${scanned} quarters narrated, ${quoted} figures traced`)

// ─── 4. thresholds behave ───────────────────────────────────────────────────
console.log('\n── Suppression rules ──')
{
  // Fixtures are built from synthetic ROWS and run through buildQuarterStats,
  // not hand-written stats objects: a hand-written one silently goes stale the
  // moment a metric is added, which is exactly what happened when the branch
  // breakdowns landed.
  const rows = (n, { free = false, lesson = true, mission = true } = {}) =>
    Array.from({ length: n }, (_, i) => ({
      cid: `s${i}`,
      isTuitionFree: free,
      discountType: null,
      location: mission ? 'Mission Branch' : 'Richmond Branch',
      activityType: lesson ? 'LESSON' : 'CLASS',
      classStart: null,
    }))
  const unit = (period, rs) => ({ period, rows: rs, stats: R.buildQuarterStats(rs) })

  // A percentage on a tiny base must not appear: 6 -> 9 tuition-free is +50%.
  const small = R.buildNarrative({
    focus: unit('Fall Quarter 2026', [...rows(9, { free: true }), ...rows(1)]),
    yoy:   unit('Fall Quarter 2025', [...rows(6, { free: true }), ...rows(4)]),
    seq: null, medians: {},
  })
  check(!/50\.0%/.test(small.plainText), 'percentage quoted on a base below the minimum')

  // An identical quarter reads as unchanged, not as a movement.
  const same = R.buildNarrative({
    focus: unit('Fall Quarter 2026', rows(1000)),
    yoy:   unit('Fall Quarter 2025', rows(1000)),
    seq: null, medians: {},
  })
  check(/unchanged/.test(same.plainText), 'a quarter identical to the last does not read as unchanged')
  check(!/grew by|fell by/.test(same.plainText), 'an unchanged quarter is described as moving')

  // A trend needs at least three points; two must not produce one.
  const twoPoint = R.sameSeasonSeries('Fall Quarter 2026',
    { 'Fall Quarter 2025': R.buildQuarterStats(rows(10)), 'Fall Quarter 2026': R.buildQuarterStats(rows(20)) }, 'mission')
  check(R.trendPhrase(twoPoint) === null, 'a two-point series produced a trend sentence')
}
console.log('  small-base percentages suppressed; unchanged quarters read as unchanged')

// ─── 5. the comparison pair is the standard one, every quarter ──────────────
// Both comparisons are fixed rather than chosen, so every summary has the same
// shape. That only holds if the derivation is right for all 18 quarters.
console.log('\n── Comparison quarters are the standard pair ──')
for (const q of ordered) {
  const { yoy, seq } = R.comparisonsFor(q, quarters)
  const m = q.match(/^(\w+) Quarter (\d{4})$/)
  const expectedYoy = `${m[1]} Quarter ${+m[2] - 1}`
  check(yoy === (quarters.includes(expectedYoy) ? expectedYoy : null),
    `${q}: year-over-year comparison is ${yoy}, expected ${expectedYoy}`)
  const earlier = ordered.filter(p => quarterSortKey(p) < quarterSortKey(q))
  check(seq === (earlier.at(-1) ?? null),
    `${q}: previous-quarter comparison is ${seq}, expected ${earlier.at(-1) ?? 'none'}`)
}
{
  const fall = R.comparisonsFor('Fall Quarter 2026', quarters)
  check(fall.yoy === 'Fall Quarter 2025' && fall.seq === 'Summer Quarter 2026',
    `Fall Quarter 2026 pairs with ${fall.yoy} / ${fall.seq}`)
  const earliest = R.comparisonsFor(ordered[0], quarters)
  check(earliest.seq === null, 'the earliest quarter on file was given a previous quarter')
  console.log(`  Fall Quarter 2026 -> ${fall.yoy} (year over year) · ${fall.seq} (previous quarter)`)
  console.log(`  ${ordered.length} quarters, each pairing verified`)
}

// ─── 6. seasonal caveat fires only across differently sized seasons ─────────
console.log('\n── Seasonal caveat ──')
{
  const sameSeason = R.seasonalCaveat('Fall Quarter 2026', 'Fall Quarter 2025', medians)
  check(sameSeason === null, 'caveat raised for two quarters of the same season')
  const summerFall = R.seasonalCaveat('Fall Quarter 2026', 'Summer Quarter 2026', medians)
  check(typeof summerFall === 'string', 'no caveat raised comparing a fall quarter with a summer one')
  if (summerFall) console.log(`  ${summerFall}`)
  console.log('  season medians: ' + Object.entries(medians).map(([s, v]) => `${s} ${v}`).join(' · '))
}

// ─── report ─────────────────────────────────────────────────────────────────
console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nAll checks passed.\n')
process.exit(failures ? 1 : 0)
