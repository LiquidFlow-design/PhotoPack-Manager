import { ChevronLeft, ChevronRight, Cloud, FileWarning, FolderSearch, Minus, Plus, Scan, Star, Video } from 'lucide-react'
import { COLOR_HEX, COLOR_LABEL } from '@shared/filters'
import type { ColorLabel } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import type { MediaDetail } from '@shared/types'
import { api, mediaUrl, previewUrl } from '../lib/api'
import { fmtBytes, fmtDate, fmtDuration } from '../lib/format'
import { useStore } from '../state/store'
import { PackageButton } from './RightSidebar'

/** Einzelansicht: Bilder mit Zoom/Pan, Videos mit Player. Paketzuordnung bleibt erreichbar. */
export function FocusView() {
  const active = useStore((s) => s.active)
  const m = useStore((s) => (s.active != null ? s.mediaById.get(s.active) : undefined))
  const visible = useStore((s) => s.visible)
  const visibleIndex = useStore((s) => s.visibleIndex)
  const packages = useStore((s) => s.packages)
  const v = useStore((s) => (s.active != null ? (s.thumbVersion.get(s.active) ?? 0) : 0))
  const [detail, setDetail] = useState<MediaDetail | null>(null)
  const [cloudLoad, setCloudLoad] = useState<number | null>(null)
  const provider = useStore((s) => (m?.sourceId ? s.sources.find((x) => x.id === m.sourceId)?.cloudProvider : null))
  const idx = active != null ? (visibleIndex.get(active) ?? -1) : -1

  useEffect(() => {
    let off = false
    setDetail(null)
    if (active != null) void api.media.detail(active).then((d) => !off && setDetail(d))
    return () => {
      off = true
    }
  }, [active, v])

  if (!m) {
    return (
      <div className="focus">
        <div className="empty">Kein Medium ausgewählt.</div>
      </div>
    )
  }

  const nav = (d: number) => useStore.getState().navigate(d)

  return (
    <div className="focus">
      <div className="stage-wrap" style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
        {m.location === 'missing' ? (
          <div className="stage">
            <div className="empty">
              <FileWarning size={34} /> Die Quelldatei ist nicht mehr vorhanden.
            </div>
          </div>
        ) : m.cloudOnline && cloudLoad !== m.id ? (
          <div className="stage" style={{ cursor: 'default' }}>
            <div className="empty">
              <Cloud size={34} />
              <div>Diese Datei liegt nur online{provider ? ` in ${provider}` : ''}.</div>
              <button className="btn primary" onClick={() => setCloudLoad(m.id)}>
                Laden und anzeigen
              </button>
            </div>
          </div>
        ) : m.kind === 'video' ? (
          <VideoStage key={m.id} id={m.id} load={m.cloudOnline} />
        ) : (
          <ImageStage key={m.id} id={m.id} v={v} load={m.cloudOnline} />
        )}
        <button className="icon-btn stage-nav left glass" aria-label="Vorheriges Medium" disabled={idx <= 0} onClick={() => nav(-1)}>
          <ChevronLeft size={18} />
        </button>
        <button className="icon-btn stage-nav right glass" aria-label="Nächstes Medium" disabled={idx >= visible.length - 1} onClick={() => nav(1)}>
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="focus-bar">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <strong className="ellipsis">{m.name}</strong>
            <span className="status-pill muted">{m.kind === 'raw' ? 'RAW' : m.kind === 'video' ? 'Video' : m.ext.toUpperCase()}</span>
            {m.location === 'recovery' && <span className="status-pill info">verschoben</span>}
          </div>
          <div className="tiny muted ellipsis">
            {idx + 1} / {visible.length} · {fmtBytes(m.size)}
            {m.width ? ` · ${m.width}×${m.height}` : ''}
            {m.durationMs ? ` · ${fmtDuration(m.durationMs)}` : ''}
            {detail?.codec ? ` · ${detail.codec}` : ''} · {fmtDate(m.capturedAt ?? m.mtimeMs)}
            {m.relDir ? ` · ${m.relDir}` : ''}
          </div>
          {detail && detail.destinations.length > 0 && (
            <div className="tiny muted ellipsis" title={detail.destinations.map((d) => d.path).join('\n')}>
              Exportiert nach: {detail.destinations.map((d) => d.packageName).join(', ')}
            </div>
          )}
        </div>
        <div className="row">
          <div className="row" style={{ gap: 0 }} role="group" aria-label="Bewertung (Alt+0–5)">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={'star-btn' + (m.rating >= n ? ' on' : '')}
                aria-label={`${n} Sterne`}
                title={`${n} Sterne (Alt+${n})`}
                onClick={() => void useStore.getState().setRating(m.rating === n ? 0 : n)}
              >
                <Star size={16} fill={m.rating >= n ? 'currentColor' : 'none'} />
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 4 }} role="group" aria-label="Farbmarkierung (Alt+6–9)">
            {(Object.keys(COLOR_LABEL) as ColorLabel[]).map((c) => (
              <button
                key={c}
                className="color-btn"
                style={{ background: COLOR_HEX[c] }}
                aria-pressed={m.colorLabel === c}
                aria-label={COLOR_LABEL[c]}
                title={COLOR_LABEL[c]}
                onClick={() => void useStore.getState().toggleColor(c)}
              />
            ))}
          </div>
          <button className="btn sm" onClick={() => void api.media.reveal(m.id)} title="Im Explorer anzeigen">
            <FolderSearch size={14} /> Im Explorer
          </button>
        </div>
      </div>
      <div className="focus-pkgs" role="group" aria-label="Pakete für dieses Medium">
        {packages.map((p) => (
          <div key={p.id} style={{ minWidth: 130, maxWidth: 200, flex: '0 0 auto' }}>
            <PackageButton p={p} compact />
          </div>
        ))}
      </div>
    </div>
  )
}

