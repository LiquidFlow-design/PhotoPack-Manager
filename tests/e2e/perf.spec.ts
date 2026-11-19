// UI-Reaktionsfähigkeit mit 12.000 synthetischen Medien (eigener Lauf: npx playwright test perf).
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { launch, stubDirDialog } from './helpers'

const N = 12_000
test('12.000 Medien: Laden, Scrollen, Auswahl, Zuordnung', async () => {
  test.setTimeout(300_000)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-perf-'))
  const src = path.join(root, 'quelle')
  const base = await sharp({ create: { width: 320, height: 214, channels: 3, background: '#4a6b8a' } }).jpeg({ quality: 70 }).toBuffer()
  for (let i = 0; i < N; i++) {
    const dir = path.join(src, `Ordner_${Math.floor(i / 1000)}`)
    if (i % 1000 === 0) fs.mkdirSync(dir, { recursive: true })
    // Inhalt je Datei minimal variieren (JPEG-Kommentar am Ende ist für Decoder unschädlich)
    fs.writeFileSync(path.join(dir, `IMG_${String(i).padStart(5, '0')}.jpg`), Buffer.concat([base, Buffer.from(String(i))]))
  }
  const h = await launch()
  const { page, app } = h
  const r: Record<string, number> = {}
  try {
    await page.getByRole('button', { name: 'Neues Projekt' }).first().click()
    await page.getByLabel('Projektname').fill('Perf')
    await page.getByRole('button', { name: 'Projekt anlegen' }).click()
    await stubDirDialog(app, src)
    let t = Date.now()
    await page.getByRole('button', { name: 'Quellordner hinzufügen' }).first().click()
    await expect(page.getByText(`von ${N.toLocaleString('de-DE')} Medien`)).toBeVisible({ timeout: 60_000 })
    r.index_and_render_ms = Date.now() - t

    await page.getByRole('button', { name: 'Neues Paket erstellen' }).click()
    await page.getByLabel(/Name des Pakets/).fill('Anna')
    await page.getByRole('button', { name: 'Paket erstellen', exact: true }).click()

    await page.locator('.tile').first().click()
    // Tastaturnavigation: 50 Schritte nach rechts
    t = Date.now()
    for (let i = 0; i < 50; i++) await page.keyboard.press('ArrowRight')
    await expect(page.locator('.tile.active .tile-name')).toHaveText('IMG_00050.jpg')
    r.keyboard_50_steps_ms = Date.now() - t

    // Zum Ende springen (virtualisiertes Scrollen)
    t = Date.now()
    await page.keyboard.press('End')
    await expect(page.locator('.tile.active .tile-name')).toHaveText(`IMG_${String(N - 1).padStart(5, '0')}.jpg`)
    r.jump_to_end_ms = Date.now() - t
    r.dom_tiles = await page.locator('.tile').count()

    // Alles auswählen und zuordnen
    t = Date.now()
    await page.keyboard.press('Control+a')
    await expect(page.getByText(`· ${N.toLocaleString('de-DE')} ausgewählt`)).toBeVisible()
    r.select_all_ms = Date.now() - t
    t = Date.now()
    await page.keyboard.press('1')
    await expect(page.getByRole('button', { name: /^Anna .*Taste 1$/ })).toHaveAttribute('aria-pressed', 'true')
    r.assign_all_ms = Date.now() - t

    // Filter auf großer Liste
    t = Date.now()
    await page.locator('#media-search').fill('IMG_0999')
    await expect(page.getByText(/^10 von/)).toBeVisible()
    r.search_filter_ms = Date.now() - t

    // Hauptthread-Blockaden messen: längste Pause in 2 s Scrollen
    await page.locator('#media-search').fill('')
    r.max_frame_gap_while_scrolling_ms = await page.evaluate(async () => {
      const g = document.querySelector('.gallery') as HTMLElement
      let last = performance.now()
      let max = 0
      let run = true
      const loop = () => {
        const now = performance.now()
        max = Math.max(max, now - last)
        last = now
        if (run) requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
      const start = performance.now()
      while (performance.now() - start < 2000) {
        g.scrollTop += 600
        await new Promise((res) => setTimeout(res, 16))
      }
      run = false
      return Math.round(max)
    })
  } finally {
    console.log('UI-Perf', JSON.stringify(r))
    fs.mkdirSync(path.resolve(__dirname, '../../.tmp-tests'), { recursive: true })
    fs.writeFileSync(path.resolve(__dirname, '../../.tmp-tests/ui-perf.json'), JSON.stringify(r, null, 2))
    await h.close()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(h.userData, { recursive: true, force: true })
  }
  expect(r.dom_tiles).toBeLessThan(400)
})
