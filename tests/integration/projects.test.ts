import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, schemaVersion } from '../../src/main/db/database'
import { MIGRATIONS } from '../../src/main/db/migrations'
import { createContext } from '../../src/main/core/context'
import { inlineFileOps } from '../../src/main/core/fileops'
import { createProject, deleteProject, getProject, listProjects, renameProject, saveUiState, updateProjectSettings } from '../../src/main/core/projects'
import { createPackage, deletePackage, listPackages, updatePackage } from '../../src/main/core/packages'
import { listAssignments } from '../../src/main/core/assignments'
import { getSettings, updateSettings } from '../../src/main/core/settings'
import { DEFAULT_FILTERS } from '../../src/shared/filters'
import { assign, content, exportAll, makeEnv, mediaId, pkg, type TestEnv } from '../helpers/env'

let env: TestEnv | null = null
afterEach(() => {
  env?.cleanup()
  env = null
})

describe('Projekte und Persistenz', () => {
  it('Projekt erstellen, schließen, wieder öffnen: Einstellungen und Zuordnungen bleiben', async () => {
    env = await makeEnv({ 'a.jpg': 'x', 'b.jpg': 'y' })
    const A = pkg(env, 'Anna')
    await assign(env, [[mediaId(env, 'a.jpg'), A]])
    updateProjectSettings(env.ctx, env.projectId, { workMode: 'instant', operation: 'move', conflictPolicy: 'skip' })
    saveUiState(env.ctx, env.projectId, { filters: { ...DEFAULT_FILTERS, kinds: ['raw'] }, sort: { key: 'date', dir: 'desc' }, sourceId: null, view: 'focus' })
    updateSettings(env.ctx, { theme: 'dark', quickAssign: 'advance', layout: { leftWidth: 300, rightWidth: 350, leftCollapsed: true, rightCollapsed: false } })
    await env.restart()
    const p = getProject(env.ctx, env.projectId)
    expect(p).toMatchObject({ workMode: 'instant', operation: 'move', conflictPolicy: 'skip' })
    expect(p.ui.filters.kinds).toEqual(['raw'])
    expect(p.ui.sort).toEqual({ key: 'date', dir: 'desc' })
    expect(listAssignments(env.ctx, env.projectId)).toEqual([[mediaId(env, 'a.jpg'), A]])
    const s = getSettings(env.ctx)
    expect(s.theme).toBe('dark')
    expect(s.layout.leftWidth).toBe(300)
    expect(listPackages(env.ctx, env.projectId)[0]).toMatchObject({ name: 'Anna', shortcut: 1, mediaCount: 1 })
  })

  it('mehrere Projekte, Umbenennen, Löschen ohne Dateiverlust', async () => {
    env = await makeEnv({ 'a.jpg': content('a') })
    const second = createProject(env.ctx, 'Zweites')
    renameProject(env.ctx, second.id, 'Zweites Projekt')
    expect(listProjects(env.ctx).map((p) => p.name).sort()).toEqual(['Testprojekt', 'Zweites Projekt'])
    const A = pkg(env, 'Anna')
    await assign(env, [[mediaId(env, 'a.jpg'), A]])
    await exportAll(env, 'move')
    const r = deleteProject(env.ctx, env.projectId)
    expect(r.recoveryFiles).toBe(1)
    expect(r.recoveryDirKept).not.toBeNull()
    expect(fs.readdirSync(path.join(env.outDir, 'Anna'))).toEqual(['a.jpg'])
    expect(listProjects(env.ctx)).toHaveLength(1)
  })

  it('Paketverwaltung: Namen, Kürzel, Löschen', async () => {
    env = await makeEnv({ 'a.jpg': content('a') })
    const a = createPackage(env.ctx, env.projectId, 'Anna')
    const b = createPackage(env.ctx, env.projectId, 'Max')
    expect([a.shortcut, b.shortcut]).toEqual([1, 2])
    expect(() => createPackage(env!.ctx, env!.projectId, 'anna')).toThrow(/existiert/)
    expect(() => createPackage(env!.ctx, env!.projectId, '  ')).toThrow()
    // Kürzel tauschen
    updatePackage(env.ctx, b.id, { shortcut: 1 })
    const list = listPackages(env.ctx, env.projectId)
    expect(list.find((p) => p.id === a.id)!.shortcut).toBe(2)
    expect(list.find((p) => p.id === b.id)!.shortcut).toBe(1)
    expect(list.find((p) => p.id === a.id)!.effectiveTargetDir).toBe(path.join(env.outDir, 'Anna'))
    await assign(env, [[mediaId(env, 'a.jpg'), a.id]])
    await exportAll(env)
    const del = deletePackage(env.ctx, a.id)
    expect(del.removedAssignments).toBe(1)
    expect(fs.existsSync(path.join(env.outDir, 'Anna', 'a.jpg'))).toBe(true)
  })

  it('Migrationen: Schema-Version, WAL, Fremdschlüssel', () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-tests', 'db-'))
    try {
      const db = openDatabase(path.join(dir, 'x.sqlite'))
      expect(schemaVersion(db)).toBe(MIGRATIONS.length)
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      const ctx = createContext({ db, fileOps: inlineFileOps, dataDir: dir })
      const p = createProject(ctx, 'X')
      createPackage(ctx, p.id, 'P')
      db.prepare('DELETE FROM projects WHERE id = ?').run(p.id)
      expect((db.prepare('SELECT COUNT(*) AS n FROM packages').get() as { n: number }).n).toBe(0)
      db.close()
      // erneutes Öffnen migriert nicht doppelt
      const db2 = openDatabase(path.join(dir, 'x.sqlite'))
      expect(schemaVersion(db2)).toBe(MIGRATIONS.length)
      db2.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
