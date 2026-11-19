// Vorschau- und Metadatenerzeugung mit echten Decodern (Sharp, ExifTool, FFmpeg) auf generierten Dateien.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MediaProcessor, resolveToolPaths } from '../../src/main/services/media-tools'
import { makeEnv, mediaId, type TestEnv } from '../helpers/env'

let env: TestEnv
let proc: MediaProcessor

beforeAll(async () => {
  env = await makeEnv({})
  execFileSync(process.execPath, [path.resolve('scripts/gen-test-media.mjs'), env.srcDir, '3', '--videos'], { stdio: 'ignore' })
  const { scanSource } = await import('../../src/main/core/sources')
  await scanSource(env.ctx, env.sourceId)
  proc = new MediaProcessor(env.ctx, path.join(env.dataDir, 'cache'), resolveToolPaths())
}, 60000)
afterAll(async () => {
  await proc.close()
  env.cleanup()
})

function row(id: number) {
  return env.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as Record<string, unknown>
}

describe('Vorschauen und Metadaten', () => {
  it('Werkzeuge verfügbar', () => {
    const s = proc.status()
    expect(s.sharp).toBe(true)
    expect(s.ffmpeg).toBe(true)
    expect(s.ffprobe).toBe(true)
  })

  it.each(['Zeremonie/IMG_0001.jpg', 'Feier/Grafik_01.png', 'Feier/Web_01.webp', 'Feier/Scan_01.tiff', 'Feier/Anim_01.gif'])('Thumbnail für %s', async (rel) => {
    const id = mediaId(env, rel)
    const f = await proc.getThumb(id)
    expect(f).not.toBeNull()
    expect(fs.statSync(f!).size).toBeGreaterThan(100)
    const r = row(id)
    expect(r.thumb_status).toBe('ok')
    expect(r.width).toBeGreaterThan(0)
  })

  it('TIFF erhält eine Großvorschau (nicht browser-nativ)', async () => {
    const id = mediaId(env, 'Feier/Scan_01.tiff')
    expect(proc.needsPreview({ kind: 'image', ext: 'tiff' })).toBe(true)
    const f = await proc.getPreview(id)
    expect(f).toMatch(/\.jpg$/)
  })

  it('Video: Thumbnail, Dauer, Codec', async () => {
    const id = mediaId(env, 'Feier/VID_0001.mp4')
    const f = await proc.getThumb(id)
    expect(f).not.toBeNull()
    const r = row(id)
    expect(r.duration_ms).toBeGreaterThan(3500)
    expect(r.codec).toBe('h264')
    expect(r.width).toBe(640)
  })

  it('RAW ohne eingebettete Vorschau und beschädigte Dateien blockieren nicht', async () => {
    for (const rel of ['Portraits/DSC_0001.NEF', 'Portraits/IMG_9999.CR3', 'Feier/kaputt.jpg']) {
      const id = mediaId(env, rel)
      const f = await proc.getThumb(id)
      expect(f).toBeNull()
      expect(row(id).thumb_status).toBe('error')
      expect(String(row(id).thumb_error).length).toBeGreaterThan(0)
    }
  }, 60000)

  it('Cache-Invalidierung bei geänderter Datei', async () => {
    const id = mediaId(env, 'Zeremonie/IMG_0001.jpg')
    const a = await proc.getThumb(id)
    env.db.prepare('UPDATE media SET mtime_ms = mtime_ms + 1000 WHERE id = ?').run(id)
    const b = await proc.getThumb(id)
    expect(b).not.toBe(a)
  })

  it('hängender Decoder (ExifTool) blockiert Vorschauen nicht', async () => {
    const p2 = new MediaProcessor(env.ctx, path.join(env.dataDir, 'cache2'), resolveToolPaths(), 2, 300)
    const never = () => new Promise<never>(() => {})
    ;(p2 as unknown as { getExiftool: () => Promise<unknown> }).getExiftool = async () => ({ read: never, extractBinaryTagToBuffer: never, end: async () => {} })
    const t = Date.now()
    const jpg = await p2.getThumb(mediaId(env, 'Feier/IMG_0002.jpg'))
    expect(jpg).not.toBeNull()
    const raw = await p2.getThumb(mediaId(env, 'Portraits/DSC_0001.NEF'))
    expect(raw).toBeNull()
    expect(Date.now() - t).toBeLessThan(10000)
    await p2.close()
  })

  it('Video mit nicht unterstütztem Codec bleibt exportierbar (kein Abbruch)', async () => {
    const id = mediaId(env, 'Feier/VID_0003.mkv')
    await proc.getThumb(id)
    expect(['ok', 'error']).toContain(row(id).thumb_status)
  })
})
