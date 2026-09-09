import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { fetchAll, fetchByIds, joinBy } from '../utils/fetchAll'
import { quarterSortKey, parseQuarter, quarterFYLabel, classStartDate } from '../utils/periodUtils'

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment Narrative
//
// The Enrollment page answers "what were the numbers?" as a table. This report
// answers the same question in prose: what a person would write after reading
// that table, generated from the same partitions so the two cannot disagree.
//
// Every sentence is assembled from the numbers by rule — there is no language
// model here and no judgement about causes. The report says what moved and by
// how much; it never says why. That is what makes it safe to paste into a board
// memo without re-checking each figure.
// ─────────────────────────────────────────────────────────────────────────────

// ─── pure logic (verified by scripts/enrollment-narrative-check.mjs) ─────────

const MISSION = 'Mission Branch', RICHMOND = 'Richmond Branch'

// The metrics the prose can talk about. These mirror the Enrollment page's rows
// exactly — same filters, same partitions — so a number quoted here is the same
// number that page shows for the same quarter.
const METRICS = [
  { key: 'total',        label: 'total enrollments',   f: null },
  { key: 'fee',          label: 'fee-based',           f: e => !e.isTuitionFree },
  { key: 'free',         label: 'tuition-free',        f: e =>  e.isTuitionFree },
  { key: 'lessons',      label: 'private lessons',     f: e => e.activityType === 'LESSON' },
  { key: 'group',        label: 'group classes',       f: e => e.activityType === 'CLASS' },
  { key: 'mission',      label: 'Mission Branch',      f: e => e.location === MISSION },
  { key: 'richmond',     label: 'Richmond Branch',     f: e => e.location === RICHMOND },
  { key: 'feeLessons',   label: 'fee-based lessons',        f: e => !e.isTuitionFree && e.activityType === 'LESSON' },
  { key: 'feeGroup',     label: 'fee-based group classes',  f: e => !e.isTuitionFree && e.activityType === 'CLASS' },
  { key: 'freeLessons',  label: 'tuition-free lessons',       f: e =>  e.isTuitionFree && e.activityType === 'LESSON' },
  { key: 'freeGroup',    label: 'tuition-free group classes', f: e =>  e.isTuitionFree && e.activityType === 'CLASS' },
]

// Sub-metrics scanned for the "notable movements" paragraph. The headline rows
// (total, and the branch/type splits already covered in their own paragraphs)
// are left out so that paragraph adds something rather than repeating.
const MOVER_KEYS = ['feeLessons', 'feeGroup', 'freeLessons', 'freeGroup', 'mission', 'richmond']

// Below this many enrollments a percentage swing is noise — three enrollments on
// a base of six is "+50%", which reads as a trend and isn't one. Under it the
// prose gives counts only.
const MIN_BASE_FOR_PCT = 25

// Movements smaller than this in both absolute and relative terms are described
// as flat rather than given a direction.
const FLAT_PCT = 1.5
const FLAT_RAW = 10

function statsFor(rows) {
  return { enr: rows.length, stu: new Set(rows.map(r => r.cid)).size }
}

// All metrics for one quarter's rows.
export function buildQuarterStats(rows) {
  const out = {}
  for (const m of METRICS) out[m.key] = statsFor(m.f ? rows.filter(m.f) : rows)
  return out
}

function delta(from, to) {
  const raw = to - from
  return { raw, pct: from === 0 ? null : (raw / from) * 100, from, to }
}

// ─── phrasing ───────────────────────────────────────────────────────────────

const n = v => v.toLocaleString()

function pctText(d) {
  if (d.pct === null) return null
  if (d.from < MIN_BASE_FOR_PCT) return null
  return `${Math.abs(d.pct).toFixed(1)}%`
}

// "grew by 46 (+4.3%)" / "fell by 92 (7.8%)" / "held steady"
function movementPhrase(d, { verbUp = 'grew', verbDown = 'fell' } = {}) {
  if (d.raw === 0) return 'was unchanged'
  const flat = Math.abs(d.raw) < FLAT_RAW && d.pct !== null && Math.abs(d.pct) < FLAT_PCT
  if (flat) return `held roughly steady (${d.raw > 0 ? '+' : '−'}${n(Math.abs(d.raw))})`
  const verb = d.raw > 0 ? verbUp : verbDown
  const pct = pctText(d)
  return pct ? `${verb} by ${n(Math.abs(d.raw))} (${pct})` : `${verb} by ${n(Math.abs(d.raw))}`
}

