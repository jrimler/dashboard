# CMC Dashboard — Data Model & Claude Code Prompt
Supabase URL: https://ojwmjrmuugirennmjqzo.supabase.co
Supabase publishable key: sb_publishable_AvfWonC840ioBamglTBPUg_cJHnMhBW
## Project Overview

A web-based reporting dashboard for San Francisco Community Music Center (SFCMC). Updated quarterly by manually uploading three standardized ASAP exports. Allows staff to produce enrollment reports, student demographics, retention stats, and class info — with both aggregate numbers and downloadable underlying data.

**Stack:** Supabase (backend), React/JS (frontend), Netlify (hosting), GitHub (version control)

---

## Source Reports

Three standardized ASAP exports, always the same columns in the same order. May arrive as HTML-disguised-as-XLS; the ingest pipeline must handle both real XLSX and HTML-with-XLS-extension.

| Report | Internal Name | Key Columns Used For |
|--------|--------------|----------------------|
| Enrollment Report | REGULAR | Financial data, instructor names, quarter/term |
| Super Enrollment Report | SUPER | Class details, location, timing, fiscal year |
| Student Report | STUDENT | Demographics, identity, account info |

---

## Supabase Tables

### `students`
One row per unique student. Upserted on upload (keyed on `customer_id`).

| Field | Source | Notes |
|-------|--------|-------|
| `customer_id` | STUDENT: `Customer ID` | Primary key |
| `first_name` | STUDENT: `First Name` | |
| `last_name` | STUDENT: `Last Name` | |
| `birthdate` | STUDENT: `Birthdate` | |
| `account_created_date` | STUDENT: `Customer Account Created Date` | |
| `gender` | STUDENT: `Gender` + `Gender1` | Coalesce: prefer non-null; if both non-null, `Gender1` wins |
| `ethnicity` | STUDENT: `Ethnicity` + `Ethnicity1` + `Ethnicity Info` | Coalesce: prefer non-null; if both non-null, `Ethnicity Info` wins, then `Ethnicity1` |
| `household_income` | STUDENT: `Household Income` (two columns) | Coalesce: prefer non-null; newer column wins |
| `pronouns` | STUDENT: `Pronouns` | |

### `enrollments`
One row per unique enrollment. Keyed on `event_enrollment_id`. Built by joining REGULAR + SUPER on `event_enrollment_id`. Upserted on upload.

| Field | Source | Notes |
|-------|--------|-------|
| `event_enrollment_id` | REGULAR: `EventEnrollmentID` / SUPER: `Event Enrollment ID` | Primary key |
| `event_id` | REGULAR: `Event ID` / SUPER: `Event ID` | Foreign key to `events` |
| `customer_id` | REGULAR: `Customer ID` / SUPER: `Studentid` | Foreign key to `students` |
| `time_period` | REGULAR: `TimePeriod` | e.g. "Spring Quarter 2026" |
| `fiscal_year` | SUPER: `Fiscal Year` | e.g. "FY26" |
| `amount` | REGULAR: `Amount` | Raw tuition amount |
| `total_discount` | REGULAR: `Total Discount` | |
| `discount_type` | REGULAR: `Discount Type` | |
| `is_tuition_free` | Calculated | `true` if `amount - total_discount == 0` |
| `instructor_name` | REGULAR: `Instructor Last` + `Instructor First` | Stored as "Last, First" |

### `events`
One row per unique class/lesson section. Keyed on `event_id`. Upserted on upload.

| Field | Source | Notes |
|-------|--------|-------|
| `event_id` | SUPER: `Event ID` | Primary key |
| `course_name` | SUPER: `Course Name` | e.g. "Piano", "Mariachi CMC" |
| `department` | SUPER: `Department` | e.g. "Piano", "Strings", "Latin" |
| `activity_type` | SUPER: `Activity Type` | "LESSON" or "CLASS" — used to distinguish private vs. group |
| `location` | SUPER: `Location` | "Mission Branch" or "Richmond Branch" |
| `facility` | SUPER: `Facility` | Raw room name, e.g. "(C) Studio C" |
| `is_virtual` | Calculated | `true` if `facility` contains "virtual" (case-insensitive) |
| `primary_instructor` | SUPER: `Primary Instructor` | "Last, First" format |
| `class_start_date` | SUPER: `Class Start Date` | |
| `class_end_date` | SUPER: `Class End Date` | |
| `lesson_duration_minutes` | SUPER: `Lesson Duration` | |
| `all_meetings` | SUPER: `All Meetings` | Total sessions in the quarter |
| `fiscal_year` | SUPER: `Fiscal Year` | |
| `time_period` | SUPER: `Time Period` | |

---

## Key Derived Fields & Logic

### Tuition Free vs. Fee Based
```
is_tuition_free = (amount - total_discount) == 0
```
Stored on `enrollments` table.

### Virtual vs. On-Site
```
is_virtual = facility ILIKE '%virtual%'
```
Stored as boolean on `events` table.

### Private Lesson vs. Group Class
```
activity_type == 'LESSON'  →  Private Lesson
activity_type == 'CLASS'   →  Group Class
```
Use `activity_type` from `events`.

### Fiscal Year Quarter Ordering
Quarters sort in this order within each fiscal year (not alphabetical, not calendar):
1. Summer
2. Fall
3. Winter
4. Spring

So FY26 = Summer 2025 → Fall 2025 → Winter 2026 → Spring 2026.

