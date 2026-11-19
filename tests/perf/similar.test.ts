// Laufzeit der Ähnlichkeitsgruppierung (12 000 Medien, Hashes bereits vorhanden).
import fs from 'node:fs'
import { expect, it } from 'vitest'
import { scanSimilar } from '../../src/main/core/similar'
import { makeEnv } from '../helpers/env'

it('Ähnlichkeitsgruppierung 12 000 Medien', async () => {
  const env = await makeEnv({})
  const ins = env.db.prepare(
    "INSERT INTO media (project_id, source_id, original_path, path_key, current_path, rel_dir, file_name, ext, kind, size, mtime_ms, imported_at, updated_at, phash) VALUES (?,?,?,?,?,'',?, 'jpg','image',1,1,1,1,?)"
  )
  env.db.transaction(() => {
    for (let i = 0; i < 12000; i++) {
      const base = (Math.floor(i / 3) * 2654435761) >>> 0 // je 3 Bilder ähnliche Serie
      const h = (base.toString(16).padStart(8, '0') + ((base ^ (i % 3)) >>> 0).toString(16).padStart(8, '0')).slice(0, 16)
      ins.run(env.projectId, env.sourceId, '/x/' + i, '/x/' + i, '/x/' + i, `IMG_${i}.jpg`, h)
    }
  })()
  let maxGap = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
  }, 10)
  const t = performance.now()
  const r = await scanSimilar(env.ctx, env.projectId, 8, async () => {})
  const ms = Math.round(performance.now() - t)
  clearInterval(timer)
  const prev = fs.existsSync('.tmp-tests/perf-results.json') ? JSON.parse(fs.readFileSync('.tmp-tests/perf-results.json', 'utf8')) : {}
  fs.writeFileSync('.tmp-tests/perf-results.json', JSON.stringify({ ...prev, similar_12k_ms: ms, similar_groups: r.groups, similar_max_event_loop_gap_ms: Math.round(maxGap) }, null, 2))
  console.log({ ms, groups: r.groups, maxGap: Math.round(maxGap) })
  expect(r.groups).toBe(4000)
  env.cleanup()
}, 120000)
