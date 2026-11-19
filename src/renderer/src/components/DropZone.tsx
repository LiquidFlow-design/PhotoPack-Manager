import { FolderInput } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AddSourceResult } from '@shared/api'
import { api } from '../lib/api'
import { useStore } from '../state/store'

/** Ordner aus dem Windows-Explorer ins Fenster ziehen = als Quelle hinzufügen. */
export function DropZone() {
  const [active, setActive] = useState(false)
  const depth = useRef(0)
  useEffect(() => {
    const isFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
    const enter = (e: DragEvent) => {
      if (!isFiles(e)) return
      depth.current++
      if (useStore.getState().project) setActive(true)
    }
    const over = (e: DragEvent) => {
      if (!isFiles(e)) return
      e.preventDefault() // sonst würde Chromium die Datei öffnen
      if (e.dataTransfer) e.dataTransfer.dropEffect = useStore.getState().project ? 'copy' : 'none'
    }
    const leave = (e: DragEvent) => {
      if (!isFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    }
    const drop = (e: DragEvent) => {
      if (!isFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setActive(false)
      const s = useStore.getState()
      const files = [...(e.dataTransfer?.files ?? [])]
      if (!s.project || !files.length) return
      void api
        .dropSources(s.project.id, files)
        .then((results) => handleResults(s.project!.id, results))
        .catch((err) => s.toast('error', (err as Error).message))
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])
  if (!active) return null
  return (
    <div className="dropzone" aria-live="polite">
      <div className="dropzone-card">
        <FolderInput size={34} />
        <strong>Ordner hier ablegen</strong>
        <span className="muted small">wird als Quelle hinzugefügt und indexiert</span>
      </div>
    </div>
  )
}

function handleResults(projectId: string, results: AddSourceResult[]): void {
  const s = useStore.getState()
  const added = results.filter((r) => r.status === 'added').length
  if (added) s.toast('success', `${added} Quelle(n) hinzugefügt – Indexierung läuft.`)
  for (const r of results.filter((x) => x.status === 'error')) s.toast('error', r.error ?? 'Ordner kann nicht hinzugefügt werden.')
  const confirm = results.filter((x) => x.status === 'needs-confirmation')
  const next = (i: number) => {
    const r = confirm[i]
    if (!r) return
    s.openDialog({
      type: 'confirm',
      title: 'Ordner ausschließen?',
      message: `„${r.path}“ enthält Ausgabe- oder Wiederherstellungsordner:\n\n${(r.exclusions ?? []).join('\n')}\n\nDiese werden dauerhaft von der Indexierung ausgeschlossen.`,
      confirmLabel: 'Mit Ausschluss hinzufügen',
      onConfirm: async () => {
        const c = await api.sources.confirmAdd(projectId, r.confirmToken!)
        if (c.status !== 'added') s.toast('error', c.error ?? 'Fehler')
        next(i + 1)
      }
    })
  }
  next(0)
}
