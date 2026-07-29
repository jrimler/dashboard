# CMC Dashboard — Project Summary

Internal reporting dashboard for San Francisco Community Music Center (SFCMC). Updated quarterly by manually uploading four ASAP exports. Live at **cmcdashboard.netlify.app**.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite 5, React Router v6 |
| Backend / DB | Supabase (Postgres + Auth) |
| Hosting | Netlify (auto-deploys from GitHub on push to `main`) |
| Repo | github.com/jrimler/dashboard |
| File parsing | SheetJS (xlsx) |
| Env vars | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |

---

## Source Reports

Four standardized ASAP exports. May arrive as real XLSX or HTML-disguised-as-XLS — the parser handles both. Two ASAP quirks the pipeline compensates for: "empty" cells often contain a single space or a literal `0` rather than nothing, and enrollment exports can end with a junk totals row (blank enrollment ID).

| Internal name | Report name | URL | Primary use |
|---|---|---|---|
| REGULAR | Enrollment Report | `/Reports/EnrollmentsReport.aspx` | Financial data, instructor names, quarter/term |
| SUPER | Super Enrollment Report | `/reports/SuperEnrollment.aspx?ReportID=30209` | Class details, location, timing, fiscal year |
| STUDENT | Student Report | `/Reports/StudentReport.aspx` | Demographics, identity, account info |
| CLASS SCHEDULE | Super Class Summary Report | `/reports/CustomQuery.aspx?ReportID=29315` | Schedule details: days, times, age range |

All URLs are relative to `app.asapconnected.com`. The Upload page shows the full URL and run instructions for each report.

### Columns extracted

**REGULAR:** `EventEnrollmentID`, `Customer ID`, `TimePeriod`, `Amount`, `Event ID`, `Total Discount`, `Discount Type`, `Instructor Last`, `Instructor First`

**SUPER:** `Course Name`, `Fiscal Year`, `Primary Instructor`, `Location`, `Facility`, `Department`, `Activity Type`, `Class Start Date`, `Class End Date`, `Lesson Duration`, `All Meetings`, `Studentid`, `Event ID`, `Event Enrollment ID`, `Time Period`

**STUDENT:** `Customer ID`, `First Name`, `Last Name`, `Birthdate`, `Customer Account Created Date`, `Gender`, `Gender1`, `Ethnicity`, `Ethnicity1`, `Ethnicity Info`, `Household Income - CMC funders ask for this inform`, `Household Income - CMC s funders ask for this info`, `Pronouns`

**CLASS SCHEDULE:** `Class ID` (→ `event_id`), `Facility`, `Days Of Week`, `Start Time`, `End Time`, `Age Min`, `Age Max`, `Course ID`

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
| `gender` | text | Coalesce: `Gender1` wins over `Gender`; legacy single-letter codes normalized (M→Male, F→Female, N→Nonbinary/Gender Nonconforming/Genderqueer, D→Decline to State) |
| `ethnicity` | text | Coalesce: `Ethnicity` > `Ethnicity1` > `Ethnicity Info` (matches ASAP standard reporting — the original `Ethnicity` column wins) |
| `household_income` | text | Coalesce: newer column name wins |

