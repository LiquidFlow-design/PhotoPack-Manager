import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'

/** Globale Mediensuche (Kopfleiste). Strg+F setzt den Fokus. */
export function SearchBox() {
  const search = useStore((s) => s.filters.search)
  const [q, setQ] = useState(search)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => setQ(search), [search])
  const onSearch = (v: string) => {
    setQ(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => useStore.getState().setFilters({ ...useStore.getState().filters, search: v }), 160)
  }
  return (
    <div className="search header-search" role="search">
      <Search size={16} className="muted" />
      <input id="media-search" placeholder="Medien suchen …" aria-label="Medien nach Name oder Ordner suchen" value={q} onChange={(e) => onSearch(e.target.value)} />
      {q ? (
        <button className="icon-btn ghost sm" style={{ width: 22, height: 22 }} aria-label="Suche leeren" onClick={() => onSearch('')}>
          <X size={13} />
        </button>
      ) : (
        <span className="kbd" aria-hidden="true">
          Strg F
        </span>
      )}
    </div>
  )
}
