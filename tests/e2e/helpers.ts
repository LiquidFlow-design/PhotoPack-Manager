import { _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface AppHandle {
  app: ElectronApplication
  page: Page
  userData: string
  close(): Promise<void>
}

const running = new Set<ElectronApplication>()

/**
 * Aufräumen nach einer Suite: Noch laufende App-Instanzen (z. B. nach einem fehlgeschlagenen Test) zuerst
 * schließen – Windows sperrt sonst die geöffnete Datenbank und das Löschen scheitert mit EPERM.
 */
export async function cleanup(dir: string): Promise<void> {
  await Promise.all([...running].map((a) => a.close().catch(() => {})))
  running.clear()
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (e) {
    console.warn(`Temporärer Testordner konnte nicht gelöscht werden: ${dir} (${(e as Error).message})`)
  }
}

export async function launch(userData?: string): Promise<AppHandle> {
  const dir = userData ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-e2e-'))
  // PPM_E2E_EXE: gepacktes Programm testen (asar, entpackte Binärdateien, Worker)
  const exe = process.env.PPM_E2E_EXE
  const app = await electron.launch({
    ...(exe ? { executablePath: exe, args: ['--no-sandbox'] } : { args: ['--no-sandbox', path.resolve(__dirname, '../..')] }),
    env: { ...process.env, PPM_USER_DATA: dir, ELECTRON_RENDERER_URL: '' } as Record<string, string>
  })
  running.add(app)
  app.on('close', () => running.delete(app))
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return {
    app,
    page,
    userData: dir,
    async close() {
      await app.close().catch(() => {})
    }
  }
}

/** Ersetzt den nativen Ordnerdialog im Main-Prozess (nur Tests). */
export async function stubDirDialog(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, d) => {
    ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [d] })
  }, dir)
}

/**
 * Kachel im virtualisierten Raster finden: Nur sichtbare Zeilen existieren im DOM. Bei kleinen Bildschirmen
 * (z. B. CI-Runner 1024×768) wird das Raster daher schrittweise gescrollt, bis die Kachel gerendert ist.
 */
export async function revealTile(page: Page, name: string): Promise<Locator> {
  const loc = page.locator('.tile', { has: page.locator('.tile-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first()
  if ((await loc.count()) > 0) {
    await loc.scrollIntoViewIfNeeded()
    return loc
  }
  const gallery = page.locator('.gallery')
  await gallery.evaluate((el) => (el.scrollTop = 0))
  for (let i = 0; i < 200; i++) {
    if ((await loc.count()) > 0) break
    const atEnd = await gallery.evaluate((el) => {
      const before = el.scrollTop
      el.scrollTop += Math.max(100, el.clientHeight * 0.7)
      return el.scrollTop === before
    })
    await page.waitForTimeout(40)
    if (atEnd && (await loc.count()) === 0) break
  }
  await loc.scrollIntoViewIfNeeded()
  return loc
}
