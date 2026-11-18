import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyAssignments } from '../../src/main/core/assignments'
import { inlineFileOps, type FileOps } from '../../src/main/core/fileops'
import { TransferEngine } from '../../src/main/core/engine'
import { buildPlan } from '../../src/main/core/planner'
import { updateProjectSettings } from '../../src/main/core/projects'
import { assign, content, exportAll, items, jobStatus, listFiles, makeEnv, mediaId, pkg, readSha, sha, writeFile, type TestEnv } from '../helpers/env'

let env: TestEnv | null = null
afterEach(() => {
  env?.cleanup()
  env = null
})

function mediaRow(e: TestEnv, id: number) {
  return e.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as { location: string; current_path: string; sha256: string | null; original_path: string }
}

function noTempFiles(dir: string): boolean {
  return listFiles(dir).every((f) => !path.basename(f).startsWith('.ppm-'))
}

describe('Kopieren', () => {
  it('kopiert ein Medium verifiziert in ein Paket', async () => {
    const data = content('a', 50_000)
    env = await makeEnv({ 'a.jpg': data })
    const A = pkg(env, 'Anna')
    const m = mediaId(env, 'a.jpg')
    await assign(env, [[m, A]])
    const { jobId } = await exportAll(env)
    expect(jobStatus(env, jobId!)).toBe('completed')
    expect(listFiles(env.outDir)).toEqual(['Anna/a.jpg'])
    expect(readSha(path.join(env.outDir, 'Anna/a.jpg'))).toBe(sha(data))
    expect(fs.existsSync(path.join(env.srcDir, 'a.jpg'))).toBe(true)
    const d = env.db.prepare('SELECT * FROM transfer_destinations WHERE media_id = ?').all(m)
    expect(d).toHaveLength(1)
    expect(mediaRow(env, m).sha256).toBe(sha(data))
  })

  it('ein Medium in mehreren Paketen', async () => {
    env = await makeEnv({ 'x/a.jpg': content('a') })
    const A = pkg(env, 'Anna')
    const B = pkg(env, 'Max')
    const C = pkg(env, 'Familie')
    const m = mediaId(env, 'x/a.jpg')
    await assign(env, [
      [m, A],
      [m, B],
      [m, C]
    ])
    await exportAll(env)
    expect(listFiles(env.outDir)).toEqual(['Anna/a.jpg', 'Familie/a.jpg', 'Max/a.jpg'])
  })

  it('löst gleiche Dateinamen deterministisch auf', async () => {
    env = await makeEnv({ 'k1/IMG_1.jpg': content('1'), 'k2/IMG_1.jpg': content('2'), 'k3/IMG_1.jpg': content('3') })
    const A = pkg(env, 'Anna')
    const ids = ['k1/IMG_1.jpg', 'k2/IMG_1.jpg', 'k3/IMG_1.jpg'].map((r) => mediaId(env!, r))
    await assign(
      env,
      ids.map((i) => [i, A] as [number, string])
    )
    const { preview } = await exportAll(env)
    expect(preview.packages[0].nameCollisions).toBe(2)
    expect(listFiles(env.outDir)).toEqual(['Anna/IMG_1 (2).jpg', 'Anna/IMG_1 (3).jpg', 'Anna/IMG_1.jpg'])
    expect(readSha(path.join(env.outDir, 'Anna/IMG_1.jpg'))).toBe(sha(content('1')))
    expect(readSha(path.join(env.outDir, 'Anna/IMG_1 (2).jpg'))).toBe(sha(content('2')))
  })

  it('überspringt identische vorhandene Zieldatei, benennt abweichende um', async () => {
    env = await makeEnv({ 'a.jpg': content('a'), 'b.jpg': content('b') })
    writeFile(path.join(env.outDir, 'Anna/a.jpg'), content('a')) // identisch
    writeFile(path.join(env.outDir, 'Anna/b.jpg'), content('fremd')) // anderer Inhalt
    const A = pkg(env, 'Anna')
    await assign(env, [
      [mediaId(env, 'a.jpg'), A],
      [mediaId(env, 'b.jpg'), A]
    ])
    const { jobId } = await exportAll(env)
    const its = items(env, jobId!)
    expect(its.find((i) => i.fileName === 'a.jpg')!.status).toBe('skipped')
    expect(its.find((i) => i.fileName === 'a.jpg')!.note).toBe('identical')
    expect(listFiles(env.outDir)).toEqual(['Anna/a.jpg', 'Anna/b (2).jpg', 'Anna/b.jpg'])
    expect(readSha(path.join(env.outDir, 'Anna/b.jpg'))).toBe(sha(content('fremd'))) // nie überschrieben
  })

  it('Konfliktregel „überspringen“ überschreibt nichts', async () => {
    env = await makeEnv({ 'b.jpg': content('b') })
    writeFile(path.join(env.outDir, 'Anna/b.jpg'), content('fremd'))
    const A = pkg(env, 'Anna')
    await assign(env, [[mediaId(env, 'b.jpg'), A]])
    const { jobId } = await exportAll(env, 'copy', 'skip')
    expect(items(env, jobId!)[0].status).toBe('skipped')
    expect(listFiles(env.outDir)).toEqual(['Anna/b.jpg'])
    expect(readSha(path.join(env.outDir, 'Anna/b.jpg'))).toBe(sha(content('fremd')))
  })

  it('erkennt veränderte Quelle nach der Planung', async () => {
    env = await makeEnv({ 'a.jpg': content('a') })
    const A = pkg(env, 'Anna')
    await assign(env, [[mediaId(env, 'a.jpg'), A]])
    const { snapshot } = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'move', conflictPolicy: 'rename', reexportMissing: false })
    fs.writeFileSync(path.join(env.srcDir, 'a.jpg'), content('geändert', 3000))
    const { jobId } = env.engine.createJob(snapshot, 'collect', 't')
    await env.engine.waitIdle()
    const its = items(env, jobId!)
    expect(its.find((i) => i.kind === 'copy')!.errorCode).toBe('SOURCE_CHANGED')
    expect(its.find((i) => i.kind === 'release_source')!.errorCode).toBe('SOURCE_KEPT')
    expect(fs.existsSync(path.join(env.srcDir, 'a.jpg'))).toBe(true)
    expect(listFiles(env.outDir)).toEqual([])
    expect(jobStatus(env, jobId!)).toBe('completed_with_errors')
  })

  it('meldet fehlende Quelle', async () => {
    env = await makeEnv({ 'a.jpg': content('a') })
    const A = pkg(env, 'Anna')
    await assign(env, [[mediaId(env, 'a.jpg'), A]])
    const { snapshot } = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    fs.unlinkSync(path.join(env.srcDir, 'a.jpg'))
    const { jobId } = env.engine.createJob(snapshot, 'collect', 't')
    await env.engine.waitIdle()
    expect(items(env, jobId!)[0].errorCode).toBe('SOURCE_MISSING')
    // Plan nach dem Verschwinden: wird übersprungen und gemeldet
    const p2 = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    expect(p2.preview.missingSources).toBe(1)
    expect(p2.preview.totalItems).toBe(0)
  })

  it('blockiert Plan ohne Zielordner und bei unerreichbarem Ziel', async () => {
    env = await makeEnv({ 'a.jpg': content('a') })
    updateProjectSettings(env.ctx, env.projectId, { outputDir: null })
    const A = pkg(env, 'Anna')
    await assign(env, [[mediaId(env, 'a.jpg'), A]])
    let p = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    expect(p.preview.blockingErrors.length).toBeGreaterThan(0)
    // Ziel unterhalb einer Datei -> zur Laufzeit nicht anlegbar
    const blocker = path.join(env.root, 'blocker')
    fs.writeFileSync(blocker, 'x')
    updateProjectSettings(env.ctx, env.projectId, { outputDir: path.join(blocker, 'sub') })
    p = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    const { jobId } = env.engine.createJob(p.snapshot, 'collect', 't')
    await env.engine.waitIdle()
    expect(items(env, jobId!)[0].errorCode).toBe('TARGET_MISSING')
  })
})

