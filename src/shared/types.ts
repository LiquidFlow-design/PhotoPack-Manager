// Gemeinsame Typen für Main-Prozess, Preload und Renderer.
// Keine Node-/DOM-Abhängigkeiten in dieser Datei.

export type MediaKind = 'image' | 'raw' | 'video'
export type MediaLocation = 'source' | 'recovery' | 'missing'
export type WorkMode = 'collect' | 'instant'
export type Operation = 'copy' | 'move'
export type ConflictPolicy = 'rename' | 'skip'
export type ThemeSetting = 'system' | 'light' | 'dark'
export type QuickAssignMode = 'stay' | 'advance' | 'stage'
export type ThumbStatus = 'none' | 'ok' | 'error'

export interface ProjectSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  lastOpenedAt: number | null
  mediaCount: number
  packageCount: number
}

export interface ProjectUiState {
  filters: FilterState
  sort: SortState
  sourceId: string | null
  view: 'grid' | 'focus'
  packageView: string | null // geöffnetes Paket (Paketansicht) oder null
}

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  outputDir: string | null
  workMode: WorkMode
  operation: Operation
  conflictPolicy: ConflictPolicy
  recoveryDir: string // effektiver Pfad
  recoveryDirCustom: boolean
  ui: ProjectUiState
}

export interface Source {
  id: string
  projectId: string
  path: string
  addedAt: number
  lastScanAt: number | null
  scanStatus: 'idle' | 'scanning' | 'error' | 'unavailable'
  scanError: string | null
  fileCount: number
  skippedLinks: number
  excludedPaths: string[]
}

/** Kompakte Medienzeile für den Renderer (20k Einträge müssen günstig übertragbar sein). */
export interface MediaRow {
  id: number
  sourceId: string | null
  name: string
  ext: string
  kind: MediaKind
  relDir: string
  size: number
  mtimeMs: number
  capturedAt: number | null
  width: number | null
  height: number | null
  durationMs: number | null
  location: MediaLocation
  thumbStatus: ThumbStatus
  thumbError: string | null
  dupGroup: string | null
  hasHash: boolean
  pairId: number | null // RAW+JPEG-Partner
  sidecars: number // Anzahl zugehöriger XMP-Sidecars
  rating: number // 0–5
  colorLabel: ColorLabel | null
  simGroup: number | null // Gruppe visuell ähnlicher Medien
}

export type ColorLabel = 'red' | 'yellow' | 'green' | 'blue' | 'purple'

export interface MediaDetail extends MediaRow {
  originalPath: string
  currentPath: string
  sha256: string | null
  codec: string | null
  destinations: Array<{ packageId: string | null; packageName: string; path: string; status: string; createdAt: number }>
  recovery: { id: string; status: RecoveryStatus; retainUntil: number | null } | null
}

export interface PackageInfo {
  id: string
  name: string
  color: string
  shortcut: number | null
  targetDir: string | null // individueller Zielordner (null = global/<Name>)
  effectiveTargetDir: string | null
  sortOrder: number
  mediaCount: number
  exportedCount: number
  pendingCount: number // zugeordnet, aber noch nicht exportiert
  activeJobCount: number
}

/** [mediaId, packageId] */
export type AssignmentPair = [number, string]

export interface AssignmentDelta {
  added: AssignmentPair[]
  removed: AssignmentPair[]
}

export interface AssignResult {
  delta: AssignmentDelta
  jobId: string | null // Sofortmodus: erzeugter Auftrag
  cancelledItems: number
  keptExports: number // entfernte Zuordnungen mit bereits exportierten Dateien (bleiben erhalten)
  notices: string[]
}

export interface ExportedPair {
  mediaId: number
  packageId: string
}

// ---------- Filter ----------

export type AssignmentFilter = 'all' | 'none' | 'any' | 'partial'
export type DuplicateFilter = 'all' | 'only' | 'none' | 'similar'
export type ExportFilter = 'all' | 'exported' | 'pending'

export interface FilterState {
  kinds: MediaKind[] // leer = alle
  assignment: AssignmentFilter
  packageIds: string[] // leer = egal
  duplicates: DuplicateFilter
  formats: string[] // Dateiendungen ohne Punkt, leer = alle
  dateFrom: string | null // YYYY-MM-DD
  dateTo: string | null
  exportState: ExportFilter
  location: 'all' | 'moved' | 'missing'
  minRating: number // 0 = egal
  colorLabels: ColorLabel[]
  search: string
}

export type SortKey = 'name' | 'date' | 'size' | 'type' | 'folder' | 'rating' | 'custom'
export interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

// ---------- Export / Jobs ----------

export type JobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed_with_errors'
  | 'cancelled'

export type JobItemKind = 'copy' | 'release_source' | 'restore'

export type JobItemStatus =
  | 'pending'
  | 'copying'
  | 'verifying'
  | 'committing'
  | 'waiting' // release: wartet auf Zielkopien
  | 'recovery_copying'
  | 'recovery_committed'
  | 'source_removing'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'cancelled'

export interface JobSummary {
  id: string
  projectId: string
  kind: 'export' | 'restore'
  mode: WorkMode
  operation: Operation
  conflictPolicy: ConflictPolicy
  status: JobStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  totalItems: number
  doneItems: number
  failedItems: number
  skippedItems: number
  cancelledItems: number
  totalBytes: number
  doneBytes: number
  label: string
  interrupted: boolean
}

