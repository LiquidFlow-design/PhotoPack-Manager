// Typisierte Schnittstelle zwischen Renderer und Main-Prozess (über contextBridge).
// Der Renderer übergibt niemals frei gewählte Dateipfade: Ordner werden über native Dialoge im Main-Prozess gewählt.
import type {
  AppEvent,
  AppSettings,
  AssignmentDelta,
  AssignResult,
  CloudRootInfo,
  ColorLabel,
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
  SimilarGroup,
  Source,
  StartupInfo,
  TaskProgress,
  UpdateStatus,
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
    openPresenter(): Promise<void>
    closePresenter(): Promise<void>
    presenterShow(mediaId: number | null): Promise<void>
    presenterNav(delta: number): Promise<void>
    presenterOpen(): Promise<boolean>
    presenterCurrent(): Promise<number | null>
    updateStatus(): Promise<UpdateStatus | null>
    checkForUpdates(): Promise<UpdateStatus>
    installUpdate(): Promise<{ ok: boolean; message?: string }>
    openReleasePage(): Promise<void>
    relaunch(): Promise<void>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    create(name: string): Promise<Project>
    open(id: string): Promise<ProjectBundle>
    rename(id: string, name: string): Promise<Project>
    remove(id: string): Promise<{ recoveryDirKept: string | null; recoveryFiles: number }>
    update(id: string, patch: { workMode?: WorkMode; operation?: Operation; conflictPolicy?: ConflictPolicy; numberPrefix?: boolean }): Promise<Project>
    saveUi(id: string, ui: ProjectUiState): Promise<void>
    chooseOutputDir(id: string, confirmToken?: string, cloudRootId?: string): Promise<ChooseDirResult>
    clearOutputDir(id: string): Promise<Project>
    chooseRecoveryDir(id: string): Promise<ChooseDirResult>
    resetRecoveryDir(id: string): Promise<Project>
    tasks(id: string): Promise<TaskProgress[]>
    cancelTask(id: string, kind: TaskProgress['kind']): Promise<void>
    exportBackup(id: string): Promise<{ file: string; media: number } | null>
    importBackup(): Promise<{ projectId: string; name: string; media: number } | null>
  }
  sources: {
    add(projectId: string, cloudRootId?: string): Promise<AddSourceResult>
    confirmAdd(projectId: string, token: string): Promise<AddSourceResult>
    rescan(projectId: string, sourceId?: string): Promise<void>
    remove(sourceId: string): Promise<{ removedMedia: number; keptMoved: number }>
    list(projectId: string): Promise<Source[]>
    cloudRoots(): Promise<CloudRootInfo[]>
  }
  media: {
    list(projectId: string): Promise<MediaRow[]>
    rows(projectId: string, ids: number[]): Promise<MediaRow[]>
    detail(mediaId: number): Promise<MediaDetail | null>
    reveal(mediaId: number): Promise<void>
    revealPath(kind: 'destination' | 'recovery', ref: string): Promise<void>
    setRating(projectId: string, ids: number[], rating: number): Promise<number[]>
    setColor(projectId: string, ids: number[], color: ColorLabel | null): Promise<number[]>
  }
  packages: {
    list(projectId: string): Promise<PackageInfo[]>
    create(projectId: string, name: string, color?: string): Promise<PackageInfo>
    update(id: string, patch: { name?: string; color?: string; shortcut?: number | null; sortOrder?: number }): Promise<PackageInfo>
    remove(id: string): Promise<{ removedAssignments: number; cancelledItems: number }>
    chooseTargetDir(id: string, confirmToken?: string, cloudRootId?: string): Promise<ChooseDirResult>
    clearTargetDir(id: string): Promise<PackageInfo>
    openTarget(id: string): Promise<void>
    order(id: string): Promise<number[]>
    reorderMedia(id: string, orderedMediaIds: number[]): Promise<number[]>
    reorder(projectId: string, orderedPackageIds: string[]): Promise<void>
    exportZip(id: string): Promise<{ file: string; entries: number; skipped: Array<{ name: string; reason: string }> } | null>
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
    releaseAll(projectId: string): Promise<{ count: number; bytes: number }>
  }
  duplicates: {
    scan(projectId: string): Promise<{ groups: number } | null>
    groups(projectId: string): Promise<DuplicateGroup[]>
    scanSimilar(projectId: string): Promise<{ groups: number } | null>
    similarGroups(projectId: string): Promise<SimilarGroup[]>
  }
  onEvent(cb: (e: AppEvent) => void): () => void
  /** Ordner aus dem Explorer als Quellen hinzufügen (Pfade ermittelt die Preload-Schicht). */
  dropSources(projectId: string, files: File[]): Promise<AddSourceResult[]>
}

/** Liste aller Methoden je Gruppe – Preload und Main leiten daraus Kanalnamen ab. */
export const API_METHODS = {
  app: ['startup', 'getSettings', 'updateSettings', 'clearThumbCache', 'openLogFolder', 'openPresenter', 'closePresenter', 'presenterShow', 'presenterNav', 'presenterOpen', 'presenterCurrent', 'updateStatus', 'checkForUpdates', 'installUpdate', 'openReleasePage', 'relaunch'],
  projects: [
    'list',
    'create',
    'open',
    'rename',
    'remove',
    'update',
    'saveUi',
    'chooseOutputDir',
    'clearOutputDir',
    'chooseRecoveryDir',
    'resetRecoveryDir',
    'tasks',
    'cancelTask',
    'exportBackup',
    'importBackup'
  ],
  sources: ['add', 'confirmAdd', 'rescan', 'remove', 'list', 'cloudRoots'],
  media: ['list', 'rows', 'detail', 'reveal', 'revealPath', 'setRating', 'setColor'],
  packages: ['list', 'create', 'update', 'remove', 'chooseTargetDir', 'clearTargetDir', 'openTarget', 'order', 'reorderMedia', 'reorder', 'exportZip'],
  assign: ['apply', 'list'],
  exports: ['preview', 'start'],
  jobs: ['list', 'items', 'pause', 'resume', 'cancel', 'retry'],
  recovery: ['overview', 'restore', 'release', 'hold', 'purge', 'openFolder', 'releaseAll'],
  duplicates: ['scan', 'groups', 'scanSimilar', 'similarGroups']
} as const

export const EVENT_CHANNEL = 'ppm:event'

/** GitHub-Repository für Updates und Release-Seiten */
export const UPDATE_REPO = { owner: 'LiquidFlow-design', repo: 'PhotoPack-Manager' } as const
export const releasePageUrl = (version?: string | null): string =>
  `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases` +
  (version && /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version) ? `/tag/v${version}` : '')
export const DROP_CHANNEL = 'ppm:sources.addDropped'
export const channel = (group: string, method: string): string => `ppm:${group}.${method}`
