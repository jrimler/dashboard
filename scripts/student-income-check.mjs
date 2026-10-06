// Checks a STUDENT report export's household income before (or after) it is
// uploaded: which income column each answer comes from, which headers the
// upload would ignore, which answers the income map doesn't classify, and how
// the stored income in the live database would change.
//
// Runs src/utils/householdIncome.js — the module the upload itself calls — so
// the file is read exactly as an upload would read it. Prints counts and
// bracket labels only, never student names.
//
// Usage: node scripts/student-income-check.mjs <StudentReport.xls>
import XLSX from 'xlsx'
import { sb } from './db.mjs'
import {
  INCOME_COLUMNS, householdIncome, unknownIncomeColumns, unmappedIncomeValues,
} from '../src/utils/householdIncome.js'

const file = process.argv[2]
if (!file) { console.error('Usage: node scripts/student-income-check.mjs <StudentReport.xls>'); process.exit(1) }

const wb = XLSX.readFile(file)
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null })
  .filter(r => String(r['Customer ID'] ?? '').trim())
const headers = Object.keys(rows[0] ?? {})
console.log(`${rows.length.toLocaleString()} students in ${file}\n`)

const stray = unknownIncomeColumns(headers)
console.log(stray.length ? `UNRECOGNISED income columns (would be ignored): ${stray.join(' | ')}` : 'No unrecognised income columns.')
const missing = INCOME_COLUMNS.filter(c => !headers.includes(c))
if (missing.length) console.log(`Known columns absent from this export: ${missing.join(' | ')}`)

// Which column supplied each student's answer. householdIncome() returns the
// first real value in INCOME_COLUMNS order, so the first column whose trimmed
// value equals the result is the source.
const bySource = new Map([...INCOME_COLUMNS, '(no answer)'].map(c => [c, 0]))
const income = new Map()
for (const r of rows) {
  const v = householdIncome(r)
  income.set(String(r['Customer ID']).trim(), v)
  const src = v ? INCOME_COLUMNS.find(c => String(r[c] ?? '').trim() === v) : '(no answer)'
  bySource.set(src, bySource.get(src) + 1)
}
console.log('\nAnswer taken from:')
for (const [c, n] of bySource) console.log(`  ${String(n).padStart(6)}  ${c}`)
const sourced = [...bySource.values()].reduce((a, b) => a + b, 0)
console.log(`  ${String(sourced).padStart(6)}  total — ${sourced === rows.length ? 'reconciles' : 'MISMATCH'} with ${rows.length} students`)

const unmapped = unmappedIncomeValues([...income.values()])
console.log(unmapped.length
  ? `\nNot in INCOME_MAP (will report as No Response): ${unmapped.map(([v, n]) => `${v} (${n})`).join(', ')}`
  : '\nEvery answer is in INCOME_MAP.')

// Compare with what the database holds now for the same students.
const ids = [...income.keys()]
const stored = new Map()
for (let i = 0; i < ids.length; i += 200) {
  const { data, error } = await sb.from('students').select('customer_id, household_income').in('customer_id', ids.slice(i, i + 200))
  if (error) { console.error(error.message); process.exit(1) }
  for (const s of data) stored.set(s.customer_id, s.household_income?.trim() || null)
}
const t = { notInDb: 0, unchanged: 0, gained: 0, changed: 0, lost: 0 }
for (const [id, v] of income) {
  if (!stored.has(id)) { t.notInDb++; continue }
  const was = stored.get(id)
  if ((was ?? null) === (v ?? null)) t.unchanged++
  else if (!was) t.gained++
  else if (!v) t.lost++
  else t.changed++
}
console.log('\nUploading this file would change stored income for these students:')
console.log(`  ${String(t.gained).padStart(6)}  gain an answer (none stored now)`)
console.log(`  ${String(t.changed).padStart(6)}  change answer`)
console.log(`  ${String(t.lost).padStart(6)}  LOSE their stored answer`)
console.log(`  ${String(t.unchanged).padStart(6)}  unchanged`)
console.log(`  ${String(t.notInDb).padStart(6)}  not in the database yet`)
const sum = Object.values(t).reduce((a, b) => a + b, 0)
console.log(`  ${String(sum).padStart(6)}  total — ${sum === rows.length ? 'reconciles' : 'MISMATCH'}`)
