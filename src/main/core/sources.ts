import fs from 'node:fs'
import path from 'node:path'
import { extOf, kindForExt } from '@shared/media-kinds'
import type { Source } from '@shared/types'
import { newId, oplog, thumbsDir, type CoreContext } from './context'
import { isInside, isOwnTempFile, pathKey, realPathOrSelf, SKIP_DIR_NAMES } from './paths'
import { getProject } from './projects'

export class SourceError extends Error {}

interface SourceRow {
  id: string
  project_id: string
  path: string
  real_path: string
  added_at: number
  last_scan_at: number | null
  scan_status: Source['scanStatus']
  scan_error: string | null
  file_count: number
  skipped_links: number
  excluded_json: string
}

function toSource(r: SourceRow): Source {
  return {
    id: r.id,
    projectId: r.project_id,
    path: r.path,
    addedAt: r.added_at,
    lastScanAt: r.last_scan_at,
    scanStatus: r.scan_status,
    scanError: r.scan_error,
    fileCount: r.file_count,
    skippedLinks: r.skipped_links,
    excludedPaths: JSON.parse(r.excluded_json) as string[]
  }
}

export function listSources(ctx: CoreContext, projectId: string): Source[] {
  return (ctx.db.prepare('SELECT * FROM sources WHERE project_id = ? ORDER BY added_at').all(projectId) as SourceRow[]).map(toSource)
}

export function getSource(ctx: CoreContext, id: string): Source {
  const r = ctx.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined
  if (!r) throw new SourceError('Quelle nicht gefunden.')
  return toSource(r)
}

/**
 * Alle Verzeichnisse, die niemals als Medienquelle indexiert werden dürfen:
 * globaler Ausgabeordner, individuelle Paketziele, Wiederherstellungsbereich, App-Datenordner.
 */
export async function protectedDirs(ctx: CoreContext, projectId: string): Promise<string[]> {
  const p = getProject(ctx, projectId)
  const dirs = [ctx.dataDir, p.recoveryDir]
  if (p.outputDir) dirs.push(p.outputDir)
  const targets = ctx.db.prepare('SELECT target_dir FROM packages WHERE project_id = ? AND target_dir IS NOT NULL').all(projectId) as Array<{ target_dir: string }>
  for (const t of targets) dirs.push(t.target_dir)
  const out: string[] = []
  for (const d of dirs) {
    out.push(path.resolve(d))
    const real = await realPathOrSelf(d)
    if (pathKey(real) !== pathKey(d)) out.push(real)
  }
  return out
}

export interface SourceCheck {
  ok: boolean
  realPath: string
  error: string | null
  /** Geschützte Ordner (Ausgabe/Recovery), die innerhalb der Quelle liegen und ausgeschlossen werden. */
  exclusions: string[]
}

export async function checkSourcePath(ctx: CoreContext, projectId: string, dir: string): Promise<SourceCheck> {
  const abs = path.resolve(dir)
  let st: fs.Stats
  try {
    st = await fs.promises.stat(abs)
  } catch {
    return { ok: false, realPath: abs, error: 'Der Ordner existiert nicht oder ist nicht erreichbar.', exclusions: [] }
  }
  if (!st.isDirectory()) return { ok: false, realPath: abs, error: 'Der gewählte Pfad ist kein Ordner.', exclusions: [] }
  const real = await realPathOrSelf(abs)
  if (path.parse(real).root === real) {
    return { ok: false, realPath: real, error: 'Ein komplettes Laufwerk kann nicht als Quelle verwendet werden. Bitte einen Unterordner wählen.', exclusions: [] }
  }
  for (const s of listSources(ctx, projectId)) {
    const sReal = (ctx.db.prepare('SELECT real_path FROM sources WHERE id = ?').get(s.id) as { real_path: string }).real_path
    if (isInside(real, sReal)) return { ok: false, realPath: real, error: `Der Ordner ist bereits über die Quelle „${s.path}“ enthalten.`, exclusions: [] }
    if (isInside(sReal, real))
      return { ok: false, realPath: real, error: `Der Ordner enthält die bestehende Quelle „${s.path}“. Bitte diese zuerst entfernen.`, exclusions: [] }
  }
  const prot = await protectedDirs(ctx, projectId)
  for (const d of prot) {
    if (isInside(real, d)) {
      return { ok: false, realPath: real, error: 'Der Ordner liegt in einem Ausgabe-, Wiederherstellungs- oder Programmdatenordner und kann nicht als Quelle dienen.', exclusions: [] }
    }
  }
  const exclusions = prot.filter((d) => isInside(d, real) && pathKey(d) !== pathKey(real))
  return { ok: true, realPath: real, error: null, exclusions: [...new Set(exclusions)] }
}

