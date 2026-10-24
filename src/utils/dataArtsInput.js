// The yearly figures CMC's program managers collect outside ASAP — partner
// programs in the school district and elsewhere, and event audiences — entered
// once per fiscal year on the Data Arts Input page and read by the Data Arts
// Report. One definition here so the form and the report can't disagree about
// what a field is called or which column holds it.
//
// Table: data_arts_input (supabase/migrations/005_data_arts_input.sql), one row
// per fiscal year. A blank field is stored as null and means "not entered" — it
// is never read as 0, so a report total that depends on it is withheld rather
// than silently understated.

export const DATA_ARTS_TABLE = 'data_arts_input'

// The Data Arts Report starts with FY26; earlier years are never run.
export const FIRST_DATA_ARTS_FY = 'FY26'

export const DATA_ARTS_FIELDS = [
  { key: 'partner_schools',           group: 'partner',  label: 'Number of schools',             help: 'Schools and other sites hosting a CMC partner program.' },
  { key: 'partner_classes',           group: 'partner',  label: 'Number of distinct classes',    help: 'Each separate class or section counts once.' },
  { key: 'partner_times_offered',     group: 'partner',  label: 'Number of times offered',       help: 'Total class meetings across all partner classes.' },
  { key: 'partner_students',          group: 'partner',  label: 'Number of students',            help: 'Partner program students. Counted as free students in the report.' },
  { key: 'partner_instruction_hours', group: 'partner',  label: 'Number of hours of instruction', help: 'Total instruction hours across all partner classes.', decimal: true },
  { key: 'paid_audience',             group: 'audience', label: 'Paid audience members',          help: 'Ticketed attendance at CMC events.' },
  { key: 'free_audience',             group: 'audience', label: 'Free audience members',          help: 'Attendance at free CMC events.' },
]

export const DATA_ARTS_GROUPS = [
  { id: 'partner',  title: 'Partner programs' },
  { id: 'audience', title: 'Audiences' },
]

// PostgREST reports a table it can't see as PGRST205 (schema cache) and
// Postgres as 42P01. Either means migration 005 hasn't been applied yet, which
// the pages explain instead of showing a raw error.
export function isMissingTable(error) {
  return error?.code === 'PGRST205' || error?.code === '42P01'
}

// The input row for one fiscal year, or null if nothing has been entered.
// Resolves { row, missingTable, error }.
export async function loadDataArtsInput(supabase, fiscalYear) {
  const { data, error } = await supabase
    .from(DATA_ARTS_TABLE)
    .select('*')
    .eq('fiscal_year', fiscalYear)
    .maybeSingle()
  if (error) return { row: null, missingTable: isMissingTable(error), error: isMissingTable(error) ? null : error.message }
  return { row: data ?? null, missingTable: false, error: null }
}

// "FY26" → 2026, for building year ranges.
function fyNumber(fy) {
  const m = fy?.match(/^FY(\d{2})$/)
  return m ? 2000 + Number(m[1]) : null
}

function fyLabel(year) { return 'FY' + String(year).slice(-2) }

// The fiscal year in progress on a date, taking July 1 as the turnover. Only
// used to decide which years the input form offers — records are classified by
// ASAP's own Fiscal Year column, never by date (some Summer sections start in
// mid-June and still belong to the next FY).
export function fiscalYearOf(date = new Date()) {
  return fyLabel(date.getMonth() >= 6 ? date.getFullYear() + 1 : date.getFullYear())
}

// Every FY from FIRST_DATA_ARTS_FY through `last`, oldest first.
export function dataArtsYearsThrough(last) {
  const from = fyNumber(FIRST_DATA_ARTS_FY)
  const to   = Math.max(fyNumber(last) ?? from, from)
  const out = []
  for (let y = from; y <= to; y++) out.push(fyLabel(y))
  return out
}

// Which quarters make up a fiscal year, for labelling the form and report so
// nobody has to remember that FY26 began in Summer 2025.
export function fiscalYearSpan(fy) {
  const y = fyNumber(fy)
  return y ? `Summer ${y - 1} – Spring ${y}` : ''
}
