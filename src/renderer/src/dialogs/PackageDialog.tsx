import { Eye, FileArchive, FolderOpen, FolderOutput, Send, Trash2, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api'
import { chooseDirFlow } from '../lib/flows'
import { useStore } from '../state/store'
import { Modal } from './Modal'

const COLORS = ['#6ea8ff', '#b59cf5', '#f0a875', '#6fcfae', '#f27f9b', '#e6c860', '#5fc6dd', '#a3b5c9', '#d78ee0']

export function PackageDialog({ packageId }: { packageId: string | null }) {
  const close = useStore((s) => s.closeDialog)
  const packages = useStore((s) => s.packages)
  const p = packages.find((x) => x.id === packageId)
  const [name, setName] = useState(p?.name ?? '')
  const [err, setErr] = useState<string | null>(null)
  if (!p) return null
  const s = useStore.getState()

  const save = async (patch: Parameters<typeof api.packages.update>[1]) => {
    try {
      setErr(null)
      await api.packages.update(p.id, patch)
      await s.refreshPackages()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <Modal
      title={`Paket „${p.name}“`}
      onClose={close}
      footer={
        <>
          <button
            className="btn danger"
            style={{ marginRight: 'auto' }}
            onClick={() =>
              s.openDialog({
                type: 'confirm',
                title: 'Paket löschen',
                message: `Paket „${p.name}“ mit ${p.mediaCount} Zuordnung(en) löschen? Bereits exportierte Dateien im Zielordner bleiben erhalten. Noch nicht gestartete Übertragungen werden storniert.`,
                confirmLabel: 'Paket löschen',
                danger: true,
                onConfirm: async () => {
                  const r = await api.packages.remove(p.id)
                  await s.refreshPackages()
                  await s.refreshAssignments()
                  s.toast('info', `Paket gelöscht (${r.removedAssignments} Zuordnungen entfernt).`)
                }
              })
            }
          >
            <Trash2 size={14} /> Löschen
          </button>
          <button
            className="btn"
            onClick={() => {
              s.closeDialog()
              void s.openPackageView(p.id)
            }}
          >
            <Eye size={14} /> Ansehen
          </button>
          <button
            className="btn"
            disabled={!p.mediaCount}
            onClick={async () => {
              try {
                const r = await api.packages.exportZip(p.id)
                if (!r) return
                s.toast(r.skipped.length ? 'warn' : 'success', `ZIP erstellt (${r.entries} Dateien)${r.skipped.length ? `, ${r.skipped.length} übersprungen` : ''}: ${r.file}`)
              } catch (e) {
                s.toast('error', (e as Error).message)
              }
            }}
          >
            <FileArchive size={14} /> Als ZIP …
          </button>
          <button
            className="btn"
            onClick={() => {
              s.openDialog({ type: 'export', packageIds: [p.id] })
            }}
          >
            <Send size={14} /> Exportieren
          </button>
          <button className="btn primary" onClick={close}>
            Fertig
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && name.trim() !== p.name) void save({ name: name.trim() })
        }}
      >
        <div className="field">
          <label htmlFor="pkg-name">Name</label>
          <div className="row">
            <input id="pkg-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== p.name && void save({ name: name.trim() })} />
          </div>
          {p.exportedCount > 0 && !p.targetDir && <div className="tiny muted">Bisherige Exporte bleiben im alten Ordner.</div>}
        </div>
      </form>
      {err && <div className="callout err">{err}</div>}
      <div className="field">
        <span className="field-label">Farbe</span>
        <div className="color-swatches" role="radiogroup" aria-label="Paketfarbe">
          {COLORS.map((c) => (
            <button key={c} role="radio" aria-checked={p.color === c} aria-label={`Farbe ${c}`} className="swatch" style={{ background: c }} onClick={() => void save({ color: c })} />
          ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor="pkg-key">Tastenkürzel</label>
        <select id="pkg-key" className="select" style={{ width: 200 }} value={p.shortcut ?? ''} onChange={(e) => void save({ shortcut: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Keins</option>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => {
            const other = packages.find((x) => x.shortcut === n && x.id !== p.id)
            return (
              <option key={n} value={n}>
                {n}
                {other ? ` (tauscht mit „${other.name}“)` : ''}
              </option>
            )
          })}
        </select>
      </div>
      <div className="field">
        <span className="field-label">Zielordner</span>
        <div className="mono small ellipsis" title={p.effectiveTargetDir ?? ''}>
          {p.effectiveTargetDir ?? <span className="warn">Nicht festgelegt – globalen Ausgabeordner wählen oder individuellen Ordner setzen.</span>}
        </div>

        <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => void chooseDirFlow('package', p.id)}>
            <FolderOutput size={13} /> Individuellen Ordner wählen
          </button>
          {p.targetDir && (
            <button className="btn sm" onClick={() => void api.packages.clearTargetDir(p.id).then(() => s.refreshPackages())}>
              <Undo2 size={13} /> Globalen Ordner verwenden
            </button>
          )}
          <button className="btn sm" onClick={() => void api.packages.openTarget(p.id)}>
            <FolderOpen size={13} /> Öffnen
          </button>
        </div>
      </div>
      <div className="stat-grid">
        <div className="stat">
          <div className="v">{p.mediaCount}</div>
          <div className="l">zugeordnet</div>
        </div>
        <div className="stat">
          <div className="v">{p.exportedCount}</div>
          <div className="l">exportiert</div>
        </div>
        <div className="stat">
          <div className="v">{p.pendingCount}</div>
          <div className="l">ausstehend</div>
        </div>
      </div>
    </Modal>
  )
}
