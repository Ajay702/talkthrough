// "vfd session <name> [<name>…]": opens one browser window per name at your app (each with its own profile,
// so being logged in as one user never logs out another), you log in, then press Enter (or create the
// --until file), and each session is saved to demo/state/<name>.json for the headless recorder.
// Nothing leaves your machine.
import { chromium } from 'playwright'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { ensure, paths, findBrowser } from './project.mjs'


export async function saveSession({ dir, config, names, url, until }) {
  const p = paths(dir)
  const windows = []
  for (const name of names) {
    const ctx = await chromium.launchPersistentContext(join(ensure(p.state), `.browser-${name}`), {
      headless: false, viewport: null, executablePath: findBrowser(config) })
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(url ?? config.appUrl)
    await page.evaluate((n) => { document.title = `Log in as ${n}: ${document.title}` }, name).catch(() => {})
    windows.push({ name, ctx })
  }
  const who = names.map((n) => `"${n}"`).join(' and ')
  if (until) {
    if (existsSync(until)) unlinkSync(until)
    console.log(`Log in as ${who} (one window each, stay logged in). Waiting for ${until} …`)
    while (!existsSync(until)) await new Promise((r) => setTimeout(r, 1000))
    unlinkSync(until)
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question(`Log in as ${who} (one window each, stay logged in), then press Enter here… `)
    rl.close()
  }
  for (const { name, ctx } of windows) {
    const file = join(p.state, `${name}.json`)
    // Cookies plus localStorage of the open tabs (some apps tie a session to an id kept there).
    writeFileSync(file, JSON.stringify(await ctx.storageState()), { mode: 0o600 })
    await ctx.close()
    console.log(`saved ${file}`)
  }
  console.log(`Map parts to sessions in demo.config.mjs, e.g. sessions: { part1: '${names[0]}' }.`)
  console.log('Logging out of the app later ends a session; just run "vfd session" again.')
}
