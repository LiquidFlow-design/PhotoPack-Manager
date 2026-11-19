// Updates über GitHub-Releases (electron-updater).
// Nur die Installer-Version lädt Updates selbst und installiert sie beim Beenden. Portable EXE und ZIP
// erhalten einen Hinweis mit Link zur Release-Seite. Laufende Übertragungen werden nie unterbrochen.
import path from 'node:path'
import type { InstallKind, UpdateStatus } from '@shared/types'

/** Ausschnitt von electron-updaters AppUpdater, den wir nutzen (erleichtert Tests). */
export interface UpdaterBackend {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  on(event: string, cb: (...args: never[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export function detectInstallKind(o: {
  packaged: boolean
  platform: string
  portableEnv?: string
  exePath: string
  productName: string
  exists: (p: string) => boolean
}): InstallKind {
  if (!o.packaged) return 'dev'
  if (o.platform !== 'win32') return 'unsupported'
  if (o.portableEnv) return 'portable'
  // Der NSIS-Installer legt das Deinstallationsprogramm neben die EXE
  if (o.exists(path.join(path.dirname(o.exePath), `Uninstall ${o.productName}.exe`))) return 'nsis'
  return 'zip'
}

/** Verständliche Meldung statt Stacktrace (z. B. offline, GitHub nicht erreichbar). */
export function friendlyUpdateError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|net::/i.test(msg))
    return 'GitHub ist nicht erreichbar (keine Internetverbindung?).'
  if (/\b(403|429)\b|rate limit/i.test(msg)) return 'GitHub hat die Anfrage vorübergehend abgelehnt. Bitte später erneut versuchen.'
  if (/latest\.yml|\b404\b|No published versions|Cannot find/i.test(msg)) return 'Für die neueste Version liegen keine Update-Dateien vor.'
  if (/sha512|checksum/i.test(msg)) return 'Das heruntergeladene Update ist beschädigt und wurde verworfen.'
  return msg.split('\n')[0].slice(0, 200)
}

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/

export class Updater {
  private st: UpdateStatus
  private backend: UpdaterBackend | null = null
  private manual = false

  constructor(
    private readonly deps: {
      kind: InstallKind
      currentVersion: string
      emit: (s: UpdateStatus, manual: boolean) => void
      hasActiveWork: () => boolean
      createBackend: () => UpdaterBackend
      now?: () => number
    }
  ) {
    const enabled = deps.kind !== 'dev' && deps.kind !== 'unsupported'
    this.st = {
      state: enabled ? 'idle' : 'disabled',
      kind: deps.kind,
      install: !enabled ? 'unavailable' : deps.kind === 'nsis' ? 'auto' : 'manual',
      currentVersion: deps.currentVersion,
      version: null,
      percent: null,
      checkedAt: null,
      error: null
    }
  }

  status(): UpdateStatus {
    return { ...this.st }
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.st = { ...this.st, ...patch }
    this.deps.emit(this.status(), this.manual)
  }

  private ensureBackend(): UpdaterBackend {
    if (this.backend) return this.backend
    const b = this.deps.createBackend()
    const auto = this.st.install === 'auto'
    b.autoDownload = auto
    b.autoInstallOnAppQuit = auto
    b.allowDowngrade = false
    const ver = (info: unknown): string | null => {
      const v = (info as { version?: unknown } | null)?.version
      return typeof v === 'string' && VERSION_RE.test(v) ? v : null
    }
    b.on('checking-for-update', () => this.set({ state: 'checking', error: null }))
    b.on('update-not-available', () => this.set({ state: 'none', version: null, percent: null, checkedAt: this.now() }))
    b.on('update-available', (info: never) =>
      this.set({ state: auto ? 'downloading' : 'available', version: ver(info), percent: auto ? 0 : null, checkedAt: this.now() })
    )
    b.on('download-progress', (p: never) => {
      const percent = Number((p as { percent?: unknown }).percent)
      this.set({ state: 'downloading', percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null })
    })
    b.on('update-downloaded', (info: never) => this.set({ state: 'ready', version: ver(info) ?? this.st.version, percent: 100 }))
    b.on('error', (e: never) => {
      // Ein bereits geladenes Update bleibt gültig, auch wenn eine spätere Prüfung scheitert
      if (this.st.state === 'ready') return
      this.set({ state: 'error', error: friendlyUpdateError(e), percent: null, checkedAt: this.now() })
    })
    this.backend = b
    return b
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Nach Updates suchen. `manual` = vom Nutzer ausgelöst (Fehler werden dann angezeigt). */
  async check(manual: boolean): Promise<UpdateStatus> {
    if (this.st.state === 'disabled') return this.status()
    // Läuft schon / bereits geladen: nichts erneut anstoßen
    if (this.st.state === 'checking' || this.st.state === 'downloading' || this.st.state === 'ready') return this.status()
    this.manual = manual
    try {
      const b = this.ensureBackend()
      this.set({ state: 'checking', error: null })
      await b.checkForUpdates()
    } catch (e) {
      if ((this.st.state as UpdateStatus['state']) !== 'ready') this.set({ state: 'error', error: friendlyUpdateError(e), percent: null, checkedAt: this.now() })
    }
    return this.status()
  }

  /** Sofort neu starten und installieren – nur Installer-Version, nur ohne laufende Übertragungen. */
  install(): { ok: boolean; message?: string } {
    if (this.st.install !== 'auto') return { ok: false, message: 'Diese Version aktualisiert sich nicht selbst. Bitte die neue Version herunterladen.' }
    if (this.st.state !== 'ready' || !this.backend) return { ok: false, message: 'Es ist noch kein Update bereit.' }
    if (this.deps.hasActiveWork()) return { ok: false, message: 'Es laufen noch Übertragungen. Das Update wird nach dem Beenden installiert.' }
    this.backend.quitAndInstall(false, true)
    return { ok: true }
  }
}
