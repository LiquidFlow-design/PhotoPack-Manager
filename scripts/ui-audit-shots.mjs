// Audit-Screenshots: kleine Windows-Fenstergrößen und Kontrastdesign. Aufruf: node scripts/ui-audit-shots.mjs <medien> <ziel>
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const [media, shots] = process.argv.slice(2)
fs.mkdirSync(shots, { recursive: true })
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-ui-'))
const app = await electron.launch({ args: ['--no-sandbox', '.'], env: { ...process.env, PPM_USER_DATA: ud } })
const page = await app.firstWindow()
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h])
await size(1440, 900)
await page.waitForTimeout(1000)
await page.getByRole('button', { name: 'Neues Projekt' }).first().click()
await page.getByLabel('Projektname').fill('Hochzeit 2026')
await page.getByRole('button', { name: 'Projekt anlegen' }).click()
await app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }) }, media)
await page.getByRole('button', { name: 'Quellordner hinzufügen' }).first().click()
for (const n of ['Anna', 'Max', 'Familie']) {
  await page.getByRole('button', { name: 'Neues Paket erstellen' }).click()
  await page.getByLabel(/Name des Pakets/).fill(n)
  await page.getByRole('button', { name: 'Paket erstellen', exact: true }).click()
}
await page.waitForTimeout(4000)
await page.locator('.tile').nth(4).click()
await page.keyboard.press('1')
await page.locator('.tile').nth(5).click({ modifiers: ['Shift'] })
for (const [w, h, n] of [[1280, 720, '1280x720'], [1093, 614, '1093x614'], [800, 600, '800x600']]) {
  await size(w, h)
  await page.waitForTimeout(700)
  await page.screenshot({ path: path.join(shots, `fenster-${n}.png`) })
}
await page.keyboard.press('Enter')
await page.waitForTimeout(800)
await page.screenshot({ path: path.join(shots, 'fokus-800x600.png') })
await page.keyboard.press('Escape')
await page.getByRole('button', { name: /Exportvorschau/ }).first().click().catch(() => {})
await page.waitForTimeout(800)
await page.screenshot({ path: path.join(shots, 'export-800x600.png') })
await page.keyboard.press('Escape')
await size(1280, 720)
await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' })
await page.waitForTimeout(600)
await page.screenshot({ path: path.join(shots, 'kontrast.png') })
await app.close()
fs.rmSync(ud, { recursive: true, force: true })
