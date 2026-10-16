import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, authLinkError } from '../lib/supabase'

export default function Login() {
  const navigate = useNavigate()
  const [mode, setMode]         = useState('signin') // 'signin' | 'forgot'
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(
    authLinkError ? `That email link didn’t work (${authLinkError}). Links expire and can only be used once — request a new one below.` : null
  )
  const [notice, setNotice]     = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error: err } = await supabase.auth.signInWithPassword({ email, password })

    if (err) {
      setError('Invalid email or password.')
      setLoading(false)
    } else {
      navigate('/reports', { replace: true })
    }
  }

  async function handleForgot(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    // redirectTo must be listed under Supabase → Authentication → URL
    // Configuration → Redirect URLs, or Supabase falls back to the Site URL.
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    })
    setLoading(false)
    if (err) setError(err.message)
    else setNotice(`If ${email} has an account, a reset link is on its way. It opens a page where you choose a new password.`)
  }

  function switchMode(next) {
    setMode(next)
    setError(null)
    setNotice(null)
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">CMC</div>
        <h1 className="login-heading">{mode === 'forgot' ? 'Reset password' : 'Dashboard'}</h1>

        <form className="login-form" onSubmit={mode === 'forgot' ? handleForgot : handleSubmit}>
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
          {mode === 'signin' && <>
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
          </>}
          {error && <div className="error-banner">{error}</div>}
          {notice && <div className="login-notice">{notice}</div>}
          {mode === 'signin' ? (
            <button
              className="btn-primary"
              type="submit"
              disabled={loading || !email || !password}
            >
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          ) : (
            <button
              className="btn-primary"
              type="submit"
              disabled={loading || !email || !!notice}
            >
              {loading ? 'Sending…' : 'Send reset link'}
            </button>
          )}
          <button
            type="button"
            className="login-link"
            onClick={() => switchMode(mode === 'signin' ? 'forgot' : 'signin')}
          >
            {mode === 'signin' ? 'Forgot password?' : 'Back to sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
