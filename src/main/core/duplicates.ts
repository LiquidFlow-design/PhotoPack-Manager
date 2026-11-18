// Exakte Duplikaterkennung: Gruppierung nach Größe, nur Kandidaten per SHA-256 hashen. Keine Löschung.
import type { DuplicateGroup } from '@shared/types'
import { oplog, type CoreContext } from './context'

export async function scanDuplicates(
  ctx: CoreContext,
  projectId: string,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
  parallel = 3
): Promise<{ groups: number; hashed: number; files: number; errors: number }> {
  const cands = ctx.db
    .prepare(
      `SELECT id, current_path, size, sha256 FROM media
       WHERE project_id = ? AND role = 'main' AND location != 'missing' AND size > 0
         AND size IN (SELECT size FROM media WHERE project_id = ? AND role = 'main' AND location != 'missing' AND size > 0 GROUP BY size HAVING COUNT(*) > 1)`
    )
    .all(projectId, projectId) as Array<{ id: number; current_path: string; size: number; sha256: string | null }>
  const todo = cands.filter((c) => !c.sha256)
  let done = 0
  let errors = 0
  const total = todo.length
  onProgress?.(0, total)
  const upd = ctx.db.prepare('UPDATE media SET sha256 = ?, hashed_at = ? WHERE id = ?')
  let idx = 0
  async function worker() {
    while (idx < todo.length && !signal?.aborted) {
      const c = todo[idx++]
      try {
        const h = await ctx.fileOps.hashFile(c.current_path, signal)
        if (h.size === c.size) upd.run(h.sha256, ctx.now(), c.id)
      } catch {
        errors++
      }
      done++
      if (done % 20 === 0 || done === total) onProgress?.(done, total)
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))
  if (signal?.aborted) return { groups: 0, hashed: done, files: cands.length, errors }

  // Gruppen setzen
  const groups = ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE media SET dup_group = NULL WHERE project_id = ?').run(projectId)
    const g = ctx.db
      .prepare("SELECT sha256 FROM media WHERE project_id = ? AND role = 'main' AND sha256 IS NOT NULL AND location != 'missing' GROUP BY sha256 HAVING COUNT(*) > 1")
      .all(projectId) as Array<{ sha256: string }>
    const set = ctx.db.prepare("UPDATE media SET dup_group = ? WHERE project_id = ? AND role = 'main' AND sha256 = ? AND location != 'missing'")
    for (const x of g) set.run(x.sha256, projectId, x.sha256)
    return g.length
  })()
  oplog(ctx, projectId, 'info', 'duplicates.scan', 'project', projectId, { groups, hashed: done, errors })
  ctx.emit({ type: 'media-changed', projectId, full: true })
  return { groups, hashed: done, files: cands.length, errors }
}

export function listDuplicateGroups(ctx: CoreContext, projectId: string): DuplicateGroup[] {
  const rows = ctx.db
    .prepare('SELECT dup_group, size, id FROM media WHERE project_id = ? AND dup_group IS NOT NULL ORDER BY size DESC, dup_group, file_name')
    .all(projectId) as Array<{ dup_group: string; size: number; id: number }>
  const map = new Map<string, DuplicateGroup>()
  for (const r of rows) {
    let g = map.get(r.dup_group)
    if (!g) map.set(r.dup_group, (g = { sha256: r.dup_group, size: r.size, mediaIds: [] }))
    g.mediaIds.push(r.id)
  }
  return [...map.values()]
}
