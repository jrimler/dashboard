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
| `ethnicity` | text | Coalesce: `Ethnicity Info` > `Ethnicity1` > `Ethnicity` |
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
    SpecializedReporting.jsx Working — report picker shell; see below
  reports/
    PianoInspiresGrant.jsx          Specialized report — see below
    UniqueGroupClassesBoard.jsx     Specialized report — see below
    Demographics.jsx                Specialized report — see below
  App.jsx                    Auth gating + sidebar nav shell (React Router v6)
  main.jsx
  index.css
supabase/
  migrations/
    001_initial_schema.sql   students, events, enrollments tables + indexes
    002_class_schedule.sql   class_schedule table + index (FK → events)
    003_grant_delete_enrollments.sql   DELETE grant for replace-by-quarter uploads
netlify.toml                 SPA redirect (/* → /index.html)
.env.example                 Env var template
```

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

### Specialized Reporting (`/reports`)

A report-picker shell. Buttons at the top select which report to display below. Adding a new report requires only adding an entry to the `REPORTS` array in `SpecializedReporting.jsx` and creating the component in `src/reports/`.

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

**Youth vs. Adult:** Each enrolled student's age is calculated as of that enrollment's event's `class_start_date`. Students without a birthdate on record are excluded from the check. If every student with a known birthdate is under 19 across all matching events, the class is Youth; otherwise Adult. Defaults to Adult if no birthdates are known.

**Filter pills:** Two groups — Tuition Status (Tuition Free / Fee Based) and Age Group (Youth / Adult) — all active by default.

**Table columns:** Course Name, Category, Instructor, Days of Week, Time (start – end), Quarters Offered, Age Group, Tuition Status, Total Enrolled, Total Tuition Free — all sortable. Summary totals row at bottom (unique class count, total enrolled, total tuition free).

**Export:** CSV of all visible rows with the same 10 columns.

---

#### Demographics

Summarizes age, gender, ethnicity, and household income for **unique students** in a selected fiscal year. Shows a **Total Students** breakdown followed by a per-class breakdown for each unique group class. Every figure is a raw unique-student count plus a percentage of that group's own total. No student names or per-student detail appear anywhere.

**Period selector:** Fiscal Year only (no quarter pills), single-select. FY pills populated from distinct `fiscal_year` values in `enrollments`.

**Units broken down:**
- **Total Students** — all unique `customer_id`s with any enrollment in the FY, across **all** activity types (`LESSON` + `CLASS`), counted exactly once. The report's true denominator; its breakdowns sum to 100%.
- **Each unique group class** — one row per `course_name` where `activity_type = 'CLASS'` (all sections/events with the same course name collapse together; instructor/day/time are *not* part of the grouping — differs from the Board report). Counts **unique students** within each course (a student in two sections of the same course counts once). Per-class counts do **not** sum to Total Students (a student can appear in multiple classes) — by design.

**Age brackets** (computed from `birthdate` against the enrollment's event `class_start_date`; earliest `class_start_date` within the class for class rows, earliest across all FY enrollments for Total Students): `0–2`, `3–35`, `36–54`, `55–74`, `75+`, and `No Response` (no birthdate, or birthdate before 1905).

**Gender / Ethnicity:** raw stored value as the category label; blank/null → `No Response`. Each student has one ethnicity (coalesced from the three source columns in priority order). **Hispanic/Latinx merge:** the values `"Hispanic"` and `"Latinx"` report as one category labeled `"Hispanic/Latinx"` (case-insensitive lookup via `ETHNICITY_ALIASES` in `Demographics.jsx`).

**Household income:** mapped via an explicit case-insensitive lookup table (`INCOME_MAP` in `Demographics.jsx`), not numeric parsing. `HIGH`: Above $145,201 / Above $154,700 / $116,040–$154,700. `LOW`: Below $60,600 / Below $58,000 / Below $60,000 / $96,700–$116,040 / $97,000–$145,200 / $58,000–$96,700 / $60,600–$97,000 / $60,001–$69,000 / $69,001–$78,000 / $78,001–$86,000 / $86,001–$93,000 / Above $93,001. `DECLINE TO STATE`: Decline to state. `No Response`: blank, `0`, **and any value not in the map** (so a new ASAP income label lands in No Response rather than vanishing — map must be updated when ASAP adds brackets; ASAP's bracket labels have changed several times across years).

**UI:** Total Students breakdown shown at top (count + % per bucket across the four dimensions); below it a sortable class table with the Classes-page drilldown pattern — click a class to expand its four-dimension breakdown. Percentages are always relative to the unit's own total; age and income buckets stay in fixed logical order, gender/ethnicity by descending count with `No Response` last.

**Data loading:** Two-phase. Mount → distinct `fiscal_year` from `enrollments` (FY pills only). On FY selection → paginated fetch (1000/batch) of `enrollments` filtered by `fiscal_year`, joined to `events(activity_type, course_name, class_start_date)` and `students(birthdate, gender, ethnicity, household_income)`; all dedup/age/bucketing done client-side.

**Export:** One comprehensive flat CSV per FY — a row per unit (Total Students first, then each class) with count + % columns for every age bracket, income category, and gender/ethnicity value present (gender/ethnicity columns generated dynamically).

---

## Known Issues / Design Decisions

| Issue | Status | Notes |
|---|---|---|
| Richmond location has trailing spaces in ASAP export | Fixed | `.trim()` on ingest and in all report queries |
| Supabase 1000-row default page limit | Fixed | All fetches paginate in 1000-row batches |
| `is_tuition_free` threshold | Decided | `<= 15` (not `=== 0`) to handle small processing fees |
| Enrollment FK violations on upload | Fixed | Enrollments with no matching student skipped with a logged warning |
| ASAP placeholder cells (`" "` / `"0"`) shadowing real demographics | Fixed (July 2026) | Coalesce trims and treats both as null; caused a major ethnicity undercount (e.g. Filipino 47 vs actual 81 in FY26) until student reports were re-uploaded |
| Legacy vs current gender labels (`M`/`F`/`N`/`D` vs full labels) | Fixed | Normalized to full labels on ingest |
| Snapshot drift (uploads never deleted; cancelled enrollments lingered, late registrations missed) | Fixed (July 2026) | Replace-by-quarter on upload; all four FYs re-uploaded from fresh full-FY pulls. Recommended cadence: pull quarterly files at quarter end; after each FY closes, upload one full-FY REGULAR+SUPER pull to true up the year |
| Junk totals row in fresh ASAP enrollment pulls | Fixed | Rows with no enrollment ID exempt from status validation |
| ASAP exports contain student PII | Mitigated | `*.xls` / `*.xlsx` are gitignored so report files dropped into the repo can't be committed |
| New/Returning accuracy | Accepted | Depends on consistent `customer_id` values across all historical uploads |
| Initial page load slowness | Fixed | Classes and Enrollment now defer heavy fetches until a period is selected |
| Preceding quarter undefined for fiscal year periods | By design | Continuing row shows `—` for FY-level columns in Retention |
| Auth session flash on load | Fixed | Session state initialises as `undefined`; app renders nothing until resolved |
