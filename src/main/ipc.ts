// IPC-Handler mit Eingabevalidierung (zod). Jede Methode erhält ein Tupel-Schema.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { API_METHODS, channel, type AddSourceResult, type ChooseDirResult, type Result } from '@shared/api'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import type { AppService } from './services/app-service'
import { createProject, deleteProject, getProject, renameProject, saveUiState, updateProjectSettings } from './core/projects'
import { addSource, checkSourcePath, listSources, removeSource, targetConflictsWithSources } from './core/sources'
import { createPackage, deletePackage, listPackages, updatePackage } from './core/packages'
import { applyAssignments, listAssignments, listExported } from './core/assignments'
import { holdRecovery, purgeRecovery, recoveryOverview, releaseRecovery } from './core/recovery'
import { listDuplicateGroups } from './core/duplicates'
import { isInside } from './core/paths'

const id = z.string().min(1).max(64)
const mediaId = z.number().int().positive()
const pair = z.tuple([mediaId, id])
const workMode = z.enum(['collect', 'instant'])
const operation = z.enum(['copy', 'move'])
const conflict = z.enum(['rename', 'skip'])
const kind = z.enum(['image', 'raw', 'video'])

const filterSchema = z.object({
  kinds: z.array(kind).max(3),
  assignment: z.enum(['all', 'none', 'any', 'partial']),
  packageIds: z.array(id).max(500),
  duplicates: z.enum(['all', 'only', 'none']),
  formats: z.array(z.string().max(10)).max(100),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  exportState: z.enum(['all', 'exported', 'pending']),
  location: z.enum(['all', 'moved', 'missing']),
  search: z.string().max(500)
})
const uiSchema = z.object({
  filters: filterSchema,
  sort: z.object({ key: z.enum(['name', 'date', 'size', 'type', 'folder']), dir: z.enum(['asc', 'desc']) }),
  sourceId: id.nullable(),
  view: z.enum(['grid', 'focus'])
})
const settingsPatch = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    quickAssign: z.enum(['stay', 'advance', 'stage']),
    shortcutsEnabled: z.boolean(),
    recoveryRetentionDays: z.number().int().min(1).max(3650),
    duplicateDetection: z.boolean(),
    reducedMotion: z.enum(['system', 'on', 'off']),
    layout: z.object({
      leftWidth: z.number().min(120).max(600),
      rightWidth: z.number().min(180).max(700),
      leftCollapsed: z.boolean(),
      rightCollapsed: z.boolean()
    }),
    thumbSize: z.number().int().min(100).max(400)
  })
  .partial()
  .strict()

type Handler = (...args: never[]) => unknown
interface Def {
  args: z.ZodType
  fn: Handler
}

// Vorgemerkte Pfade aus Dialogen, die noch eine Bestätigung brauchen (Token -> Pfad).
const pendingPaths = new Map<string, { path: string; projectId: string; purpose: string; expires: number }>()
function remember(projectId: string, p: string, purpose: string): string {
  const token = crypto.randomUUID()
  pendingPaths.set(token, { path: p, projectId, purpose, expires: Date.now() + 10 * 60_000 })
  return token
}
function take(token: string, projectId: string, purpose: string): string | null {
  const v = pendingPaths.get(token)
  pendingPaths.delete(token)
  if (!v || v.projectId !== projectId || v.purpose !== purpose || v.expires < Date.now()) return null
  return v.path
}

async function pickDir(title: string, defaultPath?: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const r = await dialog.showOpenDialog(win, { title, defaultPath, properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] })
  if (r.canceled || !r.filePaths[0]) return null
  return r.filePaths[0]
}

/** Prüft einen Ausgabe-/Zielordner gegen Quellen und geschützte Bereiche. */
async function checkTargetDir(svc: AppService, projectId: string, dir: string): Promise<{ error?: string; confirm?: string }> {
  const p = getProject(svc.ctx, projectId)
  if (isInside(dir, p.recoveryDir) || isInside(dir, svc.dataDir) || isInside(p.recoveryDir, dir))
    return { error: 'Der Ordner überschneidet sich mit dem Wiederherstellungsbereich oder den Programmdaten.' }
  if (path.parse(path.resolve(dir)).root === path.resolve(dir)) return { error: 'Bitte einen Ordner und nicht das gesamte Laufwerk wählen.' }
  const c = await targetConflictsWithSources(svc.ctx, projectId, dir)
  if (c.containsSource) return { error: `Der Ordner enthält die Quelle „${c.containsSource}“ und kann nicht als Ziel dienen.` }
  if (c.insideSource)
    return {
      confirm: `Der Ordner liegt innerhalb der Quelle „${c.insideSource}“. Er wird dauerhaft von der Indexierung ausgeschlossen, damit exportierte Dateien nicht erneut importiert werden. Fortfahren?`
    }
  return {}
}

