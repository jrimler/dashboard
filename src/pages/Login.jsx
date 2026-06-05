import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Login() {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error: err } = await supabase.auth.signInWithPassword({ email, password })

    if (err) setError('Invalid email or password.')
    setLoading(false)
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">CMC</div>
        <h1 className="login-heading">Dashboard</h1>

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
          <label className="login-label" htmlFor="login-password">Password</label>
          <input
            id="login-password"
            className="login-input"
            type="password"
            required
            value={password}
            onChange={e => setPassword(e.target.value)}
            disabled={loading}
          />
          {error && <div className="error-banner">{error}</div>}
          <button
            className="btn-primary"
            type="submit"
            disabled={loading || !email || !password}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
