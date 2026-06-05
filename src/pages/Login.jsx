import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Login() {
  const [email, setEmail]       = useState('')
  const [sent, setSent]         = useState(false)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error: err } = await supabase.auth.signInWithOtp({ email })

    if (err) {
      setError(err.message)
    } else {
      setSent(true)
    }
    setLoading(false)
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">CMC</div>
        <h1 className="login-heading">Dashboard</h1>

        {sent ? (
          <div className="success-banner">
            Check your email for a login link.
          </div>
        ) : (
          <form className="login-form" onSubmit={handleSubmit}>
            <label className="login-label" htmlFor="login-email">Email</label>
            <input
              id="login-email"
              className="login-input"
              type="email"
              required
              autoFocus
              placeholder="you@sfcmc.org"
              value={email}
              onChange={e => setEmail(e.target.value)}
              disabled={loading}
            />
            {error && <div className="error-banner">{error}</div>}
            <button
              className="btn-primary"
              type="submit"
              disabled={loading || !email}
            >
              {loading ? 'Sending…' : 'Send Login Link'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
