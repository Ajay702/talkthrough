// Records the silent screen videos for a voice-first demo.
//   node record.mjs part1|part2|all
// If voice/<part>.marks.json exists (from the voice studio), each scene is fitted to how
// long you actually spoke that section; otherwise scenes are paced to script.md's
// word counts. Writes out/<part>.mp4 and out/<part>.cues.json (when each scene starts).
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = process.env.APP_URL ?? 'https://github.com/Ajay702/voice-first-demo'
// Brave if installed (or BROWSER_PATH), otherwise Playwright's own Chromium.
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const BROWSER = process.env.BROWSER_PATH ?? (existsSync(BRAVE) ? BRAVE : undefined)
const OUT = fileURLToPath(new URL('./out/', import.meta.url))
const VOICE = fileURLToPath(new URL(`./${process.env.VOICE_DIR ?? 'voice'}/`, import.meta.url))
const W = 1920
const H = 1080
// Spoken pace used to size each section; slow enough to read without rushing.
const WPM = 110
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000))
const forWords = (n) => (n / WPM) * 60 + 3
// Pauses inside a scene are scaled by `pace` so the scene roughly fills its time slot.
// A pause that would run past the scene's slot is cut short, so a slow page load eats
// into idle time rather than pushing the next scene late.
let pace = 1
// Word-synced actions: voice-el/<part>.words.json gives each spoken word's time; at('Red') waits for it.
let WORDS = [], T0 = 0, SEC = 0, CUR = 0, ANCHORS = []
const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '')
async function at(token, lead = 0.3) {
  if (!WORDS.length) return // way 1 (your own recording): no word timings, actions just run in order
  const tk = norm(token)
  const i = WORDS.findIndex((x, k) => k >= CUR && x.s === SEC && norm(x.w).startsWith(tk))
  if (i < 0) { console.log(`    (word "${token}" not found in section ${SEC + 1})`); return }
  CUR = i + 1
  const wait = (T0 + (WORDS[i].t - lead) * 1000 - Date.now()) / 1000
  if (wait > 0) await sleep(wait); else if (wait < -0.8) console.log(`    late by ${(-wait).toFixed(1)}s for "${token}"`)
  // video time this action really starts → the voice time it should start (warp.mjs lines them up)
  ANCHORS.push({ v: (Date.now() - T0) / 1000, a: WORDS[i].t - lead, word: token })
}
let slotEnd = Infinity
const hold = (s) => sleep(Math.max(0, Math.min(s * pace, (slotEnd - Date.now()) / 1000 - 1)))

// A visible cursor: headless recordings have none, and the viewer needs to see what's pointed at.
const CURSOR = `
addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div')
  c.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;' +
    'margin:-11px 0 0 -11px;border-radius:50%;background:rgba(239,68,68,.35);border:2px solid #ef4444;' +
    'left:-50px;top:-50px;transition:transform .15s'
  document.body.appendChild(c)
  addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' }, true)
  addEventListener('mousedown', () => (c.style.transform = 'scale(.7)'), true)
  addEventListener('mouseup', () => (c.style.transform = ''), true)
})`

// Brave's headless screencast leaves out the bottom 81 px of the viewport, so the
// viewport is that much taller and the captured area is exactly W x H.
const HIDDEN_PX = 81
const FPS = 25