function shareText(part, whole) {
  if (!whole) return null
  return `${((part / whole) * 100).toFixed(1)}%`
}

// ─── seasonal scale ─────────────────────────────────────────────────────────

// Summer terms are genuinely shorter, so a summer-to-fall comparison mostly
// measures the calendar. Rather than hardcoding that, the typical size of each
// season is measured from every quarter on file and the caveat is raised only
// when two seasons actually differ in scale.
const SEASON_SCALE_TOLERANCE = 0.15

export function seasonMedians(quarterTotals) {
  const bySeason = {}
  for (const [period, total] of Object.entries(quarterTotals)) {
    const q = parseQuarter(period)
    if (!q) continue
    ;(bySeason[q.season] ??= []).push(total)
  }
  const out = {}
  for (const [season, vals] of Object.entries(bySeason)) {
    const sorted = [...vals].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    out[season] = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }
  return out
}

// Returns a caveat sentence when the two quarters' seasons are structurally
// different sizes, or null when they are comparable.
export function seasonalCaveat(periodA, periodB, medians) {
  const a = parseQuarter(periodA), b = parseQuarter(periodB)
  if (!a || !b || a.season === b.season) return null
  const ma = medians[a.season], mb = medians[b.season]
  if (!ma || !mb) return null
  const ratio = mb / ma
  if (Math.abs(ratio - 1) < SEASON_SCALE_TOLERANCE) return null
  const pct = Math.round(ratio * 100)
  return `${b.season} terms have historically run about ${pct}% the size of ${a.season} terms, ` +
         `so most of that difference is the shape of the calendar rather than a change in demand.`
}

// ─── completeness ───────────────────────────────────────────────────────────

// A quarter pulled from ASAP mid-term is missing its later-starting sections.
// Detected the same way scripts/quarter-audit.mjs does it: if the comparison
// quarter a year earlier ran sections that started later in the term than
// anything in the focus quarter, this one is probably still filling.
export function completenessCaveat(focusRows, priorRows) {
  const latest = rows => rows.map(r => classStartDate(r.classStart)).filter(Boolean).sort().at(-1)
  const focusLatest = latest(focusRows), priorLatest = latest(priorRows)
  if (!focusLatest || !priorLatest) return null
  const focusMd = focusLatest.slice(5), priorMd = priorLatest.slice(5)
  if (priorMd <= focusMd) return null
  const late = priorRows.filter(r => {
    const d = classStartDate(r.classStart)
    return d && d.slice(5) > focusMd
  }).length
  if (!late) return null
  return `The comparison quarter ran ${n(late)} enrollment${late === 1 ? '' : 's'} in sections that started ` +
         `later in the term than anything in this one (after ${focusMd}). If this term is still under way, ` +
         `expect these figures to grow — re-upload once late-starting classes are in ASAP.`
}

// ─── the narrative ──────────────────────────────────────────────────────────

/**
 * Build the report. Every argument is plain data, so this is fully testable
 * without a browser.
 *
 * @param focus  { period, stats, rows }
 * @param yoy    { period, stats, rows } | null — same quarter, earlier year
 * @param seq    { period, stats }       | null — another quarter to compare
 * @param medians  season → median quarter total, from seasonMedians()
 */