describe('Verschieben mit Wiederherstellungsbereich', () => {
  it('Mehrfachzuordnung: Quelle erst nach allen Zielkopien entfernt', async () => {
    const data = content('m', 100_000)
    env = await makeEnv({ 'a.jpg': data })
    const A = pkg(env, 'Anna')
    const B = pkg(env, 'Max')
    const m = mediaId(env, 'a.jpg')
    await assign(env, [
      [m, A],
      [m, B]
    ])
    const order: string[] = []
    env.faults.on('copy:afterCommit', (c) => void order.push('copy:' + (c.final as string)))
    env.faults.on('release:afterSourceRemoved', () => void order.push('release'))
    const { jobId } = await exportAll(env, 'move')
    expect(jobStatus(env, jobId!)).toBe('completed')
    expect(order[order.length - 1]).toBe('release')
    expect(order.filter((o) => o.startsWith('copy:'))).toHaveLength(2)
    expect(fs.existsSync(path.join(env.srcDir, 'a.jpg'))).toBe(false)
    const row = mediaRow(env, m)
    expect(row.location).toBe('recovery')
    expect(readSha(row.current_path)).toBe(sha(data))
    expect(listFiles(env.outDir)).toEqual(['Anna/a.jpg', 'Max/a.jpg'])
    const rec = env.db.prepare('SELECT * FROM recovery_items WHERE media_id = ?').get(m) as { status: string; sha256: string }
    expect(rec.status).toBe('held')
    expect(rec.sha256).toBe(sha(data))
  })

  it('Sofortmodus: weiteres Paket nach dem ersten Verschieben wird aus dem Wiederherstellungsbereich bedient', async () => {
    const data = content('sofort', 80_000)
    env = await makeEnv({ 'a.jpg': data })
    updateProjectSettings(env.ctx, env.projectId, { workMode: 'instant', operation: 'move' })
    const A = pkg(env, 'Anna')
    const B = pkg(env, 'Max')
    const m = mediaId(env, 'a.jpg')
    const r1 = await assign(env, [[m, A]])
    expect(r1.jobId).not.toBeNull()
    await env.engine.waitIdle()
    expect(fs.existsSync(path.join(env.srcDir, 'a.jpg'))).toBe(false)
    expect(mediaRow(env, m).location).toBe('recovery')

    const r2 = await assign(env, [[m, B]])
    expect(r2.jobId).not.toBeNull()
    await env.engine.waitIdle()
    const its = items(env, r2.jobId!)
    expect(its.map((i) => i.kind)).toEqual(['copy']) // kein erneutes Verschieben
    expect(its[0].status).toBe('done')
    expect(listFiles(env.outDir)).toEqual(['Anna/a.jpg', 'Max/a.jpg'])
    expect(readSha(path.join(env.outDir, 'Max/a.jpg'))).toBe(sha(data))
    // Quelle weiterhin sicher im Wiederherstellungsbereich
    expect(readSha(mediaRow(env, m).current_path)).toBe(sha(data))
    // Kein Doppelexport: erneutes Zuordnen/Planen erzeugt nichts
    const p = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'move', conflictPolicy: 'rename', reexportMissing: false })
    expect(p.preview.totalItems).toBe(0)
    expect(p.preview.packages.reduce((a, x) => a + x.alreadyExported, 0)).toBe(2)
  })

  it('Sofortmodus: schnelle Folgezuordnungen (zwei Aufträge) verlieren nichts', async () => {
    const data = content('schnell', 30_000)
    env = await makeEnv({ 'a.jpg': data })
    updateProjectSettings(env.ctx, env.projectId, { workMode: 'instant', operation: 'move' })
    const A = pkg(env, 'Anna')
    const B = pkg(env, 'Max')
    const C = pkg(env, 'Familie')
    const m = mediaId(env, 'a.jpg')
    await assign(env, [[m, A]])
    await assign(env, [[m, B]])
    await assign(env, [[m, C]])
    await env.engine.waitIdle()
    expect(listFiles(env.outDir)).toEqual(['Anna/a.jpg', 'Familie/a.jpg', 'Max/a.jpg'])
    for (const f of listFiles(env.outDir)) expect(readSha(path.join(env.outDir, f))).toBe(sha(data))
    expect(mediaRow(env, m).location).toBe('recovery')
    expect(readSha(mediaRow(env, m).current_path)).toBe(sha(data))
    const releases = env.db.prepare("SELECT COUNT(*) AS n FROM job_items WHERE kind='release_source' AND status='done'").get() as { n: number }
    expect(releases.n).toBe(1)
  })

  it('Verschieben über Datenträgergrenzen (Kopie + Verifikation + Löschen)', async () => {
    const shm = '/dev/shm'
    if (!fs.existsSync(shm) || fs.statSync(shm).dev === fs.statSync(process.cwd()).dev) return
    const recDir = fs.mkdtempSync(path.join(shm, 'ppm-rec-'))
    try {
      const data = content('xdev', 70_000)
      env = await makeEnv({ 'a.jpg': data }, { recoveryDir: recDir })
      const A = pkg(env, 'Anna')
      const m = mediaId(env, 'a.jpg')
      await assign(env, [[m, A]])
      const { jobId } = await exportAll(env, 'move')
      expect(jobStatus(env, jobId!)).toBe('completed')
      const row = mediaRow(env, m)
      expect(row.current_path.startsWith(recDir)).toBe(true)
      expect(readSha(row.current_path)).toBe(sha(data))
      expect(fs.existsSync(path.join(env.srcDir, 'a.jpg'))).toBe(false)
      expect(noTempFiles(recDir)).toBe(true)
    } finally {
      fs.rmSync(recDir, { recursive: true, force: true })
    }
  })

  it('Fehler bei einer Zielkopie: Quelle bleibt erhalten', async () => {
    env = await makeEnv({ 'a.jpg': content('a') })
    const A = pkg(env, 'Anna')
    const blocker = path.join(env.root, 'blocker')
    fs.writeFileSync(blocker, 'x')
    const B = pkg(env, 'Max', path.join(blocker, 'max'))
    const m = mediaId(env, 'a.jpg')
    await assign(env, [
      [m, A],
      [m, B]
    ])
    const { snapshot } = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'move', conflictPolicy: 'rename', reexportMissing: false })
    const { jobId } = env.engine.createJob(snapshot, 'collect', 't')
    await env.engine.waitIdle()
    const its = items(env, jobId!)
    expect(its.find((i) => i.kind === 'release_source')!.errorCode).toBe('SOURCE_KEPT')
    expect(fs.existsSync(path.join(env.srcDir, 'a.jpg'))).toBe(true)
    expect(mediaRow(env, m).location).toBe('source')
    expect(listFiles(env.outDir)).toEqual(['Anna/a.jpg'])
  })

  it('Fehler nach atomarem Verschieben: Zustand bleibt konsistent', async () => {
    const data = content('nach-rename', 10_000)
    env = await makeEnv({ 'a.jpg': data })
    const A = pkg(env, 'Anna')
    const m = mediaId(env, 'a.jpg')
    await assign(env, [[m, A]])
    env.faults.on('release:afterSourceRemoved', () => {
      throw Object.assign(new Error('simulierter E/A-Fehler'), { code: 'EIO' })
    })
    const { jobId } = await exportAll(env, 'move')
    expect(jobStatus(env, jobId!)).toBe('completed')
    const row = mediaRow(env, m)
    expect(row.location).toBe('recovery')
    expect(readSha(row.current_path)).toBe(sha(data))
    expect((env.db.prepare('SELECT status FROM recovery_items WHERE media_id = ?').get(m) as { status: string }).status).toBe('held')
  })

  it('Entfernen einer Zuordnung löscht keine exportierte Datei', async () => {
    env = await makeEnv({ 'a.jpg': content('a') })
    const A = pkg(env, 'Anna')
    const m = mediaId(env, 'a.jpg')
    await assign(env, [[m, A]])
    await exportAll(env)
    const r = await applyAssignments(env.ctx, env.engine, env.projectId, { added: [], removed: [[m, A]] })
    expect(r.keptExports).toBe(1)
    expect(listFiles(env.outDir)).toEqual(['Anna/a.jpg'])
  })
})

