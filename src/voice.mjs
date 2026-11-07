// Generates the narration: one clip per script section, then one voice track per part with the time of
// every spoken word (so the recorder can fire each action on its word).
//   provider 'eleven'  clone of YOUR voice from your studio takes (ELEVENLABS_API_KEY)
//   provider 'openai'  an OpenAI stock voice, styled by config.voice.style (OPENAI_API_KEY)
// Output: tts/<part>_<n>.mp3|wav, tts/<part>.wav, tts/<part>.marks.json, tts/<part>.words.json
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensure, parseScript, paths, spokenLines } from './project.mjs'

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()
const dur = (f) => Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]))
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const EL = 'https://api.elevenlabs.io/v1'

async function cloneVoice(p, key) {
  const idFile = join(p.tts, 'eleven_voice_id.txt')
  if (existsSync(idFile)) return readFileSync(idFile, 'utf8').trim()
  const takes = ['part1', 'part2', 'part3', 'part4'].map((x) => join(p.voice, `${x}.webm`)).filter(existsSync)
  if (!takes.length) throw new Error('Cloning needs your voice: record at least one part in "vfd studio" first.')
  const form = new FormData()
  form.append('name', process.env.CLONE_NAME ?? 'My voice (voice-first-demo)')
  form.append('remove_background_noise', 'true')
  for (const [i, f] of takes.entries()) {
    const mp3 = join(p.tts, `sample_${i}.mp3`)
    sh('ffmpeg', ['-loglevel', 'error', '-y', '-i', f, '-ac', '1', '-ar', '44100', '-b:a', '192k', mp3])
    form.append('files', new Blob([readFileSync(mp3)], { type: 'audio/mpeg' }), `take${i}.mp3`)
  }
  const r = await fetch(`${EL}/voices/add`, { method: 'POST', headers: { 'xi-api-key': key }, body: form })
  const j = await r.json()
  if (!r.ok) throw new Error(`ElevenLabs clone failed (${r.status}): ${JSON.stringify(j).slice(0, 300)}. Instant cloning needs a paid plan and a key with Voices: write.`)
  writeFileSync(idFile, j.voice_id)
  console.log(`cloned your voice on ElevenLabs (voice id ${j.voice_id})`)
  return j.voice_id
}

// Character alignment → words with start times (delivery tags like [pause] are dropped).
function alignWords(al) {
  const out = []; let cur = '', start = null
  const flush = () => { const w = cur.trim(); if (w && !/^\[.*\]$/.test(w)) out.push({ w, t: start }); cur = ''; start = null }
  al.characters.forEach((ch, i) => { if (/\s/.test(ch)) return flush(); if (start === null) start = al.character_start_times_seconds[i]; cur += ch })
  flush(); return out
}

async function elevenClip(text, file, voiceId, cfg, key) {
  const body = cfg.elevenModel === 'eleven_v3'
    ? { text, model_id: cfg.elevenModel, voice_settings: { stability: 0.3, similarity_boost: 0.95 } }
    : { text, model_id: cfg.elevenModel, voice_settings: { stability: 0.45, similarity_boost: 0.9, style: 0.15, use_speaker_boost: true, speed: 0.95 } }
  const r = await fetch(`${EL}/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`ElevenLabs speech failed (${r.status}): ${(await r.text()).slice(0, 300)}`)
  const j = await r.json()
  writeFileSync(file, Buffer.from(j.audio_base64, 'base64'))
  const al = j.alignment ?? j.normalized_alignment
  return al ? alignWords(al) : null
}

async function openaiClip(text, file, cfg, key) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: cfg.openaiVoice, input: text, instructions: cfg.style, response_format: 'wav' }) })
  if (!r.ok) throw new Error(`OpenAI speech failed (${r.status}): ${(await r.text()).slice(0, 300)}`)
  writeFileSync(file, Buffer.from(await r.arrayBuffer()))
  return null
}

// Word timings for a clip without alignment: OpenAI Whisper, else ElevenLabs speech-to-text.
async function transcribe(file) {
  const blob = new Blob([readFileSync(file)]), name = file.endsWith('.wav') ? 'clip.wav' : 'clip.mp3'
  if (process.env.OPENAI_API_KEY) {
    const form = new FormData()
    form.append('model', 'whisper-1'); form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'word'); form.append('file', blob, name)
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form })
    if (r.ok) return (await r.json()).words.map((x) => ({ w: x.word, t: x.start }))
  }
  if (process.env.ELEVENLABS_API_KEY) {
    const form = new FormData(); form.append('model_id', 'scribe_v1'); form.append('file', blob, name)
    const r = await fetch(`${EL}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, body: form })
    if (r.ok) return (await r.json()).words.filter((x) => x.type === 'word').map((x) => ({ w: x.text, t: x.start }))
  }
  throw new Error('No word timings: set OPENAI_API_KEY (Whisper) or give the ElevenLabs key Speech to Text access.')
}

