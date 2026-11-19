// Exportplanung: erzeugt einen unveränderlichen Snapshot (Medien, Ziele, Fingerprints, Konfliktregeln).
import fs from 'node:fs'
import type { ConflictPolicy, ExportPlanOptions, ExportPlanPreview, Operation, PlanPackageSummary, PlanVolume } from '@shared/types'
import { newId, type CoreContext } from './context'
import { exists, freeBytes, nearestExisting, statOrNull } from './fsx'
import { effectiveTargetDir } from './packages'
import { isInside, nameKey, numberedName, pathKey, volumeRoot } from './paths'
import { getProject } from './projects'
import { resolveRecoveryDir } from './recovery'
import { cloudRootFor } from './cloud'

export interface PlannedCopy {
  mediaId: number
  packageId: string
  packageName: string
  fileName: string
  srcPath: string
  srcSize: number
  srcMtimeMs: number
  srcSha256: string | null
  destDir: string
  destName: string
  reexport: boolean
  sidecar?: boolean
}

export interface PlannedRelease {
  mediaId: number
  fileName: string
  srcPath: string
  srcSize: number
  srcMtimeMs: number
  srcSha256: string | null
}

export interface PlanSnapshot {
  id: string
  projectId: string
  operation: Operation
  conflictPolicy: ConflictPolicy
  copies: PlannedCopy[]
  releases: PlannedRelease[]
  createdAt: number
}

interface PairRow {
  media_id: number
  package_id: string
  package_name: string
  target_dir: string | null
  file_name: string
  current_path: string
  location: 'source' | 'recovery' | 'missing'
  size: number
  mtime_ms: number
  sha256: string | null
  dest_path: string | null
  active_items: number
  role: 'main' | 'sidecar'
  parent_id: number | null
}

export const SPACE_MARGIN = 64 * 1024 * 1024

/**
 * Erstellt Vorschau + Snapshot. mediaIds/pairs schränken den Plan ein (Sofortmodus).
 */
