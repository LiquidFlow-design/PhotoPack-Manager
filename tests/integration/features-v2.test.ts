// Tests für Version 2: Sidecars, RAW+JPEG-Paare, Paketreihenfolge, Bewertungen, Projektsicherung,
// ZIP-Export, Wiederherstellungsbereich je Laufwerk, „Projekt abschließen“, Ähnlichkeit.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { applyAssignments, listAssignments, packageOrder, reorderPackage } from '../../src/main/core/assignments'
import { exportProject, importProject } from '../../src/main/core/backup'
import { setColorLabel, setRating } from '../../src/main/core/media-meta'
import { getProject, updateProjectSettings } from '../../src/main/core/projects'
import { recoveryDirForSource, releaseAllHeld, resolveRecoveryDir } from '../../src/main/core/recovery'
import { updateSettings } from '../../src/main/core/settings'
import { dhashFromPixels, hamming, listSimilarGroups, scanSimilar } from '../../src/main/core/similar'
import { exportPackageZip } from '../../src/main/core/zip-export'
import { MediaProcessor, resolveToolPaths } from '../../src/main/services/media-tools'
import { scanSource } from '../../src/main/core/sources'
import { assign, content, exportAll, listFiles, makeEnv, mediaId, pkg, readSha, sha, type TestEnv } from '../helpers/env'

let env: TestEnv | null = null
afterEach(() => {
  env?.cleanup()
  env = null
})

function row(e: TestEnv, id: number) {
  return e.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as Record<string, unknown>
}

