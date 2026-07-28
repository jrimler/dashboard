# CMC Dashboard

The ship-every-change workflow, verification habit, and push-vs-PR rules live in `~/.claude/CLAUDE.md` and apply here. This file covers only what's specific to this repo.

`Project Summary.md` is the canonical description of this app — read it before starting work, and update it in the same commit whenever a change alters what a report shows, how a number is derived, the schema, or the upload pipeline.

## Reports are the product

A wrong number is the worst kind of bug here, so verify against the live database rather than reasoning about the logic:

- `scripts/db.mjs` gives an authenticated Supabase client from the `service_role` key in `.env` (gitignored, bypasses RLS, read-only grant). Never import it into anything under `src/`.
- Extract the report file's own pure functions and run those over real data.
- Reconcile where possible — e.g. classified rows + deliberately excluded rows = all coded rows.

Each report's **"About this report" panel is methodology documentation** for staff running recurring reports, not UI copy. If a change affects how a number is arrived at, the About text changes with it.

Pushing to `main` deploys to cmcdashboard.netlify.app. That's intended.

## Conventions that bite

- **Paginate every Supabase fetch** in 1000-row batches. An unpaginated query silently caps at 1000 rows and returns no error — this shipped as a real bug in the Board report.
- **ASAP empty cells** are a blank string, a single space, or the literal `"0"` — all three mean empty.
- **Placeholder birthdates**: ASAP writes `1900-01-01` when a birthdate is missing. Treat ages outside 0–100 as unknown.
- **ASAP relabels things constantly** (discount codes, income brackets, ethnicity columns). Match with patterns, and route anything unmatched into a visible "unmatched" bucket rather than dropping it silently.
- **No student names** in new reports unless the report specifically calls for a roster.
