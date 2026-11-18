import { Copy, Info } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DEFAULT_FILTERS } from '@shared/filters'
import type { DuplicateGroup } from '@shared/types'
import { api, thumbUrl } from '../lib/api'
import { fmtBytes } from '../lib/format'
import { useStore } from '../state/store'
import { Modal } from './Modal'

export function DuplicatesDialog() {
  const close = useStore((s) => s.closeDialog)
  const project = useStore((s) => s.project)!
  const mediaById = useStore((s) => s.mediaById)
  const tasks = useStore((s) => s.tasks)
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null)
  const running = tasks[`duplicates:${project.id}`]?.running
  const version = useStore((s) => s.version)

  useEffect(() => {
    void api.duplicates.groups(project.id).then(setGroups)
  }, [project.id, running, version])

  const show = (ids: number[]) => {
    const s = useStore.getState()
    s.setFilters({ ...DEFAULT_FILTERS, duplicates: 'only' })
    s.setSourceFilter(null)
    useStore.setState({ selection: new Set(ids), active: ids[0], anchor: ids[0], scrollSeq: useStore.getState().scrollSeq + 1 })
    close()
  }
  const wasted = (groups ?? []).reduce((a, g) => a + g.size * (g.mediaIds.length - 1), 0)

  return (
    <Modal
      title="Exakte Duplikate"
      size="wide"
      onClose={close}
      footer={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>
            Es werden keine Dateien gelöscht.
          </span>
          <button className="btn" onClick={close}>
            Schließen
          </button>
          <button className="btn primary" disabled={!!running} onClick={() => void api.duplicates.scan(project.id)}>
            <Copy size={14} /> {running ? 'Prüfung läuft …' : 'Duplikate jetzt prüfen'}
          </button>
        </>
      }
    >
      <div className="callout info">
        <Info size={16} />
        <span>Erkennung exakt identischer Inhalte: zuerst nach Dateigröße gruppiert, nur Kandidaten werden per SHA-256 geprüft. Unterschiedliche Dateinamen werden erkannt.</span>
      </div>
      {groups && groups.length > 0 && (
        <p className="small muted">
          {groups.length} Gruppe(n), zusätzlich belegter Speicher ca. {fmtBytes(wasted)}.
        </p>
      )}
      {groups && groups.length === 0 && <p className="muted small">Keine Duplikatgruppen bekannt. Starte die Prüfung, um das Projekt zu durchsuchen.</p>}
      {groups?.slice(0, 300).map((g) => (
        <div key={g.sha256} className="dup-group">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <span className="small">
              {g.mediaIds.length} identische Dateien · je {fmtBytes(g.size)} <span className="mono faint">{g.sha256.slice(0, 12)}…</span>
            </span>
            <button className="btn sm" onClick={() => show(g.mediaIds)}>
              Im Raster auswählen
            </button>
          </div>
          <div className="dup-items">
            {g.mediaIds.map((id) => {
              const m = mediaById.get(id)
              return (
                <button key={id} className="dup-item" onClick={() => show([id])} title={m ? `${m.relDir}/${m.name}` : ''}>
                  <img src={thumbUrl(id)} alt="" loading="lazy" />
                  <div className="tiny ellipsis" style={{ padding: '4px 6px' }}>
                    {m?.name ?? id}
                  </div>
                  <div className="tiny faint ellipsis" style={{ padding: '0 6px 5px' }}>
                    {m?.relDir || '/'}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </Modal>
  )
}
