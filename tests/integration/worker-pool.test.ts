// Worker-Pool: echte Worker-Threads (gebautes Skript aus out/) und Rückfall bei nicht ladbarem Skript.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkerFileOps } from '../../src/main/core/worker-pool'
import { content, sha, tmpDir } from '../helpers/env'

const built = path.resolve('out/main/file-worker.js')

describe('Worker-Pool', () => {
  it.skipIf(!fs.existsSync(built))('hasht und kopiert in Worker-Threads (gebautes Skript)', async () => {
    const pool = new WorkerFileOps(built, 2)
    try {
      expect(await pool.selfTest()).toBe(true)
      const d = tmpDir()
      const src = path.join(d, 'a.bin')
      fs.writeFileSync(src, content('w', 3_000_000))
      const r = await pool.copyWithHash(src, path.join(d, 'b.bin'))
      expect(r.sha256).toBe(sha(content('w', 3_000_000)))
      await expect(pool.copyWithHash(src, path.join(d, 'b.bin'))).rejects.toThrow() // wx: niemals überschreiben
      fs.rmSync(d, { recursive: true, force: true })
      expect(pool.broken).toBe(false)
    } finally {
      await pool.close()
    }
  })

  it('nicht ladbares Worker-Skript: keine Endlosschleife, Rückfall auf Main-Prozess', async () => {
    const pool = new WorkerFileOps('/gibt/es/nicht/worker.js', 2)
    expect(await pool.selfTest(3000)).toBe(false) // App nutzt dann die Inline-Variante
    await new Promise((r) => setTimeout(r, 500))
    expect(pool.broken).toBe(true) // Neustarts begrenzt
    const d = tmpDir()
    fs.writeFileSync(path.join(d, 'x'), 'abc')
    expect((await pool.hashFile(path.join(d, 'x'))).sha256).toBe(sha('abc')) // Rückfall liefert korrekte Ergebnisse
    fs.rmSync(d, { recursive: true, force: true })
    await pool.close()
  })
})
