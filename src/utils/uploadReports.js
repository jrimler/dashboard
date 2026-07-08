import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Read a File object (real XLSX or HTML-disguised-as-XLS) and return an array
 * of plain objects keyed by the header row (row 0).
 */
async function parseFile(file) {
  const arrayBuffer = await file.arrayBuffer()

  // SheetJS handles both real XLSX and HTML-disguised-as-XLS automatically
  const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]

  // header: true → row 0 becomes keys, data starts at row 1
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })
    .reduce((acc, row, idx, all) => {
      if (idx === 0) return acc // skip header row itself — we use it as key map
      const headers = all[0]
      const obj = {}
      headers.forEach((h, i) => { obj[h] = row[i] ?? null })
      acc.push(obj)
      return acc
    }, [])
}

const VALID_ENROLLMENT_STATUSES = new Set(['ENROLLED', 'PEND'])

function pick(row, keys) {
  const out = {}
  keys.forEach(k => { out[k] = row[k] ?? null })
  return out
}

// ASAP exports use whitespace-only cells and a literal "0" as empty
// placeholders, so those must not count as real values here — otherwise a
// blank-looking first column shadows a real answer in a later one.
function coalesce(...values) {
  for (const v of values) {
    if (v === null || v === undefined) continue
    const s = String(v).trim()
    if (s !== '' && s !== '0') return s
  }
  return null
}

// Older ASAP exports code gender as a single letter; normalize to the labels
// the newer exports use so both vintages land in one category.
const GENDER_CODE_MAP = {
  M: 'Male',
  F: 'Female',
  N: 'Nonbinary/Gender Nonconforming/Genderqueer',
  D: 'Decline to State',
}

function normalizeGender(v) {
  if (v === null) return null
  return GENDER_CODE_MAP[v.toUpperCase()] ?? v
}

function formatDate(val) {
  if (!val) return null
  if (val instanceof Date) return val.toISOString().slice(0, 10)
  if (typeof val === 'string') {
    const d = new Date(val)
    return isNaN(d) ? null : d.toISOString().slice(0, 10)
  }
  // Excel serial number
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val)
    if (!d) return null
    const pad = n => String(n).padStart(2, '0')
    return `${d.y}-${pad(d.m)}-${pad(d.d)}`
  }
  return null
}

// ---------------------------------------------------------------------------
// Class schedule parsing
// ---------------------------------------------------------------------------

function parseIntOrNull(val) {
  if (val === null || val === undefined || val === '') return null
  const n = parseInt(val, 10)
  return isNaN(n) ? null : n
}

async function parseClassSchedule(file) {
  const rows = await parseFile(file)
  const out = []
  for (const row of rows) {
    const eventId = String(row['Class ID'] ?? '').trim()
    if (!eventId) continue
    out.push({
      event_id:     eventId,
      facility:     row['Facility']     ?? null,
      days_of_week: row['Days Of Week'] ?? null,
      start_time:   row['Start Time']   ?? null,
      end_time:     row['End Time']     ?? null,
      age_min:      parseIntOrNull(row['Age Min']),
      age_max:      parseIntOrNull(row['Age Max']),
      course_id:    row['Course ID'] != null ? String(row['Course ID']) : null,
    })
  }
  return out
}

