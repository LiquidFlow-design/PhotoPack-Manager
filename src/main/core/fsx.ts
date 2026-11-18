// Kleine, sicherheitsrelevante Dateisystem-Helfer.
import fs from 'node:fs'
import path from 'node:path'

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p)
    return true
  } catch {
    return false
  }
}

export async function statOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p)
  } catch {
    return null
  }
}

export async function unlinkIfExists(p: string | null | undefined): Promise<void> {
  if (!p) return
  try {
    await fs.promises.unlink(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/** Nächster existierender Elternordner (für Platzprüfung auf noch nicht angelegten Zielen). */
export async function nearestExisting(p: string): Promise<string | null> {
  let cur = path.resolve(p)
  for (;;) {
    if (await exists(cur)) return cur
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/** Freier Speicher in Bytes auf dem Datenträger von p (null, wenn unbekannt). */
export async function freeBytes(p: string): Promise<number | null> {
  const base = await nearestExisting(p)
  if (!base) return null
  try {
    const s = await fs.promises.statfs(base)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/**
 * Atomarer Commit ohne Überschreiben: tmp -> final.
 * Bevorzugt Hardlink (schlägt mit EEXIST fehl, falls final existiert) und entfernt dann tmp.
 * Fallback (z. B. FAT/exFAT, manche Netzlaufwerke): Existenzprüfung + rename.
 * Rückgabe false = final existiert bereits (nichts verändert).
 */
export async function commitNoOverwrite(tmp: string, final: string): Promise<boolean> {
  try {
    await fs.promises.link(tmp, final)
    await fs.promises.unlink(tmp)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    if (code && ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EINVAL', 'EACCES', 'EOPNOTSUPP', 'UNKNOWN'].includes(code)) {
      if (await exists(final)) return false
      await fs.promises.rename(tmp, final)
      return true
    }
    throw e
  }
}

/** Einfache prozessinterne Sperre je Schlüssel (z. B. Zielordner beim Commit). */
export class KeyedMutex {
  private chains = new Map<string, Promise<void>>()
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((r) => (release = r))
    const chained = prev.then(() => next)
    this.chains.set(key, chained)
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (this.chains.get(key) === chained) this.chains.delete(key)
    }
  }
}
