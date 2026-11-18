import { ArrowDownAZ, ArrowUpAZ, Filter, LayoutGrid, Maximize2, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { activeChips, activeFilterCount, resetFilters } from '@shared/filters'
import type { SortKey } from '@shared/types'
import { useStore } from '../state/store'
import { FilterPopover } from './FilterPopover'

const SORT_LABEL: Record<SortKey, string> = { name: 'Dateiname', date: 'Aufnahmedatum', size: 'Dateigröße', type: 'Dateityp', folder: 'Ordner' }

export function Toolbar() {
  const s = useStore()
  const { filters, sort, visible, media, selection, view, packages, filterOpen, sourceId, sources } = s
  const [q, setQ] = useState(filters.search)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => setQ(filters.search), [filters.search])
  const onSearch = (v: string) => {
    setQ(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => s.setFilters({ ...useStore.getState().filters, search: v }), 160)
  }
  const pkgNames = useMemo(() => new Map(packages.map((p) => [p.id, p.name])), [packages])
  const chips = activeChips(filters, pkgNames)
  const nActive = activeFilterCount(filters)
  const src = sourceId ? sources.find((x) => x.id === sourceId) : null
  const title = src ? (src.path.split(/[\\/]/).filter(Boolean).pop() ?? src.path) : 'Medienübersicht'

  return (
    <>
      <div className="toolbar">
        <div style={{ minWidth: 0 }}>
          <h1 className="ellipsis">{title}</h1>
          <div className="small muted" aria-live="polite">
            {visible.length.toLocaleString('de-DE')} von {media.length.toLocaleString('de-DE')} Medien · {selection.size.toLocaleString('de-DE')} ausgewählt
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <div className="search" role="search">
            <Search size={15} className="muted" />
            <input id="media-search" placeholder="Medien suchen …" aria-label="Medien nach Name oder Ordner suchen" value={q} onChange={(e) => onSearch(e.target.value)} />
            {q && (
              <button className="icon-btn ghost sm" style={{ width: 22, height: 22 }} aria-label="Suche leeren" onClick={() => onSearch('')}>
                <X size={13} />
              </button>
            )}
          </div>
          <div className="popover-wrap">
            <button
              className="icon-btn"
              id="filter-button"
              aria-label={`Filter${nActive ? ` (${nActive} aktiv)` : ''}`}
              title="Filter"
              aria-haspopup="dialog"
              aria-expanded={filterOpen}
              aria-controls="filter-popover"
              onClick={() => s.setFilterOpen(!filterOpen)}
            >
              <Filter size={17} />
              {nActive > 0 && <span className="badge-count">{nActive}</span>}
            </button>
            {filterOpen && <FilterPopover />}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <select className="select" style={{ width: 'auto', minHeight: 34 }} aria-label="Sortieren nach" value={sort.key} onChange={(e) => s.setSort({ ...sort, key: e.target.value as SortKey })}>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABEL[k]}
                </option>
              ))}
            </select>
            <button
              className="icon-btn"
              aria-label={sort.dir === 'asc' ? 'Aufsteigend sortiert – umkehren' : 'Absteigend sortiert – umkehren'}
              title={sort.dir === 'asc' ? 'Aufsteigend' : 'Absteigend'}
              onClick={() => s.setSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
            >
              {sort.dir === 'asc' ? <ArrowDownAZ size={17} /> : <ArrowUpAZ size={17} />}
            </button>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Ansicht">
            <button role="radio" aria-checked={view === 'grid'} onClick={() => s.setView('grid')} title="Rasteransicht">
              <LayoutGrid size={15} /> Raster
            </button>
            <button role="radio" aria-checked={view === 'focus'} onClick={() => s.setView('focus')} title="Fokusansicht (Enter)">
              <Maximize2 size={15} /> Fokus
            </button>
          </div>
        </div>
      </div>
      {chips.length > 0 && (
        <div className="chips" aria-label="Aktive Filter">
          {chips.map((c) => (
            <span className="chip" key={c.key}>
              {c.label}
              <button aria-label={`Filter ${c.label} entfernen`} onClick={() => s.setFilters(c.clear(filters))}>
                <X size={12} />
              </button>
            </span>
          ))}
          <button className="link-btn" onClick={() => s.setFilters(resetFilters(filters))}>
            Alle Filter zurücksetzen
          </button>
        </div>
      )}
    </>
  )
}
