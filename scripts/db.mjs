// Shared Supabase client for local analysis/diagnostic scripts.
// Uses the service_role key from .env (gitignored) so scripts read any table
// without a login. NEVER import this into anything that ships to the browser —
// the service_role key bypasses Row Level Security.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const key = env.SUPABASE_SERVICE_ROLE_KEY
if (!key) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env — add the service_role secret from Supabase → Project Settings → API.')
  process.exit(1)
}

export const sb = createClient(env.VITE_SUPABASE_URL, key, {
  auth: { persistSession: false, autoRefreshToken: false },
})
