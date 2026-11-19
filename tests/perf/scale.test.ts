// Skalierung: 12.000 synthetische Medien. Misst Indexierung, Laden, Filtern, Planung, Export, Duplikatprüfung.
// Ergebnisse werden nach .tmp-tests/perf-results.json geschrieben (Grundlage für TEST_REPORT.md).
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildIndex } from '../../src/shared/assignment'
import { DEFAULT_FILTERS, filterAndSort } from '../../src/shared/filters'
import type { MediaRow } from '../../src/shared/types'
import { scanSource } from '../../src/main/core/sources'
import { buildPlan } from '../../src/main/core/planner'
import { applyAssignments } from '../../src/main/core/assignments'
import { scanDuplicates } from '../../src/main/core/duplicates'
import { makeEnv, pkg, type TestEnv } from '../helpers/env'

const N = 12_000
const results: Record<string, number | string> = { media: N, node: process.version, platform: `${process.platform}-${process.arch}` }
let env: TestEnv

function time<T>(label: string, fn: () => T): T {
  const t = performance.now()
  const r = fn()
  results[label] = Math.round(performance.now() - t)
  return r
}
async function timeA<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now()
  const r = await fn()
  results[label] = Math.round(performance.now() - t)
  return r
}

afterAll(() => {
  fs.mkdirSync('.tmp-tests', { recursive: true })
  fs.writeFileSync('.tmp-tests/perf-results.json', JSON.stringify(results, null, 2))
  console.log(results)
  env?.cleanup()
})

describe(`Skalierung mit ${N} Medien`, () => {
  it('Indexierung', async () => {
    env = await makeEnv({})
    const exts = ['jpg', 'jpg', 'jpg', 'png', 'cr3', 'nef', 'mp4', 'arw']
    for (let i = 0; i < N; i++) {
      const dir = path.join(env.srcDir, `Ordner_${Math.floor(i / 500)}`)
      if (i % 500 === 0) fs.mkdirSync(dir, { recursive: true })
      // jede 50. Datei ist ein exaktes Duplikat einer anderen
      const body = i % 50 === 1 ? 'dup-content' : `inhalt-${i}-${'x'.repeat(i % 97)}`
      fs.writeFileSync(path.join(dir, `IMG_${String(i).padStart(5, '0')}.${exts[i % exts.length]}`), body)
    }
    const r = await timeA('scan_ms', () => scanSource(env.ctx, env.sourceId))
    expect(r.added).toBe(N)
    const r2 = await timeA('rescan_unchanged_ms', () => scanSource(env.ctx, env.sourceId))
    expect(r2.unchanged).toBe(N)
  })

  it('Medienliste laden und filtern/sortieren', () => {
    const rows = time(
      'load_rows_ms',
      () =>
        env.db
          .prepare(
            'SELECT id, source_id, file_name, ext, kind, rel_dir, size, mtime_ms, captured_at, width, height, duration_ms, location, thumb_status, thumb_error, dup_group, sha256 FROM media WHERE project_id = ?'
          )
          .all(env.projectId) as Array<Record<string, unknown>>
    )
    const media: MediaRow[] = rows.map((r) => ({
      id: r.id as number,
      sourceId: r.source_id as string,
      name: r.file_name as string,
      ext: r.ext as string,
      kind: r.kind as MediaRow['kind'],
      relDir: r.rel_dir as string,
      size: r.size as number,
      mtimeMs: r.mtime_ms as number,
      capturedAt: null,
      width: null,
      height: null,
      durationMs: null,
      location: 'source',
      thumbStatus: 'none',
      thumbError: null,
      dupGroup: null,
      hasHash: false,
      pairId: null,
      sidecars: 0,
      rating: 0,
      colorLabel: null,
      simGroup: null,
      cloudOnline: false
    }))
    results.ipc_payload_kb = Math.round(JSON.stringify(media).length / 1024)
    const ctx = { assignments: buildIndex([]), exported: buildIndex([]), allPackageIds: [], sourceId: null }
    time('filter_sort_all_name_ms', () => filterAndSort(media, DEFAULT_FILTERS, { key: 'name', dir: 'asc' }, ctx))
    time('filter_sort_search_kind_ms', () => filterAndSort(media, { ...DEFAULT_FILTERS, kinds: ['raw'], search: '12' }, { key: 'size', dir: 'desc' }, ctx))
  })

  it('Zuordnung von 12.000 Medien zu 3 Paketen', async () => {
    const pk = ['Anna', 'Max', 'Familie'].map((n) => pkg(env, n))
    const ids = (env.db.prepare('SELECT id FROM media').all() as Array<{ id: number }>).map((r) => r.id)
    const pairs: Array<[number, string]> = []
    ids.forEach((id, i) => {
      pairs.push([id, pk[i % 3]])
      if (i % 4 === 0) pairs.push([id, pk[(i + 1) % 3]])
    })
    results.assignment_pairs = pairs.length
    await timeA('assign_ms', () => applyAssignments(env.ctx, env.engine, env.projectId, { added: pairs, removed: [] }))
  })

  it('Duplikatprüfung', async () => {
    const r = await timeA('duplicates_ms', () => scanDuplicates(env.ctx, env.projectId))
    results.duplicate_groups = r.groups
    results.duplicate_candidates_hashed = r.hashed
    expect(r.groups).toBeGreaterThan(0)
  })

  it('Exportplan und Kopieren', async () => {
    const { preview, snapshot } = await timeA('plan_ms', () =>
      buildPlan(env.ctx, env.projectId, { packageIds: null, operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    )
    expect(preview.blockingErrors).toEqual([])
    results.plan_items = preview.totalItems
    const { jobId } = env.engine.createJob(snapshot, 'collect', 'perf')
    await timeA('export_copy_small_files_ms', () => env.engine.waitIdle())
    const st = env.db.prepare("SELECT COUNT(*) AS n FROM job_items WHERE job_id = ? AND status = 'done'").get(jobId) as { n: number }
    expect(st.n).toBe(preview.totalItems)
    results.export_items_per_s = Math.round(preview.totalItems / ((results.export_copy_small_files_ms as number) / 1000))
  }, 600000)

  it('Durchsatz große Dateien (20 × 32 MB, Kopieren + Verifikation)', async () => {
    const big = path.join(env.srcDir, 'Gross')
    fs.mkdirSync(big)
    const chunk = Buffer.alloc(32 * 1024 * 1024)
    for (let i = 0; i < 20; i++) {
      chunk.writeUInt32LE(i, 0)
      fs.writeFileSync(path.join(big, `VID_${i}.mp4`), chunk)
    }
    await scanSource(env.ctx, env.sourceId)
    const P = pkg(env, 'Gross')
    const ids = (env.db.prepare("SELECT id FROM media WHERE rel_dir = 'Gross'").all() as Array<{ id: number }>).map((r) => [r.id, P] as [number, string])
    await applyAssignments(env.ctx, env.engine, env.projectId, { added: ids, removed: [] })
    const { snapshot } = await buildPlan(env.ctx, env.projectId, { packageIds: [P], operation: 'copy', conflictPolicy: 'rename', reexportMissing: false })
    env.engine.createJob(snapshot, 'collect', 'gross')
    await timeA('export_large_640mb_ms', () => env.engine.waitIdle())
    results.export_large_mb_per_s = Math.round(640 / ((results.export_large_640mb_ms as number) / 1000))
  }, 600000)

})