export async function buildPlan(
  ctx: CoreContext,
  projectId: string,
  opts: ExportPlanOptions,
  restrict?: { pairs?: Array<[number, string]> }
): Promise<{ preview: ExportPlanPreview; snapshot: PlanSnapshot }> {
  const project = getProject(ctx, projectId)
  const rows = ctx.db
    .prepare(
      `SELECT mp.media_id, mp.package_id, k.name AS package_name, k.target_dir, m.file_name, m.current_path, m.location,
              m.size, m.mtime_ms, m.sha256, d.path AS dest_path, m.role, m.parent_id,
              (SELECT COUNT(*) FROM job_items i WHERE i.active = 1 AND i.kind = 'copy' AND i.media_id = mp.media_id AND i.package_id = mp.package_id) AS active_items
       FROM media_packages mp
       JOIN packages k ON k.id = mp.package_id
       JOIN media m ON m.id = mp.media_id
       LEFT JOIN transfer_destinations d ON d.media_id = mp.media_id AND d.package_id = mp.package_id
       WHERE m.project_id = ?
       ORDER BY k.sort_order, k.created_at, (m.role = 'sidecar'), mp.position, m.file_name COLLATE NOCASE, m.original_path`
    )
    .all(projectId) as PairRow[]

  const pkgFilter = opts.packageIds ? new Set(opts.packageIds) : null
  const pairFilter = restrict?.pairs ? new Set(restrict.pairs.map(([m, p]) => `${m}:${p}`)) : null

  const warnings: string[] = []
  const blocking: string[] = []
  const pkgSummaries = new Map<string, PlanPackageSummary>()
  const copies: PlannedCopy[] = []
  let missingSources = 0
  let inActiveJobs = 0
  let fromExportCopies = 0
  const createdDirs: string[] = []
  const plannedNames = new Map<string, string>()
  // Paketreihenfolge als Nummer: Position unter allen Hauptmedien des Pakets (stabil, unabhängig vom Planumfang)
  const numberPrefix = opts.numberPrefix ?? project.numberPrefix
  const orderCache = new Map<string, Map<number, { n: number; width: number }>>()
  const orderOf = (pkgId: string) => {
    let m = orderCache.get(pkgId)
    if (!m) {
      const ids = ctx.db
        .prepare("SELECT mp.media_id FROM media_packages mp JOIN media x ON x.id = mp.media_id AND x.role = 'main' WHERE mp.package_id = ? ORDER BY mp.position, mp.assigned_at")
        .all(pkgId) as Array<{ media_id: number }>
      const width = Math.max(3, String(ids.length).length)
      m = new Map(ids.map((r, i) => [r.media_id, { n: i + 1, width }]))
      orderCache.set(pkgId, m)
    }
    return m
  }

  const sources = ctx.db.prepare('SELECT path, real_path FROM sources WHERE project_id = ?').all(projectId) as Array<{ path: string; real_path: string }>
  const srcExistsCache = new Map<string, boolean>()
  const dirNames = new Map<string, Set<string>>() // destDir -> vorhandene + reservierte Namen

  async function namesIn(dir: string): Promise<Set<string>> {
    let s = dirNames.get(dir)
    if (s) return s
    s = new Set()
    try {
      for (const n of await fs.promises.readdir(dir)) s.add(nameKey(n))
    } catch {
      /* Ordner existiert noch nicht */
    }
    dirNames.set(dir, s)
    return s
  }
  const existingOnDisk = new Map<string, Set<string>>()

  for (const r of rows) {
    if (pkgFilter && !pkgFilter.has(r.package_id)) continue
    if (pairFilter && !pairFilter.has(`${r.media_id}:${r.package_id}`)) continue
    const targetDir = effectiveTargetDir(project.outputDir, { name: r.package_name, target_dir: r.target_dir })
    let sum = pkgSummaries.get(r.package_id)
    if (!sum) {
      sum = {
        packageId: r.package_id,
        packageName: r.package_name,
        targetDir,
        items: 0,
        bytes: 0,
        alreadyExported: 0,
        missingTargets: 0,
        nameCollisions: 0,
        existingConflicts: 0,
        problems: []
      }
      pkgSummaries.set(r.package_id, sum)
      if (!targetDir) {
        sum.problems.push('Kein Zielordner: globalen Ausgabeordner oder individuellen Paketordner festlegen.')
        blocking.push(`Paket „${r.package_name}“ hat keinen Zielordner.`)
      } else {
        if (isInside(targetDir, project.recoveryDir) || isInside(targetDir, ctx.dataDir)) {
          sum.problems.push('Zielordner liegt im Wiederherstellungs- oder Programmdatenordner.')
          blocking.push(`Zielordner von „${r.package_name}“ ist unzulässig.`)
        }
        for (const s of sources) {
          if (isInside(targetDir, s.path) || isInside(targetDir, s.real_path)) {
            sum.problems.push('Zielordner liegt innerhalb einer Quelle (wird bei der Indexierung ausgeschlossen).')
            warnings.push(`Zielordner von „${r.package_name}“ liegt in der Quelle „${s.path}“ und wird dort von der Indexierung ausgeschlossen.`)
          }
        }
        const base = await nearestExisting(targetDir)
        if (!base) {
          sum.problems.push('Zielordner bzw. Laufwerk ist nicht erreichbar.')
          blocking.push(`Zielordner von „${r.package_name}“ ist nicht erreichbar.`)
        } else if (pathKey(base) !== pathKey(targetDir)) {
          createdDirs.push(targetDir)
        }
      }
    }

    if (r.dest_path) {
      let reexport = false
      if (opts.reexportMissing && !(await exists(r.dest_path))) reexport = true
      if (!reexport) {
        sum.alreadyExported++
        if (!opts.reexportMissing && !(await exists(r.dest_path))) sum.missingTargets++
        continue
      }
    }
    if (r.active_items > 0) {
      inActiveJobs++
      continue
    }
    let srcPath = r.current_path
    let srcOk = r.location !== 'missing' ? srcExistsCache.get(r.current_path) : false
    if (srcOk === undefined) {
      srcOk = await exists(r.current_path)
      srcExistsCache.set(r.current_path, srcOk)
    }
    if (!srcOk && r.sha256) {
      // Rückfall: verifizierte Exportkopie mit identischer Prüfsumme als Quelle verwenden
      const alt = await verifiedExportCopy(ctx, r.media_id, r.sha256, r.size)
      if (alt) {
        srcPath = alt
        srcOk = true
        fromExportCopies++
      }
    }
    if (!srcOk) {
      missingSources++
      continue
    }
    if (!targetDir) continue

    // Namenskollisionen deterministisch auflösen (Reihenfolge: Paket, Dateiname, Originalpfad)
    let disk = existingOnDisk.get(targetDir)
    if (!disk) {
      disk = new Set(await namesIn(targetDir))
      existingOnDisk.set(targetDir, disk)
    }
    const taken = await namesIn(targetDir)
    let n = 1
    let baseDest = r.file_name
    if (numberPrefix && r.role === 'main') {
      const pos = orderOf(r.package_id).get(r.media_id)
      if (pos) baseDest = `${String(pos.n).padStart(pos.width, '0')}_${r.file_name}`
    }
    if (r.role === 'sidecar' && r.parent_id) {
      // Sidecar folgt dem Zielnamen seines Hauptmediums (z. B. „IMG_1 (2).CR3“ → „IMG_1 (2).CR3.xmp“)
      const parent = plannedNames.get(`${r.parent_id}:${r.package_id}`)
      if (parent) {
        const pRow = rows.find((x) => x.media_id === r.parent_id)
        const pOrig = pRow?.file_name ?? ''
        if (pOrig && r.file_name.toLowerCase().startsWith(pOrig.toLowerCase())) baseDest = parent + r.file_name.slice(pOrig.length)
        else {
          const dot = parent.lastIndexOf('.')
          baseDest = (dot > 0 ? parent.slice(0, dot) : parent) + r.file_name.slice(r.file_name.lastIndexOf('.'))
        }
      }
    }
    let destName = baseDest
    if (disk.has(nameKey(destName))) sum.existingConflicts++
    while (taken.has(nameKey(destName)) && !disk.has(nameKey(destName))) {
      // Kollision innerhalb dieses Plans
      n++
      destName = numberedName(baseDest, n)
    }
    if (n > 1) sum.nameCollisions++
    if (!disk.has(nameKey(destName))) taken.add(nameKey(destName))
    plannedNames.set(`${r.media_id}:${r.package_id}`, destName)

    sum.items++
    sum.bytes += r.size
    copies.push({
      mediaId: r.media_id,
      packageId: r.package_id,
      packageName: r.package_name,
      fileName: r.file_name,
      srcPath,
      srcSize: r.size,
      srcMtimeMs: r.mtime_ms,
      srcSha256: r.sha256,
      destDir: targetDir,
      destName,
      reexport: !!r.dest_path,
      sidecar: r.role === 'sidecar'
    })
  }

  // Verschieben: Quelle erst nach allen Zielkopien in den Wiederherstellungsbereich
  const releases: PlannedRelease[] = []
  if (opts.operation === 'move') {
    const seen = new Set<number>()
    for (const c of copies) {
      if (seen.has(c.mediaId)) continue
      seen.add(c.mediaId)
      const m = ctx.db.prepare('SELECT location, current_path, size, mtime_ms, sha256, file_name FROM media WHERE id = ?').get(c.mediaId) as {
        location: string
        current_path: string
        size: number
        mtime_ms: number
        sha256: string | null
        file_name: string
      }
      if (m.location !== 'source') continue
      releases.push({ mediaId: c.mediaId, fileName: m.file_name, srcPath: m.current_path, srcSize: m.size, srcMtimeMs: m.mtime_ms, srcSha256: m.sha256 })
    }
  }

  // Speicherplatz je Datenträger
  const need = new Map<string, number>()
  for (const c of copies) {
    const root = volumeRoot(c.destDir)
    need.set(root, (need.get(root) ?? 0) + c.srcSize)
  }
  if (releases.length) {
    for (const r of releases) {
      const recRoot = volumeRoot(await resolveRecoveryDir(ctx, project, r.srcPath))
      if (volumeRoot(r.srcPath) !== recRoot) need.set(recRoot, (need.get(recRoot) ?? 0) + r.srcSize)
    }
  }
  const volumes: PlanVolume[] = []
  for (const [root, bytes] of need) {
    const sample = copies.find((c) => volumeRoot(c.destDir) === root)?.destDir ?? project.recoveryDir
    const free = await freeBytes(sample)
    const ok = free === null || free >= bytes + SPACE_MARGIN
    volumes.push({ root, requiredBytes: bytes, freeBytes: free, ok })
    if (!ok) blocking.push(`Nicht genügend Speicherplatz auf ${root} (benötigt ca. ${fmtBytes(bytes)}, frei ${fmtBytes(free ?? 0)}).`)
  }

  // Cloud-Speicher (Proton Drive, OneDrive …)
  const cloudQ = ctx.db.prepare('SELECT m.cloud_state AS st, s.cloud_provider AS prov FROM media m LEFT JOIN sources s ON s.id = m.source_id WHERE m.id = ?')
  const onlineBy = new Map<string, number>()
  const seenCloud = new Set<number>()
  for (const c of copies) {
    if (seenCloud.has(c.mediaId)) continue
    seenCloud.add(c.mediaId)
    const r = cloudQ.get(c.mediaId) as { st: string; prov: string | null } | undefined
    if (r?.st === 'online') onlineBy.set(r.prov ?? 'Cloud', (onlineBy.get(r.prov ?? 'Cloud') ?? 0) + 1)
  }
  for (const [prov, n] of onlineBy) warnings.push(`${n} Datei(en) liegen nur online in ${prov} und werden beim Export heruntergeladen.`)
  const releaseBy = new Map<string, number>()
  for (const r of releases) {
    const x = cloudQ.get(r.mediaId) as { st: string; prov: string | null } | undefined
    if (x?.prov) releaseBy.set(x.prov, (releaseBy.get(x.prov) ?? 0) + 1)
  }
  for (const [prov, n] of releaseBy)
    warnings.push(`Verschieben entfernt ${n} Datei(en) aus ${prov} – über die Synchronisation auch online. Die Originale bleiben im Wiederherstellungsbereich.`)
  const roots = await ctx.cloud.roots().catch(() => [])
  const targetClouds = new Set<string>()
  for (const sum of pkgSummaries.values()) {
    const r = sum.targetDir ? cloudRootFor(sum.targetDir, roots) : null
    if (r) targetClouds.add(r.provider)
  }
  for (const prov of targetClouds) warnings.push(`Ziel liegt in ${prov}: exportierte Dateien werden anschließend hochgeladen.`)

  if (createdDirs.length === 1) warnings.push(`Zielordner wird angelegt: ${createdDirs[0]}`)
  else if (createdDirs.length > 1) warnings.push(`${createdDirs.length} Zielordner werden angelegt (je Paket ein Unterordner).`)
  if (fromExportCopies) warnings.push(`${fromExportCopies} Zuordnung(en) werden aus einer verifizierten Exportkopie bedient (Original nicht mehr vorhanden).`)
  if (missingSources) warnings.push(`${missingSources} Zuordnung(en) übersprungen: Quelldatei fehlt.`)
  if (inActiveJobs) warnings.push(`${inActiveJobs} Zuordnung(en) sind bereits in einem laufenden Auftrag enthalten.`)
  const moveIntoRecovery = ctx.db.prepare("SELECT COUNT(*) AS n FROM media WHERE project_id = ? AND location = 'recovery'").get(projectId) as { n: number }
  if (opts.operation === 'move' && moveIntoRecovery.n > 0)
    warnings.push('Bereits verschobene Medien werden aus dem Wiederherstellungsbereich kopiert; ihre Quelle bleibt dort erhalten.')

  const id = newId()
  const snapshot: PlanSnapshot = {
    id,
    projectId,
    operation: opts.operation,
    conflictPolicy: opts.conflictPolicy,
    copies,
    releases,
    createdAt: ctx.now()
  }
  const preview: ExportPlanPreview = {
    planId: id,
    operation: opts.operation,
    conflictPolicy: opts.conflictPolicy,
    packages: [...pkgSummaries.values()],
    totalItems: copies.length,
    totalBytes: copies.reduce((a, c) => a + c.srcSize, 0),
    mediaCount: new Set(copies.filter((c) => !c.sidecar).map((c) => c.mediaId)).size,
    moveReleases: releases.length,
    missingSources,
    inActiveJobs,
    volumes,
    warnings: [...new Set(warnings)],
    blockingErrors: [...new Set(blocking)],
    createdAt: snapshot.createdAt
  }
  return { preview, snapshot }
}

async function verifiedExportCopy(ctx: CoreContext, mediaId: number, sha: string, size: number): Promise<string | null> {
  const rows = ctx.db.prepare('SELECT path FROM transfer_destinations WHERE media_id = ? AND sha256 = ? AND size = ?').all(mediaId, sha, size) as Array<{ path: string }>
  for (const r of rows) {
    const st = await statOrNull(r.path)
    if (st && st.isFile() && st.size === size) return r.path
  }
  return null
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0).replace('.', ',')} ${u[i]}`
}
