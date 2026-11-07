// Saves a logged-in session from your own browser so the headless recorder can show logged-in pages.
//   1. Start your browser with remote debugging, e.g.
//      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --remote-debugging-port=9333 --user-data-dir=.profile
//   2. Log in to your app there (don't log out afterwards: that ends the session).
//   3. SESSION_DOMAINS="myapp.com,other.io" node save-session.mjs part1   → state/part1.json (git-ignored)
// record.mjs loads state/<part>.json automatically. Delete the files when you're done recording.
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
const name = process.argv[2] ?? 'part1'
const domains = (process.env.SESSION_DOMAINS ?? '').split(',').map((d) => d.trim()).filter(Boolean)
if (!domains.length) { console.error('Set SESSION_DOMAINS, e.g. SESSION_DOMAINS="myapp.com"'); process.exit(1) }
const b = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://127.0.0.1:9333')
const ctx = b.contexts()[0]
const st = await ctx.storageState()
const keep = (d) => domains.some((x) => d.includes(x))
st.cookies = st.cookies.filter((c) => keep(c.domain))
// localStorage of open tabs on those domains (some apps tie the session to a browser id kept there)
st.origins = []
for (const p of ctx.pages()) {
  const u = new URL(p.url()); if (!keep(u.hostname)) continue
  const localStorage = await p.evaluate(() => Object.entries(window.localStorage).map(([name, value]) => ({ name, value })))
  st.origins.push({ origin: u.origin, localStorage })
}
mkdirSync(new URL('./state/', import.meta.url), { recursive: true })
writeFileSync(new URL(`./state/${name}.json`, import.meta.url), JSON.stringify(st), { mode: 0o600 })
console.log(`${name} saved: ${st.cookies.length} cookies, ${st.origins.length} origins`)
process.exit(0)
