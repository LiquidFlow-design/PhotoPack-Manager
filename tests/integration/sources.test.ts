import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addSource, checkSourcePath, removeSource, scanSource } from '../../src/main/core/sources'
import { updateProjectSettings } from '../../src/main/core/projects'
import { scanDuplicates, listDuplicateGroups } from '../../src/main/core/duplicates'
import { assign, content, exportAll, makeEnv, mediaId, pkg, writeFile, type TestEnv } from '../helpers/env'

let env: TestEnv | null = null
afterEach(() => {
  env?.cleanup()
  env = null
})

function count(e: TestEnv, where = '1=1'): number {
  return (e.db.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${where}`).get() as { n: number }).n
}

describe('Indexierung', () => {
  it('klassifiziert Formate und ignoriert Fremddateien', async () => {
    env = await makeEnv({
      'a.jpg': 'x', 'b.PNG': 'x', 'c.webp': 'x', 'd.gif': 'x', 'e.bmp': 'x', 'f.tiff': 'x',
      'raw/g.CR2': 'x', 'raw/h.cr3': 'x', 'raw/i.nef': 'x', 'raw/j.arw': 'x', 'raw/k.dng': 'x',
      'vid/l.mp4': 'x', 'vid/m.MOV': 'x', 'vid/n.mkv': 'x',
      'notes.txt': 'x', 'thumbs.db': 'x', '.ppm-abc.tmp': 'x'
    })
    expect(count(env)).toBe(14)
    expect(count(env, "kind='raw'")).toBe(5)
    expect(count(env, "kind='video'")).toBe(3)
    const r = env.db.prepare("SELECT rel_dir FROM media WHERE file_name = 'g.CR2'").get() as { rel_dir: string }
    expect(r.rel_dir).toBe('raw')
  })

  it('schließt Ausgabeordner innerhalb der Quelle aus (kein rekursiver Re-Import)', async () => {
    env = await makeEnv({ 'a.jpg': content('a') }, { outDirInside: true })
    const A = pkg(env, 'Anna')
    await assign(env, [[mediaId(env, 'a.jpg'), A]])
    await exportAll(env)
    expect(fs.existsSync(path.join(env.outDir, 'Anna', 'a.jpg'))).toBe(true)
    await scanSource(env.ctx, env.sourceId)
    expect(count(env)).toBe(1)
  })

  it('verlangt Bestätigung, wenn die Quelle einen Ausgabeordner enthält', async () => {
    env = await makeEnv({})
    const other = path.join(env.root, 'zweite')
    fs.mkdirSync(path.join(other, 'out'), { recursive: true })
    updateProjectSettings(env.ctx, env.projectId, { outputDir: path.join(other, 'out') })
    const chk = await checkSourcePath(env.ctx, env.projectId, other)
    expect(chk.ok).toBe(true)
    expect(chk.exclusions).toHaveLength(1)
    await expect(addSource(env.ctx, env.projectId, other)).rejects.toThrow(/Bestätigung/)
    await expect(addSource(env.ctx, env.projectId, other, true)).resolves.toBeTruthy()
  })

  it('lehnt Quellen innerhalb von Ausgabe/Recovery und verschachtelte Quellen ab', async () => {
    env = await makeEnv({ 'sub/a.jpg': 'x' })
    fs.mkdirSync(env.outDir, { recursive: true })
    expect((await checkSourcePath(env.ctx, env.projectId, env.outDir)).ok).toBe(false)
    expect((await checkSourcePath(env.ctx, env.projectId, path.join(env.srcDir, 'sub'))).error).toMatch(/bereits/)
    expect((await checkSourcePath(env.ctx, env.projectId, env.root)).error).toMatch(/enthält/)
    expect((await checkSourcePath(env.ctx, env.projectId, path.join(env.root, 'gibtsnicht'))).ok).toBe(false)
  })

  it('folgt keinen symbolischen Links (Schleifenschutz)', async () => {
    env = await makeEnv({ 'a.jpg': 'x' })
    fs.symlinkSync(env.srcDir, path.join(env.srcDir, 'loop'))
    const other = path.join(env.root, 'extern')
    writeFile(path.join(other, 'z.jpg'), 'x')
    fs.symlinkSync(other, path.join(env.srcDir, 'ext'))
    const r = await scanSource(env.ctx, env.sourceId)
    expect(r.skippedLinks).toBe(2)
    expect(count(env)).toBe(1)
  })

  it('erneute Indexierung: neue, geänderte, fehlende Dateien', async () => {
    env = await makeEnv({ 'a.jpg': 'aaa', 'b.jpg': 'bbb' })
    fs.unlinkSync(path.join(env.srcDir, 'b.jpg'))
    writeFile(path.join(env.srcDir, 'c.jpg'), 'ccc')
    fs.writeFileSync(path.join(env.srcDir, 'a.jpg'), 'aaaa-geändert')
    const r = await scanSource(env.ctx, env.sourceId)
    expect(r).toMatchObject({ added: 1, updated: 1, missing: 1 })
    expect(count(env, "location='missing'")).toBe(1)
    // Datei kehrt zurück
    writeFile(path.join(env.srcDir, 'b.jpg'), 'bbb')
    await scanSource(env.ctx, env.sourceId)
    expect(count(env, "location='missing'")).toBe(0)
  })

  it('Quelle entfernen behält verschobene Medien', async () => {
    env = await makeEnv({ 'a.jpg': content('a'), 'b.jpg': content('b') })
    const A = pkg(env, 'Anna')
    await assign(env, [[mediaId(env, 'a.jpg'), A]])
    await exportAll(env, 'move')
    const r = removeSource(env.ctx, env.sourceId)
    expect(r).toEqual({ removedMedia: 1, keptMoved: 1 })
    expect(count(env)).toBe(1)
  })

  it('nicht erreichbare Quelle wird gemeldet', async () => {
    env = await makeEnv({ 'a.jpg': 'x' })
    fs.rmSync(env.srcDir, { recursive: true })
    await expect(scanSource(env.ctx, env.sourceId)).rejects.toThrow(/nicht erreichbar/)
    expect(count(env)).toBe(1) // Datensätze bleiben
  })
})

describe('Duplikaterkennung', () => {
  it('findet identische Inhalte trotz unterschiedlicher Namen, hasht nur Größenkandidaten, löscht nichts', async () => {
    env = await makeEnv({
      'a.jpg': content('same', 5000),
      'sub/kopie.jpg': content('same', 5000),
      'c.jpg': content('other', 5000), // gleiche Größe, anderer Inhalt
      'd.jpg': content('einzeln', 7000)
    })
    const r = await scanDuplicates(env.ctx, env.projectId)
    expect(r.hashed).toBe(3)
    expect(r.groups).toBe(1)
    const g = listDuplicateGroups(env.ctx, env.projectId)
    expect(g).toHaveLength(1)
    expect(g[0].mediaIds.sort()).toEqual([mediaId(env, 'a.jpg'), mediaId(env, 'sub/kopie.jpg')].sort())
    expect(fs.readdirSync(env.srcDir).sort()).toEqual(['a.jpg', 'c.jpg', 'd.jpg', 'sub'])
  })
})

describe('Windows-Analysepunkte (OneDrive-Platzhalter)', () => {
  it('als Link gemeldete Einträge werden per lstat eingeordnet', async () => {
    const { entryType } = await import('../../src/main/core/sources')
    const linkDirent = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false } as unknown as import('node:fs').Dirent
    const fake = (kind: 'file' | 'dir' | 'link') => async () =>
      ({ isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'dir', isFile: () => kind === 'file' }) as unknown as import('node:fs').Stats
    expect(await entryType(linkDirent, 'x', fake('file'))).toBe('file') // OneDrive-Datei
    expect(await entryType(linkDirent, 'x', fake('dir'))).toBe('dir') // OneDrive-Ordner
    expect(await entryType(linkDirent, 'x', fake('link'))).toBe('link') // echter Symlink/Junction
    expect(await entryType(linkDirent, 'x', async () => Promise.reject(new Error('x')))).toBe('other')
  })
})

describe('Re-Import-Schutz über Projekte hinweg', () => {
  it('Exportordner eines anderen Projekts in der Quelle wird ausgeschlossen', async () => {
    const { createProject, updateProjectSettings } = await import('../../src/main/core/projects')
    env = await makeEnv({ 'a.jpg': 'x' })
    const other = createProject(env.ctx, 'Anderes Projekt')
    const foreignOut = path.join(env.srcDir, 'export-anderes-projekt')
    writeFile(path.join(foreignOut, 'Anna', 'b.jpg'), 'y')
    updateProjectSettings(env.ctx, other.id, { outputDir: foreignOut })
    await scanSource(env.ctx, env.sourceId)
    expect(count(env)).toBe(1)
  })
})
