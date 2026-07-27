import PianoInspiresGrant from './PianoInspiresGrant'
import UniqueGroupClassesBoard from './UniqueGroupClassesBoard'
import Demographics from './Demographics'
import LowIncomeYouthProgram from './LowIncomeYouthProgram'
import DiscountCodes from './DiscountCodes'

export const REPORTS = [
  {
    id:          'discount-codes',
    label:       'Discount Codes',
    description: 'Discount codes applied per fiscal year/quarter — applications and unique students, plus a per-student list. Downloadable CSVs.',
    component:   DiscountCodes,
  },
  {
    id:          'low-income-youth-program',
    label:       'Low-Income Youth Program (LIYP)',
    description: 'Unique students, tuition assistance, and ethnicity for sliding-scale youth, YMP, Children’s Chorus, and Teen Jazz Orchestra by fiscal year.',
    component:   LowIncomeYouthProgram,
  },
  {
    id:          'piano-inspires',
    label:       'Piano Inspires Grant',
    description: 'Unique piano/keyboard students and tuition assistance for grant reporting.',
    component:   PianoInspiresGrant,
  },
  {
    id:          'unique-group-classes-board',
    label:       'Unique Group Classes for Board',
    description: 'One row per group class offering with category, age group, and tuition status for board reporting.',
    component:   UniqueGroupClassesBoard,
  },
  {
    id:          'demographics',
    label:       'Demographics',
    description: 'Age, gender, ethnicity, and household income of unique students by fiscal year, overall and per group class.',
    component:   Demographics,
  },
]
