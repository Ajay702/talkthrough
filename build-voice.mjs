// Builds the final voice track for each part from the cloned-voice clips, and word timestamps for it.
//   node build-voice.mjs   (needs OPENAI_API_KEY for word timings)
// Writes voice-el/<part>.wav, voice-el/<part>.marks.json (section starts, same format as the voice studio)
// and voice-el/<part>.words.json ([{ s: section, w: word, t: seconds from part start }]), so the recorder
// can fire each on-screen action on the word that mentions it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

const KEY = process.env.OPENAI_API_KEY
const GAP = 0.45
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()
const dur = (f) => Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]))
mkdirSync('voice-el', { recursive: true })

async function words(file) {
  const cache = file.replace(/\.mp3$/, '.words.json')
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'))
  const form = new FormData()
  form.append('model', 'whisper-1'); form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'word')
  form.append('file', new Blob([readFileSync(file)], { type: 'audio/mpeg' }), 'clip.mp3')
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form })
  if (!r.ok) throw new Error(`whisper ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const w = (await r.json()).words.map((x) => ({ w: x.word, t: x.start }))
  writeFileSync(cache, JSON.stringify(w))
  return w
}

for (const part of ['part1', 'part2']) {
  const clips = readdirSync('tts').filter((f) => new RegExp(`^el_${part}_\\d+\\.mp3$`).test(f))
    .sort((a, b) => Number(a.match(/_(\d+)\./)[1]) - Number(b.match(/_(\d+)\./)[1]))
  const starts = [], all = []
  let t = 0
  const inputs = [], filters = []
  for (const [i, c] of clips.entries()) {
    starts.push(+t.toFixed(2))
    for (const x of await words(`tts/${c}`)) all.push({ s: i, w: x.w, t: +(t + x.t).toFixed(2) })
    const d = dur(`tts/${c}`) + GAP
    inputs.push('-i', `tts/${c}`)
    filters.push(`[${i}:a]aresample=48000,apad,atrim=duration=${d}[a${i}]`)
    t += d
  }
  const concat = clips.map((_, i) => `[a${i}]`).join('') + `concat=n=${clips.length}:v=0:a=1,loudnorm=I=-16:TP=-1.5[out]`
  sh('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', filters.join(';') + ';' + concat, '-map', '[out]', '-ar', '48000', `voice-el/${part}.wav`])
  writeFileSync(`voice-el/${part}.marks.json`, JSON.stringify({ starts, total: +t.toFixed(2) }))
  writeFileSync(`voice-el/${part}.words.json`, JSON.stringify(all))
  console.log(`${part}: ${clips.length} sections, ${t.toFixed(1)}s, ${all.length} timed words`)
}
