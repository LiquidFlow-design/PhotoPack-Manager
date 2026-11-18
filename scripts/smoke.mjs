// Startet die gebaute App, legt Projekt an, fügt Testquelle hinzu und erstellt Screenshots.
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
const media = process.argv[2]
const shots = process.argv[3]
const ud = fs.mkdtempSync('/tmp/claude-0/ppm-smoke-')
const app = await electron.launch({ args: ['--no-sandbox', '.'], env: { ...process.env, PPM_USER_DATA: ud } })
const page = await app.firstWindow()
page.on('console', (m) => console.log('[console]', m.type(), m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
await page.waitForTimeout(1500)
await page.screenshot({ path: path.join(shots, '01-welcome.png') })
await page.getByRole('button', { name: 'Neues Projekt' }).first().click()
await page.getByLabel('Projektname').fill('Hochzeit 2026')
await page.getByRole('button', { name: 'Projekt anlegen' }).click()
await page.waitForTimeout(800)
await app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }) }, media)
await page.getByRole('button', { name: 'Quellordner hinzufügen' }).first().click()
await page.waitForTimeout(6000)
await page.screenshot({ path: path.join(shots, '02-grid.png') })
console.log('done', ud)
await app.close()
