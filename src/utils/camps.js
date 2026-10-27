import { classStartDate } from './periodUtils.js'

// What counts as a camp, for every report. Camps aren't a category in any ASAP
// export and their titles can't be relied on — "CMC Sparks Mariachi" (Summer
// 2026) is a Mon–Fri camp with no "camp" in its name — so CMC's definition is
// by length: a group class (ASAP activity type CLASS) whose start and end dates
// are no more than two weeks apart. Every term-length class on file runs over
// a month, so the line is clean; the cost is that a one-off single-day class
// would also read as a camp, which is why reports list every camp they count.
export const CAMP_MAX_DAYS = 14

// Calendar days from start to end, both included, or null when either date is
// missing or a placeholder. "YYYY-MM-DD" strings.
export function classSpanDays(ev) {
  const start = classStartDate(ev?.class_start_date)
  const end   = classStartDate(ev?.class_end_date)
  if (!start || !end || end < start) return null
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 864e5) + 1
}

// A class with no usable dates can't be measured, so it is not a camp.
export function isCamp(ev) {
  if (ev?.activity_type !== 'CLASS') return false
  const span = classSpanDays(ev)
  return span != null && span <= CAMP_MAX_DAYS
}

// Mon–Fri days from start to end inclusive, "YYYY-MM-DD" strings.
export function weekdaysBetween(start, end) {
  const d = new Date(start + 'T00:00:00Z'), last = new Date(end + 'T00:00:00Z')
  let n = 0
  while (d <= last) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) n++
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return n
}

// The days a camp ran: ASAP's All Meetings or its weekdays, whichever is
// higher. Neither alone is right — Camp CMC (FY26) ran Mon–Fri but records 1
// meeting, while the Fri–Sun Summer Jazz Workshop has 3 meetings and only 1
// weekday. null when the event isn't a camp.
export function campDays(ev) {
  if (!isCamp(ev)) return null
  return Math.max(ev.all_meetings ?? 0, weekdaysBetween(ev.class_start_date, ev.class_end_date))
}
