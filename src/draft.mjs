// "vfd draft": looks at your app and writes the first version of script.md, spoken-lines.json and scenes.mjs
// with Claude (ANTHROPIC_API_KEY) or OpenAI (OPENAI_API_KEY). You review and edit; nothing is recorded yet.
import Anthropic from '@anthropic-ai/sdk'
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensure, parseScript, paths, findBrowser } from './project.mjs'


// What the model sees of each page: visible text, controls it can target, and a screenshot.
async function snapshot(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3500)
  const info = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
    const label = (el) => (el.getAttribute('aria-label') || el.placeholder || el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80)
    const controls = [...document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=tab],[onclick]')]
      .filter(vis).map((el) => `${el.tagName.toLowerCase()}${el.type ? `[type=${el.type}]` : ''}: ${label(el)}`).filter((x) => !x.endsWith(': '))
    const headings = [...document.querySelectorAll('h1,h2,h3')].filter(vis).map((h) => h.innerText.trim()).filter(Boolean)
    return { title: document.title, text: document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 5000), controls: [...new Set(controls)].slice(0, 90), headings: headings.slice(0, 40) }
  })
  const shot = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64')
  return { url: page.url(), ...info, shot }
}

const API = `Scene helpers (all async unless noted), passed as h:
- h.at('word', lead=0.3): wait until that word is spoken in THIS section (word-exact sync). Use words that literally appear in the section's spoken text, in order. Start slow actions (typing, page loads, opening panels) BEFORE their at(), right at the start of the section.
- h.hold(seconds): a pause that stretches to fit the speaker's pace.
- h.moveTo(page, x, y), h.moveToEl(page, locator): human cursor movement. h.hoverText(page, 'exact text'), h.hoverBadge(page, 'label') (right-most match).
- h.clickEl(page, locator), h.typeHuman(page, locator, 'text'), h.scrollSmooth(page, y), h.scrollToText(page, 'text', offsetPx).
- h.waitText(page, /regex/, seconds), h.caption(page, 'short caption shown at the top'), h.sleep(s), h.appUrl, h.W, h.H.
Reset state between scenes by reloading the page (page.goto), not with the app's own "clear"/"reset" buttons, which often leave inputs filled. Find a specific record by searching for it by name rather than relying on list order.
Use Playwright locators: page.getByText('x', { exact: true }), page.getByRole('button', { name: 'x' }), page.getByPlaceholder('x'), page.locator('select').filter({ hasText: 'x' }). Only target text/controls that appear in the page snapshots.`

const FORMAT = `Return JSON with:
- script_md: the script. Format exactly:
  # <title>
  ## Part 1: <short title>
  **[what is on screen]**
  <spoken lines>
  ... (each "**[cue]**" starts one section; 3-6 sections per part; 1-3 parts; each part under 2.5 minutes)
- spoken_lines: array (one per part) of arrays (one string per section, same count as script sections): how each section is said out loud: same meaning, with light natural fillers ("so", "um" at most once per section), [pause] tags for ElevenLabs v3, numbers and product names spelled the way they are pronounced (e.g. "N-eight-N", "forty thousand rupees").
- scenes_js: an ES module. Exactly:
  export const open = { part1: async (page, h) => { await page.goto(h.appUrl + '/path', { waitUntil: 'domcontentloaded' }) }, ... }
  export default (h) => ({ part1: [ async (page) => { ... }, ... one per section ], part2: [ ... ] })
  Plain JavaScript, no imports. Each scene performs what its cue says, synced with h.at() to words of its spoken line.
- notes: anything the developer must check (selectors you guessed, logins needed, actions that send emails or change data).`

const SYSTEM = `You write short, human product demo videos for developers' apps: what a person would say while showing the app to a colleague. Plain, warm, specific words; no jargon or hype; explain what each part does for the user. Never type passwords or create accounts in scenes (logged-in pages come from saved sessions). Avoid destructive actions unless the developer's description asks for them.\n\n${API}\n\n${FORMAT}`

const SCHEMA = { type: 'object', additionalProperties: false, required: ['script_md', 'spoken_lines', 'scenes_js', 'notes'],
  properties: { script_md: { type: 'string' }, spoken_lines: { type: 'array', items: { type: 'array', items: { type: 'string' } } }, scenes_js: { type: 'string' }, notes: { type: 'string' } } }

function userContent(about, minutes, snaps) {
  const intro = `Make a ${minutes}-minute demo video of this app.\nWhat it is / what to show: ${about}\nApp URL: (use h.appUrl)\n\nPages:`
  return [intro, ...snaps.map((s, i) => `\n--- Page ${i + 1}: ${s.url} (${s.title})${s.as ? ` [logged in as the saved "${s.as}" session]` : ''}\nHeadings: ${s.headings.join(' | ')}\nControls:\n${s.controls.join('\n')}\nVisible text:\n${s.text}`)].join('\n')
}

