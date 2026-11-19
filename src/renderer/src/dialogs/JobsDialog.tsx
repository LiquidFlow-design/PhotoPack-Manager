import { Pause, Play, RotateCcw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { JobItemInfo, JobItemStatus, JobStatus, JobSummary } from '@shared/types'
import { api } from '../lib/api'
import { fmtBytes, fmtDate } from '../lib/format'
import { useStore } from '../state/store'
import { Modal } from './Modal'

const JOB_STATUS: Record<JobStatus, [string, string]> = {
  queued: ['Wartet', 'info'],
  running: ['Läuft', 'info'],
  paused: ['Pausiert', 'warn'],
  completed: ['Abgeschlossen', 'ok'],
  completed_with_errors: ['Mit Fehlern', 'err'],
  cancelled: ['Abgebrochen', 'muted']
}
const ITEM_STATUS: Record<JobItemStatus, [string, string]> = {
  pending: ['Ausstehend', 'muted'],
  waiting: ['Wartet auf Zielkopien', 'muted'],
  copying: ['Kopiert …', 'info'],
  verifying: ['Prüft …', 'info'],
  committing: ['Schreibt fest …', 'info'],
  recovery_copying: ['Sichert Quelle …', 'info'],
  recovery_committed: ['Quelle gesichert', 'info'],
  source_removing: ['Entfernt Quelle …', 'info'],
  done: ['Erledigt', 'ok'],
  skipped: ['Übersprungen', 'muted'],
  failed: ['Fehler', 'err'],
  cancelled: ['Storniert', 'muted']
}
const NOTE: Record<string, string> = { identical: 'identische Datei bereits vorhanden', conflict: 'Name belegt (Regel: überspringen)', umbenannt: 'umbenannt' }

export function JobsDialog({ initialJob }: { initialJob?: string }) {
  const close = useStore((s) => s.closeDialog)
  const jobs = useStore((s) => s.jobs)
  const [sel, setSel] = useState<string | null>(initialJob ?? jobs[0]?.id ?? null)
  const [items, setItems] = useState<JobItemInfo[]>([])
  const [onlyProblems, setOnlyProblems] = useState(false)
  const job = jobs.find((j) => j.id === sel)

  useEffect(() => {
    void useStore.getState().refreshJobs()
  }, [])
  useEffect(() => {
    if (!sel) return
    let off = false
    void api.jobs.items(sel).then((r) => !off && setItems(r))
    return () => {
      off = true
    }
  }, [sel, job?.doneItems, job?.failedItems, job?.status, job?.skippedItems])

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      await useStore.getState().refreshJobs()
    } catch (e) {
      useStore.getState().toast('error', (e as Error).message)
    }
  }
  const shown = onlyProblems ? items.filter((i) => i.status === 'failed' || (i.status === 'skipped' && i.note !== 'identical')) : items

  return (
    <Modal title="Auftragsverlauf" size="wide" onClose={close}>
      {jobs.length === 0 ? (
        <p className="muted">Noch keine Aufträge.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 14, minHeight: 360 }}>
          <div style={{ overflow: 'auto', maxHeight: '60vh' }}>
            {jobs.map((j) => (
              <JobRow key={j.id} j={j} selected={j.id === sel} onClick={() => setSel(j.id)} />
            ))}
          </div>
          <div style={{ minWidth: 0 }}>
            {job && (
              <>
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                  <div>
                    <strong>{job.label || 'Auftrag'}</strong>
                    <div className="tiny muted">
                      {job.mode === 'instant' ? 'Sofortmodus' : 'Sammelexport'} · {job.operation === 'move' ? 'Verschieben' : 'Kopieren'} · angelegt {fmtDate(job.createdAt)}
                      {job.finishedAt ? ` · beendet ${fmtDate(job.finishedAt)}` : ''}
                    </div>
                  </div>
                  <div className="row">
                    {(job.status === 'running' || job.status === 'queued') && (
                      <button className="btn sm" onClick={() => void act(() => api.jobs.pause(job.id))}>
                        <Pause size={13} /> Pausieren
                      </button>
                    )}
                    {job.status === 'paused' && (
                      <button className="btn sm primary" onClick={() => void act(() => api.jobs.resume(job.id))}>
                        <Play size={13} /> Fortsetzen
                      </button>
                    )}
                    {job.failedItems > 0 && (
                      <button className="btn sm" onClick={() => void act(() => api.jobs.retry(job.id))}>
                        <RotateCcw size={13} /> Fehlgeschlagene wiederholen
                      </button>
                    )}
                    {['queued', 'running', 'paused'].includes(job.status) && (
                      <button
                        className="btn sm danger"
                        onClick={() =>
                          useStore.getState().openDialog({
                            type: 'confirm',
                            title: 'Auftrag abbrechen',
                            message: 'Offene Vorgänge werden storniert. Bereits erstellte Zieldateien bleiben erhalten; nicht verschobene Quellen bleiben an ihrem Ort.',
                            confirmLabel: 'Auftrag abbrechen',
                            danger: true,
                            onConfirm: () => act(() => api.jobs.cancel(job.id))
                          })
                        }
                      >
                        <Square size={12} /> Abbrechen
                      </button>
                    )}
                  </div>
                </div>
                {job.interrupted && (
                  <div className="callout warn" style={{ marginTop: 10 }}>
                    Dieser Auftrag wurde durch ein Programmende unterbrochen. Zwischenzustände wurden mit dem Dateisystem abgeglichen; Fortsetzen überträgt nur noch fehlende Dateien.
                  </div>
                )}
                <label className="check" style={{ margin: '8px 0' }}>
                  <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Nur Fehler und Konflikte anzeigen
                </label>
                <div style={{ maxHeight: '48vh', overflow: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Datei</th>
                        <th>Vorgang</th>
                        <th>Status</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.slice(0, 2000).map((i) => {
                        const [l, c] = ITEM_STATUS[i.status]
                        return (
                          <tr key={i.id}>
                            <td className="ellipsis" style={{ maxWidth: 200 }} title={i.fileName}>
                              {i.fileName}
                            </td>
                            <td className="tiny">{i.kind === 'copy' ? `→ ${i.packageName ?? '?'}` : i.kind === 'release_source' ? 'Quelle → Wiederherstellung' : 'Wiederherstellen'}</td>
                            <td>
                              <span className={'status-pill ' + c}>{l}</span>
                            </td>
                            <td className="tiny" style={{ maxWidth: 320 }}>
                              {i.errorMessage && <div className="err">{i.errorMessage}</div>}
                              {i.note && NOTE[i.note] && <div className="muted">{NOTE[i.note]}</div>}
                              {i.finalPath && (
                                <div className="mono faint ellipsis" title={i.finalPath}>
                                  {i.finalPath}
                                </div>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {shown.length > 2000 && <p className="hint">Es werden die ersten 2.000 Einträge angezeigt.</p>}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

function JobRow({ j, selected, onClick }: { j: JobSummary; selected: boolean; onClick: () => void }) {
  const [l, c] = JOB_STATUS[j.status]
  const finished = j.doneItems + j.skippedItems + j.failedItems + j.cancelledItems
  return (
    <button className={'list-row' + (selected ? ' current' : '')} style={{ width: '100%', textAlign: 'left', background: 'transparent', flexDirection: 'column', alignItems: 'stretch' }} onClick={onClick}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="small ellipsis" style={{ fontWeight: 600 }}>
          {j.label || 'Auftrag'}
        </span>
        <span className={'status-pill ' + c}>{l}</span>
      </div>
      <div className="row tiny muted" style={{ justifyContent: 'space-between' }}>
        <span>
          {finished}/{j.totalItems} · {fmtBytes(j.doneBytes)} / {fmtBytes(j.totalBytes)}
        </span>
        <span>{fmtDate(j.createdAt)}</span>
      </div>
      <div className="progress" style={{ width: '100%' }}>
        <div style={{ width: `${j.totalItems ? (finished / j.totalItems) * 100 : 0}%` }} />
      </div>
    </button>
  )
}
