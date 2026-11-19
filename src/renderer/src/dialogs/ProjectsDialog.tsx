import { Download, FolderOpen, FolderPlus, Pencil, Trash2, Upload } from 'lucide-react'
import { useEffect } from 'react'
import { api } from '../lib/api'
import { fmtDate } from '../lib/format'
import { useStore } from '../state/store'
import { Modal } from './Modal'

export function ProjectsDialog() {
  const close = useStore((s) => s.closeDialog)
  const projects = useStore((s) => s.projects)
  const current = useStore((s) => s.project)
  const s = useStore.getState()
  useEffect(() => {
    void s.refreshProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = () =>
    s.openDialog({
      type: 'prompt',
      title: 'Neues Projekt',
      label: 'Projektname',
      initial: '',
      confirmLabel: 'Projekt anlegen',
      onSubmit: async (name) => {
        const p = await api.projects.create(name)
        await useStore.getState().openProject(p.id)
      }
    })

  return (
    <Modal
      title="Projekte"
      onClose={close}
      footer={
        <>
          <button
            className="btn"
            style={{ marginRight: 'auto' }}
            onClick={async () => {
              try {
                const r = await api.projects.importBackup()
                if (!r) return
                await useStore.getState().refreshProjects()
                useStore.getState().toast('success', `Projekt „${r.name}“ importiert (${r.media} Dateien).`)
              } catch (e) {
                useStore.getState().toast('error', (e as Error).message)
              }
            }}
          >
            <Upload size={14} /> Sicherung importieren …
          </button>
          <button className="btn primary" onClick={create}>
            <FolderPlus size={14} /> Neues Projekt
          </button>
        </>
      }
    >
      {projects.length === 0 && <p className="muted">Noch keine Projekte.</p>}
      {projects.map((p) => (
        <div key={p.id} className={'list-row' + (current?.id === p.id ? ' current' : '')}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ellipsis" style={{ fontWeight: 600 }}>
              {p.name} {current?.id === p.id && <span className="status-pill info">geöffnet</span>}
            </div>
            <div className="tiny muted">
              {p.mediaCount.toLocaleString('de-DE')} Medien · {p.packageCount} Pakete · zuletzt geöffnet {fmtDate(p.lastOpenedAt ?? p.updatedAt)}
            </div>
          </div>
          {current?.id !== p.id && (
            <button
              className="btn sm"
              onClick={() => {
                close()
                void s.openProject(p.id)
              }}
            >
              <FolderOpen size={13} /> Öffnen
            </button>
          )}
          <button
            className="icon-btn ghost sm"
            aria-label={`${p.name} sichern`}
            title="Projekt sichern (.ppmproj)"
            onClick={async () => {
              try {
                const r = await api.projects.exportBackup(p.id)
                if (r) useStore.getState().toast('success', `Gesichert: ${r.file}`)
              } catch (e) {
                useStore.getState().toast('error', (e as Error).message)
              }
            }}
          >
            <Download size={14} />
          </button>
          <button
            className="icon-btn ghost sm"
            aria-label={`${p.name} umbenennen`}
            title="Umbenennen"
            onClick={() =>
              s.openDialog({
                type: 'prompt',
                title: 'Projekt umbenennen',
                label: 'Projektname',
                initial: p.name,
                confirmLabel: 'Umbenennen',
                onSubmit: async (name) => {
                  const r = await api.projects.rename(p.id, name)
                  if (useStore.getState().project?.id === p.id) useStore.setState({ project: { ...useStore.getState().project!, name: r.name } })
                  await useStore.getState().refreshProjects()
                }
              })
            }
          >
            <Pencil size={14} />
          </button>
          <button
            className="icon-btn ghost sm"
            aria-label={`${p.name} löschen`}
            title="Projekt löschen"
            onClick={() =>
              s.openDialog({
                type: 'confirm',
                title: 'Projekt löschen',
                message: `Projekt „${p.name}“ löschen? Zuordnungen, Pakete und Verlauf werden entfernt. Mediendateien, exportierte Dateien und der Wiederherstellungsbereich auf dem Datenträger bleiben unverändert erhalten.`,
                confirmLabel: 'Projekt löschen',
                danger: true,
                onConfirm: async () => {
                  const r = await api.projects.remove(p.id)
                  if (useStore.getState().project?.id === p.id) useStore.getState().closeProject()
                  await useStore.getState().refreshProjects()
                  if (r.recoveryDirKept)
                    useStore.getState().openDialog({
                      type: 'info',
                      title: 'Wiederherstellungsbereich bleibt erhalten',
                      message: `Der Wiederherstellungsbereich des Projekts enthält noch ${r.recoveryFiles} Datei(en) und wurde nicht gelöscht:\n\n${r.recoveryDirKept}\n\nSie können die Dateien bei Bedarf manuell sichern oder entfernen.`
                    })
                }
              })
            }
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </Modal>
  )
}
