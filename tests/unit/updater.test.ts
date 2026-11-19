import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Updater, detectInstallKind, friendlyUpdateError, type UpdaterBackend } from '../../src/main/services/updater'
import type { UpdateStatus } from '../../src/shared/types'

class FakeBackend implements UpdaterBackend {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = true
  handlers = new Map<string, (...a: unknown[]) => void>()
  quitAndInstall = vi.fn()
  checkForUpdates = vi.fn(async () => undefined as unknown)
  on(event: string, cb: (...args: never[]) => void) {
    this.handlers.set(event, cb as (...a: unknown[]) => void)
    return this
  }
  fire(event: string, arg?: unknown) {
    this.handlers.get(event)?.(arg)
  }
}

function make(kind: UpdateStatus['kind'], active = false) {
  const backend = new FakeBackend()
  const events: Array<{ s: UpdateStatus; manual: boolean }> = []
  const u = new Updater({
    kind,
    currentVersion: '1.0.0-beta.2',
    emit: (s, manual) => events.push({ s, manual }),
    hasActiveWork: () => active,
    createBackend: () => backend,
    now: () => 1000
  })
  return { u, backend, events }
}

describe('Installationsart', () => {
  const base = { packaged: true, platform: 'win32', exePath: path.join('C:', 'Apps', 'PPM', 'PhotoPack Manager.exe'), productName: 'PhotoPack Manager' }
  it('erkennt Installer, portable, ZIP, Entwicklung und andere Systeme', () => {
    const uninst = path.join(path.dirname(base.exePath), 'Uninstall PhotoPack Manager.exe')
    expect(detectInstallKind({ ...base, exists: (p) => p === uninst })).toBe('nsis')
    expect(detectInstallKind({ ...base, portableEnv: 'D:\\USB', exists: () => true })).toBe('portable')
    expect(detectInstallKind({ ...base, exists: () => false })).toBe('zip')
    expect(detectInstallKind({ ...base, packaged: false, exists: () => true })).toBe('dev')
    expect(detectInstallKind({ ...base, platform: 'linux', exists: () => true })).toBe('unsupported')
  })
})

describe('Updater', () => {
  it('ist in der Entwicklungsversion deaktiviert und fragt nichts an', async () => {
    const { u, backend } = make('dev')
    expect(u.status()).toMatchObject({ state: 'disabled', install: 'unavailable' })
    await u.check(true)
    expect(backend.checkForUpdates).not.toHaveBeenCalled()
  })

  it('Installer-Version: lädt automatisch, installiert beim Beenden, meldet Fortschritt', async () => {
    const { u, backend, events } = make('nsis')
    await u.check(false)
    expect(backend.autoDownload).toBe(true)
    expect(backend.autoInstallOnAppQuit).toBe(true)
    expect(backend.allowDowngrade).toBe(false)
    backend.fire('update-available', { version: '1.0.0-beta.3' })
    expect(u.status()).toMatchObject({ state: 'downloading', version: '1.0.0-beta.3', percent: 0 })
    backend.fire('download-progress', { percent: 42.5 })
    expect(u.status().percent).toBe(42.5)
    backend.fire('update-downloaded', { version: '1.0.0-beta.3' })
    expect(u.status()).toMatchObject({ state: 'ready', version: '1.0.0-beta.3' })
    expect(events.every((e) => e.manual === false)).toBe(true)
    // erneute Prüfung stößt nichts mehr an, ein späterer Fehler verwirft das fertige Update nicht
    await u.check(true)
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
    backend.fire('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(u.status().state).toBe('ready')
  })

  it('portable/ZIP: nur Hinweis, kein Download und keine Installation', async () => {
    const { u, backend } = make('portable')
    await u.check(true)
    expect(backend.autoDownload).toBe(false)
    expect(backend.autoInstallOnAppQuit).toBe(false)
    backend.fire('update-available', { version: '1.0.0' })
    expect(u.status()).toMatchObject({ state: 'available', install: 'manual', version: '1.0.0' })
    expect(u.install().ok).toBe(false)
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
  })

  it('installiert nie während laufender Übertragungen', async () => {
    const { u, backend } = make('nsis', true)
    await u.check(true)
    backend.fire('update-downloaded', { version: '1.0.0' })
    const r = u.install()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Übertragungen/)
    expect(backend.quitAndInstall).not.toHaveBeenCalled()
  })

  it('installiert auf Wunsch sofort, wenn nichts läuft', async () => {
    const { u, backend } = make('nsis')
    expect(u.install().ok).toBe(false) // noch nichts geladen
    await u.check(true)
    backend.fire('update-downloaded', { version: '1.0.0' })
    expect(u.install()).toEqual({ ok: true })
    expect(backend.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('übernimmt nur gültige Versionsnummern und meldet Fehler verständlich', async () => {
    const { u, backend, events } = make('zip')
    backend.checkForUpdates.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.github.com'))
    await u.check(true)
    expect(u.status()).toMatchObject({ state: 'error', error: 'GitHub ist nicht erreichbar (keine Internetverbindung?).' })
    expect(events.at(-1)?.manual).toBe(true)
    await u.check(false)
    backend.fire('update-available', { version: '<img src=x>' })
    expect(u.status().version).toBeNull()
    backend.fire('update-not-available')
    expect(u.status()).toMatchObject({ state: 'none', checkedAt: 1000 })
  })

  it('Fehlertexte', () => {
    expect(friendlyUpdateError(new Error('HttpError: 404 Not Found latest.yml'))).toMatch(/keine Update-Dateien/)
    expect(friendlyUpdateError(new Error('403 rate limit exceeded'))).toMatch(/später/)
    expect(friendlyUpdateError(new Error('sha512 checksum mismatch'))).toMatch(/beschädigt/)
    expect(friendlyUpdateError('x'.repeat(500)).length).toBeLessThanOrEqual(200)
  })
})

describe('Startoptionen (launch.json)', () => {
  it('Standard: Grafikbeschleunigung an; Schreiben und Lesen; kaputte Datei → Standard', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const { readLaunchFlags, writeLaunchFlags } = await import('../../src/main/launch-flags')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-launch-'))
    try {
      expect(readLaunchFlags(dir)).toEqual({ hardwareAcceleration: true })
      writeLaunchFlags(dir, { hardwareAcceleration: false })
      expect(readLaunchFlags(dir)).toEqual({ hardwareAcceleration: false })
      fs.writeFileSync(path.join(dir, 'launch.json'), '{kaputt')
      expect(readLaunchFlags(dir)).toEqual({ hardwareAcceleration: true })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
