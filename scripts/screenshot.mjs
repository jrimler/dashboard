// Drives the real dashboard in a headless browser: starts the dev server, logs
// in, navigates to a route, asserts the page actually rendered, and writes a
// screenshot.
//
// This exists because a chart can be logically correct and still render nothing.
// The first version of Enrollment Trends measured its container with an effect
// keyed on a ref object, which ran once while the element was still the
// "Loading…" placeholder — so both charts sat at width 0 and drew nothing, while
// every unit-level check passed. The assertions below are aimed squarely at that
// class of bug: an <svg> that exists but has no size, or has size but no marks.
//
// Usage:
//   node scripts/screenshot.mjs                       # the Enrollment Trends report
//   node scripts/screenshot.mjs /classes              # any route
//   node scripts/screenshot.mjs /reports/demographics --width 1440
//
// Credentials come from .env (gitignored), never from the command line:
//   E2E_EMAIL=you@sfcmc.org
//   E2E_PASSWORD=…
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ─── config ─────────────────────────────────────────────────────────────────
const env = {}
for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
if (!env.E2E_EMAIL || !env.E2E_PASSWORD) {
  console.error(
    'Missing E2E_EMAIL / E2E_PASSWORD in .env.\n' +
    'Add them (the file is gitignored) so this script can log in:\n' +
    '  E2E_EMAIL=you@sfcmc.org\n' +
    '  E2E_PASSWORD=your-password'
  )
  process.exit(1)
}

const args   = process.argv.slice(2)
const route  = args.find(a => a.startsWith('/')) ?? '/reports/enrollment-trends'
const widthA = args.indexOf('--width')
const WIDTH  = widthA >= 0 ? Number(args[widthA + 1]) : 1440
const PORT   = 5199
const BASE   = `http://localhost:${PORT}`
const outDir = join(root, 'screenshots')
mkdirSync(outDir, { recursive: true })

// ─── dev server ─────────────────────────────────────────────────────────────
console.log(`Starting dev server on :${PORT}…`)
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: root, stdio: 'ignore', detached: false,
})
const stop = () => { try { server.kill('SIGTERM') } catch {} }
process.on('exit', stop)
process.on('SIGINT', () => { stop(); process.exit(130) })

async function waitForServer(timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(BASE)
      if (r.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`Dev server did not come up on ${BASE}`)
}
await waitForServer()

// ─── drive the browser ──────────────────────────────────────────────────────
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: WIDTH, height: 1000 } })

// Stub window.print so the PDF packet stays mounted long enough to inspect.
// Headless fires 'afterprint' immediately, which unmounts it before any
// assertion can see it — the first version of this check reported "0 sections"
// for a packet that had rendered perfectly well.
await page.addInitScript(() => {
  window.__printSnapshot = null
  window.print = () => {
    const svgs = [...document.querySelectorAll('.et-print svg')]
    window.__printSnapshot = {
      sections: document.querySelectorAll('.et-print-page').length,
      svgs: svgs.length,
      empty: svgs.filter(n => {
        const r = n.getBoundingClientRect()
        return r.width < 100 || n.querySelectorAll('path,line').length === 0
      }).length,
    }
  }
})

// Anything the page complains about is a finding, not noise.
const consoleErrors = []
const failedRequests = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => consoleErrors.push(`[pageerror] ${e.message}`))
// React.StrictMode double-invokes effects in dev, so the first mount's in-flight
// requests are aborted when it unmounts. That is expected dev noise, not a fault.
const abortedRequests = []
page.on('requestfailed', r => {
  const err = r.failure()?.errorText ?? ''
  const line = `${r.method()} ${r.url()} — ${err}`
  if (err.includes('ERR_ABORTED')) abortedRequests.push(line)
  else failedRequests.push(line)
})

let failures = 0
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`) }

console.log('Logging in…')
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.fill('input[type="email"]', env.E2E_EMAIL)
await page.fill('input[type="password"]', env.E2E_PASSWORD)
await page.click('button[type="submit"]')

// The login screen is replaced by the app shell once the session resolves.
await page.waitForSelector('.sidebar', { timeout: 20000 })
console.log('Logged in.')

// App.jsx deliberately redirects the first authenticated load to /reports
// regardless of the entry URL, so a page.goto() to a deep link gets bounced.
// Navigate the way a person does — through the UI — which also exercises the
// real routing rather than a cold boot the app never intends to serve.
async function navigateInApp(target) {
  const SIDEBAR = { '/reports': 'Reports', '/enrollment': 'Enrollment', '/retention': 'Retention', '/classes': 'Classes', '/upload': 'Upload' }

  if (SIDEBAR[target]) {
    await page.click(`.sidebar-nav >> text="${SIDEBAR[target]}"`)
    return
  }

  const reportMatch = target.match(/^\/reports\/(.+)$/)
  if (!reportMatch) throw new Error(`Don't know how to reach ${target} through the UI`)

  // Cards are labelled, not id-ed, so map id → label from the registry source.
  const registry = readFileSync(join(root, 'src/reports/registry.js'), 'utf8')
  const entry = new RegExp(`id:\\s*'${reportMatch[1]}'[\\s\\S]{0,200}?label:\\s*'([^']+)'`).exec(registry)
  if (!entry) throw new Error(`No report with id '${reportMatch[1]}' in registry.js`)

  await page.click('.sidebar-nav >> text="Reports"')
  await page.waitForSelector('.sr-card, .report-card, button', { timeout: 10000 })
  await page.click(`text="${entry[1]}"`)
}

console.log(`Navigating to ${route}…`)
const t0 = Date.now()
await navigateInApp(route)