export function registerIpc(getSvc: () => AppService): void {
  const defs: Record<string, Record<string, Def>> = {
    app: {
      startup: {
        args: z.tuple([]),
        fn: () => {
          const s = getSvc()
          return {
            version: app.getVersion(),
            platform: process.platform,
            userDataDir: s.dataDir,
            dbPath: s.dbPath,
            interruptedJobs: s.interruptedJobs,
            tools: s.media.status()
          }
        }
      },
      getSettings: { args: z.tuple([]), fn: () => getSvc().settings() },
      updateSettings: {
        args: z.tuple([settingsPatch]),
        fn: (patch: Partial<AppSettings>) => {
          const s = getSvc().updateSettings({ ...patch })
          if (patch.theme) applyTheme(s.theme)
          return s
        }
      },
      clearThumbCache: { args: z.tuple([]), fn: () => getSvc().media.clearCache() },
      openLogFolder: { args: z.tuple([]), fn: () => shell.openPath(getSvc().dataDir) }
    },
    projects: {
      list: { args: z.tuple([]), fn: () => getSvc().projects() },
      create: { args: z.tuple([z.string().max(200)]), fn: (name: string) => createProject(getSvc().ctx, name) },
      open: { args: z.tuple([id]), fn: (pid: string) => getSvc().openProject(pid) },
      rename: { args: z.tuple([id, z.string().max(200)]), fn: (pid: string, name: string) => renameProject(getSvc().ctx, pid, name) },
      remove: {
        args: z.tuple([id]),
        fn: (pid: string) => {
          const r = deleteProject(getSvc().ctx, pid)
          if (getSvc().settings().lastProjectId === pid) getSvc().updateSettings({ lastProjectId: null })
          return r
        }
      },
      update: {
        args: z.tuple([id, z.object({ workMode: workMode.optional(), operation: operation.optional(), conflictPolicy: conflict.optional() }).strict()]),
        fn: (pid: string, patch: object) => updateProjectSettings(getSvc().ctx, pid, patch)
      },
      saveUi: { args: z.tuple([id, uiSchema]), fn: (pid: string, ui: z.infer<typeof uiSchema>) => saveUiState(getSvc().ctx, pid, ui) },
      chooseOutputDir: {
        args: z.tuple([id, z.string().optional()]),
        fn: async (pid: string, token?: string): Promise<ChooseDirResult> => {
          const svc = getSvc()
          let dir: string | null
          if (token) {
            dir = take(token, pid, 'output')
            if (!dir) return { status: 'error', message: 'Bestätigung abgelaufen.' }
          } else {
            dir = await pickDir('Globalen Ausgabeordner wählen', getProject(svc.ctx, pid).outputDir ?? undefined)
            if (!dir) return { status: 'cancelled' }
            const chk = await checkTargetDir(svc, pid, dir)
            if (chk.error) return { status: 'error', message: chk.error }
            if (chk.confirm) return { status: 'needs-confirmation', message: chk.confirm, confirmToken: remember(pid, dir, 'output'), path: dir }
          }
          updateProjectSettings(svc.ctx, pid, { outputDir: dir })
          svc.ctx.emit({ type: 'packages-changed', projectId: pid })
          return { status: 'chosen', path: dir }
        }
      },
      clearOutputDir: {
        args: z.tuple([id]),
        fn: (pid: string) => {
          const p = updateProjectSettings(getSvc().ctx, pid, { outputDir: null })
          getSvc().ctx.emit({ type: 'packages-changed', projectId: pid })
          return p
        }
      },
      chooseRecoveryDir: {
        args: z.tuple([id]),
        fn: async (pid: string): Promise<ChooseDirResult> => {
          const svc = getSvc()
          const active = svc.db.prepare("SELECT COUNT(*) AS n FROM recovery_items WHERE project_id = ? AND status IN ('staging','held','released')").get(pid) as { n: number }
          if (active.n > 0)
            return { status: 'error', message: 'Der Wiederherstellungsbereich enthält noch Dateien. Ein neuer Speicherort gilt nur für leere Bereiche (bestehende Dateien werden nicht automatisch verschoben).' }
          const dir = await pickDir('Speicherort für den Wiederherstellungsbereich wählen')
          if (!dir) return { status: 'cancelled' }
          const sources = listSources(svc.ctx, pid)
          if (sources.some((s) => isInside(dir, s.path) || isInside(s.path, dir))) return { status: 'error', message: 'Der Ordner überschneidet sich mit einer Quelle.' }
          const target = path.join(dir, 'PhotoPack-Wiederherstellung', pid)
          updateProjectSettings(svc.ctx, pid, { recoveryDir: target })
          return { status: 'chosen', path: target }
        }
      },
      resetRecoveryDir: {
        args: z.tuple([id]),
        fn: (pid: string) => {
          const svc = getSvc()
          const active = svc.db.prepare("SELECT COUNT(*) AS n FROM recovery_items WHERE project_id = ? AND status IN ('staging','held','released')").get(pid) as { n: number }
          if (active.n > 0) throw new Error('Der Wiederherstellungsbereich enthält noch Dateien.')
          return updateProjectSettings(svc.ctx, pid, { recoveryDir: null })
        }
      },
      tasks: { args: z.tuple([id]), fn: (pid: string) => getSvc().runningTasks(pid) },
      cancelTask: { args: z.tuple([id, z.enum(['scan', 'thumbs', 'duplicates', 'export', 'recovery'])]), fn: (pid: string, k: 'scan') => getSvc().cancelTask(pid, k) }
    },
    sources: {
      add: {
        args: z.tuple([id]),
        fn: async (pid: string): Promise<AddSourceResult> => {
          const svc = getSvc()
          const dir = await pickDir('Quellordner hinzufügen')
          if (!dir) return { status: 'cancelled' }
          const chk = await checkSourcePath(svc.ctx, pid, dir)
          if (!chk.ok) return { status: 'error', error: chk.error ?? 'Ungültiger Ordner', path: dir }
          if (chk.exclusions.length) return { status: 'needs-confirmation', confirmToken: remember(pid, dir, 'source'), path: dir, exclusions: chk.exclusions }
          const source = await addSource(svc.ctx, pid, dir)
          svc.ctx.emit({ type: 'sources-changed', projectId: pid })
          void svc.scanSources(pid, [source.id])
          return { status: 'added', source }
        }
      },
      confirmAdd: {
        args: z.tuple([id, id]),
        fn: async (pid: string, token: string): Promise<AddSourceResult> => {
          const svc = getSvc()
          const dir = take(token, pid, 'source')
          if (!dir) return { status: 'error', error: 'Bestätigung abgelaufen.' }
          const source = await addSource(svc.ctx, pid, dir, true)
          svc.ctx.emit({ type: 'sources-changed', projectId: pid })
          void svc.scanSources(pid, [source.id])
          return { status: 'added', source }
        }
      },
      rescan: { args: z.tuple([id, id.optional()]), fn: (pid: string, sid?: string) => void getSvc().scanSources(pid, sid ? [sid] : undefined) },
      remove: {
        args: z.tuple([id]),
        fn: (sid: string) => {
          const svc = getSvc()
          const pid = (svc.db.prepare('SELECT project_id FROM sources WHERE id = ?').get(sid) as { project_id: string } | undefined)?.project_id
          const r = removeSource(svc.ctx, sid)
          if (pid) {
            svc.ctx.emit({ type: 'sources-changed', projectId: pid })
            svc.ctx.emit({ type: 'media-changed', projectId: pid, full: true })
            svc.ctx.emit({ type: 'assignments-changed', projectId: pid })
          }
          return r
        }
      },
      list: { args: z.tuple([id]), fn: (pid: string) => listSources(getSvc().ctx, pid) }
    },
    media: {
      list: { args: z.tuple([id]), fn: (pid: string) => getSvc().listMedia(pid) },
      rows: { args: z.tuple([id, z.array(mediaId).max(50000)]), fn: (pid: string, ids: number[]) => getSvc().mediaRows(pid, ids) },
      detail: { args: z.tuple([mediaId]), fn: (mid: number) => getSvc().mediaDetail(mid) },
      reveal: {
        args: z.tuple([mediaId]),
        fn: (mid: number) => {
          const m = getSvc().mediaPath(mid)
          if (m && fs.existsSync(m.path)) shell.showItemInFolder(m.path)
        }
      },
      revealPath: {
        args: z.tuple([z.enum(['destination', 'recovery']), id]),
        fn: (k: 'destination' | 'recovery', ref: string) => {
          const db = getSvc().db
          const row =
            k === 'destination'
              ? (db.prepare('SELECT path FROM transfer_destinations WHERE id = ? OR job_item_id = ?').get(ref, ref) as { path: string } | undefined)
              : (db.prepare('SELECT recovery_path AS path FROM recovery_items WHERE id = ?').get(ref) as { path: string } | undefined)
          if (row && fs.existsSync(row.path)) shell.showItemInFolder(row.path)
        }
      }
    },
    packages: {
      list: { args: z.tuple([id]), fn: (pid: string) => listPackages(getSvc().ctx, pid) },
      create: {
        args: z.tuple([id, z.string().max(200), z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()]),
        fn: (pid: string, name: string, color?: string) => createPackage(getSvc().ctx, pid, name, color ? { color } : {})
      },
      update: {
        args: z.tuple([
          id,
          z
            .object({
              name: z.string().max(200).optional(),
              color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
              shortcut: z.number().int().min(1).max(9).nullable().optional(),
              sortOrder: z.number().int().min(0).max(10000).optional()
            })
            .strict()
        ]),
        fn: (pkgId: string, patch: object) => updatePackage(getSvc().ctx, pkgId, patch)
      },
      remove: { args: z.tuple([id]), fn: (pkgId: string) => deletePackage(getSvc().ctx, pkgId) },
      chooseTargetDir: {
        args: z.tuple([id, z.string().optional()]),
        fn: async (pkgId: string, token?: string): Promise<ChooseDirResult> => {
          const svc = getSvc()
          const row = svc.db.prepare('SELECT project_id, name FROM packages WHERE id = ?').get(pkgId) as { project_id: string; name: string } | undefined
          if (!row) return { status: 'error', message: 'Paket nicht gefunden.' }
          let dir: string | null
          if (token) {
            dir = take(token, row.project_id, 'pkg:' + pkgId)
            if (!dir) return { status: 'error', message: 'Bestätigung abgelaufen.' }
          } else {
            dir = await pickDir(`Zielordner für „${row.name}“ wählen`)
            if (!dir) return { status: 'cancelled' }
            const chk = await checkTargetDir(svc, row.project_id, dir)
            if (chk.error) return { status: 'error', message: chk.error }
            if (chk.confirm) return { status: 'needs-confirmation', message: chk.confirm, confirmToken: remember(row.project_id, dir, 'pkg:' + pkgId), path: dir }
          }
          updatePackage(svc.ctx, pkgId, { targetDir: dir })
          return { status: 'chosen', path: dir }
        }
      },
      clearTargetDir: { args: z.tuple([id]), fn: (pkgId: string) => updatePackage(getSvc().ctx, pkgId, { targetDir: null }) },
      openTarget: {
        args: z.tuple([id]),
        fn: async (pkgId: string) => {
          const svc = getSvc()
          const row = svc.db.prepare('SELECT project_id FROM packages WHERE id = ?').get(pkgId) as { project_id: string } | undefined
          if (!row) return
          const p = listPackages(svc.ctx, row.project_id).find((x) => x.id === pkgId)
          if (p?.effectiveTargetDir && fs.existsSync(p.effectiveTargetDir)) await shell.openPath(p.effectiveTargetDir)
        }
      }
    },
    assign: {
      apply: {
        args: z.tuple([id, z.object({ added: z.array(pair).max(100000), removed: z.array(pair).max(100000) })]),
        fn: (pid: string, delta: { added: Array<[number, string]>; removed: Array<[number, string]> }) => applyAssignments(getSvc().ctx, getSvc().engine, pid, delta)
      },
      list: {
        args: z.tuple([id]),
        fn: (pid: string) => ({ assignments: listAssignments(getSvc().ctx, pid), exported: listExported(getSvc().ctx, pid) })
      }
    },
    exports: {
      preview: {
        args: z.tuple([
          id,
          z.object({ packageIds: z.array(id).nullable(), operation, conflictPolicy: conflict, reexportMissing: z.boolean() }).strict()
        ]),
        fn: (pid: string, opts: Parameters<AppService['previewExport']>[1]) => getSvc().previewExport(pid, opts)
      },
      start: { args: z.tuple([id]), fn: (planId: string) => getSvc().startExport(planId) }
    },
    jobs: {
      list: { args: z.tuple([id]), fn: (pid: string) => getSvc().engine.listJobs(pid) },
      items: { args: z.tuple([id]), fn: (jid: string) => getSvc().engine.listItems(jid) },
      pause: { args: z.tuple([id]), fn: (jid: string) => getSvc().engine.pauseJob(jid) },
      resume: { args: z.tuple([id]), fn: (jid: string) => getSvc().engine.resumeJob(jid) },
      cancel: { args: z.tuple([id]), fn: (jid: string) => getSvc().engine.cancelJob(jid) },
      retry: { args: z.tuple([id]), fn: (jid: string) => getSvc().engine.retryJob(jid) }
    },
    recovery: {
      overview: { args: z.tuple([id]), fn: (pid: string) => recoveryOverview(getSvc().ctx, pid) },
      restore: {
        args: z.tuple([id, z.array(id).min(1).max(20000), z.boolean()]),
        fn: async (pid: string, ids: string[], alternative: boolean) => {
          let target: string | null = null
          if (alternative) {
            target = await pickDir('Zielordner für die Wiederherstellung wählen')
            if (!target) return null
            const chk = await checkTargetDir(getSvc(), pid, target)
            if (chk.error) throw new Error(chk.error)
          }
          return getSvc().engine.createRestoreJob(pid, ids, target)
        }
      },
      release: { args: z.tuple([id, z.array(id).max(20000)]), fn: (pid: string, ids: string[]) => releaseRecovery(getSvc().ctx, pid, ids) },
      hold: { args: z.tuple([id, z.array(id).max(20000)]), fn: (pid: string, ids: string[]) => holdRecovery(getSvc().ctx, pid, ids) },
      purge: { args: z.tuple([id, z.array(id).min(1).max(20000)]), fn: (pid: string, ids: string[]) => purgeRecovery(getSvc().ctx, pid, 'manual', ids) },
      openFolder: {
        args: z.tuple([id]),
        fn: async (pid: string) => {
          const dir = getProject(getSvc().ctx, pid).recoveryDir
          fs.mkdirSync(dir, { recursive: true })
          await shell.openPath(dir)
        }
      }
    },
    duplicates: {
      scan: { args: z.tuple([id]), fn: (pid: string) => getSvc().scanDuplicates(pid) },
      groups: { args: z.tuple([id]), fn: (pid: string) => listDuplicateGroups(getSvc().ctx, pid) }
    }
  }

  for (const [group, methods] of Object.entries(API_METHODS)) {
    for (const m of methods) {
      const def = defs[group]?.[m]
      if (!def) throw new Error(`IPC-Handler fehlt: ${group}.${m}`)
      ipcMain.handle(channel(group, m), async (event, ...args): Promise<Result<unknown>> => {
        // Nur Anfragen aus dem eigenen Hauptfenster akzeptieren
        const url = event.senderFrame?.url ?? ''
        if (!url.startsWith('file://') && !url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')) {
          return { ok: false, error: 'Unzulässiger Absender' }
        }
        const parsed = def.args.safeParse(args)
        if (!parsed.success) return { ok: false, error: 'Ungültige Eingabe: ' + parsed.error.issues.map((i) => i.message).join(', ') }
        try {
          const value = await (def.fn as (...a: unknown[]) => unknown)(...(parsed.data as unknown[]))
          return { ok: true, value: value === undefined ? null : value }
        } catch (e) {
          return { ok: false, error: (e as Error).message ?? String(e) }
        }
      })
    }
  }
}

let themeHook: ((t: AppSettings['theme']) => void) | null = null
export function onThemeChange(fn: (t: AppSettings['theme']) => void): void {
  themeHook = fn
}
function applyTheme(t: AppSettings['theme']): void {
  themeHook?.(t ?? DEFAULT_SETTINGS.theme)
}