export function buildNarrative({ focus, yoy, seq, medians }) {
  const paras = []
  const F = focus.stats

  // 1 ── headline
  {
    const s = [`${focus.period} recorded ${n(F.total.enr)} enrollments from ${n(F.total.stu)} unique students.`]
    if (yoy) {
      const d  = delta(yoy.stats.total.enr, F.total.enr)
      const ds = delta(yoy.stats.total.stu, F.total.stu)
      s.push(`Against ${yoy.period}, enrollments ${movementPhrase(d)}, from ${n(d.from)}.`)
      s.push(`Unique students ${movementPhrase(ds)}, from ${n(ds.from)}.`)
    }
    if (seq) {
      const d = delta(seq.stats.total.enr, F.total.enr)
      s.push(`Against ${seq.period}, enrollments ${movementPhrase(d)}.`)
      const caveat = seasonalCaveat(focus.period, seq.period, medians)
      if (caveat) s.push(caveat)
    }
    paras.push({ id: 'headline', title: 'Overall', sentences: s })
  }

  // 2 ── tuition mix
  {
    const s = []
    const freeShare = shareText(F.free.enr, F.total.enr)
    s.push(`${n(F.free.enr)} enrollments were tuition-free${freeShare ? `, ${freeShare} of the quarter` : ''}, ` +
           `and ${n(F.fee.enr)} were fee-based.`)
    if (yoy) {
      const df = delta(yoy.stats.free.enr, F.free.enr)
      const dp = delta(yoy.stats.fee.enr,  F.fee.enr)
      s.push(`Year over year, tuition-free ${movementPhrase(df)} and fee-based ${movementPhrase(dp)}.`)
      const prevShare = shareText(yoy.stats.free.enr, yoy.stats.total.enr)
      if (freeShare && prevShare && freeShare !== prevShare) {
        s.push(`The tuition-free share moved from ${prevShare} to ${freeShare}.`)
      }
    }
    paras.push({ id: 'tuition', title: 'Tuition assistance', sentences: s })
  }

  // 3 ── lessons vs group classes
  {
    const s = [`Private lessons accounted for ${n(F.lessons.enr)} enrollments and group classes ${n(F.group.enr)}.`]
    if (yoy) {
      const dl = delta(yoy.stats.lessons.enr, F.lessons.enr)
      const dg = delta(yoy.stats.group.enr,   F.group.enr)
      s.push(`Compared with ${yoy.period}, lessons ${movementPhrase(dl)} and group classes ${movementPhrase(dg)}.`)
      if (Math.sign(dl.raw) !== Math.sign(dg.raw) && dl.raw !== 0 && dg.raw !== 0) {
        s.push(`The two moved in opposite directions, so the quarter's total understates the shift between them.`)
      }
    }
    paras.push({ id: 'type', title: 'Lessons and group classes', sentences: s })
  }

  // 4 ── branches
  {
    const s = []
    const ms = shareText(F.mission.enr, F.total.enr), rs = shareText(F.richmond.enr, F.total.enr)
    s.push(`Mission Branch carried ${n(F.mission.enr)} enrollments${ms ? ` (${ms})` : ''} ` +
           `and Richmond Branch ${n(F.richmond.enr)}${rs ? ` (${rs})` : ''}.`)
    if (yoy) {
      const dm = delta(yoy.stats.mission.enr,  F.mission.enr)
      const dr = delta(yoy.stats.richmond.enr, F.richmond.enr)
      s.push(`Year over year Mission ${movementPhrase(dm)} and Richmond ${movementPhrase(dr)}.`)
    }
    paras.push({ id: 'branch', title: 'Branches', sentences: s })
  }

  // 5 ── notable movements
  if (yoy) {
    const moves = MOVER_KEYS
      .map(key => {
        const m = METRICS.find(x => x.key === key)
        const d = delta(yoy.stats[key].enr, F[key].enr)
        return { label: m.label, d }
      })
      // Rank by absolute change, but only keep movements big enough to mean
      // something on their own base — otherwise the "notable" list fills with
      // noise from the smallest categories.
      .filter(x => Math.abs(x.d.raw) >= FLAT_RAW && (x.d.pct === null || Math.abs(x.d.pct) >= FLAT_PCT))
      .sort((a, b) => Math.abs(b.d.raw) - Math.abs(a.d.raw))
      .slice(0, 3)

    const s = moves.length
      ? [`The largest year-over-year movements were: ` +
         moves.map(m => `${m.label} ${movementPhrase(m.d, { verbUp: 'up', verbDown: 'down' })}`).join('; ') + '.']
      : [`No sub-category moved by more than ${FLAT_RAW} enrollments year over year.`]
    paras.push({ id: 'movers', title: 'Notable movements', sentences: s })
  }

  // 6 ── caveats
  {
    const s = []
    if (yoy) {
      const c = completenessCaveat(focus.rows ?? [], yoy.rows ?? [])
      if (c) s.push(c)
    }
    if (s.length) paras.push({ id: 'caveats', title: 'Before quoting these figures', sentences: s })
  }

  return { paragraphs: paras, plainText: toPlainText(focus.period, paras) }
}

export function toPlainText(period, paragraphs) {
  return [`Enrollment summary — ${period}`, '']
    .concat(paragraphs.flatMap(p => [p.title.toUpperCase(), p.sentences.join(' '), '']))
    .join('\n')
    .trim()
}

// ─── end pure logic ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

// Same quarter one fiscal year earlier ("Fall Quarter 2026" → "Fall Quarter 2025").
function priorYearOf(period) {
  const q = parseQuarter(period)
  return q ? `${q.season} Quarter ${q.year - 1}` : null
}

