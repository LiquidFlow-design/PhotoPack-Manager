import { CheckCheck, FolderOpen, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { RecoveryOverview } from '@shared/types'
import { api } from '../lib/api'
import { fmtBytes, fmtDate } from '../lib/format'
import { useStore } from '../state/store'
import { Modal } from './Modal'

const ST: Record<string, [string, string]> = {
  held: ['Gehalten (kanonische Quelle)', 'info'],
  released: ['Freigegeben', 'warn'],
  restored: ['Wiederhergestellt', 'ok'],
  purged: ['Gelöscht', 'muted']
}

export function RecoveryDialog() {
  const close = useStore((s) => s.closeDialog)
  const project = useStore((s) => s.project)!
  const [o, setO] = useState<RecoveryOverview | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [showHistory, setShowHistory] = useState(false)

  const load = useCallback(async () => setO(await api.recovery.overview(project.id)), [project.id])
  useEffect(() => {
    void load()
    const off = api.onEvent((e) => {
      if (e.type === 'recovery-changed' && e.projectId === project.id) void load()
    })
    return off
  }, [load, project.id])

  const live = o?.items.filter((i) => i.status === 'held' || i.status === 'released') ?? []
  const items = showHistory ? (o?.items ?? []) : live
  const selected = live.filter((i) => sel.has(i.id))
  const ids = selected.map((i) => i.id)
  const toast = useStore.getState().toast

  const restore = async (alternative: boolean) => {
    try {
      const r = await api.recovery.restore(project.id, ids, alternative)
      if (r?.jobId) toast('success', `Wiederherstellung von ${r.created} Datei(en) gestartet.`)
      setSel(new Set())
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }

  return (
    <Modal
      title="Wiederherstellungsbereich"
      size="wide"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={() => void api.recovery.openFolder(project.id)}>
            <FolderOpen size={14} /> Ordner öffnen
          </button>
          <button
            className="btn"
            style={{ marginRight: 'auto' }}
            disabled={!live.some((i) => i.status === 'held')}
            onClick={() => {
              const held = live.filter((i) => i.status === 'held')
              useStore.getState().openDialog({
                type: 'confirm',
                title: 'Projekt abschließen',
                message: `${held.length} gehaltene Datei(en) (${fmtBytes(held.reduce((a, i) => a + i.size, 0))}) freigeben. Sie werden nach Ablauf der Aufbewahrungsfrist (${o?.retentionDays} Tage ab Verschiebung, mindestens 1 Tag) automatisch gelöscht. Exportierte Dateien bleiben unberührt.`,
                confirmLabel: 'Alle freigeben',
                onConfirm: async () => {
                  const r = await api.recovery.releaseAll(project.id)
                  toast('success', `${r.count} Datei(en) freigegeben (${fmtBytes(r.bytes)}).`)
                }
              })
            }}
          >
            <CheckCheck size={14} /> Projekt abschließen …
          </button>
          <button className="btn" disabled={!ids.length} onClick={() => void restore(false)}>
            <RotateCcw size={14} /> Am Originalort wiederherstellen
          </button>
          <button className="btn" disabled={!ids.length} onClick={() => void restore(true)}>
            In anderen Ordner …
          </button>
          <button
            className="btn"
            disabled={!selected.some((i) => i.status === 'held')}
            onClick={() =>
              useStore.getState().openDialog({
                type: 'confirm',
                title: 'Für Bereinigung freigeben',
                message: `${selected.filter((i) => i.status === 'held').length} Datei(en) freigeben? Freigegebene Dateien werden nach Ablauf der Aufbewahrungsfrist (${o?.retentionDays} Tage ab Verschiebung, mindestens 1 Tag) bei laufender Anwendung automatisch gelöscht. Spätere Paketzuordnungen dieser Medien können danach nur noch aus verifizierten Exportkopien bedient werden.`,
                confirmLabel: 'Freigeben',
                onConfirm: async () => {
                  await api.recovery.release(project.id, ids)
                  setSel(new Set())
                }
              })
            }
          >
            Freigeben
          </button>
          <button className="btn" disabled={!selected.some((i) => i.status === 'released')} onClick={() => void api.recovery.hold(project.id, ids).then(() => setSel(new Set()))}>
            Wieder halten
          </button>
          <button
            className="btn danger"
            disabled={!ids.length}
            onClick={() =>
              useStore.getState().openDialog({
                type: 'confirm',
                title: 'Endgültig löschen',
                message: `${ids.length} Datei(en) (${fmtBytes(selected.reduce((a, i) => a + i.size, 0))}) endgültig aus dem Wiederherstellungsbereich löschen? Dies kann nicht rückgängig gemacht werden. Exportierte Kopien in den Paketordnern bleiben erhalten.`,
                confirmLabel: 'Endgültig löschen',
                danger: true,
                onConfirm: async () => {
                  const r = await api.recovery.purge(project.id, ids)
                  toast('info', `${r.purged} Datei(en) gelöscht (${fmtBytes(r.bytes)})${r.skipped ? `, ${r.skipped} übersprungen (in Verwendung)` : ''}.`)
                  setSel(new Set())
                }
              })
            }
          >
            Löschen …
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Gehaltene Dateien werden nie automatisch gelöscht; freigegebene nach {o?.retentionDays ?? 30} Tagen. Kein Schutz bei Datenträgerausfall.
      </p>
      {o && (
        <div className="stat-grid">
          <div className="stat">
            <div className="v">{live.length.toLocaleString('de-DE')}</div>
            <div className="l">Dateien im Bereich</div>
          </div>
          <div className="stat">
            <div className="v">{fmtBytes(o.heldBytes)}</div>
            <div className="l">gehalten</div>
          </div>
          <div className="stat">
            <div className="v">{fmtBytes(o.releasedBytes)}</div>
            <div className="l">freigegeben</div>
          </div>
          <div className="stat">
            <div className="v">{fmtBytes(o.freeBytes)}</div>
            <div className="l">frei auf Datenträger</div>
          </div>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="mono tiny faint ellipsis" title={[o?.dir, ...(o?.extraDirs ?? [])].join('\n')}>
          {o?.dir}
          {o?.extraDirs.length ? ` + ${o.extraDirs.join(', ')}` : ''}
        </span>
        <label className="check">
          <input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} /> Verlauf anzeigen
        </label>
      </div>
      <div style={{ maxHeight: '45vh', overflow: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 30 }}>
                <input
                  type="checkbox"
                  aria-label="Alle auswählen"
                  checked={live.length > 0 && sel.size === live.length}
                  onChange={(e) => setSel(e.target.checked ? new Set(live.map((i) => i.id)) : new Set())}
                />
              </th>
              <th>Datei</th>
              <th>Originalpfad</th>
              <th>Verschoben</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Größe</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 3000).map((i) => {
              const live = i.status === 'held' || i.status === 'released'
              const [l, c] = ST[i.status] ?? [i.status, 'muted']
              return (
                <tr key={i.id} className="selectable">
                  <td>
                    {live && (
                      <input
                        type="checkbox"
                        aria-label={`${i.fileName} auswählen`}
                        checked={sel.has(i.id)}
                        onChange={(e) => {
                          const n = new Set(sel)
                          if (e.target.checked) n.add(i.id)
                          else n.delete(i.id)
                          setSel(n)
                        }}
                      />
                    )}
                  </td>
                  <td className="ellipsis" style={{ maxWidth: 180 }}>
                    {i.fileName}
                    {live && !i.exists && <div className="tiny err">Datei fehlt!</div>}
                  </td>
                  <td className="mono tiny ellipsis" style={{ maxWidth: 300 }} title={i.restoredTo ? `wiederhergestellt nach ${i.restoredTo}` : i.originalPath}>
                    {i.originalPath}
                  </td>
                  <td className="tiny">{fmtDate(i.movedAt)}</td>
                  <td>
                    <span className={'status-pill ' + c}>{l}</span>
                    {i.status === 'released' && i.retainUntil && <div className="tiny muted">bis {fmtDate(i.retainUntil, false)}</div>}
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmtBytes(i.size)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {items.length === 0 && <p className="muted small">Der Wiederherstellungsbereich ist leer.</p>}
      </div>
    </Modal>
  )
}
