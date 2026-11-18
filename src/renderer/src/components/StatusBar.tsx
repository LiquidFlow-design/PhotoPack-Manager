import { AlertTriangle, CheckCircle2, Copy, MoveRight, Pause, Play, X, Zap, Layers } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../state/store'

export function StatusBar() {
  const s = useStore()
  const { project, selection, jobs, tasks } = s
  if (!project) return <footer className="footer glass" aria-label="Status" />

  const activeJobs = jobs.filter((j) => j.status === 'running' || j.status === 'queued')
  const pausedJobs = jobs.filter((j) => j.status === 'paused')
  const errorJobs = jobs.filter((j) => j.status === 'completed_with_errors' && j.finishedAt && Date.now() - j.finishedAt < 24 * 3600_000)
  const total = activeJobs.reduce((a, j) => a + j.totalItems, 0)
  const done = activeJobs.reduce((a, j) => a + j.doneItems + j.skippedItems + j.failedItems + j.cancelledItems, 0)
  const runningTasks = Object.values(tasks).filter((t) => t.running)

  return (
    <footer className="footer glass" aria-label="Status- und Auftragsleiste">
      <div className="status-group" style={{ flexWrap: 'wrap' }}>
        <span className="status-text">{selection.size.toLocaleString('de-DE')} ausgewählt</span>
        <span className="saved" title="Alle Änderungen werden automatisch gespeichert">
          <CheckCircle2 size={13} className="ok" /> Gespeichert
        </span>
        {runningTasks.map((t) => (
          <span className="task-pill" key={t.id}>
            <div className="spinner" />
            {t.label}
            {t.total > 0 ? ` ${t.done.toLocaleString('de-DE')}/${t.total.toLocaleString('de-DE')}` : ''}
            {(t.kind === 'scan' || t.kind === 'duplicates' || t.kind === 'thumbs') && (
              <button className="icon-btn ghost sm" style={{ width: 20, height: 20 }} aria-label={`${t.label} abbrechen`} onClick={() => void api.projects.cancelTask(project.id, t.kind)}>
                <X size={12} />
              </button>
            )}
          </span>
        ))}
        {activeJobs.length > 0 && (
          <button className="task-pill" onClick={() => s.openDialog({ type: 'jobs' })} title="Aufträge anzeigen">
            <div className="spinner" />
            {activeJobs.length} Auftrag/Aufträge · {done}/{total}
            <span className="progress" aria-hidden="true">
              <div style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
            </span>
          </button>
        )}
        {pausedJobs.length > 0 && (
          <button className="task-pill" onClick={() => s.openDialog({ type: 'jobs' })}>
            <Pause size={13} /> {pausedJobs.length} pausiert
            <span
              role="button"
              tabIndex={0}
              className="link-btn"
              onClick={(e) => {
                e.stopPropagation()
                for (const j of pausedJobs) void api.jobs.resume(j.id)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') for (const j of pausedJobs) void api.jobs.resume(j.id)
              }}
            >
              <Play size={11} /> fortsetzen
            </span>
          </button>
        )}
        {errorJobs.length > 0 && (
          <button className="task-pill err" onClick={() => s.openDialog({ type: 'jobs', jobId: errorJobs[0].id })}>
            <AlertTriangle size={13} /> {errorJobs.reduce((a, j) => a + j.failedItems, 0)} Fehler
          </button>
        )}
      </div>
      <div className="status-group">
        <span className="status-text">Arbeitsmodus</span>
        <div className="segmented" role="radiogroup" aria-label="Arbeitsmodus">
          <button role="radio" aria-checked={project.workMode === 'collect'} onClick={() => void s.updateProject({ workMode: 'collect' })} title="Zuordnungen sammeln, Export nach Vorschau">
            <Layers size={14} /> Sammeln
          </button>
          <button role="radio" aria-checked={project.workMode === 'instant'} onClick={() => void s.updateProject({ workMode: 'instant' })} title="Neue Zuordnungen sofort übertragen">
            <Zap size={14} /> Sofort
          </button>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Dateivorgang">
          <button role="radio" aria-checked={project.operation === 'copy'} onClick={() => void s.updateProject({ operation: 'copy' })}>
            <Copy size={14} /> Kopieren
          </button>
          <button role="radio" aria-checked={project.operation === 'move'} onClick={() => void s.updateProject({ operation: 'move' })} title="Verschieben mit Wiederherstellungsbereich">
            <MoveRight size={14} /> Verschieben
          </button>
        </div>
      </div>
    </footer>
  )
}
