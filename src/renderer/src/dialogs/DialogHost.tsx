import { useState } from 'react'
import { useStore } from '../state/store'
import { Modal } from './Modal'
import { SettingsDialog } from './SettingsDialog'
import { ProjectsDialog } from './ProjectsDialog'
import { ExportDialog } from './ExportDialog'
import { JobsDialog } from './JobsDialog'
import { RecoveryDialog } from './RecoveryDialog'
import { DuplicatesDialog } from './DuplicatesDialog'
import { SourcesDialog } from './SourcesDialog'
import { PackageDialog } from './PackageDialog'

export function DialogHost() {
  const d = useStore((s) => s.dialog)
  const close = useStore((s) => s.closeDialog)
  if (!d) return null
  switch (d.type) {
    case 'settings':
      return <SettingsDialog />
    case 'projects':
      return <ProjectsDialog />
    case 'export':
      return <ExportDialog packageIds={d.packageIds ?? null} />
    case 'jobs':
      return <JobsDialog initialJob={d.jobId} />
    case 'recovery':
      return <RecoveryDialog />
    case 'duplicates':
      return <DuplicatesDialog />
    case 'sources':
      return <SourcesDialog />
    case 'package':
      return <PackageDialog packageId={d.packageId} />
    case 'info':
      return (
        <Modal title={d.title} onClose={close} size="narrow" footer={<button className="btn primary" onClick={close}>OK</button>}>
          <p className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {d.message}
          </p>
        </Modal>
      )
    case 'confirm':
      return <ConfirmDialog {...d} />
    case 'prompt':
      return <PromptDialog {...d} />
  }
}

function ConfirmDialog(d: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void> }) {
  const close = useStore((s) => s.closeDialog)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      close()
      await d.onConfirm()
    } catch (e) {
      useStore.getState().toast('error', (e as Error).message)
    }
  }
  return (
    <Modal
      title={d.title}
      onClose={close}
      size="narrow"
      footer={
        <>
          <button className="btn" onClick={close}>
            Abbrechen
          </button>
          <button className={'btn ' + (d.danger ? 'danger solid' : 'primary')} disabled={busy} onClick={() => void go()}>
            {d.confirmLabel}
          </button>
        </>
      }
    >
      <p className="small" style={{ whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.55 }}>
        {d.message}
      </p>
    </Modal>
  )
}

function PromptDialog(d: { title: string; label: string; initial: string; confirmLabel: string; onSubmit: (v: string) => void | Promise<void> }) {
  const close = useStore((s) => s.closeDialog)
  const [v, setV] = useState(d.initial)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!v.trim()) {
      setErr('Bitte einen Namen eingeben.')
      return
    }
    setBusy(true)
    try {
      await d.onSubmit(v.trim())
      close()
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal
      title={d.title}
      onClose={close}
      size="narrow"
      footer={
        <>
          <button className="btn" onClick={close}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void submit()}>
            {d.confirmLabel}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="field">
          <label htmlFor="prompt-input">{d.label}</label>
          <input id="prompt-input" className="input" autoFocus value={v} maxLength={120} onChange={(e) => setV(e.target.value)} aria-invalid={!!err} aria-describedby="prompt-err" />
          {err && (
            <div id="prompt-err" className="tiny err">
              {err}
            </div>
          )}
        </div>
      </form>
    </Modal>
  )
}
