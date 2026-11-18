import crypto from 'node:crypto'
import path from 'node:path'
import type { AppEvent } from '@shared/types'
import type { DB } from '../db/database'
import type { FileOps } from './fileops'
import { Faults } from './faults'

export interface CoreContext {
  db: DB
  fileOps: FileOps
  dataDir: string // Benutzerdatenordner der App
  emit: (evt: AppEvent) => void
  now: () => number
  faults: Faults
}

export function createContext(opts: { db: DB; fileOps: FileOps; dataDir: string; emit?: (e: AppEvent) => void; now?: () => number; faults?: Faults }): CoreContext {
  return {
    db: opts.db,
    fileOps: opts.fileOps,
    dataDir: opts.dataDir,
    emit: opts.emit ?? (() => {}),
    now: opts.now ?? (() => Date.now()),
    faults: opts.faults ?? new Faults()
  }
}

export const newId = (): string => crypto.randomUUID()

export function thumbsDir(ctx: CoreContext): string {
  return path.join(ctx.dataDir, 'cache', 'thumbs')
}

export function defaultRecoveryBase(ctx: CoreContext): string {
  return path.join(ctx.dataDir, 'recovery')
}

export function oplog(
  ctx: CoreContext,
  projectId: string | null,
  level: 'info' | 'warn' | 'error',
  action: string,
  entity?: string,
  entityId?: string | number | null,
  details?: unknown
): void {
  ctx.db
    .prepare('INSERT INTO operation_log (project_id, ts, level, action, entity, entity_id, details) VALUES (?,?,?,?,?,?,?)')
    .run(projectId, ctx.now(), level, action, entity ?? null, entityId == null ? null : String(entityId), details === undefined ? null : JSON.stringify(details))
}
