// Einstiegspunkt des Main-Prozesses.
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeTheme, Notification, screen, session } from 'electron'
import { EVENT_CHANNEL } from '@shared/api'
import type { AppEvent } from '@shared/types'
import { AppService } from './services/app-service'
import { registerIpc, onThemeChange } from './ipc'
import { registerProtocol, registerSchemePrivileges } from './protocol'
import { WorkerFileOps } from './core/worker-pool'
import { inlineFileOps } from './core/fileops'
import { getSettings } from './core/settings'
import { autoUpdater } from 'electron-updater'
import { UPDATE_REPO } from '@shared/api'
import { Updater, detectInstallKind, type UpdaterBackend } from './services/updater'
import { readLaunchFlags, writeLaunchFlags } from './launch-flags'

// Datenordner: Tests → PPM_USER_DATA; portable EXE → „PhotoPack-Daten“ neben der EXE; ZIP-Version → dort,
// wenn der Ordner „PhotoPack-Daten“ neben der EXE existiert; sonst %APPDATA%\PhotoPack Manager.
export const PORTABLE_DIR_NAME = 'PhotoPack-Daten'
let portableDataDir: string | null = null
let portableFallback = false
function selectDataDir(): void {
  if (process.env.PPM_USER_DATA) {
    app.setPath('userData', process.env.PPM_USER_DATA)
    return
  }
  if (!app.isPackaged) return
  const exeDir = path.dirname(app.getPath('exe'))
  const base = process.env.PORTABLE_EXECUTABLE_DIR || (fs.existsSync(path.join(exeDir, PORTABLE_DIR_NAME)) ? exeDir : null)
  if (!base) return
  const dir = path.join(base, PORTABLE_DIR_NAME)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.schreibtest-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe)
    app.setPath('userData', dir)
    portableDataDir = dir
  } catch {
    portableFallback = true // z. B. schreibgeschützter Datenträger → %APPDATA%
  }
}
selectDataDir()

// Grafikbeschleunigung abschaltbar (Einstellungen → System): hilft bei Darstellungsfehlern einzelner
// Grafiktreiber, z. B. doppelt gezeichnetem Mauszeiger. Muss vor „ready“ feststehen.
const launchFlags = readLaunchFlags(app.getPath('userData'))
if (!launchFlags.hardwareAcceleration) app.disableHardwareAcceleration()

registerSchemePrivileges()
// Eindeutige Kennung für Taskleiste/Benachrichtigungen (auch für die portable Version)
if (process.platform === 'win32') app.setAppUserModelId('de.photopack.manager')

let svc: AppService | null = null
let win: BrowserWindow | null = null
let presenter: BrowserWindow | null = null
let presenterMedia: number | null = null
let quitting = false
let updater: Updater | null = null

// Nur eine Instanz: verhindert konkurrierende Schreibzugriffe auf Datenbank und Dateien
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  void app.whenReady().then(start)
}

let progressTimer: NodeJS.Timeout | null = null
function send(e: AppEvent): void {
  if (e.type === 'jobs-changed' && !progressTimer) {
    progressTimer = setTimeout(() => {
      progressTimer = null
      updateTaskbar()
    }, 400)
  }
  if (e.type === 'job-finished') notifyJobFinished(e)
  if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, e)
}

/** Fortschritt in der Windows-Taskleiste (grün, gelb = pausiert, rot = Fehler). */
function updateTaskbar(): void {
  if (!win || win.isDestroyed() || !svc) return
  const p = svc.engine.overallProgress()
  if (p.mode === 'none') win.setProgressBar(-1)
  else win.setProgressBar(Math.max(0.02, p.fraction), { mode: p.mode })
}