export interface JobItemInfo {
  id: string
  kind: JobItemKind
  mediaId: number | null
  fileName: string
  packageName: string | null
  status: JobItemStatus
  finalPath: string | null
  destDir: string | null
  errorCode: string | null
  errorMessage: string | null
  attempts: number
  note: string | null
  updatedAt: number
}

export interface PlanPackageSummary {
  packageId: string
  packageName: string
  targetDir: string | null
  items: number
  bytes: number
  alreadyExported: number
  missingTargets: number // bereits exportiert, Zieldatei fehlt
  nameCollisions: number
  existingConflicts: number
  problems: string[]
}

export interface PlanVolume {
  root: string
  requiredBytes: number
  freeBytes: number | null
  ok: boolean
}

export interface ExportPlanPreview {
  planId: string
  operation: Operation
  conflictPolicy: ConflictPolicy
  packages: PlanPackageSummary[]
  totalItems: number
  totalBytes: number
  mediaCount: number
  moveReleases: number
  missingSources: number
  inActiveJobs: number
  volumes: PlanVolume[]
  warnings: string[]
  blockingErrors: string[]
  createdAt: number
}

export interface ExportPlanOptions {
  packageIds: string[] | null // null = alle
  operation: Operation
  conflictPolicy: ConflictPolicy
  reexportMissing: boolean
}

// ---------- Recovery ----------

export type RecoveryStatus = 'staging' | 'held' | 'released' | 'restored' | 'purged' | 'discarded'

export interface RecoveryItemInfo {
  id: string
  mediaId: number | null
  fileName: string
  originalPath: string
  recoveryPath: string
  size: number
  status: RecoveryStatus
  movedAt: number
  releasedAt: number | null
  retainUntil: number | null
  restoredTo: string | null
  exists: boolean
}

export interface RecoveryOverview {
  dir: string
  extraDirs: string[] // Wiederherstellungsbereiche auf weiteren Laufwerken
  items: RecoveryItemInfo[]
  heldBytes: number
  releasedBytes: number
  freeBytes: number | null
  retentionDays: number
}

// ---------- Duplikate ----------

export interface DuplicateGroup {
  sha256: string
  size: number
  mediaIds: number[]
}

export interface SimilarGroup {
  id: number
  mediaIds: number[]
}

// ---------- Einstellungen ----------

export interface AppSettings {
  theme: ThemeSetting
  quickAssign: QuickAssignMode
  shortcutsEnabled: boolean
  recoveryRetentionDays: number
  recoveryBaseDir: string | null // null = Standard im Benutzerdatenordner
  duplicateDetection: boolean
  reducedMotion: 'system' | 'on' | 'off'
  layout: {
    leftWidth: number
    rightWidth: number
    leftCollapsed: boolean
    rightCollapsed: boolean
  }
  thumbSize: number
  lastProjectId: string | null
  pairRawJpeg: boolean // RAW+JPEG gemeinsam zuordnen
  includeSidecars: boolean // XMP-Sidecars mitkopieren/-verschieben
  instantDelaySec: number // Gnadenfrist im Sofortmodus (0 = aus)
  recoveryPerVolume: boolean // Wiederherstellungsbereich je Laufwerk
  similarityThreshold: number // Hamming-Distanz für „ähnlich“
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  quickAssign: 'stay',
  shortcutsEnabled: true,
  recoveryRetentionDays: 30,
  recoveryBaseDir: null,
  duplicateDetection: false,
  reducedMotion: 'system',
  layout: { leftWidth: 240, rightWidth: 300, leftCollapsed: false, rightCollapsed: false },
  thumbSize: 170,
  lastProjectId: null,
  pairRawJpeg: true,
  includeSidecars: true,
  instantDelaySec: 3,
  recoveryPerVolume: true,
  similarityThreshold: 8
}

// ---------- Hintergrundaufgaben / Events ----------

export interface TaskProgress {
  id: string
  kind: 'scan' | 'thumbs' | 'duplicates' | 'similar' | 'export' | 'recovery' | 'zip'
  label: string
  done: number
  total: number
  running: boolean
  error: string | null
}

export type AppEvent =
  | { type: 'media-changed'; projectId: string; full?: boolean; mediaIds?: number[] }
  | { type: 'packages-changed'; projectId: string }
  | { type: 'assignments-changed'; projectId: string }
  | { type: 'sources-changed'; projectId: string }
  | { type: 'jobs-changed'; projectId: string }
  | { type: 'task-progress'; projectId: string; task: TaskProgress }
  | { type: 'thumb-ready'; projectId: string; mediaId: number; ok: boolean }
  | { type: 'theme-changed'; dark: boolean }
  | { type: 'recovery-changed'; projectId: string }
  | { type: 'notice'; projectId: string | null; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'presenter-show'; mediaId: number | null }
  | { type: 'presenter-nav'; delta: number }
  | { type: 'presenter-closed' }

export interface StartupInfo {
  version: string
  platform: string
  userDataDir: string
  dbPath: string
  interruptedJobs: number
  tools: { exiftool: boolean; ffmpeg: boolean; ffprobe: boolean; sharp: boolean }
  fileOps: 'worker' | 'inline'
}

export interface ProjectBundle {
  project: Project
  sources: Source[]
  packages: PackageInfo[]
  media: MediaRow[]
  assignments: AssignmentPair[]
  exported: AssignmentPair[]
}
