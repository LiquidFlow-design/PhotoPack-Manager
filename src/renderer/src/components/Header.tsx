import { Bell, ChevronDown, Images, Monitor, Moon, Presentation, Settings, Sun } from 'lucide-react'
import { useStore } from '../state/store'
import { SearchBox } from './SearchBox'

const THEME_NEXT = { system: 'light', light: 'dark', dark: 'system' } as const
const THEME_LABEL = { system: 'System', light: 'Hell', dark: 'Dunkel' } as const

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase() || 'P'
}

export function Header() {
  const project = useStore((s) => s.project)
  const settings = useStore((s) => s.settings)
  const openDialog = useStore((s) => s.openDialog)
  const presenterOpen = useStore((s) => s.presenterOpen)
  const jobs = useStore((s) => s.jobs)
  const theme = settings?.theme ?? 'system'
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued' || j.status === 'paused').length
  const failed = jobs.filter((j) => j.status === 'completed_with_errors' && j.finishedAt && Date.now() - j.finishedAt < 24 * 3600_000).length
  const bell = active + failed

  return (
    <header className="header glass">
      <div className="brand">
        <div className="logo" aria-hidden="true">
          <Images size={18} />
        </div>
        <div>
          PhotoPack <span className="light">Manager</span>
        </div>
      </div>
      {project ? <SearchBox /> : <div style={{ flex: 1 }} />}
      <div className="row header-actions">
        {project && (
          <button
            className={'icon-btn' + (presenterOpen ? ' active' : '')}
            title="Präsentationsfenster (zweiter Bildschirm)"
            aria-label="Präsentationsfenster"
            aria-pressed={presenterOpen}
            onClick={() => void useStore.getState().togglePresenter()}
          >
            <Presentation size={17} />
          </button>
        )}
        <button
          className="icon-btn"
          title={`Farbschema: ${THEME_LABEL[theme]} (klicken zum Wechseln)`}
          aria-label={`Farbschema: ${THEME_LABEL[theme]}. Wechseln zu ${THEME_LABEL[THEME_NEXT[theme]]}`}
          onClick={() => void useStore.getState().updateSettings({ theme: THEME_NEXT[theme] })}
        >
          <ThemeIcon size={17} />
        </button>
        {project && (
          <button
            className={'icon-btn' + (failed ? ' alert' : '')}
            title="Aufträge"
            aria-label={`Aufträge${bell ? ` (${active} offen, ${failed} mit Fehlern)` : ''}`}
            onClick={() => openDialog({ type: 'jobs' })}
          >
            <Bell size={17} />
            {bell > 0 && <span className={'badge-count' + (failed ? ' err' : '')}>{bell}</span>}
          </button>
        )}
        <button className="icon-btn" title="Einstellungen" aria-label="Einstellungen" onClick={() => openDialog({ type: 'settings' })}>
          <Settings size={17} />
        </button>
        <span className="header-sep" aria-hidden="true" />
        <button className="project-chip" onClick={() => openDialog({ type: 'projects' })} aria-haspopup="dialog" title="Projekt wechseln oder anlegen">
          <span className="avatar" aria-hidden="true">
            {initials(project?.name ?? 'PhotoPack')}
          </span>
          <span className="project-chip-text">
            <span className="ellipsis project-name">{project ? project.name : 'Kein Projekt'}</span>
            <span className="tiny muted">Projekt</span>
          </span>
          <ChevronDown size={14} className="muted" />
        </button>
      </div>
    </header>
  )
}
