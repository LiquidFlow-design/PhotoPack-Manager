import { AlertTriangle, Copy, FolderOpen, FolderPlus, History, Images, LifeBuoy, PanelLeftClose, PanelLeftOpen, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../state/store'
import { addSourceFlow } from '../lib/flows'

export function LeftSidebar({ collapsed, auto }: { collapsed: boolean; auto: boolean }) {
  const s = useStore()
  const { project, sources, media, sourceId, settings } = s
  const width = settings!.layout.leftWidth
  const setCollapsed = (v: boolean) => void s.updateSettings({ layout: { ...settings!.layout, leftCollapsed: v } })

  if (collapsed) {
    return (
      <aside className="sidebar glass collapsed" aria-label="Quellen (eingeklappt)">
        <div className="collapsed-rail">
          <button className="icon-btn ghost" title={auto ? 'Fenster zu schmal – automatisch eingeklappt' : 'Seitenleiste ausklappen'} aria-label="Linke Seitenleiste ausklappen" onClick={() => setCollapsed(false)} disabled={auto}>
            <PanelLeftOpen size={17} />
          </button>
          <button className="icon-btn ghost" title="Alle Medien" aria-label="Alle Medien" onClick={() => s.setSourceFilter(null)}>
            <Images size={17} />
          </button>
          <button className="icon-btn ghost" title="Quelle hinzufügen" aria-label="Quelle hinzufügen" onClick={() => void addSourceFlow()}>
            <FolderPlus size={17} />
          </button>
          <button className="icon-btn ghost" title="Wiederherstellung" aria-label="Wiederherstellung" onClick={() => s.openDialog({ type: 'recovery' })}>
            <LifeBuoy size={17} />
          </button>
          <button className="icon-btn ghost" title="Auftragsverlauf" aria-label="Auftragsverlauf" onClick={() => s.openDialog({ type: 'jobs' })}>
            <History size={17} />
          </button>
        </div>
      </aside>
    )
  }

  const counts = new Map<string, number>()
  for (const m of media) if (m.sourceId) counts.set(m.sourceId, (counts.get(m.sourceId) ?? 0) + 1)

  return (
    <aside className="sidebar glass" style={{ width }} aria-label="Quellen und Navigation">
      <div className="sidebar-scroll">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="h-section">Medienquellen</div>
          <button className="icon-btn ghost sm" title="Seitenleiste einklappen" aria-label="Linke Seitenleiste einklappen" onClick={() => setCollapsed(true)}>
            <PanelLeftClose size={15} />
          </button>
        </div>
        <button className={'nav-item' + (sourceId === null ? ' active' : '')} onClick={() => s.setSourceFilter(null)} aria-pressed={sourceId === null}>
          <Images size={16} /> Alle Medien <span className="count">{media.length.toLocaleString('de-DE')}</span>
        </button>
        {sources.map((src) => {
          const name = src.path.split(/[\\/]/).filter(Boolean).pop() ?? src.path
          const scanning = src.scanStatus === 'scanning'
          return (
            <div key={src.id} className={'nav-item source-item' + (sourceId === src.id ? ' active' : '')} title={src.path}>
              <button
                className="row"
                style={{ border: 0, background: 'transparent', padding: 0, flex: 1, minWidth: 0, color: 'inherit', textAlign: 'left' }}
                onClick={() => s.setSourceFilter(src.id)}
                aria-pressed={sourceId === src.id}
              >
                {src.scanStatus === 'unavailable' || src.scanStatus === 'error' ? <AlertTriangle size={16} className="warn" /> : scanning ? <div className="spinner" /> : <FolderOpen size={16} />}
                <span className="ellipsis">{name}</span>
              </button>
              <span className="count">{(counts.get(src.id) ?? 0).toLocaleString('de-DE')}</span>
              <span className="actions">
                <button className="icon-btn ghost sm" title="Erneut indexieren" aria-label={`${name} erneut indexieren`} onClick={() => void api.sources.rescan(project!.id, src.id)} disabled={scanning}>
                  <RefreshCw size={13} />
                </button>
                <button
                  className="icon-btn ghost sm"
                  title="Quelle entfernen"
                  aria-label={`${name} entfernen`}
                  onClick={() =>
                    s.openDialog({
                      type: 'confirm',
                      title: 'Quelle entfernen',
                      message: `„${src.path}“ aus dem Projekt entfernen? Dateien auf dem Datenträger bleiben unverändert. Zuordnungen der Medien dieser Quelle gehen verloren; bereits verschobene Medien bleiben im Projekt.`,
                      confirmLabel: 'Entfernen',
                      danger: true,
                      onConfirm: async () => {
                        const r = await api.sources.remove(src.id)
                        if (sourceId === src.id) s.setSourceFilter(null)
                        s.toast('info', `Quelle entfernt (${r.removedMedia} Medien aus dem Projekt entfernt, ${r.keptMoved} verschobene behalten).`)
                      }
                    })
                  }
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          )
        })}
        {sources.some((x) => x.scanStatus === 'unavailable') && <p className="hint warn">Mindestens eine Quelle ist nicht erreichbar (Laufwerk getrennt?).</p>}
        <button className="add-btn" style={{ marginTop: 8 }} onClick={() => void addSourceFlow()}>
          <FolderPlus size={16} /> Quellordner hinzufügen
        </button>
        <div className="divider" />
        <div className="h-section">Projekt</div>
        <button className="nav-item" onClick={() => s.openDialog({ type: 'sources' })}>
          <FolderOpen size={16} /> Quellen verwalten
        </button>
        <button className="nav-item" onClick={() => s.openDialog({ type: 'recovery' })}>
          <LifeBuoy size={16} /> Wiederherstellung
        </button>
        <button className="nav-item" onClick={() => s.openDialog({ type: 'jobs' })}>
          <History size={16} /> Auftragsverlauf
        </button>
        <button className="nav-item" onClick={() => s.openDialog({ type: 'duplicates' })}>
          <Copy size={16} /> Duplikate & Ähnliche
        </button>
      </div>
    </aside>
  )
}
