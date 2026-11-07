// Records the silent screen video for each part of the script, one scene per script section.
// Timing comes from (in order): word timings of a generated voice (synced mode), your studio
// recording's section marks, or the script's word count. Writes out/<part>.mp4, cues and anchors.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensure, parseScript, paths, words, findBrowser } from './project.mjs'

const HIDDEN_PX = 81 // Brave's headless screencast leaves out the bottom 81 px; record taller and crop
const WPM = 110
const sleep = (s) => new Promise((r) => setTimeout(r, Math.max(0, s) * 1000))
const forWords = (n) => (n / WPM) * 60 + 3

// ── per-scene timing state ──────────────────────────────────────────────────
let pace = 1, slotEnd = Infinity
let WORDS = [], T0 = 0, SEC = 0, CUR = 0, ANCHORS = []
let W = 1920, H = 1080
const hold = (s) => sleep(Math.min(s * pace, (slotEnd - Date.now()) / 1000 - 1))
const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '')

// Wait until `token` is spoken (synced mode). Logs when the action really started so render can line it up.
async function at(token, lead = 0.3) {
  if (!WORDS.length) return
  const tk = norm(token)
  const i = WORDS.findIndex((x, k) => k >= CUR && x.s === SEC && norm(x.w).startsWith(tk))
  if (i < 0) { console.log(`    (word "${token}" not found in section ${SEC + 1})`); return }
  CUR = i + 1
  const wait = (T0 + (WORDS[i].t - lead) * 1000 - Date.now()) / 1000
  if (wait > 0) await sleep(wait)
  ANCHORS.push({ v: (Date.now() - T0) / 1000, a: WORDS[i].t - lead, word: token })
}