function ImageStage({ id, v, load = false }: { id: number; v: number; load?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [box, setBox] = useState({ w: 800, h: 600 })
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [err, setErr] = useState(false)
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fit = nat ? Math.min(box.w / nat.w, box.h / nat.h, 1) : 1
  const scale = zoom === 'fit' ? fit : zoom
  const setScale = (s: number) => {
    const z = Math.max(Math.min(fit, 0.05), Math.min(8, s))
    if (Math.abs(z - fit) < 0.001) {
      setZoom('fit')
      setPan({ x: 0, y: 0 })
    } else setZoom(z)
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setScale(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || useStore.getState().dialog) return
      if (e.key === '+' || e.key === '=') setScale(scale * 1.25)
      else if (e.key === '-') setScale(scale / 1.25)
      else if (e.key === '0' && !e.ctrlKey) {
        setZoom('fit')
        setPan({ x: 0, y: 0 })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (err)
    return (
      <div className="stage" ref={ref}>
        <div className="empty">
          <FileWarning size={34} />
          <div>Keine Vorschau möglich (Format oder Datei beschädigt). Export bleibt möglich.</div>
        </div>
      </div>
    )

  return (
    <div
      className={'stage' + (dragging ? ' dragging' : '')}
      ref={ref}
      onPointerDown={(e) => {
        if (zoom === 'fit' || (e.target as HTMLElement).closest('button')) return
        drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
        setDragging(true)
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        setPan({ x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y })
      }}
      onPointerUp={() => {
        drag.current = null
        setDragging(false)
      }}
      onDoubleClick={() => {
        if (zoom === 'fit') setZoom(1)
        else {
          setZoom('fit')
          setPan({ x: 0, y: 0 })
        }
      }}
    >
      {!nat && <div className="spinner" />}
      <img
        ref={imgRef}
        className="zoomable"
        src={previewUrl(id, v, load)}
        alt=""
        draggable={false}
        onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        onError={() => setErr(true)}
        style={{
          width: nat ? nat.w : undefined,
          height: nat ? nat.h : undefined,
          visibility: nat ? 'visible' : 'hidden',
          transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${scale})`
        }}
      />
      <div className="zoom-ctl glass">
        <button className="icon-btn ghost sm" aria-label="Verkleinern" onClick={() => setScale(scale / 1.25)}>
          <Minus size={14} />
        </button>
        <span style={{ minWidth: 42, textAlign: 'center' }}>{Math.round(scale * 100)} %</span>
        <button className="icon-btn ghost sm" aria-label="Vergrößern" onClick={() => setScale(scale * 1.25)}>
          <Plus size={14} />
        </button>
        <button
          className="icon-btn ghost sm"
          aria-label="Einpassen"
          title="Einpassen (0)"
          onClick={() => {
            setZoom('fit')
            setPan({ x: 0, y: 0 })
          }}
        >
          <Scan size={14} />
        </button>
      </div>
    </div>
  )
}

function VideoStage({ id, load = false }: { id: number; load?: boolean }) {
  const [err, setErr] = useState(false)
  if (err)
    return (
      <div className="stage" style={{ cursor: 'default' }}>
        <img src={previewUrl(id)} alt="" style={{ maxWidth: '100%', maxHeight: '100%', opacity: 0.5 }} onError={(e) => (e.currentTarget.style.display = 'none')} />
        <div className="empty" style={{ position: 'absolute' }}>
          <Video size={34} />
          <div>Dieses Video kann hier nicht abgespielt werden (Codec nicht unterstützt). Zuordnung und Export sind trotzdem möglich.</div>
        </div>
      </div>
    )
  return (
    <div className="stage" style={{ cursor: 'default' }}>
      {/* Kein Autoplay; Steuerelemente: Wiedergabe, Zeitleiste, Lautstärke */}
      <video src={mediaUrl(id, load)} controls preload="metadata" onError={() => setErr(true)} />
    </div>
  )
}