describe('Sidecars und RAW+JPEG-Paare', () => {
  async function sidecarEnv() {
    env = await makeEnv({
      'IMG_1.CR3': content('raw1', 9000),
      'IMG_1.JPG': content('jpg1', 5000),
      'IMG_1.xmp': '<x:xmpmeta/>',
      'IMG_2.NEF': content('raw2', 9000),
      'IMG_2.NEF.xmp': '<x:xmpmeta id="2"/>',
      'IMG_3.jpg': content('jpg3', 5000),
      'verwaist.xmp': '<x/>'
    })
    return env
  }

  it('erkennt Sidecars (beide Namensschemata) und RAW+JPEG-Paare', async () => {
    const e = await sidecarEnv()
    const raw1 = mediaId(e, 'IMG_1.CR3')
    const jpg1 = mediaId(e, 'IMG_1.JPG')
    const raw2 = mediaId(e, 'IMG_2.NEF')
    expect(row(e, raw1).pair_id).toBe(jpg1)
    expect(row(e, jpg1).pair_id).toBe(raw1)
    expect(row(e, raw2).pair_id).toBeNull()
    const sc1 = row(e, mediaId(e, 'IMG_1.xmp'))
    expect(sc1.role).toBe('sidecar')
    expect(sc1.parent_id).toBe(raw1) // RAW bevorzugt
    expect(row(e, mediaId(e, 'IMG_2.NEF.xmp')).parent_id).toBe(raw2)
    expect(() => mediaId(e, 'verwaist.xmp')).toThrow()
  })

  it('Zuordnung nimmt Partner und Sidecars mit; Export benennt Sidecar passend zum Hauptmedium', async () => {
    const e = await sidecarEnv()
    const A = pkg(e, 'Anna')
    const jpg1 = mediaId(e, 'IMG_1.JPG')
    const r = await assign(e, [[jpg1, A]])
    expect(r.delta.added).toHaveLength(3) // JPG, RAW-Partner, Sidecar des RAW
    // Vorhandene, abweichende Datei erzwingt Umbenennung des RAW → Sidecar folgt
    fs.mkdirSync(path.join(e.outDir, 'Anna'), { recursive: true })
    fs.writeFileSync(path.join(e.outDir, 'Anna', 'IMG_1.CR3'), 'anderer Inhalt')
    fs.writeFileSync(path.join(e.outDir, 'Anna', 'IMG_1 (2).CR3'), 'noch einer')
    await exportAll(e)
    const files = listFiles(path.join(e.outDir, 'Anna'))
    expect(files).toContain('IMG_1.JPG')
    expect(files).toContain('IMG_1.xmp')
    expect(files.filter((f) => f.endsWith('.CR3'))).toHaveLength(3)
    // Entfernen nimmt alle drei Zuordnungen zurück
    const rem = await applyAssignments(e.ctx, e.engine, e.projectId, { added: [], removed: [[jpg1, A]] })
    expect(rem.delta.removed).toHaveLength(3)
    expect(listAssignments(e.ctx, e.projectId)).toEqual([])
  })

  it('Sidecar-Zielname folgt dem Hauptmedium bei Namenskollision im Plan', async () => {
    env = await makeEnv({ 'a/IMG_5.NEF': content('a5', 7000), 'a/IMG_5.NEF.xmp': 'x1', 'b/IMG_5.NEF': content('b5', 7000), 'b/IMG_5.NEF.xmp': 'x2' })
    const A = pkg(env, 'Anna')
    await assign(env, [
      [mediaId(env, 'a/IMG_5.NEF'), A],
      [mediaId(env, 'b/IMG_5.NEF'), A]
    ])
    await exportAll(env)
    expect(listFiles(path.join(env.outDir, 'Anna'))).toEqual(['IMG_5 (2).NEF', 'IMG_5 (2).NEF.xmp', 'IMG_5.NEF', 'IMG_5.NEF.xmp'])
    expect(fs.readFileSync(path.join(env.outDir, 'Anna', 'IMG_5 (2).NEF.xmp'), 'utf8')).toBe('x2')
  })

  it('Verschieben nimmt Sidecars mit in den Wiederherstellungsbereich', async () => {
    const e = await sidecarEnv()
    const A = pkg(e, 'Anna')
    await assign(e, [[mediaId(e, 'IMG_2.NEF'), A]])
    await exportAll(e, 'move')
    expect(fs.existsSync(path.join(e.srcDir, 'IMG_2.NEF'))).toBe(false)
    expect(fs.existsSync(path.join(e.srcDir, 'IMG_2.NEF.xmp'))).toBe(false)
    expect(row(e, mediaId(e, 'IMG_2.NEF')).location).toBe('recovery')
  })

  it('Einstellungen aus: keine Partner/Sidecars', async () => {
    const e = await sidecarEnv()
    updateSettings(e.ctx, { pairRawJpeg: false, includeSidecars: false })
    const A = pkg(e, 'Anna')
    const r = await assign(e, [[mediaId(e, 'IMG_1.JPG'), A]])
    expect(r.delta.added).toHaveLength(1)
  })
})

