import type { PpmApi } from '@shared/api'

export const api: PpmApi = window.ppm

// load=true: Datei darf aus dem Cloud-Speicher geladen werden („Nur online“)
export function thumbUrl(id: number, v = 0, load = false): string {
  return `ppm://thumb/${id}?v=${v}${load ? '&load=1' : ''}`
}
export function previewUrl(id: number, v = 0, load = false): string {
  return `ppm://preview/${id}?v=${v}${load ? '&load=1' : ''}`
}
export function mediaUrl(id: number, load = false): string {
  return `ppm://media/${id}${load ? '?load=1' : ''}`
}
