import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch, stubDirDialog, type AppHandle } from './helpers'

// Nur generierte Testdaten in temporären Ordnern
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-e2e-data-'))
const media = path.join(root, 'quelle')
const out = path.join(root, 'export')
const userData = path.join(root, 'userdata')

test.beforeAll(() => {
  execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/gen-test-media.mjs'), media, '12', '--videos'], { stdio: 'ignore' })
  fs.mkdirSync(out, { recursive: true })
})
test.afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let h: AppHandle

async function tile(name: string) {
  return h.page.locator('.tile', { has: h.page.locator('.tile-name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }) }).first()
}

test.describe.serial('PhotoPack Manager – Kern-Workflows', () => {
  test('Projekt anlegen, Quelle hinzufügen, Raster', async () => {
    h = await launch(userData)
    const { page, app } = h
    await page.getByRole('button', { name: 'Neues Projekt' }).first().click()
    await page.getByLabel('Projektname').fill('E2E Projekt')
    await page.getByRole('button', { name: 'Projekt anlegen' }).click()
    await stubDirDialog(app, media)
    await page.getByRole('button', { name: 'Quellordner hinzufügen' }).first().click()
    await expect(page.getByText(/von \d+ Medien/)).toContainText('von 25 Medien')
    await expect(page.locator('.tile').first()).toBeVisible()
  })

  test('Pakete anlegen und Ausgabeordner setzen', async () => {
    const { page, app } = h
    for (const name of ['Anna', 'Max', 'Familie']) {
      await page.getByRole('button', { name: 'Neues Paket erstellen' }).click()
      await page.getByLabel(/Name des Pakets/).fill(name)
      await page.getByRole('button', { name: 'Paket erstellen', exact: true }).click()
      await expect(page.locator('.pkg-name', { hasText: name })).toBeVisible()
    }
    await stubDirDialog(app, out)
    await page.getByRole('button', { name: 'Ausgabeordner wählen' }).click()
    await expect(page.getByText(out)).toBeVisible()
  })

  test('Einzelauswahl + Taste 1, Tri-State bei Mehrfachauswahl, Strg+Z', async () => {
    const { page } = h
    await (await tile('IMG_0002.jpg')).click()
    await page.keyboard.press('1')
    const anna = page.getByRole('button', { name: /^Anna, Taste 1/ })
    await expect(anna).toHaveAttribute('aria-pressed', 'true')
    // Mehrfachauswahl mit Strg+Klick -> teilweise
    await (await tile('IMG_0003.jpg')).click({ modifiers: ['Control'] })
    await expect(anna).toHaveAttribute('aria-pressed', 'mixed')
    await expect(anna).toContainText('1 von 2 zugeordnet')
    // Klick auf teilweise -> ergänzen
    await anna.click()
    await expect(anna).toHaveAttribute('aria-pressed', 'true')
    // erneut -> für alle entfernen
    await anna.click()
    await expect(anna).toHaveAttribute('aria-pressed', 'false')
    // Rückgängig -> wieder zugeordnet
    await page.keyboard.press('Control+z')
    await expect(anna).toHaveAttribute('aria-pressed', 'true')
    // Shift+Klick Bereich
    await (await tile('IMG_0002.jpg')).click()
    await (await tile('IMG_0005.jpg')).click({ modifiers: ['Shift'] })
    await expect(page.getByText(/· 4 ausgewählt/)).toBeVisible()
    await expect(anna).toHaveAttribute('aria-pressed', 'mixed')
    await page.keyboard.press('1')
    await expect(anna).toHaveAttribute('aria-pressed', 'true')
    await expect(anna).toContainText('alle 4 zugeordnet')
  })

  test('Paketkürzel werden während Texteingabe nicht ausgelöst', async () => {
    const { page } = h
    await (await tile('IMG_0006.jpg')).click()
    const max = page.getByRole('button', { name: /^Max, Taste 2/ })
    await expect(max).toHaveAttribute('aria-pressed', 'false')
    await page.locator('#media-search').fill('')
    await page.locator('#media-search').type('2')
    await expect(max).toHaveAttribute('aria-pressed', 'false')
    await page.locator('#media-search').fill('')
    await page.keyboard.press('Escape')
  })

  test('Schnellzuordnung: automatisch weiter und „mehrere wählen, dann Enter“', async () => {
    const { page } = h
    const qa = page.locator('#qa-mode')
    await qa.selectOption('advance')
    await (await tile('IMG_0008.jpg')).click()
    await page.keyboard.press('2')
    await expect(page.locator('.tile.active .tile-name')).toHaveText('IMG_0009.jpg')
    await (await tile('IMG_0008.jpg')).click()
    await expect(page.getByRole('button', { name: /^Max, Taste 2/ })).toHaveAttribute('aria-pressed', 'true')
    await qa.selectOption('stage')
    await (await tile('IMG_0010.jpg')).click()
    await page.keyboard.press('1')
    await page.keyboard.press('3')
    await expect(page.locator('.pkg.staged')).toHaveCount(2)
    await page.keyboard.press('Enter')
    await expect(page.locator('.tile.active .tile-name')).toHaveText('IMG_0011.jpg')
    await (await tile('IMG_0010.jpg')).click()
    await expect(page.getByRole('button', { name: /^Anna, Taste 1/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: /^Familie, Taste 3/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: /^Max, Taste 2/ })).toHaveAttribute('aria-pressed', 'false')
    // Rückgängig nimmt beide gebündelten Zuordnungen zurück
    await page.keyboard.press('Control+z')
    await expect(page.getByRole('button', { name: /^Anna, Taste 1/ })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('button', { name: /^Familie, Taste 3/ })).toHaveAttribute('aria-pressed', 'false')
    // Max-Zuordnung von IMG_0008 entfernen, damit spätere Zählungen stimmen
    await (await tile('IMG_0008.jpg')).click()
    await qa.selectOption('stay')
    await page.keyboard.press('2')
    await expect(page.getByRole('button', { name: /^Max, Taste 2/ })).toHaveAttribute('aria-pressed', 'false')
  })

  test('Filter-Popover: Kombinationen, Chips, Clear-all, Tastatur', async () => {
    const { page } = h
    const btn = page.locator('#filter-button')
    await btn.click()
    const pop = page.getByRole('dialog', { name: 'Medien filtern' })
    await expect(pop).toBeVisible()
    await pop.getByRole('button', { name: 'Video' }).click()
    await expect(page.getByText(/^3 von 25 Medien/)).toBeVisible()
    await expect(btn.locator('.badge-count')).toHaveText('1')
    await pop.getByRole('radio', { name: 'Mit Paket' }).click()
    await expect(page.getByText(/^0 von 25 Medien/)).toBeVisible()
    await pop.getByRole('button', { name: 'Video' }).click()
    await expect(page.getByText(/^4 von 25 Medien/)).toBeVisible() // IMG_0002–0005 zugeordnet
    // Esc schließt das Popover
    await page.keyboard.press('Escape')
    await expect(pop).toBeHidden()
    // Chip vorhanden und entfernbar
    const chip = page.locator('.chip', { hasText: 'Mit Paket' })
    await expect(chip).toBeVisible()
    await btn.click()
    await page.getByRole('dialog', { name: 'Medien filtern' }).getByRole('button', { name: 'RAW' }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.chip')).toHaveCount(2)
    await page.getByRole('button', { name: 'Alle Filter zurücksetzen' }).click()
    await expect(page.locator('.chip')).toHaveCount(0)
    await expect(page.getByText(/^25 von 25 Medien/)).toBeVisible()
  })

  test('Fokusansicht mit Navigation und Video-Player', async () => {
    const { page } = h
    await (await tile('IMG_0002.jpg')).click()
    await page.keyboard.press('Enter')
    await expect(page.locator('.stage img.zoomable')).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.focus-bar strong')).toHaveText('IMG_0003.jpg')
    await page.keyboard.press('Escape')
    await expect(page.locator('.gallery')).toBeVisible()
    await (await tile('VID_0001.mp4')).dblclick()
    const video = page.locator('.stage video')
    await expect(video).toBeVisible()
    expect(await video.evaluate((v) => (v as unknown as { autoplay: boolean }).autoplay)).toBe(false)
    await page.keyboard.press('Escape')
  })

  test('Sammelmodus: Exportvorschau und Kopieren', async () => {
    const { page } = h
    await page.getByRole('button', { name: /Exportvorschau öffnen/ }).click()
    const dlg = page.getByRole('dialog', { name: 'Exportvorschau' })
    await expect(dlg.locator('.stat .v').first()).toHaveText('4')
    await dlg.getByRole('button', { name: 'Kopieren starten' }).click()
    await expect.poll(() => (fs.existsSync(path.join(out, 'Anna')) ? fs.readdirSync(path.join(out, 'Anna')).sort() : [])).toEqual([
      'IMG_0002.jpg',
      'IMG_0003.jpg',
      'IMG_0004.jpg',
      'IMG_0005.jpg'
    ])
    expect(fs.existsSync(path.join(media, 'Zeremonie', 'IMG_0004.jpg'))).toBe(true)
  })

  test('Sofortmodus + Verschieben, danach weiteres Paket aus Wiederherstellung', async () => {
    const { page } = h
    await page.getByRole('radio', { name: 'Sofort' }).click()
    await page.getByRole('radio', { name: 'Verschieben' }).click()
    await (await tile('IMG_0007.jpg')).click()
    await page.keyboard.press('2')
    const src = path.join(media, 'Zeremonie', 'IMG_0007.jpg')
    await expect.poll(() => fs.existsSync(path.join(out, 'Max', 'IMG_0007.jpg')), { timeout: 20000 }).toBe(true)
    await expect.poll(() => fs.existsSync(src), { timeout: 20000 }).toBe(false)
    await expect((await tile('IMG_0007.jpg')).locator('.tag', { hasText: 'verschoben' })).toBeVisible()
    await page.keyboard.press('3')
    await expect.poll(() => fs.existsSync(path.join(out, 'Familie', 'IMG_0007.jpg')), { timeout: 20000 }).toBe(true)
    // Wiederherstellungsbereich zeigt die gehaltene Quelle
    await page.getByRole('button', { name: 'Wiederherstellung' }).click()
    const dlg = page.getByRole('dialog', { name: 'Wiederherstellungsbereich' })
    await expect(dlg.getByText('IMG_0007.jpg', { exact: true })).toBeVisible()
    await expect(dlg.getByText('Gehalten (kanonische Quelle)')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('radio', { name: 'Sammeln' }).click()
    await page.getByRole('radio', { name: 'Kopieren' }).click()
  })

  test('Theme umschalten und Persistenz nach Neustart', async () => {
    const { page } = h
    await page.getByRole('button', { name: /^Farbschema/ }).click() // system -> hell
    await page.getByRole('button', { name: /^Farbschema/ }).click() // hell -> dunkel
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await h.close()
    h = await launch(userData)
    const p2 = h.page
    await expect(p2.getByText(/von 25 Medien/)).toBeVisible()
    await expect(p2.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(p2.getByRole('button', { name: /^Anna, Taste 1/ })).toBeVisible()
    await expect(p2.locator('.pkg-name', { hasText: 'Familie' })).toBeVisible()
    await (await tile('IMG_0003.jpg')).click()
    await expect(p2.getByRole('button', { name: /^Anna, Taste 1/ })).toHaveAttribute('aria-pressed', 'true')
    await h.close()
  })
})
