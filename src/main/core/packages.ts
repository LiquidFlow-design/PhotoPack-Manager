import path from 'node:path'
import type { PackageInfo } from '@shared/types'
import { newId, oplog, type CoreContext } from './context'
import { sanitizeFileName } from './paths'
import { getProject } from './projects'

export class PackageError extends Error {}

export const PACKAGE_COLORS = ['#6ea8ff', '#b59cf5', '#f0a875', '#6fcfae', '#f27f9b', '#e6c860', '#5fc6dd', '#a3b5c9', '#d78ee0']

interface PackageRow {
  id: string
  project_id: string
  name: string
  color: string
  shortcut: number | null
  target_dir: string | null
  sort_order: number
}

export function effectiveTargetDir(outputDir: string | null, pkg: { name: string; target_dir: string | null }): string | null {
  if (pkg.target_dir) return pkg.target_dir
  if (!outputDir) return null
  return path.join(outputDir, sanitizeFileName(pkg.name))
}

export function listPackages(ctx: CoreContext, projectId: string): PackageInfo[] {
  const p = getProject(ctx, projectId)
  const rows = ctx.db
    .prepare(
      `SELECT k.*,
        (SELECT COUNT(*) FROM media_packages mp JOIN media m ON m.id = mp.media_id AND m.role = 'main' WHERE mp.package_id = k.id) AS media_count,
        (SELECT COUNT(*) FROM media_packages mp JOIN media m ON m.id = mp.media_id AND m.role = 'main'
           JOIN transfer_destinations d ON d.media_id = mp.media_id AND d.package_id = mp.package_id
           WHERE mp.package_id = k.id) AS exported_count,
        (SELECT COUNT(DISTINCT i.job_id) FROM job_items i WHERE i.package_id = k.id AND i.active = 1
           AND i.status NOT IN ('done','skipped','cancelled','failed')) AS active_jobs
       FROM packages k WHERE k.project_id = ? ORDER BY k.sort_order, k.created_at`
    )
    .all(projectId) as Array<PackageRow & { media_count: number; exported_count: number; active_jobs: number }>
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    shortcut: r.shortcut,
    targetDir: r.target_dir,
    effectiveTargetDir: effectiveTargetDir(p.outputDir, r),
    sortOrder: r.sort_order,
    mediaCount: r.media_count,
    exportedCount: r.exported_count,
    pendingCount: r.media_count - r.exported_count,
    activeJobCount: r.active_jobs
  }))
}

function validateName(ctx: CoreContext, projectId: string, name: string, exceptId?: string): string {
  const n = name.trim()
  if (!n) throw new PackageError('Der Paketname darf nicht leer sein.')
  if (n.length > 80) throw new PackageError('Der Paketname ist zu lang (max. 80 Zeichen).')
  const dup = ctx.db
    .prepare('SELECT id FROM packages WHERE project_id = ? AND lower(name) = lower(?) AND id != ?')
    .get(projectId, n, exceptId ?? '') as { id: string } | undefined
  if (dup) throw new PackageError(`Ein Paket mit dem Namen „${n}“ existiert bereits.`)
  const folder = sanitizeFileName(n).toLowerCase()
  const others = ctx.db.prepare('SELECT name FROM packages WHERE project_id = ? AND id != ? AND target_dir IS NULL').all(projectId, exceptId ?? '') as Array<{
    name: string
  }>
  if (others.some((o) => sanitizeFileName(o.name).toLowerCase() === folder))
    throw new PackageError('Der Name ergibt denselben Ordnernamen wie ein bestehendes Paket. Bitte anders benennen.')
  return n
}

function freeShortcut(ctx: CoreContext, projectId: string): number | null {
  const used = new Set((ctx.db.prepare('SELECT shortcut FROM packages WHERE project_id = ? AND shortcut IS NOT NULL').all(projectId) as Array<{ shortcut: number }>).map((r) => r.shortcut))
  for (let i = 1; i <= 9; i++) if (!used.has(i)) return i
  return null
}

