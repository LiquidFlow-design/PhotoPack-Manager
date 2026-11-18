import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { activeFilterCount, COLOR_HEX, COLOR_LABEL, resetFilters } from '@shared/filters'
import type { AssignmentFilter, ColorLabel, DuplicateFilter, ExportFilter, FilterState, MediaKind } from '@shared/types'
import { useStore } from '../state/store'

const KINDS: Array<[MediaKind, string]> = [
  ['image', 'Bild'],
  ['raw', 'RAW'],
  ['video', 'Video']
]
const ASSIGN: Array<[AssignmentFilter, string]> = [
  ['all', 'Alle'],
  ['none', 'Ohne Paket'],
  ['any', 'Mit Paket'],
  ['partial', 'Teilweise']
]

/** Zugängliches Filter-Popover: öffnet über das Filter-Icon, schließt mit Esc/Klick außerhalb. */
export function FilterPopover() {
  const s = useStore()
  const { filters: f, packages, media } = s
  const ref = useRef<HTMLDivElement>(null)
  // Feste Positionierung am Filter-Icon (Popover darf nicht vom Inhaltsbereich abgeschnitten werden)
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number }>({ top: 0, left: 0, maxH: 600 })
  useLayoutEffect(() => {
    const place = () => {
      const b = document.getElementById('filter-button')?.getBoundingClientRect()
      if (!b) return
      const w = 320
      const left = Math.max(12, Math.min(window.innerWidth - w - 12, b.right - w))
      const top = b.bottom + 8
      setPos({ top, left, maxH: Math.max(240, window.innerHeight - top - 16) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [])
  const set = (patch: Partial<FilterState>) => s.setFilters({ ...useStore.getState().filters, ...patch })
  const formats = useMemo(() => {
    const m = new Map<string, number>()
    for (const x of media) m.set(x.ext, (m.get(x.ext) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [media])
  const toggle = <T,>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, input, select')?.focus()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || document.getElementById('filter-button')?.contains(t)) return
      s.setFilterOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        s.setFilterOpen(false)
        document.getElementById('filter-button')?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    ref.current?.addEventListener('keydown', onKey)
    const el = ref.current
    return () => {
      document.removeEventListener('mousedown', onDown)
      el?.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createPortal(
    <div
      className="popover glass"
      id="filter-popover"
      role="dialog"
      aria-label="Medien filtern"
      ref={ref}
      style={{ position: 'fixed', top: pos.top, left: pos.left, right: 'auto', maxHeight: pos.maxH }}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>Medien filtern</h3>
        <button className="icon-btn ghost sm" aria-label="Filter schließen" onClick={() => s.setFilterOpen(false)}>
          <X size={15} />
        </button>
      </div>

      <fieldset className="pop-section" style={{ border: 0, padding: 0, margin: '12px 0 0' }}>
        <legend className="field-label">Medientyp</legend>
        <div className="toggle-chips" style={{ marginTop: 6 }}>
          {KINDS.map(([k, l]) => (
            <button key={k} className="toggle-chip" aria-pressed={f.kinds.includes(k)} onClick={() => set({ kinds: toggle(f.kinds, k) })}>
              {l}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="pop-section" style={{ border: 0, padding: 0 }}>
        <legend className="field-label">Paketzuordnung</legend>
        <div className="segmented" role="radiogroup" aria-label="Paketzuordnung" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          {ASSIGN.map(([k, l]) => (
            <button key={k} role="radio" aria-checked={f.assignment === k} onClick={() => set({ assignment: k })}>
              {l}
            </button>
          ))}
        </div>
        <p className="hint" style={{ margin: '5px 0 0' }}>
          {f.assignment === 'partial'
            ? f.packageIds.length
              ? 'In einigen, aber nicht allen gewählten Paketen.'
              : 'In mindestens einem, aber nicht allen Paketen.'
            : f.assignment === 'none' && f.packageIds.length
              ? 'In keinem der gewählten Pakete.'
              : ' '}
        </p>
      </fieldset>

      {packages.length > 0 && (
        <fieldset className="pop-section" style={{ border: 0, padding: 0 }}>
          <legend className="field-label">Pakete</legend>
          <div className="toggle-chips" style={{ marginTop: 6 }}>
            {packages.map((p) => (
              <button key={p.id} className="toggle-chip" aria-pressed={f.packageIds.includes(p.id)} onClick={() => set({ packageIds: toggle(f.packageIds, p.id) })}>
                <span className="dot" style={{ background: p.color }} /> {p.name}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <div className="pop-section">
        <label className="field-label" htmlFor="f-export">
          Exportstatus
        </label>
        <select id="f-export" className="select" style={{ marginTop: 5 }} value={f.exportState} onChange={(e) => set({ exportState: e.target.value as ExportFilter })}>
          <option value="all">Alle</option>
          <option value="pending">Export ausstehend</option>
          <option value="exported">Vollständig exportiert</option>
        </select>
      </div>

      <div className="pop-section">
        <label className="field-label" htmlFor="f-dup">
          Duplikatstatus
        </label>
        <select id="f-dup" className="select" style={{ marginTop: 5 }} value={f.duplicates} onChange={(e) => set({ duplicates: e.target.value as DuplicateFilter })}>
          <option value="all">Alle</option>
          <option value="only">Nur exakte Duplikate</option>
          <option value="similar">Nur ähnliche Bilder</option>
          <option value="none">Ohne Duplikate</option>
        </select>
      </div>

      <fieldset className="pop-section" style={{ border: 0, padding: 0 }}>
        <legend className="field-label">Bewertung</legend>
        <div className="toggle-chips" style={{ marginTop: 6 }}>
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <button key={n} className="toggle-chip" aria-pressed={f.minRating === n} onClick={() => set({ minRating: n })} aria-label={n ? `Mindestens ${n} Sterne` : 'Alle Bewertungen'}>
              {n ? `≥ ${'★'.repeat(n)}` : 'Alle'}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="pop-section" style={{ border: 0, padding: 0 }}>
        <legend className="field-label">Farbmarkierung</legend>
        <div className="toggle-chips" style={{ marginTop: 6 }}>
          {(Object.keys(COLOR_LABEL) as ColorLabel[]).map((c) => (
            <button key={c} className="toggle-chip" aria-pressed={f.colorLabels.includes(c)} onClick={() => set({ colorLabels: toggle(f.colorLabels, c) })}>
              <span className="dot" style={{ background: COLOR_HEX[c] }} /> {COLOR_LABEL[c]}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="pop-section">
        <label className="field-label" htmlFor="f-loc">
          Speicherort
        </label>
        <select id="f-loc" className="select" style={{ marginTop: 5 }} value={f.location} onChange={(e) => set({ location: e.target.value as FilterState['location'] })}>
          <option value="all">Alle</option>
          <option value="moved">Verschoben (im Wiederherstellungsbereich)</option>
          <option value="missing">Quelle fehlt</option>
        </select>
      </div>

      {formats.length > 0 && (
        <fieldset className="pop-section" style={{ border: 0, padding: 0 }}>
          <legend className="field-label">Dateiformat</legend>
          <div className="toggle-chips" style={{ marginTop: 6 }}>
            {formats.map(([e, n]) => (
              <button key={e} className="toggle-chip" aria-pressed={f.formats.includes(e)} onClick={() => set({ formats: toggle(f.formats, e) })}>
                {e.toUpperCase() || '—'} <span className="faint tiny">{n}</span>
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <div className="pop-section">
        <span className="field-label">Aufnahmedatum (ersatzweise Änderungsdatum)</span>
        <div className="row" style={{ marginTop: 5 }}>
          <input className="input" style={{ minWidth: 0, flex: 1 }} type="date" aria-label="Datum von" value={f.dateFrom ?? ''} onChange={(e) => set({ dateFrom: e.target.value || null })} />
          <span className="muted">–</span>
          <input className="input" style={{ minWidth: 0, flex: 1 }} type="date" aria-label="Datum bis" value={f.dateTo ?? ''} onChange={(e) => set({ dateTo: e.target.value || null })} />
        </div>
      </div>

      <button className="btn block" style={{ marginTop: 14 }} disabled={activeFilterCount(f) === 0} onClick={() => s.setFilters(resetFilters(f))}>
        Filter zurücksetzen
      </button>
    </div>
  ,
    document.body
  )
}
