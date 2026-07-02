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
| Auth | Supabase Auth (email + password) |
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

**REGULAR:** `EventEnrollmentID`, `Customer ID`, `TimePeriod`, `Amount`, `Event ID`, `Total Discount`, `Discount Type`, `Instructor Last`, `Instructor First`, `EnrollmentStatusCd`

**SUPER:** `Course Name`, `Fiscal Year`, `Primary Instructor`, `Location`, `Facility`, `Department`, `Activity Type`, `Class Start Date`, `Class End Date`, `Lesson Duration`, `All Meetings`, `Studentid`, `Event ID`, `Event Enrollment ID`, `Time Period`, `Enrollment Status`

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

### `class_schedule`
Primary key: `event_id` (supplemental schedule data, one row per class section)

| Field | Type | Notes |
|---|---|---|
| `event_id` | text PK | |
| `facility` | text | |
| `days_of_week` | text | |
| `start_time` | text | |
| `end_time` | text | |
| `age_min` | integer | |
| `age_max` | integer | |
| `course_id` | text | |

---

## Upload Pipeline (`src/utils/uploadReports.js`)

1. Each file is optional — pass `null` to skip that table
2. Enrollments require **both** REGULAR + SUPER (joined on `event_enrollment_id`)
3. **Enrollment status validation (hard error):** REGULAR rows where `EnrollmentStatusCd` is not `ENROLLED` or `PEND` throw immediately, before any Supabase writes. Same for SUPER `Enrollment Status`. Error message lists the unexpected values found.
4. Upserts in batches of 500 rows
5. FK order: students → events → enrollments
6. Enrollments with no matching `customer_id` in the parsed students data are **silently skipped** to avoid FK violations
7. `location` is `.trim()`-ed on ingest (source data has trailing spaces on Richmond)

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
    uploadReports.js       Full upload + upsert pipeline (with status validation)
    periodUtils.js         Period sorting, parsing, label formatting
  pages/
    Login.jsx              Email/password login; redirects to /reports on success
    Upload.jsx             File inputs, progress log, Test Connection button
    Enrollment.jsx         Working — see below
    Students.jsx           Placeholder
    Retention.jsx          Working — see below
    Classes.jsx            Working — see below
    SpecializedReporting.jsx  Primary landing page (nav label: "Reports")
  reports/
    PianoInspiresGrant.jsx          Unique piano/keyboard students + tuition assistance
    UniqueGroupClassesBoard.jsx     One row per unique group class for board reporting
  App.jsx                  Sidebar nav + auth gate (React Router v6)
  main.jsx
  index.css
supabase/
  migrations/
    001_initial_schema.sql All three tables + indexes
```

### Navigation order
Reports → Enrollment → Retention → Classes → Students → Upload

Default landing page after login: **Reports** (`/reports`)

---

## Pages — Current State

### Reports (`/reports`) — Primary page
Expandable report buttons. Two live reports:
- **Piano Inspires Grant** — unique piano/keyboard students and tuition assistance
- **Unique Group Classes for Board** — one row per unique group class (course + instructor + time slot), with category, age group (Youth/Adult), tuition status, enrollment counts, filterable by FY. Pulls from `class_schedule` table for days/times.

### Enrollment (`/enrollment`) — Working
Period pills (FY + quarters), multi-select columns, delta columns (count + %), branch breakdowns (All / Mission / Richmond), New/Returning section, CSV export.

**New vs. Returning logic:** A student is new in a period if their earliest enrollment across all DB data falls within that period's sort key range.

**Known limitation:** accuracy depends on consistent `customer_id` values across all historical uploads.

### Retention (`/retention`) — Working
Per-period student classification: Total, New, Continuing, Returning. Preceding-quarter comparison logic.

### Classes (`/classes`) — Working
Class section browser with period selector.

### Students (`/students`) — Placeholder
"Coming soon." Planned: demographic filtering (gender, ethnicity, household income, pronouns, age derived from birthdate), unique student counts, CSV export. Likely to be absorbed into specialized Reports rather than built as a general page.

### Upload (`/upload`)
Three file inputs (REGULAR, SUPER, STUDENT), progress log, Test Connection button. Status validation on REGULAR and SUPER throws hard errors before any writes if unexpected enrollment status values are found.

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
| Enrollment status validation | Done | Hard error on upload if REGULAR `EnrollmentStatusCd` or SUPER `Enrollment Status` contain values other than `ENROLLED` or `PEND` |
| Student report has no status column | Pending | No equivalent guard exists for student data; mitigations (column presence check, row count warning) discussed but not yet implemented |
| Students page | Deferred | Likely to be built as a specialized Report rather than a general page |

---

## Future Work

- Additional specialized Reports (Retention and Classes data to be migrated into Reports page)
- Student upload safety: column presence check + row count warning vs. current DB
- Students demographics report
