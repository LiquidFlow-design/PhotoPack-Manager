// Wiederherstellungsbereich: Übersicht, Freigabe, kontrollierte Bereinigung.
// Status: staging -> held -> (released) -> purged | restored ; staging -> discarded
//  held      = kanonische Quelle eines verschobenen Mediums; wird NIE automatisch gelöscht
//  released  = vom Nutzer freigegeben; nach Ablauf der Aufbewahrungsfrist automatisch löschbar
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { Project, RecoveryItemInfo, RecoveryOverview, RecoveryStatus } from '@shared/types'
import { oplog, type CoreContext } from './context'
import { exists, freeBytes, unlinkIfExists } from './fsx'
import { getProject } from './projects'
import { getSettings } from './settings'

interface RecRow {
  id: string
  project_id: string
  media_id: number | null
  file_name: string
  original_path: string
  recovery_path: string
  size: number
  sha256: string
  status: RecoveryStatus
  moved_at: number
  released_at: number | null
  retain_until: number | null
  restored_to: string | null
}

export class RecoveryError extends Error {}

export const VOLUME_RECOVERY_DIR = '.photopack-recovery'

/**
 * Wiederherstellungsbereich je Laufwerk (Windows): Liegt die Quelle auf einem anderen Laufwerk als der
 * Standardbereich, wird <Laufwerk>:\.photopack-recovery\<Projekt> verwendet – Verschieben ist dann eine
 * schnelle Umbenennung statt Kopie. Nicht für Netzwerkfreigaben und nicht bei individuell gesetztem Bereich.
 */
export function recoveryDirForSource(ctx: CoreContext, project: Project, srcPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || project.recoveryDirCustom || !getSettings(ctx).recoveryPerVolume) return project.recoveryDir
  const srcRoot = path.win32.parse(srcPath).root
  const recRoot = path.win32.parse(project.recoveryDir).root
  if (!/^[a-zA-Z]:\\$/.test(srcRoot)) return project.recoveryDir
  if (srcRoot.toLowerCase() === recRoot.toLowerCase()) return project.recoveryDir
  return path.win32.join(srcRoot, VOLUME_RECOVERY_DIR, project.id)
}

/** Ordner unter Windows verstecken (best effort). */
export async function hideVolumeRecoveryDir(dir: string): Promise<void> {
  if (process.platform !== 'win32') return
  const i = dir.toLowerCase().indexOf(VOLUME_RECOVERY_DIR)
  if (i < 0) return
  const root = dir.slice(0, i + VOLUME_RECOVERY_DIR.length)
  await new Promise<void>((resolve) => execFile('attrib', ['+h', root], { windowsHide: true, timeout: 5000 }, () => resolve()))
}

/** „Projekt abschließen“: alle gehaltenen Quellen freigeben. */
export function releaseAllHeld(ctx: CoreContext, projectId: string): { count: number; bytes: number } {
  const rows = ctx.db.prepare("SELECT id, size FROM recovery_items WHERE project_id = ? AND status = 'held'").all(projectId) as Array<{ id: string; size: number }>
  const count = releaseRecovery(ctx, projectId, rows.map((r) => r.id))
  return { count, bytes: rows.reduce((a, r) => a + r.size, 0) }
}

export async function recoveryOverview(ctx: CoreContext, projectId: string): Promise<RecoveryOverview> {
  const p = getProject(ctx, projectId)
  const rows = ctx.db
    .prepare("SELECT * FROM recovery_items WHERE project_id = ? AND status IN ('held','released','restored','purged') ORDER BY moved_at DESC LIMIT 5000")
    .all(projectId) as RecRow[]
  const items: RecoveryItemInfo[] = []
  let heldBytes = 0
  let releasedBytes = 0
  for (const r of rows) {
    const live = r.status === 'held' || r.status === 'released'
    if (r.status === 'held') heldBytes += r.size
    if (r.status === 'released') releasedBytes += r.size
    items.push({
      id: r.id,
      mediaId: r.media_id,
      fileName: r.file_name,
      originalPath: r.original_path,
      recoveryPath: r.recovery_path,
      size: r.size,
      status: r.status,
      movedAt: r.moved_at,
      releasedAt: r.released_at,
      retainUntil: r.retain_until,
      restoredTo: r.restored_to,
      exists: live ? await exists(r.recovery_path) : false
    })
  }
  const extraDirs = [
    ...new Set(
      rows
        .filter((r) => r.status === 'held' || r.status === 'released')
        .map((r) => {
          const i = r.recovery_path.toLowerCase().indexOf(VOLUME_RECOVERY_DIR)
          return i >= 0 ? r.recovery_path.slice(0, i + VOLUME_RECOVERY_DIR.length) : null
        })
        .filter((x): x is string => !!x)
    )
  ]
  return { dir: p.recoveryDir, extraDirs, items, heldBytes, releasedBytes, freeBytes: await freeBytes(p.recoveryDir), retentionDays: getSettings(ctx).recoveryRetentionDays }
}

