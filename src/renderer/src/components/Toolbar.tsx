import { ArrowDownAZ, ArrowLeft, ArrowUpAZ, Filter, ListOrdered, LayoutGrid, Maximize2, PackageMinus, X } from 'lucide-react'
import { useMemo } from 'react'
import { activeChips, activeFilterCount, resetFilters } from '@shared/filters'
import type { MediaKind, SortKey } from '@shared/types'
import { useStore } from '../state/store'
import { FilterPopover } from './FilterPopover'

const SORT_LABEL: Record<SortKey, string> = {
  custom: 'Eigene Reihenfolge',
  name: 'Dateiname',
  date: 'Aufnahmedatum',
  size: 'Dateigröße',
  type: 'Dateityp',
  folder: 'Ordner',
  rating: 'Bewertung'
}

export function Toolbar() {
  const s = useStore()
  const { filters, visible, media, selection, view, packages, filterOpen, sourceId, sources, packageView, pkgSort } = s
  const sort = packageView ? pkgSort : s.sort
  const pkg = packageView ? packages.find((p) => p.id === packageView) : null
  const pkgNames = useMemo(() => new Map(packages.map((p) => [p.id, p.name])), [packages])
  // Ein einzelner Medientyp wird über die Reiter gezeigt – nicht zusätzlich als Chip
  const tabKind = filters.kinds.length === 1 ? filters.kinds[0] : filters.kinds.length === 0 ? 'all' : null
  const chips = activeChips(filters, pkgNames).filter((c) => !(tabKind && tabKind !== 'all' && c.key.startsWith('kind:')))
  const nActive = activeFilterCount(filters) - (tabKind && tabKind !== 'all' ? 1 : 0)
  const assignments = s.assignments
  const counts = useMemo(() => {
    const c = { all: 0, image: 0, raw: 0, video: 0 }
    for (const m of media) {
      if (packageView && !assignments.get(m.id)?.has(packageView)) continue
      if (sourceId && !packageView && m.sourceId !== sourceId) continue
      c.all++
      c[m.kind]++
    }
    return c
  }, [media, packageView, assignments, sourceId])
  const TABS: Array<[MediaKind | 'all', string]> = [
    ['all', 'Alle'],
    ['image', 'Fotos'],
    ['raw', 'RAW'],
    ['video', 'Videos']
  ]
  const src = sourceId ? sources.find((x) => x.id === sourceId) : null
  const title = pkg ? pkg.name : src ? (src.path.split(/[\\/]/).filter(Boolean).pop() ?? src.path) : 'Medienübersicht'
  const total = pkg ? pkg.mediaCount : media.length

  return (
    <>
      <div className="toolbar">
        <div className="row" style={{ minWidth: 0, gap: 10 }}>
          {pkg && (
            <button className="icon-btn" aria-label="Zurück zur Medienübersicht" title="Zurück (Esc)" onClick={() => s.closePackageView()}>
              <ArrowLeft size={17} />
            </button>
          )}
          <div style={{ minWidth: 0 }}>
            <h1 className="ellipsis row" style={{ gap: 8 }}>
              {pkg && <span className="dot" style={{ background: pkg.color, width: 11, height: 11 }} />}
              {title}
            </h1>
            <div className="small muted" aria-live="polite">
              {visible.length.toLocaleString('de-DE')} von {total.toLocaleString('de-DE')} Medien · {selection.size.toLocaleString('de-DE')} ausgewählt
            </div>
          </div>
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
      <div className="tabs-row">
        <div className="tabs" role="tablist" aria-label="Medientyp">
          {TABS.map(([k, l]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tabKind === k}
              onClick={() => s.setFilters({ ...useStore.getState().filters, kinds: k === 'all' ? [] : [k] })}
            >
              {l} <span className="tab-count">{counts[k].toLocaleString('de-DE')}</span>
            </button>
          ))}
        </div>
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 }}>
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
              {(Object.keys(SORT_LABEL) as SortKey[])
                .filter((k) => k !== 'custom' || !!pkg)
                .map((k) => (
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
          {pkg && sort.key !== 'custom' && (
            <button className="btn" title="Aktuelle Sortierung als eigene Reihenfolge speichern" onClick={() => void s.adoptSortAsOrder()}>
              <ListOrdered size={15} /> Als Reihenfolge übernehmen
            </button>
          )}
          {pkg && (
            <button className="icon-btn" title="Auswahl aus Paket entfernen (Entf)" aria-label="Auswahl aus Paket entfernen" disabled={!selection.size} onClick={() => void s.removeSelectionFromPackage()}>
              <PackageMinus size={17} />
            </button>
          )}
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
