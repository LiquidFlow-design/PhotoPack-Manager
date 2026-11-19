import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ConflictPolicy, ExportPlanPreview, Operation } from '@shared/types'
import { api } from '../lib/api'
import { fmtBytes } from '../lib/format'
import { chooseDirFlow } from '../lib/flows'
import { useStore } from '../state/store'
import { Modal } from './Modal'

export function ExportDialog({ packageIds }: { packageIds: string[] | null }) {
  const project = useStore((s) => s.project)!
  const packages = useStore((s) => s.packages)
  const close = useStore((s) => s.closeDialog)
  const [operation, setOperation] = useState<Operation>(project.operation)
  const [policy, setPolicy] = useState<ConflictPolicy>(project.conflictPolicy)
  const [reexport, setReexport] = useState(false)
  const [selected, setSelected] = useState<string[] | null>(packageIds)
  const [preview, setPreview] = useState<ExportPlanPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setPreview(await api.exports.preview(project.id, { packageIds: selected, operation, conflictPolicy: policy, reexportMissing: reexport }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [project.id, selected, operation, policy, reexport])

  useEffect(() => {
    void load()
  }, [load])

  const start = async () => {
    if (!preview) return
    setStarting(true)
    try {
      if (operation !== project.operation || policy !== project.conflictPolicy) await api.projects.update(project.id, { operation, conflictPolicy: policy })
      const r = await api.exports.start(preview.planId)
      close()
      if (r.jobId) {
        useStore.getState().toast('success', `Export gestartet: ${r.created} Vorgänge.`)
        void useStore.getState().refreshJobs()
      } else useStore.getState().toast('info', 'Nichts zu exportieren.')
    } catch (e) {
      setError((e as Error).message)
      setStarting(false)
    }
  }

  const blocked = !preview || preview.blockingErrors.length > 0 || preview.totalItems === 0
  const toggle = (id: string) => {
    const all = selected ?? packages.map((p) => p.id)
    const next = all.includes(id) ? all.filter((x) => x !== id) : [...all, id]
    setSelected(next.length === packages.length ? null : next)
  }

  return (
    <Modal
      title="Exportvorschau"
      size="wide"
      onClose={close}
      footer={
        <>
          <span style={{ marginRight: 'auto' }} />
          <button className="btn" onClick={close}>
            Schließen
          </button>
          <button className="btn primary" disabled={blocked || starting || loading} onClick={() => void start()}>
            {operation === 'move' ? 'Verschieben starten' : 'Kopieren starten'}
          </button>
        </>
      }
    >
      <div className="row" style={{ flexWrap: 'wrap', gap: 14, marginBottom: 14 }}>
        <div>
          <div className="field-label">Vorgang</div>
          <div className="segmented" role="radiogroup" aria-label="Vorgang" style={{ marginTop: 5 }}>
            <button role="radio" aria-checked={operation === 'copy'} onClick={() => setOperation('copy')}>
              Kopieren
            </button>
            <button role="radio" aria-checked={operation === 'move'} onClick={() => setOperation('move')}>
              Verschieben
            </button>
          </div>
        </div>
        <div>
          <div className="field-label">Bei vorhandener Datei mit anderem Inhalt</div>
          <div className="segmented" role="radiogroup" aria-label="Konfliktregel" style={{ marginTop: 5 }}>
            <button role="radio" aria-checked={policy === 'rename'} onClick={() => setPolicy('rename')}>
              Umbenennen „Name (2)“
            </button>
            <button role="radio" aria-checked={policy === 'skip'} onClick={() => setPolicy('skip')}>
              Überspringen
            </button>
          </div>
        </div>
        <label className="check" style={{ alignSelf: 'flex-end' }}>
          <input type="checkbox" checked={reexport} onChange={(e) => setReexport(e.target.checked)} />
          Bereits exportierte, aber am Ziel fehlende Dateien erneut exportieren
        </label>
        <button className="btn sm" style={{ alignSelf: 'flex-end' }} onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} /> Aktualisieren
        </button>
      </div>


      {error && (
        <div className="callout err">
          <XCircle size={16} /> {error}
        </div>
      )}
      {loading && !preview && (
        <div className="row muted">
          <div className="spinner" /> Plan wird berechnet …
        </div>
      )}

      {preview && (
        <>
          <div className="stat-grid">
            <div className="stat">
              <div className="v">{preview.totalItems.toLocaleString('de-DE')}</div>
              <div className="l">Dateivorgänge</div>
            </div>
            <div className="stat">
              <div className="v">{preview.mediaCount.toLocaleString('de-DE')}</div>
              <div className="l">Medien</div>
            </div>
            <div className="stat">
              <div className="v">{fmtBytes(preview.totalBytes)}</div>
              <div className="l">Datenmenge</div>
            </div>
            {operation === 'move' && (
              <div className="stat">
                <div className="v">{preview.moveReleases.toLocaleString('de-DE')}</div>
                <div className="l">Quellen → Wiederherstellung</div>
              </div>
            )}
          </div>

          {preview.blockingErrors.map((b) => (
            <div className="callout err" key={b}>
              <XCircle size={16} /> <span style={{ flex: 1 }}>{b}</span>
              {/keinen Zielordner/.test(b) && (
                <button
                  className="btn sm"
                  onClick={async () => {
                    await chooseDirFlow('output')
                    await load()
                  }}
                >
                  Ausgabeordner wählen
                </button>
              )}
            </div>
          ))}
          {preview.warnings.map((w) => (
            <div className="callout warn" key={w}>
              <AlertTriangle size={16} /> {w}
            </div>
          ))}
          {preview.totalItems === 0 && preview.blockingErrors.length === 0 && (
            <div className="callout ok">
              <CheckCircle2 size={16} /> Alle Zuordnungen sind bereits exportiert – nichts zu tun.
            </div>
          )}

          <table className="table" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th style={{ width: 30 }} />
                <th>Paket</th>
                <th>Zielordner</th>
                <th style={{ textAlign: 'right' }}>Neu</th>
                <th style={{ textAlign: 'right' }}>Größe</th>
                <th style={{ textAlign: 'right' }}>Bereits exportiert</th>
                <th>Hinweise</th>
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => {
                const sum = preview.packages.find((x) => x.packageId === p.id)
                const on = selected === null || selected.includes(p.id)
                return (
                  <tr key={p.id}>
                    <td>
                      <input type="checkbox" aria-label={`Paket ${p.name} einbeziehen`} checked={on} onChange={() => toggle(p.id)} />
                    </td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <span className="dot" style={{ background: p.color }} />
                        {p.name}
                      </span>
                    </td>
                    <td className="mono ellipsis" style={{ maxWidth: 280 }} title={p.effectiveTargetDir ?? ''}>
                      {p.effectiveTargetDir ?? <span className="err">nicht festgelegt</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{on && sum ? sum.items : '–'}</td>
                    <td style={{ textAlign: 'right' }}>{on && sum ? fmtBytes(sum.bytes) : '–'}</td>
                    <td style={{ textAlign: 'right' }}>{sum ? sum.alreadyExported : 0}</td>
                    <td className="tiny">
                      {sum && sum.nameCollisions > 0 && <div>{sum.nameCollisions} gleiche Dateinamen → „Name (2)“</div>}
                      {sum && sum.existingConflicts > 0 && <div>{sum.existingConflicts} Name(n) existieren am Ziel (identisch → übersprungen, sonst {policy === 'rename' ? 'umbenannt' : 'übersprungen'})</div>}
                      {sum && sum.missingTargets > 0 && <div className="warn">{sum.missingTargets} exportierte Datei(en) fehlen am Ziel</div>}
                      {sum?.problems.map((x) => (
                        <div key={x} className="warn">
                          {x}
                        </div>
                      ))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {preview.volumes.length > 0 && (
            <>
              <div className="h-section" style={{ marginTop: 16 }}>
                Speicherplatz
              </div>
              {preview.volumes.map((v) => (
                <div key={v.root} className="row small" style={{ gap: 10, marginBottom: 4 }}>
                  {v.ok ? <CheckCircle2 size={14} className="ok" /> : <XCircle size={14} className="err" />}
                  <span className="mono">{v.root}</span>
                  <span className="muted">
                    benötigt {fmtBytes(v.requiredBytes)} · frei {v.freeBytes == null ? 'unbekannt' : fmtBytes(v.freeBytes)}
                  </span>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </Modal>
  )
}