Coalescing takes the first **real** value: whitespace-only cells and literal `"0"` (ASAP's empty-cell placeholders) are treated as null, so a blank-looking high-priority column can't shadow an actual answer in a lower-priority one. (Before this fix, roughly a third of students had a demographic field silently blanked.)
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

### `class_schedule`
Primary key: `event_id` (FK → `events.event_id`). One row per class section; populated from the CLASS SCHEDULE report.

| Field | Type | Notes |
|---|---|---|
| `event_id` | text PK FK | References `events.event_id` |
| `facility` | text | Room/space name |
| `days_of_week` | text | e.g. "Monday, Wednesday" |
| `start_time` | text | e.g. "10:00 AM" |
| `end_time` | text | e.g. "11:00 AM" |
| `age_min` | integer | Minimum age for the class (nullable) |
| `age_max` | integer | Maximum age for the class (nullable) |
| `course_id` | text | ASAP course identifier (stored as text) |

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
2. Enrollment statuses are validated: only `ENROLLED` and `PEND` are allowed; any other value rejects the file (junk totals rows with no enrollment ID are exempt — they never import)
3. Enrollments require **both** REGULAR + SUPER (joined on `event_enrollment_id`)
4. **Replace-by-quarter:** before inserting, existing enrollment rows for the time periods present in the batch are deleted. Each REGULAR+SUPER upload is a point-in-time snapshot, so this keeps the dashboard authoritative for its quarters — enrollments cancelled or changed in ASAP after a previous upload don't linger. Re-uploading a full-FY pull trues up the whole fiscal year. (Requires `DELETE` grant — migration 003.)
5. Upserts in batches of 500 rows
6. FK order enforced: students → events → enrollments → class_schedule
7. Enrollments with no matching `customer_id` in the parsed student data are skipped with a logged warning to avoid FK violations
8. `location` is `.trim()`-ed on ingest (Richmond source data has trailing spaces)
9. CLASS SCHEDULE is upserted last (after enrollments) because `class_schedule.event_id` FK references `events`

**Student uploads are last-write-wins** per `customer_id`: when re-uploading multiple STUDENT reports, go oldest → newest so the most recent demographics survive.

### Function signature
```js
uploadReports(regularFile, superFile, studentFile, log, classFile = null)
```

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
    Login.jsx                Email/password login screen (shown when no session)
    Upload.jsx               Working — 4 labeled report sections (URL + instructions + file input), progress log, Test Connection
    Enrollment.jsx           Working — see below
    Retention.jsx            Working — see below
    Classes.jsx              Working — see below
    SpecializedReporting.jsx Report gallery at /reports — cards from the REPORTS registry; see below
    ReportDetail.jsx         Renders one report at /reports/:reportId (looks it up in the registry)
  reports/
    registry.js                     REPORTS array — id/label/description/component for each report; drives the gallery + routing
    demographicCategories.js        Shared income/ethnicity/gender category definitions (see below)
    PianoInspiresGrant.jsx          Specialized report — see below
    UniqueGroupClassesBoard.jsx     Specialized report — see below
    Demographics.jsx                Specialized report — see below
    LowIncomeYouthProgram.jsx       Specialized report — see below
    NeighborhoodChoirDemographics.jsx  Specialized report — see below
    DiscountCodes.jsx               Specialized report — see below
  App.jsx                    Auth gating + sidebar nav shell (React Router v6)
  main.jsx
  index.css
scripts/                     Local analysis tooling (Node, service_role key) — NOT shipped to the browser
  db.mjs                     Authenticated Supabase client from .env SUPABASE_SERVICE_ROLE_KEY (bypasses RLS; read-only grant)
  query.mjs                  Quick CLI table query: node scripts/query.mjs <table> "col=op.value" "select=..." limit=N
  neighborhood-choir-check.mjs  Verifies the Neighborhood Choir report by extracting its own pure-logic block and running it over live data
  income-base-check.mjs      Verifies the income percentage base (Decline to State excluded for income only) across both income-reporting reports
supabase/
  migrations/
    001_initial_schema.sql   students, events, enrollments tables + indexes
    002_class_schedule.sql   class_schedule table + index (FK → events)
    003_grant_delete_enrollments.sql   DELETE grant for replace-by-quarter uploads
CLAUDE.md                    Working agreement: ship-every-change workflow, verification rules, ASAP gotchas
netlify.toml                 SPA redirect (/* → /index.html)
.env.example                 Env var template
```

**Local data tooling:** `scripts/db.mjs` / `scripts/query.mjs` let a developer query the live Supabase DB from the command line using a `service_role` key in `.env` (gitignored). This required a one-time `GRANT SELECT ... TO service_role` in the Supabase SQL editor — the tables were originally readable only by the `authenticated` role, so the app worked but scripts (and the anon key) got "permission denied." The key bypasses Row Level Security, so these files must never be imported into browser code.

### Sidebar nav order
Reports → Enrollment → Retention → Classes → Upload

---

## Pages

### Login (`/`)

Email/password authentication via Supabase Auth. Shown to any unauthenticated visitor — the rest of the app is entirely hidden.

- Centered card with CMC logo mark, email and password inputs; calls `supabase.auth.signInWithPassword({ email, password })` on submit
- Shows "Invalid email or password." on failure; on success the `onAuthStateChange` listener in `App.jsx` handles the transition automatically (no redirect logic needed in the form)
- `App.jsx` resolves the session on mount with `getSession()` and stays in sync via `onAuthStateChange`. While the session is resolving, nothing is rendered (prevents flash). Once authenticated, the full layout renders; on sign-out, the login screen returns.
- Sign out button at the bottom of the sidebar calls `supabase.auth.signOut()`
- After login, the root route redirects to Reports (`/` → `/reports`)

---

### Upload
Four labeled report sections, each showing: report name, linked ASAP URL (opens in new tab), run instructions, and a file picker. Reports: Enrollment Report, Super Enrollment Report, Student Report, Super Class Summary Report. Upload button, scrolling status log. Each file is optional. Test Connection button validates Supabase credentials.

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

### Specialized Reporting (`/reports` + `/reports/:reportId`)

`/reports` (`SpecializedReporting.jsx`) is a **gallery** of report cards — one button per entry in the `REPORTS` array (`src/reports/registry.js`), each showing the report's label and description. Clicking a card navigates to `/reports/:reportId`, where `ReportDetail.jsx` looks the id up in the registry and renders that report's component (redirecting to `/reports` if the id is unknown).

Adding a new report requires only: create the component in `src/reports/`, then add an `{ id, label, description, component }` entry to the `REPORTS` array in `registry.js`. Report order in the gallery follows array order, and the array is kept alphabetical by label — insert a new entry in its alphabetical slot.

---

#### Piano Inspires Grant

Counts unique students enrolled in any piano or keyboard lesson or group class for a selected period. Reports total students, students receiving tuition assistance (tuition-free or any discount applied), and percentage assisted. Includes a collapsible course coverage list and a full student roster with CSV export.

---

#### Unique Group Classes for Board

**Uniqueness:** One row per unique combination of `(course_name, primary_instructor, days_of_week, start_time, end_time)`. The same course running at a different time or with a different instructor appears as a separate row. Schedule fields (`days_of_week`, `start_time`, `end_time`) come from the `class_schedule` table; events with no matching row show `"—"` and still group correctly.

**Data loading:** Three-phase.
1. Mount: lightweight fetch of `fiscal_year` from CLASS events for FY period pills only (no quarter pills).
2. On FY selection: full CLASS event details from `events`.
3. Immediately after: batch-fetch `class_schedule` for all returned `event_id`s (500/request), then paginated enrollment fetch with `students(birthdate)` join. All three datasets joined client-side before grouping.

**Aggregation per unique class (across all matching events in the selected FY):**
- `quarters_offered`: sorted distinct `time_period` values (e.g. "Fall 2025, Winter 2026, Spring 2026")
- `total_enrolled`: sum of enrollment counts
- `total_tuition_free`: sum of tuition-free enrollment counts
- `age_group`: see below
- `tuition_free_status`: see below

**Category:** Hardcoded override map keyed on course name (`CATEGORY_MAP` at the top of `UniqueGroupClassesBoard.jsx`). Falls back to the ASAP `department` field if no override exists.

**Tuition-free:** All enrollments across all matching events are tuition-free (`is_tuition_free = true`), OR the course name starts with `"Young Musicians Program"` (hardcoded override).

**Youth vs. Adult:** Each enrolled student's age is calculated as of that enrollment's event's `class_start_date`. Students without a birthdate on record — **or with an implausible age (outside 0–100)** — are excluded from the check; ASAP writes a `1900-01-01` placeholder (age ~126) when a birthdate is missing, and without this guard a single placeholder flipped whole youth classes to Adult (this was the Teen Jazz Orchestra bug, fixed via `MAX_PLAUSIBLE_AGE = 100`). If every student with a confirmed age is under 19 across all matching events, the class is Youth; otherwise Adult. Defaults to Adult if no ages are known.

**Filter pills:** Two groups — Tuition Status (Tuition Free / Fee Based) and Age Group (Youth / Adult) — all active by default.

**Table columns:** Course Name, Category, Instructor, Days of Week, Time (start – end), Quarters Offered, Age Group, Tuition Status, Total Enrolled, Total Tuition Free — all sortable. Summary totals row at bottom (unique class count, total enrolled, total tuition free).

**Export:** CSV of all visible rows with the same 10 columns.

---

#### Demographics

Summarizes age, gender, ethnicity, and household income for **unique students** in a selected fiscal year or quarter. A scope toggle switches the breakdown between **Total** (lessons + classes), **Lessons**, and **Group Classes**; the Group Classes view also shows a per-class breakdown for each unique group class. Every figure is a raw unique-student count plus a percentage. Percentages are calculated out of the students whose answer counts toward that dimension's **base**; a category excluded from the base keeps its count and shows `—` instead of a `%`, and the categories that do get a percentage sum to 100%. The base is per-dimension (see **Percentage base** below). No student names or per-student detail appear anywhere.

**Period selector:** Fiscal Year + Quarter pills, **single-select** (one FY *or* one quarter at a time — a demographics snapshot). Same grouped-pill UI as Enrollment/Classes. Pills populated from distinct `fiscal_year` and `time_period` values in `enrollments`.

**Units broken down:**
- **Total Students** — all unique `customer_id`s with any enrollment in the period, across **all** activity types (`LESSON` + `CLASS`), counted exactly once.
- **Lesson Students** — unique students with any `LESSON` enrollment in the period. Flat aggregate; **not** split by course or instructor (by design).
- **Group Class Students** — unique students with any `CLASS` enrollment in the period. Flat aggregate across all group classes.
- **Each unique group class** — one row per `course_name` where `activity_type = 'CLASS'` (all sections/events with the same course name collapse together; instructor/day/time are *not* part of the grouping — differs from the Board report). Counts **unique students** within each course (a student in two sections of the same course counts once). Per-class counts do **not** sum to Group Class Students (a student can appear in multiple classes) — by design.

**Age brackets** (computed from `birthdate` against the enrollment's event `class_start_date`; earliest `class_start_date` within the unit): `0–2`, `3–35`, `36–54`, `55–74`, `75+`, and `No Response` (no birthdate, or birthdate before 1905).

**Gender / Ethnicity:** raw stored value as the category label; blank/null → `No Response`. Each student has one ethnicity (coalesced from the three source columns in priority order). Case-insensitive alias merges collapse related labels into one category: **ethnicity** — `"Hispanic"` and `"Latinx"` → `"Hispanic/Latinx"` (`ETHNICITY_ALIASES`); **gender** — `"Trans Male"`, `"Trans Female"`, `"Transgender"` → `"Transgender"`; `"Nonbinary/Gender Nonconforming/Genderqueer"` and `"Gender Non-Conforming"` → `"Nonbinary/Gender Nonconforming/Genderqueer"`; plus case normalization for `"Decline to State"` and `"Two Spirit"` (`GENDER_ALIASES`).

**Household income:** mapped via an explicit case-insensitive lookup table (`INCOME_MAP`), not numeric parsing. `High`: Above $154,700. `Low`: Below $60,600 / Below $58,000 / Below $60,000 / $96,700–$116,040 / $97,000–$145,200 / $58,000–$96,700 / $60,600–$97,000 / $60,001–$69,000 / $69,001–$78,000 / $78,001–$86,000 / $86,001–$93,000 / Above $93,001 / $116,040–$154,700 / Above $145,201. (The three top brackets other than Above $154,700 landing in `Low` reflects SF's very high area median income — HUD's low-income limit for a larger San Francisco household runs above $145k. An earlier version of this document listed Above $145,201 and $116,040–$154,700 as `High`, which never matched the shipped map.) `Decline to State`: Decline to state. `No Response`: blank, `0`, **and any value not in the map** (so a new ASAP income label lands in No Response rather than vanishing — map must be updated when ASAP adds brackets; ASAP's bracket labels have changed several times across years).

**Percentage base — income differs from the rest.** Two exclusion lists live in `demographicCategories.js` and are applied by every report that shows demographic percentages:

| Dimension | Excluded from the percentage base | Effect |
|---|---|---|
| Age, gender, ethnicity | `No Response` (`RESPONSE_PCT_EXCLUDED`) | `Decline to State` keeps a percentage under gender/ethnicity — there it is a meaningful self-description |
| **Household income** | `No Response` **and `Decline to State`** (`INCOME_PCT_EXCLUDED`) | Income percentages describe only students who **named a bracket**, so a rising number of decliners can't drag the low-income share down |

Excluding `Decline to State` from income was a deliberate change (July 2026, at the user's request) and it moves the numbers a lot, because declining income is common and rising: all students FY26 low-income share went 62.4% → **92.1%**, FY23 65.6% → 99.5%. The narrower base means an income percentage speaks for fewer students than a gender or ethnicity one — read it next to the `Decline to State` and `No Response` counts. Helpers `pctBase(counts, total, excluded)` and `bucketPct(label, count, base, excluded)` are shared, so the two exclusion rules cannot diverge between reports.

**Where these categories live:** the income map, income order, both exclusion lists, and both alias maps are in **`src/reports/demographicCategories.js`**, shared by Demographics, LIYP, and Neighborhood Choir Program Demographics. A grant report that disagreed with Demographics about what counts as "Low" income, or about how Hispanic/Latinx is grouped, would be a bug — so ASAP's periodic relabelling is absorbed in exactly one file. (These definitions previously lived in `Demographics.jsx` and were copied into LIYP.)

**UI:** Scope tabs (`Total · Lessons · Group Classes`, each showing its unique-student count) select which aggregate breakdown displays (count + % per bucket across the four dimensions). In the Group Classes view, a sortable class table with the Classes-page drilldown pattern appears below — click a class to expand its four-dimension breakdown. Percentages are relative to that dimension's base (excluded categories show `—` for their percentage: `No Response` everywhere, plus `Decline to State` under income); age and income buckets stay in fixed logical order, gender/ethnicity by descending count with `No Response` last.

**Data loading:** Two-phase. Mount → distinct `time_period` + `fiscal_year` from `enrollments` (FY + quarter pills). On period selection → paginated fetch (1000/batch) of `enrollments` filtered by `fiscal_year` (FY pill) or `time_period` (quarter pill), joined to `events(activity_type, course_name, class_start_date)` and `students(birthdate, gender, ethnicity, household_income)`; all dedup/age/bucketing done client-side.

**Export:** One comprehensive flat CSV per period — a row per unit (Total Students, Lesson Students, Group Class Students, then each class) with count + % columns for every age bracket, income category, and gender/ethnicity value present (gender/ethnicity columns generated dynamically).

---

#### Low-Income Youth Program (LIYP)

Grant report on four low-income youth cohorts for **one or more selected fiscal years** (FY pills, multi-select). For each group it shows **unique students** (counted once per FY; every enrollment already qualifies since only ENROLLED/PEND import) and an **ethnicity** breakdown reusing the Demographics categories (Hispanic + Latinx merged; percentages out of the responded base, No Response excluded from the base). A de-duplicated **combined** total across all four groups is shown last. One CSV export covers all groups + combined.

**Year-over-year comparison:** each group renders as a table (Enrollment-page `report-table` / `rt-*` / `delta-line` styling) with a column per selected FY and a **Δ column between consecutive years**. Rows are `Unique students` (bold) followed by one row per ethnicity category — the union across the selected years, ordered by total count with No Response last, so a category present in only one year still gets a row (0 elsewhere). Each year is aggregated **independently**: a student enrolled in two selected years counts once in *each* column, so columns are not additive.

Δ cells show two lines: change in students, and change in share. Share change is a **relative %** on the `Unique students` row but **percentage points (pp)** on ethnicity rows — a category can grow in headcount while shrinking as a share. No Response has no share, so its second line is `—`. Caveat when reading pp shifts across years: the No Response count has been falling steadily (combined 248 → 102 from FY23 → FY26), so part of any share movement reflects improving response rates, not a changing student mix.

The CSV is tall — one row per (group, category), a Count/% pair per FY, then Δ Count and Δ "% / pp" pairs between consecutive years.

Groups (a student can appear in more than one):
- **Sliding-Scale & Merit Youth (ages 4–18)** — students aged 4–18 with ≥1 enrollment whose `discount_type` contains a `Child<NN>` token (regex `/(?:^|[ _])Child\d+(?:[ _]|$)/`) **or** the word "Merit" (`/merit/i`). The `Child<NN>` rule deliberately includes the older Mission/Richmond satellite variants (e.g. `Mission_FA2022 Child46_2022_Private`), which only affects FY23. Merit codes are relabelled every term (`Merit - Fall 2025`, `Merit Winter_2026`, `MERIT Richmond_Summer_2022`, `Mission Merit Scholars FA2022_Private`, …), hence the loose substring match; no Merit code carries a `Child<NN>` token, so the two rules never double-count an enrollment. Age is measured at each enrollment's `class_start_date`; students whose age can't be confirmed 4–18 (missing/placeholder birthdate, same 0–100 guard as the Board report) are excluded and reported in a separate note. Adding Merit raised the group by ~17–25 unique students per FY (FY26: 200 → 220).
- **YMP** — enrolled in `Young Musicians Program / Saturday Play! (Ensemble)`, `... (Theory)`, or `Mission District Young Musicians Program / Saturday Play!`.
- **Children's Chorus** / **Teen Jazz Orchestra** — enrolled in the class of that exact name.

**Tuition assistance:** originally shown per group (dollars from `total_discount` for Sliding-Scale + YMP; fully-subsidized headcount for the free programs), but **removed at the user's request** — the tuition-free programs record `$0` discounts inconsistently in ASAP (a billing-practice artifact, not a real change in aid), so the dollar/subsidized figures confused more than helped. The report now shows only unique students + ethnicity.

---

#### Neighborhood Choir Program Demographics

Ethnicity, gender, and household income of **unique students** in the Neighborhood Choir Program — ASAP course name *Neighborhood Choirs for Older Adults and Adults with Disabilities* — for **one or more selected fiscal years** (FY pills, multi-select; same layout and Δ conventions as LIYP). Requested as ethnicities, gender, and low-income percentages.

**Which enrollments count:** course name matching `/neighborhood\s*choirs?/i`. Matching on the distinguishing words rather than the exact title is deliberate — ASAP relabels courses constantly — and nothing else in the catalog pairs "neighborhood" with "choir" (the only other choir course on file is `R&B Choir and More`). Every matched course name is listed in a collapsible **Matched courses** strip above the tables, so a rename that widens or narrows the match surfaces instead of silently shifting the numbers. All 214 choir events on file are `activity_type = 'CLASS'` at Mission Branch, FY23–FY26.

**Categories and percentage bases** come from `demographicCategories.js`, so they are identical to the Demographics report by construction — including the income-only exclusion of `Decline to State` from the percentage base (see the Demographics **Percentage base** table above). Ethnicity and gender exclude only `No Response`.

**Low-income figure:** the `Low` income row; its percentage is the share of choir students **who named an income bracket** and named a low one. Also surfaced as three headline stat cards for the **most recent selected year** (labelled with the FY so a multi-year selection can't be misread as a total): unique students, low-income count (with the named-a-bracket base), and low-income share.

**Reading that figure (documented in the About panel):** on the current base essentially every choir student who names an income bracket names a low one — **100.0% / 100.0% / 100.0% / 99.0%** for FY23–FY26 (FY26 is 206 Low vs 2 High; FY23–FY25 have zero High at all). Declining to state is common and rising here (83 students in FY23 → 159 in FY26), and on the old base that counted decliners in the denominator the same data appeared to show the low-income share *falling* from 70.7% to 56.1% — a response-rate artifact, which is what excluding `Decline to State` removes. The base is narrow, though: the FY26 percentage speaks for 208 of 405 students, so read it next to the `Decline to State` (159) and `No Response` (38) counts.

**Three tables** — Household income (fixed `INCOME_ORDER` rows), Ethnicity, Gender (both ordered by total students across the selected years, `No Response` last; rows are the union across years, so a category present in only one year still gets a row showing 0 elsewhere). Each has a bold `Unique students` row, a column per FY, and a Δ column between consecutive years: top line change in students, bottom line change in share — relative % on the `Unique students` row, **percentage points (pp)** on category rows.

**Each year is aggregated independently** — a student enrolled in two selected years counts once in *each* column, so columns are not additive. A student enrolled in several quarters of the choir counts once per fiscal year.

**Data loading:** two-phase. Mount → paginated `fiscal_year` + `events(course_name)` fetch, filtered client-side to choir rows so the pills only offer years the program ran. On FY selection → paginated (1000/batch) `enrollments` filtered by `fiscal_year`, joined to `events(course_name)` and `students(gender, ethnicity, household_income)`; course filtering and dedup client-side (the course name lives on `events`, so filtering it server-side would mean a second round trip for event IDs).

**Export:** one tall CSV — a row per (dimension, category), a students and % column per selected year, then Δ students and Δ "% / pp" columns between consecutive years.

**Verification:** `node scripts/neighborhood-choir-check.mjs` extracts the report file's own pure-logic block (between the `pure logic` markers) and runs it over live data — no reimplementation; it also reuses the report's own import line for the shared categories, so a name added there can't leave the check behind. It checks unique students against an independent count joined through `event_id` (FY23 333 / FY24 333 / FY25 339 / FY26 405 — matched on all four years), reconciles base + excluded categories = all students for every dimension and year, and confirms percentages sum to 100.0000% of each dimension's base. FY26: 405 students, low income 206 of 208 who named a bracket = 99.0%.

`node scripts/income-base-check.mjs` covers the income base rule itself across both income-reporting reports' cohorts (all students per FY and choir students per FY): that income excludes `No Response` + `Decline to State` while ethnicity/gender exclude only `No Response`, that `Decline to State` has a percentage under ethnicity/gender and none under income, that all 24 cohort×dimension combinations reconcile and sum to 100.0000%, and that every stored income label still maps to a real category. It also prints the old-vs-new low-income share side by side.

---

#### Discount Trends

How each kind of discount has ebbed and flowed across fiscal years. ASAP relabels discount codes nearly every term (308 distinct spellings across FY23–FY26), so codes are collapsed into **families** by an ordered rule list at the top of `DiscountTrends.jsx` — first match wins, order matters (Merit before the branch-prefixed satellite codes, MDYMP before the generic YMP token). Multi-select FY pills, defaulting to every FY on file.

Families: Sliding Scale — Youth (`Child<NN>`), Sliding Scale — Adult (`Adult<NN>`), Merit Scholarship, YMP (**includes MDYMP** — a different class under the same umbrella), CMP (fee-paying YMP — YMP students who pay rather than hold a scholarship; kept separate so the paying share stays visible), Seniors, Faculty / Staff, Family $3, Multiple Classes, SFUSD Teacher, Promotions, Children's Chorus. Coverage is 100% of counted codes.

**Unmatched vs. excluded:** a code matching no pattern lands in a visible `Unmatched` row plus a callout listing the codes, so a new ASAP label surfaces as an actionable number instead of silently deflating a family (same principle as `INCOME_MAP`). Three one-offs are *deliberately excluded* from the report by a separate rule list — `FMS Pay`, `Bebop!`, `30th Street OAC` (293 enrollments total, at the user's direction) — which keeps `Unmatched` meaning "nobody has classified this yet."

**Metric toggle — Unique Students / Enrollments.** Unique students (once per family per FY) is the cross-year comparable measure; enrollments counts the rows a code was applied to (one student in three discounted classes = 1 student, 3 enrollments) and tracks billing practice as much as reality (YMP went 124 → 341 discounted enrollments FY23 → FY24 while unique students went 46 → 48, purely because `YMP - 100% Group` began being applied per enrollment). "Applications" was the original wording for this column; renamed to Enrollments to match how staff talk about the distinction. A student can appear in several families, so families don't sum to *Any discount*. **Dollar amounts are deliberately not shown** — same `$0`-discount artifact that removed them from LIYP.

**Table:** one column per FY with a Δ column (change + % change) between consecutive years, reusing the Enrollment/LIYP `report-table` styling. Click a family to expand it: sliding-scale rows expand to **tier** (`Tier 46` — the number is discount depth), everything else to the raw ASAP codes, which is what makes rate changes legible (Seniors moved 30% → 20% between the FY23 satellite codes and `Seniors_20%_2025`). Two summary rows — *Any discount* (de-duplicated across families) and *All enrolled* — let a family be read as a share of the whole. CSV export writes every family plus its detail codes on the current metric, with a Level column for pivoting.

---

#### Discount Codes

Reconciliation tool. Select any fiscal years and/or quarters (multi-select FY + quarter pills). Blank / `" "` / `"0"` `discount_type` values are treated as "no code." Two tables, each with its own CSV export:

- **Discount Code Summary** — one row per code applied in the timeframe: **Enrollments** (rows the code was applied to) and **Unique Students** who received it. Sortable.
- **Student List** — one row per student with any enrollment in the timeframe (Customer ID only, no names): **Age** at their earliest enrollment in the timeframe (missing/placeholder → `—`), total enrollments, enrollments with a discount, and the discount codes received. A "With a discount only" toggle filters to students who received ≥1 code. On-screen the codes sit in one cell; the **CSV spreads them across `Discount Code 1..N` columns** (widened to the student with the most codes) for easy spreadsheet pivoting.

Built to investigate a sliding-scale count discrepancy (a report of 200 vs a staffer's 246 for FY26): our DB holds only ~202 students with `Child…` codes in FY26, so the gap is upstream (snapshot drift or a different definition/source), not the report logic.

---

## Known Issues / Design Decisions

| Issue | Status | Notes |
|---|---|---|
| Richmond location has trailing spaces in ASAP export | Fixed | `.trim()` on ingest and in all report queries |
| Supabase 1000-row default page limit | Fixed | All fetches paginate in 1000-row batches |
| `is_tuition_free` threshold | Decided | `<= 15` (not `=== 0`) to handle small processing fees |
| Enrollment FK violations on upload | Fixed | Enrollments with no matching student skipped with a logged warning |
| ASAP placeholder cells (`" "` / `"0"`) shadowing real demographics | Fixed (July 2026) | Coalesce trims and treats both as null; caused a major ethnicity undercount (e.g. Filipino 47 vs actual 81 in FY26) until student reports were re-uploaded |
| Ethnicity coalesce order disagreed with ASAP standard reporting | Fixed (July 2026) | Flipped to `Ethnicity` > `Ethnicity1` > `Ethnicity Info` (original column wins) to match ASAP; verified against a colleague's FY26 pivot (matched every named category exactly). Was `Ethnicity Info` > `Ethnicity1` > `Ethnicity`. **Requires re-uploading student reports to take effect** (the report reads the stored coalesced value) |
| Legacy vs current gender labels (`M`/`F`/`N`/`D` vs full labels) | Fixed | Normalized to full labels on ingest |
| Snapshot drift (uploads never deleted; cancelled enrollments lingered, late registrations missed) | Fixed (July 2026) | Replace-by-quarter on upload; all four FYs re-uploaded from fresh full-FY pulls. Recommended cadence: pull quarterly files at quarter end; after each FY closes, upload one full-FY REGULAR+SUPER pull to true up the year |
| Junk totals row in fresh ASAP enrollment pulls | Fixed | Rows with no enrollment ID exempt from status validation |
| ASAP exports contain student PII | Mitigated | `*.xls` / `*.xlsx` are gitignored so report files dropped into the repo can't be committed |
| New/Returning accuracy | Accepted | Depends on consistent `customer_id` values across all historical uploads |
| Initial page load slowness | Fixed | Classes and Enrollment now defer heavy fetches until a period is selected |
| Preceding quarter undefined for fiscal year periods | By design | Continuing row shows `—` for FY-level columns in Retention |
| Auth session flash on load | Fixed | Session state initialises as `undefined`; app renders nothing until resolved |
| Placeholder birthdates (`1900-01-01`, age ~126) misclassifying youth classes | Fixed (July 2026) | Ages outside 0–100 treated as unknown (`MAX_PLAUSIBLE_AGE`); Teen Jazz Orchestra was showing Adult in the Board report. Same guard applied in LIYP and Discount Codes |
| Tuition-free programs record `$0` discount inconsistently in ASAP | Accepted / design | YMP, Children's Chorus, Teen Jazz often store `amount=0, total_discount=0` (varies by year — a billing-practice artifact). Summing discounts undercounts them; LIYP therefore dropped tuition-assistance figures entirely |
| `Decline to State` deflating income percentages | Changed by request (July 2026) | Income percentages now exclude `Decline to State` **and** `No Response` from the base, so they describe only students who named a bracket. Ethnicity/gender still exclude only `No Response`. Applied in one place (`INCOME_PCT_EXCLUDED`) so every demographic report moved together. Big shift: all-students FY26 low-income share 62.4% → 92.1%; Neighborhood Choir FY26 56.1% → 99.0%. Verified by `scripts/income-base-check.mjs` |
| Tables readable only by `authenticated` role (anon/service_role denied) | Fixed (July 2026) | One-time `GRANT SELECT ... TO service_role` in Supabase SQL editor enables local `scripts/` querying; service_role key kept in gitignored `.env` |
