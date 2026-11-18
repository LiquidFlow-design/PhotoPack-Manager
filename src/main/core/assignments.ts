import type { AssignmentDelta, AssignmentPair, AssignResult } from '@shared/types'
import { oplog, type CoreContext } from './context'
import type { TransferEngine } from './engine'
import { buildPlan } from './planner'
import { getProject } from './projects'

export class AssignmentError extends Error {}

export function listAssignments(ctx: CoreContext, projectId: string): AssignmentPair[] {
  const rows = ctx.db
    .prepare('SELECT mp.media_id, mp.package_id FROM media_packages mp JOIN packages k ON k.id = mp.package_id WHERE k.project_id = ?')
    .all(projectId) as Array<{ media_id: number; package_id: string }>
  return rows.map((r) => [r.media_id, r.package_id])
}

export function listExported(ctx: CoreContext, projectId: string): AssignmentPair[] {
  const rows = ctx.db.prepare('SELECT media_id, package_id FROM transfer_destinations WHERE project_id = ? AND package_id IS NOT NULL').all(projectId) as Array<{
    media_id: number
    package_id: string
  }>
  return rows.map((r) => [r.media_id, r.package_id])
}

/**
 * Wendet Zuordnungsänderungen an. Im Sofortmodus werden für neue Zuordnungen sofort persistente
 * Aufträge erzeugt; bei entfernten Zuordnungen werden nur noch nicht gestartete Einträge storniert.
 * Bereits exportierte Dateien werden NIE gelöscht.
 */
export async function applyAssignments(ctx: CoreContext, engine: TransferEngine | null, projectId: string, delta: AssignmentDelta): Promise<AssignResult> {
  const project = getProject(ctx, projectId)
  const pkgIds = new Set((ctx.db.prepare('SELECT id FROM packages WHERE project_id = ?').all(projectId) as Array<{ id: string }>).map((r) => r.id))
  const mediaOk = ctx.db.prepare('SELECT 1 FROM media WHERE id = ? AND project_id = ?')
  const check = (pairs: AssignmentPair[]) => {
    for (const [m, p] of pairs) {
      if (!pkgIds.has(p)) throw new AssignmentError('Unbekanntes Paket.')
      if (!mediaOk.get(m, projectId)) throw new AssignmentError('Unbekanntes Medium.')
    }
  }
  check(delta.added)
  check(delta.removed)

  const t = ctx.now()
  const applied: AssignmentDelta = { added: [], removed: [] }
  let keptExports = 0
  ctx.db.transaction(() => {
    const ins = ctx.db.prepare('INSERT OR IGNORE INTO media_packages (media_id, package_id, assigned_at) VALUES (?,?,?)')
    const del = ctx.db.prepare('DELETE FROM media_packages WHERE media_id = ? AND package_id = ?')
    const exported = ctx.db.prepare('SELECT 1 FROM transfer_destinations WHERE media_id = ? AND package_id = ?')
    for (const [m, p] of delta.added) if (ins.run(m, p, t).changes) applied.added.push([m, p])
    for (const [m, p] of delta.removed) {
      if (del.run(m, p).changes) {
        applied.removed.push([m, p])
        if (exported.get(m, p)) keptExports++
      }
    }
  })()

  const notices: string[] = []
  let jobId: string | null = null
  let cancelledItems = 0
  if (keptExports) notices.push(`${keptExports} bereits exportierte Datei(en) bleiben im Zielordner erhalten.`)

  if (project.workMode === 'instant' && engine) {
    cancelledItems = engine.cancelPendingFor(applied.removed)
    if (cancelledItems) notices.push(`${cancelledItems} noch nicht gestartete Übertragung(en) storniert.`)
    if (applied.added.length) {
      const { preview, snapshot } = await buildPlan(
        ctx,
        projectId,
        { packageIds: null, operation: project.operation, conflictPolicy: project.conflictPolicy, reexportMissing: false },
        { pairs: applied.added }
      )
      if (preview.blockingErrors.length) {
        notices.push('Sofortauftrag nicht gestartet: ' + preview.blockingErrors.join(' ') + ' Die Zuordnung bleibt gespeichert.')
      } else if (snapshot.copies.length) {
        const names = [...new Set(snapshot.copies.map((c) => c.packageName))].join(', ')
        const label = `Sofort · ${project.operation === 'move' ? 'Verschieben' : 'Kopieren'} · ${snapshot.copies.length} → ${names}`
        jobId = engine.createJob(snapshot, 'instant', label).jobId
      }
      if (preview.missingSources) notices.push(`${preview.missingSources} Medium/Medien ohne erreichbare Quelle nicht übertragen.`)
    }
  }

  if (applied.added.length || applied.removed.length) {
    oplog(ctx, projectId, 'info', 'assign', 'project', projectId, { added: applied.added.length, removed: applied.removed.length, jobId })
    ctx.emit({ type: 'assignments-changed', projectId })
    ctx.emit({ type: 'packages-changed', projectId })
  }
  return { delta: applied, jobId, cancelledItems, keptExports, notices }
}