/** Windows-Benachrichtigung bei Auftragsende, wenn das Fenster nicht im Vordergrund ist. */
function notifyJobFinished(e: Extract<AppEvent, { type: 'job-finished' }>): void {
  const ok = e.status === 'completed'
  if (e.mode === 'instant' && ok) return // Sofortmodus: nur Fehler melden (sonst eine Meldung je Zuordnung)
  if (!win || win.isDestroyed() || win.isFocused() || !Notification.isSupported()) return
  const n = new Notification({
    title: ok ? 'Auftrag abgeschlossen' : 'Auftrag mit Fehlern beendet',
    body: `${e.label}\n${e.done} erledigt${e.failed ? `, ${e.failed} fehlgeschlagen` : ''}`,
    silent: ok
  })
  n.on('click', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  n.show()
  if (!ok) win.flashFrame(true)
}

function sendPresenter(e: AppEvent): void {
  if (presenter && !presenter.isDestroyed()) presenter.webContents.send(EVENT_CHANNEL, e)
}

const WEB_PREFS = () => ({
  preload: path.join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: false
})

function loadRenderer(w: BrowserWindow, hash = ''): void {
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL + (hash ? '#' + hash : ''))
  else void w.loadFile(path.join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}

function guardNavigation(w: BrowserWindow): void {
  w.webContents.on('will-navigate', (e, url) => {
    if (url !== w.webContents.getURL()) e.preventDefault()
  })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

/** Präsentationsfenster: bevorzugt auf einem zweiten Bildschirm im Vollbild. */
export function openPresenter(): void {
  if (presenter && !presenter.isDestroyed()) {
    presenter.focus()
    return
  }
  const primary = screen.getPrimaryDisplay()
  const other = screen.getAllDisplays().find((d) => d.id !== primary.id)
  const area = (other ?? primary).workArea
  presenter = new BrowserWindow({
    x: area.x + 40,
    y: area.y + 40,
    width: Math.min(1280, area.width - 80),
    height: Math.min(800, area.height - 80),
    title: 'PhotoPack Manager – Präsentation',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    fullscreen: !!other,
    webPreferences: WEB_PREFS()
  })
  guardNavigation(presenter)
  presenter.on('closed', () => {
    presenter = null
    send({ type: 'presenter-closed' })
  })
  loadRenderer(presenter, 'presenter')
}

export function closePresenter(): void {
  if (presenter && !presenter.isDestroyed()) presenter.close()
}

async function start(): Promise<void> {
  const dataDir = app.getPath('userData')
  let fileOps: import('./core/fileops').FileOps = inlineFileOps
  let fileOpsMode: 'worker' | 'inline' = 'inline'
  try {
    const pool = new WorkerFileOps(path.join(__dirname, 'file-worker.js'), 2)
    if (await pool.selfTest()) {
      fileOps = pool
      fileOpsMode = 'worker'
    } else await pool.close()
  } catch {
    fileOps = inlineFileOps
  }
  try {
    svc = new AppService(dataDir, fileOps, send)
    svc.fileOpsMode = fileOpsMode
    svc.portable = { dir: portableDataDir, fallback: portableFallback }
    await svc.init()
  } catch (e) {
    dialog.showErrorBox('PhotoPack Manager', 'Die Datenbank konnte nicht geöffnet werden:\n' + (e as Error).message)
    app.exit(1)
    return
  }

  const theme = getSettings(svc.ctx).theme
  nativeTheme.themeSource = theme
  onThemeChange((t) => {
    nativeTheme.themeSource = t
  })
  nativeTheme.on('updated', () => send({ type: 'theme-changed', dark: nativeTheme.shouldUseDarkColors }))

  // Keine Berechtigungen (Kamera, Mikrofon, Benachrichtigungen …) für den Renderer
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

  registerProtocol(() => svc)
  Menu.setApplicationMenu(null) // keine Menüleiste (Alt-Taste bleibt für Kürzel frei)
  registerIpc(
    () => {
      if (!svc) throw new Error('Dienst nicht bereit')
      return svc
    },
    {
      openPresenter,
      closePresenter,
      presenterShow: (mediaId) => {
        presenterMedia = mediaId
        sendPresenter({ type: 'presenter-show', mediaId })
      },
      presenterNav: (delta) => send({ type: 'presenter-nav', delta }),
      isPresenterOpen: () => !!presenter && !presenter.isDestroyed(),
      presenterCurrent: () => presenterMedia,
      updater: () => updater,
      launchGpu: () => launchFlags.hardwareAcceleration,
      relaunch: () => {
        if (svc?.engine.hasActiveWork()) throw new Error('Es laufen noch Übertragungen. Bitte nach deren Abschluss neu starten.')
        app.relaunch()
        app.quit()
      }
    }
  )
  // Einstellung und Startdatei abgleichen (z. B. nach Wiederherstellung einer Sicherung)
  const hw = getSettings(svc.ctx).hardwareAcceleration
  if (hw !== launchFlags.hardwareAcceleration) {
    try {
      writeLaunchFlags(svc.dataDir, { hardwareAcceleration: hw })
    } catch {
      /* wirkt dann erst nach erneutem Umschalten */
    }
  }
  setupUpdater()
  createWindow()
}

/** Updates über GitHub-Releases; Prüfung einmal pro Start, sofern nicht abgeschaltet. */
function setupUpdater(): void {
  const kind = detectInstallKind({
    packaged: app.isPackaged,
    platform: process.platform,
    portableEnv: process.env.PORTABLE_EXECUTABLE_DIR,
    exePath: app.getPath('exe'),
    productName: app.getName(),
    exists: (p) => fs.existsSync(p)
  })
  updater = new Updater({
    kind,
    currentVersion: app.getVersion(),
    emit: (status, manual) => send({ type: 'update-status', status, manual }),
    hasActiveWork: () => !!svc?.engine.hasActiveWork(),
    createBackend: () => {
      autoUpdater.setFeedURL({ provider: 'github', owner: UPDATE_REPO.owner, repo: UPDATE_REPO.repo })
      autoUpdater.logger = null
      return autoUpdater as unknown as UpdaterBackend
    }
  })
  if (updater.status().state === 'disabled' || !svc || !getSettings(svc.ctx).updateCheck) return
  // Etwas Abstand zum Start, damit Indexierung und Oberfläche Vorrang haben
  setTimeout(() => void updater?.check(false), 8000).unref()
}

interface WinState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

/** Gespeicherte Fensterlage nur übernehmen, wenn sie auf einem vorhandenen Bildschirm liegt. */
function restoreBounds(): WinState {
  const fallback: WinState = { width: 1440, height: 900, maximized: false }
  const s = svc?.db.prepare("SELECT value FROM app_settings WHERE key = 'window'").get() as { value: string } | undefined
  if (!s) return fallback
  try {
    const w = JSON.parse(s.value) as WinState
    if (w.x == null || w.y == null) return { ...fallback, ...w }
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return w.x! < a.x + a.width - 100 && w.x! + w.width > a.x + 100 && w.y! >= a.y - 10 && w.y! < a.y + a.height - 100
    })
    return visible ? w : { ...fallback, maximized: w.maximized }
  } catch {
    return fallback
  }
}

