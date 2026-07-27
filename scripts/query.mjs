// Quick ad-hoc table query for local analysis.
// Usage examples:
//   node scripts/query.mjs events "course_name=ilike.*Teen Jazz*" "select=event_id,course_name,fiscal_year" limit=20
//   node scripts/query.mjs enrollments "event_id=eq.ABC123" "select=customer_id,students(birthdate)"
//
// Args after the table name are PostgREST filters (col=op.value), a select=...
// clause, and/or limit=N. Output is pretty-printed JSON.
import { sb } from './db.mjs'

const [, , table, ...rest] = process.argv
if (!table) {
  console.error('Usage: node scripts/query.mjs <table> [col=op.value ...] [select=...] [limit=N]')
  process.exit(1)
}

let select = '*'
let limit = null
const filters = []
for (const a of rest) {
  if (a.startsWith('select=')) select = a.slice(7)
  else if (a.startsWith('limit=')) limit = Number(a.slice(6))
  else filters.push(a)
}

let q = sb.from(table).select(select)
for (const f of filters) {
  const eq = f.indexOf('=')
  const col = f.slice(0, eq)
  const rhs = f.slice(eq + 1)
  const dot = rhs.indexOf('.')
  const op = rhs.slice(0, dot)
  const val = rhs.slice(dot + 1)
  q = q.filter(col, op, val)
}
if (limit) q = q.limit(limit)

const { data, error } = await q
if (error) { console.error(error.message); process.exit(1) }
console.log(JSON.stringify(data, null, 2))
console.error(`\n(${data.length} rows)`)
