// Puts the narration on the screen video and joins all parts into final/demo.mp4.
//   own voice:   your studio recording over each part (scenes were paced to it while recording)
//   generated:   the video is re-timed piece by piece so every logged action starts on its word
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ensure, parseScript, paths } from './project.mjs'

const ff = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]).toString())
const ENC = ['-c:v', 'libx264', '-crf', '19', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']

// Between two anchors: speed up (max 3x, hides page loads and typing) or slow down (max 2x, then hold a frame).
function warpGraph(vlen, alen, raw) {
  const pts = [{ v: 0, a: 0 }]
  for (const x of raw) { const l = pts[pts.length - 1]; if (x.v > l.v + 0.05 && x.a > l.a + 0.05) pts.push(x) }
  pts.push({ v: vlen, a: Math.max(alen, pts[pts.length - 1].a + 0.5) })
  const segs = [], labels = []
  for (let k = 0; k + 1 < pts.length; k++) {
    const sv = pts[k + 1].v - pts[k].v, sa = pts[k + 1].a - pts[k].a
    const speed = Math.max(1 / 3, Math.min(2, sa / sv)), pad = Math.max(0, sa - sv * speed)
    segs.push(`[0:v]trim=start=${pts[k].v}:end=${pts[k + 1].v},setpts=(PTS-STARTPTS)*${speed},tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)},trim=duration=${sa.toFixed(3)},setpts=PTS-STARTPTS[s${k}]`)
    labels.push(`[s${k}]`)
  }
  return { graph: segs.join(';') + `;${labels.join('')}concat=n=${labels.length}:v=1:a=0,fps=25,format=yuv420p[v]`, aligned: pts.length - 2 }
}

export function render({ dir, config }) {
  const p = paths(dir), own = config.voice.provider === 'own'
  ensure(p.final)
  const outs = []
  for (const part of parseScript(p.script)) {
    const video = join(p.out, `${part.id}.mp4`), out = join(p.final, `${part.id}.mp4`)
    if (!existsSync(video)) throw new Error(`Missing ${video}: run "vfd record" first.`)
    if (own) {
      const voice = join(p.voice, `${part.id}.webm`)
      if (!existsSync(voice)) throw new Error(`Missing ${voice}: record it in "vfd studio".`)
      ff(['-i', video, '-i', voice, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5,apad',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', out])
      console.log(`${part.id}: your voice over the screen → ${out}`)
    } else {
      const voice = join(p.tts, `${part.id}.wav`), anchorsFile = join(p.out, `${part.id}.anchors.json`)
      if (!existsSync(voice)) throw new Error(`Missing ${voice}: run "vfd voice" first.`)
      const anchors = existsSync(anchorsFile) ? JSON.parse(readFileSync(anchorsFile, 'utf8')) : []
      if (!anchors.length) console.log(`${part.id}: no word anchors (record with "vfd record --synced" for word-exact timing)`)
      const { graph, aligned } = warpGraph(dur(video), dur(voice), anchors)
      ff(['-i', video, '-i', voice, '-filter_complex', graph, '-map', '[v]', '-map', '1:a', ...ENC, '-shortest', out])
      console.log(`${part.id}: ${aligned} actions lined up with their words → ${out}`)
    }
    outs.push(out)
  }
  const list = join(p.final, 'list.txt')
  writeFileSync(list, outs.map((o) => `file '${o.replace(/'/g, "'\\''")}'`).join('\n'))
  const demo = join(p.final, 'demo.mp4')
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', demo])
  unlinkSync(list)
  console.log(`\n✓ ${demo} (${Math.round(dur(demo))}s)`)
  return demo
}
