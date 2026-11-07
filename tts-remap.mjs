// Re-voices the demo with AI speech and re-times each recorded scene to its new line.
//   node tts-remap.mjs              OpenAI stock voice (OPENAI_API_KEY)
//   TTS=eleven node tts-remap.mjs   your own voice, cloned on ElevenLabs from voice/part*.webm (ELEVENLABS_API_KEY)
// Reads script.md (or spoken-lines.json for ElevenLabs), out/part*.mp4 + cues.
// For every script section: generate speech, then take that section's video clip, slow it or
// speed it up (within limits) and hold the last frame if needed so picture and voice match exactly.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// TTS=eleven uses an ElevenLabs instant clone of your own voice (from voice/part*.webm); default is OpenAI.
const ELEVEN = process.env.TTS === 'eleven'
const KEY = ELEVEN ? process.env.ELEVENLABS_API_KEY : process.env.OPENAI_API_KEY
if (!KEY) { console.error(ELEVEN ? 'ELEVENLABS_API_KEY missing' : 'OPENAI_API_KEY missing'); process.exit(1) }
const TAG = ELEVEN ? 'el_' : ''
const OUTFILE = ELEVEN ? 'final/demo-myvoice.mp4' : 'final/demo-tts.mp4'
const VOICE = process.env.TTS_VOICE ?? 'ash'
// OpenAI only: how the stock voice should sound. Describe yourself (accent, age, mood) for a closer match.
const STYLE = process.env.TTS_STYLE ?? 'Speak like a friendly developer showing a project to a colleague: warm, relaxed, ' +
  'conversational, natural pauses, not salesy, not robotic. Moderate pace.'
const GAP = 0.45 // breathing room after each line
mkdirSync('tts', { recursive: true }); mkdirSync('seg', { recursive: true })

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()
const dur = (f) => Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]))

