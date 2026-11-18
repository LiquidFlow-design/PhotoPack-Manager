import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface AppHandle {
  app: ElectronApplication
  page: Page
  userData: string
  close(): Promise<void>
}

export async function launch(userData?: string): Promise<AppHandle> {
  const dir = userData ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-e2e-'))
  const app = await electron.launch({
    args: ['--no-sandbox', path.resolve(__dirname, '../..')],
    env: { ...process.env, PPM_USER_DATA: dir, ELECTRON_RENDERER_URL: '' } as Record<string, string>
  })
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
