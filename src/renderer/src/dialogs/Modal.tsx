import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

/** Barrierearmer Dialog: Fokusfalle, Esc schließt, Fokus kehrt zurück. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  size,
  labelledBy
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'wide' | 'narrow'
  labelledBy?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const id = labelledBy ?? 'modal-title'
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    const first = el?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button.primary, button')
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea, [tabindex="0"]')]
        if (!f.length) return
        const a = f[0]
        const b = f[f.length - 1]
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault()
          b.focus()
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault()
          a.focus()
        }
      }
    }
    el?.addEventListener('keydown', onKey)
    return () => {
      el?.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={'modal glass' + (size ? ' ' + size : '')} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <div className="modal-head">
          <h2 id={id}>{title}</h2>
          <button className="icon-btn ghost sm" aria-label="Dialog schließen" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
