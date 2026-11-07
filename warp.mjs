// Lines each on-screen action up with the word that mentions it, by warping the screen video piece by piece.
//   node warp.mjs part1 [part2 ...]   → final/<part>-synced.mp4 (voice-el/<part>.wav + out/<part>.mp4 + anchors)
// Between two anchors the clip is sped up or slowed down so the next action starts exactly on its word.
// Speed-ups are capped at 3x (page loads and typing hide it well); slow-downs past 2x become a hold instead.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
const sh = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]).toString())
for (const part of process.argv.slice(2)) {
  const vlen = dur(`out/${part}.mp4`), alen = dur(`voice-el/${part}.wav`)
  const raw = existsSync(`out/${part}.anchors.json`) ? JSON.parse(readFileSync(`out/${part}.anchors.json`, 'utf8')) : []
  const pts = [{ v: 0, a: 0 }]
  for (const x of raw) { const last = pts[pts.length - 1]; if (x.v > last.v + 0.05 && x.a > last.a + 0.05) pts.push(x) }
  pts.push({ v: vlen, a: Math.max(alen, pts[pts.length - 1].a + 0.5) })
  const parts = [], labels = []
  for (let k = 0; k + 1 < pts.length; k++) {
    const sv = pts[k + 1].v - pts[k].v, sa = pts[k + 1].a - pts[k].a
    let f = sa / sv
    const speed = Math.max(1 / 3, Math.min(2, f)) // played-length factor actually applied
    const pad = Math.max(0, sa - sv * speed)       // if still short, hold the last frame
    parts.push(`[0:v]trim=start=${pts[k].v}:end=${pts[k + 1].v},setpts=(PTS-STARTPTS)*${speed},tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)},trim=duration=${sa.toFixed(3)},setpts=PTS-STARTPTS[s${k}]`)
    labels.push(`[s${k}]`)
  }
  const graph = parts.join(';') + `;${labels.join('')}concat=n=${labels.length}:v=1:a=0,fps=25,format=yuv420p[v]`
  sh(['-i', `out/${part}.mp4`, '-i', `voice-el/${part}.wav`, '-filter_complex', graph, '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-crf', '19', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest', `final/${part}-synced.mp4`])
  console.log(`${part}: ${pts.length - 2} actions aligned → final/${part}-synced.mp4 (${dur(`final/${part}-synced.mp4`).toFixed(0)}s)`)
}
