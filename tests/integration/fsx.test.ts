// Windows-Verhalten des Festschreibens simuliert: gesperrte Zwischendatei, Dateisystem ohne Hardlinks.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitNoOverwrite } from '../../src/main/core/fsx'
import { tmpDir } from '../helpers/env'

afterEach(() => vi.restoreAllMocks())

describe('commitNoOverwrite', () => {
  it('Zwischendatei kurz gesperrt (Virenscanner): trotzdem festgeschrieben, kein zweiter Name', async () => {
    const d = tmpDir()
    const tmp = path.join(d, '.ppm-1.tmp')
    const fin = path.join(d, 'a.jpg')
    fs.writeFileSync(tmp, 'x')
    const real = fs.promises.unlink
    let n = 0
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async (p) => {
      if (n++ < 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return real(p)
    })
    expect(await commitNoOverwrite(tmp, fin)).toBe(true)
    expect(fs.readFileSync(fin, 'utf8')).toBe('x')
    expect(fs.existsSync(tmp)).toBe(false)
    fs.rmSync(d, { recursive: true, force: true })
  })

  it('dauerhaft gesperrte Zwischendatei: Ziel gilt dennoch als festgeschrieben', async () => {
    const d = tmpDir()
    const tmp = path.join(d, '.ppm-2.tmp')
    fs.writeFileSync(tmp, 'y')
    vi.spyOn(fs.promises, 'unlink').mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    expect(await commitNoOverwrite(tmp, path.join(d, 'b.jpg'))).toBe(true)
    vi.restoreAllMocks()
    fs.rmSync(d, { recursive: true, force: true })
  }, 20000)

  it('FAT32/exFAT (Windows: EISDIR bei link): Rückfall ohne Überschreiben', async () => {
    const d = tmpDir()
    const tmp = path.join(d, '.ppm-3.tmp')
    fs.writeFileSync(tmp, 'z')
    fs.writeFileSync(path.join(d, 'belegt.jpg'), 'fremd')
    vi.spyOn(fs.promises, 'link').mockRejectedValue(Object.assign(new Error('invalid function'), { code: 'EISDIR' }))
    expect(await commitNoOverwrite(tmp, path.join(d, 'belegt.jpg'))).toBe(false)
    expect(fs.readFileSync(path.join(d, 'belegt.jpg'), 'utf8')).toBe('fremd')
    expect(await commitNoOverwrite(tmp, path.join(d, 'frei.jpg'))).toBe(true)
    expect(fs.readFileSync(path.join(d, 'frei.jpg'), 'utf8')).toBe('z')
    fs.rmSync(d, { recursive: true, force: true })
  })
})
