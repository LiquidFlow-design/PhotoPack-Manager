// Einstiegspunkt des Main-Prozesses.
import path from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, session } from 'electron'
import { EVENT_CHANNEL } from '@shared/api'
import type { AppEvent } from '@shared/types'
import { AppService } from './services/app-service'
import { registerIpc, onThemeChange } from './ipc'
import { registerProtocol, registerSchemePrivileges } from './protocol'
import { WorkerFileOps } from './core/worker-pool'
import { inlineFileOps } from './core/fileops'
import { getSettings } from './core/settings'

// Testumgebungen können einen eigenen Datenordner setzen (niemals Nutzerdaten in Tests)
if (process.env.PPM_USER_DATA) app.setPath('userData', process.env.PPM_USER_DATA)

registerSchemePrivileges()
// Eindeutige Kennung für Taskleiste/Benachrichtigungen (auch für die portable Version)
if (process.platform === 'win32') app.setAppUserModelId('de.photopack.manager')

let svc: AppService | null = null
let win: BrowserWindow | null = null
let presenter: BrowserWindow | null = null
let presenterMedia: number | null = null
let quitting = false

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

function send(e: AppEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, e)
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
      presenterCurrent: () => presenterMedia
    }
  )
  createWindow()
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
