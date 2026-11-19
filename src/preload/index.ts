// Preload (Sandbox): stellt eine schmale, typisierte API bereit. Kein Node-Zugriff im Renderer.
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { API_METHODS, DROP_CHANNEL, EVENT_CHANNEL, channel, type PpmApi, type Result } from '../shared/api'
import type { AppEvent } from '../shared/types'

async function call(ch: string, args: unknown[]): Promise<unknown> {
  const r = (await ipcRenderer.invoke(ch, ...args)) as Result<unknown>
  if (!r || typeof r !== 'object') throw new Error('Ungültige Antwort')
  if (!r.ok) throw new Error(r.error)
  return r.value
}

const api: Record<string, unknown> = {}
for (const [group, methods] of Object.entries(API_METHODS)) {
  const g: Record<string, (...a: unknown[]) => Promise<unknown>> = {}
  for (const m of methods) g[m] = (...a: unknown[]) => call(channel(group, m), a)
  api[group] = g
}
// Ordner per Drag & Drop: Pfade werden hier aus echten, vom Nutzer gezogenen Dateiobjekten ermittelt.
// Die Seite selbst bekommt keine Pfade zu sehen und kann keine beliebigen Pfade übergeben.
api.dropSources = (projectId: string, files: File[]) => {
  const paths = files.map((f) => webUtils.getPathForFile(f)).filter((p) => typeof p === 'string' && p.length > 0)
  return call(DROP_CHANNEL, [projectId, paths])
}
api.onEvent = (cb: (e: AppEvent) => void) => {
  const h = (_: unknown, e: AppEvent) => cb(e)
  ipcRenderer.on(EVENT_CHANNEL, h)
  return () => ipcRenderer.removeListener(EVENT_CHANNEL, h)
}

contextBridge.exposeInMainWorld('ppm', api as unknown as PpmApi)
