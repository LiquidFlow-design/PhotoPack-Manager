// Barrierefreiheit: automatischer axe-Scan der Hauptansichten und Dialoge (hell und dunkel).
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch, stubDirDialog } from './helpers'

test('axe: keine schwerwiegenden Verstöße', async () => {
  test.setTimeout(180_000)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-a11y-'))
  const media = path.join(root, 'quelle')
  execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/gen-test-media.mjs'), media, '6'], { stdio: 'ignore' })
  const h = await launch(path.join(root, 'ud'))
  const { page, app } = h
  const report: Record<string, string[]> = {}
  const scan = async (name: string) => {
    await page.waitForTimeout(300)
    const r = await new AxeBuilder({ page }).setLegacyMode(true).disableRules(['region']).analyze()
    const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    report[name] = bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.length}× – ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)
  }
  try {
    await scan('Willkommen')
    await page.getByRole('button', { name: 'Neues Projekt' }).first().click()
    await scan('Dialog Neues Projekt')
    await page.getByLabel('Projektname').fill('A11y')
    await page.getByRole('button', { name: 'Projekt anlegen' }).click()
    await stubDirDialog(app, media)
    await page.getByRole('button', { name: 'Quellordner hinzufügen' }).first().click()
    await expect(page.getByText(/von \d+ Medien/)).toBeVisible()
    await page.getByRole('button', { name: 'Neues Paket erstellen' }).click()
    await page.getByLabel(/Name des Pakets/).fill('Anna')
    await page.getByRole('button', { name: 'Paket erstellen', exact: true }).click()
    await page.locator('.tile').nth(2).click()
    await page.keyboard.press('1')
    for (const theme of ['hell', 'dunkel']) {
      if (theme === 'dunkel') {
        await page.getByRole('button', { name: /^Farbschema/ }).click()
        await page.getByRole('button', { name: /^Farbschema/ }).click()
      }
      await scan(`Raster (${theme})`)
      await page.locator('#filter-button').click()
      await scan(`Filter (${theme})`)
      await page.keyboard.press('Escape')
      await page.keyboard.press('Enter')
      await scan(`Fokusansicht (${theme})`)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Paket Anna ansehen' }).click()
      await scan(`Paketansicht (${theme})`)
      await page.getByRole('button', { name: 'Zurück zur Medienübersicht' }).click()
      for (const [btn, dlg] of [
        [/Exportvorschau öffnen/, 'Exportvorschau'],
        [/^Einstellungen$/, 'Einstellungen'],
        [/^Wiederherstellung$/, 'Wiederherstellungsbereich'],
        [/^Auftragsverlauf$/, 'Auftragsverlauf'],
        [/^Duplikate/, 'Duplikate'],
        [/^Paket Anna bearbeiten$/, 'Paket „Anna“']
      ] as const) {
        await page.getByRole('button', { name: btn }).first().click()
        await expect(page.getByRole('dialog', { name: dlg })).toBeVisible()
        await scan(`${dlg} (${theme})`)
        await page.keyboard.press('Escape')
      }
    }
  } finally {
    fs.mkdirSync(path.resolve(__dirname, '../../.tmp-tests'), { recursive: true })
    fs.writeFileSync(path.resolve(__dirname, '../../.tmp-tests/a11y.json'), JSON.stringify(report, null, 2))
    await h.close()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
  const all = Object.entries(report).flatMap(([k, v]) => v.map((x) => `${k}: ${x}`))
  expect(all, all.join('\n')).toEqual([])
})
