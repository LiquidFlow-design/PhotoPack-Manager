// Transfer-Engine: persistente Auftragswarteschlange mit expliziten Zustandsautomaten.
// Siehe ARCHITECTURE.md, Abschnitt „Zustandsautomaten“. Invarianten:
//  I1  Eine Quelldatei wird erst entfernt, wenn ALLE Zielkopien ihres Auftrags verifiziert vorliegen
//      UND eine verifizierte Kopie im Wiederherstellungsbereich existiert (bzw. atomar dorthin umbenannt wurde).
//  I2  Zieldateien werden nie überschrieben (Commit per Hardlink/EEXIST bzw. Existenzprüfung).
//  I3  Jede Zwischendatei (.ppm-<id>.tmp) ist im Auftragseintrag vermerkt, bevor sie entsteht.
//  I4  Ein abgeschlossener Transfer (transfer_destinations) wird nicht erneut ausgeführt.
//  I5  Nach Absturz werden Einträge anhand des Dateisystems abgeglichen; Aufträge werden pausiert.
import fs from 'node:fs'
import path from 'node:path'
import type { JobItemInfo, JobItemKind, JobItemStatus, JobStatus, JobSummary, WorkMode } from '@shared/types'
import { newId, oplog, type CoreContext } from './context'
import { durable } from '../db/database'
import { AbortError } from './fileops'
import { SimulatedCrash } from './faults'
import { commitNoOverwrite, exists, freeBytes, KeyedMutex, statOrNull, unlinkIfExists } from './fsx'
import { numberedName, pathKey, TMP_PREFIX, TMP_SUFFIX } from './paths'
import { SPACE_MARGIN, type PlanSnapshot } from './planner'
import { getProject } from './projects'
import { hideVolumeRecoveryDir, resolveRecoveryDir } from './recovery'
import { getSettings } from './settings'

export class TransferError extends Error {
  constructor(
    public code: string,
    message: string,
    public transient = false
  ) {
    super(message)
  }
}

export interface ItemRow {
  id: string
  job_id: string
  project_id: string
  seq: number
  kind: JobItemKind
  media_id: number | null
  package_id: string | null
  package_name: string | null
  recovery_item_id: string | null
  idempotency_key: string
  active: number
  file_name: string
  src_path: string
  src_size: number
  src_mtime_ms: number
  src_sha256: string | null
  dest_dir: string | null
  dest_name: string | null
  final_path: string | null
  tmp_path: string | null
  status: JobItemStatus
  result_sha256: string | null
  attempts: number
  max_attempts: number
  retry_at: number | null
  error_code: string | null
  error_message: string | null
  note: string | null
}

interface JobRow {
  id: string
  project_id: string
  kind: 'export' | 'restore'
  mode: WorkMode
  operation: 'copy' | 'move'
  conflict_policy: 'rename' | 'skip'
  status: JobStatus
  label: string
  interrupted: number
  created_at: number
  started_at: number | null
  finished_at: number | null
}

interface MediaRowDb {
  id: number
  project_id: string
  current_path: string
  original_path: string
  location: 'source' | 'recovery' | 'missing'
  size: number
  mtime_ms: number
  sha256: string | null
  file_name: string
}

const IN_PROGRESS: JobItemStatus[] = ['copying', 'verifying', 'committing', 'recovery_copying', 'recovery_committed', 'source_removing']
const TERMINAL: JobItemStatus[] = ['done', 'skipped', 'cancelled']
const RETRY_DELAYS = [2000, 10000, 30000]

const ERR_TEXT: Record<string, string> = {
  SOURCE_MISSING: 'Quelldatei nicht gefunden.',
  SOURCE_CHANGED: 'Quelldatei wurde seit der Planung verändert.',
  TARGET_MISSING: 'Zielordner bzw. Laufwerk nicht erreichbar.',
  DISK_FULL: 'Nicht genügend Speicherplatz auf dem Ziellaufwerk.',
  VERIFY_MISMATCH: 'Prüfsumme der Kopie stimmt nicht mit der Quelle überein.',
  LOCKED: 'Datei ist gesperrt oder wird von einem anderen Programm verwendet.',
  ACCESS_DENIED: 'Zugriff verweigert.',
  SOURCE_KEPT: 'Quelle nicht verschoben, da nicht alle Zielkopien erfolgreich erstellt wurden.',
  IO: 'Ein-/Ausgabefehler.'
}

export function classifyError(e: unknown, phase: 'source' | 'target' | 'recovery' = 'target'): TransferError {
  if (e instanceof TransferError) return e
  const err = e as NodeJS.ErrnoException
  switch (err.code) {
    case 'ENOSPC':
      return new TransferError('DISK_FULL', ERR_TEXT.DISK_FULL)
    case 'EBUSY':
    case 'EPERM':
    case 'EAGAIN':
    case 'EMFILE':
    case 'ENFILE':
      return new TransferError('LOCKED', `${ERR_TEXT.LOCKED} (${err.code})`, true)
    case 'EACCES':
      return new TransferError('ACCESS_DENIED', `${ERR_TEXT.ACCESS_DENIED} (${err.message})`)
    case 'ENOTDIR':
    case 'ENODEV':
    case 'EROFS':
      return new TransferError('TARGET_MISSING', `${ERR_TEXT.TARGET_MISSING} (${err.code})`)
    case 'ENOENT':
      return phase === 'source' ? new TransferError('SOURCE_MISSING', ERR_TEXT.SOURCE_MISSING) : new TransferError('TARGET_MISSING', ERR_TEXT.TARGET_MISSING)
    case 'ETIMEDOUT':
    case 'ECONNRESET':
    case 'ENETUNREACH':
    case 'EIO':
    case 'UNKNOWN':
      return new TransferError('IO', `${ERR_TEXT.IO} (${err.code})`, true)
    default:
      return new TransferError(err.code ?? 'ERROR', err.message ?? String(e))
  }
}

export interface EngineOptions {
  concurrency?: number
  autoStart?: boolean
  retryDelays?: number[]
}

export class TransferEngine {
  private inflight = new Map<string, { ac: AbortController; mediaId: number | null; jobId: string }>()
  private busyMedia = new Set<number>()
  private dirMutex = new KeyedMutex()
  private concurrency: number
  private running = false
  private crashed: SimulatedCrash | null = null
  private idleWaiters: Array<(err: SimulatedCrash | null) => void> = []
  private timer: NodeJS.Timeout | null = null
  private pumping = false
  private repump = false
  private lastEmit = 0
  private emitTimer: NodeJS.Timeout | null = null
  private dirtyProjects = new Set<string>()
  private retryDelays: number[]

  constructor(
    private ctx: CoreContext,
    opts: EngineOptions = {}
  ) {
    this.concurrency = opts.concurrency ?? 2
    this.retryDelays = opts.retryDelays ?? RETRY_DELAYS
    if (opts.autoStart) this.start()
  }

  // ------------------------------------------------------------------ Steuerung

  start(): void {
    this.running = true
    this.kick()
  }

  /** Geordnetes Anhalten: laufende Kopien abbrechen (Zwischendateien werden entfernt), Aufträge pausieren. */
  async shutdown(): Promise<void> {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    for (const f of this.inflight.values()) f.ac.abort()
    while (this.inflight.size) await new Promise((r) => setTimeout(r, 20))
    const t = this.ctx.now()
    this.ctx.db.prepare("UPDATE jobs SET status='paused', updated_at=? WHERE status IN ('queued','running')").run(t)
  }

  get isCrashed(): boolean {
    return !!this.crashed
  }

