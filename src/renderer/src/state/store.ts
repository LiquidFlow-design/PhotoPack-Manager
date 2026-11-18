import { create } from 'zustand'
import {
  addManyDelta,
  applyDelta as applyIdx,
  buildIndex,
  invertDelta,
  isEmptyDelta,
  toggleDelta,
  type AssignmentIndex
} from '@shared/assignment'
import { DEFAULT_FILTERS, DEFAULT_SORT, filterAndSort } from '@shared/filters'
import type {
  AppEvent,
  AppSettings,
  AssignmentDelta,
  FilterState,
  JobSummary,
  MediaRow,
  PackageInfo,
  Project,
  ProjectSummary,
  SortState,
  Source,
  StartupInfo,
  TaskProgress
} from '@shared/types'
import { api } from '../lib/api'

export type DialogState =
  | { type: 'settings' }
  | { type: 'projects' }
  | { type: 'export'; packageIds?: string[] | null }
  | { type: 'jobs'; jobId?: string }
  | { type: 'recovery' }
  | { type: 'duplicates' }
  | { type: 'sources' }
  | { type: 'package'; packageId: string | null }
  | { type: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void> }
  | { type: 'prompt'; title: string; label: string; initial: string; confirmLabel: string; onSubmit: (v: string) => void | Promise<void> }
  | { type: 'info'; title: string; message: string }

export interface Toast {
  id: number
  level: 'info' | 'warn' | 'error' | 'success'
  text: string
}

interface State {
  ready: boolean
  startup: StartupInfo | null
  settings: AppSettings | null
  projects: ProjectSummary[]
  project: Project | null
  sources: Source[]
  packages: PackageInfo[]
  media: MediaRow[]
  mediaById: Map<number, MediaRow>
  assignments: AssignmentIndex
  exported: AssignmentIndex
  version: number // erhöht bei Änderungen an Medien/Zuordnungen
  thumbVersion: Map<number, number>
  filters: FilterState
  sort: SortState
  sourceId: string | null
  view: 'grid' | 'focus'
  visible: MediaRow[]
  visibleIndex: Map<number, number>
  selection: Set<number>
  anchor: number | null
  active: number | null
  columns: number
  scrollSeq: number // erhöht, wenn das aktive Element sichtbar gescrollt werden soll (Tastatur)
  staged: Set<string>
  undoStack: AssignmentDelta[]
  jobs: JobSummary[]
  tasks: Record<string, TaskProgress>
  toasts: Toast[]
  dialog: DialogState | null
  filterOpen: boolean
  darkSystem: boolean
  busy: boolean
}

interface Actions {
  init(): Promise<void>
  openProject(id: string): Promise<void>
  closeProject(): void
  refreshProjects(): Promise<void>
  reloadMedia(): Promise<void>
  updateRows(ids: number[]): Promise<void>
  refreshPackages(): Promise<void>
  refreshAssignments(): Promise<void>
  refreshSources(): Promise<void>
  refreshJobs(): Promise<void>
  setFilters(f: FilterState): void
  setSort(s: SortState): void
  setSourceFilter(id: string | null): void
  setView(v: 'grid' | 'focus'): void
  setColumns(n: number): void
  select(id: number, mode: 'single' | 'toggle' | 'range'): void
  selectAll(): void
  clearSelection(): void
  navigate(delta: number | 'home' | 'end', extend?: boolean): void
  togglePackage(packageId: string): Promise<void>
  toggleStage(packageId: string): void
  commitStaged(): Promise<void>
  applyDelta(delta: AssignmentDelta, opts?: { recordUndo?: boolean; quiet?: boolean }): Promise<boolean>
  undo(): Promise<void>
  updateProject(patch: Partial<Pick<Project, 'workMode' | 'operation' | 'conflictPolicy'>>): Promise<void>
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  toast(level: Toast['level'], text: string): void
  dismissToast(id: number): void
  openDialog(d: DialogState): void
  closeDialog(): void
  setFilterOpen(v: boolean): void
  handleEvent(e: AppEvent): void
}

let toastSeq = 0
let saveTimer: ReturnType<typeof setTimeout> | null = null
let reloadTimer: ReturnType<typeof setTimeout> | null = null
let rowsTimer: ReturnType<typeof setTimeout> | null = null
let pendingRowIds = new Set<number>()
let jobsTimer: ReturnType<typeof setTimeout> | null = null