// Reports fetch after mount; wait for the loading placeholder to clear.
try {
  await page.waitForFunction(
    () => !document.body.innerText.includes('Loading'),
    { timeout: 90000 }
  )
} catch {
  console.log('  (still showing a loading state after 90s)')
}
const loadMs = Date.now() - t0
console.log(`Rendered in ${(loadMs / 1000).toFixed(1)}s\n`)

// ─── assertions ─────────────────────────────────────────────────────────────
console.log('Page health')
check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? ':\n        ' + consoleErrors.slice(0, 5).join('\n        ') : ''}`)
check(failedRequests.length === 0, `no failed requests${failedRequests.length ? ':\n        ' + failedRequests.slice(0, 5).join('\n        ') : ''}`)
if (abortedRequests.length) console.log(`        (${abortedRequests.length} aborted requests — expected: StrictMode double-invokes effects in dev)`)
check(!(await page.locator('.error-banner').count()), 'no error banner on the page')

// The blank-chart guard: an <svg> must exist, have real layout size, and
// actually contain drawn marks.
const svgCount = await page.locator('svg').count()
console.log(`\nCharts — ${svgCount} svg element(s) on the page`)
// A route that is supposed to be charted and isn't is the whole reason this
// script exists; don't let a zero slide past as "nothing to check".
if (route.includes('enrollment-trends')) {
  check(svgCount >= 2, `Enrollment Trends renders both charts (found ${svgCount})`)
}
if (svgCount > 0) {
  const svgStats = await page.$$eval('svg', nodes => nodes.map(n => {
    const r = n.getBoundingClientRect()
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      paths: n.querySelectorAll('path').length,
      texts: n.querySelectorAll('text').length,
      lines: n.querySelectorAll('line').length,
    }
  }))
  svgStats.forEach((s, i) => {
    const sized = s.w > 100 && s.h > 50
    const drawn = s.paths + s.lines > 0
    check(sized, `svg #${i + 1} has real size (${s.w}×${s.h})`)
    check(drawn, `svg #${i + 1} has marks (${s.paths} paths, ${s.lines} lines, ${s.texts} labels)`)
  })
}

const tableRows = await page.locator('table tbody tr').count()
if (tableRows) console.log(`\nTable: ${tableRows} rows`)

// ─── capture ────────────────────────────────────────────────────────────────
const slug = route.replace(/^\//, '').replace(/\//g, '-') || 'home'
const file = join(outDir, `${slug}.png`)
await page.screenshot({ path: file, fullPage: true })
console.log(`\nScreenshot → ${file.replace(root + '/', '')}`)

// Extra frames for the interactive states of the trends report.
if (route.includes('enrollment-trends')) {
  for (const label of ['Branch', 'Lessons vs. classes']) {
    const pill = page.locator('.period-pill', { hasText: label }).first()
    if (await pill.count()) {
      await pill.click()
      await page.waitForTimeout(400)
      const f = join(outDir, `${slug}-${label.split(' ')[0].toLowerCase()}.png`)
      await page.screenshot({ path: f, fullPage: true })
      console.log(`Screenshot → ${f.replace(root + '/', '')}`)
    }
  }
  const summer = page.locator('.period-pill', { hasText: 'Exclude summer' }).first()
  if (await summer.count()) {
    await summer.click()
    await page.waitForTimeout(400)
    const f = join(outDir, `${slug}-no-summer.png`)
    await page.screenshot({ path: f, fullPage: true })
    console.log(`Screenshot → ${f.replace(root + '/', '')}`)
  }
}

// ─── PDF packet ─────────────────────────────────────────────────────────────
// Letter landscape at 0.5in margins is a 960x720 printable area. A section
// taller than 720px silently spills onto a second sheet, which turned the
// 10-page packet into 18 the first time round — so the height is asserted, not
// eyeballed.
if (route.includes('enrollment-trends')) {
  console.log('\nPDF export')
  const PAGE_H = 720
  await page.click('text="Export PDF"')
  await page.waitForFunction(() => window.__printSnapshot !== null, { timeout: 20000 })
  const snap = await page.evaluate(() => window.__printSnapshot)

  check(snap.sections === 10, `packet has 10 sections — cover + 8 variations + table (got ${snap.sections})`)
  check(snap.svgs === 16, `packet has 16 charts — 8 variations x 2 (got ${snap.svgs})`)
  check(snap.empty === 0, `no blank charts in the packet (${snap.empty} blank)`)

  await page.setViewportSize({ width: 960, height: PAGE_H })
  await page.emulateMedia({ media: 'print' })
  await page.waitForTimeout(400)

  // #root is hidden by an @media print rule, so this is only true under print
  // media — checking it at print() time reads the screen value and fails.
  const rootHidden = await page.evaluate(() => getComputedStyle(document.getElementById('root')).display)
  check(rootHidden === 'none', `the app itself is hidden in print (#root display: ${rootHidden})`)

  const heights = await page.$$eval('.et-print-page', ns => ns.map(n => Math.round(n.getBoundingClientRect().height)))
  const tall = heights.filter(h => h > PAGE_H)
  check(tall.length === 0,
    `every section fits one ${PAGE_H}px page (tallest ${Math.max(...heights)}px)` +
    (tall.length ? ` — ${tall.length} spill onto a second sheet` : ''))

  const pdf = join(outDir, 'enrollment-trends.pdf')
  await page.pdf({
    path: pdf, format: 'Letter', landscape: true, printBackground: true,
    margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
  })
  const pdfPages = (readFileSync(pdf).toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
  check(pdfPages === 10, `rendered PDF is 10 pages (got ${pdfPages})`)
  console.log(`PDF        → ${pdf.replace(root + '/', '')}`)
  await page.emulateMedia({ media: 'screen' })
}

await browser.close()
stop()

console.log(failures === 0 ? '\n✅ page rendered cleanly\n' : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
