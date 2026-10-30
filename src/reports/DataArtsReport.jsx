import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { fetchAll, fetchByIds } from '../utils/fetchAll'
import { classStartDate, quarterWeeks, timePeriodSeason, QUARTER_WEEKS } from '../utils/periodUtils'
import { isCamp, campDays, weekdaysBetween, CAMP_MAX_DAYS } from '../utils/camps'
import {
  DATA_ARTS_FIELDS, FIRST_DATA_ARTS_FY,
  loadDataArtsInput, dataArtsYearsThrough, fiscalYearSpan,
} from '../utils/dataArtsInput'

// ─── pure logic (verified by scripts/data-arts-check.mjs) ────────────────────

// A lesson or class is online when ASAP's location or facility mentions
// "virtual". In practice it's the facility ("Virtual Music Studio",
// "<Teacher> Virtual Studio"); location is checked too so a relabel that moves
// the word there is still caught.
const VIRTUAL_RE = /virtual/i

// Data Arts counts attendees "18 and under".
const YOUTH_MAX_AGE = 18

// CMC's estimate of the share of its audiences that are 18 or under.
const AUDIENCE_YOUTH_SHARE = 0.6

// ASAP writes a 1900-01-01 placeholder when a birthdate is missing (age ~126).
const MAX_PLAUSIBLE_AGE = 100

function isVirtual(ev) {
  return VIRTUAL_RE.test(ev?.location ?? '') || VIRTUAL_RE.test(ev?.facility ?? '')
}

function ageAtDate(birthdateStr, referenceDateStr) {
  if (!birthdateStr || !referenceDateStr) return null
  const [by, bm, bd] = birthdateStr.split('-').map(Number)
  const [ry, rm, rd] = referenceDateStr.split('-').map(Number)
  let age = ry - by
  if (rm < bm || (rm === bm && rd < bd)) age--
  return age < 0 || age > MAX_PLAUSIBLE_AGE ? null : age
}

// The fiscal year's first day: the earliest real start date of any lesson or
// class in it. Not a fixed July 1 — Summer sections start in mid-June and
// still belong to the next FY (FY26 opens 2025-06-16 with Camp CMC).
function fiscalYearStart(events) {
  let first = null
  for (const ev of events) {
    const start = classStartDate(ev.class_start_date)
    if (start && (!first || start < first)) first = start
  }
  return first
}

// Splits one fiscal year's CMC students by age. A student counts as 18 and
// under if they were 18 or younger at any point in the year, which is the same
// as being 18 or younger on its first day. No birthdate or a placeholder one →
// unknown.
function studentAges(enrollments, birthdates, yearStart) {
  const students = new Set(enrollments.map(e => e.customer_id).filter(Boolean))
  let youth = 0, older = 0, unknown = 0
  for (const cid of students) {
    const age = ageAtDate(birthdates.get(cid) ?? null, yearStart)
    if (age === null) unknown++
    else if (age <= YOUTH_MAX_AGE) youth++
    else older++
  }
  return { total: students.size, youth, older, unknown, yearStart }
}

function sum(values) { return values.reduce((a, b) => a + b, 0) }

// A total that depends on Data Arts Input is withheld (null) while any input it
// needs is missing — a partial figure in a funder report is worse than a gap.
function sumIfComplete(values) {
  return values.some(v => v == null) ? null : sum(values)
}

/**
 * Every Data Arts figure for one fiscal year.
 *
 * events       events whose fiscal_year is the selected FY
 * enrollments  enrollments whose fiscal_year is the selected FY
 * birthdates   Map customer_id → birthdate string (or null)
 * input        the data_arts_input row for the FY, or null
 */
