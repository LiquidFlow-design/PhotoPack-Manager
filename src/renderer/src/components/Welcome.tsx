import { FolderPlus, Images } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../state/store'

export function Welcome() {
  const projects = useStore((s) => s.projects)
  const openDialog = useStore((s) => s.openDialog)
  const create = () =>
    openDialog({
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
    <div className="welcome">
      <div className="welcome-card glass">
        <div className="row" style={{ gap: 12, marginBottom: 14 }}>
          <div className="logo" style={{ width: 42, height: 42 }}>
            <Images size={22} />
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 650 }}>Willkommen bei PhotoPack Manager</div>
            <div className="muted small">Medien sichten, Paketen zuordnen und sicher verteilen – vollständig lokal.</div>
          </div>
        </div>
        <ol className="hint" style={{ paddingLeft: 18, margin: '8px 0 18px' }}>
          <li>Projekt anlegen und Quellordner hinzufügen</li>
          <li>Pakete (z. B. Personen) erstellen, Ausgabeordner festlegen</li>
          <li>Medien per Klick oder Taste 1–9 zuordnen</li>
          <li>Exportvorschau prüfen und Kopieren oder Verschieben starten</li>
        </ol>
        <div className="row">
          <button className="btn primary" onClick={create}>
            <FolderPlus size={16} /> Neues Projekt
          </button>
          {projects.length > 0 && (
            <button className="btn" onClick={() => openDialog({ type: 'projects' })}>
              Vorhandenes Projekt öffnen ({projects.length})
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