export default function EnrollmentNarrative() {
  const [quarters, setQuarters]   = useState([])   // every quarter on file, newest first
  const [totals, setTotals]       = useState({})   // period → enrollment count, for season medians
  const [focus, setFocus]         = useState('')
  const [yoyPeriod, setYoyPeriod] = useState('')
  const [seqPeriod, setSeqPeriod] = useState('')
  const [rowsByPeriod, setRows]   = useState(null)
  const [loading, setLoading]     = useState(true)
  const [busy, setBusy]           = useState(false)
  const [error, setError]         = useState(null)
  const [infoOpen, setInfoOpen]   = useState(false)
  const [copied, setCopied]       = useState(false)

  // Phase 1: every quarter on file. Light enough to fetch whole (one column),
  // and it gives both the pickers and the seasonal baselines.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const rows = await fetchAll(supabase, 'enrollments', {
          select: 'event_enrollment_id, time_period',
          orderBy: 'event_enrollment_id',
        })
        if (cancelled) return
        const counts = {}
        for (const r of rows) if (r.time_period) counts[r.time_period] = (counts[r.time_period] ?? 0) + 1
        const qs = Object.keys(counts).sort((a, b) => quarterSortKey(b) - quarterSortKey(a))
        setTotals(counts)
        setQuarters(qs)
        // Defaults: newest quarter, the same quarter a year earlier, and the
        // quarter immediately before it.
        const f = qs[0] ?? ''
        setFocus(f)
        const py = priorYearOf(f)
        setYoyPeriod(py && qs.includes(py) ? py : '')
        setSeqPeriod(qs[1] ?? '')
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Phase 2: full detail for just the selected quarters.
  useEffect(() => {
    const wanted = [focus, yoyPeriod, seqPeriod].filter(Boolean)
    if (!wanted.length) { setRows(null); return }
    let cancelled = false
    setBusy(true)
    ;(async () => {
      try {
        const enr = await fetchAll(supabase, 'enrollments', {
          select: 'event_enrollment_id, event_id, customer_id, time_period, is_tuition_free',
          orderBy: 'event_enrollment_id',
          apply: q => q.in('time_period', wanted),
        })
        // Events are fetched flat and joined here — a nested PostgREST join is
        // dramatically slower per page (see src/utils/fetchAll.js). The id list
        // is chunked because three quarters reference ~3,200 events, which as a
        // single .in() is a 25,000-character URL and a 400 from the server.
        const events = await fetchByIds(supabase, 'events', {
          column: 'event_id',
          values: enr.map(e => e.event_id),
          select: 'event_id, location, activity_type, class_start_date',
        })
        joinBy(enr, events, { on: 'event_id', as: 'ev' })

        // A missed join would silently null out location and activity type,
        // which the branch and lesson/class figures are counted from — so a
        // gap must surface as an error, never as a quietly smaller number.
        const orphans = enr.filter(e => !e.ev).length
        if (orphans) throw new Error(`${orphans} enrollment(s) have no matching event; figures would undercount.`)
        if (cancelled) return
        const byPeriod = {}
        for (const e of enr) {
          ;(byPeriod[e.time_period] ??= []).push({
            cid:           e.customer_id,
            isTuitionFree: e.is_tuition_free,
            location:      e.ev?.location ?? null,
            activityType:  e.ev?.activity_type ?? null,
            classStart:    e.ev?.class_start_date ?? null,
          })
        }
        setRows(byPeriod)
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => { cancelled = true }
  }, [focus, yoyPeriod, seqPeriod])

  const medians = useMemo(() => seasonMedians(totals), [totals])

  const narrative = useMemo(() => {
    if (!rowsByPeriod || !focus || !rowsByPeriod[focus]) return null
    const unit = p => p && rowsByPeriod[p]
      ? { period: p, rows: rowsByPeriod[p], stats: buildQuarterStats(rowsByPeriod[p]) }
      : null
    const f = unit(focus)
    if (!f) return null
    return buildNarrative({ focus: f, yoy: unit(yoyPeriod), seq: unit(seqPeriod), medians })
  }, [rowsByPeriod, focus, yoyPeriod, seqPeriod, medians])

  function copyText() {
    if (!narrative) return
    navigator.clipboard.writeText(narrative.plainText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  if (loading) return <p className="coming-soon">Loading every quarter on file…</p>

  return (
    <div className="pig-report">
      {error && <div className="error-banner">{error}</div>}

      <div className="pig-courses ugcb-info-block">
        <button className="pig-courses-toggle" onClick={() => setInfoOpen(o => !o)}>
          <span>About this report</span>
          <span className="pig-courses-chevron">{infoOpen ? '▲' : '▼'}</span>
        </button>
        {infoOpen && (
          <div className="ugcb-info-body">
            <div className="ugcb-info-section-title">What this report shows</div>
            <p>
              The same figures the <strong>Enrollment</strong> page reports as a table, written out
              as prose for a quarter you pick, compared against two other quarters. It exists so a
              quarterly summary can be produced without transcribing a table by hand.
            </p>
            <p>
              The metrics are the Enrollment page's own row definitions — total, fee-based,
              tuition-free, lessons, group classes, and the two branches — so a number quoted here
              is the same number that page shows for the same quarter. Counts are enrollment rows:
              a student taking three classes counts three times, which is why unique students are
              reported separately.
            </p>

            <div className="ugcb-info-section-title">How the sentences are built</div>
            <p>
              Every sentence is assembled from the numbers by rule. There is no language model
              involved and no attempt to explain <em>why</em> anything moved — the report states what
              changed and by how much, and stops there. Two rules keep it honest:
              a percentage is suppressed when the earlier quarter had fewer than {MIN_BASE_FOR_PCT} enrollments
              in that category (three on a base of six reads as "+50%", which looks like a trend and
              isn't), and a movement under {FLAT_RAW} enrollments and {FLAT_PCT}% is described as holding
              steady rather than given a direction.
            </p>

            <div className="ugcb-info-section-title">Choosing the comparison quarters</div>
            <p>
              By default the report compares the selected quarter against the same quarter one
              fiscal year earlier, and against the quarter immediately before it. Both are free to
              change, and either can be set to <em>None</em>.
            </p>
            <p>
              Summer terms are genuinely shorter than the other three, so a summer-to-fall
              comparison largely measures the calendar. Rather than forbidding that pairing, the
              report measures the typical size of each season across every quarter on file and adds
              a caveat sentence when the two seasons differ in scale by more than{' '}
              {Math.round(SEASON_SCALE_TOLERANCE * 100)}%. The comparison is still shown — it is just
              labelled for what it is.
            </p>

            <div className="ugcb-info-section-title">Before quoting the figures</div>
            <p>
              A quarter pulled from ASAP part-way through the term is missing its later-starting
              sections. When the comparison quarter ran sections that started later in the term than
              anything in the selected one, the report says so and recommends re-uploading once
              those classes are in ASAP. This is the same check{' '}
              <code>scripts/quarter-audit.mjs</code> performs after an upload.
            </p>
          </div>
        )}
      </div>

      <div className="narr-controls">
        <label className="narr-field">
          <span className="narr-field-label">Quarter</span>
          <select value={focus} onChange={e => setFocus(e.target.value)}>
            {quarters.map(q => <option key={q} value={q}>{q}</option>)}
          </select>
        </label>
        <label className="narr-field">
          <span className="narr-field-label">Compared with (year over year)</span>
          <select value={yoyPeriod} onChange={e => setYoyPeriod(e.target.value)}>
            <option value="">None</option>
            {quarters.filter(q => q !== focus).map(q => <option key={q} value={q}>{q}</option>)}
          </select>
        </label>
        <label className="narr-field">
          <span className="narr-field-label">And with</span>
          <select value={seqPeriod} onChange={e => setSeqPeriod(e.target.value)}>
            <option value="">None</option>
            {quarters.filter(q => q !== focus).map(q => <option key={q} value={q}>{q}</option>)}
          </select>
        </label>
      </div>

      {busy && <p className="coming-soon">Reading those quarters…</p>}

      {!busy && narrative && (
        <>
          <div className="narr-actions">
            <button className="btn-secondary" onClick={copyText}>
              {copied ? 'Copied' : 'Copy as text'}
            </button>
          </div>
          <div className="narr-body">
            {narrative.paragraphs.map(p => (
              <section key={p.id} className="narr-para">
                <h3 className="narr-para-title">{p.title}</h3>
                <p>{p.sentences.join(' ')}</p>
              </section>
            ))}
          </div>
        </>
      )}

      {!busy && !narrative && !error && (
        <p className="coming-soon">Pick a quarter to summarise.</p>
      )}
    </div>
  )
}
