# CMC Dashboard — Planning Reference

Internal reporting dashboard for San Francisco Community Music Center (SFCMC).
Updated quarterly by manually uploading three ASAP exports.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite 5, React Router v6 |
| Backend / DB | Supabase (Postgres) |
| Hosting | Netlify |
| File parsing | SheetJS (xlsx) |
| Env vars | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` in `.env` |

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
| `location` | text | `"Mission Branch"` or `"Richmond Branch"` — **trim on ingest, trailing spaces in source** |
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
4. FK order: students → events → enrollments
5. Enrollments with no matching `customer_id` in the parsed students data are **silently skipped** to avoid FK violations
6. `location` is `.trim()`-ed on ingest (source data has trailing spaces on Richmond)

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

**Sort key implementation:** `fullYear * 10 + seasonOrder` (e.g., Spring 2026 = 20264). Fiscal year sort key = `fullYear * 10` (sorts before its own quarters). This ensures FY and quarter keys are on the same numeric scale.

Time period strings look like: `"Spring Quarter 2026"`, `"Fall Quarter 2025"`
Fiscal year strings look like: `"FY26"`, `"FY25"`

---

## App Structure

```
src/
  lib/supabase.js          Supabase client (reads VITE_ env vars)
  utils/
    uploadReports.js       Full upload + upsert pipeline
    periodUtils.js         Period sorting, parsing, label formatting
  pages/
    Upload.jsx             Working — file inputs, progress log, Test Connection button
    Enrollment.jsx         Working — see below
    Students.jsx           Placeholder
    Retention.jsx          Placeholder
    Classes.jsx            Placeholder
  App.jsx                  Sidebar nav shell (React Router v6)
  main.jsx
  index.css
supabase/
  migrations/
    001_initial_schema.sql All three tables + indexes
```

---

## Enrollment Page (current state)

### Period selector
- Pills grouped as **Fiscal Years** (FY24, FY25…) and **Quarters** (grouped under FY labels)
- Multi-select; each selected period becomes a column
- Columns always sort chronologically regardless of click order
- Data loads once on mount (all records, paginated in 1000-row pages)

### Report table structure

Four sections, each with a muted header row:

**All Branches**
- Total (bold)
- — Fee Based
- — Tuition Free
- — Lessons
- — Group Classes
- — Fee Based — Lessons
- — Fee Based — Group Classes
- — Tuition Free — Lessons
- — Tuition Free — Group Classes

**Mission Branch** (same 9 sub-rows, all filtered to `location = "Mission Branch"`)

**Richmond Branch** (same 9 sub-rows, all filtered to `location = "Richmond Branch"`)

**Retention**
- New Students (bold)
- Returning Students (bold)

### Column types
- **Period column**: enrollment count (large) + unique student count (small/muted), stacked
- **Δ column** (between consecutive periods): `+42 / +8.3%` for enrollments, same for students — green if positive, red if negative

### New vs Returning (current implementation)
A student is **new** in a period if their earliest enrollment (across all data in the DB) falls within that period's sort key range. **Returning** if their earliest enrollment predates the period.

**Known limitation:** only as accurate as uploaded data. With Summer 2022–Spring 2026 loaded, Spring 2026 shows ~228 new students — which may or may not be accurate depending on whether student IDs have been consistent across all uploads.

**Alternative definition discussed but not implemented:** returning = student whose `account_created_date` predates the earliest `class_start_date` in the selected period.

**Another option to implement:** returning = student who appears in any *earlier* quarter in the database (compare by `customer_id` across quarters).

### Export
"Export CSV" button downloads all rows × all columns (with delta columns broken out into raw + % separately).

---

## Pages Still to Build

### Students page
Filterable by: Quarter / Fiscal Year, Gender, Ethnicity, Household Income, Pronouns, Age (derived from birthdate)
- Show unique student counts
- Demographics breakdown
- CSV export of underlying data

### Retention page
- Students who appear in a selected quarter AND a previous quarter/year
- "New student" flag: first quarter they appear in the database
- Quarter-over-quarter comparison

### Classes page
- Sections offered per course
- Class categories (department)
- On-site vs. virtual breakdown
- Lesson duration
- Number of sessions (all_meetings)

---

## Known Issues / Design Decisions

| Issue | Status | Notes |
|---|---|---|
| Richmond location has trailing spaces in ASAP export | Fixed | `.trim()` applied on ingest and in report loader |
| Supabase default 1000-row limit | Fixed | Paginated fetch in Enrollment loader |
| `is_tuition_free` threshold | Updated | Changed from `=== 0` to `<= 15` |
| Enrollment FK violations on upload | Fixed | Enrollments with no matching student are skipped |
| New/returning accuracy | Pending | Logic is sound but depends on consistent customer_ids across all historical uploads |
| Each file upload is optional | Done | Can upload 1, 2, or all 3 files; enrollments require both REGULAR + SUPER |
