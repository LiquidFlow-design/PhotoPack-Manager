// Einstellungen, die vor dem Start von Chromium feststehen müssen (z. B. Grafikbeschleunigung).
// Liegen als kleine JSON-Datei im Datenordner, weil die Datenbank erst nach „ready“ geöffnet wird.
import fs from 'node:fs'
import path from 'node:path'

export interface LaunchFlags {
  hardwareAcceleration: boolean
}

const FILE = 'launch.json'

export function readLaunchFlags(dataDir: string): LaunchFlags {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8')) as Partial<LaunchFlags>
    return { hardwareAcceleration: v.hardwareAcceleration !== false }
  } catch {
    return { hardwareAcceleration: true }
  }
}

export function writeLaunchFlags(dataDir: string, flags: LaunchFlags): void {
  const file = path.join(dataDir, FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(flags))
  fs.renameSync(tmp, file)
}
