import { expect, test, type Locator } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch, stubDirDialog, type AppHandle } from './helpers'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-e2e-v2-'))
const media = path.join(root, 'quelle')
const out = path.join(root, 'export')
let h: AppHandle

test.beforeAll(() => {
  execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/gen-test-media.mjs'), media, '9'], { stdio: 'ignore' })
  // RAW+JPEG-Paar mit Sidecar
  fs.copyFileSync(path.join(media, 'Zeremonie', 'IMG_0001.jpg'), path.join(media, 'Zeremonie', 'DSC_0500.JPG'))
  fs.writeFileSync(path.join(media, 'Zeremonie', 'DSC_0500.CR2'), Buffer.alloc(5000, 3))
  fs.writeFileSync(path.join(media, 'Zeremonie', 'DSC_0500.xmp'), '<x:xmpmeta/>')
  fs.mkdirSync(out, { recursive: true })
})
test.afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const tile = (name: string): Locator => h.page.locator('.tile', { has: h.page.locator('.tile-name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }) }).first()
const names = async () => h.page.locator('.tile .tile-name').allTextContents()

test.describe.serial('Version 2', () => {
  test('Einrichten', async () => {
    h = await launch(path.join(root, 'ud'))
    const { page, app } = h
    await page.getByRole('button', { name: 'Neues Projekt' }).first().click()
    await page.getByLabel('Projektname').fill('V2')
    await page.getByRole('button', { name: 'Projekt anlegen' }).click()
    await stubDirDialog(app, media)
    await page.getByRole('button', { name: 'Quellordner hinzufügen' }).first().click()
    await expect(page.getByText(/von \d+ Medien/)).toBeVisible()
    for (const n of ['Anna', 'Max']) {
      await page.getByRole('button', { name: 'Neues Paket erstellen' }).click()
      await page.getByLabel(/Name des Pakets/).fill(n)
      await page.getByRole('button', { name: 'Paket erstellen', exact: true }).click()
    }
    await stubDirDialog(app, out)
    await page.getByRole('button', { name: 'Ausgabeordner wählen' }).click()
  })

  test('RAW+JPEG-Paar wird gemeinsam zugeordnet und gekennzeichnet', async () => {
    const { page } = h
    await expect(tile('DSC_0500.CR2').locator('.tag').first()).toContainText('RAW+JPG')
    await expect(tile('DSC_0500.CR2').locator('.tag').first()).toContainText('XMP')
    await tile('DSC_0500.JPG').click()
    await page.keyboard.press('2')
    await tile('DSC_0500.CR2').click()
    await expect(page.getByRole('button', { name: /^Max .*Taste 2$/ })).toHaveAttribute('aria-pressed', 'true')
  })

  test('Paketansicht: Inhalt, Drag & Drop, Tastatur, Entfernen', async () => {
    const { page } = h
    for (const f of ['IMG_0003.jpg', 'IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0004.jpg']) {
      await tile(f).click()
      await page.keyboard.press('1')
    }
    await page.getByRole('button', { name: 'Paket Anna ansehen' }).click()
    await expect(page.locator('h1')).toContainText('Anna')
    // Paketansicht zeigt nur Paketinhalt in Zuordnungsreihenfolge (Portraits/IMG_0001 hat gleichen Namen – Reihenfolge nach Zuordnung)
    await expect.poll(names).toEqual(['IMG_0003.jpg', 'IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0004.jpg'])
    // Drag & Drop: IMG_0004 vor IMG_0003
    await tile('IMG_0004.jpg').dragTo(tile('IMG_0003.jpg'), { targetPosition: { x: 5, y: 40 } })
    await expect.poll(names).toEqual(['IMG_0004.jpg', 'IMG_0003.jpg', 'IMG_0001.jpg', 'IMG_0002.jpg'])
    // Tastatur: Strg+Pfeil rechts verschiebt Auswahl nach hinten
    await tile('IMG_0003.jpg').click()
    await page.keyboard.press('Control+ArrowRight')
    await expect.poll(names).toEqual(['IMG_0004.jpg', 'IMG_0001.jpg', 'IMG_0003.jpg', 'IMG_0002.jpg'])
    // Sortierung als Reihenfolge übernehmen
    await page.getByLabel('Sortieren nach').selectOption('name')
    await page.getByRole('button', { name: 'Als Reihenfolge übernehmen' }).click()
    await expect(page.getByLabel('Sortieren nach')).toHaveValue('custom')
    await expect.poll(names).toEqual(['IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0003.jpg', 'IMG_0004.jpg'])
    // Reihenfolge bleibt beim Verlassen und erneuten Öffnen
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(page.locator('h1')).toContainText('Medienübersicht')
    await page.getByRole('button', { name: 'Paket Anna ansehen' }).click()
    await expect.poll(names).toEqual(['IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0003.jpg', 'IMG_0004.jpg'])
    // Entf entfernt aus dem Paket, Strg+Z nimmt es zurück, Strg+Y wiederholt
    await tile('IMG_0002.jpg').click()
    await page.keyboard.press('Delete')
    await expect.poll(names).toEqual(['IMG_0001.jpg', 'IMG_0003.jpg', 'IMG_0004.jpg'])
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await names()).length).toBe(4)
    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await names()).length).toBe(3)
    await page.keyboard.press('Control+z')
    await page.getByRole('button', { name: 'Zurück zur Medienübersicht' }).click()
  })

  test('Pakete per Tastatur in der Seitenleiste umsortieren', async () => {
    const { page } = h
    await page.getByRole('button', { name: /^Max verschieben/ }).focus()
    await page.keyboard.press('Control+ArrowUp')
    await expect(page.locator('.pkg-name').first()).toHaveText('Max')
    await page.keyboard.press('Control+ArrowDown')
    await expect(page.locator('.pkg-name').first()).toHaveText('Anna')
  })

  test('Bewertung und Farbmarkierung per Tastatur, Filter', async () => {
    const { page } = h
    await tile('IMG_0005.jpg').click()
    await page.keyboard.press('Alt+4')
    await page.keyboard.press('Alt+6')
    await expect(tile('IMG_0005.jpg').locator('.rating')).toContainText('4')
    await page.locator('#filter-button').click()
    const pop = page.getByRole('dialog', { name: 'Medien filtern' })
    await pop.getByRole('button', { name: 'Mindestens 3 Sterne' }).click()
    await expect(page.getByText(/^1 von/)).toBeVisible()
    await pop.getByRole('button', { name: 'Alle Bewertungen' }).click()
    await pop.getByRole('button', { name: 'Rot' }).click()
    await expect(page.getByText(/^1 von/)).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Alle Filter zurücksetzen' }).click()
  })

  test('Sofortmodus: „Rückgängig“ im Hinweis verhindert die Übertragung', async () => {
    const { page } = h
    await page.getByRole('radio', { name: 'Sofort' }).click()
    await tile('IMG_0007.jpg').click()
    await page.keyboard.press('1')
    const undo = page.locator('.toast').getByRole('button', { name: 'Rückgängig' })
    await expect(undo).toBeVisible()
    await undo.click()
    await expect(page.getByRole('button', { name: /^Anna .*Taste 1$/ })).toHaveAttribute('aria-pressed', 'false')
    await page.waitForTimeout(4000)
    expect(fs.existsSync(path.join(out, 'Anna', 'IMG_0007.jpg'))).toBe(false)
    await page.getByRole('radio', { name: 'Sammeln' }).click()
  })

  test('Präsentationsfenster folgt dem aktiven Medium', async () => {
    const { page, app } = h
    await tile('IMG_0006.jpg').click()
    const pres = app.waitForEvent('window')
    await page.getByRole('button', { name: 'Präsentationsfenster' }).click()
    const p2 = await pres
    await expect(p2.locator('.presenter img')).toHaveAttribute('alt', 'IMG_0006.jpg')
    await page.locator('.gallery').focus()
    await page.keyboard.press('ArrowRight')
    await expect(p2.locator('.presenter img')).not.toHaveAttribute('alt', 'IMG_0006.jpg')
    // Navigation aus dem Präsentationsfenster steuert das Hauptfenster
    const before = await page.locator('.tile.active .tile-name').textContent()
    await p2.keyboard.press('ArrowLeft')
    await expect(page.locator('.tile.active .tile-name')).not.toHaveText(before ?? '')
    await page.getByRole('button', { name: 'Präsentationsfenster' }).click()
    await expect(page.getByRole('button', { name: 'Präsentationsfenster' })).toHaveAttribute('aria-pressed', 'false')
    await h.close()
  })
})