export const useStore = create<State & Actions>((set, get) => {
  function recompute(partial: Partial<State> = {}): Partial<State> {
    const s = { ...get(), ...partial }
    const visible = filterAndSort(s.media, s.filters, s.sort, {
      assignments: s.assignments,
      exported: s.exported,
      allPackageIds: s.packages.map((p) => p.id),
      sourceId: s.sourceId
    })
    const visibleIndex = new Map<number, number>()
    visible.forEach((m, i) => visibleIndex.set(m.id, i))
    return { ...partial, visible, visibleIndex, version: s.version + 1 }
  }

  function scheduleUiSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const s = get()
      if (!s.project) return
      void api.projects.saveUi(s.project.id, { filters: s.filters, sort: s.sort, sourceId: s.sourceId, view: s.view }).catch(() => {})
    }, 400)
  }

  function nextAfter(ids: Set<number>): number | null {
    const s = get()
    let maxIdx = -1
    for (const id of ids) maxIdx = Math.max(maxIdx, s.visibleIndex.get(id) ?? -1)
    const next = s.visible[maxIdx + 1]
    return next ? next.id : null
  }

  function advance(): void {
    const s = get()
    const next = nextAfter(s.selection)
    if (next != null) set({ selection: new Set([next]), anchor: next, active: next, scrollSeq: s.scrollSeq + 1 })
  }

  return {
    ready: false,
    startup: null,
    settings: null,
    projects: [],
    project: null,
    sources: [],
    packages: [],
    media: [],
    mediaById: new Map(),
    assignments: new Map(),
    exported: new Map(),
    version: 0,
    thumbVersion: new Map(),
    filters: DEFAULT_FILTERS,
    sort: DEFAULT_SORT,
    sourceId: null,
    view: 'grid',
    visible: [],
    visibleIndex: new Map(),
    selection: new Set(),
    anchor: null,
    active: null,
    columns: 1,
    scrollSeq: 0,
    staged: new Set(),
    undoStack: [],
    jobs: [],
    tasks: {},
    toasts: [],
    dialog: null,
    filterOpen: false,
    darkSystem: window.matchMedia('(prefers-color-scheme: dark)').matches,
    busy: false,

    async init() {
      const [startup, settings, projects] = await Promise.all([api.app.startup(), api.app.getSettings(), api.projects.list()])
      set({ startup, settings, projects })
      const last = settings.lastProjectId && projects.find((p) => p.id === settings.lastProjectId)
      if (last) await get().openProject(last.id)
      else if (projects.length === 0) set({ dialog: null })
      set({ ready: true })
      if (startup.interruptedJobs > 0) {
        get().toast('warn', `${startup.interruptedJobs} unterbrochene(r) Auftrag/Aufträge pausiert. Bitte im Auftragsverlauf prüfen und fortsetzen.`)
      }
    },

    async openProject(id) {
      set({ busy: true })
      try {
        const b = await api.projects.open(id)
        const assignments = buildIndex(b.assignments)
        const exported = buildIndex(b.exported)
        const mediaById = new Map(b.media.map((m) => [m.id, m]))
        set({ undoStack: [], selection: new Set(), anchor: null, active: null, staged: new Set(), tasks: {} })
        set(
          recompute({
            project: b.project,
            sources: b.sources,
            packages: b.packages,
            media: b.media,
            mediaById,
            assignments,
            exported,
            filters: b.project.ui.filters,
            sort: b.project.ui.sort,
            sourceId: b.sources.some((s) => s.id === b.project.ui.sourceId) ? b.project.ui.sourceId : null,
            view: 'grid'
          })
        )
        const first = get().visible[0]
        if (first) set({ active: first.id, anchor: first.id, selection: new Set([first.id]) })
        set({ scrollSeq: get().scrollSeq + 1 })
        void get().refreshJobs()
        void get().refreshProjects()
        const tasks = await api.projects.tasks(id)
        set({ tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) })
      } catch (e) {
        get().toast('error', 'Projekt konnte nicht geöffnet werden: ' + (e as Error).message)
      } finally {
        set({ busy: false })
      }
    },

    closeProject() {
      set({ project: null, media: [], visible: [], packages: [], sources: [], selection: new Set(), jobs: [] })
    },

    async refreshProjects() {
      set({ projects: await api.projects.list() })
    },

    async reloadMedia() {
      const p = get().project
      if (!p) return
      const media = await api.media.list(p.id)
      const mediaById = new Map(media.map((m) => [m.id, m]))
      const sel = new Set([...get().selection].filter((id) => mediaById.has(id)))
      set(recompute({ media, mediaById, selection: sel }))
    },

    async updateRows(ids) {
      const p = get().project
      if (!p || !ids.length) return
      const rows = await api.media.rows(p.id, ids)
      const mediaById = new Map(get().mediaById)
      const thumbVersion = new Map(get().thumbVersion)
      for (const r of rows) {
        mediaById.set(r.id, r)
        thumbVersion.set(r.id, (thumbVersion.get(r.id) ?? 0) + 1)
      }
      const media = get().media.map((m) => mediaById.get(m.id) ?? m)
      set(recompute({ media, mediaById, thumbVersion }))
    },

    async refreshPackages() {
      const p = get().project
      if (!p) return
      const packages = await api.packages.list(p.id)
      const ids = new Set(packages.map((x) => x.id))
      const filters = get().filters
      const cleaned = filters.packageIds.some((x) => !ids.has(x)) ? { ...filters, packageIds: filters.packageIds.filter((x) => ids.has(x)) } : filters
      set(recompute({ packages, filters: cleaned }))
    },

    async refreshAssignments() {
      const p = get().project
      if (!p) return
      const r = await api.assign.list(p.id)
      set(recompute({ assignments: buildIndex(r.assignments), exported: buildIndex(r.exported) }))
    },

    async refreshSources() {
      const p = get().project
      if (!p) return
      set({ sources: await api.sources.list(p.id) })
    },

    async refreshJobs() {
      const p = get().project
      if (!p) return
      set({ jobs: await api.jobs.list(p.id) })
    },

    setFilters(f) {
      set(recompute({ filters: f }))
      scheduleUiSave()
    },
    setSort(s) {
      set(recompute({ sort: s }))
      scheduleUiSave()
    },
    setSourceFilter(id) {
      set(recompute({ sourceId: id }))
      scheduleUiSave()
    },
    setView(v) {
      const s = get()
      if (v === 'focus' && s.active == null && s.visible[0]) set({ active: s.visible[0].id, selection: new Set([s.visible[0].id]) })
      set({ view: v, scrollSeq: get().scrollSeq + 1 })
    },
    setColumns(n) {
      if (n !== get().columns) set({ columns: n })
    },

    select(id, mode) {
      const s = get()
      if (mode === 'toggle') {
        const sel = new Set(s.selection)
        if (sel.has(id)) sel.delete(id)
        else sel.add(id)
        set({ selection: sel, anchor: id, active: id })
      } else if (mode === 'range' && s.anchor != null) {
        const a = s.visibleIndex.get(s.anchor)
        const b = s.visibleIndex.get(id)
        if (a == null || b == null) {
          set({ selection: new Set([id]), anchor: id, active: id })
          return
        }
        const sel = new Set<number>()
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.add(s.visible[i].id)
        set({ selection: sel, active: id })
      } else {
        set({ selection: new Set([id]), anchor: id, active: id })
      }
    },

    selectAll() {
      const s = get()
      set({ selection: new Set(s.visible.map((m) => m.id)) })
    },

    clearSelection() {
      set({ selection: new Set(), staged: new Set() })
    },

    navigate(delta, extend = false) {
      const s = get()
      if (!s.visible.length) return
      const cur = s.active != null ? (s.visibleIndex.get(s.active) ?? -1) : -1
      let idx: number
      if (delta === 'home') idx = 0
      else if (delta === 'end') idx = s.visible.length - 1
      else idx = Math.max(0, Math.min(s.visible.length - 1, (cur < 0 ? 0 : cur) + delta))
      const id = s.visible[idx].id
      if (extend) get().select(id, 'range')
      else set({ selection: new Set([id]), anchor: id, active: id })
      set({ scrollSeq: get().scrollSeq + 1 })
    },

    async togglePackage(packageId) {
      const s = get()
      if (!s.selection.size) {
        get().toast('info', 'Bitte zuerst mindestens ein Medium auswählen.')
        return
      }
      const ids = [...s.selection]
      const delta = toggleDelta(s.assignments, ids, packageId)
      const ok = await get().applyDelta(delta, { recordUndo: true })
      if (ok && delta.added.length && s.settings?.quickAssign === 'advance' && s.selection.size === 1) advance()
    },

    toggleStage(packageId) {
      const st = new Set(get().staged)
      if (st.has(packageId)) st.delete(packageId)
      else st.add(packageId)
      set({ staged: st })
    },

    async commitStaged() {
      const s = get()
      if (!s.staged.size || !s.selection.size) {
        set({ staged: new Set() })
        if (s.selection.size === 1) advance()
        return
      }
      const delta = addManyDelta(s.assignments, [...s.selection], [...s.staged])
      set({ staged: new Set() })
      const ok = isEmptyDelta(delta) ? true : await get().applyDelta(delta, { recordUndo: true })
      if (ok && s.selection.size === 1) advance()
    },

    async applyDelta(delta, opts = {}) {
      const s = get()
      if (!s.project || isEmptyDelta(delta)) return true
      // Optimistisch anwenden
      const idx = new Map([...s.assignments].map(([k, v]) => [k, new Set(v)]))
      applyIdx(idx, delta)
      set(recompute({ assignments: idx }))
      try {
        const r = await api.assign.apply(s.project.id, delta)
        if (opts.recordUndo && !isEmptyDelta(r.delta)) set({ undoStack: [...get().undoStack.slice(-99), r.delta] })
        for (const n of r.notices) get().toast(n.startsWith('Sofortauftrag nicht') ? 'warn' : 'info', n)
        if (r.jobId && !opts.quiet) get().toast('info', 'Sofortauftrag angelegt – läuft im Hintergrund.')
        void get().refreshPackages()
        return true
      } catch (e) {
        get().toast('error', 'Zuordnung fehlgeschlagen: ' + (e as Error).message)
        await get().refreshAssignments()
        return false
      }
    },

    async undo() {
      const stack = get().undoStack
      const last = stack[stack.length - 1]
      if (!last) {
        get().toast('info', 'Nichts rückgängig zu machen.')
        return
      }
      set({ undoStack: stack.slice(0, -1) })
      const ok = await get().applyDelta(invertDelta(last), { quiet: true })
      if (ok) {
        const n = last.added.length + last.removed.length
        get().toast('info', `Zuordnungsänderung rückgängig gemacht (${n}). Bereits übertragene Dateien bleiben unverändert.`)
      }
    },

    async updateProject(patch) {
      const p = get().project
      if (!p) return
      const prev = p
      try {
        const project = await api.projects.update(p.id, patch)
        set({ project: { ...project, ui: get().project!.ui } })
        if (patch.workMode === 'instant' && prev.workMode === 'collect') {
          const pending = get().packages.reduce((a, x) => a + x.pendingCount, 0)
          if (pending) get().toast('info', `Sofortmodus aktiv. ${pending} vorgemerkte Zuordnung(en) bleiben im Sammelexport und werden nicht automatisch übertragen.`)
          else get().toast('info', 'Sofortmodus aktiv: neue Zuordnungen werden sofort übertragen.')
        }
        if (patch.operation === 'move') get().toast('info', 'Verschieben: Quellen werden erst nach verifizierten Zielkopien in den Wiederherstellungsbereich verschoben.')
      } catch (e) {
        get().toast('error', (e as Error).message)
      }
    },

    async updateSettings(patch) {
      const settings = await api.app.updateSettings(patch)
      set({ settings })
    },

    toast(level, text) {
      const id = ++toastSeq
      set({ toasts: [...get().toasts.slice(-4), { id, level, text }] })
      setTimeout(() => get().dismissToast(id), level === 'error' ? 9000 : level === 'warn' ? 7000 : 4000)
    },
    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) })
    },
    openDialog(d) {
      set({ dialog: d, filterOpen: false })
    },
    closeDialog() {
      set({ dialog: null })
    },
    setFilterOpen(v) {
      set({ filterOpen: v })
    },

    handleEvent(e) {
      const s = get()
      if (e.type === 'theme-changed') {
        set({ darkSystem: e.dark })
        return
      }
      if (e.type === 'notice') {
        if (!e.projectId || e.projectId === s.project?.id) get().toast(e.level, e.message)
        return
      }
      if (!s.project || e.projectId !== s.project.id) return
      switch (e.type) {
        case 'media-changed':
          if (e.full) {
            if (reloadTimer) clearTimeout(reloadTimer)
            reloadTimer = setTimeout(() => void get().reloadMedia(), 300)
          } else if (e.mediaIds?.length) {
            for (const id of e.mediaIds) pendingRowIds.add(id)
            if (!rowsTimer)
              rowsTimer = setTimeout(() => {
                rowsTimer = null
                const ids = [...pendingRowIds]
                pendingRowIds = new Set()
                void get().updateRows(ids)
              }, 200)
          }
          break
        case 'packages-changed':
          void get().refreshPackages()
          break
        case 'assignments-changed':
          void get().refreshAssignments()
          break
        case 'sources-changed':
          void get().refreshSources()
          break
        case 'jobs-changed':
          if (!jobsTimer)
            jobsTimer = setTimeout(() => {
              jobsTimer = null
              void get().refreshJobs()
              void get().refreshAssignments()
              void get().refreshPackages()
            }, 250)
          break
        case 'task-progress':
          set({ tasks: { ...get().tasks, [e.task.id]: e.task } })
          break
        case 'recovery-changed':
          break
      }
    }
  }
})

export function isDark(settings: AppSettings | null, darkSystem: boolean): boolean {
  const t = settings?.theme ?? 'system'
  return t === 'dark' || (t === 'system' && darkSystem)
}
