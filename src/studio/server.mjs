// Voice studio: a local teleprompter that records your narration, one part at a time.
// Saves demo/voice/<part>.webm + <part>.marks.json (when you moved to each section). Binds to 127.0.0.1 only.
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensure, parseScript, paths } from '../project.mjs'

const HTML = fileURLToPath(new URL('./studio.html', import.meta.url))
const MAX_BYTES = 200 * 1024 * 1024

export function startStudio(dir, port = 8766) {
  const p = paths(dir)
  const send = (res, code, body, type = 'text/plain') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body)
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const partIds = () => parseScript(p.script).map((x) => x.id)
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/studio.html')) return send(res, 200, readFileSync(HTML), 'text/html; charset=utf-8')
      if (req.method === 'GET' && url.pathname === '/script.json') return send(res, 200, JSON.stringify({ parts: parseScript(p.script) }), 'application/json')
      const m = url.pathname.match(/^\/voice\/(part\d+)\.(webm|marks\.json)$/)
      if (req.method === 'GET' && m) {
        const f = join(p.voice, `${m[1]}.${m[2]}`)
        if (!existsSync(f)) return send(res, 404, 'not found')
        const data = readFileSync(f)
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
        const type = m[2] === 'webm' ? 'audio/webm' : 'application/json'
        if (range) {
          const start = Number(range[1]), end = range[2] ? Number(range[2]) : data.length - 1
          res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' })
          return res.end(data.subarray(start, end + 1))
        }
        res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }); return res.end(data)
      }
      if (req.method === 'POST' && url.pathname === '/save') {
        const part = url.searchParams.get('part'), ext = { audio: 'webm', marks: 'marks.json' }[url.searchParams.get('kind')]
        if (!partIds().includes(part) || !ext) return send(res, 400, 'bad request')
        const chunks = []; let size = 0
        req.on('data', (c) => { size += c.length; if (size > MAX_BYTES) req.destroy(); else chunks.push(c) })
        req.on('end', () => {
          writeFileSync(join(ensure(p.voice), `${part}.${ext}`), Buffer.concat(chunks))
          console.log(`saved voice/${part}.${ext} (${Math.round(size / 1024)} KiB)`)
          send(res, 200, 'ok')
        })
        return
      }
      send(res, 404, 'not found')
    } catch (e) { send(res, 500, String(e.message)) }
  })
  server.listen(port, '127.0.0.1', () => console.log(`Voice studio on http://localhost:${port}  (Ctrl-C to stop)`))
  return server
}
