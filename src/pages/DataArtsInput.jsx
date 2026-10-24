import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  DATA_ARTS_TABLE, DATA_ARTS_FIELDS, DATA_ARTS_GROUPS,
  loadDataArtsInput, isMissingTable, fiscalYearOf, dataArtsYearsThrough, fiscalYearSpan,
} from '../utils/dataArtsInput'

// Yearly partner-program and audience figures for the Data Arts Report. These
// never pass through ASAP, so this form is their only way into the dashboard.

const YEARS = dataArtsYearsThrough(fiscalYearOf())

// Form state holds strings so a half-typed value isn't coerced; blank stays
// blank and is saved as null ("not entered").
function toForm(row) {
  const f = {}
  for (const { key } of DATA_ARTS_FIELDS) f[key] = row?.[key] == null ? '' : String(row[key])
  return f
}

// Returns { values, errors }. Every field is optional — a year can be filled in
// as figures arrive — but anything typed must be a non-negative number, and a
// whole number unless the field is fractional (hours).
function parseForm(form) {
  const values = {}, errors = {}
  for (const { key, decimal } of DATA_ARTS_FIELDS) {
    const raw = form[key].replace(/,/g, '').trim()
    if (raw === '') { values[key] = null; continue }
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) errors[key] = 'Enter a number of 0 or more.'
    else if (!decimal && !Number.isInteger(n)) errors[key] = 'Enter a whole number.'
    else values[key] = n
  }
  return { values, errors }
}

export default function DataArtsInput() {
  // Default to the year most likely being reported on: the last one that has
  // closed. Early in a year that's the previous FY, not the one just begun.
  const [fy, setFy]               = useState(YEARS.length > 1 ? YEARS[YEARS.length - 2] : YEARS[0])
  const [row, setRow]             = useState(null)
  const [form, setForm]           = useState(toForm(null))
  const [errors, setErrors]       = useState({})
  const [loading, setLoading]     = useState(true)
  const [saving, setSaving]       = useState(false)
  const [saved, setSaved]         = useState(false)
  const [error, setError]         = useState(null)
  const [missingTable, setMissingTable] = useState(false)

  // Switching years quickly can leave an older fetch resolving last; only the
  // newest may fill the form, or one year's figures could be saved under another.
  const loadSeq = useRef(0)

  useEffect(() => {
    const seq = ++loadSeq.current
    setLoading(true); setSaved(false); setError(null); setErrors({})
    loadDataArtsInput(supabase, fy).then(res => {
      if (seq !== loadSeq.current) return
      setMissingTable(res.missingTable)
      setError(res.error)
      setRow(res.row)
      setForm(toForm(res.row))
      setLoading(false)
    })
  }, [fy])

  const dirty = DATA_ARTS_FIELDS.some(({ key }) => form[key] !== toForm(row)[key])

  async function handleSave(e) {
    e.preventDefault()
    const { values, errors: errs } = parseForm(form)
    setErrors(errs)
    setSaved(false)
    if (Object.keys(errs).length) return

    setSaving(true)
    setError(null)
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error: err } = await supabase
      .from(DATA_ARTS_TABLE)
      .upsert(
        { fiscal_year: fy, ...values, updated_at: new Date().toISOString(), updated_by: user?.email ?? null },
        { onConflict: 'fiscal_year' }
      )
      .select()
      .single()
    setSaving(false)
    if (err) {
      if (isMissingTable(err)) setMissingTable(true)
      else setError(err.message)
      return
    }
    setRow(data)
    setForm(toForm(data))
    setSaved(true)
  }

  return (
    <div className="page">
      <h1>Data Arts Input</h1>
      <p className="subtitle">
        Partner-program and audience figures for the yearly Data Arts Report. ASAP doesn't
        record these, so program managers collect them and they're entered here once per fiscal
        year. The <Link to="/reports/data-arts">Data Arts Report</Link> combines them with the
        uploaded ASAP data.
      </p>

      {missingTable ? (
        <div className="warn-banner">
          The <code>data_arts_input</code> table hasn't been created yet. Run{' '}
          <code>supabase/migrations/005_data_arts_input.sql</code> in the Supabase SQL editor, then
          reload this page.
        </div>
      ) : (
        <form className="upload-form dai-form" onSubmit={handleSave} noValidate>
          <div className="dai-fy">
            <label className="file-label" htmlFor="dai-fy-select">Fiscal year</label>
            <select
              id="dai-fy-select"
              value={fy}
              onChange={e => setFy(e.target.value)}
              disabled={saving}
            >
              {YEARS.map(y => <option key={y} value={y}>{y} ({fiscalYearSpan(y)})</option>)}
            </select>
          </div>

          <div className="dai-banner">
            You are entering figures for <strong>{fy}</strong>
            <span className="dai-banner-span"> — {fiscalYearSpan(fy)}</span>
            <div className="dai-banner-status">
              {loading
                ? 'Loading…'
                : row
                  ? <>Last saved {new Date(row.updated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                      {row.updated_by && <> by {row.updated_by}</>}. Saving again replaces {fy}'s figures.</>
                  : <>Nothing entered for {fy} yet.</>}
            </div>
          </div>

          {DATA_ARTS_GROUPS.map(g => (
            <fieldset key={g.id} className="dai-group" disabled={loading || saving}>
              <legend className="dai-group-title">{g.title}</legend>
              {DATA_ARTS_FIELDS.filter(f => f.group === g.id).map(f => (
                <div key={f.key} className="dai-field">
                  <label className="file-label" htmlFor={`dai-${f.key}`}>{f.label}</label>
                  <input
                    id={`dai-${f.key}`}
                    className={`login-input dai-input${errors[f.key] ? ' dai-input--error' : ''}`}
                    inputMode={f.decimal ? 'decimal' : 'numeric'}
                    value={form[f.key]}
                    onChange={e => { setForm(prev => ({ ...prev, [f.key]: e.target.value })); setSaved(false) }}
                    placeholder="Not entered"
                  />
                  <p className="report-instructions">{errors[f.key] ?? f.help}</p>
                </div>
              ))}
            </fieldset>
          ))}

          <p className="report-instructions">
            Leave a field blank if the figure isn't in yet. A blank isn't counted as 0: the report
            holds back any total that needs it until it's entered.
          </p>

          {error && <div className="error-banner">{error}</div>}

          <div className="button-row">
            <button className="btn-primary" type="submit" disabled={loading || saving || !dirty}>
              {saving ? 'Saving…' : `Save ${fy}`}
            </button>
            {dirty && !saving && (
              <button type="button" className="btn-secondary" onClick={() => { setForm(toForm(row)); setErrors({}) }}>
                Discard changes
              </button>
            )}
          </div>

          {saved && <div className="success-banner">{fy} figures saved.</div>}
        </form>
      )}
    </div>
  )
}
