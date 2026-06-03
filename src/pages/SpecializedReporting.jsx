import { useState } from 'react'
import PianoInspiresGrant from '../reports/PianoInspiresGrant'
import UniqueGroupClassesBoard from '../reports/UniqueGroupClassesBoard'

const REPORTS = [
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
]

export default function SpecializedReporting() {
  const [activeId, setActiveId] = useState(null)

  const active = REPORTS.find(r => r.id === activeId) ?? null

  return (
    <div className="page sr-page">
      <div className="enroll-header">
        <h1>Specialized Reporting</h1>
      </div>

      <div className="sr-report-list">
        {REPORTS.map(r => (
          <button
            key={r.id}
            className={`sr-report-btn${activeId === r.id ? ' active' : ''}`}
            onClick={() => setActiveId(prev => prev === r.id ? null : r.id)}
          >
            <span className="sr-report-btn-label">{r.label}</span>
            <span className="sr-report-btn-desc">{r.description}</span>
          </button>
        ))}
      </div>

      {active && (
        <div className="sr-report-body">
          <div className="sr-report-body-title">{active.label}</div>
          <active.component />
        </div>
      )}
    </div>
  )
}
