import { api } from './api'
import { useStore } from '../state/store'

/** Quellordner hinzufügen inkl. Bestätigung, falls Ausgabe-/Wiederherstellungsordner darin liegen. */
export async function addSourceFlow(cloudRootId?: string): Promise<void> {
  const s = useStore.getState()
  if (!s.project) return
  const pid = s.project.id
  try {
    const r = await api.sources.add(pid, cloudRootId)
    if (r.status === 'error') s.toast('error', r.error ?? 'Ordner kann nicht hinzugefügt werden.')
    else if (r.status === 'added') s.toast('success', 'Quelle hinzugefügt – Indexierung läuft.')
    else if (r.status === 'needs-confirmation') {
      s.openDialog({
        type: 'confirm',
        title: 'Ordner ausschließen?',
        message: `Der Ordner „${r.path}“ enthält Ausgabe- oder Wiederherstellungsordner:\n\n${(r.exclusions ?? []).join('\n')}\n\nDiese werden dauerhaft von der Indexierung ausgeschlossen, damit exportierte Dateien nicht erneut importiert werden.`,
        confirmLabel: 'Mit Ausschluss hinzufügen',
        onConfirm: async () => {
          const c = await api.sources.confirmAdd(pid, r.confirmToken!)
          if (c.status === 'added') s.toast('success', 'Quelle hinzugefügt – Indexierung läuft.')
          else s.toast('error', c.error ?? 'Fehler')
        }
      })
    }
  } catch (e) {
    s.toast('error', (e as Error).message)
  }
}

/** Ordnerauswahl mit optionaler Bestätigung (Ausgabe- oder Paketordner). */
export async function chooseDirFlow(kind: 'output' | 'package', packageId?: string, cloudRootId?: string): Promise<void> {
  const s = useStore.getState()
  if (!s.project) return
  const pid = s.project.id
  const run = (token?: string) => (kind === 'output' ? api.projects.chooseOutputDir(pid, token, token ? undefined : cloudRootId) : api.packages.chooseTargetDir(packageId!, token, token ? undefined : cloudRootId))
  try {
    const r = await run()
    if (r.status === 'error') s.toast('error', r.message ?? 'Ordner ungeeignet.')
    else if (r.status === 'needs-confirmation') {
      s.openDialog({
        type: 'confirm',
        title: 'Zielordner innerhalb einer Quelle',
        message: r.message ?? '',
        confirmLabel: 'Ordner verwenden und ausschließen',
        onConfirm: async () => {
          const c = await run(r.confirmToken)
          if (c.status === 'chosen') afterChosen(kind)
          else s.toast('error', c.message ?? 'Fehler')
        }
      })
    } else if (r.status === 'chosen') afterChosen(kind)
  } catch (e) {
    s.toast('error', (e as Error).message)
  }
}

async function afterChosen(kind: 'output' | 'package'): Promise<void> {
  const s = useStore.getState()
  if (kind === 'output' && s.project) {
    const b = await api.projects.list()
    useStore.setState({ projects: b })
    const p = await api.projects.update(s.project.id, {})
    useStore.setState({ project: { ...p, ui: s.project.ui } })
  }
  await s.refreshPackages()
  s.toast('success', 'Zielordner gespeichert.')
}
