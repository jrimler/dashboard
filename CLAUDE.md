# CMC Dashboard — working agreement

`Project Summary.md` is the canonical description of this app. Read it before starting work.

## Ship every change without being asked

When a change to `src/`, `scripts/`, `supabase/`, or config is complete and verified, finish the job in the same turn — do not wait for permission at any step:

1. **Build** — `npx vite build` must pass.
2. **Update `Project Summary.md`** — if the change alters what a report shows, how a number is derived, the schema, or the upload pipeline, edit the relevant section in the same commit. A stale summary is treated as a bug.
3. **Update the report's "About this report" panel** — these are methodology documentation for staff running recurring reports, not UI copy. If the change affects how a number is arrived at, the About text changes with it.
4. **Commit** with a descriptive message: what changed, why, and any figure that verifies it. No generic "update report" messages.
5. **Push to `main`.** Netlify auto-deploys from `main`, so pushing publishes to cmcdashboard.netlify.app. That is intended — the user wants changes live.

Report what shipped, including the commit SHA. Never end a turn with finished work sitting uncommitted or unpushed.

Still ask before: rewriting published history (force-push, hard reset), deleting data, or anything touching the Supabase schema in production.

## Verifying report logic

Reports are the product here, so a wrong number is the worst kind of bug. Before shipping a change to report logic, check it against the live database rather than reasoning about it:

- `scripts/db.mjs` gives an authenticated Supabase client from the `service_role` key in `.env` (gitignored, bypasses RLS, read-only grant). Never import it into anything under `src/`.
- Prefer extracting the report file's own pure functions and running those over real data — a reimplementation in a scratch script can agree with itself and still be wrong.
- Reconcile totals when the shape allows it (e.g. classified rows + deliberately excluded rows = all rows).
- Quote the verifying figure in the commit message and to the user.

## Conventions that bite

- **Paginate every Supabase fetch** in 1000-row batches. An unpaginated query silently caps at 1000 rows and returns no error.
- **ASAP empty cells** are a blank string, a single space, or the literal `"0"` — all three mean empty.
- **Placeholder birthdates**: ASAP writes `1900-01-01` when a birthdate is missing. Treat ages outside 0–100 as unknown.
- **ASAP relabels things constantly** (discount codes, income brackets, ethnicity columns). Match with patterns, and route anything unmatched into a visible "unmatched" bucket rather than dropping it.
- **No student names** in new reports unless the report specifically calls for a roster.
