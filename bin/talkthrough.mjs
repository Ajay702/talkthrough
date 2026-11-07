#!/usr/bin/env node
// talkthrough CLI. Run from your project root; everything lives in ./demo (or --dir).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensure, findBrowser, loadConfig, loadEnv, parseScript, paths, projectDir } from '../src/project.mjs'

const HELP = `talkthrough: narrated product demo videos, voice first.
(Run with  npx talkthrough <command>,  or  npm install -D talkthrough  to pin a version per project.)

  talkthrough init                      add a demo/ folder (config, script, scenes, .env.example) to this project
  talkthrough draft --about "..."       let Claude/OpenAI look at your app and write script + scenes
            [--pages /a,/b@user] [--minutes 3] [--session admin] [--force]
  talkthrough studio                    teleprompter: record your voice, one part at a time (http://localhost:8766)
  talkthrough session <name> [<name>…]  log in once per user in real browser windows; the recorder reuses them
            [--url u] [--until file]  (--until: save when that file appears instead of on Enter)
  talkthrough voice                     generate the narration (voice.provider: eleven = your cloned voice, openai)
  talkthrough record [--synced] [--part part1]   record the screen, scene by scene
  talkthrough render                    put voice on video → demo/final/demo.mp4
  talkthrough make                      voice (if AI) + record + render in one go
  talkthrough key <NAME>                paste an API key (hidden) into demo/.env, e.g. talkthrough key ELEVENLABS_API_KEY
  talkthrough doctor                    check ffmpeg, browser, keys, script and scenes

Options: --dir <folder> (default ./demo)`

const argv = process.argv.slice(2)
const cmd = argv[0]
const flags = {}; const pos = []
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); flags[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true } else pos.push(argv[i])
}
const dir = projectDir(flags)
loadEnv(dir)

async function main() {
  if (!cmd || ['help', '--help', '-h'].includes(cmd) || flags.help) return console.log(HELP)
  if (cmd === 'init') {
    const tpl = fileURLToPath(new URL('../templates/', import.meta.url))
    ensure(dir)
    for (const [from, to] of [['demo.config.mjs', 'demo.config.mjs'], ['script.md', 'script.md'], ['scenes.mjs', 'scenes.mjs'], ['env.example', '.env.example'], ['gitignore', '.gitignore']]) {
      const dest = join(dir, to)
      if (existsSync(dest) && !flags.force) { console.log(`  keep ${to} (exists)`); continue }
      copyFileSync(join(tpl, from), dest); console.log(`  add  ${to}`)
    }
    return console.log(`\nNext: set appUrl in ${join(dir, 'demo.config.mjs')}, copy .env.example to .env if you use AI features,\nthen "talkthrough draft --about 'what your app does'" or edit script.md + scenes.mjs yourself.`)
  }
  if (cmd === 'key') return saveKey(pos[0])
  const config = await loadConfig(dir)
  const only = flags.part ? String(flags.part).split(',') : undefined
  switch (cmd) {
    case 'draft': {
      if (!flags.about) throw new Error('Tell it what the app is: talkthrough draft --about "an invoicing app for freelancers; show creating and sending an invoice"')
      const { draft } = await import('../src/draft.mjs')
      return draft({ dir, config, about: flags.about, pages: flags.pages ? String(flags.pages).split(',') : [], minutes: Number(flags.minutes ?? 3), session: flags.session, force: !!flags.force })
    }
    case 'studio': { const { startStudio } = await import('../src/studio/server.mjs'); return startStudio(dir, Number(flags.port ?? 8766)) }
    case 'session': {
      if (!pos.length) throw new Error('Name the session(s): talkthrough session admin  or  talkthrough session admin customer')
      const { saveSession } = await import('../src/session.mjs'); return saveSession({ dir, config, names: pos, url: flags.url, until: flags.until })
    }
    case 'voice': { const { generateVoice } = await import('../src/voice.mjs'); return generateVoice({ dir, config }) }
    case 'record': {
      const { record } = await import('../src/recorder.mjs')
      return record({ dir, config, only, synced: !!flags.synced || (config.voice.provider !== 'own' && flags.synced !== 'false') })
    }
    case 'render': { const { render } = await import('../src/render.mjs'); return render({ dir, config }) }
    case 'make': {
      const ai = config.voice.provider !== 'own'
      if (ai) { const { generateVoice } = await import('../src/voice.mjs'); await generateVoice({ dir, config }) }
      const { record } = await import('../src/recorder.mjs'); await record({ dir, config, only, synced: ai })
      const { render } = await import('../src/render.mjs'); return render({ dir, config })
    }
    case 'doctor': return doctor(config)
    default: console.log(`Unknown command "${cmd}".\n\n${HELP}`); process.exitCode = 1
  }
}