describe('Reihenfolge in Paketen', () => {
  it('neue Zuordnungen werden angehängt; Reihenfolge lässt sich setzen und bleibt erhalten', async () => {
    env = await makeEnv({ 'a.jpg': 'a', 'b.jpg': 'b', 'c.jpg': 'c', 'd.jpg': 'd' })
    const A = pkg(env, 'Anna')
    const [a, b, c, d] = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map((f) => mediaId(env!, f))
    await assign(env, [[c, A]])
    await assign(env, [
      [a, A],
      [b, A]
    ])
    expect(packageOrder(env.ctx, A)).toEqual([c, a, b])
    expect(reorderPackage(env.ctx, A, [b, c])).toEqual([b, c, a]) // nicht genannte folgen
    await assign(env, [[d, A]])
    expect(packageOrder(env.ctx, A)).toEqual([b, c, a, d])
    await env.restart()
    expect(packageOrder(env.ctx, A)).toEqual([b, c, a, d])
  })

  it('Paketreihenfolge als Nummer im Dateinamen (inkl. Sidecar)', async () => {
    env = await makeEnv({ 'b.jpg': content('b'), 'a.NEF': content('a'), 'a.NEF.xmp': 'x', 'c.jpg': content('c') })
    const A = pkg(env, 'Anna')
    const [a, b, c] = ['a.NEF', 'b.jpg', 'c.jpg'].map((f) => mediaId(env!, f))
    await assign(env, [
      [b, A],
      [a, A],
      [c, A]
    ])
    reorderPackage(env.ctx, A, [c, b, a])
    updateProjectSettings(env.ctx, env.projectId, { numberPrefix: true })
    await exportAll(env)
    expect(listFiles(path.join(env.outDir, 'Anna'))).toEqual(['001_c.jpg', '002_b.jpg', '003_a.NEF', '003_a.NEF.xmp'])
  })

  it('ZIP-Export folgt der Paketreihenfolge, liest nur und überspringt veränderte Quellen', async () => {
    env = await makeEnv({ 'x/a.jpg': content('a'), 'y/a.jpg': content('a2'), 'b.jpg': content('b'), 'c.NEF': content('c'), 'c.NEF.xmp': 'side' })
    const A = pkg(env, 'Anna')
    const ids = ['b.jpg', 'x/a.jpg', 'y/a.jpg', 'c.NEF'].map((f) => mediaId(env!, f))
    await assign(
      env,
      ids.map((i) => [i, A] as [number, string])
    )
    const zipFile = path.join(env.root, 'anna.zip')
    const r = await exportPackageZip(env.ctx, A, zipFile)
    expect(r.entries).toBe(5)
    const listing = execFileSync('unzip', ['-Z1', zipFile]).toString().trim().split('\n')
    expect(listing).toEqual(['b.jpg', 'a.jpg', 'a (2).jpg', 'c.NEF', 'c.NEF.xmp'])
    const test = execFileSync('unzip', ['-t', zipFile]).toString()
    expect(test).toMatch(/No errors/)
    expect(fs.readdirSync(env.srcDir).sort()).toEqual(['b.jpg', 'c.NEF', 'c.NEF.xmp', 'x', 'y'])
    // veränderte Quelle wird übersprungen
    fs.writeFileSync(path.join(env.srcDir, 'b.jpg'), 'anders und länger')
    const r2 = await exportPackageZip(env.ctx, A, path.join(env.root, 'anna2.zip'))
    expect(r2.skipped.map((s) => s.name)).toEqual(['b.jpg'])
  })
})

describe('Bewertungen und Farbmarkierungen', () => {
  it('setzt Sterne und Farbe, Paarpartner inklusive', async () => {
    env = await makeEnv({ 'IMG_1.CR3': 'r', 'IMG_1.jpg': 'j', 'x.jpg': 'x' })
    const raw = mediaId(env, 'IMG_1.CR3')
    const jpg = mediaId(env, 'IMG_1.jpg')
    expect(setRating(env.ctx, env.projectId, [jpg], 4).sort()).toEqual([raw, jpg].sort())
    expect(row(env, raw).rating).toBe(4)
    setColorLabel(env.ctx, env.projectId, [mediaId(env, 'x.jpg')], 'red')
    expect(row(env, mediaId(env, 'x.jpg')).color_label).toBe('red')
    setColorLabel(env.ctx, env.projectId, [mediaId(env, 'x.jpg')], null)
    expect(row(env, mediaId(env, 'x.jpg')).color_label).toBeNull()
    expect(() => setRating(env!.ctx, 'fremdes-projekt', [jpg], 2)).not.toThrow()
    expect(row(env, jpg).rating).toBe(4)
  })
})