describe('Gesperrte Dateien, Speicherplatz, Wiederholung', () => {
  function flakyOps(failTimes: number, code: string): FileOps & { calls: number } {
    let n = 0
    const ops = {
      calls: 0,
      hashFile: inlineFileOps.hashFile,
      async copyWithHash(src: string, dst: string, signal?: AbortSignal) {
        ops.calls++
        if (n++ < failTimes) throw Object.assign(new Error(code), { code })
        return inlineFileOps.copyWithHash(src, dst, signal)
      }
    }
    return ops
  }

  it('gesperrte Datei: automatische Wiederholung', async () => {
    const ops = flakyOps(2, 'EBUSY')
    env = await makeEnv({ 'a.jpg': content('a') }, { fileOps: ops })
    env.engine = new TransferEngine(env.ctx, { retryDelays: [5, 5, 5] })
    env.engine.start()
    const A = pkg(env, 'Anna')
    await assign(env, [[mediaId(env, 'a.jpg'), A]])
    const { jobId } = await exportAll(env)
    // Wiederholungen laufen zeitverzögert
    for (let i = 0; i < 50 && jobStatus(env, jobId!) !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      env.clock.t += 1000
      await env.engine.waitIdle()
    }
    expect(jobStatus(env, jobId!)).toBe('completed')
    expect(items(env, jobId!)[0].attempts).toBe(3)
    expect(listFiles(env.outDir)).toEqual(['Anna/a.jpg'])
  })

  it('dauerhaft gesperrt: nach max. Versuchen fehlgeschlagen, keine Reste', async () => {
    const ops = flakyOps(99, 'EBUSY')
    env = await makeEnv({ 'a.jpg': content('a') }, { fileOps: ops })
    env.engine = new TransferEngine(env.ctx, { retryDelays: [5, 5, 5] })
    env.engine.start()
    const A = pkg(env, 'Anna')
    await assign(env, [[mediaId(env, 'a.jpg'), A]])
    const { jobId } = await exportAll(env)
    for (let i = 0; i < 50 && jobStatus(env, jobId!) === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      env.clock.t += 1000
      await env.engine.waitIdle()
    }
    expect(jobStatus(env, jobId!)).toBe('completed_with_errors')
    expect(items(env, jobId!)[0].errorCode).toBe('LOCKED')
    expect(noTempFiles(env.outDir)).toBe(true)
  })

  it('Speicher voll: Abbruch ohne Teildatei, Quelle bleibt (Move)', async () => {
    const ops = flakyOps(1, 'ENOSPC')
    env = await makeEnv({ 'a.jpg': content('a') }, { fileOps: ops })
    const A = pkg(env, 'Anna')
    await assign(env, [[mediaId(env, 'a.jpg'), A]])
    const { jobId } = await exportAll(env, 'move')
    const its = items(env, jobId!)
    expect(its[0].errorCode).toBe('DISK_FULL')
    expect(fs.existsSync(path.join(env.srcDir, 'a.jpg'))).toBe(true)
    expect(listFiles(env.outDir)).toEqual([])
    // Nach „Platz schaffen“: Wiederholen erfolgreich
    expect(env.engine.retryJob(jobId!)).toBe(2)
    await env.engine.waitIdle()
    expect(jobStatus(env, jobId!)).toBe('completed')
    expect(fs.existsSync(path.join(env.srcDir, 'a.jpg'))).toBe(false)
  })

  it('unzureichender Speicherplatz laut Platzprüfung blockiert den Plan', async () => {
    env = await makeEnv({ 'a.jpg': content('a') })
    const A = pkg(env, 'Anna', '/dev/shm/ppm-too-small-' + Date.now())
    await assign(env, [[mediaId(env, 'a.jpg'), A]])
    env.db.prepare('UPDATE media SET size = ?').run(1e15) // 1 PB – passt sicher nicht
    const p = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    expect(p.preview.volumes.some((v) => !v.ok)).toBe(true)
    expect(p.preview.blockingErrors.join(' ')).toMatch(/Speicherplatz/)
  })
})

