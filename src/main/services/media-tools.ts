// Vorschauen und Metadaten: Sharp (Bilder), ExifTool (RAW-Vorschauen, Aufnahmedatum), FFmpeg/ffprobe (Video).
// Fehlende oder defekte Decoder blockieren die App nicht: Fehler werden pro Medium vermerkt.
import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BROWSER_NATIVE_IMAGE } from '@shared/media-kinds'
import type { CoreContext } from '../core/context'
import { dhashFromPixels } from '../core/similar'

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
  cloud_state: string
}

/** Begrenzt die Laufzeit externer Decoder – ein hängendes Werkzeug darf nichts blockieren. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: Zeitüberschreitung nach ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}


export const THUMB_PX = 400
export const PREVIEW_PX = 2560
const CACHE_VERSION = 'v1'

function asarUnpacked(p: string | null): string | null {
  if (!p) return null
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

/**
 * Reihenfolge: Umgebungsvariablen → mitgeliefertes LGPL-FFmpeg (resources/ffmpeg) → vendor/ffmpeg (Entwicklung,
 * per scripts/fetch-ffmpeg-lgpl.mjs) → ffmpeg-static/ffprobe-static (nur Entwicklung/Tests, nicht ausgeliefert).
 */
export function resolveToolPaths(): ToolPaths {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const dirs: string[] = []
  const rp = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (rp) dirs.push(path.join(rp, 'ffmpeg'))
  dirs.push(path.resolve(__dirname, '../../vendor/ffmpeg', `${process.platform}-${process.arch}`, 'bin'))
  dirs.push(path.resolve(process.cwd(), 'vendor/ffmpeg', `${process.platform}-${process.arch}`, 'bin'))
  const find = (envVar: string, name: string, fallback: () => string | null): string | null => {
    const env = process.env[envVar]
    if (env && fs.existsSync(env)) return env
    for (const d of dirs) {
      const f = path.join(d, name + exe)
      if (fs.existsSync(f)) return f
    }
    try {
      const f = asarUnpacked(fallback())
      return f && fs.existsSync(f) ? f : null
    } catch {
      return null
    }
  }
  return {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ffmpeg: find('PPM_FFMPEG', 'ffmpeg', () => require('ffmpeg-static') as string),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ffprobe: find('PPM_FFPROBE', 'ffprobe', () => (require('ffprobe-static') as { path: string }).path)
  }
}