async function record(name, prepare, scenes, storageState) {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true })
  const ctx = await browser.newContext({
    viewport: { width: W, height: H + HIDDEN_PX },
    colorScheme: 'light',
    locale: 'en-GB',
    ...(storageState ? { storageState } : {}),
  })
  await ctx.addInitScript(CURSOR)
  const page = await ctx.newPage()
  await prepare(page)

  // Screencast frames arrive only when the page changes; repeat the latest one at a
  // constant frame rate so the video keeps real time.
  const mp4 = join(OUT, `${name}.mp4`)
  const ffmpeg = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg',
    '-framerate', String(FPS), '-i', '-', '-vf', `crop=${W}:${H}:0:0,format=yuv420p`,
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', mp4], { stdio: ['pipe', 'inherit', 'inherit'] })
  const cdp = await ctx.newCDPSession(page)
  let last = null
  cdp.on('Page.screencastFrame', (f) => {
    last = Buffer.from(f.data, 'base64')
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92 })
  while (!last) await sleep(0.05)
  const t0 = Date.now()
  T0 = t0
  const wf = join(VOICE, `${name}.words.json`)
  WORDS = existsSync(wf) ? JSON.parse(readFileSync(wf, 'utf8')) : []
  ANCHORS = []
  let written = 0
  const pump = setInterval(() => {
    const due = Math.floor(((Date.now() - t0) / 1000) * FPS)
    for (; written < due; written++) ffmpeg.stdin.write(last)
  }, 1000 / FPS)

  // When each scene should end, measured from the start of the video.
  const ends = sceneEnds(name, scenes)
  const cues = []
  for (const [i, [section, words, run]] of scenes.entries()) {
    const began = Date.now()
    const at = (began - t0) / 1000
    cues.push({ section, at: +at.toFixed(2) })
    // Loose fit: stretch or squeeze the scene's pauses towards its slot, within limits.
    pace = Math.min(2.5, Math.max(0.4, (ends[i] - at) / forWords(words)))
    slotEnd = t0 + ends[i] * 1000
    SEC = i; CUR = Math.max(0, WORDS.findIndex((x) => x.s === i))
    await run(page)
    // Hold to the scene's end on the overall timeline, so an overrun is caught up later.
    const left = ends[i] - (Date.now() - t0) / 1000
    if (left > 0) await sleep(left)
    console.log(`  ${section}: ${((Date.now() - began) / 1000).toFixed(0)}s (slot ends ${ends[i].toFixed(0)}s)`)
  }
  clearInterval(pump)
  await cdp.send('Page.stopScreencast')
  const done = new Promise((r) => ffmpeg.on('close', r))
  ffmpeg.stdin.end()
  await done
  await browser.close()
  writeFileSync(join(OUT, `${name}.cues.json`), JSON.stringify(cues, null, 2))
  writeFileSync(join(OUT, `${name}.anchors.json`), JSON.stringify(ANCHORS, null, 2))
  console.log(`→ ${mp4}`)
}

function sceneEnds(name, scenes) {
  const file = join(VOICE, `${name}.marks.json`)
  const nominal = []
  let t = 0
  for (const [, words] of scenes) nominal.push((t += forWords(words)))
  if (!existsSync(file)) {
    console.log(`${name}: no voice timings, pacing to the script`)
    return nominal
  }
  // marks: { starts: [seconds each section began in the recording], total: seconds }
  const { starts, total } = JSON.parse(readFileSync(file, 'utf8'))
  console.log(`${name}: fitting to your recording (${total.toFixed(0)}s, ${starts.length} sections)`)
  const ends = scenes.map((_, i) => (i + 1 < starts.length ? starts[i + 1] : null))
  // Sections you didn't mark (finished early) share the remaining time by word count.
  const known = Math.max(0, ...ends.filter((e) => e !== null))
  const rest = scenes.map(([, w], i) => (ends[i] === null ? forWords(w) : 0))
  const restSum = rest.reduce((a, b) => a + b, 0)
  let acc = known
  return ends.map((e, i) => {
    if (e !== null) return e
    acc += (rest[i] / restSum) * Math.max(total - known, 0)
    return acc
  })
}

// --- helpers --------------------------------------------------------------

let mouse = { x: W / 2, y: H / 2 }
// Human-like cursor: eased (slow-fast-slow) along a slight curve, ~16 ms per step.
async function moveTo(page, x, y, steps = 34) {
  const from = { ...mouse }
  const bend = (Math.random() - 0.5) * 0.18
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    const nx = -(y - from.y) * bend, ny = (x - from.x) * bend
    const arc = Math.sin(Math.PI * e)
    await page.mouse.move(from.x + (x - from.x) * e + nx * arc, from.y + (y - from.y) * e + ny * arc)
    await sleep(0.016)
  }
  mouse = { x, y }
}
async function moveToEl(page, locator, dx = 0.5, dy = 0.5) {
  const b = await locator.boundingBox()
  await moveTo(page, b.x + b.width * dx, b.y + b.height * dy)
}
// Eased scroll over ~1 s, like a trackpad flick, instead of an instant jump.
async function scrollSmooth(page, y, secs = 1.1) {
  await page.evaluate(async ([top, ms]) => {
    const s = window.scrollY, d = top - s, t0 = performance.now()
    await new Promise((res) => { const f = (now) => { const t = Math.min(1, (now - t0) / ms)
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
      window.scrollTo(0, s + d * e); t < 1 ? requestAnimationFrame(f) : res() }; requestAnimationFrame(f) })
  }, [y, secs * 1000])
  await sleep(0.2)
}
async function scrollToEl(page, locator, offset = 90) {
  const y = await locator.evaluate((el, o) => el.getBoundingClientRect().top + window.scrollY - o, offset)
  await scrollSmooth(page, y)
}
const card = (page, title) => page.locator('.card, section').filter({ has: page.getByRole('heading', { name: title }) }).first()

// --- scene helpers --------------------------------------------------------