export async function generateVoice({ dir, config }) {
  const p = paths(dir), cfg = config.voice
  const provider = cfg.provider
  if (provider === 'own') return console.log('voice.provider is "own": your studio recording is the narration, nothing to generate.')
  const key = provider === 'eleven' ? process.env.ELEVENLABS_API_KEY : process.env.OPENAI_API_KEY
  if (!key) throw new Error(`${provider === 'eleven' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY'} is not set (put it in demo/.env).`)
  ensure(p.tts)
  const parts = parseScript(p.script), lines = spokenLines(p, parts)
  const voiceId = provider === 'eleven' ? await cloneVoice(p, key) : null
  const manFile = join(p.tts, 'manifest.json')
  const man = existsSync(manFile) ? JSON.parse(readFileSync(manFile, 'utf8')) : {}
  const ext = provider === 'eleven' ? 'mp3' : 'wav'

  for (const part of parts) {
    const starts = [], all = [], inputs = [], filters = []
    let t = 0
    for (const [i, text] of lines[part.id].entries()) {
      const clip = join(p.tts, `${part.id}_${i}.${ext}`), wordsFile = clip.replace(/\.\w+$/, '.words.json')
      const sig = hash([provider, cfg.elevenModel, cfg.openaiVoice, cfg.style, voiceId, text].join('|'))
      if (man[clip] !== sig || !existsSync(clip) || !existsSync(wordsFile)) {
        const aligned = provider === 'eleven' ? await elevenClip(text, clip, voiceId, cfg, key) : await openaiClip(text, clip, cfg, key)
        writeFileSync(wordsFile, JSON.stringify(aligned ?? (await transcribe(clip))))
        man[clip] = sig; writeFileSync(manFile, JSON.stringify(man, null, 2))
        console.log(`  ${part.id} §${i + 1} spoken`)
      }
      starts.push(+t.toFixed(2))
      for (const x of JSON.parse(readFileSync(wordsFile, 'utf8'))) all.push({ s: i, w: x.w, t: +(t + x.t).toFixed(2) })
      const d = dur(clip) + cfg.gap
      inputs.push('-i', clip); filters.push(`[${i}:a]aresample=48000,apad,atrim=duration=${d}[a${i}]`)
      t += d
    }
    const n = lines[part.id].length
    sh('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex',
      filters.join(';') + ';' + Array.from({ length: n }, (_, i) => `[a${i}]`).join('') + `concat=n=${n}:v=0:a=1,loudnorm=I=-16:TP=-1.5[out]`,
      '-map', '[out]', '-ar', '48000', join(p.tts, `${part.id}.wav`)])
    writeFileSync(join(p.tts, `${part.id}.marks.json`), JSON.stringify({ starts, total: +t.toFixed(2) }))
    writeFileSync(join(p.tts, `${part.id}.words.json`), JSON.stringify(all))
    console.log(`${part.id}: ${n} lines, ${t.toFixed(0)}s, ${all.length} timed words → tts/${part.id}.wav`)
  }
}
