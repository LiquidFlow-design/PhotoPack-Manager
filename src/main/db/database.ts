import Database from 'better-sqlite3'
import { MIGRATIONS } from './migrations'

export type DB = Database.Database

export function openDatabase(file: string): DB {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // NORMAL: robust gegen Programmabstürze. Statuswechsel vor nicht umkehrbaren Dateischritten werden
  // zusätzlich mit durable() garantiert auf den Datenträger geschrieben (Schutz bei Stromausfall).
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    const tx = db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.pragma(`user_version = ${v + 1}`)
    })
    tx()
  }
}

export function schemaVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number
}

/**
 * Führt eine Transaktion aus, die auch bei Stromausfall erhalten bleibt (WAL wird beim Commit synchronisiert,
 * einschließlich aller vorherigen Transaktionen). Für Zustände vor nicht umkehrbaren Dateioperationen.
 */
export function durable<T>(db: DB, fn: () => T): T {
  db.pragma('synchronous = FULL')
  try {
    return db.transaction(fn)()
  } finally {
    db.pragma('synchronous = NORMAL')
  }
}
