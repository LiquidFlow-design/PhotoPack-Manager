import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useStore } from '../state/store'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'toast ' + t.level}>
          {t.level === 'error' ? (
            <XCircle size={16} className="err" />
          ) : t.level === 'warn' ? (
            <AlertTriangle size={16} className="warn" />
          ) : t.level === 'success' ? (
            <CheckCircle2 size={16} className="ok" />
          ) : (
            <Info size={16} className="muted" />
          )}
          <span>{t.text}</span>
          {t.action && (
            <button
              className="btn sm"
              onClick={() => {
                t.action!.run()
                dismiss(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn ghost sm" aria-label="Hinweis schließen" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
