// Cloud-Speicher mit lokalem Synchronisationsordner (Windows Cloud Files API): Proton Drive, OneDrive, …
// - Erkennung der Sync-Ordner über die Registrierung (SyncRootManager) mit Rückfall auf Standardpfade
// - Erkennung von „Nur online“-Platzhaltern (Lesen würde den Download auslösen)
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isInside } from './paths'

export interface CloudRoot {
  id: string
  provider: string // „Proton Drive“, „OneDrive“, …
  label: string // Anzeigename (Konto/Ordner)
  path: string
}

export type PsRunner = (script: string, env?: Record<string, string>, timeoutMs?: number) => Promise<string | null>

/** PowerShell-Aufruf (nur Windows); Werte nur über Umgebungsvariablen übergeben (keine Skript-Injektion). */
export const runPowerShell: PsRunner = (script, env = {}, timeoutMs = 20000) =>
  new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null)
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, out) => resolve(err ? null : String(out))
    )
  })

const SYNC_ROOTS_PS = `
$base='HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$r=@()
if (Test-Path $base) { Get-ChildItem $base | ForEach-Object {
  $k=$_; $p=Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
  $u=Join-Path $k.PSPath 'UserSyncRoots'
  if (Test-Path $u) { $v=(Get-ItemProperty $u -ErrorAction SilentlyContinue).$sid
    if ($v) { $r+=[pscustomobject]@{ Id=$k.PSChildName; Name=[string]$p.DisplayNameResource; Path=[string]$v } } }
} }
ConvertTo-Json -Compress -InputObject @($r)`

export function providerName(id: string, name: string): string {
  const s = `${id} ${name}`
  if (/proton/i.test(s)) return 'Proton Drive'
  if (/onedrive/i.test(s)) return 'OneDrive'
  if (/dropbox/i.test(s)) return 'Dropbox'
  if (/google|drivefs/i.test(s)) return 'Google Drive'
  if (/icloud/i.test(s)) return 'iCloud'
  if (/box/i.test(s)) return 'Box'
  return (id.split('!')[0] || name || 'Cloud').trim()
}

/** Ausgabe des Registrierungs-Skripts auswerten (testbar ohne Windows). */
export function parseSyncRoots(json: string | null): CloudRoot[] {
  if (!json) return []
  let arr: Array<{ Id?: string; Name?: string; Path?: string }>
  try {
    const v = JSON.parse(json.trim() || '[]')
    arr = Array.isArray(v) ? v : [v]
  } catch {
    return []
  }
  return arr
    .filter((x) => x && x.Path)
    .map((x) => {
      const provider = providerName(x.Id ?? '', x.Name ?? '')
      const account = (x.Id ?? '').split('!')[2] ?? ''
      return { id: '', provider, label: account ? `${provider} – ${account}` : provider, path: x.Path! }
    })
}

let cache: { at: number; roots: CloudRoot[] } | null = null

export async function detectCloudRoots(opts: { ps?: PsRunner; home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; force?: boolean } = {}): Promise<CloudRoot[]> {
  if (!opts.force && cache && Date.now() - cache.at < 60_000) return cache.roots
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? os.homedir()
  const env = opts.env ?? process.env
  const roots: CloudRoot[] = []
  if (platform === 'win32') roots.push(...parseSyncRoots(await (opts.ps ?? runPowerShell)(SYNC_ROOTS_PS)))
  // Rückfall: Standardorte (auch wenn die Registrierung nicht lesbar ist)
  const protonBase = path.join(home, 'Proton Drive')
  if (fs.existsSync(protonBase)) {
    for (const acc of fs.readdirSync(protonBase, { withFileTypes: true })) {
      if (!acc.isDirectory()) continue
      const p = path.join(protonBase, acc.name)
      roots.push({ id: '', provider: 'Proton Drive', label: `Proton Drive – ${acc.name}`, path: p })
    }
  }
  for (const v of ['OneDriveConsumer', 'OneDriveCommercial', 'OneDrive']) {
    const p = env[v]
    if (p && fs.existsSync(p)) roots.push({ id: '', provider: 'OneDrive', label: v === 'OneDriveCommercial' ? 'OneDrive (Arbeit)' : 'OneDrive', path: p })
  }
  // Doppelte/verschachtelte Einträge entfernen (Registrierung hat Vorrang)
  const out: CloudRoot[] = []
  for (const r of roots) {
    if (!fs.existsSync(r.path)) continue
    if (out.some((o) => isInside(r.path, o.path) || isInside(o.path, r.path))) continue
    out.push({ ...r, id: `cloud-${out.length}` })
  }
  cache = { at: Date.now(), roots: out }
  return out
}

export function cloudRootFor(p: string, roots: CloudRoot[]): CloudRoot | null {
  return roots.find((r) => isInside(p, r.path)) ?? null
}

// Kompatibel mit Windows PowerShell 5.1 (.NET Framework); Get-ChildItem liest nur Metadaten (kein Download)
const ONLINE_ONLY_PS = `
$m=0x400000 -bor 0x40000 -bor 0x1000
Get-ChildItem -LiteralPath $env:PPM_DIR -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { if (([int]$_.Attributes) -band $m) { $_.FullName } }`

/**
 * Liefert alle Dateien unter dir, die nur online vorliegen (RECALL_ON_DATA_ACCESS / RECALL_ON_OPEN / OFFLINE).
 * Liest keine Dateiinhalte – löst also keinen Download aus. Außerhalb von Windows leer.
 */
export async function scanOnlineOnly(dir: string, ps: PsRunner = runPowerShell): Promise<Set<string>> {
  const out = await ps(ONLINE_ONLY_PS, { PPM_DIR: dir }, 120000)
  return new Set((out ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
}