function buildReport({ events, enrollments, birthdates, input }) {
  const eventsById = new Map(events.map(e => [e.event_id, e]))
  const lessonEnr  = enrollments.filter(e => eventsById.get(e.event_id)?.activity_type === 'LESSON')
  const classes    = events.filter(e => e.activity_type === 'CLASS')
  const camps      = classes.filter(isCamp)
  const regular    = classes.filter(e => !isCamp(e))

  // Online vs physical: private lessons are counted per enrollment, group
  // classes per section (event ID).
  const online = {
    lessons: { online: lessonEnr.filter(e => isVirtual(eventsById.get(e.event_id))).length },
    classes: { online: classes.filter(isVirtual).length },
  }
  online.lessons.onsite = lessonEnr.length - online.lessons.online
  online.classes.onsite = classes.length   - online.classes.online

  // Group classes: each section is one distinct class, offered once per week
  // of its quarter (CMC's fixed lengths, not ASAP's meeting count) — Mariachi
  // CMC in Fall, Winter and Spring is three classes and 14 + 12 + 10. Camps
  // count the days they ran instead.
  const byQuarter = new Map()
  for (const e of regular) {
    const tp = e.time_period ?? '—'
    const q = byQuarter.get(tp) ?? { time_period: tp, season: timePeriodSeason(tp), weeks: quarterWeeks(tp), sections: 0, timesOffered: 0, start: null }
    q.sections++
    q.timesOffered += q.weeks ?? 0
    const start = classStartDate(e.class_start_date)
    if (start && (!q.start || start < q.start)) q.start = start
    byQuarter.set(tp, q)
  }
  const quarterRows = [...byQuarter.values()].sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
  const campRows = camps.map(e => ({
    event_id:   e.event_id,
    course:     (e.course_name ?? '').trim(),
    instructor: e.primary_instructor ?? '',
    start:      e.class_start_date,
    end:        e.class_end_date,
    meetings:   e.all_meetings,
    weekdays:   weekdaysBetween(e.class_start_date, e.class_end_date),
    days:       campDays(e),
  })).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '') || a.course.localeCompare(b.course))
  const groupClasses = {
    regular: {
      sections:     regular.length,
      timesOffered: sum(quarterRows.map(q => q.timesOffered)),
      // A Time Period that isn't one of the four seasons has no length, adds 0
      // and is named in a note rather than guessed.
      noQuarter:    sum(quarterRows.filter(q => q.weeks == null).map(q => q.sections)),
      // Without real dates a section can't be measured against the camp rule,
      // so it counts as a regular class; the note makes that visible.
      noDates:      regular.filter(e => !classStartDate(e.class_start_date) || !classStartDate(e.class_end_date)).length,
      byQuarter:    quarterRows,
    },
    camps: {
      sections: camps.length,
      days:     sum(campRows.map(c => c.days)),
      rows:     campRows,
    },
  }
  groupClasses.sections     = classes.length
  groupClasses.timesOffered = groupClasses.regular.timesOffered + groupClasses.camps.days

  // Private lessons: every lesson enrollment times its quarter's length in
  // weeks — how CMC has always reported this to Data Arts, so it stays
  // consistent year to year. ASAP's All Meetings (the lessons actually booked,
  // fewer for a mid-quarter start) is kept alongside for reference only.
  const byBranchQuarter = new Map()
  let lessonsTotal = 0, lessonsNoQuarter = 0, asapMeetings = 0
  for (const e of lessonEnr) {
    const ev = eventsById.get(e.event_id)
    const weeks = quarterWeeks(ev.time_period)
    if (weeks == null) lessonsNoQuarter++
    lessonsTotal += weeks ?? 0
    asapMeetings += ev.all_meetings ?? 0
    const key = `${(ev.location ?? '').trim() || '—'}|${ev.time_period ?? '—'}`
    const b = byBranchQuarter.get(key) ?? { location: (ev.location ?? '').trim() || '—', time_period: ev.time_period ?? '—', weeks, enrollments: 0, lessons: 0, asapMeetings: 0, start: null }
    b.enrollments++
    b.lessons += weeks ?? 0
    b.asapMeetings += ev.all_meetings ?? 0
    const start = classStartDate(ev.class_start_date)
    if (start && (!b.start || start < b.start)) b.start = start
    byBranchQuarter.set(key, b)
  }
  const privateLessons = {
    enrollments: lessonEnr.length,
    lessons:     lessonsTotal,
    noQuarter:   lessonsNoQuarter,
    asapMeetings,
    byBranchQuarter: [...byBranchQuarter.values()]
      .sort((a, b) => a.location.localeCompare(b.location) || (a.start ?? '').localeCompare(b.start ?? '')),
  }

  // Attendance / participation, all ages, in unique students. A student with
  // any tuition-free lesson or class in the year counts as tuition-free, and
  // one with any fee-based enrollment as fee-based, so a student with both
  // counts in both rows — CMC's rule, not a double count to correct.
  const freeIds = new Set(), feeIds = new Set(), allIds = new Set()
  for (const e of enrollments) {
    if (!e.customer_id) continue
    allIds.add(e.customer_id)
    if (e.is_tuition_free === true)  freeIds.add(e.customer_id)
    if (e.is_tuition_free === false) feeIds.add(e.customer_id)
  }
  const tuitionFree = freeIds.size
  const feeBased    = feeIds.size
  const both        = [...freeIds].filter(id => feeIds.has(id)).length
  const val = key => (input?.[key] == null ? null : Number(input[key]))
  const participation = {
    tuitionFree,
    feeBased,
    both,
    // Students whose every enrollment lacks a tuition status are in neither row.
    unclassified: allIds.size - (tuitionFree + feeBased - both),
    partnerStudents: val('partner_students'),
    freeStudents:    sumIfComplete([tuitionFree, val('partner_students')]),
    paidStudents:    feeBased,
    freeAudience:    val('free_audience'),
    paidAudience:    val('paid_audience'),
  }

  // Attendees 18 and under: CMC students 18 and under + partner students +
  // 60% of all audience members, rounded to a whole person.
  const ages = studentAges(enrollments, birthdates, fiscalYearStart(events))
  const audienceCombined = sumIfComplete([val('paid_audience'), val('free_audience')])
  const audienceYouth    = audienceCombined == null ? null : Math.round(audienceCombined * AUDIENCE_YOUTH_SHARE)
  const youth = {
    ages,
    cmcStudents:     ages.youth,
    partnerStudents: val('partner_students'),
    audienceCombined,
    audienceYouth,
    total:           sumIfComplete([ages.youth, val('partner_students'), audienceYouth]),
  }

  const partner = Object.fromEntries(DATA_ARTS_FIELDS.map(f => [f.key, val(f.key)]))
  const missingInput = DATA_ARTS_FIELDS.filter(f => val(f.key) == null).map(f => f.label)

  return { online, partner, groupClasses, privateLessons, participation, youth, missingInput }
}

