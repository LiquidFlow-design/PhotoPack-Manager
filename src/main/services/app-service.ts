// Orchestrierung im Main-Prozess: Projekte, Hintergrundaufgaben, Pläne, Ereignisse.
import fs from 'node:fs'
import path from 'node:path'
import type {
  AppEvent,
  AppSettings,
  ExportPlanOptions,
  ExportPlanPreview,
  MediaDetail,
  MediaRow,
  ProjectBundle,
  TaskProgress
} from '@shared/types'
import { openDatabase, type DB } from '../db/database'
import { createContext, oplog, type CoreContext } from '../core/context'
import type { FileOps } from '../core/fileops'
import { TransferEngine } from '../core/engine'
import { buildPlan, type PlanSnapshot } from '../core/planner'
import { getProject, listProjects, touchProject } from '../core/projects'
import { listSources, scanSource } from '../core/sources'
import { listPackages } from '../core/packages'
import { listAssignments, listExported } from '../core/assignments'
import { purgeRecovery } from '../core/recovery'
import { scanDuplicates } from '../core/duplicates'
import { scanSimilar } from '../core/similar'
import { exportPackageZip, type ZipResult } from '../core/zip-export'
import { getSettings, updateSettings } from '../core/settings'
import { MediaProcessor, resolveToolPaths } from './media-tools'

interface MediaDbRow {
  id: number
  source_id: string | null
  file_name: string
  ext: string
  kind: MediaRow['kind']
  rel_dir: string
  size: number
  mtime_ms: number
  captured_at: number | null
  width: number | null
  height: number | null
  duration_ms: number | null
  location: MediaRow['location']
  thumb_status: MediaRow['thumbStatus']
  thumb_error: string | null
  dup_group: string | null
  sha256: string | null
  pair_id: number | null
  rating: number
  color_label: MediaRow['colorLabel']
  sim_group: number | null
  sidecars: number
}

const MEDIA_COLS =
  "id, source_id, file_name, ext, kind, rel_dir, size, mtime_ms, captured_at, width, height, duration_ms, location, thumb_status, thumb_error, dup_group, sha256, pair_id, rating, color_label, sim_group, (SELECT COUNT(*) FROM media sc WHERE sc.parent_id = media.id) AS sidecars"
const MAIN = "role = 'main'"

function toRow(r: MediaDbRow): MediaRow {
  return {
    id: r.id,
    sourceId: r.source_id,
    name: r.file_name,
    ext: r.ext,
    kind: r.kind,
    relDir: r.rel_dir,
    size: r.size,
    mtimeMs: r.mtime_ms,
    capturedAt: r.captured_at,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    location: r.location,
    thumbStatus: r.thumb_status,
    thumbError: r.thumb_error,
    dupGroup: r.dup_group,
    hasHash: !!r.sha256,
    pairId: r.pair_id,
    sidecars: r.sidecars ?? 0,
    rating: r.rating ?? 0,
    colorLabel: r.color_label ?? null,
    simGroup: r.sim_group
  }
}

export class AppService {
  readonly db: DB
  readonly ctx: CoreContext
  readonly engine: TransferEngine
  readonly media: MediaProcessor
  private plans = new Map<string, PlanSnapshot>()
  private tasks = new Map<string, { ac: AbortController; progress: TaskProgress }>()
  private cleanupTimer: NodeJS.Timeout | null = null
  private thumbBuffer = new Map<string, Set<number>>()
  private thumbTimer: NodeJS.Timeout | null = null
  interruptedJobs = 0
  fileOpsMode: 'worker' | 'inline' = 'inline'
  reconcileNotes: string[] = []

