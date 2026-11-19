// Visuell ähnliche Medien: 64-Bit-Differenz-Hash (dHash) aus dem Vorschaubild, Gruppierung per Hamming-Distanz.
// Keine Löschung – nur Gruppierung zur Sichtung (z. B. Serienbilder).
import type { SimilarGroup } from '@shared/types'
import { oplog, type CoreContext } from './context'

/** dHash aus 9×8 Graustufenpixeln (Zeilenweise: links heller als rechts → 1). */
export function dhashFromPixels(px: Uint8Array | Buffer): string {
  let hi = 0
  let lo = 0
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const bit = px[y * 9 + x] > px[y * 9 + x + 1] ? 1 : 0
      const i = y * 8 + x
      if (i < 32) hi = (hi << 1) | bit
      else lo = (lo << 1) | bit
    }
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0')
}

function popcount(n: number): number {
  n = n - ((n >>> 1) & 0x55555555)
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

export function hamming(a: string, b: string): number {
  return popcount(parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) + popcount(parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16))
}

export async function scanSimilar(
  ctx: CoreContext,
  projectId: string,
  threshold: number,
  ensureHash: (mediaId: number) => Promise<void>,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void
): Promise<{ groups: number; hashed: number }> {
  const missing = ctx.db
    .prepare("SELECT id FROM media WHERE project_id = ? AND role = 'main' AND location != 'missing' AND phash IS NULL AND thumb_status != 'error' AND cloud_state = 'local'")
    .all(projectId) as Array<{ id: number }>
  let done = 0
  const total = missing.length
  onProgress?.(0, total)
  let idx = 0
  const worker = async () => {
    while (idx < missing.length && !signal?.aborted) {
      const m = missing[idx++]
      await ensureHash(m.id).catch(() => {})
      done++
      if (done % 25 === 0) onProgress?.(done, total)
    }
  }
  await Promise.all([worker(), worker(), worker()])
  if (signal?.aborted) return { groups: 0, hashed: done }

  const rows = ctx.db
    .prepare("SELECT id, phash FROM media WHERE project_id = ? AND role = 'main' AND location != 'missing' AND phash IS NOT NULL ORDER BY id")
    .all(projectId) as Array<{ id: number; phash: string }>
  const n = rows.length
  const hi = new Uint32Array(n)
  const lo = new Uint32Array(n)
  rows.forEach((r, i) => {
    hi[i] = parseInt(r.phash.slice(0, 8), 16) >>> 0
    lo[i] = parseInt(r.phash.slice(8), 16) >>> 0
  })
  // Union-Find
  const parent = new Int32Array(n).map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (popcount(hi[i] ^ hi[j]) + popcount(lo[i] ^ lo[j]) <= threshold) {
        const a = find(i)
        const b = find(j)
        if (a !== b) parent[b] = a
      }
    }
    // Event-Loop nicht blockieren
    if (i % 400 === 399) {
      await new Promise((r) => setImmediate(r))
      if (signal?.aborted) return { groups: 0, hashed: done }
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const g = groups.get(r) ?? []
    g.push(rows[i].id)
    groups.set(r, g)
  }
  let count = 0
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE media SET sim_group = NULL WHERE project_id = ?').run(projectId)
    const set = ctx.db.prepare('UPDATE media SET sim_group = ? WHERE id = ?')
    for (const ids of groups.values()) {
      if (ids.length < 2) continue
      count++
      const gid = Math.min(...ids)
      for (const id of ids) set.run(gid, id)
    }
  })()
  oplog(ctx, projectId, 'info', 'similar.scan', 'project', projectId, { groups: count, threshold, compared: n })
  ctx.emit({ type: 'media-changed', projectId, full: true })
  return { groups: count, hashed: done }
}

export function listSimilarGroups(ctx: CoreContext, projectId: string): SimilarGroup[] {
  const rows = ctx.db
    .prepare("SELECT sim_group, id FROM media WHERE project_id = ? AND sim_group IS NOT NULL AND role = 'main' ORDER BY sim_group, file_name")
    .all(projectId) as Array<{ sim_group: number; id: number }>
  const map = new Map<number, SimilarGroup>()
  for (const r of rows) {
    let g = map.get(r.sim_group)
    if (!g) map.set(r.sim_group, (g = { id: r.sim_group, mediaIds: [] }))
    g.mediaIds.push(r.id)
  }
  return [...map.values()].sort((a, b) => b.mediaIds.length - a.mediaIds.length)
}
