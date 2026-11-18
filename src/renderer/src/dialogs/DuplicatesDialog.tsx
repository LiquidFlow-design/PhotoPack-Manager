import { Copy, Images } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DEFAULT_FILTERS } from '@shared/filters'
import type { DuplicateGroup, SimilarGroup } from '@shared/types'
import { api, thumbUrl } from '../lib/api'
import { fmtBytes } from '../lib/format'
import { useStore } from '../state/store'
import { Modal } from './Modal'

export function DuplicatesDialog() {
  const close = useStore((s) => s.closeDialog)
  const project = useStore((s) => s.project)!
  const mediaById = useStore((s) => s.mediaById)
  const tasks = useStore((s) => s.tasks)
  const version = useStore((s) => s.version)
  const [tab, setTab] = useState<'exact' | 'similar'>('exact')
  const [exact, setExact] = useState<DuplicateGroup[] | null>(null)
  const [similar, setSimilar] = useState<SimilarGroup[] | null>(null)
  const runningExact = tasks[`duplicates:${project.id}`]?.running
  const runningSimilar = tasks[`similar:${project.id}`]?.running

  useEffect(() => {
    void api.duplicates.groups(project.id).then(setExact)
    void api.duplicates.similarGroups(project.id).then(setSimilar)
  }, [project.id, runningExact, runningSimilar, version])

  const show = (ids: number[], kind: 'only' | 'similar') => {
    const s = useStore.getState()
    if (s.packageView) s.closePackageView()
    s.setFilters({ ...DEFAULT_FILTERS, duplicates: kind })
    s.setSourceFilter(null)
    useStore.setState({ selection: new Set(ids), active: ids[0], anchor: ids[0], scrollSeq: useStore.getState().scrollSeq + 1 })
    close()
  }
  const groups = tab === 'exact' ? exact : similar
  const running = tab === 'exact' ? runningExact : runningSimilar
  const wasted = (exact ?? []).reduce((a, g) => a + g.size * (g.mediaIds.length - 1), 0)

  return (
    <Modal
      title="Duplikate"
      size="wide"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Schließen
          </button>
          <button
            className="btn primary"
            disabled={!!running}
            onClick={() => void (tab === 'exact' ? api.duplicates.scan(project.id) : api.duplicates.scanSimilar(project.id))}
          >
            {tab === 'exact' ? <Copy size={14} /> : <Images size={14} />} {running ? 'Prüfung läuft …' : 'Jetzt prüfen'}
          </button>
        </>
      }
    >
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'exact'} onClick={() => setTab('exact')}>
          Exakt (SHA-256){exact?.length ? ` · ${exact.length}` : ''}
        </button>
        <button role="tab" aria-selected={tab === 'similar'} onClick={() => setTab('similar')}>
          Ähnlich{similar?.length ? ` · ${similar.length}` : ''}
        </button>
      </div>
      {tab === 'exact' && exact && exact.length > 0 && <p className="small muted">Zusätzlich belegt: {fmtBytes(wasted)}</p>}
      {groups && groups.length === 0 && <p className="muted small">Keine Gruppen bekannt.</p>}
      {groups?.slice(0, 300).map((g) => {
        const ids = g.mediaIds
        const key = 'sha256' in g ? g.sha256 : String(g.id)
        return (
          <div key={key} className="dup-group">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="small">
                {ids.length} Dateien{'size' in g ? ` · je ${fmtBytes(g.size)}` : ''}
              </span>
              <button className="btn sm" onClick={() => show(ids, tab === 'exact' ? 'only' : 'similar')}>
                Im Raster auswählen
              </button>
            </div>
            <div className="dup-items">
              {ids.map((id) => {
                const m = mediaById.get(id)
                return (
                  <button key={id} className="dup-item" onClick={() => show([id], tab === 'exact' ? 'only' : 'similar')} title={m ? `${m.relDir}/${m.name}` : ''}>
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
        )
      })}
    </Modal>
  )
}