function saveBounds(): void {
  if (!win || win.isDestroyed() || !svc || win.isMinimized()) return
  const b = win.getNormalBounds()
  const v: WinState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }
  svc.db
    .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('window', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(JSON.stringify(v), Date.now())
}

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors
  const ws = restoreBounds()
  win = new BrowserWindow({
    x: ws.x,
    y: ws.y,
    width: ws.width,
    height: ws.height,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'PhotoPack Manager',
    backgroundColor: dark ? '#0c111b' : '#eef2f8',
    autoHideMenuBar: true,
    webPreferences: WEB_PREFS()
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => {
    if (ws.maximized) win?.maximize()
    win?.show()
  })
  let boundsTimer: NodeJS.Timeout | null = null
  const scheduleSave = () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(saveBounds, 500)
  }
  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('maximize', scheduleSave)
  win.on('unmaximize', scheduleSave)
  // Keine Navigation / keine neuen Fenster aus dem Renderer
  guardNavigation(win)
  // Windows-Abmeldung/-Herunterfahren: keine Zeit für asynchrones Beenden – Aufträge sofort pausieren,
  // Datenbank sichern. Unterbrochene Einzelschritte gleicht der Start-Abgleich aus.
  win.on('session-end', () => {
    try {
      saveBounds()
      svc?.db.prepare("UPDATE jobs SET status='paused', interrupted=1, updated_at=? WHERE status IN ('queued','running')").run(Date.now())
      svc?.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* best effort */
    }
  })
  win.on('close', (e) => {
    saveBounds()
    if (quitting || !svc) return
    if (svc.engine.hasActiveWork()) {
      const r = dialog.showMessageBoxSync(win!, {
        type: 'question',
        buttons: ['Pausieren und beenden', 'Abbrechen'],
        defaultId: 1,
        cancelId: 1,
        title: 'Aufträge laufen',
        message: 'Es laufen noch Übertragungen.',
        detail: 'Beim Beenden werden laufende Aufträge sicher pausiert (Zwischendateien werden entfernt). Sie können beim nächsten Start fortgesetzt werden.'
      })
      if (r === 1) {
        e.preventDefault()
        return
      }
    }
  })

  win.on('closed', () => closePresenter())
  loadRenderer(win)
}

app.on('before-quit', (e) => {
  if (quitting || !svc) return
  e.preventDefault()
  quitting = true
  const s = svc
  void s
    .shutdown()
    .catch(() => {})
    .finally(() => {
      svc = null
      app.quit()
    })
})

app.on('window-all-closed', () => {
  app.quit()
})