// The report as labelled rows, one table per Data Arts category, in the order
// the Data Arts form asks for them. Shared by the screen and the CSV so they
// can't disagree. `value` null renders as "—" with `note` explaining why.
function reportSections(r) {
  const NEEDS_INPUT = 'Needs Data Arts Input'
  const inputRow = (label, value, source = 'Data Arts Input') =>
    ({ label, value, source, note: value == null ? NEEDS_INPUT : null })

  return [
    {
      id: 'online', title: 'Online vs Physical Classes',
      rows: [
        { label: 'Online',  value: r.online.lessons.online + r.online.classes.online, source: 'ASAP', top: true },
        { label: 'Private lesson enrollments', value: r.online.lessons.online, source: 'ASAP' },
        { label: 'Group class sections',       value: r.online.classes.online, source: 'ASAP' },
        { label: 'On-site', value: r.online.lessons.onsite + r.online.classes.onsite, source: 'ASAP', top: true },
        { label: 'Private lesson enrollments', value: r.online.lessons.onsite, source: 'ASAP' },
        { label: 'Group class sections',       value: r.online.classes.onsite, source: 'ASAP' },
      ],
    },
    {
      id: 'partner', title: 'Partner Stats',
      rows: DATA_ARTS_FIELDS.map(f => ({ ...inputRow(f.label, r.partner[f.key]), top: true })),
    },
    {
      id: 'group', title: 'Number of Group Classes',
      rows: [
        { label: 'Distinct classes', value: r.groupClasses.sections, source: 'ASAP', top: true },
        { label: 'Classes (one per section)', value: r.groupClasses.regular.sections, source: 'ASAP' },
        { label: 'Camps (one per session)',   value: r.groupClasses.camps.sections,   source: 'ASAP' },
        { label: 'Times offered', value: r.groupClasses.timesOffered, source: 'ASAP', top: true },
        { label: 'Class weeks (quarter length × sections)', value: r.groupClasses.regular.timesOffered, source: 'ASAP',
          note: [
            r.groupClasses.regular.noQuarter ? `${r.groupClasses.regular.noQuarter} section(s) have no recognisable quarter and add 0` : null,
            r.groupClasses.regular.noDates ? `${r.groupClasses.regular.noDates} section(s) have no usable dates, so couldn't be tested as camps` : null,
          ].filter(Boolean).join('; ') || null },
        { label: 'Camp days', value: r.groupClasses.camps.days, source: 'ASAP' },
      ],
    },
    {
      id: 'lessons', title: 'Number of Private Lessons',
      rows: [
        { label: 'Private lessons', value: r.privateLessons.lessons, source: 'ASAP', top: true,
          note: r.privateLessons.noQuarter ? `${r.privateLessons.noQuarter} enrollment(s) have no recognisable quarter and add 0` : null },
        { label: 'Private lesson enrollments', value: r.privateLessons.enrollments, source: 'ASAP' },
      ],
    },
    {
      id: 'participation', title: 'Attendance / Participation (all ages)',
      rows: [
        { label: 'Free students', value: r.participation.freeStudents, source: 'Combined', top: true,
          note: r.participation.freeStudents == null ? NEEDS_INPUT : null },
        { label: 'Tuition-free students at CMC', value: r.participation.tuitionFree, source: 'ASAP' },
        inputRow('Partner program students', r.participation.partnerStudents),
        { label: 'Paid students at CMC', value: r.participation.paidStudents, source: 'ASAP', top: true,
          note: [
            r.participation.both ? `${r.participation.both.toLocaleString()} student(s) had both tuition-free and paid enrollments and count in both` : null,
            r.participation.unclassified ? `${r.participation.unclassified} student(s) have no tuition status on any enrollment and are in neither row` : null,
          ].filter(Boolean).join('; ') || null },
        { ...inputRow('Free audience', r.participation.freeAudience), top: true },
        { ...inputRow('Paid audience', r.participation.paidAudience), top: true },
      ],
    },
    {
      id: 'youth', title: 'Number of Attendees (18 and under)',
      rows: [
        { label: 'Attendees 18 and under', value: r.youth.total, source: 'Combined', top: true,
          note: r.youth.total == null ? NEEDS_INPUT : null },
        { label: 'CMC students 18 and under', value: r.youth.cmcStudents, source: 'ASAP',
          note: [
            r.youth.ages.yearStart ? `Aged on ${r.youth.ages.yearStart}, the year's first class or lesson` : 'no class or lesson in the year has a usable start date',
            r.youth.ages.unknown ? `${r.youth.ages.unknown} of ${r.youth.ages.total} students have no usable birthdate and aren't counted` : null,
          ].filter(Boolean).join('; ') },
        inputRow('Partner program students', r.youth.partnerStudents),
        { label: `Audience estimate (${AUDIENCE_YOUTH_SHARE * 100}% of ${r.youth.audienceCombined == null ? 'paid + free' : r.youth.audienceCombined.toLocaleString()})`,
          value: r.youth.audienceYouth, source: 'Data Arts Input',
          note: r.youth.audienceYouth == null ? NEEDS_INPUT : null },
      ],
    },
  ]
}

