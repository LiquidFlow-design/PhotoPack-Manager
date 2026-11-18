import type { AssignmentDelta, AssignmentPair, AssignResult } from '@shared/types'
import { oplog, type CoreContext } from './context'
import type { TransferEngine } from './engine'
import { buildPlan } from './planner'
import { getProject } from './projects'
import { getSettings } from './settings'

export class AssignmentError extends Error {}

export function listAssignments(ctx: CoreContext, projectId: string): AssignmentPair[] {
  const rows = ctx.db
    .prepare('SELECT mp.media_id, mp.package_id FROM media_packages mp JOIN packages k ON k.id = mp.package_id WHERE k.project_id = ?')
    .all(projectId) as Array<{ media_id: number; package_id: string }>
  return rows.map((r) => [r.media_id, r.package_id])
}

/**
 * Erweitert Zuordnungsänderungen um verknüpfte Dateien:
 * RAW+JPEG-Partner (Einstellung „Paare gemeinsam“) und XMP-Sidecars (Einstellung „Sidecars mitnehmen“).
 */
export function expandDelta(ctx: CoreContext, delta: AssignmentDelta): AssignmentDelta {
  const s = getSettings(ctx)
  const pairOf = ctx.db.prepare('SELECT pair_id FROM media WHERE id = ?')
  const sidecarsOf = ctx.db.prepare("SELECT id FROM media WHERE parent_id = ? AND role = 'sidecar'")
  const expand = (pairs: AssignmentPair[]): AssignmentPair[] => {
    const out = new Map<string, AssignmentPair>()
    const add = (m: number, p: string) => out.set(`${m}:${p}`, [m, p])
    for (const [m, p] of pairs) {
      const mains = [m]
      if (s.pairRawJpeg) {
        const r = pairOf.get(m) as { pair_id: number | null } | undefined
        if (r?.pair_id) mains.push(r.pair_id)
      }
      for (const x of mains) {
        add(x, p)
        if (s.includeSidecars) for (const sc of sidecarsOf.all(x) as Array<{ id: number }>) add(sc.id, p)
      }
    }
    return [...out.values()]
  }
  return { added: expand(delta.added), removed: expand(delta.removed) }
}

/** Reihenfolge innerhalb eines Pakets (Hauptmedien, aufsteigend). */
export function packageOrder(ctx: CoreContext, packageId: string): number[] {
  return (
    ctx.db
      .prepare("SELECT mp.media_id FROM media_packages mp JOIN media m ON m.id = mp.media_id AND m.role = 'main' WHERE mp.package_id = ? ORDER BY mp.position, mp.assigned_at")
      .all(packageId) as Array<{ media_id: number }>
  ).map((r) => r.media_id)
}

/** Neue Reihenfolge setzen (vollständige oder teilweise Liste; nicht genannte Medien folgen dahinter). */
export function reorderPackage(ctx: CoreContext, packageId: string, orderedIds: number[]): number[] {
  const current = packageOrder(ctx, packageId)
  const member = new Set(current)
  const seen = new Set<number>()
  const order: number[] = []
  for (const id of orderedIds) if (member.has(id) && !seen.has(id)) (seen.add(id), order.push(id))
  for (const id of current) if (!seen.has(id)) order.push(id)
  const upd = ctx.db.prepare('UPDATE media_packages SET position = ? WHERE package_id = ? AND media_id = ?')
  ctx.db.transaction(() => order.forEach((id, i) => upd.run(i + 1, packageId, id)))()
  return order
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
  delta = expandDelta(ctx, delta)

  const t = ctx.now()
  const applied: AssignmentDelta = { added: [], removed: [] }
  let keptExports = 0
  ctx.db.transaction(() => {
    const ins = ctx.db.prepare('INSERT OR IGNORE INTO media_packages (media_id, package_id, assigned_at, position) VALUES (?,?,?,?)')
    const maxPos = new Map<string, number>()
    const nextPos = (p: string) => {
      let v = maxPos.get(p)
      if (v === undefined) v = (ctx.db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM media_packages WHERE package_id = ?').get(p) as { m: number }).m
      v += 1
      maxPos.set(p, v)
      return v
    }
    const del = ctx.db.prepare('DELETE FROM media_packages WHERE media_id = ? AND package_id = ?')
    const exported = ctx.db.prepare('SELECT 1 FROM transfer_destinations WHERE media_id = ? AND package_id = ?')
    for (const [m, p] of delta.added) if (ins.run(m, p, t, nextPos(p)).changes) applied.added.push([m, p])
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
        const delay = getSettings(ctx).instantDelaySec
        jobId = engine.createJob(snapshot, 'instant', label, { startAfter: delay > 0 ? ctx.now() + delay * 1000 : null }).jobId
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