export async function addSource(ctx: CoreContext, projectId: string, dir: string, confirmExclusions = false): Promise<Source> {
  const chk = await checkSourcePath(ctx, projectId, dir)
  if (!chk.ok) throw new SourceError(chk.error!)
  if (chk.exclusions.length && !confirmExclusions) {
    throw new SourceError('Die Quelle enthält Ausgabe- oder Wiederherstellungsordner. Bestätigung für den Ausschluss erforderlich.')
  }
  const id = newId()
  ctx.db
    .prepare('INSERT INTO sources (id, project_id, path, real_path, added_at, excluded_json) VALUES (?,?,?,?,?,?)')
    .run(id, projectId, path.resolve(dir), chk.realPath, ctx.now(), JSON.stringify(chk.exclusions))
  oplog(ctx, projectId, 'info', 'source.add', 'source', id, { path: dir, exclusions: chk.exclusions })
  return getSource(ctx, id)
}

/**
 * Prüft, ob ein geplanter Ausgabe-/Zielordner in einer Quelle liegt. Dann ist eine explizite
 * Bestätigung nötig; der Ordner wird anschließend bei jeder Indexierung ausgeschlossen.
 */
export async function targetConflictsWithSources(ctx: CoreContext, projectId: string, target: string): Promise<{ insideSource: string | null; containsSource: string | null }> {
  const real = await realPathOrSelf(target)
  for (const s of ctx.db.prepare('SELECT path, real_path FROM sources WHERE project_id = ?').all(projectId) as Array<{ path: string; real_path: string }>) {
    if (isInside(real, s.real_path) || isInside(target, s.path)) return { insideSource: s.path, containsSource: null }
    if (isInside(s.real_path, real)) return { insideSource: null, containsSource: s.path }
  }
  return { insideSource: null, containsSource: null }
}

