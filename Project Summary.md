# CMC Dashboard — Project Summary

Internal reporting dashboard for San Francisco Community Music Center (SFCMC). Updated quarterly by manually uploading three ASAP exports. Live at **cmcdashboard.netlify.app**.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite 5, React Router v6 |
| Backend / DB | Supabase (Postgres) |
| Hosting | Netlify (auto-deploys from GitHub on push to `main`) |
| Repo | github.com/jrimler/dashboard |
| File parsing | SheetJS (xlsx) |
| Env vars | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |

---

## Source Reports

Three standardized ASAP exports. May arrive as real XLSX or HTML-disguised-as-XLS — the parser handles both.

| Internal name | Report name | Primary use |
|---|---|---|
| REGULAR | Enrollment Report | Financial data, instructor names, quarter/term |
| SUPER | Super Enrollment Report | Class details, location, timing, fiscal year |
| STUDENT | Student Report | Demographics, identity, account info |

### Columns extracted

**REGULAR:** `EventEnrollmentID`, `Customer ID`, `TimePeriod`, `Amount`, `Event ID`, `Total Discount`, `Discount Type`, `Instructor Last`, `Instructor First`

**SUPER:** `Course Name`, `Fiscal Year`, `Primary Instructor`, `Location`, `Facility`, `Department`, `Activity Type`, `Class Start Date`, `Class End Date`, `Lesson Duration`, `All Meetings`, `Studentid`, `Event ID`, `Event Enrollment ID`, `Time Period`

**STUDENT:** `Customer ID`, `First Name`, `Last Name`, `Birthdate`, `Customer Account Created Date`, `Gender`, `Gender1`, `Ethnicity`, `Ethnicity1`, `Ethnicity Info`, `Household Income - CMC funders ask for this inform`, `Household Income - CMC s funders ask for this info`, `Pronouns`

---

## Database Schema

### `students`
Primary key: `customer_id`

| Field | Type | Notes |
|---|---|---|
| `customer_id` | text PK | |
| `first_name` | text | |
| `last_name` | text | |
| `birthdate` | date | |
| `account_created_date` | timestamptz | |
| `gender` | text | Coalesce: `Gender1` wins over `Gender` |
| `ethnicity` | text | Coalesce: `Ethnicity Info` > `Ethnicity1` > `Ethnicity` |
| `household_income` | text | Coalesce: newer column name wins |
| `pronouns` | text | |

### `events`
Primary key: `event_id` (one row per class/lesson section)

| Field | Type | Notes |
|---|---|---|
| `event_id` | text PK | |
| `course_name` | text | e.g. "Piano", "Mariachi CMC" |
| `department` | text | e.g. "Piano", "Strings", "Latin" |
| `activity_type` | text | `"LESSON"` (private) or `"CLASS"` (group) |
| `location` | text | `"Mission Branch"` or `"Richmond Branch"` — trimmed on ingest (source has trailing spaces) |
| `facility` | text | Raw room name, e.g. "(C) Studio C" |
| `is_virtual` | boolean | `true` if facility contains "virtual" (case-insensitive) |
| `primary_instructor` | text | "Last, First" format |
| `class_start_date` | date | |
| `class_end_date` | date | |
| `lesson_duration_minutes` | integer | |
| `all_meetings` | integer | Total sessions in quarter |
| `fiscal_year` | text | e.g. "FY26" |
| `time_period` | text | e.g. "Spring Quarter 2026" |

### `enrollments`
Primary key: `event_enrollment_id` (join of REGULAR + SUPER)

| Field | Type | Notes |
|---|---|---|
| `event_enrollment_id` | text PK | |
| `event_id` | text FK → events | |
| `customer_id` | text FK → students | |
| `time_period` | text | from REGULAR `TimePeriod` |
| `fiscal_year` | text | from SUPER `Fiscal Year` |
| `amount` | numeric | Raw tuition |
| `total_discount` | numeric | |
| `discount_type` | text | |
| `is_tuition_free` | boolean | `(amount - total_discount) <= 15` |
| `instructor_name` | text | "Last, First" from REGULAR |

---

## Upload Pipeline (`src/utils/uploadReports.js`)