export function createPackage(ctx: CoreContext, projectId: string, name: string, opts: { color?: string; shortcut?: number | null; targetDir?: string | null } = {}): PackageInfo {
  const n = validateName(ctx, projectId, name)
  const count = (ctx.db.prepare('SELECT COUNT(*) AS n FROM packages WHERE project_id = ?').get(projectId) as { n: number }).n
  const id = newId()
  const t = ctx.now()
  const shortcut = opts.shortcut === undefined ? freeShortcut(ctx, projectId) : opts.shortcut
  if (shortcut != null) checkShortcut(ctx, projectId, shortcut)
  ctx.db
    .prepare('INSERT INTO packages (id, project_id, name, color, shortcut, target_dir, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, projectId, n, opts.color ?? PACKAGE_COLORS[count % PACKAGE_COLORS.length], shortcut, opts.targetDir ?? null, count, t, t)
  oplog(ctx, projectId, 'info', 'package.create', 'package', id, { name: n })
  ctx.emit({ type: 'packages-changed', projectId })
  return listPackages(ctx, projectId).find((p) => p.id === id)!
}

function checkShortcut(ctx: CoreContext, projectId: string, s: number, exceptId?: string): void {
  if (!Number.isInteger(s) || s < 1 || s > 9) throw new PackageError('Tastenkürzel muss zwischen 1 und 9 liegen.')
  const other = ctx.db.prepare('SELECT name FROM packages WHERE project_id = ? AND shortcut = ? AND id != ?').get(projectId, s, exceptId ?? '') as
    | { name: string }
    | undefined
  if (other) throw new PackageError(`Taste ${s} ist bereits dem Paket „${other.name}“ zugewiesen.`)
}

export function updatePackage(
  ctx: CoreContext,
  packageId: string,
  patch: Partial<{ name: string; color: string; shortcut: number | null; targetDir: string | null; sortOrder: number }>
): PackageInfo {
  const row = ctx.db.prepare('SELECT * FROM packages WHERE id = ?').get(packageId) as PackageRow | undefined
  if (!row) throw new PackageError('Paket nicht gefunden.')
  const name = patch.name !== undefined ? validateName(ctx, row.project_id, patch.name, packageId) : row.name
  const shortcut = patch.shortcut !== undefined ? patch.shortcut : row.shortcut
  if (shortcut != null && (!Number.isInteger(shortcut) || shortcut < 1 || shortcut > 9)) throw new PackageError('Tastenkürzel muss zwischen 1 und 9 liegen.')
  if (patch.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(patch.color)) throw new PackageError('Ungültige Farbe.')
  ctx.db.transaction(() => {
    if (shortcut != null && patch.shortcut !== undefined && shortcut !== row.shortcut) {
      // Kürzel tauschen, falls ein anderes Paket es bereits nutzt
      const other = ctx.db.prepare('SELECT id FROM packages WHERE project_id = ? AND shortcut = ? AND id != ?').get(row.project_id, shortcut, packageId) as
        | { id: string }
        | undefined
      if (other) {
        ctx.db.prepare('UPDATE packages SET shortcut = NULL WHERE id = ?').run(packageId)
        ctx.db.prepare('UPDATE packages SET shortcut = ? WHERE id = ?').run(row.shortcut, other.id)
      }
    }
    ctx.db
      .prepare('UPDATE packages SET name=?, color=?, shortcut=?, target_dir=?, sort_order=?, updated_at=? WHERE id=?')
      .run(
        name,
        patch.color ?? row.color,
        shortcut,
        patch.targetDir !== undefined ? patch.targetDir : row.target_dir,
        patch.sortOrder ?? row.sort_order,
        ctx.now(),
        packageId
      )
  })()
  oplog(ctx, row.project_id, 'info', 'package.update', 'package', packageId, patch)
  ctx.emit({ type: 'packages-changed', projectId: row.project_id })
  return listPackages(ctx, row.project_id).find((p) => p.id === packageId)!
}

/**
 * Löscht ein Paket inkl. seiner Zuordnungen. Bereits exportierte Dateien bleiben unangetastet.
 * Noch nicht gestartete Auftragseinträge für das Paket werden abgebrochen; laufende blockieren.
 */
/** Reihenfolge der Pakete (Drag & Drop in der Seitenleiste). */
export function reorderPackages(ctx: CoreContext, projectId: string, ids: string[]): void {
  const upd = ctx.db.prepare('UPDATE packages SET sort_order = ? WHERE id = ? AND project_id = ?')
  ctx.db.transaction(() => ids.forEach((id, i) => upd.run(i, id, projectId)))()
  ctx.emit({ type: 'packages-changed', projectId })
}

export function deletePackage(ctx: CoreContext, packageId: string): { removedAssignments: number; cancelledItems: number } {
  const row = ctx.db.prepare('SELECT * FROM packages WHERE id = ?').get(packageId) as PackageRow | undefined
  if (!row) throw new PackageError('Paket nicht gefunden.')
  const running = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM job_items WHERE package_id = ? AND active = 1 AND status IN ('copying','verifying','committing')")
    .get(packageId) as { n: number }
  if (running.n) throw new PackageError('Für dieses Paket wird gerade übertragen. Bitte warten oder Auftrag pausieren.')
  const tx = ctx.db.transaction(() => {
    const t = ctx.now()
    const cancelled = ctx.db
      .prepare("UPDATE job_items SET status='cancelled', active=0, note='Paket gelöscht', updated_at=?, finished_at=? WHERE package_id = ? AND status IN ('pending','failed')")
      .run(t, t, packageId).changes
    const removed = ctx.db.prepare('DELETE FROM media_packages WHERE package_id = ?').run(packageId).changes
    ctx.db.prepare('DELETE FROM packages WHERE id = ?').run(packageId)
    return { removedAssignments: removed, cancelledItems: cancelled }
  })
  const r = tx()
  oplog(ctx, row.project_id, 'warn', 'package.delete', 'package', packageId, { name: row.name, ...r })
  ctx.emit({ type: 'packages-changed', projectId: row.project_id })
  ctx.emit({ type: 'assignments-changed', projectId: row.project_id })
  return r
}