  /** Für Tests: wartet, bis keine ausführbaren Einträge mehr vorhanden sind. */
  waitIdle(): Promise<SimulatedCrash | null> {
    if (this.crashed) return Promise.resolve(this.crashed)
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve)
      this.kick()
    })
  }

  private kick(): void {
    if (!this.running || this.crashed) {
      this.resolveIdle()
      return
    }
    if (this.pumping) {
      this.repump = true
      return
    }
    queueMicrotask(() => void this.pump())
  }

  private resolveIdle(): void {
    if (!this.crashed && this.inflight.size) return
    const w = this.idleWaiters
    this.idleWaiters = []
    for (const r of w) r(this.crashed)
  }

  // ------------------------------------------------------------------ Aufträge anlegen

  /**
   * Legt einen Auftrag aus einem Snapshot an. Einträge, die bereits aktiv in einem anderen Auftrag
   * enthalten sind (Idempotenzschlüssel), werden übersprungen.
   */
  createJob(snapshot: PlanSnapshot, mode: WorkMode, label: string, opts: { startAfter?: number | null } = {}): { jobId: string | null; created: number; skippedActive: number } {
    const db = this.ctx.db
    const t = this.ctx.now()
    const jobId = newId()
    const project = getProject(this.ctx, snapshot.projectId)
    let created = 0
    let skippedActive = 0
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO jobs (id, project_id, kind, mode, operation, conflict_policy, status, label, plan_json, created_at, updated_at, start_after)
         VALUES (?,?,?,?,?,?,'queued',?,?,?,?,?)`
      ).run(
        jobId,
        snapshot.projectId,
        'export',
        mode,
        snapshot.operation,
        snapshot.conflictPolicy,
        label,
        JSON.stringify({ planId: snapshot.id, copies: snapshot.copies.length, releases: snapshot.releases.length, recoveryDir: project.recoveryDir }),
        t,
        t,
        opts.startAfter ?? null
      )
      const ins = db.prepare(
        `INSERT INTO job_items (id, job_id, project_id, seq, kind, media_id, package_id, package_name, idempotency_key, file_name,
           src_path, src_size, src_mtime_ms, src_sha256, dest_dir, dest_name, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      const hasActive = db.prepare('SELECT 1 FROM job_items WHERE idempotency_key = ? AND active = 1')
      let seq = 0
      const copiedMedia = new Set<number>()
      for (const c of snapshot.copies) {
        const key = `copy:${c.mediaId}:${c.packageId}:${c.srcSize}:${c.srcMtimeMs}`
        if (hasActive.get(key)) {
          skippedActive++
          continue
        }
        const id = newId()
        ins.run(
          id,
          jobId,
          snapshot.projectId,
          seq++,
          'copy',
          c.mediaId,
          c.packageId,
          c.packageName,
          key,
          c.fileName,
          c.srcPath,
          c.srcSize,
          c.srcMtimeMs,
          c.srcSha256,
          c.destDir,
          c.destName,
          'pending',
          t,
          t
        )
        this.event(id, null, 'pending', 'angelegt')
        copiedMedia.add(c.mediaId)
        created++
      }
      for (const r of snapshot.releases) {
        if (!copiedMedia.has(r.mediaId)) continue
        const key = `release:${r.mediaId}:${r.srcSize}:${r.srcMtimeMs}`
        if (hasActive.get(key)) continue
        const id = newId()
        ins.run(id, jobId, snapshot.projectId, seq++, 'release_source', r.mediaId, null, null, key, r.fileName, r.srcPath, r.srcSize, r.srcMtimeMs, r.srcSha256, null, null, 'waiting', t, t)
        this.event(id, null, 'waiting', 'angelegt')
        created++
      }
      if (created === 0) db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId)
    })
    tx()
    if (!created) return { jobId: null, created, skippedActive }
    oplog(this.ctx, snapshot.projectId, 'info', 'job.create', 'job', jobId, { mode, operation: snapshot.operation, items: created, skippedActive })
    this.changed(snapshot.projectId)
    this.kick()
    return { jobId, created, skippedActive }
  }

  /** Wiederherstellungsauftrag für Einträge des Wiederherstellungsbereichs. */
  createRestoreJob(projectId: string, recoveryIds: string[], targetDir: string | null): { jobId: string | null; created: number } {
    const db = this.ctx.db
    const t = this.ctx.now()
    const jobId = newId()
    let created = 0
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO jobs (id, project_id, kind, mode, operation, conflict_policy, status, label, created_at, updated_at)
         VALUES (?,?,'restore','collect','move','rename','queued',?,?,?)`
      ).run(jobId, projectId, `Wiederherstellung (${recoveryIds.length})`, t, t)
      const ins = db.prepare(
        `INSERT INTO job_items (id, job_id, project_id, seq, kind, media_id, recovery_item_id, idempotency_key, file_name,
           src_path, src_size, src_mtime_ms, src_sha256, dest_dir, dest_name, status, created_at, updated_at)
         VALUES (?,?,?,?,'restore',?,?,?,?,?,?,?,?,?,?,'pending',?,?)`
      )
      let seq = 0
      for (const rid of recoveryIds) {
        const r = db.prepare("SELECT * FROM recovery_items WHERE id = ? AND project_id = ? AND status IN ('held','released')").get(rid, projectId) as
          | { id: string; media_id: number | null; file_name: string; original_path: string; recovery_path: string; size: number; sha256: string }
          | undefined
        if (!r) continue
        const key = `restore:${r.id}`
        if (db.prepare('SELECT 1 FROM job_items WHERE idempotency_key = ? AND active = 1').get(key)) continue
        const destDir = targetDir ?? path.dirname(r.original_path)
        const id = newId()
        ins.run(id, jobId, projectId, seq++, r.media_id, r.id, key, r.file_name, r.recovery_path, r.size, 0, r.sha256, destDir, path.basename(r.original_path), t, t)
        this.event(id, null, 'pending', 'angelegt')
        created++
      }
      if (!created) db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId)
    })
    tx()
    if (!created) return { jobId: null, created }
    oplog(this.ctx, projectId, 'info', 'job.create', 'job', jobId, { kind: 'restore', items: created })
    this.changed(projectId)
    this.kick()
    return { jobId, created }
  }

  // ------------------------------------------------------------------ Benutzeraktionen

  pauseJob(jobId: string): void {
    const j = this.job(jobId)
    if (!['queued', 'running'].includes(j.status)) return
    this.setJobStatus(jobId, 'paused')
    for (const f of this.inflight.values()) if (f.jobId === jobId) f.ac.abort()
    this.changed(j.project_id)
  }

  resumeJob(jobId: string): void {
    const j = this.job(jobId)
    if (j.status !== 'paused') return
    this.ctx.db.prepare('UPDATE jobs SET status = ?, interrupted = 0, updated_at = ? WHERE id = ?').run(j.started_at ? 'running' : 'queued', this.ctx.now(), jobId)
    this.changed(j.project_id)
    this.kick()
  }

  /** Abbruch: offene Einträge werden storniert. Bereits erstellte Zieldateien bleiben erhalten. */
  cancelJob(jobId: string): void {
    const j = this.job(jobId)
    if (!['queued', 'running', 'paused'].includes(j.status)) return
    const t = this.ctx.now()
    const tx = this.ctx.db.transaction(() => {
      const items = this.ctx.db.prepare("SELECT id, status FROM job_items WHERE job_id = ? AND status IN ('pending','waiting','failed')").all(jobId) as Array<{
        id: string
        status: JobItemStatus
      }>
      for (const it of items) this.setItem(it.id, it.status, 'cancelled', { active: 0, finished_at: t, retry_at: null }, 'Auftrag abgebrochen')
      this.ctx.db.prepare("UPDATE jobs SET status='cancelled', finished_at=?, updated_at=? WHERE id=?").run(t, t, jobId)
    })
    tx()
    for (const f of this.inflight.values()) if (f.jobId === jobId) f.ac.abort()
    oplog(this.ctx, j.project_id, 'warn', 'job.cancel', 'job', jobId)
    this.changed(j.project_id)
    this.kick()
  }

  /** Fehlgeschlagene Einträge erneut einreihen (auch nach Abschluss des Auftrags). */
  retryJob(jobId: string): number {
    const j = this.job(jobId)
    let n = 0
    const tx = this.ctx.db.transaction(() => {
      const items = this.ctx.db.prepare("SELECT * FROM job_items WHERE job_id = ? AND status = 'failed'").all(jobId) as ItemRow[]
      for (const it of items) {
        try {
          this.setItem(it.id, it.status, it.kind === 'release_source' ? 'waiting' : 'pending', { active: 1, retry_at: null, attempts: 0, error_code: null, error_message: null })
          n++
        } catch {
          // Idempotenzkonflikt: Eintrag ist inzwischen in einem anderen Auftrag aktiv
          this.setItem(it.id, it.status, 'cancelled', { active: 0 }, 'bereits in anderem Auftrag enthalten')
        }
      }
      if (n) this.ctx.db.prepare("UPDATE jobs SET status = 'running', finished_at = NULL, updated_at = ? WHERE id = ?").run(this.ctx.now(), jobId)
    })
    tx()
    this.changed(j.project_id)
    this.kick()
    return n
  }

  /**
   * Sofortmodus: Zuordnung entfernt -> noch nicht gestartete Kopien stornieren.
   * Bereits laufende oder abgeschlossene Übertragungen bleiben unangetastet.
   */
  cancelPendingFor(pairs: Array<[number, string]>): number {
    if (!pairs.length) return 0
    let n = 0
    const touchedJobs = new Set<string>()
    const tx = this.ctx.db.transaction(() => {
      const sel = this.ctx.db.prepare("SELECT id, job_id, status FROM job_items WHERE kind='copy' AND media_id=? AND package_id=? AND status IN ('pending','failed') AND active=1")
      for (const [m, p] of pairs) {
        for (const it of sel.all(m, p) as Array<{ id: string; job_id: string; status: JobItemStatus }>) {
          this.setItem(it.id, it.status, 'cancelled', { active: 0, finished_at: this.ctx.now() }, 'Zuordnung entfernt')
          touchedJobs.add(it.job_id)
          n++
        }
      }
      // Verschiebe-Einträge ohne verbleibende Kopien stornieren
      for (const jobId of touchedJobs) {
        const rel = this.ctx.db.prepare("SELECT id, media_id, status FROM job_items WHERE job_id=? AND kind='release_source' AND status='waiting'").all(jobId) as Array<{
          id: string
          media_id: number
          status: JobItemStatus
        }>
        for (const r of rel) {
          const left = this.ctx.db
            .prepare("SELECT COUNT(*) AS n FROM job_items WHERE job_id=? AND kind='copy' AND media_id=? AND status != 'cancelled'")
            .get(jobId, r.media_id) as { n: number }
          if (left.n === 0) this.setItem(r.id, r.status, 'cancelled', { active: 0, finished_at: this.ctx.now() }, 'keine Zielkopien mehr vorgesehen')
        }
      }
    })
    tx()
    for (const j of touchedJobs) this.changed(this.job(j).project_id)
    this.kick()
    return n
  }

  // ------------------------------------------------------------------ Absturz-Abgleich

  /**
   * Muss beim Start vor start() aufgerufen werden. Gleicht unterbrochene Einträge mit dem
   * Dateisystem ab und pausiert alle offenen Aufträge (kein blindes Wiederholen).
   */
  async reconcile(): Promise<{ interruptedJobs: number; fixedItems: number; notes: string[] }> {
    const db = this.ctx.db
    const notes: string[] = []
    let fixed = 0
    const items = db.prepare(`SELECT * FROM job_items WHERE status IN (${IN_PROGRESS.map(() => '?').join(',')})`).all(...IN_PROGRESS) as ItemRow[]
    for (const it of items) {
      try {
        const note = await this.reconcileItem(it)
        if (note) notes.push(`${it.file_name}: ${note}`)
        fixed++
      } catch (e) {
        this.setItem(it.id, it.status, 'failed', { error_code: 'RECONCILE', error_message: (e as Error).message, retry_at: null }, 'Abgleich nach Absturz fehlgeschlagen')
        notes.push(`${it.file_name}: Abgleich fehlgeschlagen – ${(e as Error).message}`)
      }
    }
    // Übriggebliebene Zwischendateien im Wiederherstellungsbereich (staging ohne aktiven Eintrag)
    const staging = db.prepare("SELECT * FROM recovery_items WHERE status = 'staging'").all() as Array<{ id: string; recovery_path: string; job_item_id: string | null }>
    for (const s of staging) {
      const it = s.job_item_id ? (db.prepare('SELECT status FROM job_items WHERE id = ?').get(s.job_item_id) as { status: string } | undefined) : undefined
      if (!it || !IN_PROGRESS.includes(it.status as JobItemStatus)) {
        // nur verwerfen, wenn die Originalquelle noch existiert – sonst ist dies die einzige Kopie
        const media = db.prepare('SELECT m.current_path, m.location FROM media m JOIN recovery_items r ON r.media_id = m.id WHERE r.id = ?').get(s.id) as
          | { current_path: string; location: string }
          | undefined
        if (media && media.location === 'source' && (await exists(media.current_path))) {
          await unlinkIfExists(s.recovery_path)
          db.prepare("UPDATE recovery_items SET status='discarded', updated_at=? WHERE id=?").run(this.ctx.now(), s.id)
        }
      }
    }
    const t = this.ctx.now()
    const open = db.prepare("SELECT id, project_id, status FROM jobs WHERE status IN ('queued','running')").all() as Array<{ id: string; project_id: string; status: string }>
    for (const j of open) {
      db.prepare("UPDATE jobs SET status='paused', interrupted=1, updated_at=? WHERE id=?").run(t, j.id)
      oplog(this.ctx, j.project_id, 'warn', 'job.interrupted', 'job', j.id, { previous: j.status })
    }
    const pausedTotal = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='paused'").get() as { n: number }).n
    return { interruptedJobs: pausedTotal, fixedItems: fixed, notes }
  }

  private async reconcileItem(it: ItemRow): Promise<string | null> {
    if (it.kind === 'copy') return this.reconcileCopy(it)
    if (it.kind === 'release_source') return this.reconcileRelease(it)
    return this.reconcileRestore(it)
  }

  private async reconcileCopy(it: ItemRow): Promise<string | null> {
    if (it.status === 'committing' && it.final_path && it.result_sha256) {
      const st = await statOrNull(it.final_path)
      if (st && st.size === it.src_size) {
        const h = await this.ctx.fileOps.hashFile(it.final_path)
        if (h.sha256 === it.result_sha256) {
          await unlinkIfExists(it.tmp_path)
          this.finishCopy(it, it.final_path, it.result_sha256, 'exported', 'nach Absturz als abgeschlossen erkannt')
          return 'Zieldatei war bereits vollständig – als erledigt markiert.'
        }
      }
    }
    await unlinkIfExists(it.tmp_path)
    this.setItem(it.id, it.status, 'pending', { tmp_path: null, final_path: null }, 'nach Absturz zurückgesetzt')
    return null
  }

  private async reconcileRelease(it: ItemRow): Promise<string | null> {
    const db = this.ctx.db
    const rec = it.recovery_item_id
      ? (db.prepare('SELECT * FROM recovery_items WHERE id = ?').get(it.recovery_item_id) as { id: string; recovery_path: string; sha256: string; status: string } | undefined)
      : undefined
    const media = it.media_id ? this.media(it.media_id) : null
    const srcPath = media?.location === 'source' ? media.current_path : it.src_path
    const srcExists = await exists(srcPath)
    await unlinkIfExists(it.tmp_path)
    const recExists = rec ? await exists(rec.recovery_path) : false
    let recValid = false
    if (rec && recExists) {
      const h = await this.ctx.fileOps.hashFile(rec.recovery_path)
      recValid = h.sha256 === rec.sha256 && h.size === it.src_size
    }
    if (srcExists) {
      // Quelle noch vorhanden: eventuelle Wiederherstellungskopie verwerfen und von vorn beginnen
      if (rec && recExists) await unlinkIfExists(rec.recovery_path)
      if (rec) db.prepare("UPDATE recovery_items SET status='discarded', updated_at=? WHERE id=?").run(this.ctx.now(), rec.id)
      this.setItem(it.id, it.status, 'waiting', { recovery_item_id: null, tmp_path: null }, 'nach Absturz zurückgesetzt, Quelle unverändert')
      return null
    }
    if (rec && recValid) {
      this.commitRelease(it, rec.id, rec.recovery_path, rec.sha256, 'nach Absturz abgeschlossen')
      return 'Verschieben in den Wiederherstellungsbereich wurde abgeschlossen.'
    }
    // Weder Quelle noch gültige Wiederherstellungskopie: extern verändert – laut melden
    this.setItem(it.id, it.status, 'failed', { error_code: 'SOURCE_MISSING', error_message: 'Quelle und Wiederherstellungskopie fehlen (extern verändert?).', retry_at: null })
    oplog(this.ctx, it.project_id, 'error', 'release.lost', 'media', it.media_id, { src: srcPath, recovery: rec?.recovery_path })
    if (it.media_id) db.prepare("UPDATE media SET location='missing', updated_at=? WHERE id=?").run(this.ctx.now(), it.media_id)
    return 'Quelle fehlt – bitte prüfen.'
  }

  private async reconcileRestore(it: ItemRow): Promise<string | null> {
    if ((it.status === 'committing' || it.status === 'source_removing') && it.final_path && it.src_sha256) {
      const st = await statOrNull(it.final_path)
      if (st && st.size === it.src_size) {
        const h = await this.ctx.fileOps.hashFile(it.final_path)
        if (h.sha256 === it.src_sha256) {
          await unlinkIfExists(it.tmp_path)
          await this.finishRestore(it, it.final_path)
          return 'Wiederherstellung war bereits vollständig.'
        }
      }
    }
    await unlinkIfExists(it.tmp_path)
    this.setItem(it.id, it.status, 'pending', { tmp_path: null, final_path: null }, 'nach Absturz zurückgesetzt')
    return null
  }

  // ------------------------------------------------------------------ Warteschlange

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      do {
        this.repump = false
        if (!this.running || this.crashed) break
        while (this.inflight.size < this.concurrency) {
          const next = this.nextRunnable()
          if (!next) break
          this.launch(next)
        }
        this.finalizeJobs()
      } while (this.repump)
    } finally {
      this.pumping = false
    }
    this.scheduleRetry()
    if (this.inflight.size === 0) this.resolveIdle()
  }

  private scheduleRetry(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.running || this.crashed) return
    const r = this.ctx.db
      .prepare(
        "SELECT MIN(i.retry_at) AS t FROM job_items i JOIN jobs j ON j.id = i.job_id WHERE i.status='failed' AND i.retry_at IS NOT NULL AND j.status IN ('queued','running')"
      )
      .get() as { t: number | null }
    const d = this.ctx.db.prepare("SELECT MIN(start_after) AS t FROM jobs WHERE status = 'queued' AND start_after IS NOT NULL").get() as { t: number | null }
    const next = [r.t, d.t].filter((x): x is number => x != null)
    if (next.length) r.t = Math.min(...next)
    if (r.t != null) {
      const delay = Math.max(50, r.t - this.ctx.now())
      this.timer = setTimeout(() => this.kick(), delay)
      this.timer.unref?.()
    }
  }

  private nextRunnable(): ItemRow | null {
    const now = this.ctx.now()
    const db = this.ctx.db
    // Je Auftrag (älteste zuerst) nur wenige Kandidaten je Status lesen – nutzt idx_items_job_status_seq
    const jobs = db
      .prepare("SELECT id FROM jobs WHERE status IN ('queued','running') AND (start_after IS NULL OR start_after <= ?) ORDER BY created_at")
      .all(now) as Array<{ id: string }>
    const byStatus = db.prepare('SELECT * FROM job_items WHERE job_id = ? AND status = ? ORDER BY seq LIMIT 64')
    const retries = db.prepare("SELECT * FROM job_items WHERE job_id = ? AND status = 'failed' AND retry_at IS NOT NULL AND retry_at <= ? ORDER BY seq LIMIT 16")
    const candidates: ItemRow[] = []
    for (const j of jobs) {
      candidates.push(...(byStatus.all(j.id, 'pending') as ItemRow[]), ...(retries.all(j.id, now) as ItemRow[]), ...(byStatus.all(j.id, 'waiting') as ItemRow[]))
      if (candidates.length >= 64) break
    }
    for (const it of candidates) {
      if (this.inflight.has(it.id)) continue
      if (it.media_id != null && this.busyMedia.has(it.media_id)) continue
      if (it.kind === 'release_source') {
        const gate = this.releaseGate(it)
        if (gate === 'wait') continue
        if (gate === 'blocked') {
          this.setItem(it.id, it.status, 'failed', { error_code: 'SOURCE_KEPT', error_message: ERR_TEXT.SOURCE_KEPT, retry_at: null })
          this.changed(it.project_id)
          continue
        }
      }
      return it
    }
    return null
  }

  /** Verschieben darf erst starten, wenn alle Zielkopien desselben Auftrags für das Medium verifiziert sind (I1). */
  private releaseGate(it: ItemRow): 'go' | 'wait' | 'blocked' {
    const sibs = this.ctx.db.prepare("SELECT status, note, retry_at FROM job_items WHERE job_id = ? AND kind = 'copy' AND media_id = ?").all(it.job_id, it.media_id) as Array<{
      status: JobItemStatus
      note: string | null
      retry_at: number | null
    }>
    let waiting = false
    let blocked = false
    let anyDone = false
    for (const s of sibs) {
      if (s.status === 'done') anyDone = true
      else if (s.status === 'skipped' && s.note === 'identical') anyDone = true
      else if (s.status === 'cancelled') continue
      else if (s.status === 'skipped') blocked = true
      else if (s.status === 'failed' && s.retry_at == null) blocked = true
      else waiting = true
    }
    if (waiting) return 'wait'
    if (blocked || !anyDone) return 'blocked'
    return 'go'
  }

  private launch(it: ItemRow): void {
    const ac = new AbortController()
    this.inflight.set(it.id, { ac, mediaId: it.media_id, jobId: it.job_id })
    if (it.media_id != null) this.busyMedia.add(it.media_id)
    it = { ...it, attempts: it.attempts + 1 }
    this.ctx.db.transaction(() => {
      this.ctx.db.prepare('UPDATE job_items SET attempts = attempts + 1 WHERE id = ?').run(it.id)
      this.ctx.db
        .prepare("UPDATE jobs SET status='running', started_at=COALESCE(started_at, ?), updated_at=? WHERE id=? AND status='queued'")
        .run(this.ctx.now(), this.ctx.now(), it.job_id)
    })()
    void this.execute(it, ac.signal)
      .catch((e) => {
        if (e instanceof SimulatedCrash) {
          this.crashed = e
          this.running = false
          return
        }
        // Unerwarteter Fehler außerhalb der Fehlerbehandlung – Eintrag als fehlgeschlagen markieren
        try {
          const cur = this.item(it.id)
          if (cur && !TERMINAL.includes(cur.status)) this.setItem(it.id, cur.status, 'failed', { error_code: 'INTERNAL', error_message: String((e as Error)?.message ?? e), retry_at: null })
        } catch {
          /* ignorieren */
        }
      })
      .finally(() => {
        this.inflight.delete(it.id)
        if (it.media_id != null) this.busyMedia.delete(it.media_id)
        this.changed(it.project_id)
        if (this.crashed) this.resolveIdle()
        else this.kick()
      })
  }

  private async execute(it: ItemRow, signal: AbortSignal): Promise<void> {
    try {
      if (it.kind === 'copy') await this.runCopy(it, signal)
      else if (it.kind === 'release_source') await this.runRelease(it, signal)
      else await this.runRestore(it, signal)
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e
      await this.handleFailure(it.id, e)
    }
  }

  private async handleFailure(itemId: string, e: unknown): Promise<void> {
    const cur = this.item(itemId)
    if (!cur) return
    // Aufräumen: eigene Zwischendatei entfernen
    try {
      await unlinkIfExists(cur.tmp_path)
    } catch {
      /* best effort */
    }
    if (cur.kind === 'release_source' && cur.recovery_item_id) {
      // Quelle bereits (atomar) verschoben und Kopie im Wiederherstellungsbereich gültig? Dann abschließen statt verwerfen.
      if (await this.completeIfMoved(cur)) return
      await this.discardStagedRecovery(cur)
    }
    if (e instanceof AbortError) {
      const job = this.job(cur.job_id)
      const next: JobItemStatus = job.status === 'cancelled' ? 'cancelled' : cur.kind === 'release_source' ? 'waiting' : 'pending'
      this.setItem(
        cur.id,
        cur.status,
        next,
        { tmp_path: null, final_path: null, recovery_item_id: null, active: next === 'cancelled' ? 0 : 1, attempts: Math.max(0, cur.attempts - 1) },
        'abgebrochen/pausiert'
      )
      return
    }
    const te = classifyError(e)
    const willRetry = te.transient && cur.attempts < cur.max_attempts
    this.setItem(
      cur.id,
      cur.status,
      'failed',
      {
        error_code: te.code,
        error_message: te.message,
        tmp_path: null,
        retry_at: willRetry ? this.ctx.now() + this.retryDelays[Math.max(0, Math.min(cur.attempts - 1, this.retryDelays.length - 1))] : null
      },
      willRetry ? 'automatischer neuer Versuch geplant' : undefined
    )
    oplog(this.ctx, cur.project_id, 'error', `item.${cur.kind}.failed`, 'job_item', cur.id, { code: te.code, message: te.message, file: cur.file_name })
  }

  private async completeIfMoved(it: ItemRow): Promise<boolean> {
    const rec = this.ctx.db.prepare('SELECT * FROM recovery_items WHERE id = ?').get(it.recovery_item_id) as
      | { id: string; recovery_path: string; sha256: string; status: string }
      | undefined
    if (!rec || rec.status !== 'staging') return false
    const media = it.media_id ? this.media(it.media_id) : null
    const srcPath = media?.location === 'source' ? media.current_path : it.src_path
    if (await exists(srcPath)) return false
    const st = await statOrNull(rec.recovery_path)
    if (!st || st.size !== it.src_size) return false
    const h = await this.ctx.fileOps.hashFile(rec.recovery_path)
    if (h.sha256 !== rec.sha256) return false
    this.commitRelease(it, rec.id, rec.recovery_path, rec.sha256, 'nach Fehler abgeschlossen (Quelle bereits gesichert)')
    return true
  }

  private async discardStagedRecovery(it: ItemRow): Promise<void> {
    const rec = this.ctx.db.prepare('SELECT * FROM recovery_items WHERE id = ?').get(it.recovery_item_id) as { id: string; recovery_path: string; status: string } | undefined
    if (!rec || rec.status !== 'staging') return
    const media = it.media_id ? this.media(it.media_id) : null
    const srcPath = media?.location === 'source' ? media.current_path : it.src_path
    // Nur verwerfen, wenn die Quelle nachweislich noch existiert (sonst ist dies die einzige Kopie)
    if (await exists(srcPath)) {
      await unlinkIfExists(rec.recovery_path)
      this.ctx.db.prepare("UPDATE recovery_items SET status='discarded', updated_at=? WHERE id=?").run(this.ctx.now(), rec.id)
    }
  }

  private finalizeJobs(): void {
    const db = this.ctx.db
    const open = db.prepare("SELECT id, project_id FROM jobs WHERE status IN ('queued','running')").all() as Array<{ id: string; project_id: string }>
    const hasOpen = db.prepare(
      `SELECT 1 FROM job_items WHERE job_id = ? AND status IN ('pending','waiting','copying','verifying','committing','recovery_copying','recovery_committed','source_removing') LIMIT 1`
    )
    const hasRetry = db.prepare("SELECT 1 FROM job_items WHERE job_id = ? AND status = 'failed' AND retry_at IS NOT NULL LIMIT 1")
    const hasFailed = db.prepare("SELECT 1 FROM job_items WHERE job_id = ? AND status = 'failed' LIMIT 1")
    for (const j of open) {
      const c = { open: hasOpen.get(j.id) || hasRetry.get(j.id) ? 1 : 0, failed: hasFailed.get(j.id) ? 1 : 0 }
      if ((c.open ?? 0) > 0) continue
      if ([...this.inflight.values()].some((f) => f.jobId === j.id)) continue
      const t = this.ctx.now()
      const status: JobStatus = (c.failed ?? 0) > 0 ? 'completed_with_errors' : 'completed'
      db.transaction(() => {
        db.prepare('UPDATE jobs SET status=?, finished_at=?, updated_at=? WHERE id=?').run(status, t, t, j.id)
        // Endgültig fehlgeschlagene Einträge geben ihren Idempotenzschlüssel frei (erneut planbar)
        db.prepare("UPDATE job_items SET active=0 WHERE job_id=? AND status='failed'").run(j.id)
      })()
      oplog(this.ctx, j.project_id, status === 'completed' ? 'info' : 'warn', 'job.finished', 'job', j.id, { status })
      const sum = db
        .prepare("SELECT j.label, j.mode, SUM(CASE WHEN i.status IN ('done','skipped') THEN 1 ELSE 0 END) AS done, SUM(CASE WHEN i.status='failed' THEN 1 ELSE 0 END) AS failed FROM jobs j JOIN job_items i ON i.job_id = j.id WHERE j.id = ? AND i.kind != 'release_source'")
        .get(j.id) as { label: string; mode: WorkMode; done: number | null; failed: number | null }
      this.ctx.emit({ type: 'job-finished', projectId: j.project_id, jobId: j.id, status, mode: sum.mode, label: sum.label, done: sum.done ?? 0, failed: sum.failed ?? 0 })
      this.changed(j.project_id)
    }
  }

  // ------------------------------------------------------------------ Kopieren (Medium -> Paketziel)

  private async resolveSource(it: ItemRow): Promise<{ path: string; expectedSha: string | null }> {
    const media = it.media_id ? this.media(it.media_id) : null
    if (!media) throw new TransferError('SOURCE_MISSING', 'Medium wurde aus dem Projekt entfernt.')
    const expectedSha = it.src_sha256 ?? (media.size === it.src_size && media.mtime_ms === it.src_mtime_ms ? media.sha256 : null)
    const candidates: string[] = []
    if (media.location !== 'missing') candidates.push(media.current_path)
    if (!candidates.includes(it.src_path)) candidates.push(it.src_path)
    let sawChanged = false
    for (const c of candidates) {
      const st = await statOrNull(c)
      if (!st || !st.isFile()) continue
      if (st.size !== it.src_size) {
        sawChanged = true
        continue
      }
      // mtime gilt nur am Originalort (eine Kopie im Wiederherstellungsbereich hat ggf. neue mtime)
      if (pathKey(c) === pathKey(media.original_path) && Math.round(st.mtimeMs) !== it.src_mtime_ms) {
        sawChanged = true
        continue
      }
      return { path: c, expectedSha }
    }
    // Rückfall: verifizierte Exportkopie mit identischer Prüfsumme (nur wenn Prüfsumme bekannt)
    if (expectedSha) {
      const dests = this.ctx.db.prepare('SELECT path FROM transfer_destinations WHERE media_id = ? AND sha256 = ?').all(media.id, expectedSha) as Array<{ path: string }>
      for (const d of dests) {
        const st = await statOrNull(d.path)
        if (st && st.size === it.src_size) return { path: d.path, expectedSha }
      }
    }
    if (sawChanged) throw new TransferError('SOURCE_CHANGED', ERR_TEXT.SOURCE_CHANGED)
    throw new TransferError('SOURCE_MISSING', ERR_TEXT.SOURCE_MISSING)
  }

  private async ensureTargetDir(dir: string): Promise<void> {
    try {
      await fs.promises.mkdir(dir, { recursive: true })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENODEV' || code === 'EROFS' || code === 'ENOTDIR') throw new TransferError('TARGET_MISSING', `${ERR_TEXT.TARGET_MISSING} (${dir})`)
      throw e
    }
  }

  private async checkSpace(dir: string, bytes: number): Promise<void> {
    const free = await freeBytes(dir)
    if (free !== null && free < bytes + SPACE_MARGIN) throw new TransferError('DISK_FULL', ERR_TEXT.DISK_FULL)
  }

  private async runCopy(it: ItemRow, signal: AbortSignal): Promise<void> {
    const job = this.job(it.job_id)
    const destDir = it.dest_dir!
    const destName = it.dest_name!
    const src = await this.resolveSource(it)
    await this.ensureTargetDir(destDir)

    // Vorabprüfung: identische Datei bereits am Ziel?
    const direct = path.join(destDir, destName)
    const dst = await statOrNull(direct)
    if (dst && dst.size === it.src_size) {
      const srcHash = src.expectedSha ?? (await this.ctx.fileOps.hashFile(src.path, signal)).sha256
      const dh = await this.ctx.fileOps.hashFile(direct, signal)
      if (dh.sha256 === srcHash) {
        this.finishCopy(it, direct, srcHash, 'identical_existing', 'identical')
        return
      }
    }
    if (dst && job.conflict_policy === 'skip') {
      this.setItem(it.id, it.status, 'skipped', { active: 0, finished_at: this.ctx.now() }, 'conflict')
      return
    }

    await this.checkSpace(destDir, it.src_size)
    const tmp = path.join(destDir, `${TMP_PREFIX}${it.id}${TMP_SUFFIX}`)
    await unlinkIfExists(tmp)
    const preStat = await fs.promises.stat(src.path).catch((e) => {
      throw classifyError(e, 'source')
    })
    // I3: Zwischendatei vermerken, bevor sie entsteht
    this.setItem(it.id, it.status, 'copying', { tmp_path: tmp, started_at: this.ctx.now(), retry_at: null, error_code: null, error_message: null })
    await this.ctx.faults.hit('copy:afterTmpCreated', { item: it })
    let copied
    try {
      copied = await this.ctx.fileOps.copyWithHash(src.path, tmp, signal)
    } catch (e) {
      if (e instanceof AbortError) throw e
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' && !(await exists(src.path))) throw new TransferError('SOURCE_MISSING', ERR_TEXT.SOURCE_MISSING)
      if (code === 'EBUSY' || code === 'EPERM') throw classifyError(e, 'source')
      throw classifyError(e)
    }
    await this.ctx.faults.hit('copy:afterTmpWritten', { item: it, tmp })
    if (copied.size !== it.src_size) throw new TransferError('SOURCE_CHANGED', ERR_TEXT.SOURCE_CHANGED)
    if (src.expectedSha && copied.sha256 !== src.expectedSha) throw new TransferError('SOURCE_CHANGED', ERR_TEXT.SOURCE_CHANGED)

    this.setItem(it.id, 'copying', 'verifying', { result_sha256: copied.sha256 })
    const verify = await this.ctx.fileOps.hashFile(tmp, signal)
    if (verify.sha256 !== copied.sha256 || verify.size !== copied.size) throw new TransferError('VERIFY_MISMATCH', ERR_TEXT.VERIFY_MISMATCH, true)
    await this.ctx.faults.hit('copy:afterVerify', { item: it, tmp })

    // Quelle während des Kopierens unverändert?
    const postStat = await statOrNull(src.path)
    if (!postStat || postStat.size !== preStat.size || Math.round(postStat.mtimeMs) !== Math.round(preStat.mtimeMs))
      throw new TransferError('SOURCE_CHANGED', 'Quelldatei wurde während des Kopierens verändert.')

    // Commit unter Ordnersperre: freien Namen bestimmen, ohne Überschreiben festschreiben (I2)
    await this.dirMutex.run(pathKey(destDir), async () => {
      for (let n = 1; n < 10000; n++) {
        const name = numberedName(destName, n)
        const final = path.join(destDir, name)
        const st = await statOrNull(final)
        if (st) {
          if (st.size === copied.size) {
            const h = await this.ctx.fileOps.hashFile(final)
            if (h.sha256 === copied.sha256) {
              await unlinkIfExists(tmp)
              this.finishCopy({ ...it, status: 'verifying' }, final, copied.sha256, 'identical_existing', 'identical')
              return
            }
          }
          if (n === 1 && job.conflict_policy === 'skip') {
            await unlinkIfExists(tmp)
            this.setItem(it.id, 'verifying', 'skipped', { active: 0, tmp_path: null, finished_at: this.ctx.now() }, 'conflict')
            return
          }
          continue
        }
        this.setItem(it.id, this.item(it.id)!.status, 'committing', { final_path: final })
        await this.ctx.faults.hit('copy:beforeCommit', { item: it, tmp, final })
        const ok = await commitNoOverwrite(tmp, final)
        if (!ok) continue
        await this.ctx.faults.hit('copy:afterCommit', { item: it, final })
        this.finishCopy({ ...it, status: 'committing' }, final, copied.sha256, 'exported', n > 1 ? 'umbenannt' : undefined)
        return
      }
      throw new TransferError('NAME_EXHAUSTED', 'Kein freier Dateiname im Zielordner gefunden.')
    })
  }

  private finishCopy(it: ItemRow, finalPath: string, sha: string, kind: 'exported' | 'identical_existing', note?: string): void {
    const db = this.ctx.db
    const t = this.ctx.now()
    db.transaction(() => {
      const cur = this.item(it.id)!
      const status: JobItemStatus = kind === 'exported' ? 'done' : 'skipped'
      this.setItem(it.id, cur.status, status, { active: 0, final_path: finalPath, result_sha256: sha, tmp_path: null, finished_at: t, retry_at: null }, note)
      if (it.package_id) {
        db.prepare(
          `INSERT INTO transfer_destinations (id, project_id, media_id, package_id, package_name, path, sha256, size, status, job_item_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(media_id, package_id) DO UPDATE SET path=excluded.path, sha256=excluded.sha256, size=excluded.size,
             status=excluded.status, job_item_id=excluded.job_item_id, created_at=excluded.created_at`
        ).run(newId(), it.project_id, it.media_id, it.package_id, it.package_name ?? '', finalPath, sha, it.src_size, kind, it.id, t)
      }
      if (it.media_id) {
        db.prepare('UPDATE media SET sha256 = COALESCE(sha256, ?), hashed_at = COALESCE(hashed_at, ?) WHERE id = ? AND size = ? AND mtime_ms = ?').run(
          sha,
          t,
          it.media_id,
          it.src_size,
          it.src_mtime_ms
        )
      }
    })()
  }

  // ------------------------------------------------------------------ Verschieben: Quelle -> Wiederherstellungsbereich

  private async runRelease(it: ItemRow, signal: AbortSignal): Promise<void> {
    const db = this.ctx.db
    const media = it.media_id ? this.media(it.media_id) : null
    if (!media) throw new TransferError('SOURCE_MISSING', 'Medium wurde aus dem Projekt entfernt.')
    if (media.location === 'recovery') {
      this.setItem(it.id, it.status, 'done', { active: 0, finished_at: this.ctx.now() }, 'bereits im Wiederherstellungsbereich')
      return
    }
    if (media.location === 'missing') throw new TransferError('SOURCE_MISSING', ERR_TEXT.SOURCE_MISSING)
    const src = media.current_path
    const st = await statOrNull(src)
    if (!st) throw new TransferError('SOURCE_MISSING', ERR_TEXT.SOURCE_MISSING)
    if (st.size !== it.src_size || Math.round(st.mtimeMs) !== it.src_mtime_ms) throw new TransferError('SOURCE_CHANGED', ERR_TEXT.SOURCE_CHANGED)

    // Erwartete Prüfsumme aus den verifizierten Zielkopien dieses Auftrags
    const shas = db
      .prepare("SELECT DISTINCT result_sha256 AS s FROM job_items WHERE job_id = ? AND kind = 'copy' AND media_id = ? AND result_sha256 IS NOT NULL AND status IN ('done','skipped')")
      .all(it.job_id, it.media_id) as Array<{ s: string }>
    if (shas.length !== 1) throw new TransferError('VERIFY_MISMATCH', 'Zielkopien haben keine eindeutige Prüfsumme – Quelle bleibt erhalten.')
    const expected = shas[0].s

    const project = getProject(this.ctx, it.project_id)
    const month = new Date(this.ctx.now()).toISOString().slice(0, 7)
    const sub = path.join(month, `${media.id}-${it.id.slice(0, 8)}`)
    // Bevorzugt Wiederherstellungsbereich auf dem Laufwerk der Quelle (schnelles Umbenennen); sonst Standardort
    let recDir = path.join(await resolveRecoveryDir(this.ctx, project, src), sub)
    try {
      await fs.promises.mkdir(recDir, { recursive: true })
      await hideVolumeRecoveryDir(recDir)
    } catch {
      recDir = path.join(project.recoveryDir, sub)
      try {
        await fs.promises.mkdir(recDir, { recursive: true })
      } catch (e) {
        throw new TransferError('RECOVERY_UNAVAILABLE', 'Wiederherstellungsbereich nicht beschreibbar: ' + (e as Error).message)
      }
    }
    const recPath = path.join(recDir, media.file_name)
    const recId = newId()
    const t = this.ctx.now()
    const recDev = (await fs.promises.stat(recDir)).dev
    // Quellen in Cloud-Ordnern (Proton Drive, OneDrive …) nie per Umbenennen verschieben: Platzhalter könnten
    // Reparse-Daten mitnehmen; stattdessen verifizierte Kopie in den Wiederherstellungsbereich, dann Löschen.
    const cloud = this.ctx.db.prepare('SELECT s.cloud_provider AS p FROM media m JOIN sources s ON s.id = m.source_id WHERE m.id = ?').get(media.id) as
      | { p: string | null }
      | undefined
    const sameVolume = st.dev === recDev && !cloud?.p

    // Muss vor dem Verschieben der Quelle dauerhaft gespeichert sein (Abgleich nach Stromausfall)
    durable(db, () => {
      db.prepare(
        `INSERT INTO recovery_items (id, project_id, media_id, file_name, original_path, recovery_path, size, sha256, status, job_item_id, moved_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,'staging',?,?,?)`
      ).run(recId, it.project_id, media.id, media.file_name, media.original_path, recPath, it.src_size, expected, it.id, t, t)
      this.setItem(it.id, it.status, sameVolume ? 'source_removing' : 'recovery_copying', {
        recovery_item_id: recId,
        started_at: t,
        retry_at: null,
        error_code: null,
        error_message: null
      })
    })

    if (sameVolume) {
      // Gleicher Datenträger: atomare Umbenennung (Quelle existiert danach entweder alt ODER neu)
      await this.ctx.faults.hit('release:beforeMove', { item: it })
      // Unmittelbar vorher Quelle erneut prüfen
      const again = await statOrNull(src)
      if (!again || again.size !== it.src_size || Math.round(again.mtimeMs) !== it.src_mtime_ms) throw new TransferError('SOURCE_CHANGED', ERR_TEXT.SOURCE_CHANGED)
      if (await exists(recPath)) throw new TransferError('RECOVERY_CONFLICT', 'Zielpfad im Wiederherstellungsbereich existiert bereits.')
      try {
        await fs.promises.rename(src, recPath)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw classifyError(e, 'source')
        // Doch unterschiedliche Datenträger (z. B. Mountpunkt) -> Kopierweg
        this.setItem(it.id, 'source_removing', 'recovery_copying', {})
        await this.releaseByCopy(it, src, recDir, recPath, recId, expected, signal)
        return
      }
      const after = await statOrNull(recPath)
      if (!after || after.size !== it.src_size) throw new TransferError('VERIFY_MISMATCH', 'Datei im Wiederherstellungsbereich unvollständig.')
      await this.ctx.faults.hit('release:afterSourceRemoved', { item: it })
      this.commitRelease(it, recId, recPath, expected)
      return
    }
    await this.releaseByCopy(it, src, recDir, recPath, recId, expected, signal)
  }

  private async releaseByCopy(it: ItemRow, src: string, recDir: string, recPath: string, recId: string, expected: string, signal: AbortSignal): Promise<void> {
    await this.checkSpace(recDir, it.src_size)
    const tmp = path.join(recDir, `${TMP_PREFIX}${it.id}${TMP_SUFFIX}`)
    this.setItem(it.id, 'recovery_copying', 'recovery_copying', { tmp_path: tmp })
    const c = await this.ctx.fileOps.copyWithHash(src, tmp, signal)
    if (c.sha256 !== expected || c.size !== it.src_size) throw new TransferError('SOURCE_CHANGED', 'Quelle weicht von den exportierten Kopien ab – Quelle bleibt erhalten.')
    const v = await this.ctx.fileOps.hashFile(tmp, signal)
    if (v.sha256 !== expected) throw new TransferError('VERIFY_MISMATCH', ERR_TEXT.VERIFY_MISMATCH, true)
    await this.ctx.faults.hit('release:afterRecoveryCopy', { item: it })
    if (!(await commitNoOverwrite(tmp, recPath))) throw new TransferError('RECOVERY_CONFLICT', 'Zielpfad im Wiederherstellungsbereich existiert bereits.')
    this.setItem(it.id, 'recovery_copying', 'recovery_committed', { tmp_path: null })
    await this.ctx.faults.hit('release:afterRecoveryCommit', { item: it })
    // Quelle unverändert? Erst dann entfernen.
    const st = await statOrNull(src)
    if (!st || st.size !== it.src_size || Math.round(st.mtimeMs) !== it.src_mtime_ms) throw new TransferError('SOURCE_CHANGED', ERR_TEXT.SOURCE_CHANGED)
    durable(this.ctx.db, () => this.setItem(it.id, 'recovery_committed', 'source_removing', {}))
    try {
      await fs.promises.unlink(src)
    } catch (e) {
      throw classifyError(e, 'source')
    }
    await this.ctx.faults.hit('release:afterSourceRemoved', { item: it })
    this.commitRelease(it, recId, recPath, expected)
  }

  private commitRelease(it: ItemRow, recId: string, recPath: string, sha: string, note?: string): void {
    const db = this.ctx.db
    const t = this.ctx.now()
    const retention = getSettings(this.ctx).recoveryRetentionDays
    db.transaction(() => {
      db.prepare("UPDATE recovery_items SET status='held', retain_until=?, updated_at=? WHERE id=?").run(t + retention * 86400000, t, recId)
      if (it.media_id) {
        db.prepare("UPDATE media SET location='recovery', current_path=?, path_key=?, sha256=?, updated_at=? WHERE id=?").run(recPath, 'recovery:' + pathKey(recPath), sha, t, it.media_id)
      }
      const cur = this.item(it.id)!
      this.setItem(it.id, cur.status, 'done', { active: 0, finished_at: t, tmp_path: null }, note)
    })()
    oplog(this.ctx, it.project_id, 'info', 'release.done', 'media', it.media_id, { recoveryPath: recPath })
    this.ctx.emit({ type: 'media-changed', projectId: it.project_id, mediaIds: it.media_id ? [it.media_id] : [] })
    this.ctx.emit({ type: 'recovery-changed', projectId: it.project_id })
  }

  // ------------------------------------------------------------------ Wiederherstellung

  private async runRestore(it: ItemRow, signal: AbortSignal): Promise<void> {
    const db = this.ctx.db
    const rec = db.prepare('SELECT * FROM recovery_items WHERE id = ?').get(it.recovery_item_id) as
      | { id: string; recovery_path: string; sha256: string; status: string; size: number }
      | undefined
    if (!rec || !['held', 'released'].includes(rec.status)) throw new TransferError('RECOVERY_GONE', 'Eintrag im Wiederherstellungsbereich nicht mehr vorhanden.')
    const st = await statOrNull(rec.recovery_path)
    if (!st) throw new TransferError('SOURCE_MISSING', 'Datei im Wiederherstellungsbereich fehlt.')
    const destDir = it.dest_dir!
    await this.ensureTargetDir(destDir)
    await this.checkSpace(destDir, rec.size)
    const tmp = path.join(destDir, `${TMP_PREFIX}${it.id}${TMP_SUFFIX}`)
    await unlinkIfExists(tmp)
    this.setItem(it.id, it.status, 'copying', { tmp_path: tmp, started_at: this.ctx.now(), retry_at: null, error_code: null, error_message: null })
    const c = await this.ctx.fileOps.copyWithHash(rec.recovery_path, tmp, signal)
    if (c.sha256 !== rec.sha256) throw new TransferError('VERIFY_MISMATCH', 'Datei im Wiederherstellungsbereich ist beschädigt (Prüfsumme weicht ab).')
    this.setItem(it.id, 'copying', 'verifying', {})
    const v = await this.ctx.fileOps.hashFile(tmp, signal)
    if (v.sha256 !== rec.sha256) throw new TransferError('VERIFY_MISMATCH', ERR_TEXT.VERIFY_MISMATCH, true)
    await this.dirMutex.run(pathKey(destDir), async () => {
      for (let n = 1; n < 10000; n++) {
        const final = path.join(destDir, numberedName(it.dest_name!, n))
        if (await exists(final)) continue
        const taken = db.prepare('SELECT 1 FROM media WHERE project_id = ? AND path_key = ? AND id != ?').get(it.project_id, pathKey(final), it.media_id ?? -1)
        if (taken) continue
        this.setItem(it.id, this.item(it.id)!.status, 'committing', { final_path: final })
        if (!(await commitNoOverwrite(tmp, final))) continue
        await this.ctx.faults.hit('restore:afterCommit', { item: it, final })
        await this.finishRestore({ ...it, status: 'committing' }, final)
        return
      }
      throw new TransferError('NAME_EXHAUSTED', 'Kein freier Dateiname gefunden.')
    })
  }

  private async finishRestore(it: ItemRow, finalPath: string): Promise<void> {
    const db = this.ctx.db
    const rec = db.prepare('SELECT * FROM recovery_items WHERE id = ?').get(it.recovery_item_id) as { id: string; recovery_path: string } | undefined
    const t = this.ctx.now()
    durable(db, () => {
      this.setItem(it.id, this.item(it.id)!.status, 'source_removing', { final_path: finalPath })
      if (rec) db.prepare("UPDATE recovery_items SET status='restored', restored_at=?, restored_to=?, updated_at=? WHERE id=?").run(t, finalPath, t, rec.id)
      if (it.media_id) {
        const st = fs.statSync(finalPath)
        db.prepare("UPDATE media SET location='source', current_path=?, path_key=?, mtime_ms=?, updated_at=? WHERE id=?").run(
          finalPath,
          pathKey(finalPath),
          Math.round(st.mtimeMs),
          t,
          it.media_id
        )
      }
    })
    // Wiederhergestellte Datei ist verifiziert -> Kopie im Wiederherstellungsbereich entfernen
    if (rec) {
      await unlinkIfExists(rec.recovery_path)
      await fs.promises.rmdir(path.dirname(rec.recovery_path)).catch(() => {})
    }
    this.setItem(it.id, 'source_removing', 'done', { active: 0, finished_at: t, tmp_path: null })
    oplog(this.ctx, it.project_id, 'info', 'recovery.restored', 'recovery', rec?.id, { to: finalPath })
    this.ctx.emit({ type: 'media-changed', projectId: it.project_id, mediaIds: it.media_id ? [it.media_id] : [] })
    this.ctx.emit({ type: 'recovery-changed', projectId: it.project_id })
  }

  // ------------------------------------------------------------------ Abfragen

  listJobs(projectId: string, limit = 100): JobSummary[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT j.*,
           COUNT(i.id) AS total,
           SUM(CASE WHEN i.status='done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN i.status='failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN i.status='skipped' THEN 1 ELSE 0 END) AS skipped,
           SUM(CASE WHEN i.status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
           SUM(CASE WHEN i.kind!='release_source' THEN i.src_size ELSE 0 END) AS bytes,
           SUM(CASE WHEN i.kind!='release_source' AND i.status IN ('done','skipped') THEN i.src_size ELSE 0 END) AS done_bytes
         FROM jobs j LEFT JOIN job_items i ON i.job_id = j.id
         WHERE j.project_id = ? GROUP BY j.id ORDER BY j.created_at DESC LIMIT ?`
      )
      .all(projectId, limit) as Array<JobRow & { total: number; done: number; failed: number; skipped: number; cancelled: number; bytes: number; done_bytes: number }>
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      kind: r.kind,
      mode: r.mode,
      operation: r.operation,
      conflictPolicy: r.conflict_policy,
      status: r.status,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      totalItems: r.total ?? 0,
      doneItems: r.done ?? 0,
      failedItems: r.failed ?? 0,
      skippedItems: r.skipped ?? 0,
      cancelledItems: r.cancelled ?? 0,
      totalBytes: r.bytes ?? 0,
      doneBytes: r.done_bytes ?? 0,
      label: r.label,
      interrupted: !!r.interrupted
    }))
  }

  listItems(jobId: string): JobItemInfo[] {
    const rows = this.ctx.db.prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY seq').all(jobId) as Array<ItemRow & { updated_at: number }>
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      mediaId: r.media_id,
      fileName: r.file_name,
      packageName: r.package_name,
      status: r.status,
      finalPath: r.final_path,
      destDir: r.dest_dir,
      errorCode: r.error_code,
      errorMessage: r.error_message,
      attempts: r.attempts,
      note: r.note,
      updatedAt: r.updated_at
    }))
  }

  // ------------------------------------------------------------------ Interna

  private job(id: string): JobRow {
    const j = this.ctx.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    if (!j) throw new Error('Auftrag nicht gefunden')
    return j
  }

  private item(id: string): ItemRow | undefined {
    return this.ctx.db.prepare('SELECT * FROM job_items WHERE id = ?').get(id) as ItemRow | undefined
  }

  private media(id: number): MediaRowDb | null {
    return (this.ctx.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRowDb | undefined) ?? null
  }

  private setJobStatus(jobId: string, status: JobStatus): void {
    this.ctx.db.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?').run(status, this.ctx.now(), jobId)
  }

  /** Zustandsübergang mit Protokoll (job_item_events). */
  private setItem(id: string, from: JobItemStatus | null, to: JobItemStatus, fields: Record<string, unknown> = {}, note?: string): void {
    const sets = ['status = ?', 'updated_at = ?']
    const vals: unknown[] = [to, this.ctx.now()]
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (note !== undefined) {
      sets.push('note = ?')
      vals.push(note)
    }
    vals.push(id)
    // Status und Protokoll in einer Transaktion (ein Flush statt zwei bei synchronous=FULL)
    this.ctx.db.transaction(() => {
      this.ctx.db.prepare(`UPDATE job_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
      if (from !== to || note) this.event(id, from, to, note ?? null)
    })()
  }

  private event(itemId: string, from: JobItemStatus | null, to: JobItemStatus, note: string | null): void {
    this.ctx.db.prepare('INSERT INTO job_item_events (item_id, ts, from_status, to_status, note) VALUES (?,?,?,?,?)').run(itemId, this.ctx.now(), from, to, note)
  }

  private changed(projectId: string): void {
    this.dirtyProjects.add(projectId)
    const flush = () => {
      this.emitTimer = null
      this.lastEmit = Date.now()
      for (const p of this.dirtyProjects) this.ctx.emit({ type: 'jobs-changed', projectId: p })
      this.dirtyProjects.clear()
    }
    if (Date.now() - this.lastEmit > 200) flush()
    else if (!this.emitTimer) {
      this.emitTimer = setTimeout(flush, 200)
      this.emitTimer.unref?.()
    }
  }

  /** Gesamtfortschritt aller offenen Aufträge (Taskleiste). */
  overallProgress(): { fraction: number; mode: 'none' | 'normal' | 'paused' | 'error' } {
    const r = this.ctx.db
      .prepare(
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN i.status IN ('done','skipped','failed','cancelled') THEN 1 ELSE 0 END) AS fin,
           SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN j.status IN ('queued','running') THEN 1 ELSE 0 END) AS active
         FROM job_items i JOIN jobs j ON j.id = i.job_id WHERE j.status IN ('queued','running','paused')`
      )
      .get() as { total: number; fin: number | null; failed: number | null; active: number | null }
    if (!r.total) return { fraction: -1, mode: 'none' }
    const fraction = (r.fin ?? 0) / r.total
    return { fraction, mode: (r.failed ?? 0) > 0 ? 'error' : (r.active ?? 0) === 0 ? 'paused' : 'normal' }
  }

  hasActiveWork(): boolean {
    const r = this.ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get() as { n: number }
    return r.n > 0 || this.inflight.size > 0
  }
}