### Unique Students vs. Enrollments
- **Enrollment count**: rows in `enrollments` (one student can have many)
- **Unique student count**: distinct `customer_id` values in a filtered set

---

## Upload Pipeline Logic

1. User uploads all three files (REGULAR, SUPER, STUDENT) via the app UI
2. Parser handles both real XLSX and HTML-disguised-as-XLS
3. Only the specified columns are extracted from each report (all others ignored)
5. REGULAR + SUPER are joined on `event_enrollment_id`
6. Derived fields calculated (`is_tuition_free`, `is_virtual`)
7. `students` table: upserted by `customer_id` (demographics updated if changed)
8. `events` table: upserted by `event_id`
9. `enrollments` table: upserted by `event_enrollment_id`

**Note on file structure:** Row 0 is the header row, data begins at row 1. Standard SheetJS default behavior — no special row skipping needed.

---

## Dashboard Reporting Requirements

### 1. Enrollment Numbers
Filterable by:
- Quarter(s) and/or Fiscal Year(s)
- Campus (Mission / Richmond)
- Tuition Free vs. Fee Based
- Private Lesson vs. Group Class
- Course Name
- Department / Instrument
- Instructor
- Discount Type

### 2. Unique Students
Filterable by:
- Quarter / Fiscal Year
- Gender
- Ethnicity
- Household Income
- Pronouns
- Age (derived from birthdate)

### 3. Retention
- Students who appear in a selected quarter AND a previous quarter/year
- "New student" flag: first quarter they appear in the database

### 4. Class Info
- Sections offered per course
- Class categories (department)
- On-site vs. virtual
- Lesson duration
- Number of sessions (all_meetings)

### All Stats: Drill-Down & Export
Every aggregate number must link to the underlying rows. Users can view and download the data behind any stat as a CSV.

---

## Claude Code Initial Prompt

Use this as the first prompt to Claude Code to set up the project foundation:

---

**PROMPT:**

Create a new React web app called `cmc-dashboard`. This is an internal reporting tool for a nonprofit music school. The stack is React + Supabase + Netlify.

Set up the following:

**1. Supabase schema** — create a migration file with these three tables:

`students` table:
- `customer_id` (text, primary key)
- `first_name` (text)
- `last_name` (text)
- `birthdate` (date)
- `account_created_date` (timestamptz)
- `gender` (text)
- `ethnicity` (text)
- `household_income` (text)
- `pronouns` (text)

`events` table:
- `event_id` (text, primary key)
- `course_name` (text)
- `department` (text)
- `activity_type` (text) — values are "LESSON" or "CLASS"
- `location` (text) — campus name
- `facility` (text) — room name
- `is_virtual` (boolean) — true if facility contains "virtual"
- `primary_instructor` (text)
- `class_start_date` (date)
- `class_end_date` (date)
- `lesson_duration_minutes` (integer)
- `all_meetings` (integer)
- `fiscal_year` (text)
- `time_period` (text)

`enrollments` table:
- `event_enrollment_id` (text, primary key)
- `event_id` (text, foreign key → events)
- `customer_id` (text, foreign key → students)
- `time_period` (text)
- `fiscal_year` (text)
- `amount` (numeric)
- `total_discount` (numeric)
- `discount_type` (text)
- `is_tuition_free` (boolean)
- `instructor_name` (text)

**2. Upload pipeline** — create an `uploadReports.js` utility that:
- Accepts three files: REGULAR, SUPER, STUDENT (XLSX or HTML-disguised-as-XLS)
- Parses them using SheetJS (xlsx library)
- Reads row 0 as headers, data starts at row 1 (standard SheetJS behavior)
- Extracts only these columns by name:

REGULAR columns to keep: `EventEnrollmentID`, `Customer ID`, `TimePeriod`, `Amount`, `Event ID`, `Total Discount`, `Discount Type`, `Instructor Last`, `Instructor First`

SUPER columns to keep: `Course Name`, `Fiscal Year`, `Primary Instructor`, `Location`, `Facility`, `Department`, `Activity Type`, `Class Start Date`, `Class End Date`, `Lesson Duration`, `All Meetings`, `Studentid`, `Event ID`, `Event Enrollment ID`, `Time Period`

STUDENT columns to keep: `Customer ID`, `First Name`, `Last Name`, `Birthdate`, `Customer Account Created Date`, `Gender`, `Gender1`, `Ethnicity`, `Ethnicity1`, `Ethnicity Info`, `Household Income - CMC funders ask for this inform`, `Household Income - CMC s funders ask for this info`, `Pronouns`

- Joins REGULAR + SUPER on `Event Enrollment ID` = `EventEnrollmentID`
- Calculates `is_tuition_free`: true if (Amount - Total Discount) == 0
- Calculates `is_virtual`: true if Facility contains "virtual" (case-insensitive)
- Combines instructor from REGULAR: "Last, First" format
- Coalesces STUDENT demographic fields:
  - `gender`: prefer `Gender1` if non-null, else `Gender`
  - `ethnicity`: prefer `Ethnicity Info` if non-null, else `Ethnicity1`, else `Ethnicity`
  - `household_income`: prefer second Household Income column if non-null, else first
- Upserts all three tables into Supabase (upsert by primary key)

**3. Upload UI** — a simple admin page with three file inputs (labeled REGULAR, SUPER, STUDENT), an Upload button, and a status log showing progress and any errors.

**4. Basic app shell** — a sidebar nav with placeholders for: Upload, Enrollment, Students, Retention, Classes.