/** HEIC/HEIF unter Windows über die Windows-Bildkomponente (WIC, „HEIF-Bilderweiterungen“) in JPEG wandeln. */
export function wicToJpeg(file: string, maxPx: number, timeoutMs = 30000): Promise<Buffer | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const out = path.join(path.dirname(file), '.ppm-wic-' + crypto.randomUUID() + '.jpg')
  const tmpOut = path.join(require('node:os').tmpdir(), path.basename(out))
  const script = [
    'Add-Type -AssemblyName PresentationCore',
    '$s=[IO.File]::OpenRead($env:PPM_IN)',
    'try {',
    '$d=[Windows.Media.Imaging.BitmapDecoder]::Create($s,[Windows.Media.Imaging.BitmapCreateOptions]::None,[Windows.Media.Imaging.BitmapCacheOption]::OnLoad)',
    '$f=$d.Frames[0]',
    '$m=[double]$env:PPM_MAX',
    '$k=[Math]::Min(1.0, $m / [Math]::Max($f.PixelWidth,$f.PixelHeight))',
    '$t=New-Object Windows.Media.Imaging.TransformedBitmap($f,(New-Object Windows.Media.ScaleTransform($k,$k)))',
    '$e=New-Object Windows.Media.Imaging.JpegBitmapEncoder; $e.QualityLevel=88',
    '$e.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($t))',
    '$o=[IO.File]::Create($env:PPM_OUT); $e.Save($o); $o.Close()',
    '} finally { $s.Close() }'
  ].join('; ')
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, env: { ...process.env, PPM_IN: file, PPM_OUT: tmpOut, PPM_MAX: String(maxPx) } },
      (err) => {
        let buf: Buffer | null = null
        try {
          if (!err) buf = fs.readFileSync(tmpOut)
        } catch {
          buf = null
        }
        fs.rm(tmpOut, { force: true }, () => resolve(buf && buf.length > 0 ? buf : null))
      }
    )
  })
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
  private exiftoolErrors = 0
  private queue: QueueTask[] = []
  private inflight = new Map<string, Promise<string | null>>()
  private active = 0
  private background = new Map<string, { running: boolean; stop: boolean }>()
  private closed = false

  constructor(
    private ctx: CoreContext,
    private cacheDir: string,
    private tools: ToolPaths,
    private concurrency = 3,
    private exiftoolTimeout = 15000
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
      this.exiftool = new ExifTool({ maxProcs: 2, taskTimeoutMillis: this.exiftoolTimeout, maxTasksPerProcess: 2000 })
      // Erreichbarkeit prüfen; schlägt dies fehl, wird ExifTool für diese Sitzung deaktiviert
      await withTimeout(this.exiftool.version(), this.exiftoolTimeout, 'ExifTool')
      return this.exiftool
    } catch {
      this.disableExiftool()
      return null
    }
  }

  /** ExifTool-Aufruf mit Zeitlimit; wiederholte Fehler deaktivieren das Werkzeug (Rest der App läuft weiter). */
  private async et<T>(fn: (et: ExifToolT) => Promise<T>): Promise<T | null> {
    const et = await this.getExiftool()
    if (!et) return null
    try {
      const r = await withTimeout(fn(et), this.exiftoolTimeout, 'ExifTool')
      this.exiftoolErrors = 0
      return r
    } catch (e) {
      if (/Zeitüberschreitung|ENOENT|spawn|EACCES/.test(String((e as Error)?.message))) {
        if (++this.exiftoolErrors >= 3) this.disableExiftool()
      }
      return null
    }
  }

  private disableExiftool(): void {
    this.exiftoolFailed = true
    const et = this.exiftool
    this.exiftool = null
    if (et) void et.end().catch(() => {})
  }

  async close(): Promise<void> {
    this.closed = true
    for (const b of this.background.values()) b.stop = true
    if (this.exiftool) await this.exiftool.end().catch(() => {})
  }

  private media(id: number): MediaInfo | null {
    return (
      (this.ctx.db
        .prepare('SELECT id, project_id, current_path, location, kind, ext, size, mtime_ms, meta_status, thumb_status, cloud_state FROM media WHERE id = ?')
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
  /** allowOnline=false: Dateien, die nur online im Cloud-Speicher liegen, werden nicht heruntergeladen. */
  getThumb(mediaId: number, priority = true, allowOnline = false): Promise<string | null> {
    return this.request(mediaId, 'thumb', priority, allowOnline)
  }

  getPreview(mediaId: number, allowOnline = false): Promise<string | null> {
    return this.request(mediaId, 'preview', true, allowOnline)
  }

  private request(mediaId: number, kind: 'thumb' | 'preview', priority: boolean, allowOnline = false): Promise<string | null> {
    const m = this.media(mediaId)
    if (!m || m.location === 'missing') return Promise.resolve(null)
    const file = this.cacheFile(m, kind)
    if (fs.existsSync(file)) return Promise.resolve(file)
    if (m.cloud_state === 'online' && !allowOnline) return Promise.resolve(null)
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
      // Videos: Dauer vorab (für die Wahl des Vorschaubildes); sonst Metadaten nach der Vorschau
      if (m.kind === 'video' && m.meta_status === 'none') await withTimeout(this.extractMeta(m), 20000, 'Metadaten').catch(() => {})
      const buf = await withTimeout(this.render(m, t.kind === 'thumb' ? THUMB_PX : PREVIEW_PX, t.kind), 60000, 'Vorschau')
      if (m.kind !== 'video' && m.meta_status === 'none') await withTimeout(this.extractMeta(m), 20000, 'Metadaten').catch(() => {})
      if (!buf) throw new Error('Keine Vorschau verfügbar')
      const tmp = out + '.' + process.pid + '.part'
      await fs.promises.writeFile(tmp, buf)
      await fs.promises.rename(tmp, out)
      if (t.kind === 'thumb') {
        await this.storePhash(m.id, buf).catch(() => {})
        this.setThumb(m, 'ok', null)
      }
      return out
    } catch (e) {
      if (t.kind === 'thumb') this.setThumb(m, 'error', shortError(e))
      return null
    }
  }

  private async storePhash(id: number, image: Buffer | string): Promise<void> {
    if (!this.sharp) return
    const px = await this.sharp(image).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer()
    this.ctx.db.prepare('UPDATE media SET phash = ? WHERE id = ?').run(dhashFromPixels(px), id)
  }

  /** Wahrnehmungs-Hash sicherstellen (aus vorhandenem Vorschau-Cache oder durch Erzeugen der Vorschau). */
  async ensurePhash(mediaId: number): Promise<void> {
    const m = this.media(mediaId)
    if (!m || m.location === 'missing') return
    const file = this.cacheFile(m, 'thumb')
    if (fs.existsSync(file)) await this.storePhash(mediaId, file)
    else await this.getThumb(mediaId, false)
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
    } else if (m.ext === 'heic' || m.ext === 'heif') {
      // sharp enthält keinen HEVC-Decoder -> unter Windows über WIC
      const b = await wicToJpeg(m.current_path, px)
      if (!b) throw new Error('HEIC-Vorschau nicht möglich (Windows-HEIF-Erweiterung installiert?)')
      input = b
    }
    const img = sharp(input, { failOn: 'none', limitInputPixels: 400_000_000, sequentialRead: true }).rotate()
    const resized = img.resize(px, px, { fit: 'inside', withoutEnlargement: true })
    return kind === 'thumb' ? resized.webp({ quality: 78, effort: 2 }).toBuffer() : resized.jpeg({ quality: 86, mozjpeg: false }).toBuffer()
  }

  private async rawPreview(file: string): Promise<Buffer | null> {
    for (const tag of ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'ThumbnailImage'] as const) {
      const buf = await this.et((et) => et.extractBinaryTagToBuffer(tag, file))
      if (buf && buf.length > 1000) {
        // Ausrichtung der RAW-Datei auf die eingebettete Vorschau anwenden
        const tags = (await this.et((et) => et.read(file, { readArgs: ['-Orientation#', '-fast'] }))) as { Orientation?: number } | null
        const o = typeof tags?.Orientation === 'number' ? tags.Orientation : 1
        if (o > 1 && this.sharp) return await this.sharp(buf).withMetadata({ orientation: o }).jpeg().toBuffer()
        return buf
      }
      if (this.exiftoolFailed) break
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
        {
          const tags = (await this.et((et) => et.read(m.current_path, { readArgs: ['-fast'] }))) as Record<string, unknown> | null
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
      const total = (this.ctx.db.prepare("SELECT COUNT(*) AS n FROM media WHERE project_id = ? AND role = 'main' AND location != 'missing' AND cloud_state = 'local'").get(projectId) as { n: number }).n
      let lastEmit = 0
      for (;;) {
        if (state.stop || this.closed) break
        const batch = this.ctx.db
          .prepare("SELECT id FROM media WHERE project_id = ? AND role = 'main' AND location != 'missing' AND thumb_status = 'none' AND cloud_state = 'local' ORDER BY id LIMIT 50")
          .all(projectId) as Array<{ id: number }>
        if (!batch.length) break
        // Hintergrund nur füllen, wenn die Vordergrund-Warteschlange leer ist
        while (this.queue.length > 2 && !state.stop) await new Promise((r) => setTimeout(r, 50))
        await Promise.all(batch.map((b) => this.getThumb(b.id, false)))
        // Fehlgeschlagene ohne Statuswechsel nicht endlos wiederholen
        this.ctx.db
          .prepare(`UPDATE media SET thumb_status='error', thumb_error=COALESCE(thumb_error,'Keine Vorschau') WHERE id IN (${batch.map(() => '?').join(',')}) AND thumb_status='none'`)
          .run(...batch.map((b) => b.id))
        const done = (this.ctx.db.prepare("SELECT COUNT(*) AS n FROM media WHERE project_id = ? AND role = 'main' AND location != 'missing' AND cloud_state = 'local' AND thumb_status != 'none'").get(projectId) as { n: number }).n
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
