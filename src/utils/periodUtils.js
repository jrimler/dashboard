export const SEASON_ORDER = { Summer: 1, Fall: 2, Winter: 3, Spring: 4 }
export const SEASON_SHORT = { Summer: 'Sum', Fall: 'Fall', Winter: 'Wtr', Spring: 'Spr' }

export function parseQuarter(s) {
  const m = s?.match(/^(\w+)\s+Quarter\s+(\d{4})$/i)
  return m ? { season: m[1], year: parseInt(m[2]) } : null
}

// Summer/Fall belong to the NEXT calendar year's FY
export function quarterFY(season, year) {
  return (season === 'Summer' || season === 'Fall') ? year + 1 : year
}

export function quarterFYLabel(season, year) {
  const n = quarterFY(season, year)
  return 'FY' + String(n).slice(-2)
}

// All sort keys use fullYear * 10 so FY and quarter keys share the same scale
export function quarterSortKey(timePeriod) {
  const q = parseQuarter(timePeriod)
  if (!q) return 99999
  return quarterFY(q.season, q.year) * 10 + (SEASON_ORDER[q.season] ?? 9)
}

export function fySortKey(fy) {
  const m = fy?.match(/^FY(\d+)$/)
  if (!m) return 99999
  const n = parseInt(m[1])
  const fullYear = n < 50 ? 2000 + n : 1900 + n
  return fullYear * 10  // before all quarters of that FY (which are fullYear*10+1 through +4)
}

export function periodSortKey(p) {
  return p.type === 'quarter' ? quarterSortKey(p.value) : fySortKey(p.value)
}

// Returns [minQuarterSortKey, maxQuarterSortKey] that belong to a FY
export function fyRange(fy) {
  const m = fy?.match(/^FY(\d+)$/)
  if (!m) return [99999, 99999]
  const n = parseInt(m[1])
  const fullYear = n < 50 ? 2000 + n : 1900 + n
  return [fullYear * 10 + 1, fullYear * 10 + 4]
}

export function periodLabel(p) {
  if (p.type === 'fiscal_year') return p.value
  const q = parseQuarter(p.value)
  if (!q) return p.value
  return `${SEASON_SHORT[q.season] ?? q.season.slice(0, 3)} ${q.year}`
}

// ASAP writes a far-future placeholder class start date (2050-01-01 in the data
// so far) when the real one is missing — the mirror of the 1900-01-01
// placeholder birthdate. It matters because Demographics, LIYP and the Board
// report all compute a student's age *at the class start date*, so a
// placeholder silently ages a student into an older bracket: a 40-year-old
// enrolled in a 2050-dated section reads as 65. Existing age guards don't catch
// it, because the inflated age still looks perfectly plausible.
//
// Returns the date unchanged, or null when it can't be real — callers then
// treat it as "no date on record", exactly as they do a missing one.
const MIN_PLAUSIBLE_CLASS_YEAR = 2015

// Floats with the clock so this never needs revisiting: a class scheduled more
// than five years out is a placeholder, not a schedule.
function maxPlausibleClassYear() { return new Date().getFullYear() + 5 }

export function classStartDate(raw) {
  if (!raw) return null
  const year = Number(String(raw).slice(0, 4))
  if (!year || year < MIN_PLAUSIBLE_CLASS_YEAR || year > maxPlausibleClassYear()) return null
  return raw
}