// ── human-looking motion ──────────────────────────────────────────────────────
let mouse = { x: 960, y: 540 }
async function moveTo(page, x, y, steps = 34) {
  const from = { ...mouse }, bend = (Math.random() - 0.5) * 0.18
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2, arc = Math.sin(Math.PI * e)
    await page.mouse.move(from.x + (x - from.x) * e - (y - from.y) * bend * arc, from.y + (y - from.y) * e + (x - from.x) * bend * arc)
    await sleep(0.016)
  }
  mouse = { x, y }
}
async function moveToEl(page, loc, dx = 0.5, dy = 0.5) {
  const b = await loc.boundingBox(); if (b) await moveTo(page, b.x + b.width * dx, b.y + b.height * dy)
}
async function scrollSmooth(page, y, secs = 1.1) {
  await page.evaluate(async ([top, ms]) => {
    const s = window.scrollY, d = top - s, t0 = performance.now()
    await new Promise((res) => { const f = (now) => { const t = Math.min(1, (now - t0) / ms), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
      window.scrollTo(0, s + d * e); t < 1 ? requestAnimationFrame(f) : res() }; requestAnimationFrame(f) })
  }, [y, secs * 1000])
  await sleep(0.2)
}
async function scrollToText(page, text, offset = 140) {
  const loc = page.getByText(text).filter({ visible: true }).first()
  if (!(await loc.count())) return console.log(`    (text "${text}" not on screen)`)
  await scrollSmooth(page, await loc.evaluate((el, o) => el.getBoundingClientRect().top + window.scrollY - o, offset))
}
async function clickEl(page, loc) { await loc.scrollIntoViewIfNeeded(); await moveToEl(page, loc); await sleep(0.25); await loc.click() }
async function typeHuman(page, loc, text, gap = 0.09) { await clickEl(page, loc); for (const ch of text) { await page.keyboard.type(ch); await sleep(gap + Math.random() * gap * 0.8) } }
async function hoverText(page, text, exact = true) {
  const loc = page.getByText(text, { exact }).filter({ visible: true }).first()
  if (await loc.count()) { await loc.scrollIntoViewIfNeeded(); await moveToEl(page, loc) } else console.log(`    (text "${text}" not on screen)`)
}
// When the same word is a column label and a status badge, the badge is usually the right-most match.
async function hoverBadge(page, label) {
  let best = null, bx = -1
  for (const l of await page.getByText(label, { exact: true }).filter({ visible: true }).all()) { const b = await l.boundingBox(); if (b && b.x > bx && b.y > 0 && b.y < H) { bx = b.x; best = l } }
  if (best) await moveToEl(page, best)
}
async function waitText(page, re, secs) { const end = Date.now() + secs * 1000; while (Date.now() < end) { if (re.test(await page.innerText('body'))) return true; await sleep(0.5) } return false }
async function caption(page, text) {
  await page.evaluate((t) => { let c = document.getElementById('__talkthrough_cap'); if (!c) { c = document.createElement('div'); c.id = '__talkthrough_cap'
    c.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:2147483646;background:#1f2937;color:#fff;font:600 22px system-ui;padding:12px 22px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.2)'; document.body.appendChild(c) } c.textContent = t }, text)
}

// A visible cursor: headless recordings have none.
const CURSOR = `addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div')
  c.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(239,68,68,.35);border:2px solid #ef4444;left:-50px;top:-50px;transition:transform .15s'
  document.body.appendChild(c)
  addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' }, true)
  addEventListener('mousedown', () => (c.style.transform = 'scale(.7)'), true)
  addEventListener('mouseup', () => (c.style.transform = ''), true)
})`

// Section end times: synced voice marks > studio recording marks > script word counts.
function sectionEnds(p, part, synced) {
  const nominal = []; let t = 0
  for (const s of part.sections) nominal.push((t += forWords(words(s.text))))
  const file = synced ? join(p.tts, `${part.id}.marks.json`) : join(p.voice, `${part.id}.marks.json`)
  if (!existsSync(file)) { console.log(`${part.id}: no ${synced ? 'generated voice' : 'studio recording'}, pacing to the script`); return nominal }
  const { starts, total } = JSON.parse(readFileSync(file, 'utf8'))
  console.log(`${part.id}: fitting to ${synced ? 'the generated voice' : 'your recording'} (${total.toFixed(0)}s)`)
  const ends = part.sections.map((_, i) => (i + 1 < starts.length ? starts[i + 1] : null))
  const known = Math.max(0, ...ends.filter((e) => e !== null))
  const rest = part.sections.map((s, i) => (ends[i] === null ? forWords(words(s.text)) : 0)), restSum = rest.reduce((a, b) => a + b, 0) || 1
  let acc = known
  return ends.map((e, i) => (e !== null ? e : (acc += (rest[i] / restSum) * Math.max(total - known, 0))))
}

export async function record({ dir, config, only, synced = false }) {
  const p = paths(dir)
  W = config.viewport.width; H = config.viewport.height
  const parts = parseScript(p.script).filter((x) => !only || only.includes(x.id))
  const mod = await import(pathToFileURL(p.scenes).href + `?t=${Date.now()}`)
  const helpers = { at, hold, sleep, moveTo, moveToEl, scrollSmooth, scrollToText, clickEl, typeHuman, hoverText, hoverBadge, waitText, caption,
    get mouse() { return mouse }, W, H, appUrl: config.appUrl }
  const all = mod.default(helpers)
  const browserPath = findBrowser(config)
  ensure(p.out)

  for (const part of parts) {
    const def = all[part.id]
    if (!def) throw new Error(`scenes.mjs has no "${part.id}" (script.md has ${parts.length} parts)`)
    const scenes = (Array.isArray(def) ? def : def.scenes).map((s) => (typeof s === 'function' ? s : s[s.length - 1]))
    if (scenes.length !== part.sections.length) throw new Error(`${part.id}: ${scenes.length} scenes but ${part.sections.length} script sections`)
    const session = config.sessions[part.id]
    const storageState = session ? join(p.state, `${session}.json`) : undefined
    if (storageState && !existsSync(storageState)) throw new Error(`${part.id} needs a saved "${session}" session: run "talkthrough session ${session}"`)

    const browser = await chromium.launch({ executablePath: browserPath, headless: true })
    const ctx = await browser.newContext({ viewport: { width: W, height: H + HIDDEN_PX }, colorScheme: 'light', ...(storageState ? { storageState } : {}) })
    await ctx.addInitScript(CURSOR)
    const page = await ctx.newPage()
    const open = def.open ?? mod.open?.[part.id] ?? ((pg) => pg.goto(config.appUrl, { waitUntil: 'domcontentloaded' }))
    await open(page, helpers); await sleep(1)

    // Frames arrive only when the page changes; repeat the latest at a constant rate so the video keeps real time.
    const mp4 = join(p.out, `${part.id}.mp4`)
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(config.fps), '-i', '-',
      '-vf', `crop=${W}:${H}:0:0,format=yuv420p`, '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', mp4], { stdio: ['pipe', 'inherit', 'inherit'] })
    const cdp = await ctx.newCDPSession(page)
    let last = null
    cdp.on('Page.screencastFrame', (f) => { last = Buffer.from(f.data, 'base64'); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}) })
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92 })
    while (!last) await sleep(0.05)
    const t0 = Date.now(); let written = 0
    const pump = setInterval(() => { for (const due = Math.floor(((Date.now() - t0) / 1000) * config.fps); written < due; written++) ff.stdin.write(last) }, 1000 / config.fps)

    T0 = t0; ANCHORS = []
    const wf = join(p.tts, `${part.id}.words.json`)
    WORDS = synced && existsSync(wf) ? JSON.parse(readFileSync(wf, 'utf8')) : []
    const ends = sectionEnds(p, part, synced), cues = []
    for (const [i, run] of scenes.entries()) {
      const began = Date.now(), atS = (began - t0) / 1000
      cues.push({ section: part.sections[i].screen, at: +atS.toFixed(2) })
      pace = Math.min(2.5, Math.max(0.4, (ends[i] - atS) / forWords(words(part.sections[i].text))))
      slotEnd = t0 + ends[i] * 1000
      SEC = i; CUR = Math.max(0, WORDS.findIndex((x) => x.s === i))
      try { await run(page, helpers) } catch (e) { console.log(`    scene ${i + 1} error: ${e.message.split('\n')[0]}`) }
      const left = ends[i] - (Date.now() - t0) / 1000
      if (left > 0) await sleep(left)
      console.log(`  ${i + 1}. ${part.sections[i].screen}: ${((Date.now() - began) / 1000).toFixed(0)}s`)
    }
    clearInterval(pump)
    await cdp.send('Page.stopScreencast')
    const done = new Promise((r) => ff.on('close', r)); ff.stdin.end(); await done
    await browser.close()
    writeFileSync(join(p.out, `${part.id}.cues.json`), JSON.stringify(cues, null, 2))
    writeFileSync(join(p.out, `${part.id}.anchors.json`), JSON.stringify(ANCHORS, null, 2))
    console.log(`→ ${mp4}`)
  }
}
