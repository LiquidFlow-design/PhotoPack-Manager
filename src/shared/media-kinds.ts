import type { MediaKind } from './types'

export const IMAGE_EXTS = ['jpg', 'jpeg', 'jpe', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif'] as const
export const RAW_EXTS = [
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw', 'x3f', '3fr', 'iiq', 'erf', 'kdc', 'mos', 'mrw', 'rwl'
] as const
export const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'mkv', 'avi', 'webm', 'mts', 'm2ts', 'mpg', 'mpeg', 'wmv', '3gp'] as const

const map = new Map<string, MediaKind>()
for (const e of IMAGE_EXTS) map.set(e, 'image')
for (const e of RAW_EXTS) map.set(e, 'raw')
for (const e of VIDEO_EXTS) map.set(e, 'video')

export function kindForExt(ext: string): MediaKind | null {
  return map.get(ext.toLowerCase()) ?? null
}

export function extOf(fileName: string): string {
  const i = fileName.lastIndexOf('.')
  if (i <= 0 || i === fileName.length - 1) return ''
  return fileName.slice(i + 1).toLowerCase()
}

/** Formate, die Chromium direkt anzeigen kann (Fokusansicht ohne Konvertierung). */
export const BROWSER_NATIVE_IMAGE = new Set(['jpg', 'jpeg', 'jpe', 'png', 'webp', 'gif', 'bmp', 'avif'])

export const KIND_LABEL: Record<MediaKind, string> = { image: 'Bild', raw: 'RAW', video: 'Video' }
