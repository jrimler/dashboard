// Shared discount-family definitions.
//
// These live outside any one report because two reports now classify the same
// codes: Discount Trends, which reports the families directly, and Enrollment
// Narrative, which describes how they moved. A report that disagreed with
// Discount Trends about what counts as "Sliding Scale — Youth" would be a bug,
// so ASAP's relabelling is absorbed in exactly one file — the same reasoning
// that put the demographic categories in demographicCategories.js.
//
// Discount families
//
// ASAP relabels discount codes nearly every term — 308 distinct spellings across
// FY23–FY26 — but they describe a much smaller set of standing programs. These
// ordered rules collapse the spellings into families; the FIRST match wins, so
// order matters (Merit before the branch-prefixed satellite codes, MDYMP before
// the generic YMP token).
//
// Anything that matches no rule lands in an "Unmatched" row rather than being
// dropped, so a new ASAP label shows up as a number someone can act on instead
// of silently deflating a family. Same principle as INCOME_MAP in Demographics.
// ─────────────────────────────────────────────────────────────────────────────

export const FAMILY_RULES = [
  // Sliding scale. Tier number encodes the discount depth; the year suffix
  // (_2023, _2024-2025, _2026-2027) marks which rate schedule was in force, and
  // the FY23 spellings additionally carry a Mission/Richmond branch prefix.
  ['Sliding Scale — Youth', /(?:^|[ _])Child\d+/i],
  ['Sliding Scale — Adult', /(?:^|[ _])Adult\d+/i],

  ['Merit Scholarship',     /merit/i],

  // Mission District YMP is a different class but part of the YMP umbrella, so
  // both rules land in one family.
  ['YMP',                   /MDYMP/i],
  ['YMP',                   /(?:^|[ _])YMP/i],

  // YMP students who pay rather than hold a scholarship. Related to YMP but
  // deliberately kept separate — folding it in would hide the paying share.
  ['CMP (fee-paying YMP)',  /(?:^|[ _])CMP(?:[ _-]|$)/i],

  ['Seniors',               /senior/i],
  ['Faculty / Staff',       /fac(?:ulty)?[ _/]*staff|Fac\d*%/i],
  ['Family $3',             /family \$3/i],
  ['Multiple Classes',      /multi/i],
  ['SFUSD Teacher',         /SFUSD/i],
  ['Promotions',            /open house|refer a friend|promo|survey|PTA|friend of CMC|music for children/i],
  ["Children's Chorus",     /chorus/i],
]

// Codes deliberately left out of the report (one-off or non-program codes).
// Excluded rather than unmatched so the Unmatched row keeps meaning "a code
// nobody has classified yet".
export const EXCLUDED_RULES = [
  /^FMS Pay/i,
  /^Bebop!/i,
  /30th Street OAC/i,
]

export const UNMATCHED = 'Unmatched'

export function familyOf(code) {
  if (EXCLUDED_RULES.some(re => re.test(code))) return null
  const hit = FAMILY_RULES.find(([, re]) => re.test(code))
  return hit ? hit[0] : UNMATCHED
}

// Sub-label shown when a family row is expanded. Sliding-scale codes collapse to
// their tier so the mix across tiers is readable; everything else keeps the raw
// ASAP code, which is what makes rate changes visible (Seniors 30% → 20%).
export function subgroupOf(family, code) {
  if (family.startsWith('Sliding Scale')) {
    const m = code.match(/(?:^|[ _])(Child|Adult)(\d+)/i)
    if (m) return `Tier ${m[2]}`
  }
  return code
}
