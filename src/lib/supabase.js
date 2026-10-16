import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in environment')
}

// Read the email-link fragment BEFORE createClient: the client consumes it,
// signs the user in, and strips it from the URL. Reset and invite links both
// arrive as a plain signed-in session, so without this the app can't tell that
// the person still needs to choose a password — it dropped them straight into
// the dashboard, and they could never log in again once that session ended.
const hash = new URLSearchParams(window.location.hash.slice(1))

// 'recovery' (password reset) or 'invite' — both must set a password first.
export const authLinkType = ['recovery', 'invite'].includes(hash.get('type'))
  ? hash.get('type')
  : null

// An expired or already-used link comes back as an error in the fragment
// (e.g. otp_expired). Surface it on the login screen instead of failing silently.
export const authLinkError = hash.get('error_description')?.replace(/\+/g, ' ') ?? null

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