/** Gehaltene Einträge freigeben: Aufbewahrungsfrist läuft (ab Verschiebung, mindestens bis jetzt + 1 Tag). */
export function releaseRecovery(ctx: CoreContext, projectId: string, ids: string[]): number {
  const t = ctx.now()
  const days = getSettings(ctx).recoveryRetentionDays
  let n = 0
  ctx.db.transaction(() => {
    for (const id of ids) {
      const r = ctx.db.prepare("SELECT * FROM recovery_items WHERE id = ? AND project_id = ? AND status = 'held'").get(id, projectId) as RecRow | undefined
      if (!r) continue
      const until = Math.max(r.moved_at + days * 86400000, t + 86400000)
      ctx.db.prepare("UPDATE recovery_items SET status='released', released_at=?, retain_until=?, updated_at=? WHERE id=?").run(t, until, t, id)
      n++
    }
  })()
  oplog(ctx, projectId, 'info', 'recovery.release', 'recovery', null, { count: n })
  ctx.emit({ type: 'recovery-changed', projectId })
  return n
}

/** Freigabe zurücknehmen (wieder als kanonische Quelle halten). */
export function holdRecovery(ctx: CoreContext, projectId: string, ids: string[]): number {
  const t = ctx.now()
  let n = 0
  for (const id of ids) {
    n += ctx.db.prepare("UPDATE recovery_items SET status='held', released_at=NULL, updated_at=? WHERE id=? AND project_id=? AND status='released'").run(t, id, projectId).changes
  }
  ctx.emit({ type: 'recovery-changed', projectId })
  return n
}

function inUseByActiveJob(ctx: CoreContext, r: RecRow): boolean {
  if (!r.media_id) return false
  const a = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM job_items WHERE media_id = ? AND active = 1 AND status NOT IN ('done','skipped','cancelled')")
    .get(r.media_id) as { n: number }
  const b = ctx.db.prepare("SELECT COUNT(*) AS n FROM job_items WHERE recovery_item_id = ? AND active = 1 AND status NOT IN ('done','skipped','cancelled')").get(r.id) as {
    n: number
  }
  return a.n + b.n > 0
}

/**
 * Löscht Dateien aus dem Wiederherstellungsbereich.
 * mode 'expired': nur freigegebene Einträge mit abgelaufener Frist (automatische Bereinigung).
 * mode 'manual':  ausgewählte Einträge, auch gehaltene – nur nach ausdrücklicher Bestätigung im UI.
 */
export async function purgeRecovery(ctx: CoreContext, projectId: string | null, mode: 'expired' | 'manual', ids?: string[]): Promise<{ purged: number; bytes: number; skipped: number }> {
  const t = ctx.now()
  let rows: RecRow[]
  if (mode === 'expired') {
    rows = (
      projectId
        ? ctx.db.prepare("SELECT * FROM recovery_items WHERE project_id = ? AND status='released' AND retain_until <= ?").all(projectId, t)
        : ctx.db.prepare("SELECT * FROM recovery_items WHERE status='released' AND retain_until <= ?").all(t)
    ) as RecRow[]
  } else {
    if (!ids?.length || !projectId) return { purged: 0, bytes: 0, skipped: 0 }
    rows = ids
      .map((id) => ctx.db.prepare("SELECT * FROM recovery_items WHERE id = ? AND project_id = ? AND status IN ('held','released')").get(id, projectId) as RecRow | undefined)
      .filter((x): x is RecRow => !!x)
  }
  let purged = 0
  let bytes = 0
  let skipped = 0
  for (const r of rows) {
    if (inUseByActiveJob(ctx, r)) {
      skipped++
      continue
    }
    try {
      await unlinkIfExists(r.recovery_path)
      await fs.promises.rmdir(path.dirname(r.recovery_path)).catch(() => {})
    } catch (e) {
      oplog(ctx, r.project_id, 'error', 'recovery.purge.failed', 'recovery', r.id, { message: (e as Error).message })
      skipped++
      continue
    }
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE recovery_items SET status='purged', purged_at=?, updated_at=? WHERE id=?").run(t, t, r.id)
      if (r.media_id) {
        // Medium hat keine kanonische Quelle mehr; spätere Exporte nutzen ggf. verifizierte Exportkopien
        ctx.db.prepare("UPDATE media SET location='missing', updated_at=? WHERE id=? AND location='recovery' AND current_path=?").run(t, r.media_id, r.recovery_path)
      }
    })()
    oplog(ctx, r.project_id, 'warn', mode === 'expired' ? 'recovery.purge.expired' : 'recovery.purge.manual', 'recovery', r.id, { file: r.recovery_path, size: r.size })
    purged++
    bytes += r.size
    ctx.emit({ type: 'recovery-changed', projectId: r.project_id })
    if (r.media_id) ctx.emit({ type: 'media-changed', projectId: r.project_id, mediaIds: [r.media_id] })
  }
  return { purged, bytes, skipped }
}
