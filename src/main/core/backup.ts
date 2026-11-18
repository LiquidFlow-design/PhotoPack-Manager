// Projekt-Sicherung: Export als gzip-komprimiertes JSON (.ppmproj) und Import (z. B. auf einem anderen PC).
// Es werden nur Datenbankinhalte gesichert – keine Mediendateien. Auftragsverläufe werden nicht übernommen.
import fs from 'node:fs'
import zlib from 'node:zlib'
import { oplog, type CoreContext } from './context'
import { getProject } from './projects'

export const BACKUP_FORMAT = 'photopack-project'
export const BACKUP_VERSION = 1

interface Backup {
  format: string
  version: number
  exportedAt: number
  project: Record<string, unknown>
  sources: Record<string, unknown>[]
  media: Record<string, unknown>[]
  packages: Record<string, unknown>[]
  mediaPackages: Record<string, unknown>[]
  destinations: Record<string, unknown>[]
  recovery: Record<string, unknown>[]
}

export class BackupError extends Error {}

export function exportProject(ctx: CoreContext, projectId: string, file: string): { media: number; packages: number } {
  getProject(ctx, projectId)
  const q = (sql: string) => ctx.db.prepare(sql).all(projectId) as Record<string, unknown>[]
  const b: Backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: ctx.now(),
    project: ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown>,
    sources: q('SELECT * FROM sources WHERE project_id = ?'),
    media: q('SELECT * FROM media WHERE project_id = ? ORDER BY id'),
    packages: q('SELECT * FROM packages WHERE project_id = ?'),
    mediaPackages: q('SELECT mp.* FROM media_packages mp JOIN packages k ON k.id = mp.package_id WHERE k.project_id = ?'),
    destinations: q('SELECT * FROM transfer_destinations WHERE project_id = ?'),
    recovery: q('SELECT * FROM recovery_items WHERE project_id = ?')
  }
  const data = zlib.gzipSync(Buffer.from(JSON.stringify(b)))
  const tmp = file + '.ppm-tmp'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
  oplog(ctx, projectId, 'info', 'project.export', 'project', projectId, { file })
  return { media: b.media.length, packages: b.packages.length }
}

function insertRow(ctx: CoreContext, table: string, row: Record<string, unknown>, allowed: Set<string>): number {
  const cols = Object.keys(row).filter((c) => allowed.has(c))
  const r = ctx.db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c] as never))
  return Number(r.lastInsertRowid)
}

function columns(ctx: CoreContext, table: string): Set<string> {
  return new Set((ctx.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name))
}

/**
 * Importiert ein gesichertes Projekt. Projekt-, Quellen- und Paket-IDs bleiben erhalten (UUIDs);
 * Medien erhalten neue IDs. Existiert das Projekt bereits, wird der Import abgelehnt, damit nie zwei
 * Projekte denselben Wiederherstellungsbereich verwalten.
 */
export function importProject(ctx: CoreContext, file: string): { projectId: string; name: string; media: number } {
  let b: Backup
  try {
    b = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as Backup
  } catch {
    throw new BackupError('Die Datei ist keine gültige PhotoPack-Projektsicherung.')
  }
  if (b.format !== BACKUP_FORMAT || typeof b.version !== 'number') throw new BackupError('Unbekanntes Dateiformat.')
  if (b.version > BACKUP_VERSION) throw new BackupError('Die Sicherung stammt aus einer neueren Programmversion.')
  const pid = String(b.project.id)
  if (ctx.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid)) {
    throw new BackupError('Dieses Projekt existiert bereits. Bitte das vorhandene Projekt zuerst löschen.')
  }
  const cols = {
    projects: columns(ctx, 'projects'),
    sources: columns(ctx, 'sources'),
    media: columns(ctx, 'media'),
    packages: columns(ctx, 'packages'),
    media_packages: columns(ctx, 'media_packages'),
    transfer_destinations: columns(ctx, 'transfer_destinations'),
    recovery_items: columns(ctx, 'recovery_items')
  }
  const idMap = new Map<number, number>()
  ctx.db.transaction(() => {
    insertRow(ctx, 'projects', { ...b.project, last_opened_at: ctx.now() }, cols.projects)
    for (const s of b.sources) insertRow(ctx, 'sources', { ...s, scan_status: 'idle' }, cols.sources)
    for (const p of b.packages) insertRow(ctx, 'packages', p, cols.packages)
    // Hauptmedien vor Sidecars (parent_id muss existieren)
    const sorted = [...b.media].sort((x, y) => (x.role === 'sidecar' ? 1 : 0) - (y.role === 'sidecar' ? 1 : 0))
    for (const m of sorted) {
      const old = Number(m.id)
      const row: Record<string, unknown> = { ...m }
      delete row.id
      row.parent_id = m.parent_id != null ? (idMap.get(Number(m.parent_id)) ?? null) : null
      row.pair_id = null
      row.sim_group = null
      row.thumb_status = 'none'
      idMap.set(old, insertRow(ctx, 'media', row, cols.media))
    }
    for (const m of b.media) {
      if (m.pair_id != null && idMap.has(Number(m.pair_id)))
        ctx.db.prepare('UPDATE media SET pair_id = ? WHERE id = ?').run(idMap.get(Number(m.pair_id)), idMap.get(Number(m.id)))
    }
    for (const mp of b.mediaPackages) {
      const mid = idMap.get(Number(mp.media_id))
      if (mid) insertRow(ctx, 'media_packages', { ...mp, media_id: mid }, cols.media_packages)
    }
    for (const d of b.destinations) {
      const mid = idMap.get(Number(d.media_id))
      if (mid) insertRow(ctx, 'transfer_destinations', { ...d, media_id: mid, job_item_id: null }, cols.transfer_destinations)
    }
    for (const r of b.recovery) {
      const mid = r.media_id != null ? (idMap.get(Number(r.media_id)) ?? null) : null
      insertRow(ctx, 'recovery_items', { ...r, media_id: mid, job_item_id: null }, cols.recovery_items)
    }
  })()
  oplog(ctx, pid, 'info', 'project.import', 'project', pid, { file, media: b.media.length })
  return { projectId: pid, name: String(b.project.name), media: b.media.length }
}
