import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, FileWarning, FolderPlus, ImageOff, Star, Undo2, Video } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BROWSER_NATIVE_IMAGE } from '@shared/media-kinds'
import { activeFilterCount, COLOR_HEX } from '@shared/filters'
import type { MediaRow, PackageInfo } from '@shared/types'
import { thumbUrl } from '../lib/api'
import { fmtBytes, fmtDuration } from '../lib/format'
import { addSourceFlow } from '../lib/flows'
import { useStore } from '../state/store'

const GAP = 12
const META_H = 46

export function MediaGrid() {
  const visible = useStore((s) => s.visible)
  const selection = useStore((s) => s.selection)
  const active = useStore((s) => s.active)
  const assignments = useStore((s) => s.assignments)
  const exported = useStore((s) => s.exported)
  const packages = useStore((s) => s.packages)
  const thumbVersion = useStore((s) => s.thumbVersion)
  const thumbSize = useStore((s) => s.settings?.thumbSize ?? 170)
  const media = useStore((s) => s.media)
  const sources = useStore((s) => s.sources)
  const packageView = useStore((s) => s.packageView)
  const pkgSort = useStore((s) => s.pkgSort)
  const filters = useStore((s) => s.filters)
  const parentRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [drop, setDrop] = useState<{ id: number; after: boolean } | null>(null)
  const dragIds = useRef<number[] | null>(null)
  // Drag & Drop nur in der Paketansicht mit eigener Reihenfolge und ohne Filter (sonst wäre die Position mehrdeutig)
  const dnd = !!packageView && pkgSort.key === 'custom' && activeFilterCount(filters) === 0 && !filters.search

  useLayoutEffect(() => {
    const el = parentRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 24))
    ro.observe(el)
    setWidth(el.clientWidth - 24)
    return () => ro.disconnect()
  }, [])

  const cols = Math.max(1, Math.floor((width + GAP) / (thumbSize + GAP)))
  const tileW = (width - GAP * (cols - 1)) / cols
  const rowH = Math.round(tileW * 0.75) + META_H
  const rows = Math.ceil(visible.length / cols)
  useEffect(() => useStore.getState().setColumns(cols), [cols])

  const virt = useVirtualizer({
    count: rows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowH + GAP,
    overscan: 4
  })
  useEffect(() => virt.measure(), [rowH, virt])

  // Aktives Element nur bei Tastaturnavigation sichtbar scrollen (nicht bei Mausklick –
  // sonst verschiebt sich das Raster unter dem Mauszeiger und ein Doppelklick trifft eine andere Kachel)
  const scrollSeq = useStore((s) => s.scrollSeq)
  useEffect(() => {
    const s = useStore.getState()
    const idx = s.active != null ? s.visibleIndex.get(s.active) : undefined
    if (idx != null) virt.scrollToIndex(Math.floor(idx / cols), { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollSeq, cols])

  const pkgById = new Map(packages.map((p) => [p.id, p]))

  const tileFrom = (e: React.DragEvent) => (e.target as HTMLElement).closest<HTMLElement>('[data-mid]')
  const onDragStart = (e: React.DragEvent) => {
    const el = tileFrom(e)
    if (!dnd || !el) return
    const id = Number(el.dataset.mid)
    const st = useStore.getState()
    let ids: number[]
    if (st.selection.has(id)) ids = st.packageOrder.filter((x) => st.selection.has(x))
    else {
      st.select(id, 'single')
      ids = [id]
    }
    dragIds.current = ids
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-ppm-media', ids.join(','))
    if (ids.length > 1) {
      const badge = document.createElement('div')
      badge.textContent = `${ids.length} Medien`
      badge.className = 'drag-badge'
      document.body.appendChild(badge)
      e.dataTransfer.setDragImage(badge, 10, 10)
      setTimeout(() => badge.remove(), 0)
    }
  }
  const onDragOver = (e: React.DragEvent) => {
    if (!dnd || !dragIds.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const g = parentRef.current!
    const r = g.getBoundingClientRect()
    if (e.clientY < r.top + 60) g.scrollTop -= 18
    else if (e.clientY > r.bottom - 60) g.scrollTop += 18
    const el = tileFrom(e)
    if (el) {
      const b = el.getBoundingClientRect()
      const next = { id: Number(el.dataset.mid), after: e.clientX > b.left + b.width / 2 }
      if (!drop || drop.id !== next.id || drop.after !== next.after) setDrop(next)
    } else if (visible.length) {
      const last = visible[visible.length - 1].id
      if (!drop || drop.id !== last || !drop.after) setDrop({ id: last, after: true })
    }
  }
  const endDrag = () => {
    dragIds.current = null
    setDrop(null)
  }
  const onDrop = (e: React.DragEvent) => {
    if (!dnd || !dragIds.current || !drop) return endDrag()
    e.preventDefault()
    void useStore.getState().reorderInPackage(dragIds.current, drop.id, drop.after)
    endDrag()
  }

  if (media.length === 0) {
    return (
      <div className="gallery">
        <div className="empty">
          <ImageOff size={34} />
          <div>{sources.length ? 'In den Quellen wurden (noch) keine unterstützten Medien gefunden.' : 'Noch keine Quellordner hinzugefügt.'}</div>
          <button className="btn primary" onClick={() => void addSourceFlow()}>
            <FolderPlus size={16} /> Quellordner hinzufügen
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="gallery"
      ref={parentRef}
      tabIndex={0}
      role="listbox"
      aria-multiselectable="true"
      aria-label="Medienraster"
      aria-activedescendant={active != null ? `tile-${active}` : undefined}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={endDrag}
      onDragLeave={(e) => {
        if (!parentRef.current?.contains(e.relatedTarget as Node)) setDrop(null)
      }}
    >
      {visible.length === 0 ? (
        <div className="empty">Keine Medien entsprechen den gewählten Filtern.</div>
      ) : (
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((vr) => {
            const start = vr.index * cols
            const items = visible.slice(start, start + cols)
            return (
              <div key={vr.key} className="grid-row" style={{ top: vr.start, height: rowH, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                {items.map((m) => {
                  const assigned = assignments.get(m.id)
                  const pk: Array<{ p: PackageInfo; exported: boolean }> = []
                  if (assigned) for (const pid of assigned) {
                    const p = pkgById.get(pid)
                    if (p) pk.push({ p, exported: !!exported.get(m.id)?.has(pid) })
                  }
                  return (
                    <Tile
                      key={m.id}
                      m={m}
                      selected={selection.has(m.id)}
                      active={active === m.id}
                      pkgs={pk}
                      v={thumbVersion.get(m.id) ?? 0}
                      pos={packageView ? start + items.indexOf(m) + 1 : 0}
                      draggable={dnd}
                      dropSide={drop?.id === m.id ? (drop.after ? 'after' : 'before') : null}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const Tile = memo(function Tile({
  m,
  selected,
  active,
  pkgs,
  v,
  pos,
  draggable,
  dropSide
}: {
  m: MediaRow
  selected: boolean
  active: boolean
  pkgs: Array<{ p: PackageInfo; exported: boolean }>
  v: number
  pos: number
  draggable: boolean
  dropSide: 'before' | 'after' | null
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [v])
  const canNative = m.kind === 'image' && BROWSER_NATIVE_IMAGE.has(m.ext)
  const showImg = m.location !== 'missing' && !failed && (m.thumbStatus !== 'error' || canNative)
  const kindTag = m.kind === 'raw' ? 'RAW' : m.kind === 'video' ? 'VIDEO' : m.ext.toUpperCase()
  const onClick = (e: React.MouseEvent) => {
    const s = useStore.getState()
    s.select(m.id, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'single')
  }
  const status = m.location === 'missing' ? 'Quelle fehlt' : m.location === 'recovery' ? 'verschoben' : null
  return (
    <div
      id={`tile-${m.id}`}
      role="option"
      aria-selected={selected}
      className={'tile' + (selected ? ' selected' : '') + (active ? ' active' : '') + (dropSide ? ' drop-' + dropSide : '')}
      data-mid={m.id}
      draggable={draggable}
      onClick={onClick}
      onDoubleClick={() => {
        useStore.getState().select(m.id, 'single')
        useStore.getState().setView('focus')
      }}
    >
      <div className="thumb">
        {showImg ? (
          <img src={thumbUrl(m.id, v)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
        ) : (
          <div className="placeholder">
            {m.location === 'missing' ? <FileWarning size={26} /> : m.kind === 'video' ? <Video size={26} /> : <ImageOff size={26} />}
            <span>{m.location === 'missing' ? 'Quelle fehlt' : m.thumbStatus === 'error' ? 'Keine Vorschau' : m.thumbStatus === 'none' ? 'Vorschau wird erstellt …' : 'Keine Vorschau'}</span>
          </div>
        )}
        <span className="tag">
          {kindTag}
          {m.pairId ? (m.kind === 'raw' ? '+JPG' : '+RAW') : ''}
          {m.sidecars ? ' · XMP' : ''}
        </span>
        {m.kind === 'video' && m.durationMs != null && <span className="tag br">{fmtDuration(m.durationMs)}</span>}
        {pos > 0 && m.location !== 'recovery' && m.location !== 'missing' && <span className="tag bl">{pos}</span>}
        {m.location === 'recovery' && (
          <span className="tag bl" title="Verschoben – Original liegt im Wiederherstellungsbereich">
            <Undo2 size={10} /> verschoben
          </span>
        )}
        {m.location === 'missing' && <span className="tag bl err">fehlt</span>}
        {m.thumbStatus === 'error' && m.location !== 'missing' && !showImg && (
          <span className="tag bl warn" title={m.thumbError ?? 'Vorschau fehlgeschlagen'} style={m.location === 'recovery' ? { bottom: 28 } : undefined}>
            !
          </span>
        )}
        {m.dupGroup && (
          <span className="tag" style={{ top: 30 }} title="Exaktes Duplikat vorhanden">
            DUP
          </span>
        )}
        {selected && (
          <span className="tick" aria-hidden="true">
            <Check size={13} strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="tile-meta" style={m.colorLabel ? { boxShadow: `inset 3px 0 0 ${COLOR_HEX[m.colorLabel]}` } : undefined}>
        <div className="tile-name ellipsis" title={m.relDir ? `${m.relDir}/${m.name}` : m.name}>
          {m.name}
        </div>
        <span className="sr-only">
          {m.rating ? `, ${m.rating} Sterne` : ''}
          {pkgs.length ? `, Pakete: ${pkgs.map((x) => x.p.name).join(', ')}` : ''}
        </span>
        <div className="tile-info">
          <span>{fmtBytes(m.size)}</span>
          {m.rating > 0 && (
            <span className="rating" aria-hidden="true">
              <Star size={10} fill="currentColor" /> {m.rating}
            </span>
          )}
          <span className="pkg-pills" aria-hidden="true">
            {pkgs.slice(0, 2).map(({ p, exported }) => (
              <span key={p.id} className={'pkg-pill' + (exported ? '' : ' pending')} style={{ ['--pkg' as string]: p.color }} title={`${p.name}${exported ? ' (exportiert)' : ' (ausstehend)'}`}>
                {p.name.length > 10 ? p.name.slice(0, 9) + '…' : p.name}
              </span>
            ))}
            {pkgs.length > 2 && (
              <span className="pkg-pill" style={{ ['--pkg' as string]: '#8b7bff' }} title={pkgs.slice(2).map((x) => x.p.name).join(', ')}>
                +{pkgs.length - 2}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  )
})
