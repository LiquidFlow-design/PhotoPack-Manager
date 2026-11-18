// Vorschauen und Metadaten: Sharp (Bilder), ExifTool (RAW-Vorschauen, Aufnahmedatum), FFmpeg/ffprobe (Video).
// Fehlende oder defekte Decoder blockieren die App nicht: Fehler werden pro Medium vermerkt.
import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BROWSER_NATIVE_IMAGE } from '@shared/media-kinds'
import type { CoreContext } from '../core/context'

type Sharp = typeof import('sharp').default
type ExifToolT = import('exiftool-vendored').ExifTool

export interface ToolPaths {
  ffmpeg: string | null
  ffprobe: string | null
}

export interface ToolStatus {
  sharp: boolean
  exiftool: boolean
  ffmpeg: boolean
  ffprobe: boolean
}

interface MediaInfo {
  id: number
  project_id: string
  current_path: string
  location: string
  kind: 'image' | 'raw' | 'video'
  ext: string
  size: number
  mtime_ms: number
  meta_status: string
  thumb_status: string
}

export const THUMB_PX = 400
export const PREVIEW_PX = 2560
const CACHE_VERSION = 'v1'

function asarUnpacked(p: string | null): string | null {
  if (!p) return null
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

export function resolveToolPaths(): ToolPaths {
  let ffmpeg: string | null = null
  let ffprobe: string | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ffmpeg = asarUnpacked(require('ffmpeg-static') as string)
  } catch {
    ffmpeg = null
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ffprobe = asarUnpacked((require('ffprobe-static') as { path: string }).path)
  } catch {
    ffprobe = null
  }
  if (ffmpeg && !fs.existsSync(ffmpeg)) ffmpeg = null
  if (ffprobe && !fs.existsSync(ffprobe)) ffprobe = null
  return { ffmpeg, ffprobe }
}

interface QueueTask {
  mediaId: number
  kind: 'thumb' | 'preview'
  resolve: (r: string | null) => void
}

export class MediaProcessor {
  private sharp: Sharp | null = null
  private exiftool: ExifToolT | null = null
  private exiftoolFailed = false
  private queue: QueueTask[] = []
  private inflight = new Map<string, Promise<string | null>>()
  private active = 0
  private background = new Map<string, { running: boolean; stop: boolean }>()
  private closed = false