async function upsertClassSchedule(rows, log) {
  await upsertInBatches('class_schedule', rows, 'event_id', log)
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Upload pipeline. Each file is optional — pass null to skip that section.
 * Enrollments require both REGULAR and SUPER to join; if either is absent they are skipped.
 * @param {File|null} regularFile
 * @param {File|null} superFile
 * @param {File|null} studentFile
 * @param {(msg: string) => void} log
 * @param {File|null} classFile
 */
export async function uploadReports(regularFile, superFile, studentFile, log, classFile = null) {
  if (!regularFile && !superFile && !studentFile && !classFile) {
    throw new Error('No files provided. Select at least one report to upload.')
  }

  let regularRows      = []
  let superRows        = []
  let studentRows      = []
  let classScheduleRows = []

  if (regularFile) {
    log('Parsing REGULAR report...')
    regularRows = await parseFile(regularFile)
    // ASAP exports can end with a junk totals row (no enrollment ID); those
    // rows never import, so they don't get a say in status validation either.
    const badRegular = [...new Set(
      regularRows.filter(r => String(r['EventEnrollmentID'] ?? '').trim())
        .map(r => r['EnrollmentStatusCd']).filter(s => !VALID_ENROLLMENT_STATUSES.has(s))
    )]
    if (badRegular.length > 0) {
      throw new Error(`REGULAR report contains unexpected EnrollmentStatusCd values: ${badRegular.map(s => JSON.stringify(s)).join(', ')}. Only ENROLLED and PEND are allowed.`)
    }
    log(`  ${regularRows.length} rows`)
  }
  if (superFile) {
    log('Parsing SUPER report...')
    superRows = await parseFile(superFile)
    const badSuper = [...new Set(
      superRows.filter(r => String(r['Event Enrollment ID'] ?? '').trim())
        .map(r => r['Enrollment Status']).filter(s => !VALID_ENROLLMENT_STATUSES.has(s))
    )]
    if (badSuper.length > 0) {
      throw new Error(`SUPER report contains unexpected Enrollment Status values: ${badSuper.map(s => JSON.stringify(s)).join(', ')}. Only ENROLLED and PEND are allowed.`)
    }
    log(`  ${superRows.length} rows`)
  }
  if (studentFile) {
    log('Parsing STUDENT report...')
    studentRows = await parseFile(studentFile)
    log(`  ${studentRows.length} rows`)
  }
  if (classFile) {
    log('Parsing CLASS SCHEDULE report...')
    classScheduleRows = await parseClassSchedule(classFile)
    log(`  ${classScheduleRows.length} rows`)
  }

  // -------------------------------------------------------------------------
  // Build students records (only if STUDENT file was provided)
  // -------------------------------------------------------------------------
  const studentsMap = {}

  if (studentFile) {
    log('Building student records...')
    for (const row of studentRows) {
      const customerId = String(row['Customer ID'] ?? '').trim()
      if (!customerId) continue

      const hIncome1 = row['Household Income - CMC funders ask for this inform']
      const hIncome2 = row['Household Income - CMC s funders ask for this info']

      studentsMap[customerId] = {
        customer_id:          customerId,
        first_name:           row['First Name'] ?? null,
        last_name:            row['Last Name'] ?? null,
        birthdate:            formatDate(row['Birthdate']),
        account_created_date: row['Customer Account Created Date']
                                ? new Date(row['Customer Account Created Date']).toISOString()
                                : null,
        gender:               normalizeGender(coalesce(row['Gender1'], row['Gender'])),
        ethnicity:            coalesce(row['Ethnicity Info'], row['Ethnicity1'], row['Ethnicity']),
        household_income:     coalesce(hIncome2, hIncome1),
        pronouns:             row['Pronouns'] ?? null,
      }
    }
  }

  // -------------------------------------------------------------------------
  // Build events records (only if SUPER file was provided)
  // -------------------------------------------------------------------------
  const eventsMap = {}
  const superByEEId = {}

  if (superFile) {
    log('Building event records...')
    for (const row of superRows) {
      const id = row['Event Enrollment ID']
      if (id) superByEEId[id] = row

      const eventId = String(row['Event ID'] ?? '').trim()
      if (!eventId) continue

      const facility  = row['Facility'] ?? null
      const durationRaw = row['Lesson Duration']
      const meetingsRaw = row['All Meetings']

      eventsMap[eventId] = {
        event_id:                eventId,
        course_name:             row['Course Name'] ?? null,
        department:              row['Department'] ?? null,
        activity_type:           row['Activity Type'] ?? null,
        location:                row['Location']?.trim() ?? null,
        facility,
        is_virtual:              facility ? facility.toLowerCase().includes('virtual') : false,
        primary_instructor:      row['Primary Instructor'] ?? null,
        class_start_date:        formatDate(row['Class Start Date']),
        class_end_date:          formatDate(row['Class End Date']),
        lesson_duration_minutes: durationRaw !== null && durationRaw !== '' ? parseInt(durationRaw, 10) || null : null,
        all_meetings:            meetingsRaw !== null && meetingsRaw !== '' ? parseInt(meetingsRaw, 10) || null : null,
        fiscal_year:             row['Fiscal Year'] ?? null,
        time_period:             row['Time Period'] ?? null,
      }
    }
  }

  // -------------------------------------------------------------------------
  // Build enrollments records — requires both REGULAR and SUPER
  // -------------------------------------------------------------------------
  const enrollmentsMap = {}

  if (regularFile && superFile) {
    log('Building enrollment records...')
    for (const row of regularRows) {
      const eeid = String(row['EventEnrollmentID'] ?? '').trim()
      if (!eeid) continue

      const superRow      = superByEEId[eeid] ?? {}
      const amount        = parseFloat(row['Amount']) || 0
      const totalDiscount = parseFloat(row['Total Discount']) || 0
      const instrLast     = row['Instructor Last']  ?? ''
      const instrFirst    = row['Instructor First'] ?? ''

      enrollmentsMap[eeid] = {
        event_enrollment_id: eeid,
        event_id:            String(coalesce(row['Event ID'], superRow['Event ID']) ?? '').trim() || null,
        customer_id:         String(coalesce(row['Customer ID'], superRow['Studentid']) ?? '').trim() || null,
        time_period:         row['TimePeriod'] ?? superRow['Time Period'] ?? null,
        fiscal_year:         superRow['Fiscal Year'] ?? null,
        amount,
        total_discount:      totalDiscount,
        discount_type:       row['Discount Type'] ?? null,
        is_tuition_free:     (amount - totalDiscount) <= 15,
        instructor_name:     instrLast ? `${instrLast}, ${instrFirst}`.trim().replace(/,\s*$/, '') : instrFirst || null,
      }
    }
  } else if (regularFile && !superFile) {
    log('Skipping enrollments — SUPER file required to join with REGULAR.')
  }

  // -------------------------------------------------------------------------
  // Filter enrollments: drop rows whose customer_id isn't in the students table
  // (only applies when we also parsed students this run)
  // -------------------------------------------------------------------------
  const students = Object.values(studentsMap)
  const events   = Object.values(eventsMap)
  let   enrollments = Object.values(enrollmentsMap)

  if (studentFile && enrollments.length > 0) {
    const before = enrollments.length
    enrollments = enrollments.filter(e => e.customer_id && studentsMap[e.customer_id])
    const skipped = before - enrollments.length
    if (skipped > 0) log(`WARNING: skipped ${skipped} enrollment(s) with no matching student record`)
  }

  log(`Prepared: ${students.length} students, ${events.length} events, ${enrollments.length} enrollments, ${classScheduleRows.length} class schedule rows`)

  // -------------------------------------------------------------------------
  // Upsert — students and events must come before enrollments (FK order)
  // -------------------------------------------------------------------------
  if (students.length > 0) {
    log('Upserting students...')
    await upsertInBatches('students', students, 'customer_id', log)
  }

  if (events.length > 0) {
    log('Upserting events...')
    await upsertInBatches('events', events, 'event_id', log)
  }

  if (enrollments.length > 0) {
    // A REGULAR+SUPER pair is a full snapshot of the time periods it contains,
    // so rows from earlier snapshots of those periods (enrollments since
    // cancelled or changed in ASAP) must not survive the new upload.
    const periods = [...new Set(enrollments.map(e => e.time_period).filter(Boolean))]
    if (periods.length > 0) {
      log(`Replacing existing enrollments for: ${periods.join(', ')}`)
      const { error } = await supabase.from('enrollments').delete().in('time_period', periods)
      if (error) throw new Error(`Error clearing enrollments for ${periods.join(', ')}: ${error.message}`)
    }
    log('Upserting enrollments...')
    await upsertInBatches('enrollments', enrollments, 'event_enrollment_id', log)
  }

  if (classScheduleRows.length > 0) {
    log('Upserting class schedule...')
    await upsertClassSchedule(classScheduleRows, log)
  }

  log('Upload complete.')
}

const BATCH_SIZE = 500

async function upsertInBatches(table, rows, conflictColumn, log) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict: conflictColumn })

    if (error) {
      const detail = [
        error.message,
        error.code    ? `code: ${error.code}`       : null,
        error.status  ? `status: ${error.status}`   : null,
        error.hint    ? `hint: ${error.hint}`        : null,
        error.details ? `details: ${error.details}`  : null,
      ].filter(Boolean).join(' | ')
      throw new Error(`Error upserting ${table} (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${detail}`)
    }
    log(`  ${table}: upserted rows ${i + 1}–${Math.min(i + BATCH_SIZE, rows.length)}`)
  }
}