describe('Auftragssteuerung und Idempotenz', () => {
  it('Snapshot bleibt bei Moduswechsel unverändert', async () => {
    env = await makeEnv({ 'a.jpg': content('a') })
    const A = pkg(env, 'Anna')
    const m = mediaId(env, 'a.jpg')
    await assign(env, [[m, A]])
    const { snapshot } = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    updateProjectSettings(env.ctx, env.projectId, { workMode: 'instant', operation: 'move' })
    const { jobId } = env.engine.createJob(snapshot, 'collect', 't')
    await env.engine.waitIdle()
    expect(items(env, jobId!).map((i) => i.kind)).toEqual(['copy'])
    expect(fs.existsSync(path.join(env.srcDir, 'a.jpg'))).toBe(true)
  })

  it('Moduswechsel während eines laufenden Sofortauftrags: Auftrag läuft weiter, kein Doppelexport', async () => {
    env = await makeEnv({ 'a.jpg': content('a'), 'b.jpg': content('b') })
    updateProjectSettings(env.ctx, env.projectId, { workMode: 'instant', operation: 'move' })
    const A = pkg(env, 'Anna')
    const e = env
    let switched = false
    env.faults.on('copy:afterTmpWritten', () => {
      if (!switched) {
        switched = true
        updateProjectSettings(e.ctx, e.projectId, { workMode: 'collect', operation: 'copy' })
      }
    })
    const r = await assign(env, [
      [mediaId(env, 'a.jpg'), A],
      [mediaId(env, 'b.jpg'), A]
    ])
    await env.engine.waitIdle()
    expect(switched).toBe(true)
    expect(jobStatus(env, r.jobId!)).toBe('completed')
    // Snapshot (Verschieben) wurde vollständig ausgeführt
    expect(fs.existsSync(path.join(env.srcDir, 'a.jpg'))).toBe(false)
    expect(listFiles(env.outDir)).toEqual(['Anna/a.jpg', 'Anna/b.jpg'])
    // Sammelexport danach: nichts mehr zu tun
    const p = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    expect(p.preview.totalItems).toBe(0)
    // Neue Zuordnung im Sammelmodus erzeugt keinen Sofortauftrag
    const B = pkg(env, 'Max')
    const r2 = await assign(env, [[mediaId(env, 'a.jpg'), B]])
    expect(r2.jobId).toBeNull()
  })

  it('Pause, Fortsetzen und Abbruch', async () => {
    env = await makeEnv({ 'a.jpg': content('a'), 'b.jpg': content('b'), 'c.jpg': content('c') })
    const A = pkg(env, 'Anna')
    await assign(
      env,
      ['a.jpg', 'b.jpg', 'c.jpg'].map((f) => [mediaId(env!, f), A] as [number, string])
    )
    const { snapshot } = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    const { jobId } = env.engine.createJob(snapshot, 'collect', 't')
    env.engine.pauseJob(jobId!)
    await env.engine.waitIdle()
    expect(jobStatus(env, jobId!)).toBe('paused')
    const doneBefore = items(env, jobId!).filter((i) => i.status === 'done').length
    expect(doneBefore).toBeLessThan(3)
    expect(noTempFiles(env.outDir)).toBe(true)
    env.engine.resumeJob(jobId!)
    await env.engine.waitIdle()
    expect(jobStatus(env, jobId!)).toBe('completed')
    expect(listFiles(env.outDir)).toHaveLength(3)

    // Abbruch eines zweiten Auftrags: erstellte Dateien bleiben
    const B = pkg(env, 'Max')
    await assign(
      env,
      ['a.jpg', 'b.jpg', 'c.jpg'].map((f) => [mediaId(env!, f), B] as [number, string])
    )
    const p2 = await buildPlan(env.ctx, env.projectId, { packageIds: [B], operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    const j2 = env.engine.createJob(p2.snapshot, 'collect', 't2').jobId!
    env.engine.cancelJob(j2)
    await env.engine.waitIdle()
    expect(jobStatus(env, j2)).toBe('cancelled')
    expect(noTempFiles(env.outDir)).toBe(true)
  })

  it('Idempotenz: doppelt angelegter Plan wird nicht doppelt ausgeführt', async () => {
    env = await makeEnv({ 'a.jpg': content('a') })
    const A = pkg(env, 'Anna')
    await assign(env, [[mediaId(env, 'a.jpg'), A]])
    const { snapshot } = await buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    env.engine.pauseJob(env.engine.createJob(snapshot, 'collect', 't1').jobId!)
    const second = env.engine.createJob(snapshot, 'collect', 't2')
    expect(second.jobId).toBeNull()
    expect(second.skippedActive).toBe(1)
  })

  it('Sofortmodus: Rückgängig storniert noch nicht gestartete Übertragung', async () => {
    env = await makeEnv({ 'a.jpg': content('a') })
    updateProjectSettings(env.ctx, env.projectId, { workMode: 'instant', operation: 'move' })
    const A = pkg(env, 'Anna')
    const m = mediaId(env, 'a.jpg')
    // Engine anhalten, damit der Auftrag noch nicht startet
    const eng = env.engine
    await eng.shutdown()
    const r = await assign(env, [[m, A]])
    const undo = await applyAssignments(env.ctx, eng, env.projectId, { added: [], removed: [[m, A]] })
    expect(undo.cancelledItems).toBe(1)
    const its = items(env, r.jobId!)
    expect(its.every((i) => i.status === 'cancelled')).toBe(true)
    expect(fs.existsSync(path.join(env.srcDir, 'a.jpg'))).toBe(true)
  })
})