  constructor(
    private ctx: CoreContext,
    private cacheDir: string,
    private tools: ToolPaths,
    private concurrency = 3
  ) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.sharp = require('sharp') as Sharp
      this.sharp.cache(false)
      this.sharp.concurrency(1)
    } catch {
      this.sharp = null
    }
  }

  status(): ToolStatus {
    return { sharp: !!this.sharp, exiftool: !this.exiftoolFailed, ffmpeg: !!this.tools.ffmpeg, ffprobe: !!this.tools.ffprobe }
  }

  private async getExiftool(): Promise<ExifToolT | null> {
    if (this.exiftool) return this.exiftool
    if (this.exiftoolFailed) return null
    try {
      const { ExifTool } = await import('exiftool-vendored')
      this.exiftool = new ExifTool({ maxProcs: 2, taskTimeoutMillis: 20000 })
      return this.exiftool
    } catch {
      this.exiftoolFailed = true
      return null
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const b of this.background.values()) b.stop = true
    if (this.exiftool) await this.exiftool.end().catch(() => {})
  }

  private media(id: number): MediaInfo | null {
    return (
      (this.ctx.db
        .prepare('SELECT id, project_id, current_path, location, kind, ext, size, mtime_ms, meta_status, thumb_status FROM media WHERE id = ?')
        .get(id) as MediaInfo | undefined) ?? null
    )
  }

  private cacheFile(m: MediaInfo, kind: 'thumb' | 'preview'): string {
    const key = crypto.createHash('sha1').update(`${CACHE_VERSION}|${m.id}|${m.size}|${m.mtime_ms}|${m.ext}`).digest('hex')
    return path.join(this.cacheDir, kind === 'thumb' ? 'thumbs' : 'previews', key.slice(0, 2), key + (kind === 'thumb' ? '.webp' : '.jpg'))
  }

  /** Liefert den Pfad einer Datei für die Großansicht; Browser-native Formate direkt das Original. */
  needsPreview(m: { kind: string; ext: string }): boolean {
    return m.kind === 'raw' || (m.kind === 'image' && !BROWSER_NATIVE_IMAGE.has(m.ext))
  }

  /** Vorschaubild (Raster). priority=true stellt die Anfrage vor Hintergrundaufgaben. */
  getThumb(mediaId: number, priority = true): Promise<string | null> {
    return this.request(mediaId, 'thumb', priority)
  }

  getPreview(mediaId: number): Promise<string | null> {
    return this.request(mediaId, 'preview', true)
  }

  private request(mediaId: number, kind: 'thumb' | 'preview', priority: boolean): Promise<string | null> {
    const m = this.media(mediaId)
    if (!m || m.location === 'missing') return Promise.resolve(null)
    const file = this.cacheFile(m, kind)
    if (fs.existsSync(file)) return Promise.resolve(file)
    const k = `${kind}:${mediaId}`
    const existing = this.inflight.get(k)
    if (existing) return existing
    const p = new Promise<string | null>((resolve) => {
      const task = { mediaId, kind, resolve }
      if (priority) this.queue.unshift(task)
      else this.queue.push(task)
    })
    this.inflight.set(k, p)
    void p.finally(() => this.inflight.delete(k))
    this.drain()
    return p
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const t = this.queue.shift()!
      this.active++
      void this.process(t)
        .then(t.resolve, () => t.resolve(null))
        .finally(() => {
          this.active--
          this.drain()
        })
    }
  }

  private async process(t: QueueTask): Promise<string | null> {
    const m = this.media(t.mediaId)
    if (!m || m.location === 'missing') return null
    const out = this.cacheFile(m, t.kind)
    if (fs.existsSync(out)) return out
    await fs.promises.mkdir(path.dirname(out), { recursive: true })
    try {
      if (m.meta_status === 'none') await this.extractMeta(m).catch(() => {})
      const buf = await this.render(m, t.kind === 'thumb' ? THUMB_PX : PREVIEW_PX, t.kind)
      if (!buf) throw new Error('Keine Vorschau verfügbar')
      const tmp = out + '.' + process.pid + '.part'
      await fs.promises.writeFile(tmp, buf)
      await fs.promises.rename(tmp, out)
      if (t.kind === 'thumb') this.setThumb(m, 'ok', null)
      return out
    } catch (e) {
      if (t.kind === 'thumb') this.setThumb(m, 'error', shortError(e))
      return null
    }
  }

  private setThumb(m: MediaInfo, status: 'ok' | 'error', err: string | null): void {
    this.ctx.db.prepare('UPDATE media SET thumb_status = ?, thumb_error = ? WHERE id = ?').run(status, err, m.id)
    this.ctx.emit({ type: 'thumb-ready', projectId: m.project_id, mediaId: m.id, ok: status === 'ok' })
  }

  private async render(m: MediaInfo, px: number, kind: 'thumb' | 'preview'): Promise<Buffer | null> {
    const sharp = this.sharp
    if (!sharp) throw new Error('Bildbibliothek (sharp) nicht verfügbar')
    let input: Buffer | string = m.current_path
    if (m.kind === 'raw') {
      const b = await this.rawPreview(m.current_path)
      if (!b) throw new Error('RAW ohne eingebettete Vorschau')
      input = b
    } else if (m.kind === 'video') {
      const b = await this.videoFrame(m.current_path, kind === 'thumb' ? 640 : 1920)
      if (!b) throw new Error('Videovorschau nicht möglich (Codec?)')
      input = b
    }
    const img = sharp(input, { failOn: 'none', limitInputPixels: 400_000_000, sequentialRead: true }).rotate()
    const resized = img.resize(px, px, { fit: 'inside', withoutEnlargement: true })
    return kind === 'thumb' ? resized.webp({ quality: 78, effort: 2 }).toBuffer() : resized.jpeg({ quality: 86, mozjpeg: false }).toBuffer()
  }

  private async rawPreview(file: string): Promise<Buffer | null> {
    const et = await this.getExiftool()
    if (!et) return null
    for (const tag of ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'ThumbnailImage'] as const) {
      try {
        const buf = await et.extractBinaryTagToBuffer(tag, file)
        if (buf && buf.length > 1000) {
          // Ausrichtung der RAW-Datei auf die eingebettete Vorschau anwenden
          const tags = (await et.read(file, { readArgs: ['-Orientation#', '-fast'] }).catch(() => null)) as { Orientation?: number } | null
          const o = typeof tags?.Orientation === 'number' ? tags.Orientation : 1
          if (o > 1 && this.sharp) {
            return await this.sharp(buf).withMetadata({ orientation: o }).jpeg().toBuffer()
          }
          return buf
        }
      } catch {
        /* nächstes Tag versuchen */
      }
    }
    return null
  }

  private videoFrame(file: string, width: number): Promise<Buffer | null> {
    const ff = this.tools.ffmpeg
    if (!ff) return Promise.resolve(null)
    const m = this.ctx.db.prepare('SELECT duration_ms FROM media WHERE current_path = ?').get(file) as { duration_ms: number | null } | undefined
    const at = m?.duration_ms ? Math.min(m.duration_ms / 1000 / 10, 5) : 0.5
    return new Promise((resolve) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']
      const p = spawn(ff, args, { windowsHide: true })
      const chunks: Buffer[] = []
      let size = 0
      const timer = setTimeout(() => p.kill('SIGKILL'), 20000)
      p.stdout.on('data', (c: Buffer) => {
        size += c.length
        if (size < 50_000_000) chunks.push(c)
      })
      p.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
      p.on('close', (code) => {
        clearTimeout(timer)
        resolve(code === 0 && size > 0 ? Buffer.concat(chunks) : null)
      })
    })
  }

  private probe(file: string): Promise<{ durationMs: number | null; width: number | null; height: number | null; codec: string | null; createdAt: number | null } | null> {
    const fp = this.tools.ffprobe
    if (!fp) return Promise.resolve(null)
    return new Promise((resolve) => {
      execFile(
        fp,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
        { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(null)
          try {
            const j = JSON.parse(stdout) as {
              format?: { duration?: string; tags?: Record<string, string> }
              streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }>
            }
            const v = j.streams?.find((s) => s.codec_type === 'video')
            const dur = parseFloat(j.format?.duration ?? v?.duration ?? '')
            const ct = j.format?.tags?.creation_time
            resolve({
              durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : null,
              width: v?.width ?? null,
              height: v?.height ?? null,
              codec: v?.codec_name ?? null,
              createdAt: ct ? Date.parse(ct) || null : null
            })
          } catch {
            resolve(null)
          }
        }
      )
    })
  }

  async extractMeta(m: MediaInfo): Promise<void> {
    let width: number | null = null
    let height: number | null = null
    let durationMs: number | null = null
    let codec: string | null = null
    let captured: number | null = null
    let ok = true
    try {
      if (m.kind === 'video') {
        const p = await this.probe(m.current_path)
        if (p) ({ width, height, durationMs, codec, createdAt: captured } = p)
        else ok = false
      } else {
        if (m.kind === 'image' && this.sharp) {
          const md = await this.sharp(m.current_path, { failOn: 'none' })
            .metadata()
            .catch(() => null)
          if (md) {
            const rotated = (md.orientation ?? 1) >= 5
            width = (rotated ? md.height : md.width) ?? null
            height = (rotated ? md.width : md.height) ?? null
          }
        }
        const et = await this.getExiftool()
        if (et) {
          const tags = (await et.read(m.current_path, { readArgs: ['-fast'] }).catch(() => null)) as Record<string, unknown> | null
          if (tags) {
            const dt = (tags.DateTimeOriginal ?? tags.CreateDate) as { toMillis?: () => number } | string | undefined
            if (dt && typeof dt === 'object' && typeof dt.toMillis === 'function') captured = dt.toMillis()
            if (width == null && typeof tags.ImageWidth === 'number') width = tags.ImageWidth
            if (height == null && typeof tags.ImageHeight === 'number') height = tags.ImageHeight
          }
        }
      }
    } catch {
      ok = false
    }
    this.ctx.db
      .prepare('UPDATE media SET width=COALESCE(?,width), height=COALESCE(?,height), duration_ms=COALESCE(?,duration_ms), codec=COALESCE(?,codec), captured_at=COALESCE(?,captured_at), meta_status=? WHERE id=?')
      .run(width, height, durationMs, codec, captured && Number.isFinite(captured) ? captured : null, ok ? 'ok' : 'error', m.id)
  }

  /**
   * Hintergrund-Vorverarbeitung aller Medien eines Projekts (Vorschau + Metadaten), niedrige Priorität.
   * Sichtbare Medien werden über getThumb(priority) vorgezogen.
   */
  startBackground(projectId: string, onProgress: (done: number, total: number, running: boolean) => void): void {
    const existing = this.background.get(projectId)
    if (existing?.running) return
    const state = { running: true, stop: false }
    this.background.set(projectId, state)
    void (async () => {
      const total = (this.ctx.db.prepare("SELECT COUNT(*) AS n FROM media WHERE project_id = ? AND location != 'missing'").get(projectId) as { n: number }).n
      let lastEmit = 0
      for (;;) {
        if (state.stop || this.closed) break
        const batch = this.ctx.db
          .prepare("SELECT id FROM media WHERE project_id = ? AND location != 'missing' AND thumb_status = 'none' ORDER BY id LIMIT 50")
          .all(projectId) as Array<{ id: number }>
        if (!batch.length) break
        // Hintergrund nur füllen, wenn die Vordergrund-Warteschlange leer ist
        while (this.queue.length > 2 && !state.stop) await new Promise((r) => setTimeout(r, 50))
        await Promise.all(batch.map((b) => this.getThumb(b.id, false)))
        // Fehlgeschlagene ohne Statuswechsel nicht endlos wiederholen
        this.ctx.db
          .prepare(`UPDATE media SET thumb_status='error', thumb_error=COALESCE(thumb_error,'Keine Vorschau') WHERE id IN (${batch.map(() => '?').join(',')}) AND thumb_status='none'`)
          .run(...batch.map((b) => b.id))
        const done = (this.ctx.db.prepare("SELECT COUNT(*) AS n FROM media WHERE project_id = ? AND location != 'missing' AND thumb_status != 'none'").get(projectId) as { n: number }).n
        if (Date.now() - lastEmit > 400) {
          lastEmit = Date.now()
          onProgress(done, total, true)
          this.ctx.emit({ type: 'media-changed', projectId, full: true })
        }
      }
      state.running = false
      onProgress(total, total, false)
      this.ctx.emit({ type: 'media-changed', projectId, full: true })
    })()
  }

  stopBackground(projectId: string): void {
    const s = this.background.get(projectId)
    if (s) s.stop = true
  }

  /** Cache leeren (z. B. Einstellungen). */
  async clearCache(): Promise<void> {
    await fs.promises.rm(path.join(this.cacheDir, 'thumbs'), { recursive: true, force: true })
    await fs.promises.rm(path.join(this.cacheDir, 'previews'), { recursive: true, force: true })
    this.ctx.db.prepare("UPDATE media SET thumb_status='none', thumb_error=NULL").run()
  }
}

function shortError(e: unknown): string {
  const s = (e as Error)?.message ?? String(e)
  return s.split('\n')[0].slice(0, 200)
}