1. Each file is optional — pass `null` to skip that table
2. Enrollments require **both** REGULAR + SUPER (joined on `event_enrollment_id`)
3. Upserts in batches of 500 rows
4. FK order enforced: students → events → enrollments
5. Enrollments with no matching `customer_id` in the parsed student data are silently skipped to avoid FK violations
6. `location` is `.trim()`-ed on ingest (Richmond source data has trailing spaces)

### Derived fields
- `is_tuition_free`: `(amount - total_discount) <= 15`
- `is_virtual`: `facility.toLowerCase().includes('virtual')`
- `instructor_name`: `"${Instructor Last}, ${Instructor First}"`

---

## Fiscal Year / Quarter Ordering

Quarters sort in this order within each FY (not alphabetical, not calendar):

| Order | Season | Example |
|---|---|---|
| 1 | Summer | Summer Quarter 2025 |
| 2 | Fall | Fall Quarter 2025 |
| 3 | Winter | Winter Quarter 2026 |
| 4 | Spring | Spring Quarter 2026 |

FY26 = Summer 2025 → Fall 2025 → Winter 2026 → Spring 2026

**Sort key:** `quarterFY(season, year) * 10 + SEASON_ORDER[season]`
- `quarterFY`: Summer/Fall belong to the *next* calendar year's FY; Winter/Spring stay in their calendar year
- Example: Spring 2026 → FY 2026 → `2026 * 10 + 4 = 20264`
- Fiscal year sort key = `fullYear * 10` (sorts before all its own quarters, same numeric scale)

Time period strings: `"Spring Quarter 2026"`, `"Fall Quarter 2025"`
Fiscal year strings: `"FY26"`, `"FY25"`

Implemented in `src/utils/periodUtils.js`.

---

## App Structure

```
src/
  lib/
    supabase.js              Supabase client (reads VITE_ env vars, throws if missing)
  utils/
    uploadReports.js         Full upload + upsert pipeline (parse → join → upsert)
    periodUtils.js           Period sorting, parsing, label formatting, sort keys
  pages/
    Upload.jsx               Working — file inputs, progress log, Test Connection button
    Enrollment.jsx           Working — see below
    Retention.jsx            Working — see below
    Classes.jsx              Working — see below
    Students.jsx             Placeholder
  App.jsx                    Sidebar nav shell (React Router v6)
  main.jsx
  index.css
supabase/
  migrations/
    001_initial_schema.sql   All three tables + indexes
netlify.toml                 SPA redirect (/* → /index.html)
.env.example                 Env var template
```

---

## Pages

### Upload
Three file inputs (REGULAR, SUPER, STUDENT), Upload button, scrolling status log. Each file is optional. Test Connection button validates Supabase credentials.

---

### Enrollment (`/enrollment`)

**Data loading strategy:** Two-phase.
1. **On mount** — lightweight fetch: `customer_id, time_period, fiscal_year` from all enrollments (no joins). Used for period pills and `firstKey` (per-customer earliest quarter, needed for New/Returning across all time on the Retention page).
2. **On period selection** — scoped fetch: full enrollment + `events(location, activity_type)` join, filtered server-side with `.in('time_period', [...])` or `.in('fiscal_year', [...])`.

**Period selector:** Pills grouped as Fiscal Years and Quarters (grouped by FY label). Multi-select; each period becomes a table column sorted chronologically. Clear button visible when any period is selected.

**Report table:** Two main sections, each with a muted section header:

*All Branches*
- Total (bold)
- — Fee Based
- — Tuition Free
- — Lessons
- — Group Classes
- — Fee Based — Lessons
- — Fee Based — Group Classes
- — Tuition Free — Lessons
- — Tuition Free — Group Classes

*Mission Branch* — same 9 rows, filtered to `location = "Mission Branch"`

*Richmond Branch* — same 9 rows, filtered to `location = "Richmond Branch"`

**Column types:**
- **Period column:** enrollment count (large) + unique student count (small/muted), stacked
- **Δ column** (between consecutive periods): `+42 / +8.3%` — green if positive, red if negative

