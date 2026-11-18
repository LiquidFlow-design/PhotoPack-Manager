import { ChevronDown, FolderKanban, Images, Monitor, Moon, Settings, Sun } from 'lucide-react'
import { useStore } from '../state/store'

const THEME_NEXT = { system: 'light', light: 'dark', dark: 'system' } as const
const THEME_LABEL = { system: 'System', light: 'Hell', dark: 'Dunkel' } as const

export function Header() {
  const project = useStore((s) => s.project)
  const settings = useStore((s) => s.settings)
  const openDialog = useStore((s) => s.openDialog)
  const theme = settings?.theme ?? 'system'
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon

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
      <div className="header-center">
        <button className="btn" onClick={() => openDialog({ type: 'projects' })} aria-haspopup="dialog" title="Projekt wechseln oder anlegen">
          <FolderKanban size={16} />
          <span className="ellipsis" style={{ maxWidth: 260 }}>
            {project ? project.name : 'Kein Projekt geöffnet'}
          </span>
          <ChevronDown size={14} className="muted" />
        </button>
      </div>
      <div className="row">
        <button
          className="icon-btn"
          title={`Farbschema: ${THEME_LABEL[theme]} (klicken zum Wechseln)`}
          aria-label={`Farbschema: ${THEME_LABEL[theme]}. Wechseln zu ${THEME_LABEL[THEME_NEXT[theme]]}`}
          onClick={() => void useStore.getState().updateSettings({ theme: THEME_NEXT[theme] })}
        >
          <ThemeIcon size={17} />
        </button>
        <button className="icon-btn" title="Einstellungen" aria-label="Einstellungen" onClick={() => openDialog({ type: 'settings' })}>
          <Settings size={17} />
        </button>
      </div>
    </header>
  )
}