const visible = (p, sel, text) => p.locator(sel).filter({ hasText: text }).filter({ visible: true })
async function clickEl(p, loc) { await loc.scrollIntoViewIfNeeded(); await moveToEl(p, loc); await sleep(0.25); await loc.click() }
async function typeHuman(p, loc, text, gap = 0.09) { await clickEl(p, loc); for (const ch of text) { await p.keyboard.type(ch); await sleep(gap + Math.random() * gap * 0.8) } }
// The button with `label` on the same row as some text (e.g. a table row's name).
async function rowButton(p, name, label) {
  const nb = await p.getByText(name, { exact: true }).filter({ visible: true }).first().boundingBox()
  const btns = p.locator('button').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).filter({ visible: true })
  let best = null, bd = 1e9
  for (const b of await btns.all()) { const bb = await b.boundingBox(); if (!bb) continue; const d = Math.abs(bb.y + bb.height / 2 - (nb.y + nb.height / 2)); if (d < bd) { bd = d; best = b } }
  return best
}
async function textY(p, text) { const b = await p.getByText(text).filter({ visible: true }).first().boundingBox(); return b ? b.y + b.height / 2 : H / 2 }
async function scrollToText(p, text, offset = 140) {
  const loc = p.getByText(text).filter({ visible: true }).first()
  const y = await loc.evaluate((el, o) => el.getBoundingClientRect().top + window.scrollY - o, offset)
  await scrollSmooth(p, y)
}
async function waitText(p, re, secs) { const end = Date.now() + secs * 1000; while (Date.now() < end) { if (re.test(await p.innerText('body'))) return true; await sleep(0.5) } return false }
async function caption(p, text) {
  await p.evaluate((t) => { let c = document.getElementById('__cap'); if (!c) { c = document.createElement('div'); c.id = '__cap'
    c.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:2147483646;background:#1f3b57;color:#fff;font:600 22px system-ui;padding:12px 22px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.2)'; document.body.appendChild(c) } c.textContent = t }, text)
}
// --- generic helpers used by the example ---------------------------------------
const hoverText = async (p, text, exact = true) => {
  const loc = p.getByText(text, { exact }).filter({ visible: true }).first()
  if (await loc.count()) { await loc.scrollIntoViewIfNeeded(); await moveToEl(p, loc) }
}
// When the same word appears as a label and as a badge, the badge is usually the right-most one.
async function hoverBadge(p, label) {
  let best = null, bx = -1
  for (const l of await p.getByText(label, { exact: true }).filter({ visible: true }).all()) { const b = await l.boundingBox(); if (b && b.x > bx && b.y > 0 && b.y < H) { bx = b.x; best = l } }
  if (best) await moveToEl(p, best)
}
const heading = (p, text) => scrollToText(p, text, 110)

// --- Example: the tool demos its own GitHub page ---------------------------------
// Each scene matches one **[cue]** section of script.md. `await at('word')` waits until that word is
// spoken (needs voice-el/<part>.words.json from build-voice.mjs; without it, actions just run in order).
// Replace these with your own product: ordinary Playwright calls plus hold(), at() and the helpers above.

const part1 = [
  ['The repo page', 40, async (p) => {
    await moveTo(p, 420, 230, 40)
    await at('voice'); await hoverText(p, 'voice-first-demo', false)
    await at('screen'); await moveTo(p, W * 0.45, 520, 40)
    await hold(2)
  }],
  ['How it works', 45, async (p) => {
    await at('flips', 0.8); await heading(p, 'How it works')
    await at('teleprompter'); await hoverText(p, 'Voice studio', false)
    await at('recorder'); await hoverText(p, 'Recorder', false)
    await hold(2)
  }],
]

const part2 = [
  ['Two ways to voice it', 45, async (p) => {
    await at('two', 0.8); await heading(p, 'Two ways to voice it')
    await at('clone'); await hoverText(p, 'cloned voice', false)
    await hold(2)
  }],
  ['Making it yours', 40, async (p) => {
    await at('scenes', 0.8); await heading(p, 'Making it yours')
    await at('word'); await hoverText(p, "at('word')", false)
    await hold(2)
  }],
]

const which = process.argv[2] ?? 'all'
// Logged-in apps: save a session from your own browser with save-session.mjs, then pass it here.
const STATE = (n) => { const f = fileURLToPath(new URL(`./state/${n}.json`, import.meta.url)); return existsSync(f) ? f : undefined }
const open = async (p) => { await p.goto(APP, { waitUntil: 'domcontentloaded' }); await sleep(2) }
if (which === 'part1' || which === 'all') await record('part1', open, part1, STATE('part1'))
if (which === 'part2' || which === 'all') await record('part2', async (p) => { await open(p); await heading(p, 'Two ways to voice it') }, part2, STATE('part2'))