// Same parsing as the voice studio: "## Part" headings, sections split by **[cue]** markers.
const parts = readFileSync('script.md', 'utf8').split(/^## /m).slice(1).map((body) => {
  const chunks = body.split(/\*\*\[(.*?)\]\*\*/)
  const out = []
  for (let i = 1; i < chunks.length; i += 2) out.push(chunks[i + 1].replace(/`/g, '').split(/\s+/).join(' ').trim())
  return out
})

// One-time ElevenLabs clone from the takes recorded in the voice studio.
let voiceId = null
async function elevenVoice() {
  const idFile = 'tts/eleven_voice_id.txt'
  if (existsSync(idFile)) return readFileSync(idFile, 'utf8').trim()
  const form = new FormData()
  form.append('name', process.env.CLONE_NAME ?? 'My voice (voice-first-demo)')
  form.append('remove_background_noise', 'true')
  for (const part of ['part1', 'part2']) {
    sh('ffmpeg', ['-loglevel', 'error', '-y', '-i', `voice/${part}.webm`, '-ac', '1', '-ar', '44100', '-b:a', '192k', `tts/sample_${part}.mp3`])
    form.append('files', new Blob([readFileSync(`tts/sample_${part}.mp3`)], { type: 'audio/mpeg' }), `${part}.mp3`)
  }
  const r = await fetch('https://api.elevenlabs.io/v1/voices/add', { method: 'POST', headers: { 'xi-api-key': KEY }, body: form })
  const j = await r.json()
  if (!r.ok) throw new Error(`ElevenLabs clone ${r.status}: ${JSON.stringify(j).slice(0, 300)}`)
  writeFileSync(idFile, j.voice_id)
  console.log('cloned your voice:', j.voice_id)
  return j.voice_id
}
async function speakEleven(text, file, prev, next) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    // v3 keeps a cloned accent and delivery better and understands [pause]-style tags; it takes no neighbour context.
    body: JSON.stringify(MODEL === 'eleven_v3'
      ? { text, model_id: MODEL, voice_settings: { stability: 0.3, similarity_boost: 0.95 } }
      : { text, model_id: MODEL, previous_text: prev, next_text: next,
          voice_settings: { stability: 0.45, similarity_boost: 0.9, style: 0.15, use_speaker_boost: true, speed: 0.9 } }),
  })
  if (!r.ok) throw new Error(`ElevenLabs TTS ${r.status}: ${(await r.text()).slice(0, 300)}`)
  writeFileSync(file, Buffer.from(await r.arrayBuffer()))
}

async function speak(text, file, prev = '', next = '') {
  if (existsSync(file)) return
  if (ELEVEN) return speakEleven(text, file, prev, next)
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: VOICE, input: text, instructions: STYLE, response_format: 'wav' }),
  })
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 300)}`)
  writeFileSync(file, Buffer.from(await r.arrayBuffer()))
}

if (ELEVEN) voiceId = await elevenVoice()
// ElevenLabs reads the "spoken" lines (fillers + v3 delivery tags) when spoken-lines.json exists.
const SPOKEN = ELEVEN && existsSync('spoken-lines.json') ? JSON.parse(readFileSync('spoken-lines.json', 'utf8')) : null
const MODEL = process.env.ELEVEN_MODEL ?? 'eleven_v3'
const list = []
for (const [pi, lines] of parts.entries()) {
  const part = `part${pi + 1}`
  const cues = JSON.parse(readFileSync(`out/${part}.cues.json`, 'utf8')).map((c) => c.at)
  const vlen = dur(`out/${part}.mp4`)
  const ext = ELEVEN ? 'mp3' : 'wav'
  if (SPOKEN) { if (SPOKEN[part].length !== lines.length) throw new Error(`spoken-lines ${part}: ${SPOKEN[part].length} vs ${lines.length} sections`); lines.splice(0, lines.length, ...SPOKEN[part]) }
  // ElevenLabs: sequential, with neighbouring lines as context so the delivery flows between sections.
  if (ELEVEN) for (const [i, t] of lines.entries()) await speak(t, `tts/${TAG}${part}_${i}.${ext}`, lines[i - 1] ?? '', lines[i + 1] ?? '')
  else await Promise.all(lines.map((t, i) => speak(t, `tts/${part}_${i}.${ext}`)))
  for (const [i] of lines.entries()) {
    const wav = `tts/${TAG}${part}_${i}.${ext}`
    const start = cues[i], end = i + 1 < cues.length ? cues[i + 1] : vlen
    const src = Math.max(0.5, end - start)
    // Never speed a scene past 0.8x (it would look rushed or lose its ending); a short line gets silence after it instead.
    const target = Math.max(dur(wav) + GAP, src * 0.8)
    const f = Math.min(1.6, Math.max(0.8, target / src)) // >1 slows the clip down, <1 speeds it up
    const out = `seg/${TAG}${part}_${i}.mp4`
    sh('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(start), '-t', String(src), '-i', `out/${part}.mp4`, '-i', wav,
      '-filter_complex', `[0:v]setpts=(PTS-STARTPTS)*${f},tpad=stop_mode=clone:stop_duration=${target},trim=duration=${target},setpts=PTS-STARTPTS,fps=25,format=yuv420p[v];` +
        `[1:a]aresample=48000,apad,atrim=duration=${target}[a]`,
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '19', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', out])
    list.push(`file '${out}'`)
    console.log(`${part} §${i + 1}: voice ${target.toFixed(1)}s, video ${src.toFixed(1)}s ×${f.toFixed(2)}`)
  }
}
writeFileSync('seg/list.txt', list.map((l) => l.replace("'seg/", "'")).join('\n'))
mkdirSync('final', { recursive: true })
sh('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'seg/list.txt', '-af', 'loudnorm=I=-16:TP=-1.5',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', OUTFILE])
console.log(`→ ${OUTFILE} (${dur(OUTFILE).toFixed(0)}s)`)