describe('Projektsicherung', () => {
  it('Export und Import auf „anderem PC“ (frische Datenbank): Zuordnungen, Reihenfolge, Exporte, Recovery', async () => {
    env = await makeEnv({ 'a.jpg': content('a'), 'b.jpg': content('b'), 'IMG_1.CR3': 'r', 'IMG_1.xmp': 's' })
    const A = pkg(env, 'Anna')
    const B = pkg(env, 'Max')
    const a = mediaId(env, 'a.jpg')
    const b = mediaId(env, 'b.jpg')
    await assign(env, [
      [b, A],
      [a, A],
      [a, B]
    ])
    setRating(env.ctx, env.projectId, [a], 5)
    await exportAll(env, 'move', 'rename', [B])
    const file = path.join(env.root, 'sicherung.ppmproj')
    exportProject(env.ctx, env.projectId, file)
    // Import in derselben DB wird abgelehnt (Projekt existiert)
    expect(() => importProject(env!.ctx, file)).toThrow(/existiert bereits/)
    // Frische Datenbank
    const env2 = await makeEnv({})
    try {
      const r = importProject(env2.ctx, file)
      expect(r.projectId).toBe(env.projectId)
      expect(r.media).toBe(4)
      const p = getProject(env2.ctx, r.projectId)
      expect(p.outputDir).toBe(env.outDir)
      const media = env2.db.prepare('SELECT file_name, rating, location, role, parent_id FROM media WHERE project_id = ? ORDER BY file_name').all(r.projectId) as Array<Record<string, unknown>>
      expect(media.find((m) => m.file_name === 'a.jpg')).toMatchObject({ rating: 5, location: 'recovery' })
      expect(media.find((m) => m.file_name === 'IMG_1.xmp')!.parent_id).not.toBeNull()
      const newA = (env2.db.prepare("SELECT id FROM media WHERE project_id = ? AND file_name = 'a.jpg'").get(r.projectId) as { id: number }).id
      const newB = (env2.db.prepare("SELECT id FROM media WHERE project_id = ? AND file_name = 'b.jpg'").get(r.projectId) as { id: number }).id
      expect(packageOrder(env2.ctx, A)).toEqual([newB, newA])
      expect((env2.db.prepare('SELECT COUNT(*) AS n FROM transfer_destinations WHERE project_id = ?').get(r.projectId) as { n: number }).n).toBe(1)
      expect((env2.db.prepare("SELECT COUNT(*) AS n FROM recovery_items WHERE project_id = ? AND status='held'").get(r.projectId) as { n: number }).n).toBe(1)
    } finally {
      env2.cleanup()
    }
  })

  it('beschädigte Datei wird abgelehnt', async () => {
    env = await makeEnv({})
    const f = path.join(env.root, 'kaputt.ppmproj')
    fs.writeFileSync(f, 'kein gzip')
    expect(() => importProject(env!.ctx, f)).toThrow(/gültige/)
  })
})

