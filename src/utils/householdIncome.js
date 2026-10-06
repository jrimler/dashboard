import { INCOME_MAP } from '../reports/demographicCategories.js'

// Household income columns in the STUDENT report, newest first — the first
// real answer wins. ASAP truncates headers at 50 characters, so these are the
// exact strings it writes. It has renamed this question more than once, and a
// rename is silent: the old header simply stops appearing and every answer
// under the new one is dropped. That happened when "Household Income - CMC s
// funders ask for this info" became "Gross Household Income - …" (2026) —
// 878 of the 1,908 students in a Fall 2026 export had income only under the
// new name and none in the database. unknownIncomeColumns() exists so the
// next rename is a visible upload warning instead.
export const INCOME_COLUMNS = [
  'Gross Household Income - CMC s funders ask for thi',
  'Household Income - CMC s funders ask for this info',
  'Household Income - CMC funders ask for this inform',
]

// Same empty-cell rule as the upload's coalesce(): blank, whitespace-only and
// a literal "0" are ASAP placeholders, not answers.
function realValue(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s !== '' && s !== '0' ? s : null
}

export function householdIncome(row) {
  for (const col of INCOME_COLUMNS) {
    const v = realValue(row[col])
    if (v) return v
  }
  return null
}

// Headers that look like an income question but aren't in INCOME_COLUMNS.
export function unknownIncomeColumns(headers) {
  return headers.filter(h => h && /income/i.test(h) && !INCOME_COLUMNS.includes(h))
}

// Stored answers the income map doesn't recognise, with counts, most common
// first. Reports bucket these as No Response, so a new ASAP bracket would
// otherwise vanish from every income figure without a trace.
export function unmappedIncomeValues(values) {
  const counts = new Map()
  for (const v of values) {
    if (!v || INCOME_MAP[v.toLowerCase()]) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])
}
