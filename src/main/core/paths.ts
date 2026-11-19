import fs from 'node:fs'
import path from 'node:path'

const isWin = process.platform === 'win32'

/** Normalisierter Vergleichsschlüssel für Pfade (Windows: case-insensitiv, ohne abschließenden Trenner). */
export function pathKey(p: string): string {
  let r = path.resolve(p)
  if (r.length > 1 && (r.endsWith(path.sep) || r.endsWith('/')) && !/^[A-Za-z]:[\\/]$/.test(r)) r = r.slice(0, -1)
  return isWin ? r.toLowerCase() : r
}

/** true, wenn child gleich parent ist oder darin liegt (ohne Symlink-Auflösung). */
export function isInside(child: string, parent: string): boolean {
  const c = pathKey(child)
  const p = pathKey(parent)
  if (c === p) return true
  const withSep = p.endsWith(path.sep) ? p : p + path.sep
  return c.startsWith(withSep)
}

/** realpath, falls existent; sonst normalisierter Pfad. Löst Symlinks/Junctions auf. */
export async function realPathOrSelf(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p)
  } catch {
    return path.resolve(p)
  }
}

/** Unzulässige Zeichen für Windows-Dateinamen ersetzen (gilt auch für Paketordner). */
export function sanitizeFileName(name: string): string {
  let n = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
  if (!n) n = '_'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = '_' + n
  return n.slice(0, 180)
}

/** Deterministischer Konfliktname im Windows-Stil: "Name (2).ext", "Name (3).ext" … */
export function numberedName(fileName: string, n: number): string {
  if (n <= 1) return fileName
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return `${fileName} (${n})`
  return `${fileName.slice(0, dot)} (${n})${fileName.slice(dot)}`
}

/** Liefert das Wurzelverzeichnis (Laufwerk / Mount) eines Pfades für Platzprüfungen. */
export function volumeRoot(p: string): string {
  const r = path.parse(path.resolve(p)).root
  return r || '/'
}

export function nameKey(name: string): string {
  return isWin ? name.toLowerCase() : name
}

export const TMP_PREFIX = '.ppm-'
export const TMP_SUFFIX = '.tmp'
export function isOwnTempFile(name: string): boolean {
  return name.startsWith(TMP_PREFIX) && name.endsWith(TMP_SUFFIX)
}

/** Ordner, die beim Indexieren grundsätzlich übersprungen werden. */
export const SKIP_DIR_NAMES = new Set(['$recycle.bin', 'system volume information', '.photopack-recovery', '.trash', '.trashes', '.spotlight-v100', '.fseventsd'])
