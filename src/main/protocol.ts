// Sicherer Medienzugriff für den Renderer über das eigene Schema ppm://
// Der Renderer übergibt ausschließlich Medien-IDs; Pfade werden im Main-Prozess aus der Datenbank gelesen.
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { BROWSER_NATIVE_IMAGE } from '@shared/media-kinds'
import type { AppService } from './services/app-service'

export const SCHEME = 'ppm'

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } }
  ])
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  wmv: 'video/x-ms-wmv',
  '3gp': 'video/3gpp'
}

function notFound(): Response {
  return new Response('not found', { status: 404 })
}

async function serveFile(file: string, req: Request, contentType: string, cache = false): Promise<Response> {
  let st: fs.Stats
  try {
    st = await fs.promises.stat(file)
  } catch {
    return notFound()
  }
  const size = st.size
  const headers: Record<string, string> = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' }
  if (cache) headers['Cache-Control'] = 'max-age=31536000, immutable'
  const range = req.headers.get('range')
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : NaN
      let end = m[2] ? parseInt(m[2], 10) : NaN
      if (Number.isNaN(start)) {
        start = Math.max(0, size - (Number.isNaN(end) ? 0 : end))
        end = size - 1
      }
      if (Number.isNaN(end) || end >= size) end = size - 1
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const stream = fs.createReadStream(file, { start, end })
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
      })
    }
  }
  const stream = fs.createReadStream(file)
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
}

export function registerProtocol(svc: () => AppService | null): void {
  protocol.handle(SCHEME, async (req) => {
    const s = svc()
    if (!s) return notFound()
    let url: URL
    try {
      url = new URL(req.url)
    } catch {
      return notFound()
    }
    const id = Number(url.pathname.replace(/^\//, ''))
    if (!Number.isInteger(id) || id <= 0) return notFound()
    const m = s.mediaPath(id)
    if (!m || m.location === 'missing') return notFound()
    switch (url.host) {
      case 'thumb': {
        const f = await s.media.getThumb(id, true)
        if (f) return serveFile(f, req, 'image/webp', true)
        // Rückfall: Browser-native Formate (z. B. BMP) direkt anzeigen
        if (m.kind === 'image' && BROWSER_NATIVE_IMAGE.has(m.ext)) return serveFile(m.path, req, MIME[m.ext] ?? 'application/octet-stream')
        return notFound()
      }
      case 'preview': {
        if (s.media.needsPreview(m)) {
          const f = await s.media.getPreview(id)
          return f ? serveFile(f, req, 'image/jpeg', true) : notFound()
        }
        if (m.kind === 'video') {
          const f = await s.media.getThumb(id, true)
          return f ? serveFile(f, req, 'image/webp', true) : notFound()
        }
        return serveFile(m.path, req, MIME[m.ext] ?? 'application/octet-stream')
      }
      case 'media':
        return serveFile(m.path, req, MIME[m.ext] ?? 'application/octet-stream')
      default:
        return notFound()
    }
  })
}
