import { AlertTriangle, FolderPlus, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { addSourceFlow } from '../lib/flows'
import { fmtDate } from '../lib/format'
import { useStore } from '../state/store'
import { Modal } from './Modal'

export function SourcesDialog() {
  const close = useStore((s) => s.closeDialog)
  const sources = useStore((s) => s.sources)
  const project = useStore((s) => s.project)!
  return (
    <Modal
      title="Quellordner verwalten"
      size="wide"
      onClose={close}
      footer={
        <>
          <button className="btn" style={{ marginRight: 'auto' }} onClick={() => void api.sources.rescan(project.id)}>
            <RefreshCw size={14} /> Alle neu indexieren
          </button>
          <button
            className="btn primary"
            onClick={() => {
              close()
              void addSourceFlow()
            }}
          >
            <FolderPlus size={14} /> Quellordner hinzufügen
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Unterordner werden einbezogen. Symbolische Links und Junctions werden nicht verfolgt. Ausgabe-, Paket- und Wiederherstellungsordner werden automatisch ausgeschlossen.
      </p>
      {sources.length === 0 && <p className="muted">Noch keine Quellen.</p>}
      {sources.map((s) => (
        <div key={s.id} className="list-row">
          {s.scanStatus === 'unavailable' && <AlertTriangle size={16} className="warn" />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono ellipsis">{s.path}</div>
            <div className="tiny muted">
              {s.fileCount.toLocaleString('de-DE')} Medien · zuletzt indexiert {fmtDate(s.lastScanAt)}
              {s.skippedLinks ? ` · ${s.skippedLinks} Verknüpfung(en) übersprungen` : ''}
              {s.scanError ? ` · ${s.scanError}` : ''}
            </div>
            {s.excludedPaths.length > 0 && <div className="tiny faint ellipsis">Ausgeschlossen: {s.excludedPaths.join(', ')}</div>}
          </div>
          <button className="btn sm" disabled={s.scanStatus === 'scanning'} onClick={() => void api.sources.rescan(project.id, s.id)}>
            {s.scanStatus === 'scanning' ? 'Indexiert …' : 'Neu indexieren'}
          </button>
        </div>
      ))}
    </Modal>
  )
}
