import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, type DB } from '../../src/main/db/database'
import { createContext, type CloudFns, type CoreContext } from '../../src/main/core/context'
import { inlineFileOps, type FileOps } from '../../src/main/core/fileops'
import { Faults } from '../../src/main/core/faults'
import { TransferEngine } from '../../src/main/core/engine'
import { createProject, updateProjectSettings } from '../../src/main/core/projects'
import { addSource, scanSource } from '../../src/main/core/sources'
import { createPackage } from '../../src/main/core/packages'
import { applyAssignments } from '../../src/main/core/assignments'
import { buildPlan } from '../../src/main/core/planner'
import { updateSettings } from '../../src/main/core/settings'
import type { AppEvent, ConflictPolicy, Operation } from '../../src/shared/types'

export interface TestEnv {
  root: string
  dataDir: string
  srcDir: string
  outDir: string
  dbFile: string
  db: DB
  ctx: CoreContext
  faults: Faults
  engine: TransferEngine
  projectId: string
  sourceId: string
  events: AppEvent[]
  clock: { t: number }
  /** Simuliert Neustart: neue DB-Verbindung, neue Engine (Faults bleiben leer). */
  restart(): Promise<{ interruptedJobs: number; notes: string[] }>
  cleanup(): void
}

export function sha(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** Deterministischer Pseudo-Inhalt (nur generierte Testdaten, niemals echte Nutzerdaten). */
export function content(seed: string, size = 2048): Buffer {
  const out = Buffer.alloc(size)
  let h = crypto.createHash('sha256').update(seed).digest()
  for (let off = 0; off < size; off += h.length) {
    h.copy(out, off, 0, Math.min(h.length, size - off))
    h = crypto.createHash('sha256').update(h).digest()
  }
  return out
}

export function writeFile(p: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
}

export async function makeEnv(
  files: Record<string, Buffer | string> = {},
  opts: { fileOps?: FileOps; outDirInside?: boolean; recoveryDir?: string; concurrency?: number; cloud?: CloudFns } = {}
): Promise<TestEnv> {
  const base = path.join(process.cwd(), '.tmp-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'env-'))
  const dataDir = path.join(root, 'appdata')
  const srcDir = path.join(root, 'quelle')
  const outDir = opts.outDirInside ? path.join(srcDir, 'export') : path.join(root, 'export')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(srcDir, { recursive: true })
  for (const [rel, data] of Object.entries(files)) writeFile(path.join(srcDir, rel), data)
  const dbFile = path.join(dataDir, 'test.sqlite')
  const events: AppEvent[] = []
  const clock = { t: Date.now() }
  const faults = new Faults()
  const env: TestEnv = {
    root,
    dataDir,
    srcDir,
    outDir,
    dbFile,
    db: null as unknown as DB,
    ctx: null as unknown as CoreContext,
    faults,
    engine: null as unknown as TransferEngine,
    projectId: '',
    sourceId: '',
    events,
    clock,
    async restart() {
      env.db.close()
      env.db = openDatabase(dbFile)
      env.ctx = createContext({ db: env.db, fileOps: opts.fileOps ?? inlineFileOps, dataDir, emit: (e) => events.push(e), now: () => clock.t, faults: new Faults(), cloud: env.ctx.cloud })
      env.engine = new TransferEngine(env.ctx, { concurrency: opts.concurrency ?? 2 })
      const r = await env.engine.reconcile()
      env.engine.start()
      return r
    },
    cleanup() {
      try {
        env.db.close()
      } catch {
        /* ignore */
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  env.db = openDatabase(dbFile)
  const cloud: CloudFns = opts.cloud ?? { roots: async () => [], onlineOnly: async () => new Set() }
  env.ctx = createContext({ db: env.db, fileOps: opts.fileOps ?? inlineFileOps, dataDir, emit: (e) => events.push(e), now: () => clock.t, faults, cloud })
  env.engine = new TransferEngine(env.ctx, { concurrency: opts.concurrency ?? 2 })
  env.engine.start()
  updateSettings(env.ctx, { instantDelaySec: 0 })
  const p = createProject(env.ctx, 'Testprojekt')
  env.projectId = p.id
  updateProjectSettings(env.ctx, p.id, { outputDir: outDir, recoveryDir: opts.recoveryDir ?? null })
  const s = await addSource(env.ctx, p.id, srcDir, true)
  env.sourceId = s.id
  await scanSource(env.ctx, s.id)
  return env
}

export function mediaId(env: TestEnv, rel: string): number {
  const full = path.join(env.srcDir, rel)
  const r = env.db.prepare('SELECT id FROM media WHERE original_path = ?').get(full) as { id: number } | undefined
  if (!r) throw new Error('Medium nicht gefunden: ' + rel)
  return r.id
}

export function pkg(env: TestEnv, name: string, targetDir?: string): string {
  return createPackage(env.ctx, env.projectId, name, { targetDir: targetDir ?? null }).id
}

export async function assign(env: TestEnv, pairs: Array<[number, string]>) {
  return applyAssignments(env.ctx, env.engine, env.projectId, { added: pairs, removed: [] })
}

export async function exportAll(env: TestEnv, operation: Operation = 'copy', conflictPolicy: ConflictPolicy = 'rename', packageIds: string[] | null = null) {
  const { preview, snapshot } = await buildPlan(env.ctx, env.projectId, { packageIds, operation, conflictPolicy, reexportMissing: false })
  if (preview.blockingErrors.length) throw new Error('Plan blockiert: ' + preview.blockingErrors.join('; '))
  const r = env.engine.createJob(snapshot, 'collect', 'Test-Export')
  const crash = await env.engine.waitIdle()
  return { preview, jobId: r.jobId, crash }
}

export function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(path.relative(dir, p).split(path.sep).join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

export function readSha(p: string): string {
  return sha(fs.readFileSync(p))
}

export function items(env: TestEnv, jobId: string) {
  return env.engine.listItems(jobId)
}

export function jobStatus(env: TestEnv, jobId: string): string {
  return (env.db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string }).status
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ppm-'))
}
