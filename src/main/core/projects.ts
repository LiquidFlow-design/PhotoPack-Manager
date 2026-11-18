import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_FILTERS, DEFAULT_SORT } from '@shared/filters'
import type { ConflictPolicy, Operation, Project, ProjectSummary, ProjectUiState, WorkMode } from '@shared/types'
import { defaultRecoveryBase, newId, oplog, type CoreContext } from './context'
import { getSettings } from './settings'

interface ProjectRow {
  id: string
  name: string
  created_at: number
  updated_at: number
  last_opened_at: number | null
  output_dir: string | null
  work_mode: WorkMode
  operation: Operation
  conflict_policy: ConflictPolicy
  recovery_dir: string | null
  ui_state: string
}

export const DEFAULT_UI: ProjectUiState = { filters: DEFAULT_FILTERS, sort: DEFAULT_SORT, sourceId: null, view: 'grid', packageView: null }

export class ProjectError extends Error {}

function parseUi(s: string): ProjectUiState {
  try {
    const p = JSON.parse(s) as Partial<ProjectUiState>
    return { ...DEFAULT_UI, ...p, filters: { ...DEFAULT_FILTERS, ...(p.filters ?? {}) }, sort: { ...DEFAULT_SORT, ...(p.sort ?? {}) } }
  } catch {
    return DEFAULT_UI
  }
}

/** Projektinterner Wiederherstellungsbereich: <Basis>/<Projekt-ID>. */
export function recoveryDirFor(ctx: CoreContext, projectId: string, custom: string | null): string {
  if (custom) return custom
  const base = getSettings(ctx).recoveryBaseDir || defaultRecoveryBase(ctx)
  return path.join(base, projectId)
}

function toProject(ctx: CoreContext, r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    outputDir: r.output_dir,
    workMode: r.work_mode,
    operation: r.operation,
    conflictPolicy: r.conflict_policy,
    recoveryDir: recoveryDirFor(ctx, r.id, r.recovery_dir),
    recoveryDirCustom: !!r.recovery_dir,
    ui: parseUi(r.ui_state)
  }
}

export function validateProjectName(name: string): string {
  const n = name.trim()
  if (!n) throw new ProjectError('Der Projektname darf nicht leer sein.')
  if (n.length > 120) throw new ProjectError('Der Projektname ist zu lang (max. 120 Zeichen).')
  return n
}

export function createProject(ctx: CoreContext, name: string): Project {
  const n = validateProjectName(name)
  const id = newId()
  const t = ctx.now()
  ctx.db
    .prepare('INSERT INTO projects (id, name, created_at, updated_at, last_opened_at, ui_state) VALUES (?,?,?,?,?,?)')
    .run(id, n, t, t, t, JSON.stringify(DEFAULT_UI))
  oplog(ctx, id, 'info', 'project.create', 'project', id, { name: n })
  return getProject(ctx, id)
}

export function getProject(ctx: CoreContext, id: string): Project {
  const r = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
  if (!r) throw new ProjectError('Projekt nicht gefunden.')
  return toProject(ctx, r)
}

export function projectExists(ctx: CoreContext, id: string): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)
}

export function listProjects(ctx: CoreContext): ProjectSummary[] {
  const rows = ctx.db
    .prepare(
      `SELECT p.id, p.name, p.created_at, p.updated_at, p.last_opened_at,
        (SELECT COUNT(*) FROM media m WHERE m.project_id = p.id) AS media_count,
        (SELECT COUNT(*) FROM packages k WHERE k.project_id = p.id) AS package_count
       FROM projects p ORDER BY COALESCE(p.last_opened_at, p.updated_at) DESC`
    )
    .all() as Array<ProjectRow & { media_count: number; package_count: number }>
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastOpenedAt: r.last_opened_at,
    mediaCount: r.media_count,
    packageCount: r.package_count
  }))
}

export function touchProject(ctx: CoreContext, id: string): void {
  ctx.db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(ctx.now(), id)
}

export function renameProject(ctx: CoreContext, id: string, name: string): Project {
  const n = validateProjectName(name)
  ctx.db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(n, ctx.now(), id)
  oplog(ctx, id, 'info', 'project.rename', 'project', id, { name: n })
  return getProject(ctx, id)
}

export function updateProjectSettings(
  ctx: CoreContext,
  id: string,
  patch: Partial<{ workMode: WorkMode; operation: Operation; conflictPolicy: ConflictPolicy; outputDir: string | null; recoveryDir: string | null }>
): Project {
  const cur = getProject(ctx, id)
  const next = {
    work_mode: patch.workMode ?? cur.workMode,
    operation: patch.operation ?? cur.operation,
    conflict_policy: patch.conflictPolicy ?? cur.conflictPolicy,
    output_dir: patch.outputDir !== undefined ? patch.outputDir : cur.outputDir,
    recovery_dir: patch.recoveryDir !== undefined ? patch.recoveryDir : cur.recoveryDirCustom ? cur.recoveryDir : null
  }
  ctx.db
    .prepare('UPDATE projects SET work_mode=?, operation=?, conflict_policy=?, output_dir=?, recovery_dir=?, updated_at=? WHERE id=?')
    .run(next.work_mode, next.operation, next.conflict_policy, next.output_dir, next.recovery_dir, ctx.now(), id)
  oplog(ctx, id, 'info', 'project.settings', 'project', id, patch)
  return getProject(ctx, id)
}

export function saveUiState(ctx: CoreContext, id: string, ui: ProjectUiState): void {
  ctx.db.prepare('UPDATE projects SET ui_state = ? WHERE id = ?').run(JSON.stringify(ui), id)
}

export interface DeleteProjectResult {
  recoveryDirKept: string | null
  recoveryFiles: number
}

/**
 * Löscht ein Projekt aus der Datenbank. Mediendateien, Exporte und der Wiederherstellungsbereich
 * werden NICHT gelöscht. Aktive Aufträge blockieren das Löschen.
 */
export function deleteProject(ctx: CoreContext, id: string): DeleteProjectResult {
  const p = getProject(ctx, id)
  const active = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND status IN ('queued','running','paused')")
    .get(id) as { n: number }
  if (active.n > 0) throw new ProjectError('Das Projekt hat noch offene Aufträge. Bitte zuerst abschließen oder abbrechen.')
  const rec = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM recovery_items WHERE project_id = ? AND status IN ('staging','held','released')")
    .get(id) as { n: number }
  ctx.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  oplog(ctx, null, 'warn', 'project.delete', 'project', id, { name: p.name, recoveryFiles: rec.n, recoveryDir: p.recoveryDir })
  const kept = rec.n > 0 || (fs.existsSync(p.recoveryDir) && fs.readdirSync(p.recoveryDir).length > 0)
  return { recoveryDirKept: kept ? p.recoveryDir : null, recoveryFiles: rec.n }
}