async function withClaude(model, about, minutes, snaps) {
  const client = new Anthropic()
  const content = [{ type: 'text', text: userContent(about, minutes, snaps) }]
  for (const s of snaps) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.shot } }, { type: 'text', text: `(screenshot of ${s.url})` })
  const msg = await client.beta.messages.stream({
    model, max_tokens: 32000, system: SYSTEM,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  }).finalMessage()
  if (msg.stop_reason === 'refusal') throw new Error(`Claude declined: ${msg.stop_details?.explanation ?? 'no reason given'}`)
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude ran out of output tokens; try fewer pages or a shorter video.')
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return JSON.parse(text)
}

async function withOpenAI(model, about, minutes, snaps) {
  const content = [{ type: 'text', text: userContent(about, minutes, snaps) }, ...snaps.map((s) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${s.shot}` } }))]
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
      response_format: { type: 'json_schema', json_schema: { name: 'demo', strict: true, schema: SCHEMA } } }) })
  if (!r.ok) throw new Error(`OpenAI failed (${r.status}): ${(await r.text()).slice(0, 300)}`)
  return JSON.parse((await r.json()).choices[0].message.content)
}

export async function draft({ dir, config, about, pages = [], minutes = 3, session, force = false }) {
  const p = paths(dir)
  ensure(dir)
  for (const f of [p.script, p.scenes]) if (existsSync(f) && !force) throw new Error(`${f} already exists; use --force to replace it.`)
  const useClaude = config.llm.provider === 'anthropic' || (config.llm.provider === 'auto' && process.env.ANTHROPIC_API_KEY)
  if (!useClaude && !process.env.OPENAI_API_KEY) throw new Error('Set ANTHROPIC_API_KEY (Claude) or OPENAI_API_KEY in demo/.env.')

  // Pages: "/admin" uses --session; "/dashboard@priya" looks at that page as the saved "priya" session.
  const browser = await chromium.launch({ executablePath: findBrowser(config), headless: true })
  const ctxs = {}
  const pageFor = async (who) => {
    if (!ctxs[who ?? '']) {
      const state = who ? join(p.state, `${who}.json`) : undefined
      if (state && !existsSync(state)) throw new Error(`No saved "${who}" session: run "vfd session ${who}"`)
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(state ? { storageState: state } : {}) })
      ctxs[who ?? ''] = await ctx.newPage()
    }
    return ctxs[who ?? '']
  }
  const snaps = []
  for (const spec of ['', ...pages]) {
    const [path, who = session] = spec.split('@')
    const u = path.startsWith('http') ? path : config.appUrl.replace(/\/$/, '') + (path ? '/' + path.replace(/^\//, '') : '')
    console.log(`looking at ${u}${who ? ` as ${who}` : ''}`)
    snaps.push({ ...(await snapshot(await pageFor(who), u)), as: who })
  }
  await browser.close()

  console.log(`writing the script and scenes with ${useClaude ? config.llm.anthropicModel : config.llm.openaiModel}…`)
  const out = useClaude ? await withClaude(config.llm.anthropicModel, about, minutes, snaps) : await withOpenAI(config.llm.openaiModel, about, minutes, snaps)

  writeFileSync(p.script, out.script_md.trim() + '\n')
  const parts = parseScript(p.script)
  writeFileSync(p.spoken, JSON.stringify(Object.fromEntries(parts.map((x, i) => [x.id, out.spoken_lines[i] ?? x.sections.map((s) => s.text)])), null, 2))
  writeFileSync(p.scenes, `// Drafted by "vfd draft"; edit freely. One scene per script section; see README "Scene helpers".\n${out.scenes_js.trim()}\n`)
  writeFileSync(join(dir, 'DRAFT-NOTES.md'), `# Things to check\n\n${out.notes}\n`)

  // Sanity check: the module loads and has one scene per section.
  execFileSync(process.execPath, ['--check', p.scenes])
  const mod = await import(pathToFileURL(p.scenes).href + `?t=${Date.now()}`)
  const def = mod.default(new Proxy({}, { get: () => () => {} }))
  const problems = parts.filter((x) => { const s = def[x.id]; return !s || (Array.isArray(s) ? s : s.scenes).length !== x.sections.length }).map((x) => x.id)
  console.log(`\nwrote script.md (${parts.length} parts, ${parts.reduce((a, x) => a + x.sections.length, 0)} sections), spoken-lines.json, scenes.mjs, DRAFT-NOTES.md`)
  if (problems.length) console.log(`⚠ scene count doesn't match the script in: ${problems.join(', ')}; fix scenes.mjs before recording`)
  console.log('Next: read the script, then "vfd studio" to record your voice.')
}
