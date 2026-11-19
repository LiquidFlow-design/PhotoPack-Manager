import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './lib/api'
import { isDark, useStore } from './state/store'
import { Header } from './components/Header'
import { LeftSidebar } from './components/LeftSidebar'
import { RightSidebar } from './components/RightSidebar'
import { Toolbar } from './components/Toolbar'
import { MediaGrid } from './components/MediaGrid'
import { FocusView } from './components/FocusView'
import { StatusBar } from './components/StatusBar'
import { Resizer } from './components/Resizer'
import { Toasts } from './components/Toasts'
import { DialogHost } from './dialogs/DialogHost'
import { Welcome } from './components/Welcome'
import { DropZone } from './components/DropZone'
import { ContextMenu } from './components/ContextMenu'
import { useKeyboard } from './lib/keyboard'

const MIN_CENTER = 400
const PADDING = 24 + 20

export function App() {
  const ready = useStore((s) => s.ready)
  const project = useStore((s) => s.project)
  const settings = useStore((s) => s.settings)
  const darkSystem = useStore((s) => s.darkSystem)
  const view = useStore((s) => s.view)
  const contextMenu = useStore((s) => s.contextMenu)
  const closeMenu = useCallback(() => useStore.setState({ contextMenu: null }), [])
  const [winW, setWinW] = useState(window.innerWidth)

  useEffect(() => {
    void useStore.getState().init()
    const off = api.onEvent((e) => useStore.getState().handleEvent(e))
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onMq = () => useStore.setState({ darkSystem: mq.matches })
    mq.addEventListener('change', onMq)
    const onResize = () => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => {
      off()
      mq.removeEventListener('change', onMq)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  useKeyboard()

  // Theme: manuelle Einstellung hat Vorrang vor System
  const dark = isDark(settings, darkSystem)
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])
  useEffect(() => {
    const m = settings?.reducedMotion ?? 'system'
    if (m === 'system') delete document.documentElement.dataset.motion
    else document.documentElement.dataset.motion = m === 'on' ? 'reduced' : 'full'
  }, [settings?.reducedMotion])

  const layout = settings?.layout
  // Bei engen Fenstern automatisch einklappen (links zuerst), ohne die gespeicherte Präferenz zu ändern
  const { leftCollapsed, rightCollapsed } = useMemo(() => {
    if (!layout) return { leftCollapsed: false, rightCollapsed: false }
    let lc = layout.leftCollapsed
    let rc = layout.rightCollapsed
    const avail = winW - PADDING
    const need = () => (lc ? 44 : layout.leftWidth) + (rc ? 44 : layout.rightWidth) + MIN_CENTER
    // Quellenleiste zuerst einklappen – die Paketleiste wird zum Zuordnen gebraucht
    if (need() > avail && !lc) lc = true
    if (need() > avail && !rc) rc = true
    return { leftCollapsed: lc, rightCollapsed: rc }
  }, [layout, winW])
  const autoCollapsed = !!layout && (leftCollapsed !== layout.leftCollapsed || rightCollapsed !== layout.rightCollapsed)

  if (!ready || !settings) {
    return (
      <div className="app" aria-busy="true">
        <div className="welcome">
          <div className="row muted">
            <div className="spinner" /> PhotoPack Manager wird geladen …
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <Header />
      {project ? (
        <div className="workspace">
          <LeftSidebar collapsed={leftCollapsed} auto={autoCollapsed && leftCollapsed && !layout!.leftCollapsed} />
          <Resizer side="left" disabled={leftCollapsed} />
          <main className="main glass" aria-label="Medienübersicht">
            <Toolbar />
            {view === 'grid' ? <MediaGrid /> : <FocusView />}
          </main>
          <Resizer side="right" disabled={rightCollapsed} />
          <RightSidebar collapsed={rightCollapsed} auto={autoCollapsed && rightCollapsed && !layout!.rightCollapsed} />
        </div>
      ) : (
        <Welcome />
      )}
      <StatusBar />
      <Toasts />
      <DialogHost />
      <DropZone />
      {contextMenu && <ContextMenu at={contextMenu} onClose={closeMenu} />}
    </div>
  )
}
