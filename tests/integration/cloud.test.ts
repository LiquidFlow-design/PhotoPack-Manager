// Proton Drive / Cloud-Speicher: Erkennung, „Nur online“-Platzhalter, sicheres Verschieben, Hinweise.
// Windows-Ausgaben (Registrierung, Dateiattribute) werden simuliert.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cloudRootFor, detectCloudRoots, parseSyncRoots, providerName } from '../../src/main/core/cloud'
import { buildPlan } from '../../src/main/core/planner'
import { scanDuplicates } from '../../src/main/core/duplicates'
import { MediaProcessor, resolveToolPaths } from '../../src/main/services/media-tools'
import { assign, content, exportAll, makeEnv, mediaId, pkg, readSha, sha, tmpDir, type TestEnv } from '../helpers/env'

let env: TestEnv | null = null
afterEach(() => {
  env?.cleanup()
  env = null
})

describe('Erkennung der Sync-Ordner', () => {
  it('wertet die Windows-Registrierung (SyncRootManager) aus', () => {
    const json = JSON.stringify([
      { Id: 'ProtonDrive!S-1-5-21-1!max@proton.me', Name: 'Proton Drive', Path: 'C:\\Users\\Max\\Proton Drive\\max@proton.me' },
      { Id: 'OneDrive!S-1-5-21-1!Personal|ABC', Name: 'OneDrive - Personal', Path: 'C:\\Users\\Max\\OneDrive' }
    ])
    const r = parseSyncRoots(json)
    expect(r.map((x) => x.provider)).toEqual(['Proton Drive', 'OneDrive'])
    expect(r[0].label).toBe('Proton Drive – max@proton.me')
    expect(parseSyncRoots(JSON.stringify({ Id: 'ProtonDrive!S!a', Name: '', Path: 'D:\\PD' }))).toHaveLength(1) // Einzelobjekt
    expect(parseSyncRoots('kaputt')).toEqual([])
    expect(parseSyncRoots(null)).toEqual([])
    expect(providerName('Dropbox!S!1', '')).toBe('Dropbox')
  })

  it('findet Proton Drive auch über den Standardordner (Rückfall)', async () => {
    const home = tmpDir()
    fs.mkdirSync(path.join(home, 'Proton Drive', 'max@proton.me', 'My files'), { recursive: true })
    const roots = await detectCloudRoots({ home, env: {}, platform: 'linux', force: true })
    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatchObject({ provider: 'Proton Drive', label: 'Proton Drive – max@proton.me' })
    expect(cloudRootFor(path.join(roots[0].path, 'My files', 'a.jpg'), roots)?.provider).toBe('Proton Drive')
    expect(cloudRootFor(path.join(home, 'anders'), roots)).toBeNull()
    fs.rmSync(home, { recursive: true, force: true })
  })
})


describe('Proton Drive als Quelle', () => {
  it('Quelle wird als Proton Drive erkannt, „Nur online“-Dateien markiert, ohne automatischen Download', async () => {
    // srcDir wird erst in makeEnv erzeugt: Cloud-Funktionen greifen per Closure darauf zu
    const holder: { e?: TestEnv } = {}
    env = await makeEnv(
      { 'IMG_1.jpg': content('lokal', 30_000), 'IMG_2.jpg': content('dup', 30_000), 'IMG_3.jpg': content('dup', 30_000) },
      {
        cloud: {
          roots: async () => [{ id: 'cloud-0', provider: 'Proton Drive', label: 'Proton Drive – test', path: holder.e!.root }],
          onlineOnly: async () => new Set([path.join(holder.e!.srcDir, 'IMG_2.jpg')])
        }
      }
    )
    holder.e = env
    // Quelle erneut anlegen, damit die Erkennung mit gesetztem holder läuft
    const { addSource, scanSource, removeSource } = await import('../../src/main/core/sources')
    removeSource(env.ctx, env.sourceId)
    const s = await addSource(env.ctx, env.projectId, env.srcDir, true)
    env.sourceId = s.id
    expect(s.cloudProvider).toBe('Proton Drive')
    const r = await scanSource(env.ctx, s.id)
    expect(r.onlineOnly).toBe(1)
    const st = (f: string) => (env!.db.prepare('SELECT cloud_state FROM media WHERE original_path = ?').get(path.join(env!.srcDir, f)) as { cloud_state: string }).cloud_state
    expect(st('IMG_2.jpg')).toBe('online')
    expect(st('IMG_1.jpg')).toBe('local')

    // Vorschau: nur auf Anforderung
    const proc = new MediaProcessor(env.ctx, path.join(env.dataDir, 'cache'), resolveToolPaths())
    try {
      const fakeJpeg = mediaId(env, 'IMG_2.jpg')
      expect(await proc.getThumb(fakeJpeg)).toBeNull()
    } finally {
      await proc.close()
    }
    // Duplikatprüfung liest keine Nur-online-Dateien
    const d = await scanDuplicates(env.ctx, env.projectId)
    expect(d.hashed).toBe(2) // IMG_1 und IMG_3 (gleiche Größe), IMG_2 ausgelassen
    expect(d.groups).toBe(0)

    // Exportvorschau: Hinweise für Download und Verschieben aus Proton Drive
    const A = pkg(env, 'Anna', path.join(env.root, 'ziel-in-proton'))
    await assign(env, [
      [mediaId(env, 'IMG_1.jpg'), A],
      [mediaId(env, 'IMG_2.jpg'), A]
    ])
    const p = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'move', conflictPolicy: 'rename', reexportMissing: false })
    const w = p.preview.warnings.join('\n')
    expect(w).toMatch(/1 Datei\(en\) liegen nur online in Proton Drive/)
    expect(w).toMatch(/Verschieben entfernt 2 Datei\(en\) aus Proton Drive/)
    expect(w).toMatch(/Ziel liegt in Proton Drive/)
  })

  it('Verschieben aus Proton Drive: verifizierte Kopie in den Wiederherstellungsbereich statt Umbenennen', async () => {
    env = await makeEnv({ 'IMG_1.jpg': content('p1', 40_000) })
    // Quelle als Proton Drive markieren
    env.db.prepare("UPDATE sources SET cloud_provider = 'Proton Drive'").run()
    const A = pkg(env, 'Anna')
    const m = mediaId(env, 'IMG_1.jpg')
    await assign(env, [[m, A]])
    let copied = false
    env.faults.on('release:afterRecoveryCopy', () => {
      copied = true
    })
    await exportAll(env, 'move')
    expect(copied).toBe(true) // Kopierweg trotz gleichem Datenträger
    const row = env.db.prepare('SELECT location, current_path FROM media WHERE id = ?').get(m) as { location: string; current_path: string }
    expect(row.location).toBe('recovery')
    expect(readSha(row.current_path)).toBe(sha(content('p1', 40_000)))
    expect(fs.existsSync(path.join(env.srcDir, 'IMG_1.jpg'))).toBe(false)
  })
})
