import { describe, expect, it } from 'vitest'
import { isInside, numberedName, sanitizeFileName, isOwnTempFile } from '../../src/main/core/paths'
import { kindForExt, extOf } from '../../src/shared/media-kinds'

describe('Pfade und Namen', () => {
  it('numberedName im Windows-Stil', () => {
    expect(numberedName('IMG.jpg', 1)).toBe('IMG.jpg')
    expect(numberedName('IMG.jpg', 2)).toBe('IMG (2).jpg')
    expect(numberedName('README', 3)).toBe('README (3)')
    expect(numberedName('.hidden', 2)).toBe('.hidden (2)')
  })
  it('isInside', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/bc', '/a/b')).toBe(false)
    expect(isInside('/a/b/../x', '/a/b')).toBe(false)
  })
  it('sanitizeFileName entfernt unzulässige Zeichen und reservierte Namen', () => {
    expect(sanitizeFileName('Anna: Hochzeit?')).toBe('Anna_ Hochzeit_')
    expect(sanitizeFileName('CON')).toBe('_CON')
    expect(sanitizeFileName('name. ')).toBe('name')
    expect(sanitizeFileName('')).toBe('_')
  })
  it('eigene Zwischendateien erkennen', () => {
    expect(isOwnTempFile('.ppm-123.tmp')).toBe(true)
    expect(isOwnTempFile('foto.tmp')).toBe(false)
  })
  it('Formatklassifikation', () => {
    for (const e of ['jpg', 'JPEG', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff']) expect(kindForExt(e)).toBe('image')
    for (const e of ['cr2', 'CR3', 'nef', 'arw', 'dng']) expect(kindForExt(e)).toBe('raw')
    for (const e of ['mp4', 'mov', 'MKV']) expect(kindForExt(e)).toBe('video')
    expect(kindForExt('txt')).toBeNull()
    expect(extOf('a.b.JPG')).toBe('jpg')
    expect(extOf('noext')).toBe('')
  })
})