  constructor(
    readonly dataDir: string,
    fileOps: FileOps,
    private send: (e: AppEvent) => void
  ) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.db = openDatabase(path.join(dataDir, 'photopack.sqlite'))
    this.ctx = createContext({ db: this.db, fileOps, dataDir, emit: (e) => this.emit(e) })
    this.engine = new TransferEngine(this.ctx, { concurrency: 2 })
    this.media = new MediaProcessor(this.ctx, path.join(dataDir, 'cache'), resolveToolPaths())
  }

  get dbPath(): string {
    return path.join(this.dataDir, 'photopack.sqlite')
  }

  async init(): Promise<void> {
    const r = await this.engine.reconcile()
    this.interruptedJobs = r.interruptedJobs
    this.reconcileNotes = r.notes
    if (r.notes.length) oplog(this.ctx, null, 'warn', 'startup.reconcile', undefined, null, r.notes)
    this.engine.start()
    // Kontrollierte automatische Bereinigung nur bei laufender Anwendung
    const runCleanup = () => void purgeRecovery(this.ctx, null, 'expired').catch(() => {})
    setTimeout(runCleanup, 60_000).unref()
    this.cleanupTimer = setInterval(runCleanup, 3600_000)
    this.cleanupTimer.unref()
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    for (const t of this.tasks.values()) t.ac.abort()
    await this.engine.shutdown()
    await this.media.close()
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* ignore */
    }
    this.db.close()
  }

  /** Ereignisse an den Renderer; Vorschau-Ereignisse werden gebündelt. */
  private emit(e: AppEvent): void {
    if (e.type === 'thumb-ready') {
      let s = this.thumbBuffer.get(e.projectId)
      if (!s) this.thumbBuffer.set(e.projectId, (s = new Set()))
      s.add(e.mediaId)
      if (!this.thumbTimer) {
        this.thumbTimer = setTimeout(() => {
          this.thumbTimer = null
          for (const [projectId, ids] of this.thumbBuffer) this.send({ type: 'media-changed', projectId, mediaIds: [...ids] })
          this.thumbBuffer.clear()
        }, 150)
      }
      return
    }
    this.send(e)
  }

  // ---------------- Projekte

  openProject(projectId: string): ProjectBundle {
    const project = getProject(this.ctx, projectId)
    touchProject(this.ctx, projectId)
    updateSettings(this.ctx, { lastProjectId: projectId })
    this.media.startBackground(projectId, (done, total, running) => this.progress(projectId, 'thumbs', 'Vorschauen erzeugen', done, total, running))
    return {
      project,
      sources: listSources(this.ctx, projectId),
      packages: listPackages(this.ctx, projectId),
      media: this.listMedia(projectId),
      assignments: listAssignments(this.ctx, projectId),
      exported: listExported(this.ctx, projectId)
    }
  }

  listMedia(projectId: string): MediaRow[] {
    return (this.db.prepare(`SELECT ${MEDIA_COLS} FROM media WHERE project_id = ? AND ${MAIN}`).all(projectId) as MediaDbRow[]).map(toRow)
  }

  mediaRows(projectId: string, ids: number[]): MediaRow[] {
    if (!ids.length) return []
    const out: MediaRow[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      out.push(
        ...(this.db.prepare(`SELECT ${MEDIA_COLS} FROM media WHERE project_id = ? AND id IN (${chunk.map(() => '?').join(',')})`).all(projectId, ...chunk) as MediaDbRow[]).map(toRow)
      )
    }
    return out
  }

  mediaDetail(mediaId: number): MediaDetail | null {
    const r = this.db.prepare(`SELECT ${MEDIA_COLS}, original_path, current_path, codec FROM media WHERE id = ?`).get(mediaId) as
      | (MediaDbRow & { original_path: string; current_path: string; codec: string | null })
      | undefined
    if (!r) return null
    const dests = this.db
      .prepare('SELECT package_id, package_name, path, status, created_at FROM transfer_destinations WHERE media_id = ? ORDER BY created_at')
      .all(mediaId) as Array<{ package_id: string | null; package_name: string; path: string; status: string; created_at: number }>
    const rec = this.db
      .prepare("SELECT id, status, retain_until FROM recovery_items WHERE media_id = ? AND status IN ('held','released') ORDER BY moved_at DESC LIMIT 1")
      .get(mediaId) as { id: string; status: 'held' | 'released'; retain_until: number | null } | undefined
    return {
      ...toRow(r),
      originalPath: r.original_path,
      currentPath: r.current_path,
      sha256: r.sha256,
      codec: r.codec,
      destinations: dests.map((d) => ({ packageId: d.package_id, packageName: d.package_name, path: d.path, status: d.status, createdAt: d.created_at })),
      recovery: rec ? { id: rec.id, status: rec.status, retainUntil: rec.retain_until } : null
    }
  }

  mediaPath(mediaId: number): { path: string; kind: string; ext: string; location: string } | null {
    return (
      (this.db.prepare('SELECT current_path AS path, kind, ext, location FROM media WHERE id = ?').get(mediaId) as
        | { path: string; kind: string; ext: string; location: string }
        | undefined) ?? null
    )
  }

  // ---------------- Hintergrundaufgaben

  private progress(projectId: string, kind: TaskProgress['kind'], label: string, done: number, total: number, running: boolean, error: string | null = null): void {
    const task: TaskProgress = { id: `${kind}:${projectId}`, kind, label, done, total, running, error }
    const t = this.tasks.get(task.id)
    if (t) t.progress = task
    this.send({ type: 'task-progress', projectId, task })
  }

  runningTasks(projectId: string): TaskProgress[] {
    return [...this.tasks.entries()].filter(([k]) => k.endsWith(':' + projectId)).map(([, v]) => v.progress)
  }

  async scanSources(projectId: string, sourceIds?: string[]): Promise<void> {
    const id = `scan:${projectId}`
    if (this.tasks.has(id)) return
    const ac = new AbortController()
    const progress: TaskProgress = { id, kind: 'scan', label: 'Indexierung', done: 0, total: 0, running: true, error: null }
    this.tasks.set(id, { ac, progress })
    const ids = sourceIds ?? listSources(this.ctx, projectId).map((s) => s.id)
    const errors: string[] = []
    try {
      for (const sid of ids) {
        if (ac.signal.aborted) break
        try {
          await scanSource(this.ctx, sid, ac.signal, (p) => this.progress(projectId, 'scan', `Indexierung · ${p.files} Dateien`, p.files, 0, true))
        } catch (e) {
          errors.push((e as Error).message)
        }
      }
    } finally {
      this.tasks.delete(id)
      this.progress(projectId, 'scan', 'Indexierung abgeschlossen', 1, 1, false, errors.length ? errors.join('; ') : null)
      if (errors.length) this.send({ type: 'notice', projectId, level: 'warn', message: errors.join(' ') })
      this.media.startBackground(projectId, (done, total, running) => this.progress(projectId, 'thumbs', 'Vorschauen erzeugen', done, total, running))
      if (getSettings(this.ctx).duplicateDetection) void this.scanDuplicates(projectId)
    }
  }

  cancelTask(projectId: string, kind: TaskProgress['kind']): void {
    this.tasks.get(`${kind}:${projectId}`)?.ac.abort()
    if (kind === 'thumbs') this.media.stopBackground(projectId)
  }

  async scanDuplicates(projectId: string): Promise<{ groups: number } | null> {
    const id = `duplicates:${projectId}`
    if (this.tasks.has(id)) return null
    const ac = new AbortController()
    const progress: TaskProgress = { id, kind: 'duplicates', label: 'Duplikatprüfung', done: 0, total: 0, running: true, error: null }
    this.tasks.set(id, { ac, progress })
    try {
      const r = await scanDuplicates(this.ctx, projectId, ac.signal, (d, t) => this.progress(projectId, 'duplicates', 'Duplikatprüfung', d, t, true))
      this.send({
        type: 'notice',
        projectId,
        level: 'info',
        message: ac.signal.aborted ? 'Duplikatprüfung abgebrochen.' : r.groups ? `${r.groups} Duplikatgruppe(n) gefunden. Es wurde nichts gelöscht.` : 'Keine exakten Duplikate gefunden.'
      })
      return { groups: r.groups }
    } finally {
      this.tasks.delete(id)
      this.progress(projectId, 'duplicates', 'Duplikatprüfung abgeschlossen', 1, 1, false)
    }
  }

  async scanSimilar(projectId: string): Promise<{ groups: number } | null> {
    const id = `similar:${projectId}`
    if (this.tasks.has(id)) return null
    const ac = new AbortController()
    const progress: TaskProgress = { id, kind: 'similar', label: 'Ähnliche Bilder suchen', done: 0, total: 0, running: true, error: null }
    this.tasks.set(id, { ac, progress })
    try {
      const r = await scanSimilar(
        this.ctx,
        projectId,
        getSettings(this.ctx).similarityThreshold,
        (mid) => this.media.ensurePhash(mid),
        ac.signal,
        (d, t) => this.progress(projectId, 'similar', 'Ähnliche Bilder suchen', d, t, true)
      )
      this.send({ type: 'notice', projectId, level: 'info', message: r.groups ? `${r.groups} Gruppe(n) ähnlicher Bilder gefunden.` : 'Keine ähnlichen Bilder gefunden.' })
      return { groups: r.groups }
    } finally {
      this.tasks.delete(id)
      this.progress(projectId, 'similar', 'Ähnlichkeitssuche abgeschlossen', 1, 1, false)
    }
  }

  async runZip(projectId: string, packageId: string, file: string): Promise<ZipResult> {
    const id = `zip:${projectId}`
    if (this.tasks.has(id)) throw new Error('Es läuft bereits ein ZIP-Export.')
    const ac = new AbortController()
    const progress: TaskProgress = { id, kind: 'zip', label: 'ZIP-Export', done: 0, total: 0, running: true, error: null }
    this.tasks.set(id, { ac, progress })
    try {
      return await exportPackageZip(this.ctx, packageId, file, { signal: ac.signal, onProgress: (d, t) => this.progress(projectId, 'zip', 'ZIP-Export', d, t, true) })
    } finally {
      this.tasks.delete(id)
      this.progress(projectId, 'zip', 'ZIP-Export abgeschlossen', 1, 1, false)
    }
  }

  // ---------------- Export

  async previewExport(projectId: string, opts: ExportPlanOptions): Promise<ExportPlanPreview> {
    const { preview, snapshot } = await buildPlan(this.ctx, projectId, opts)
    this.plans.set(snapshot.id, snapshot)
    // alte Pläne verwerfen
    const now = Date.now()
    for (const [k, v] of this.plans) if (now - v.createdAt > 30 * 60_000) this.plans.delete(k)
    return preview
  }

  startExport(planId: string): { jobId: string | null; created: number; skippedActive: number } {
    const snap = this.plans.get(planId)
    if (!snap) throw new Error('Exportplan abgelaufen. Bitte Vorschau erneut öffnen.')
    this.plans.delete(planId)
    const label = `Export · ${snap.operation === 'move' ? 'Verschieben' : 'Kopieren'} · ${snap.copies.length} Dateien`
    return this.engine.createJob(snap, 'collect', label)
  }

  // ---------------- Einstellungen

  settings(): AppSettings {
    return getSettings(this.ctx)
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    return updateSettings(this.ctx, patch)
  }

  projects() {
    return listProjects(this.ctx)
  }
}
