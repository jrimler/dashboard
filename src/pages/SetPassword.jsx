import { useState } from 'react'
import { supabase } from '../lib/supabase'

// Shown after a password-reset or invite link. The link has already signed the
// user in; this is where they choose the password they'll log in with next time.
export default function SetPassword({ isInvite, onDone }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    // Length/strength rules are left to Supabase (Authentication → Providers →
    // Email) so the form can't disagree with what the server actually enforces.
    if (password !== confirm) return setError('The two passwords don’t match.')

    setLoading(true)
    const { error: err } = await supabase.auth.updateUser({ password })
    setLoading(false)
    // Supabase's own messages are specific and readable (e.g. "New password
    // should be different from the old password"), so show them as-is.
    if (err) setError(err.message)
    else onDone()
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">CMC</div>
        <h1 className="login-heading">{isInvite ? 'Welcome — choose a password' : 'Set a new password'}</h1>

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-label" htmlFor="new-password">New password</label>
          <input
            id="new-password"
            className="login-input"
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            value={password}
            onChange={e => setPassword(e.target.value)}
            disabled={loading}
          />
          <label className="login-label" htmlFor="confirm-password">Confirm password</label>
          <input
            id="confirm-password"
            className="login-input"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            disabled={loading}
          />
          {error && <div className="error-banner">{error}</div>}
          <button
            className="btn-primary"
            type="submit"
            disabled={loading || !password || !confirm}
          >
            {loading ? 'Saving…' : 'Save password'}
          </button>
        </form>
      </div>
    </div>
  )
}