export function removeSource(ctx: CoreContext, sourceId: string): { removedMedia: number; keptMoved: number } {
  const s = getSource(ctx, sourceId)
  const active = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM job_items i JOIN media m ON m.id = i.media_id
       WHERE m.source_id = ? AND i.active = 1 AND i.status NOT IN ('done','skipped','cancelled')`
    )
    .get(sourceId) as { n: number }
  if (active.n > 0) throw new SourceError('Für Medien dieser Quelle laufen noch Aufträge.')
  const tx = ctx.db.transaction(() => {
    const kept = ctx.db.prepare("UPDATE media SET source_id = NULL WHERE source_id = ? AND location = 'recovery'").run(sourceId).changes
    const removed = ctx.db.prepare('DELETE FROM media WHERE source_id = ?').run(sourceId).changes
    ctx.db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId)
    return { removedMedia: removed, keptMoved: kept }
  })
  const r = tx()
  oplog(ctx, s.projectId, 'info', 'source.remove', 'source', sourceId, { path: s.path, ...r })
  return r
}

// ---------------- Indexierung ----------------

/** RAW+JPEG-Paare: gleicher Ordner, gleicher Basisname, genau ein RAW und ein JPEG/HEIC. */
export function computePairs(ctx: CoreContext, sourceId: string): number {
  const rows = ctx.db
    .prepare("SELECT id, rel_dir, file_name, kind, ext FROM media WHERE source_id = ? AND role = 'main' AND location != 'missing'")
    .all(sourceId) as Array<{ id: number; rel_dir: string; file_name: string; kind: string; ext: string }>
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const i = r.file_name.lastIndexOf('.')
    const k = `${r.rel_dir}|${(i > 0 ? r.file_name.slice(0, i) : r.file_name).toLowerCase()}`
    const g = groups.get(k) ?? []
    g.push(r)
    groups.set(k, g)
  }
  let pairs = 0
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE media SET pair_id = NULL WHERE source_id = ?').run(sourceId)
    const set = ctx.db.prepare('UPDATE media SET pair_id = ? WHERE id = ?')
    for (const g of groups.values()) {
      if (g.length !== 2) continue
      const raw = g.find((x) => x.kind === 'raw')
      const img = g.find((x) => x.kind === 'image' && PAIR_IMAGE_EXTS.has(x.ext))
      if (!raw || !img) continue
      set.run(img.id, raw.id)
      set.run(raw.id, img.id)
      pairs++
    }
  })()
  return pairs
}

export interface ScanProgress {
  files: number
  dirs: number
}

export interface ScanResult {
  added: number
  updated: number
  missing: number
  unchanged: number
  skippedLinks: number
  skippedDirs: number
  errors: string[]
}

interface FoundFile {
  full: string
  relDir: string
  name: string
  ext: string
  kind: 'image' | 'raw' | 'video'
  size: number
  mtimeMs: number
  role?: 'main' | 'sidecar'
  parentId?: number | null
}

const PAIR_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'jpe', 'heic', 'heif'])
const baseName = (n: string) => {
  const i = n.lastIndexOf('.')
  return (i > 0 ? n.slice(0, i) : n).toLowerCase()
}

export async function scanSource(ctx: CoreContext, sourceId: string, signal?: AbortSignal, onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
  const src = ctx.db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as SourceRow | undefined
  if (!src) throw new SourceError('Quelle nicht gefunden.')
  const projectId = src.project_id
  const result: ScanResult = { added: 0, updated: 0, missing: 0, unchanged: 0, skippedLinks: 0, skippedDirs: 0, errors: [] }

  try {
    const st = await fs.promises.stat(src.path)
    if (!st.isDirectory()) throw new Error('kein Ordner')
  } catch {
    ctx.db.prepare("UPDATE sources SET scan_status='unavailable', scan_error=? WHERE id=?").run('Quellordner nicht erreichbar (Laufwerk getrennt?)', sourceId)
    ctx.emit({ type: 'sources-changed', projectId })
    throw new SourceError('Quellordner nicht erreichbar: ' + src.path)
  }

  ctx.db.prepare("UPDATE sources SET scan_status='scanning', scan_error=NULL WHERE id=?").run(sourceId)
  ctx.emit({ type: 'sources-changed', projectId })

  const excluded = [...(await protectedDirs(ctx, projectId)), ...(JSON.parse(src.excluded_json) as string[]), thumbsDir(ctx)]
  const excludedKeys = excluded.map((d) => d)
  const isExcluded = (p: string) => excludedKeys.some((d) => isInside(p, d))

  const existing = new Map<string, { id: number; size: number; mtime_ms: number; location: string }>()
  for (const r of ctx.db
    .prepare('SELECT id, path_key, size, mtime_ms, location FROM media WHERE project_id = ? AND source_id = ?')
    .all(projectId, sourceId) as Array<{ id: number; path_key: string; size: number; mtime_ms: number; location: string }>) {
    existing.set(r.path_key, r)
  }
  const seen = new Set<number>()

  const insert = ctx.db.prepare(
    `INSERT INTO media (project_id, source_id, original_path, path_key, current_path, location, rel_dir, file_name, ext, kind, size, mtime_ms, imported_at, updated_at, role, parent_id)
     VALUES (?,?,?,?,?, 'source', ?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(project_id, path_key) DO NOTHING`
  )
  const setParent = ctx.db.prepare("UPDATE media SET parent_id = ?, kind = ? WHERE id = ? AND role = 'sidecar'")
  const updateChanged = ctx.db.prepare(
    `UPDATE media SET size=?, mtime_ms=?, sha256=NULL, hashed_at=NULL, thumb_status='none', thumb_error=NULL, meta_status='none',
       dup_group=NULL, location='source', current_path=?, updated_at=? WHERE id=?`
  )
  const markPresent = ctx.db.prepare("UPDATE media SET location='source', current_path=?, updated_at=? WHERE id=? AND location='missing'")

  let batch: FoundFile[] = []
  const flush = ctx.db.transaction((files: FoundFile[]) => {
    const t = ctx.now()
    for (const f of files) {
      const key = pathKey(f.full)
      const ex = existing.get(key)
      if (ex) {
        seen.add(ex.id)
        if (f.role === 'sidecar') setParent.run(f.parentId ?? null, f.kind, ex.id)
        if (ex.location === 'recovery') {
          // Kann nicht auftreten (path_key wird beim Verschieben umgestellt) – defensiv ignorieren
          result.unchanged++
        } else if (ex.size !== f.size || ex.mtime_ms !== Math.round(f.mtimeMs)) {
          updateChanged.run(f.size, Math.round(f.mtimeMs), f.full, t, ex.id)
          result.updated++
        } else {
          if (ex.location === 'missing') markPresent.run(f.full, t, ex.id)
          result.unchanged++
        }
      } else {
        const r = insert.run(projectId, sourceId, f.full, key, f.full, f.relDir, f.name, f.ext, f.kind, f.size, Math.round(f.mtimeMs), t, t, f.role ?? 'main', f.parentId ?? null)
        if (r.changes) result.added++
      }
    }
  })

  let files = 0
  let dirs = 0
  const sidecarFiles: FoundFile[] = []
  const stack: string[] = [src.path]
  while (stack.length) {
    if (signal?.aborted) break
    const dir = stack.pop()!
    dirs++
    let handle: fs.Dir
    try {
      handle = await fs.promises.opendir(dir)
    } catch (e) {
      result.errors.push(`${dir}: ${(e as Error).message}`)
      continue
    }
    try {
      for await (const ent of handle) {
        const full = path.join(dir, ent.name)
        if (ent.isSymbolicLink()) {
          // Symbolische Links und Junctions werden nicht verfolgt (Schleifen / doppelte Importe vermeiden)
          result.skippedLinks++
          continue
        }
        if (ent.isDirectory()) {
          if (SKIP_DIR_NAMES.has(ent.name.toLowerCase()) || isExcluded(full)) {
            result.skippedDirs++
            continue
          }
          stack.push(full)
          continue
        }
        if (!ent.isFile()) continue
        if (isOwnTempFile(ent.name)) continue
        const ext = extOf(ent.name)
        if (ext === 'xmp') {
          try {
            const st = await fs.promises.lstat(full)
            const rel = path.relative(src.path, dir)
            sidecarFiles.push({ full, relDir: rel, name: ent.name, ext, kind: 'image', size: st.size, mtimeMs: st.mtimeMs, role: 'sidecar' })
          } catch {
            /* ignorieren */
          }
          continue
        }
        const kind = kindForExt(ext)
        if (!kind) continue
        let st: fs.Stats
        try {
          st = await fs.promises.lstat(full)
        } catch (e) {
          result.errors.push(`${full}: ${(e as Error).message}`)
          continue
        }
        const rel = path.relative(src.path, dir)
        batch.push({ full, relDir: rel === '' ? '' : rel, name: ent.name, ext, kind, size: st.size, mtimeMs: st.mtimeMs })
        files++
        if (batch.length >= 500) {
          flush(batch)
          batch = []
          onProgress?.({ files, dirs })
        }
      }
    } catch (e) {
      result.errors.push(`${dir}: ${(e as Error).message}`)
    }
  }
  if (batch.length) flush(batch)

  // XMP-Sidecars ihrem Medium zuordnen (IMG_1.xmp oder IMG_1.CR3.xmp); bevorzugt RAW
  if (sidecarFiles.length) {
    const mains = ctx.db
      .prepare("SELECT id, rel_dir, file_name, kind FROM media WHERE source_id = ? AND role = 'main'")
      .all(sourceId) as Array<{ id: number; rel_dir: string; file_name: string; kind: 'image' | 'raw' | 'video' }>
    const byFull = new Map<string, (typeof mains)[number]>()
    const byBase = new Map<string, Array<(typeof mains)[number]>>()
    for (const m of mains) {
      byFull.set(`${m.rel_dir}|${m.file_name.toLowerCase()}`, m)
      const k = `${m.rel_dir}|${baseName(m.file_name)}`
      const arr = byBase.get(k) ?? []
      arr.push(m)
      byBase.set(k, arr)
    }
    const rank = { raw: 0, image: 1, video: 2 }
    const linked: FoundFile[] = []
    for (const sc of sidecarFiles) {
      const stem = sc.name.slice(0, -4)
      let parent = byFull.get(`${sc.relDir}|${stem.toLowerCase()}`)
      if (!parent) parent = (byBase.get(`${sc.relDir}|${stem.toLowerCase()}`) ?? []).slice().sort((a, b) => rank[a.kind] - rank[b.kind])[0]
      if (!parent) continue
      linked.push({ ...sc, kind: parent.kind, parentId: parent.id })
    }
    for (let i = 0; i < linked.length; i += 500) flush(linked.slice(i, i + 500))
  }
  computePairs(ctx, sourceId)

  const aborted = !!signal?.aborted
  if (!aborted) {
    // Nicht mehr gefundene Dateien als fehlend markieren (keine Löschung von Datensätzen)
    const markMissing = ctx.db.prepare("UPDATE media SET location='missing', updated_at=? WHERE id=? AND location='source'")
    const tx = ctx.db.transaction(() => {
      for (const ex of existing.values()) {
        if (!seen.has(ex.id) && ex.location === 'source') {
          result.missing += markMissing.run(ctx.now(), ex.id).changes
        }
      }
    })
    tx()
  }
  const count = (ctx.db.prepare("SELECT COUNT(*) AS n FROM media WHERE source_id = ? AND location != 'missing'").get(sourceId) as { n: number }).n
  ctx.db
    .prepare('UPDATE sources SET scan_status=?, scan_error=?, last_scan_at=?, file_count=?, skipped_links=? WHERE id=?')
    .run(
      'idle',
      aborted ? 'Indexierung abgebrochen' : result.errors.length ? `${result.errors.length} Fehler beim Lesen` : null,
      ctx.now(),
      count,
      result.skippedLinks,
      sourceId
    )
  oplog(ctx, projectId, result.errors.length ? 'warn' : 'info', 'source.scan', 'source', sourceId, { ...result, errors: result.errors.slice(0, 20), aborted })
  onProgress?.({ files, dirs })
  ctx.emit({ type: 'sources-changed', projectId })
  ctx.emit({ type: 'media-changed', projectId, full: true })
  return result
}
