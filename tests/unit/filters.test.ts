import { describe, expect, it } from 'vitest'
import { buildIndex } from '../../src/shared/assignment'
import { activeChips, activeFilterCount, DEFAULT_FILTERS, filterAndSort, resetFilters } from '../../src/shared/filters'
import type { FilterState, MediaRow } from '../../src/shared/types'

function m(id: number, name: string, kind: MediaRow['kind'], extra: Partial<MediaRow> = {}): MediaRow {
  const ext = name.split('.').pop()!.toLowerCase()
  return { id, sourceId: 's1', name, ext, kind, relDir: '', size: id * 100, mtimeMs: new Date(2026, 0, id).getTime(), capturedAt: null, width: null, height: null, durationMs: null, location: 'source', thumbStatus: 'ok', thumbError: null, dupGroup: null, hasHash: false, pairId: null, sidecars: 0, rating: 0, colorLabel: null, simGroup: null, cloudOnline: false, ...extra } as MediaRow
}

const media = [
  m(1, 'IMG_0001.jpg', 'image'),
  m(2, 'IMG_0002.CR3', 'raw'),
  m(3, 'VID_0003.mp4', 'video', { dupGroup: 'x' }),
  m(4, 'IMG_0004.jpg', 'image', { dupGroup: 'x' }),
  m(5, 'IMG_0010.png', 'image', { location: 'recovery' })
]
const ctx = {
  assignments: buildIndex([[1, 'A'], [2, 'A'], [2, 'B'], [3, 'B']]),
  exported: buildIndex([[1, 'A'], [2, 'A']]),
  allPackageIds: ['A', 'B'],
  sourceId: null
}
const run = (f: Partial<FilterState>) => filterAndSort(media, { ...DEFAULT_FILTERS, ...f }, { key: 'name', dir: 'asc' }, ctx).map((x) => x.id).sort((a, b) => a - b)

describe('Filter', () => {
  it('Medientyp', () => {
    expect(run({ kinds: ['image'] })).toEqual([1, 4, 5])
    expect(run({ kinds: ['raw', 'video'] })).toEqual([2, 3])
  })
  it('Zuordnung ohne/mit/teilweise', () => {
    expect(run({ assignment: 'none' })).toEqual([4, 5])
    expect(run({ assignment: 'any' })).toEqual([1, 2, 3])
    expect(run({ assignment: 'partial' })).toEqual([1, 3]) // in einigen, nicht allen Paketen
  })
  it('ausgewählte Pakete, kombiniert mit Zuordnungsart', () => {
    expect(run({ packageIds: ['B'] })).toEqual([2, 3])
    expect(run({ packageIds: ['A', 'B'], assignment: 'partial' })).toEqual([1, 3])
    expect(run({ packageIds: ['A'], assignment: 'none' })).toEqual([3, 4, 5])
  })
  it('Duplikate, Format, Ort, Exportstatus', () => {
    expect(run({ duplicates: 'only' })).toEqual([3, 4])
    expect(run({ duplicates: 'none' })).toEqual([1, 2, 5])
    expect(run({ formats: ['cr3', 'png'] })).toEqual([2, 5])
    expect(run({ location: 'moved' })).toEqual([5])
    expect(run({ exportState: 'exported' })).toEqual([1])
    expect(run({ exportState: 'pending' })).toEqual([2, 3])
  })
  it('Datumsbereich', () => {
    expect(run({ dateFrom: '2026-01-02', dateTo: '2026-01-03' })).toEqual([2, 3])
  })
  it('Kombination + Suche', () => {
    expect(run({ kinds: ['image'], duplicates: 'none', search: '0010' })).toEqual([5])
  })
  it('natürliche Sortierung und Richtung', () => {
    const r = filterAndSort(media, DEFAULT_FILTERS, { key: 'size', dir: 'desc' }, ctx).map((x) => x.id)
    expect(r).toEqual([5, 4, 3, 2, 1])
  })
  it('Chips, Zähler und Zurücksetzen', () => {
    const f: FilterState = { ...DEFAULT_FILTERS, kinds: ['raw'], packageIds: ['A'], duplicates: 'only', search: 'abc' }
    const chips = activeChips(f, new Map([['A', 'Anna']]))
    expect(chips.map((c) => c.label)).toEqual(['Typ: RAW', 'Paket: Anna', 'Nur Duplikate'])
    expect(activeFilterCount(f)).toBe(3)
    const after = chips[1].clear(f)
    expect(after.packageIds).toEqual([])
    const reset = resetFilters(f)
    expect(activeFilterCount(reset)).toBe(0)
    expect(reset.search).toBe('abc')
  })
})