// Hidden prompt → demo/.env (mode 600). The key is never echoed or written anywhere else.
async function saveKey(name) {
  const KNOWN = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY']
  if (!name || !/^[A-Z0-9_]+$/.test(name)) throw new Error(`Usage: talkthrough key ${KNOWN.join(' | ')}`)
  process.stdout.write(`Paste ${name} (hidden), then Enter: `)
  const key = await new Promise((resolve) => {
    let buf = ''
    process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdin.setEncoding('utf8')
    process.stdin.on('data', function on(ch) {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { process.stdin.setRawMode?.(false); process.stdin.pause(); process.stdin.off('data', on); process.stdout.write('\n'); return resolve(buf.trim()) }
        if (c === '\u0003') process.exit(130)
        if (c === '\u007f') buf = buf.slice(0, -1); else buf += c
      }
    })
  })
  if (!key) throw new Error('Nothing entered.')
  ensure(dir)
  const f = join(dir, '.env')
  const lines = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l && !l.startsWith(`${name}=`)) : []
  writeFileSync(f, [...lines, `${name}=${key}`].join('\n') + '\n', { mode: 0o600 })
  console.log(`saved ${name} to ${f}`)
}

async function doctor(config) {
  const ok = (b, msg, fix = '') => console.log(`${b ? '✓' : '✗'} ${msg}${!b && fix ? `  →  ${fix}` : ''}`)
  const has = (bin) => { try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true } catch { return false } }
  ok(Number(process.versions.node.split('.')[0]) >= 18, `Node ${process.versions.node}`, 'Node 18+ needed')
  ok(has('ffmpeg') && has('ffprobe'), 'ffmpeg + ffprobe', 'brew install ffmpeg  /  apt install ffmpeg')
  const b = findBrowser(config)
  ok(true, `browser: ${b ?? "Playwright's Chromium (if missing: npx playwright install chromium)"}`)
  ok(true, `platform: ${process.platform}${process.platform === 'win32' ? ' (recording is tested on Windows in CI; report anything odd)' : ''}`)
  const p = paths(dir)
  ok(existsSync(p.script), `script ${p.script}`, 'talkthrough init  or  talkthrough draft')
  if (existsSync(p.script)) {
    const parts = parseScript(p.script)
    console.log(`  ${parts.map((x) => `${x.id}: ${x.sections.length} sections`).join(', ')}`)
    if (existsSync(p.scenes)) {
      try {
        const mod = await import(pathToFileURL(p.scenes).href + `?t=${Date.now()}`)
        const def = mod.default(new Proxy({}, { get: () => () => {} }))
        for (const x of parts) { const s = def[x.id]; const n = s ? (Array.isArray(s) ? s : s.scenes).length : 0; ok(n === x.sections.length, `${x.id}: ${n} scenes for ${x.sections.length} sections`) }
      } catch (e) { ok(false, `scenes.mjs loads`, e.message.split('\n')[0]) }
    } else ok(false, 'scenes.mjs', 'talkthrough init  or  talkthrough draft')
  }
  const v = config.voice.provider
  ok(true, `voice.provider: ${v}`)
  if (v === 'eleven') ok(!!process.env.ELEVENLABS_API_KEY, 'ELEVENLABS_API_KEY set', 'add it to demo/.env')
  if (v === 'openai') ok(!!process.env.OPENAI_API_KEY, 'OPENAI_API_KEY set', 'add it to demo/.env')
  if (v === 'eleven') ok(existsSync(join(p.tts, 'eleven_voice_id.txt')) || ['part1', 'part2'].some((x) => existsSync(join(p.voice, `${x}.webm`))), 'your voice to clone (a studio take, or an existing clone)', 'talkthrough studio')
  ok(!!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY), 'key for talkthrough draft (optional)', 'ANTHROPIC_API_KEY or OPENAI_API_KEY in demo/.env')
  for (const [part, s] of Object.entries(config.sessions)) ok(existsSync(join(p.state, `${s}.json`)), `${part} session "${s}"`, `talkthrough session ${s}`)
  const gi = join(dir, '.gitignore')
  ok(existsSync(gi) && readFileSync(gi, 'utf8').includes('.env'), 'demo/.gitignore keeps .env, recordings and sessions out of git', 'talkthrough init')
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1 })
