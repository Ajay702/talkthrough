// Loads a demo project: the demo/ folder inside the user's repo (config, script, scenes, recordings).
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULTS = {
  appUrl: 'http://localhost:3000',
  browserPath: undefined,          // Brave/Chrome path; default: Brave if installed, else Playwright's Chromium
  viewport: { width: 1920, height: 1080 },
  fps: 25,
  sessions: {},                    // { part1: 'admin' } → loads demo/state/admin.json for that part
  voice: {
    provider: 'eleven',            // 'eleven' (clone your voice) | 'openai' (stock voice) | 'own' (your recording as is)
    elevenModel: 'eleven_v3',      // v3 keeps accents and understands [pause] tags
    openaiVoice: 'ash',
    style: 'Speak like a friendly developer showing a project to a colleague: warm, relaxed, conversational, natural pauses.',
    gap: 0.45,                     // seconds of breathing room after each line
  },
  llm: { provider: 'auto', anthropicModel: 'claude-opus-5-5', openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4.1' },
}

// Brave if installed (its headless screencast is what the recorder is tuned for), else Playwright's Chromium.
export function findBrowser(config = {}) {
  if (config.browserPath) return config.browserPath
  if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH
  const env = process.env
  const candidates = process.platform === 'win32'
    ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
        .map((b) => join(b, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))
    : process.platform === 'darwin'
      ? ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
      : ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave', '/opt/brave.com/brave/brave']
  return candidates.find((c) => existsSync(c)) // undefined → Playwright's own Chromium
}

export function projectDir(flags = {}) {
  return resolve(flags.dir ?? process.env.TALKTHROUGH_DIR ?? 'demo')
}

// .env next to the demo folder and inside it; existing environment variables win.
export function loadEnv(dir) {
  for (const f of [join(dir, '..', '.env'), join(dir, '.env')]) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
}

export async function loadConfig(dir) {
  const f = join(dir, 'demo.config.mjs')
  const user = existsSync(f) ? (await import(pathToFileURL(f).href + `?t=${Date.now()}`)).default ?? {} : {}
  return { ...DEFAULTS, ...user, voice: { ...DEFAULTS.voice, ...user.voice }, llm: { ...DEFAULTS.llm, ...user.llm },
    viewport: { ...DEFAULTS.viewport, ...user.viewport } }
}

export function paths(dir) {
  const p = (x) => join(dir, x)
  return { dir, script: p('script.md'), spoken: p('spoken-lines.json'), scenes: p('scenes.mjs'), voice: p('voice'),
    tts: p('tts'), out: p('out'), final: p('final'), state: p('state') }
}
export const ensure = (d) => (mkdirSync(d, { recursive: true }), d)

// script.md: "## Part title" headings; each section starts with a **[on-screen cue]**, then the spoken text.
export function parseScript(file) {
  if (!existsSync(file)) throw new Error(`No script at ${file}. Run "talkthrough init" or "talkthrough draft" first.`)
  const parts = readFileSync(file, 'utf8').split(/^## /m).slice(1)
  return parts.map((body, i) => {
    const title = body.split('\n')[0].trim()
    const chunks = body.split(/\*\*\[(.*?)\]\*\*/)
    const sections = []
    for (let k = 1; k < chunks.length; k += 2) {
      sections.push({ screen: chunks[k].trim(), text: chunks[k + 1].replace(/`/g, '').split(/\s+/).join(' ').trim().replace(/[-\s]+$/, '') })
    }
    return { id: `part${i + 1}`, title, sections }
  }).filter((p) => p.sections.length)
}

// What each section actually says out loud (spoken-lines.json can add "um"s, [pause] tags, phonetic spellings).
export function spokenLines(p, parts) {
  const extra = existsSync(p.spoken) ? JSON.parse(readFileSync(p.spoken, 'utf8')) : {}
  return Object.fromEntries(parts.map((part) => {
    const over = extra[part.id]
    if (over && over.length !== part.sections.length) throw new Error(`spoken-lines.json ${part.id}: ${over.length} lines but script has ${part.sections.length} sections`)
    return [part.id, part.sections.map((s, i) => over?.[i] ?? s.text)]
  }))
}

export const words = (s) => s.split(/\s+/).filter(Boolean).length
