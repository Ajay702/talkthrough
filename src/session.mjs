// "vfd session <name>": opens a browser window at your app, you log in, press Enter, and the session is
// saved to demo/state/<name>.json so the headless recorder can show logged-in pages. Nothing leaves your machine.
import { chromium } from 'playwright'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { ensure, paths } from './project.mjs'

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'

export async function saveSession({ dir, config, name, url }) {
  const p = paths(dir)
  const ctx = await chromium.launchPersistentContext(join(ensure(p.state), `.browser-${name}`) /* one profile per session: logging in as someone else never logs this one out */, {
    headless: false, viewport: null, executablePath: config.browserPath ?? (existsSync(BRAVE) ? BRAVE : undefined) })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto(url ?? config.appUrl)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  await rl.question(`Log in as "${name}" in the browser window (stay logged in), then press Enter here… `)
  rl.close()
  const file = join(p.state, `${name}.json`)
  // Cookies plus localStorage of the open tabs (some apps tie a session to an id kept there).
  writeFileSync(file, JSON.stringify(await ctx.storageState()), { mode: 0o600 })
  await ctx.close()
  console.log(`saved ${file}. Use it with  sessions: { part1: '${name}' }  in demo.config.mjs`)
  console.log('Logging out of the app later ends this session; just run "vfd session" again.')
}
