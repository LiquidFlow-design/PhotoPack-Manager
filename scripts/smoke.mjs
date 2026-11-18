// Smoke-Test: startet die App (Build oder gepacktes Programm), legt Projekt an, indexiert Testmedien,
// erstellt Screenshots. Aufruf: node scripts/smoke.mjs <medienordner> <screenshotordner> [executable]
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const [media, shots, exe] = process.argv.slice(2)
fs.mkdirSync(shots, { recursive: true })
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-smoke-'))
const opts = exe ? { executablePath: exe, args: ['--no-sandbox'] } : { args: ['--no-sandbox', '.'] }
const app = await electron.launch({ ...opts, env: { ...process.env, PPM_USER_DATA: ud } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'Neues Projekt' }).first().click()
await page.getByLabel('Projektname').fill('Hochzeit 2026')
await page.getByRole('button', { name: 'Projekt anlegen' }).click()
await app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }) }, media)
await page.getByRole('button', { name: 'Quellordner hinzufügen' }).first().click()
await page.waitForTimeout(8000)
const info = await page.evaluate(() => window.ppm.app.startup())
console.log('startup', JSON.stringify(info))
const thumbs = await page.evaluate(async () => {
  const p = (await window.ppm.projects.list())[0]
  const m = await window.ppm.media.list(p.id)
  const c = {}
  for (const x of m) c[x.kind + ':' + x.thumbStatus] = (c[x.kind + ':' + x.thumbStatus] ?? 0) + 1
  return c
})
console.log('thumbs', JSON.stringify(thumbs))
await page.screenshot({ path: path.join(shots, 'grid.png') })
console.log('pageerrors', errors.length, errors.slice(0, 3))
await app.close()
fs.rmSync(ud, { recursive: true, force: true })