**Export:** CSV with all visible rows × all columns; delta columns broken into raw + % separately.

---

### Retention (`/retention`)

**Data loading strategy:** Same lightweight mount fetch as Enrollment (`customer_id, time_period, fiscal_year`). No additional fetch on period selection — all classification is computed client-side from the global data.

**Period selector:** Same pill UI as Enrollment.

**Student classification:** For each selected period, each unique student in that period is classified into exactly one category:

- **New** — their `firstKey` (earliest-ever enrollment sort key across all DB data) falls within this period's sort key range
- **Continuing** — not new, AND appeared in the immediately preceding quarter (only shown when the preceding quarter exists in the DB)
- **Returning** — not new, not continuing (lapsed and came back)

**Preceding quarter adjacency logic** (from `precedingQuarterSortKey`):
- Summer Q (year Y) ← Spring Q (year Y): `Y*10+4`
- Fall Q (year Y) ← Summer Q (year Y): `(Y+1)*10+1`
- Winter Q (year Y) ← Fall Q (year Y-1): `Y*10+2`
- Spring Q (year Y) ← Winter Q (year Y): `Y*10+3`

Continuing is shown as `—` if the preceding quarter has no data in the DB, or if the selected period is a fiscal year (adjacency not defined for FY-level periods).

**Report table:**
- Total Students (bold)
- New (count + % of total)
- Continuing (count + % of total, or `—`)
- Returning (count + % of total)
- Δ columns between consecutive periods (omits Continuing delta if either side is null)

**Export:** CSV with all rows × all columns.

---

### Classes (`/classes`)

**Data loading strategy:** Two-phase.
1. **On mount** — lightweight fetch: `event_id, time_period, fiscal_year` from `events WHERE activity_type = 'CLASS'`. Used only to populate period pills. No enrollment data fetched.
2. **On period selection** — two sequential queries:
   - Fetch full event details from `events WHERE activity_type = 'CLASS'` filtered server-side (`.in('time_period', [...])`, `.in('fiscal_year', [...])`, or `.or(...)` for mixed)
   - Fetch enrollments scoped to returned event IDs only: `.in('event_id', [...eventIds])`

**Period selector:** Same pill UI as Enrollment, but periods are derived only from CLASS events.

**Tuition-free classification:** Derived per class after the scoped fetch. A class is tuition-free if every one of its enrollments has `is_tuition_free = true`.

**Filter pills:** "Tuition Free" and "Fee Based" toggles above the table (both active by default). Deselecting one hides that category.

**Class list table** (flat, one row per `event_id`):
- Course Name, Department, Instructor, Location, Quarter, Enrolled, Tuition Free (count/total), Dates, Sessions
- Sortable by any column
- Total row: section count, total enrolled, total tuition-free

**Drilldown:** Click any row to expand inline. Shows:
- Left panel: full class details (course, department, instructor, location, facility, dates, sessions, duration, period, fiscal year, enrollment summary)
- Right panel: scrollable student roster (name, customer ID, amount, discount type, tuition-free flag) with its own CSV export

**Export:** Table-level CSV (visible rows) and per-class drilldown CSV.

---

### Students (`/students`)
**Status: Placeholder.** Not yet built.

Planned: filterable by quarter/fiscal year, gender, ethnicity, household income, pronouns, age (derived from birthdate). Show unique student counts and demographics breakdown. CSV export.

---

## Known Issues / Design Decisions

| Issue | Status | Notes |
|---|---|---|
| Richmond location has trailing spaces in ASAP export | Fixed | `.trim()` on ingest and in all report queries |
| Supabase 1000-row default page limit | Fixed | All fetches paginate in 1000-row batches |
| `is_tuition_free` threshold | Decided | `<= 15` (not `=== 0`) to handle small processing fees |
| Enrollment FK violations on upload | Fixed | Enrollments with no matching student silently skipped |
| New/Returning accuracy | Accepted | Depends on consistent `customer_id` values across all historical uploads |
| Initial page load slowness | Fixed | Classes and Enrollment now defer heavy fetches until a period is selected |
| Preceding quarter undefined for fiscal year periods | By design | Continuing row shows `—` for FY-level columns in Retention |
