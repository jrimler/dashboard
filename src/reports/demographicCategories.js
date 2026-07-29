// Shared demographic category definitions.
//
// Household income, ethnicity, and gender categories are reported identically
// across Demographics, LIYP, and Neighborhood Choir Program Demographics — a
// grant report that disagreed with the Demographics report about what counts as
// "Low" income or how Hispanic/Latinx is grouped would be a bug. These lived in
// Demographics.jsx and were copied into LIYP; they now live here so ASAP's
// periodic relabelling only has to be absorbed in one place.

export const NO_RESPONSE = 'No Response'

// Household income: explicit lookup from the raw ASAP text label (matched
// case-insensitively, trimmed) to a reporting category. Any label not in this
// map falls to "No Response" — this map must be updated when ASAP introduces
// new income labels.
export const INCOME_MAP = {
  'above $154,700':        'High',
  'below $60,600':         'Low',
  'below $58,000':         'Low',
  'below $60,000':         'Low',
  '$96,700 - $116,040':    'Low',
  '$97,000 - $145,200':    'Low',
  '$58,000 - $96,700':     'Low',
  '$60,600 - $97,000':     'Low',
  '$60,001 - $69,000':     'Low',
  '$69,001 - $78,000':     'Low',
  '$78,001 - $86,000':     'Low',
  '$86,001 - $93,000':     'Low',
  'above $93,001':         'Low',
  '$116,040 - $154,700':   'Low',
  'above $145,201':        'Low',
  'decline to state':      'Decline to State',
}

export const INCOME_ORDER = ['High', 'Low', 'Decline to State', 'No Response']

// The income category that reports as low-income. Named so a report asking
// "what share of these students are low-income?" doesn't hardcode the string.
export const LOW_INCOME = 'Low'

export const DECLINE_TO_STATE = 'Decline to State'

// Labels excluded from the percentage base for INCOME ONLY: "No Response" (no
// answer at all) and "Decline to State" (an explicit refusal). Income
// percentages therefore describe only the students who named a bracket, so
// e.g. the low-income share can't be dragged down by a growing number of
// students declining to answer.
//
// This is deliberately income-only. Ethnicity and gender keep "Decline to
// State" in their base and give it a percentage, because there it is a
// meaningful self-description rather than a gap in the income data a funder
// asked about. Both dimensions still exclude "No Response".
export const INCOME_PCT_EXCLUDED = [NO_RESPONSE, DECLINE_TO_STATE]
export const RESPONSE_PCT_EXCLUDED = [NO_RESPONSE]

// Percentage base for a dimension: the students whose answer counts toward the
// denominator. `excluded` is one of the two lists above.
export function pctBase(counts, total, excluded) {
  let base = total
  for (const label of excluded) base -= counts[label] ?? 0
  return base
}

// A bucket's percentage, or null when the label is excluded from the base
// (shown as a count with no percentage).
export function bucketPct(label, count, base, excluded) {
  if (excluded.includes(label) || base === 0) return null
  return (count / base) * 100
}

// Ethnicity labels that name the same group and should report as one category.
// Matched case-insensitively against the stored value (each student has one
// ethnicity, coalesced from the three source columns in priority order).
export const ETHNICITY_ALIASES = {
  'hispanic': 'Hispanic/Latinx',
  'latinx':   'Hispanic/Latinx',
}

// Gender labels merged into shared categories, matched case-insensitively
// against the stored value.
export const GENDER_ALIASES = {
  'trans male':   'Transgender',
  'trans female': 'Transgender',
  'transgender':  'Transgender',
  'nonbinary/gender nonconforming/genderqueer': 'Nonbinary/Gender Nonconforming/Genderqueer',
  'gender non-conforming':                      'Nonbinary/Gender Nonconforming/Genderqueer',
  'decline to state':                           'Decline to State',
  'two spirit':                                 'Two Spirit',
}

export function incomeCategoryFor(raw) {
  const key = String(raw ?? '').trim().toLowerCase()
  if (key === '' || key === '0') return NO_RESPONSE
  return INCOME_MAP[key] ?? NO_RESPONSE
}

// Ethnicity label with Hispanic/Latinx aliases merged to one category.
export function ethnicityLabelFor(raw) {
  const v = String(raw ?? '').trim()
  if (v === '') return NO_RESPONSE
  return ETHNICITY_ALIASES[v.toLowerCase()] ?? v
}

// Gender label with Trans Male/Trans Female/Transgender merged to one category.
export function genderLabelFor(raw) {
  const v = String(raw ?? '').trim()
  if (v === '') return NO_RESPONSE
  return GENDER_ALIASES[v.toLowerCase()] ?? v
}
