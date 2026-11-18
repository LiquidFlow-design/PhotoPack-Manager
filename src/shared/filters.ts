// Reine Filter- und Sortierlogik. Wird im Renderer verwendet und per Unit-Test geprüft.
import type { AssignmentIndex } from './assignment'
import type { FilterState, MediaKind, MediaRow, SortState } from './types'
import { KIND_LABEL } from './media-kinds'

export const DEFAULT_FILTERS: FilterState = {
  kinds: [],
  assignment: 'all',
  packageIds: [],
  duplicates: 'all',
  formats: [],
  dateFrom: null,
  dateTo: null,
  exportState: 'all',
  location: 'all',
  search: ''
}

export const DEFAULT_SORT: SortState = { key: 'name', dir: 'asc' }

export interface FilterContext {
  assignments: AssignmentIndex
  exported: AssignmentIndex
  allPackageIds: string[]
  sourceId: string | null
}

function dayStart(s: string): number {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}
function dayEnd(s: string): number {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
}

export function mediaDate(m: MediaRow): number {
  return m.capturedAt ?? m.mtimeMs
}

export function matchesFilter(m: MediaRow, f: FilterState, ctx: FilterContext): boolean {
  if (ctx.sourceId && m.sourceId !== ctx.sourceId) return false
  if (f.kinds.length && !f.kinds.includes(m.kind)) return false
  if (f.formats.length && !f.formats.includes(m.ext)) return false
  if (f.search) {
    const q = f.search.toLowerCase()
    if (!m.name.toLowerCase().includes(q) && !m.relDir.toLowerCase().includes(q)) return false
  }
  if (f.duplicates === 'only' && !m.dupGroup) return false
  if (f.duplicates === 'none' && m.dupGroup) return false
  if (f.location === 'moved' && m.location !== 'recovery') return false
  if (f.location === 'missing' && m.location !== 'missing') return false
  if (f.dateFrom && mediaDate(m) < dayStart(f.dateFrom)) return false
  if (f.dateTo && mediaDate(m) > dayEnd(f.dateTo)) return false

  const assigned = ctx.assignments.get(m.id)
  const n = assigned?.size ?? 0
  if (f.packageIds.length) {
    const hits = f.packageIds.filter((p) => assigned?.has(p)).length
    if (f.assignment === 'none') {
      if (hits > 0) return false
    } else if (f.assignment === 'partial') {
      if (hits === 0 || hits === f.packageIds.length) return false
    } else if (f.assignment === 'any' || f.assignment === 'all') {
      // Paketauswahl ohne weitere Angabe: Medium muss in mindestens einem gewählten Paket sein
      if (hits === 0) return false
    }
  } else {
    if (f.assignment === 'none' && n > 0) return false
    if (f.assignment === 'any' && n === 0) return false
    if (f.assignment === 'partial') {
      const total = ctx.allPackageIds.length
      if (n === 0 || n >= total) return false
    }
  }

  if (f.exportState !== 'all') {
    if (n === 0) return false
    const ex = ctx.exported.get(m.id)
    let exportedCount = 0
    for (const p of assigned!) if (ex?.has(p)) exportedCount++
    if (f.exportState === 'exported' && exportedCount < n) return false
    if (f.exportState === 'pending' && exportedCount === n) return false
  }
  return true
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })

export function sortMedia(list: MediaRow[], s: SortState): MediaRow[] {
  const dir = s.dir === 'asc' ? 1 : -1
  const byName = (a: MediaRow, b: MediaRow) => collator.compare(a.name, b.name) || a.id - b.id
  let cmp: (a: MediaRow, b: MediaRow) => number
  switch (s.key) {
    case 'date':
      cmp = (a, b) => mediaDate(a) - mediaDate(b) || byName(a, b)
      break
    case 'size':
      cmp = (a, b) => a.size - b.size || byName(a, b)
      break
    case 'type':
      cmp = (a, b) => a.kind.localeCompare(b.kind) || a.ext.localeCompare(b.ext) || byName(a, b)
      break
    case 'folder':
      cmp = (a, b) => collator.compare(a.relDir, b.relDir) || byName(a, b)
      break
    default:
      cmp = byName
  }
  return list.slice().sort((a, b) => dir * cmp(a, b))
}

export function filterAndSort(all: MediaRow[], f: FilterState, s: SortState, ctx: FilterContext): MediaRow[] {
  return sortMedia(
    all.filter((m) => matchesFilter(m, f, ctx)),
    s
  )
}

export interface FilterChip {
  key: string
  label: string
  clear: (f: FilterState) => FilterState
}

const ASSIGN_LABEL = { all: '', none: 'Ohne Paket', any: 'Mit Paket', partial: 'Teilweise zugeordnet' } as const

export function activeChips(f: FilterState, packageNames: Map<string, string>): FilterChip[] {
  const chips: FilterChip[] = []
  for (const k of f.kinds)
    chips.push({ key: 'kind:' + k, label: 'Typ: ' + KIND_LABEL[k as MediaKind], clear: (x) => ({ ...x, kinds: x.kinds.filter((y) => y !== k) }) })
  if (f.assignment !== 'all')
    chips.push({ key: 'assignment', label: ASSIGN_LABEL[f.assignment], clear: (x) => ({ ...x, assignment: 'all' }) })
  for (const p of f.packageIds)
    chips.push({
      key: 'pkg:' + p,
      label: 'Paket: ' + (packageNames.get(p) ?? '?'),
      clear: (x) => ({ ...x, packageIds: x.packageIds.filter((y) => y !== p) })
    })
  if (f.duplicates !== 'all')
    chips.push({ key: 'dup', label: f.duplicates === 'only' ? 'Nur Duplikate' : 'Ohne Duplikate', clear: (x) => ({ ...x, duplicates: 'all' }) })
  for (const e of f.formats)
    chips.push({ key: 'fmt:' + e, label: 'Format: ' + e.toUpperCase(), clear: (x) => ({ ...x, formats: x.formats.filter((y) => y !== e) }) })
  if (f.dateFrom) chips.push({ key: 'from', label: 'Ab ' + fmtDay(f.dateFrom), clear: (x) => ({ ...x, dateFrom: null }) })
  if (f.dateTo) chips.push({ key: 'to', label: 'Bis ' + fmtDay(f.dateTo), clear: (x) => ({ ...x, dateTo: null }) })
  if (f.exportState !== 'all')
    chips.push({
      key: 'export',
      label: f.exportState === 'exported' ? 'Vollständig exportiert' : 'Export ausstehend',
      clear: (x) => ({ ...x, exportState: 'all' })
    })
  if (f.location !== 'all')
    chips.push({ key: 'loc', label: f.location === 'moved' ? 'Verschoben' : 'Quelle fehlt', clear: (x) => ({ ...x, location: 'all' }) })
  return chips
}

/** Anzahl aktiver Filter (ohne Suche) für das Badge am Filter-Icon. */
export function activeFilterCount(f: FilterState): number {
  return activeChips(f, new Map()).length
}

function fmtDay(s: string): string {
  const [y, m, d] = s.split('-')
  return `${d}.${m}.${y}`
}

export function resetFilters(f: FilterState): FilterState {
  return { ...DEFAULT_FILTERS, search: f.search }
}
