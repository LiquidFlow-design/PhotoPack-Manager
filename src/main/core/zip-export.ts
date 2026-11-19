// ZIP-Export eines Pakets (Reihenfolge = Paketreihenfolge, Sidecars direkt nach ihrem Medium).
// Nur lesender Zugriff auf Medien. Das Archiv entsteht als Zwischendatei und wird erst am Ende umbenannt.
import fs from 'node:fs'
import path from 'node:path'
import yazl from 'yazl'
import { oplog, type CoreContext } from './context'
import { nameKey, numberedName, TMP_PREFIX, TMP_SUFFIX } from './paths'
import { unlinkIfExists } from './fsx'

export interface ZipResult {
  file: string
  entries: number
  skipped: Array<{ name: string; reason: string }>
  bytes: number
}

export async function exportPackageZip(
  ctx: CoreContext,
  packageId: string,
  file: string,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<ZipResult> {
  const pkg = ctx.db.prepare('SELECT project_id, name FROM packages WHERE id = ?').get(packageId) as { project_id: string; name: string } | undefined
  if (!pkg) throw new Error('Paket nicht gefunden.')
  const rows = ctx.db
    .prepare(
      `SELECT m.id, m.file_name, m.current_path, m.size, m.location, m.role, m.parent_id, mp.position
       FROM media_packages mp JOIN media m ON m.id = mp.media_id
       WHERE mp.package_id = ? ORDER BY mp.position, m.file_name`
    )
    .all(packageId) as Array<{ id: number; file_name: string; current_path: string; size: number; location: string; role: string; parent_id: number | null }>
  // Reihenfolge: Hauptmedien in Paketreihenfolge, Sidecars direkt dahinter
  const mains = rows.filter((r) => r.role === 'main')
  const sidecars = new Map<number, typeof rows>()
  for (const r of rows) if (r.role === 'sidecar' && r.parent_id) sidecars.set(r.parent_id, [...(sidecars.get(r.parent_id) ?? []), r])
  const ordered = mains.flatMap((m) => [m, ...(sidecars.get(m.id) ?? [])])

  const tmp = path.join(path.dirname(file), `${TMP_PREFIX}zip-${packageId.slice(0, 8)}${TMP_SUFFIX}`)
  await unlinkIfExists(tmp)
  const zip = new yazl.ZipFile()
  const out = fs.createWriteStream(tmp, { flags: 'wx' })
  const finished = new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve())
    out.on('error', reject)
    zip.outputStream.on('error', reject)
  })
  zip.outputStream.pipe(out)
  const used = new Set<string>()
  const skipped: ZipResult['skipped'] = []
  let entries = 0
  let bytes = 0
  let done = 0
  for (const r of ordered) {
    if (opts.signal?.aborted) break
    done++
    opts.onProgress?.(done, ordered.length)
    if (r.location === 'missing') {
      skipped.push({ name: r.file_name, reason: 'Quelle fehlt' })
      continue
    }
    let st: fs.Stats
    try {
      st = await fs.promises.stat(r.current_path)
    } catch {
      skipped.push({ name: r.file_name, reason: 'Quelle nicht erreichbar' })
      continue
    }
    if (st.size !== r.size) {
      skipped.push({ name: r.file_name, reason: 'Quelle verändert' })
      continue
    }
    let n = 1
    let name = r.file_name
    while (used.has(nameKey(name))) name = numberedName(r.file_name, ++n)
    used.add(nameKey(name))
    // Fotos/Videos sind bereits komprimiert -> speichern ohne Kompression (schnell)
    zip.addFile(r.current_path, name, { compress: false, mtime: st.mtime })
    entries++
    bytes += st.size
  }
  zip.end()
  await finished
  if (opts.signal?.aborted) {
    await unlinkIfExists(tmp)
    throw new Error('ZIP-Export abgebrochen.')
  }
  // Ziel wurde im Speicherdialog bestätigt (inkl. Ersetzen-Abfrage des Betriebssystems)
  await fs.promises.rename(tmp, file)
  oplog(ctx, pkg.project_id, 'info', 'package.zip', 'package', packageId, { file, entries, skipped: skipped.length })
  return { file, entries, skipped, bytes }
}