describe('Wiederherstellungsbereich je Laufwerk und Projekt abschließen', () => {
  it('wählt unter Windows den Bereich auf dem Laufwerk der Quelle', async () => {
    env = await makeEnv({})
    const p = { ...getProject(env.ctx, env.projectId), recoveryDir: 'C:\\Users\\x\\AppData\\Roaming\\PhotoPack Manager\\recovery\\P1', recoveryDirCustom: false, id: 'P1' }
    expect(recoveryDirForSource(env.ctx, p, 'D:\\Fotos\\a.jpg', 'win32')).toBe('D:\\.photopack-recovery\\P1')
    expect(recoveryDirForSource(env.ctx, p, 'C:\\Fotos\\a.jpg', 'win32')).toBe(p.recoveryDir)
    expect(recoveryDirForSource(env.ctx, p, '\\\\nas\\share\\a.jpg', 'win32')).toBe(p.recoveryDir)
    expect(recoveryDirForSource(env.ctx, { ...p, recoveryDirCustom: true }, 'D:\\Fotos\\a.jpg', 'win32')).toBe(p.recoveryDir)
    updateSettings(env.ctx, { recoveryPerVolume: false })
    expect(recoveryDirForSource(env.ctx, p, 'D:\\Fotos\\a.jpg', 'win32')).toBe(p.recoveryDir)
    expect(recoveryDirForSource(env.ctx, p, '/mnt/x/a.jpg', 'linux')).toBe(p.recoveryDir)
  })

  it('nur feste Laufwerke erhalten einen eigenen Bereich (keine SD-Karten/USB-Sticks)', async () => {
    env = await makeEnv({})
    const p = { ...getProject(env.ctx, env.projectId), recoveryDir: 'C:\\R\\P1', recoveryDirCustom: false, id: 'P1' }
    const type = (t: string | null) => async () => t
    expect(await resolveRecoveryDir(env.ctx, p, 'D:\\Fotos\\a.jpg', type('Fixed'), 'win32')).toBe('D:\\.photopack-recovery\\P1')
    expect(await resolveRecoveryDir(env.ctx, p, 'E:\\DCIM\\a.jpg', type('Removable'), 'win32')).toBe(p.recoveryDir)
    expect(await resolveRecoveryDir(env.ctx, p, 'E:\\DCIM\\a.jpg', type(null), 'win32')).toBe(p.recoveryDir)
  })

  it('„Projekt abschließen“ gibt alle gehaltenen Quellen frei', async () => {
    env = await makeEnv({ 'a.jpg': content('a'), 'b.jpg': content('b') })
    const A = pkg(env, 'Anna')
    await assign(env, [
      [mediaId(env, 'a.jpg'), A],
      [mediaId(env, 'b.jpg'), A]
    ])
    await exportAll(env, 'move')
    const r = releaseAllHeld(env.ctx, env.projectId)
    expect(r.count).toBe(2)
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM recovery_items WHERE status='released'").get() as { n: number }).n).toBe(2)
    // Dateien weiterhin vorhanden
    for (const x of env.db.prepare('SELECT recovery_path FROM recovery_items').all() as Array<{ recovery_path: string }>) expect(fs.existsSync(x.recovery_path)).toBe(true)
  })
})

describe('Ähnliche Bilder', () => {
  it('dHash und Hamming-Distanz', () => {
    const px = new Uint8Array(72).map((_, i) => (i * 37) % 251)
    const h = dhashFromPixels(px)
    expect(h).toHaveLength(16)
    expect(hamming(h, h)).toBe(0)
    const px2 = px.slice()
    px2[0] = 255
    expect(hamming(h, dhashFromPixels(px2))).toBeLessThanOrEqual(1)
  })

  it('gruppiert visuell ähnliche Bilder (gleiches Motiv, andere Größe/Qualität), trennt verschiedene', async () => {
    env = await makeEnv({})
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require('sharp') as typeof import('sharp').default
    const scene = (seed: number, hue: string) =>
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="${hue}"/><circle cx="${200 + seed * 40}" cy="250" r="140" fill="#fff"/><rect x="${450 - seed * 30}" y="320" width="300" height="200" fill="#123"/></svg>`
      )
    await sharp(scene(1, '#3a6')).jpeg({ quality: 90 }).toFile(path.join(env.srcDir, 'serie_1.jpg'))
    await sharp(scene(1, '#3a6')).resize(400).jpeg({ quality: 50 }).toFile(path.join(env.srcDir, 'serie_1_klein.jpg'))
    await sharp(scene(7, '#a36')).jpeg({ quality: 90 }).toFile(path.join(env.srcDir, 'anderes.jpg'))
    await scanSource(env.ctx, env.sourceId)
    const proc = new MediaProcessor(env.ctx, path.join(env.dataDir, 'cache'), resolveToolPaths())
    try {
      const r = await scanSimilar(env.ctx, env.projectId, 8, (id) => proc.ensurePhash(id))
      expect(r.groups).toBe(1)
      const g = listSimilarGroups(env.ctx, env.projectId)
      expect(g[0].mediaIds.sort()).toEqual([mediaId(env, 'serie_1.jpg'), mediaId(env, 'serie_1_klein.jpg')].sort())
      expect(row(env, mediaId(env, 'anderes.jpg')).sim_group).toBeNull()
    } finally {
      await proc.close()
    }
  })
})

void readSha
void sha
void updateProjectSettings
