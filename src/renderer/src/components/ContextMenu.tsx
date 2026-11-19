import { Check, Eye, FolderSearch, Maximize2, Minus, PackageMinus, Presentation, Star, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { triState } from '@shared/assignment'
import { COLOR_HEX, COLOR_LABEL } from '@shared/filters'
import type { ColorLabel } from '@shared/types'
import { api } from '../lib/api'
import { useStore } from '../state/store'

export interface MenuAnchor {
  x: number
  y: number
}

/** Kontextmenü für die aktuelle Auswahl (Rechtsklick, Menütaste, Umschalt+F10). */
export function ContextMenu({ at, onClose }: { at: MenuAnchor; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  const selection = useStore((s) => s.selection)
  const packages = useStore((s) => s.packages)
  const assignments = useStore((s) => s.assignments)
  const packageView = useStore((s) => s.packageView)
  const active = useStore((s) => s.active)
  const mediaById = useStore((s) => s.mediaById)
  const ids = useMemo(() => [...selection], [selection])
  const single = ids.length === 1 ? mediaById.get(ids[0]) : undefined
  const s = useStore.getState()

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) })
    el.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
  }, [at])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
      const i = items.indexOf(document.activeElement as HTMLElement)
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        const n = items.length
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]?.focus()
      } else if (e.key === 'Tab') onClose()
      else e.stopPropagation() // Paketkürzel etc. nicht im Menü auslösen
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const run = (fn: () => void | Promise<void>) => () => {
    onClose()
    void fn()
  }

  return createPortal(
    <div className="menu fixed context-menu" role="menu" aria-label="Aktionen für die Auswahl" ref={ref} style={{ left: pos.x, top: pos.y }}>
      <div className="menu-label">{ids.length === 1 ? (single?.name ?? '1 Medium') : `${ids.length} Medien`}</div>
      <button role="menuitem" className="menu-item" onClick={run(() => s.setView('focus'))}>
        <Maximize2 size={15} /> Fokusansicht öffnen <span className="kbd">Enter</span>
      </button>
      {single && (
        <button role="menuitem" className="menu-item" onClick={run(() => api.media.reveal(single.id))}>
          <FolderSearch size={15} /> Im Explorer anzeigen
        </button>
      )}
      <button role="menuitem" className="menu-item" onClick={run(() => s.togglePresenter())}>
        <Presentation size={15} /> Präsentationsfenster
      </button>
      {packages.length > 0 && (
        <>
          <div className="menu-sep" />
          <div className="menu-label">Pakete</div>
          {packages.map((p) => {
            const t = triState(assignments, ids, p.id)
            return (
              <button
                key={p.id}
                role="menuitemcheckbox"
                aria-checked={t.state === 'all' ? 'true' : t.state === 'partial' ? 'mixed' : 'false'}
                className="menu-item"
                onClick={run(() => s.togglePackage(p.id))}
              >
                <span className="menu-check" style={{ ['--pkg' as string]: p.color }}>
                  {t.state === 'all' ? <Check size={12} strokeWidth={3} /> : t.state === 'partial' ? <Minus size={12} strokeWidth={3} /> : null}
                </span>
                <span className="dot" style={{ background: p.color }} />
                <span className="ellipsis">{p.name}</span>
                {p.shortcut != null && <span className="kbd">{p.shortcut}</span>}
              </button>
            )
          })}
          {packageView && (
            <button role="menuitem" className="menu-item danger" onClick={run(() => s.removeSelectionFromPackage())}>
              <PackageMinus size={15} /> Aus diesem Paket entfernen <span className="kbd">Entf</span>
            </button>
          )}
          {!packageView && active != null && ids.length === 1 && (
            <PackageViewItems mediaId={active} onClose={onClose} />
          )}
        </>
      )}
      <div className="menu-sep" />
      <div className="menu-label">Bewertung</div>
      <div className="menu-row" role="group" aria-label="Bewertung">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} role="menuitem" className={'star-btn' + ((single?.rating ?? 0) >= n ? ' on' : '')} aria-label={`${n} Sterne`} onClick={run(() => s.setRating(n))}>
            <Star size={16} fill={(single?.rating ?? 0) >= n ? 'currentColor' : 'none'} />
          </button>
        ))}
        <button role="menuitem" className="star-btn" aria-label="Bewertung entfernen" title="Keine (Alt+0)" onClick={run(() => s.setRating(0))}>
          <X size={15} />
        </button>
      </div>
      <div className="menu-row" role="group" aria-label="Farbmarkierung">
        {(Object.keys(COLOR_LABEL) as ColorLabel[]).map((c) => (
          <button
            key={c}
            role="menuitem"
            className="color-btn"
            style={{ background: COLOR_HEX[c] }}
            aria-label={COLOR_LABEL[c]}
            aria-pressed={single?.colorLabel === c}
            onClick={run(() => s.toggleColor(c))}
          />
        ))}
      </div>
      <div className="menu-sep" />
      <button role="menuitem" className="menu-item" onClick={run(() => s.clearSelection())}>
        <X size={15} /> Auswahl aufheben
      </button>
    </div>,
    document.body
  )
}

/** „In Paketansicht öffnen“ für die Pakete, denen das Medium angehört. */
function PackageViewItems({ mediaId, onClose }: { mediaId: number; onClose: () => void }) {
  const packages = useStore((s) => s.packages)
  const assigned = useStore((s) => s.assignments.get(mediaId))
  const own = packages.filter((p) => assigned?.has(p.id))
  if (!own.length) return null
  return (
    <>
      {own.map((p) => (
        <button
          key={p.id}
          role="menuitem"
          className="menu-item"
          onClick={() => {
            onClose()
            void useStore.getState().openPackageView(p.id)
          }}
        >
          <Eye size={15} /> In Paket „{p.name}“ ansehen
        </button>
      ))}
    </>
  )
}
