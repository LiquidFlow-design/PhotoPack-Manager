import { Cloud, FolderOpen } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CloudRootInfo } from '@shared/types'
import { api } from '../lib/api'

/**
 * Ordnerauswahl mit Schnellzugriff auf erkannte Cloud-Ordner (Proton Drive, OneDrive …).
 * Ohne erkannte Cloud-Ordner öffnet ein Klick direkt den Windows-Ordnerdialog.
 */
export function FolderMenu({ children, className, onPick, title }: { children: ReactNode; className: string; onPick: (cloudRootId?: string) => void; title?: string }) {
  const [roots, setRoots] = useState<CloudRootInfo[] | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void api.sources
      .cloudRoots()
      .then(setRoots)
      .catch(() => setRoots([]))
  }, [])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key, true)
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key, true)
    }
  }, [open])
  const pick = (id?: string) => {
    setOpen(false)
    onPick(id)
  }
  const hasCloud = !!roots && roots.length > 0
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={className} title={title} aria-haspopup={hasCloud ? 'menu' : undefined} aria-expanded={hasCloud ? open : undefined} onClick={() => (hasCloud ? setOpen(!open) : pick())}>
        {children}
      </button>
      {open && hasCloud && (
        <div className="menu" role="menu">
          <button role="menuitem" className="menu-item" onClick={() => pick()}>
            <FolderOpen size={15} /> Ordner wählen …
          </button>
          <div className="menu-sep" />
          {roots!.map((r) => (
            <button key={r.id} role="menuitem" className="menu-item" onClick={() => pick(r.id)} title={r.path}>
              <Cloud size={15} /> <span className="ellipsis">{r.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
