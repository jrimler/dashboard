// Paginated Supabase reads.
//
// Two rules this encodes, both learned the hard way:
//
// 1. Always paginate. An unpaginated Supabase query silently caps at 1000 rows
//    and returns no error — that shipped as a real undercount in the Board report.
//
// 2. Always order by a unique column. PostgREST's .range() is an OFFSET, and
//    without a stable sort Postgres is free to return rows in a different order
//    for each request, so pages can overlap or skip. Ordering by the primary key
//    costs nothing measurable once the pages are issued concurrently.
//
// The speed comes from issuing the pages in parallel instead of one after
// another. Measured against the live database on the enrollments table
// (31,561 rows, 32 pages): 3,643 ms sequential with a nested events() join →
// 499 ms fetching enrollments and events flat, in parallel, and joining them in
// the client. Same rows, 0 orphans. The nested join was the expensive part, not
// the ordering.
//
// One caveat: the row count is read first, so rows inserted between the count
// and the page fetches would fall outside the last page. This dashboard is
// read-only between manual quarterly uploads, so that cannot happen in practice.

const PAGE_SIZE = 1000

// Cap concurrency so a table that grows past a few hundred thousand rows can't
// fire hundreds of simultaneous requests.
const MAX_CONCURRENT = 8

async function inBatches(tasks, limit) {
  const out = []
  for (let i = 0; i < tasks.length; i += limit) {
    out.push(...await Promise.all(tasks.slice(i, i + limit).map(t => t())))
  }
  return out
}

/**
 * Fetch every row of a table, paginated and in parallel.
 *
 * @param supabase           the Supabase client
 * @param table              table name
 * @param select             PostgREST select string
 * @param orderBy            a UNIQUE column — required, for stable pagination
 * @param apply              optional (query) => query, to add filters; it is
 *                           applied to both the count and the page queries so
 *                           the two can never disagree
 * @returns Promise<rows>    throws on error
 */
export async function fetchAll(supabase, table, { select, orderBy, apply = q => q }) {
  if (!orderBy) throw new Error(`fetchAll(${table}) needs an orderBy column for stable pagination`)

  const { count, error: countError } =
    await apply(supabase.from(table).select('*', { count: 'exact', head: true }))
  if (countError) throw new Error(countError.message)
  if (!count) return []

  const pages = Math.ceil(count / PAGE_SIZE)
  const results = await inBatches(
    Array.from({ length: pages }, (_, i) => () =>
      apply(supabase.from(table).select(select))
        .order(orderBy)
        .range(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1)
    ),
    MAX_CONCURRENT
  )

  const rows = []
  for (const r of results) {
    if (r.error) throw new Error(r.error.message)
    rows.push(...r.data)
  }
  return rows
}

/**
 * Attach a related row to each record under `as`, replacing what a nested
 * PostgREST join would have returned. Fetching the two tables flat and joining
 * here is dramatically faster than asking PostgREST to join per page.
 */
export function joinBy(rows, related, { on, as, relatedKey = on }) {
  const index = new Map(related.map(r => [r[relatedKey], r]))
  for (const row of rows) row[as] = index.get(row[on])
  return rows
}
