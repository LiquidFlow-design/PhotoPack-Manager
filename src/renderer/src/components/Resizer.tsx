import { useRef, useState } from 'react'
import { useStore } from '../state/store'

const LIMITS = { left: [180, 400], right: [240, 500] } as const

/** Verstellbare Trennlinie; Breiten werden persistent in den App-Einstellungen gespeichert. */
export function Resizer({ side, disabled }: { side: 'left' | 'right'; disabled?: boolean }) {
  const layout = useStore((s) => s.settings!.layout)
  const [drag, setDrag] = useState(false)
  const start = useRef<{ x: number; w: number } | null>(null)
  const key = side === 'left' ? 'leftWidth' : 'rightWidth'
  const [min, max] = LIMITS[side]

  const setWidth = (w: number, persist: boolean) => {
    const width = Math.round(Math.max(min, Math.min(max, w)))
    const next = { ...layout, [key]: width }
    useStore.setState((s) => ({ settings: { ...s.settings!, layout: next } }))
    if (persist) void useStore.getState().updateSettings({ layout: next })
  }

  if (disabled) return <div className="resizer disabled" aria-hidden="true" />
  return (
    <div
      className={'resizer' + (drag ? ' dragging' : '')}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? 'Breite der linken Seitenleiste' : 'Breite der rechten Seitenleiste'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={layout[key]}
      tabIndex={0}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, w: layout[key] }
        setDrag(true)
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        const dx = e.clientX - start.current.x
        setWidth(start.current.w + (side === 'left' ? dx : -dx), false)
      }}
      onPointerUp={() => {
        if (!start.current) return
        start.current = null
        setDrag(false)
        setWidth(useStore.getState().settings!.layout[key], true)
      }}
      onDoubleClick={() => setWidth(side === 'left' ? 240 : 300, true)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          e.stopPropagation()
          const d = (e.key === 'ArrowRight' ? 16 : -16) * (side === 'left' ? 1 : -1)
          setWidth(layout[key] + d, true)
        }
      }}
    />
  )
}
