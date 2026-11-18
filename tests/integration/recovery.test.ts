import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { holdRecovery, purgeRecovery, recoveryOverview, releaseRecovery } from '../../src/main/core/recovery'
import { buildPlan } from '../../src/main/core/planner'
import { createRecoveryRestore } from '../helpers/restore'
import { assign, content, exportAll, jobStatus, listFiles, makeEnv, mediaId, pkg, readSha, sha, writeFile, type TestEnv } from '../helpers/env'

let env: TestEnv | null = null
afterEach(() => {
  env?.cleanup()
  env = null
})

const DAY = 86400000

async function movedEnv() {
  const data = content('r', 20_000)
  env = await makeEnv({ 'dir/a.jpg': data })
  const A = pkg(env, 'Anna')
  const m = mediaId(env, 'dir/a.jpg')
  await assign(env, [[m, A]])
  await exportAll(env, 'move')
  const rec = env.db.prepare('SELECT * FROM recovery_items WHERE media_id = ?').get(m) as { id: string; recovery_path: string; status: string }
  return { e: env, data, m, A, rec }
}

describe('Wiederherstellungsbereich', () => {
  it('Wiederherstellung zum Originalpfad', async () => {
    const { e, data, m } = await movedEnv()
    expect(fs.existsSync(path.join(e.srcDir, 'dir/a.jpg'))).toBe(false)
    const { jobId } = await createRecoveryRestore(e, m)
    await e.engine.waitIdle()
    expect(jobStatus(e, jobId!)).toBe('completed')
    expect(readSha(path.join(e.srcDir, 'dir/a.jpg'))).toBe(sha(data))
    const row = e.db.prepare('SELECT location, current_path FROM media WHERE id = ?').get(m) as { location: string; current_path: string }
    expect(row.location).toBe('source')
    expect(row.current_path).toBe(path.join(e.srcDir, 'dir/a.jpg'))
    // Exportierte Datei bleibt
    expect(listFiles(e.outDir)).toEqual(['Anna/a.jpg'])
  })

  it('Wiederherstellung mit Konflikt am Originalpfad -> neuer Name, nichts überschrieben', async () => {
    const { e, data, m } = await movedEnv()
    writeFile(path.join(e.srcDir, 'dir/a.jpg'), 'neue fremde Datei')
    await createRecoveryRestore(e, m)
    await e.engine.waitIdle()
    expect(fs.readFileSync(path.join(e.srcDir, 'dir/a.jpg'), 'utf8')).toBe('neue fremde Datei')
    expect(readSha(path.join(e.srcDir, 'dir/a (2).jpg'))).toBe(sha(data))
  })

  it('Wiederherstellung in alternativen Ordner', async () => {
    const { e, data, m } = await movedEnv()
    const alt = path.join(e.root, 'alternativ')
    await createRecoveryRestore(e, m, alt)
    await e.engine.waitIdle()
    expect(readSha(path.join(alt, 'a.jpg'))).toBe(sha(data))
  })

  it('gehaltene Einträge werden nie automatisch bereinigt, auch nach Fristablauf', async () => {
    const { e, rec } = await movedEnv()
    e.clock.t += 400 * DAY
    const r = await purgeRecovery(e.ctx, null, 'expired')
    expect(r.purged).toBe(0)
    expect(fs.existsSync(rec.recovery_path)).toBe(true)
  })

  it('freigegebene Einträge: Bereinigung erst nach Ablauf der 30 Tage', async () => {
    const { e, rec, m } = await movedEnv()
    expect(releaseRecovery(e.ctx, e.projectId, [rec.id])).toBe(1)
    e.clock.t += 29 * DAY
    expect((await purgeRecovery(e.ctx, null, 'expired')).purged).toBe(0)
    e.clock.t += 2 * DAY
    const r = await purgeRecovery(e.ctx, null, 'expired')
    expect(r.purged).toBe(1)
    expect(fs.existsSync(rec.recovery_path)).toBe(false)
    const row = e.db.prepare('SELECT location FROM media WHERE id = ?').get(m) as { location: string }
    expect(row.location).toBe('missing')
    const log = e.db.prepare("SELECT COUNT(*) AS n FROM operation_log WHERE action = 'recovery.purge.expired'").get() as { n: number }
    expect(log.n).toBe(1)
  })

  it('Freigabe kurz vor Fristende verlängert die Aufbewahrung auf mindestens einen Tag', async () => {
    const { e, rec } = await movedEnv()
    e.clock.t += 40 * DAY
    releaseRecovery(e.ctx, e.projectId, [rec.id])
    expect((await purgeRecovery(e.ctx, null, 'expired')).purged).toBe(0)
    holdRecovery(e.ctx, e.projectId, [rec.id])
    e.clock.t += 5 * DAY
    expect((await purgeRecovery(e.ctx, null, 'expired')).purged).toBe(0)
  })

  it('nach Bereinigung bedient eine verifizierte Exportkopie spätere Paketzuordnungen', async () => {
    const { e, rec, m, data } = await movedEnv()
    await purgeRecovery(e.ctx, e.projectId, 'manual', [rec.id])
    const B = pkg(e, 'Max')
    await assign(e, [[m, B]])
    const p = await buildPlan(e.ctx, e.projectId, { packageIds: [B], operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    expect(p.preview.missingSources).toBe(0)
    expect(p.preview.warnings.join(' ')).toMatch(/Exportkopie/)
    const { jobId } = e.engine.createJob(p.snapshot, 'collect', 't')
    await e.engine.waitIdle()
    expect(jobStatus(e, jobId!)).toBe('completed')
    expect(readSha(path.join(e.outDir, 'Max/a.jpg'))).toBe(sha(data))
    // Wird die Exportkopie verändert, wird sie nicht als Quelle akzeptiert
    const C = pkg(e, 'Familie')
    await assign(e, [[m, C]])
    fs.writeFileSync(path.join(e.outDir, 'Anna/a.jpg'), content('manipuliert', 20_000))
    fs.unlinkSync(path.join(e.outDir, 'Max/a.jpg'))
    const p3 = await buildPlan(e.ctx, e.projectId, { packageIds: [C], operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    const j3 = e.engine.createJob(p3.snapshot, 'collect', 't3').jobId!
    await e.engine.waitIdle()
    expect(e.engine.listItems(j3)[0].errorCode).toBe('SOURCE_CHANGED')
    expect(fs.existsSync(path.join(e.outDir, 'Familie/a.jpg'))).toBe(false)
  })

  it('Übersicht liefert Größen und Status', async () => {
    const { e } = await movedEnv()
    const o = await recoveryOverview(e.ctx, e.projectId)
    expect(o.items).toHaveLength(1)
    expect(o.items[0].status).toBe('held')
    expect(o.items[0].exists).toBe(true)
    expect(o.heldBytes).toBe(20_000)
    expect(o.retentionDays).toBe(30)
  })
})
