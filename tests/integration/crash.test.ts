// Simulierte Abstürze an jedem kritischen Punkt der Datei-Engine, anschließend Neustart mit Abgleich.
// Prüft: kein Datenverlust, kein Doppelexport, keine verwaisten Zwischendateien.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FaultPoint } from '../../src/main/core/faults'
import { createRecoveryRestore } from '../helpers/restore'
import { assign, content, exportAll, jobStatus, listFiles, makeEnv, mediaId, pkg, readSha, sha, type TestEnv } from '../helpers/env'

let env: TestEnv | null = null
afterEach(() => {
  env?.cleanup()
  env = null
})

const MOVE_POINTS: FaultPoint[] = [
  'copy:afterTmpCreated',
  'copy:afterTmpWritten',
  'copy:afterVerify',
  'copy:beforeCommit',
  'copy:afterCommit',
  'release:beforeMove',
  'release:afterSourceRemoved'
]

const XDEV_POINTS: FaultPoint[] = ['release:afterRecoveryCopy', 'release:afterRecoveryCommit', 'release:afterSourceRemoved']

async function runCrashScenario(point: FaultPoint, recoveryDir?: string) {
  const dataA = content('A-' + point, 120_000)
  const dataB = content('B-' + point, 90_000)
  env = await makeEnv({ 'a.jpg': dataA, 'sub/b.jpg': dataB }, { recoveryDir, concurrency: 1 })
  const P1 = pkg(env, 'Anna')
  const P2 = pkg(env, 'Max')
  const a = mediaId(env, 'a.jpg')
  const b = mediaId(env, 'sub/b.jpg')
  await assign(env, [
    [a, P1],
    [a, P2],
    [b, P1]
  ])
  env.faults.crashAt(point)
  const { jobId, crash } = await exportAll(env, 'move')
  expect(crash, `Absturz an ${point} erwartet`).not.toBeNull()

  // --- Neustart ---
  const rec = await env.restart()
  expect(rec.interruptedJobs).toBeGreaterThanOrEqual(1)
  expect(jobStatus(env, jobId!)).toBe('paused') // nicht blind weiterlaufen
  env.engine.resumeJob(jobId!)
  await env.engine.waitIdle()
  expect(jobStatus(env, jobId!)).toBe('completed')

  // Jede Zieldatei genau einmal, Inhalt korrekt
  expect(listFiles(env.outDir)).toEqual(['Anna/a.jpg', 'Anna/b.jpg', 'Max/a.jpg'])
  expect(readSha(path.join(env.outDir, 'Anna/a.jpg'))).toBe(sha(dataA))
  expect(readSha(path.join(env.outDir, 'Max/a.jpg'))).toBe(sha(dataA))
  expect(readSha(path.join(env.outDir, 'Anna/b.jpg'))).toBe(sha(dataB))
  // Quellen verschoben, aber vollständig im Wiederherstellungsbereich vorhanden
  for (const [id, data, rel] of [
    [a, dataA, 'a.jpg'],
    [b, dataB, 'sub/b.jpg']
  ] as const) {
    const m = env.db.prepare('SELECT location, current_path FROM media WHERE id = ?').get(id) as { location: string; current_path: string }
    expect(m.location).toBe('recovery')
    expect(readSha(m.current_path)).toBe(sha(data))
    expect(fs.existsSync(path.join(env.srcDir, rel))).toBe(false)
  }
  const held = env.db.prepare("SELECT COUNT(*) AS n FROM recovery_items WHERE status='held'").get() as { n: number }
  expect(held.n).toBe(2)
  // Keine Zwischendateien
  const recDir = recoveryDir ?? path.join(env.dataDir, 'recovery')
  for (const d of [env.outDir, recDir, env.srcDir]) {
    expect(listFiles(d).filter((f) => path.basename(f).startsWith('.ppm-'))).toEqual([])
  }
  // Recovery-Bereich enthält genau die zwei gehaltenen Dateien
  expect(listFiles(recDir).filter((f) => !f.endsWith('.sqlite'))).toHaveLength(2)
}

describe('Absturz während Export (gleicher Datenträger)', () => {
  for (const p of MOVE_POINTS) {
    it(`Absturz bei ${p}`, async () => {
      await runCrashScenario(p)
    })
  }
})

describe('Absturz während Verschieben über Datenträgergrenze', () => {
  const shm = '/dev/shm'
  const available = fs.existsSync(shm) && fs.statSync(shm).dev !== fs.statSync(process.cwd()).dev
  for (const p of XDEV_POINTS) {
    it.skipIf(!available)(`Absturz bei ${p} (Recovery auf anderem Datenträger)`, async () => {
      const recDir = fs.mkdtempSync(path.join(shm, 'ppm-crash-'))
      try {
        await runCrashScenario(p, recDir)
      } finally {
        fs.rmSync(recDir, { recursive: true, force: true })
      }
    })
  }
})

describe('Absturz während Wiederherstellung', () => {
  it('restore:afterCommit -> nach Neustart abgeschlossen, keine Doppeldatei', async () => {
    const data = content('restore', 40_000)
    env = await makeEnv({ 'a.jpg': data })
    const A = pkg(env, 'Anna')
    const m = mediaId(env, 'a.jpg')
    await assign(env, [[m, A]])
    await exportAll(env, 'move')
    expect(fs.existsSync(path.join(env.srcDir, 'a.jpg'))).toBe(false)
    env.faults.crashAt('restore:afterCommit')
    const { jobId } = await createRecoveryRestore(env, m)
    expect(await env.engine.waitIdle()).not.toBeNull()
    await env.restart()
    env.engine.resumeJob(jobId!)
    await env.engine.waitIdle()
    expect(jobStatus(env, jobId!)).toBe('completed')
    expect(listFiles(env.srcDir)).toEqual(['a.jpg'])
    expect(readSha(path.join(env.srcDir, 'a.jpg'))).toBe(sha(data))
    const r = env.db.prepare('SELECT status FROM recovery_items WHERE media_id = ?').get(m) as { status: string }
    expect(r.status).toBe('restored')
  })
})
