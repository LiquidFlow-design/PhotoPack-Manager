// Typisierte Schnittstelle zwischen Renderer und Main-Prozess (über contextBridge).
// Der Renderer übergibt niemals frei gewählte Dateipfade: Ordner werden über native Dialoge im Main-Prozess gewählt.
import type {
  AppEvent,
  AppSettings,
  AssignmentDelta,
  AssignResult,
  ConflictPolicy,
  DuplicateGroup,
  ExportPlanOptions,
  ExportPlanPreview,
  JobItemInfo,
  JobSummary,
  MediaDetail,
  MediaRow,
  Operation,
  PackageInfo,
  Project,
  ProjectBundle,
  ProjectSummary,
  ProjectUiState,
  RecoveryOverview,
  Source,
  StartupInfo,
  TaskProgress,
  WorkMode
} from './types'

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface AddSourceResult {
  status: 'added' | 'cancelled' | 'needs-confirmation' | 'error'
  source?: Source
  confirmToken?: string
  path?: string
  exclusions?: string[]
  error?: string
}

export interface ChooseDirResult {
  status: 'chosen' | 'cancelled' | 'needs-confirmation' | 'error'
  path?: string
  confirmToken?: string
  message?: string
}

export interface PpmApi {
  app: {
    startup(): Promise<StartupInfo>
    getSettings(): Promise<AppSettings>
    updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
    clearThumbCache(): Promise<void>
    openLogFolder(): Promise<void>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    create(name: string): Promise<Project>
    open(id: string): Promise<ProjectBundle>
    rename(id: string, name: string): Promise<Project>
    remove(id: string): Promise<{ recoveryDirKept: string | null; recoveryFiles: number }>
    update(id: string, patch: { workMode?: WorkMode; operation?: Operation; conflictPolicy?: ConflictPolicy }): Promise<Project>
    saveUi(id: string, ui: ProjectUiState): Promise<void>
    chooseOutputDir(id: string, confirmToken?: string): Promise<ChooseDirResult>
    clearOutputDir(id: string): Promise<Project>
    chooseRecoveryDir(id: string): Promise<ChooseDirResult>
    resetRecoveryDir(id: string): Promise<Project>
    tasks(id: string): Promise<TaskProgress[]>
    cancelTask(id: string, kind: TaskProgress['kind']): Promise<void>
  }
  sources: {
    add(projectId: string): Promise<AddSourceResult>
    confirmAdd(projectId: string, token: string): Promise<AddSourceResult>
    rescan(projectId: string, sourceId?: string): Promise<void>
    remove(sourceId: string): Promise<{ removedMedia: number; keptMoved: number }>
    list(projectId: string): Promise<Source[]>
  }
  media: {
    list(projectId: string): Promise<MediaRow[]>
    rows(projectId: string, ids: number[]): Promise<MediaRow[]>
    detail(mediaId: number): Promise<MediaDetail | null>
    reveal(mediaId: number): Promise<void>
    revealPath(kind: 'destination' | 'recovery', ref: string): Promise<void>
  }
  packages: {
    list(projectId: string): Promise<PackageInfo[]>
    create(projectId: string, name: string, color?: string): Promise<PackageInfo>
    update(id: string, patch: { name?: string; color?: string; shortcut?: number | null; sortOrder?: number }): Promise<PackageInfo>
    remove(id: string): Promise<{ removedAssignments: number; cancelledItems: number }>
    chooseTargetDir(id: string, confirmToken?: string): Promise<ChooseDirResult>
    clearTargetDir(id: string): Promise<PackageInfo>
    openTarget(id: string): Promise<void>
  }
  assign: {
    apply(projectId: string, delta: AssignmentDelta): Promise<AssignResult>
    list(projectId: string): Promise<{ assignments: Array<[number, string]>; exported: Array<[number, string]> }>
  }
  exports: {
    preview(projectId: string, opts: ExportPlanOptions): Promise<ExportPlanPreview>
    start(planId: string): Promise<{ jobId: string | null; created: number; skippedActive: number }>
  }
  jobs: {
    list(projectId: string): Promise<JobSummary[]>
    items(jobId: string): Promise<JobItemInfo[]>
    pause(jobId: string): Promise<void>
    resume(jobId: string): Promise<void>
    cancel(jobId: string): Promise<void>
    retry(jobId: string): Promise<number>
  }
  recovery: {
    overview(projectId: string): Promise<RecoveryOverview>
    restore(projectId: string, ids: string[], alternative: boolean): Promise<{ jobId: string | null; created: number } | null>
    release(projectId: string, ids: string[]): Promise<number>
    hold(projectId: string, ids: string[]): Promise<number>
    purge(projectId: string, ids: string[]): Promise<{ purged: number; bytes: number; skipped: number }>
    openFolder(projectId: string): Promise<void>
  }
  duplicates: {
    scan(projectId: string): Promise<{ groups: number } | null>
    groups(projectId: string): Promise<DuplicateGroup[]>
  }
  onEvent(cb: (e: AppEvent) => void): () => void
}

/** Liste aller Methoden je Gruppe – Preload und Main leiten daraus Kanalnamen ab. */
export const API_METHODS = {
  app: ['startup', 'getSettings', 'updateSettings', 'clearThumbCache', 'openLogFolder'],
  projects: ['list', 'create', 'open', 'rename', 'remove', 'update', 'saveUi', 'chooseOutputDir', 'clearOutputDir', 'chooseRecoveryDir', 'resetRecoveryDir', 'tasks', 'cancelTask'],
  sources: ['add', 'confirmAdd', 'rescan', 'remove', 'list'],
  media: ['list', 'rows', 'detail', 'reveal', 'revealPath'],
  packages: ['list', 'create', 'update', 'remove', 'chooseTargetDir', 'clearTargetDir', 'openTarget'],
  assign: ['apply', 'list'],
  exports: ['preview', 'start'],
  jobs: ['list', 'items', 'pause', 'resume', 'cancel', 'retry'],
  recovery: ['overview', 'restore', 'release', 'hold', 'purge', 'openFolder'],
  duplicates: ['scan', 'groups']
} as const

export const EVENT_CHANNEL = 'ppm:event'
export const channel = (group: string, method: string): string => `ppm:${group}.${method}`
