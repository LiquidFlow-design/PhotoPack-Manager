import type { PpmApi } from '@shared/api'

export const api: PpmApi = window.ppm

export function thumbUrl(id: number, v = 0): string {
  return `ppm://thumb/${id}?v=${v}`
}
export function previewUrl(id: number, v = 0): string {
  return `ppm://preview/${id}?v=${v}`
}
export function mediaUrl(id: number): string {
  return `ppm://media/${id}`
}