// ─── end pure logic ─────────────────────────────────────────────────────────

function esc(v) { return `"${String(v ?? '').replace(/"/g, '""')}"` }

function triggerDownload(csv, filename) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  URL.revokeObjectURL(url)
}

function today() { return new Date().toISOString().slice(0, 10) }

function fmt(v) {
  if (v == null) return '—'
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function exportCSV(sections, report, fy) {
  const rows = [['Section', 'Measure', fy, 'Source', 'Note']]
  for (const s of sections) {
    for (const r of s.rows) rows.push([s.title, r.top ? r.label : `  ${r.label}`, r.value ?? '', r.source, r.note ?? ''])
  }
  rows.push([])
  rows.push(['Private lessons by branch and quarter', 'Branch', 'Quarter', 'Enrollments', 'Weeks', 'Lessons', 'ASAP meetings (reference)'])
  for (const b of report.privateLessons.byBranchQuarter) rows.push(['', b.location, b.time_period, b.enrollments, b.weeks ?? '', b.lessons, b.asapMeetings])
  rows.push([])
  rows.push(['Group classes by quarter', 'Quarter', 'Sections', 'Weeks', 'Times offered'])
  for (const q of report.groupClasses.regular.byQuarter) rows.push(['', q.time_period, q.sections, q.weeks ?? '', q.timesOffered])
  rows.push([])
  rows.push(['Camps counted', 'Course', 'Dates', 'ASAP meetings', 'Weekdays', 'Days counted'])
  for (const c of report.groupClasses.camps.rows) rows.push(['', c.course, `${c.start} – ${c.end}`, c.meetings ?? '', c.weekdays, c.days])
  triggerDownload(rows.map(r => r.map(esc).join(',')).join('\n'), `data-arts-${fy}-${today()}.csv`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation
// ─────────────────────────────────────────────────────────────────────────────

function SectionCard({ section, fy }) {
  return (
    <div className="liyp-group-card">
      <div className="pig-roster-header">
        <span className="pig-roster-title">{section.title}</span>
      </div>
      <div className="report-scroll">
        <table className="report-table">
          <thead>
            <tr>
              <th className="rt-label-hdr">Measure</th>
              <th className="rt-period-hdr"><div className="rt-period-name">{fy}</div></th>
              <th className="rt-label-hdr da-source-hdr">Source</th>
            </tr>
          </thead>
          <tbody>
            {section.rows.map((row, i) => (
              <tr key={i} className={row.top ? 'rt-row rt-top-row' : 'rt-row rt-sub-row'}>
                <td className="rt-label">
                  {row.label}
                  {row.note && <div className={`da-note${row.value == null ? ' da-note--missing' : ''}`}>{row.note}</div>}
                </td>
                <td className="rt-period-cell"><div className="cell-enr">{fmt(row.value)}</div></td>
                <td className="da-source">{row.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main report component
// ─────────────────────────────────────────────────────────────────────────────

export default function DataArtsReport() {
  const [years, setYears]           = useState([])
  const [yearsLoading, setYearsLoading] = useState(true)
  const [fy, setFy]                 = useState(null)
  const [data, setData]             = useState(null)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState(null)
  const [infoOpen, setInfoOpen]     = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)

  // Only the newest fetch may commit — clicking pills in quick succession
  // otherwise lets a slower, older year overwrite the one now selected.
  const loadSeq = useRef(0)

  // Phase 1: FY25 through the newest fiscal year on file. One row, not a scan
  // of every event.
  useEffect(() => {
    (async () => {
      const { data: latest, error: err } = await supabase
        .from('events').select('fiscal_year').order('fiscal_year', { ascending: false }).limit(1)
      if (err) setError(err.message)
      else setYears(dataArtsYearsThrough(latest?.[0]?.fiscal_year ?? FIRST_DATA_ARTS_FY))
      setYearsLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (!fy) return
    loadData(fy)
  }, [fy])

  // Phase 2: that year's events and enrollments, flat and in parallel, the
  // enrolled students' birthdates by ID, and the year's Data Arts Input row.
  async function loadData(year) {
    const seq = ++loadSeq.current
    setLoading(true); setError(null); setData(null)
    try {
      const [events, enrollments, input] = await Promise.all([
        fetchAll(supabase, 'events', {
          select: 'event_id, course_name, activity_type, location, facility, primary_instructor, class_start_date, class_end_date, all_meetings, time_period',
          orderBy: 'event_id',
          apply: q => q.eq('fiscal_year', year),
        }),
        fetchAll(supabase, 'enrollments', {
          select: 'event_enrollment_id, event_id, customer_id, is_tuition_free',
          orderBy: 'event_enrollment_id',
          apply: q => q.eq('fiscal_year', year),
        }),
        loadDataArtsInput(supabase, year),
      ])
      const students = await fetchByIds(supabase, 'students', {
        column: 'customer_id', values: enrollments.map(e => e.customer_id), select: 'customer_id, birthdate',
      })
      if (seq !== loadSeq.current) return
      if (input.error) throw new Error(input.error)

      // A missed join would silently undercount, so fail loudly instead.
      const eventIds = new Set(events.map(e => e.event_id))
      const orphans = enrollments.filter(e => !eventIds.has(e.event_id)).length
      if (orphans) throw new Error(`${orphans} ${year} enrollments point at events outside ${year} — re-upload the year before reporting.`)

      setData({
        events, enrollments, input,
        birthdates: new Map(students.map(s => [s.customer_id, s.birthdate])),
      })
    } catch (e) {
      if (seq === loadSeq.current) setError(e.message)
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  const report = useMemo(() => data && buildReport({
    events: data.events, enrollments: data.enrollments, birthdates: data.birthdates, input: data.input.row,
  }), [data])
  const sections = useMemo(() => report && reportSections(report), [report])

  if (yearsLoading) return <p className="coming-soon">Loading…</p>

  return (
    <div className="pig-report">
      {error && <div className="error-banner">{error}</div>}

      {/* Methodology */}
      <div className="pig-courses ugcb-info-block">
        <button className="pig-courses-toggle" onClick={() => setInfoOpen(o => !o)}>
          <span>About this report</span>
          <span className="pig-courses-chevron">{infoOpen ? '▲' : '▼'}</span>
        </button>
        {infoOpen && (
          <div className="ugcb-info-body">
            <div className="ugcb-info-section-title">What this report is for</div>
            <p>
              The figures CMC submits each year to <strong>Data Arts</strong>, one fiscal year at a
              time. It is never run by quarter or for several years combined. It starts with FY25.
              A fiscal year runs Summer → Fall → Winter → Spring (FY26 = Summer 2025 – Spring 2026),
              and every ASAP record is assigned to a year by ASAP's own Fiscal Year column.
            </p>
            <p>
              Figures come from two places, named in each table's <strong>Source</strong> column:
              the uploaded <strong>ASAP</strong> exports, and the <strong>Data Arts Input</strong>{' '}
              page, where staff enter the partner-program and audience figures that program
              managers collect outside ASAP. <strong>Combined</strong> rows add the two.
              Before running the report, upload a full-year Enrollment + Super Enrollment pull for
              the year (see the Upload page) and complete that year's Data Arts Input.
            </p>
            <p>
              A Data Arts Input field left blank shows as "—" with <em>Needs Data Arts Input</em>,
              and so does any total that needs it. Blanks are never read as 0, so the report never
              shows a total that is quietly too low.
            </p>

            <div className="ugcb-info-section-title">Online vs Physical Classes</div>
            <p>
              Private lessons are counted per <strong>enrollment</strong>; group classes per{' '}
              <strong>section</strong> (one ASAP class ID). A lesson or class is online when its ASAP
              location or facility contains the word "virtual". In practice that's the facility,
              e.g. <em>Virtual Music Studio</em> or <em>&lt;Teacher&gt; Virtual Studio</em>.
              Everything else is on-site. Online + on-site = all lesson enrollments and all class
              sections for the year.
            </p>

            <div className="ugcb-info-section-title">Partner Stats</div>
            <p>
              Exactly as entered on the Data Arts Input page for the year, with no calculation.
            </p>

            <div className="ugcb-info-section-title">Number of Group Classes</div>
            <p>
              <strong>Distinct classes</strong>: every group-class section (unique ASAP class ID)
              in the year. The same course with the same teacher is a separate class each quarter
              and each section.
            </p>
            <p>
              <strong>Times offered</strong>: each class counts once per week of its quarter,
              using CMC's fixed quarter lengths: Fall {QUARTER_WEEKS.Fall} weeks,
              Winter {QUARTER_WEEKS.Winter}, Spring {QUARTER_WEEKS.Spring},
              Summer {QUARTER_WEEKS.Summer}. ASAP's meeting count is not used for classes, so a
              holiday or a section that started late doesn't change the figure. Mariachi CMC in
              Fall, Winter and Spring is 3 distinct classes and {QUARTER_WEEKS.Fall} +{' '}
              {QUARTER_WEEKS.Winter} + {QUARTER_WEEKS.Spring} ={' '}
              {QUARTER_WEEKS.Fall + QUARTER_WEEKS.Winter + QUARTER_WEEKS.Spring} times offered.
              Two summer sections of Intro to Piano give 2 classes and {2 * QUARTER_WEEKS.Summer}.
              A section that meets for only part of its quarter still counts the full length, so
              a four-meeting FY25 summer ensemble counts {QUARTER_WEEKS.Summer}.
              The quarter comes from ASAP's Time Period. <em>Details</em> shows each quarter's
              sections × weeks.
            </p>
            <p>
              <strong>Camps</strong> count the <em>days</em> they ran instead. A camp is any group
              class (a CLASS in ASAP) whose start and end dates are no more than{' '}
              {CAMP_MAX_DAYS} days apart, counting both ends, whatever it's called. The shortest
              regular classes are a few FY25 summer ensembles at 22 days, so nothing else comes
              close. This means a short
              workshop such as the Fri–Sun CMC Summer Jazz Workshop is a camp. A camp's days are
              ASAP's meeting count or the number of weekdays (Mon–Fri) from start to end,
              whichever is higher. A Mon–Fri camp is 5, and the Fri–Sun workshop is 3. Neither
              figure works alone: FY26's Camp CMC ran Mon–Fri but ASAP records 1 meeting, and a
              weekend workshop has only 1 weekday. Each camp session still counts once under
              distinct classes. Every camp counted is listed under <em>Details</em> with its
              dates, ASAP meeting count, weekdays and the days counted, so a one-off class that
              falls inside the two-week rule is easy to spot. A section with no usable dates
              can't be measured, so it counts as a regular class and is named in a note.
            </p>

            <div className="ugcb-info-section-title">Number of Private Lessons</div>
            <p>
              Each private lesson enrollment times its quarter's length in weeks, the same fixed
              lengths as group classes: Fall {QUARTER_WEEKS.Fall}, Winter {QUARTER_WEEKS.Winter},
              Spring {QUARTER_WEEKS.Spring}, Summer {QUARTER_WEEKS.Summer}. This is how CMC has
              always reported lessons to Data Arts, so the figure stays comparable from year to
              year. A student who started mid-quarter still counts the full quarter. A teacher
              with 10 students in every quarter adds 10 × ({QUARTER_WEEKS.Fall} +{' '}
              {QUARTER_WEEKS.Winter} + {QUARTER_WEEKS.Spring} + {QUARTER_WEEKS.Summer}) ={' '}
              {10 * (QUARTER_WEEKS.Fall + QUARTER_WEEKS.Winter + QUARTER_WEEKS.Spring + QUARTER_WEEKS.Summer)}.
              The quarter comes from ASAP's Time Period. The branch × quarter breakdown under{' '}
              <em>Details</em> shows how the total builds up, with ASAP's own count of lessons
              booked (<em>All Meetings</em>) beside it for reference. That column isn't used in
              the report.
            </p>

            <div className="ugcb-info-section-title">Attendance / Participation (all ages)</div>
            <ul>
              <li><strong>Free students</strong> = CMC's tuition-free students + the partner
                program students from Data Arts Input.</li>
              <li><strong>Tuition-free students at CMC</strong>: every unique student with at least
                one tuition-free lesson, class or camp in the year. Tuition-free means the
                enrollment cost $15 or less after discounts, the same rule the Enrollment page
                uses, so a $15 invoice is tuition-free.</li>
              <li><strong>Paid students at CMC</strong>: every unique student with at least one
                fee-based enrollment in the year.</li>
              <li><strong>Free audience</strong> and <strong>paid audience</strong>: from Data Arts
                Input.</li>
            </ul>
            <p>
              CMC figures here are <strong>unique students</strong>, not enrollments: a student in
              three tuition-free classes counts once. A student with both a tuition-free and a paid
              enrollment, such as a free group class and a paid lesson, counts once in{' '}
              <em>each</em> row. That's intended, so tuition-free + paid can be more than the
              year's unique students. The note on the paid row gives how many students are in both.
            </p>

            <div className="ugcb-info-section-title">Number of Attendees (18 and under)</div>
            <p>
              Three parts added together:
            </p>
            <ul>
              <li><strong>CMC students 18 and under</strong>: <em>unique</em> students enrolled in
                the year who were 18 or younger at any point during it. That's the same as being
                18 or younger on the year's first day, so everyone is aged on one date: the
                earliest start date of any lesson or class in the year (FY26: June 16, 2025, when
                Camp CMC began). A student who turns 19 at any point in the year still counts,
                wherever their own classes fall. The note on that row names the date used. Students
                with no birthdate, ASAP's 1900-01-01 placeholder, or an age outside 0–100 can't be
                aged and aren't counted. The note also gives how many.</li>
              <li><strong>Partner program students</strong> from Data Arts Input, all of them.</li>
              <li><strong>Audience estimate</strong>: paid + free audience × 60%, CMC's estimate
                of the share of its audiences that are under 18, rounded to a whole person.</li>
            </ul>

            <div className="ugcb-info-section-title">Export</div>
            <p>
              <strong>Export CSV</strong> writes every row shown, with its source and any note,
              followed by the private-lesson branch × quarter breakdown and the list of camps.
            </p>
          </div>
        )}
      </div>

      <div className="period-selector">
        <div className="period-selector-header">
          <span className="period-selector-title">Select Fiscal Year</span>
        </div>
        <div className="period-pills">
          {years.map(y => (
            <button key={y} className={`period-pill${fy === y ? ' active' : ''}`} onClick={() => setFy(y)}>
              {y}
            </button>
          ))}
        </div>
      </div>

      {!fy ? (
        <p className="coming-soon">Select a fiscal year above to view the report.</p>
      ) : loading || !report ? (
        loading && <p className="coming-soon">Loading {fy}…</p>
      ) : (
        <>
          <InputStatus fy={fy} input={data.input} missing={report.missingInput} />

          <div className="pig-roster-header">
            <span className="pig-roster-title">Data Arts Report — {fy} ({fiscalYearSpan(fy)})</span>
            <button className="btn-secondary" onClick={() => exportCSV(sections, report, fy)}>Export CSV</button>
          </div>

          {sections.map(s => <SectionCard key={s.id} section={s} fy={fy} />)}

          {/* Working detail: how the lesson and camp totals were built */}
          <div className="pig-courses">
            <button className="pig-courses-toggle" onClick={() => setDetailOpen(o => !o)}>
              <span>Details — private lessons by branch and quarter, group classes by quarter, and camps counted</span>
              <span className="pig-courses-chevron">{detailOpen ? '▲' : '▼'}</span>
            </button>
            {detailOpen && <Details report={report} />}
          </div>
        </>
      )}
    </div>
  )
}

function InputStatus({ fy, input, missing }) {
  if (input.missingTable) {
    return (
      <div className="warn-banner da-status">
        The Data Arts Input table hasn't been set up yet, so partner and audience figures are
        missing. Run <code>supabase/migrations/005_data_arts_input.sql</code> in the Supabase SQL
        editor.
      </div>
    )
  }
  if (!input.row) {
    return (
      <div className="warn-banner da-status">
        No Data Arts Input entered for {fy}. Partner and audience figures, and the totals that
        include them, are blank until it is. <Link to="/data-arts-input">Enter {fy} figures →</Link>
      </div>
    )
  }
  const when = new Date(input.row.updated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div className={`${missing.length ? 'warn-banner' : 'last-upload'} da-status`}>
      Data Arts Input for {fy} last saved {when}{input.row.updated_by && <> by {input.row.updated_by}</>}.
      {missing.length > 0 && <> Still blank: {missing.join(', ')}. <Link to="/data-arts-input">Complete it →</Link></>}
    </div>
  )
}

function Details({ report }) {
  const pl = report.privateLessons
  const camps = report.groupClasses.camps
  const reg = report.groupClasses.regular
  return (
    <div className="da-details">
      <div className="report-scroll">
        <table className="report-table">
          <thead>
            <tr>
              <th className="rt-label-hdr">Private lessons — branch · quarter</th>
              <th className="rt-period-hdr">Enrollments</th>
              <th className="rt-period-hdr">Weeks</th>
              <th className="rt-period-hdr">Lessons</th>
              <th className="rt-period-hdr">ASAP meetings (reference)</th>
            </tr>
          </thead>
          <tbody>
            {pl.byBranchQuarter.map(b => (
              <tr key={`${b.location}|${b.time_period}`} className="rt-row rt-sub-row">
                <td className="rt-label">{b.location} · {b.time_period}</td>
                <td className="rt-period-cell">{b.enrollments.toLocaleString()}</td>
                <td className="rt-period-cell">{b.weeks ?? '—'}</td>
                <td className="rt-period-cell">{b.lessons.toLocaleString()}</td>
                <td className="rt-period-cell">{b.asapMeetings.toLocaleString()}</td>
              </tr>
            ))}
            <tr className="rt-row rt-top-row">
              <td className="rt-label">Total</td>
              <td className="rt-period-cell">{pl.enrollments.toLocaleString()}</td>
              <td className="rt-period-cell"></td>
              <td className="rt-period-cell">{pl.lessons.toLocaleString()}</td>
              <td className="rt-period-cell">{pl.asapMeetings.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="report-scroll">
        <table className="report-table">
          <thead>
            <tr>
              <th className="rt-label-hdr">Group classes (not camps) — quarter</th>
              <th className="rt-period-hdr">Sections</th>
              <th className="rt-period-hdr">Weeks</th>
              <th className="rt-period-hdr">Times offered</th>
            </tr>
          </thead>
          <tbody>
            {reg.byQuarter.map(q => (
              <tr key={q.time_period} className="rt-row rt-sub-row">
                <td className="rt-label">{q.time_period}</td>
                <td className="rt-period-cell">{q.sections.toLocaleString()}</td>
                <td className="rt-period-cell">{q.weeks ?? '—'}</td>
                <td className="rt-period-cell">{q.timesOffered.toLocaleString()}</td>
              </tr>
            ))}
            <tr className="rt-row rt-top-row">
              <td className="rt-label">Total</td>
              <td className="rt-period-cell">{reg.sections.toLocaleString()}</td>
              <td className="rt-period-cell"></td>
              <td className="rt-period-cell">{reg.timesOffered.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="report-scroll">
        <table className="report-table">
          <thead>
            <tr>
              <th className="rt-label-hdr">Camp</th>
              <th className="rt-label-hdr">Dates</th>
              <th className="rt-period-hdr">ASAP meetings</th>
              <th className="rt-period-hdr">Weekdays</th>
              <th className="rt-period-hdr">Days counted</th>
            </tr>
          </thead>
          <tbody>
            {camps.rows.length === 0 ? (
              <tr className="rt-row"><td className="rt-label" colSpan={5}>No camps found this year.</td></tr>
            ) : camps.rows.map(c => (
              <tr key={c.event_id} className="rt-row rt-sub-row">
                <td className="rt-label">{c.course}<div className="da-note">{c.instructor}</div></td>
                <td className="rt-label">{c.start} – {c.end}</td>
                <td className="rt-period-cell">{c.meetings ?? '—'}</td>
                <td className="rt-period-cell">{c.weekdays}</td>
                <td className="rt-period-cell">{c.days}</td>
              </tr>
            ))}
            {camps.rows.length > 0 && (
              <tr className="rt-row rt-top-row">
                <td className="rt-label" colSpan={4}>Total camp days</td>
                <td className="rt-period-cell">{camps.days.toLocaleString()}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
