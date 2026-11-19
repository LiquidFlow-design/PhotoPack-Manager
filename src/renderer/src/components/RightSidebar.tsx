import { Check, Eye, FolderOutput, GripVertical, Minus, MoreHorizontal, PackagePlus, PanelRightClose, PanelRightOpen, Send } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { triState } from '@shared/assignment'
import type { PackageInfo, QuickAssignMode } from '@shared/types'
import { api } from '../lib/api'
import { chooseDirFlow } from '../lib/flows'
import { FolderMenu } from './FolderMenu'
import { useStore } from '../state/store'

export function createPackageFlow(): void {
  const s = useStore.getState()
  if (!s.project) return
  const pid = s.project.id
  s.openDialog({
    type: 'prompt',
    title: 'Neues Paket',
    label: 'Name des Pakets (z. B. Person oder Verwendungszweck)',
    initial: '',
    confirmLabel: 'Paket erstellen',
    onSubmit: async (name) => {
      const p = await api.packages.create(pid, name)
      await useStore.getState().refreshPackages()
      useStore.getState().toast('success', `Paket „${p.name}“ erstellt${p.shortcut ? ` (Taste ${p.shortcut})` : ''}.`)
    }
  })
}

const QA_LABEL: Record<QuickAssignMode, string> = {
  stay: 'Bild bleibt geöffnet',
  advance: 'Nach Zuordnung weiter',
  stage: 'Mehrere wählen, dann Enter'
}

export function PackageButton({ p, compact = false }: { p: PackageInfo; compact?: boolean }) {
  const selection = useStore((s) => s.selection)
  const assignments = useStore((s) => s.assignments)
  const staged = useStore((s) => s.staged)
  const quick = useStore((s) => s.settings?.quickAssign)
  const t = useMemo(() => triState(assignments, selection, p.id), [assignments, selection, p.id])
  const isStaged = staged.has(p.id)
  const label =
    selection.size === 0
      ? `${p.mediaCount.toLocaleString('de-DE')} Medien`
      : t.state === 'none'
        ? 'nicht zugeordnet'
        : t.state === 'all'
          ? selection.size > 1
            ? `alle ${t.total} zugeordnet`
            : 'zugeordnet'
          : `${t.count} von ${t.total} zugeordnet`
  const onClick = () => {
    const s = useStore.getState()
    if (quick === 'stage') s.toggleStage(p.id)
    else void s.togglePackage(p.id)
  }
  return (
    <button
      className={`pkg state-${selection.size ? t.state : 'none'}${isStaged ? ' staged' : ''}`}
      style={{ ['--pkg' as string]: p.color }}
      onClick={onClick}
      aria-pressed={t.state === 'all' ? 'true' : t.state === 'partial' ? 'mixed' : 'false'}
      title={p.effectiveTargetDir ? `Ziel: ${p.effectiveTargetDir}` : 'Kein Zielordner festgelegt'}
    >
      <span className="pkg-check" aria-hidden="true">
        {selection.size > 0 && t.state === 'all' && <Check size={13} strokeWidth={3} />}
        {selection.size > 0 && t.state === 'partial' && <Minus size={13} strokeWidth={3} />}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="row" style={{ gap: 6 }}>
          <span className="dot" style={{ background: p.color }} />
          <span className="pkg-name ellipsis">{p.name}</span>
        </span>
        {!compact && (
          <span className="pkg-meta ellipsis" style={{ display: 'block' }}>
            {label}
            {selection.size === 0 && p.mediaCount > 0 && (p.pendingCount > 0 ? ` · ${p.pendingCount} ausstehend` : ' · exportiert')}
            {p.activeJobCount > 0 && ' · überträgt …'}
          </span>
        )}
      </span>
      {compact && <span className="sr-only">{label}</span>}
      {p.shortcut != null && (
        <span className="kbd">
          <span className="sr-only">Taste </span>
          {p.shortcut}
        </span>
      )}
    </button>
  )
}

/** Paketliste mit Drag & Drop zum Umsortieren (Griff links) und Paketansicht. */
function PackageList() {
  const packages = useStore((s) => s.packages)
  const packageView = useStore((s) => s.packageView)
  const project = useStore((s) => s.project)
  const drag = useRef<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null)
  const s = useStore.getState()

  const commit = async () => {
    const from = drag.current
    const d = drop
    drag.current = null
    setDrop(null)
    if (!from || !d || from === d.id || !project) return
    const ids = packages.map((p) => p.id).filter((x) => x !== from)
    let at = ids.indexOf(d.id)
    if (d.after) at++
    ids.splice(at, 0, from)
    useStore.setState({ packages: ids.map((id) => packages.find((p) => p.id === id)!) })
    await api.packages.reorder(project.id, ids)
  }
  const move = async (id: string, delta: number) => {
    if (!project) return
    const ids = packages.map((p) => p.id)
    const i = ids.indexOf(id)
    const j = i + delta
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    useStore.setState({ packages: ids.map((x) => packages.find((p) => p.id === x)!) })
    await api.packages.reorder(project.id, ids)
  }

  return (
    <div role="group" aria-label="Pakete zuordnen" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {packages.map((p) => (
        <div
          key={p.id}
          className={'pkg-row' + (drop?.id === p.id ? (drop.after ? ' drop-after' : ' drop-before') : '') + (drag.current === p.id ? ' dragging' : '')}
          onDragOver={(e) => {
            if (!drag.current) return
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            const after = e.clientY > r.top + r.height / 2
            if (drop?.id !== p.id || drop.after !== after) setDrop({ id: p.id, after })
          }}
          onDrop={(e) => {
            e.preventDefault()
            void commit()
          }}
        >
          <span
            className="grip"
            draggable
            role="button"
            tabIndex={0}
            aria-label={`${p.name} verschieben (Strg+Pfeil hoch/runter)`}
            title="Ziehen zum Umsortieren"
            onDragStart={(e) => {
              drag.current = p.id
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', p.id)
            }}
            onDragEnd={() => {
              drag.current = null
              setDrop(null)
            }}
            onKeyDown={(e) => {
              if (e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault()
                e.stopPropagation()
                void move(p.id, e.key === 'ArrowUp' ? -1 : 1)
              }
            }}
          >
            <GripVertical size={14} />
          </span>
          <PackageButton p={p} />
          <button
            className={'icon-btn ghost sm' + (packageView === p.id ? ' active' : '')}
            title="Paket ansehen und sortieren"
            aria-label={`Paket ${p.name} ansehen`}
            onClick={() => (packageView === p.id ? s.closePackageView() : void s.openPackageView(p.id))}
          >
            <Eye size={15} />
          </button>
          <button className="icon-btn ghost sm" title="Paket bearbeiten" aria-label={`Paket ${p.name} bearbeiten`} onClick={() => s.openDialog({ type: 'package', packageId: p.id })}>
            <MoreHorizontal size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function RightSidebar({ collapsed, auto }: { collapsed: boolean; auto: boolean }) {
  const s = useStore()
  const { packages, selection, settings, project, staged } = s
  const width = settings!.layout.rightWidth
  const setCollapsed = (v: boolean) => void s.updateSettings({ layout: { ...settings!.layout, rightCollapsed: v } })

  if (collapsed) {
    return (
      <aside className="sidebar glass collapsed" aria-label="Pakete (eingeklappt)">
        <div className="collapsed-rail">
          <button className="icon-btn ghost" title={auto ? 'Fenster zu schmal – automatisch eingeklappt' : 'Seitenleiste ausklappen'} aria-label="Rechte Seitenleiste ausklappen" onClick={() => setCollapsed(false)} disabled={auto}>
            <PanelRightOpen size={17} />
          </button>
          {packages.map((p) => (
            <button
              key={p.id}
              className="icon-btn ghost"
              title={`${p.name}${p.shortcut ? ` (Taste ${p.shortcut})` : ''}`}
              aria-label={`Paket ${p.name} umschalten`}
              onClick={() => (settings!.quickAssign === 'stage' ? s.toggleStage(p.id) : void s.togglePackage(p.id))}
            >
              <span className="dot" style={{ background: p.color, width: 12, height: 12 }} />
            </button>
          ))}
          <button className="icon-btn ghost" title="Exportvorschau" aria-label="Exportvorschau öffnen" onClick={() => s.openDialog({ type: 'export' })}>
            <Send size={16} />
          </button>
        </div>
      </aside>
    )
  }

  const pendingTotal = packages.reduce((a, p) => a + p.pendingCount, 0)

  return (
    <aside className="sidebar glass" style={{ width }} aria-label="Pakete">
      <div className="sidebar-scroll">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="h-section">Zielpakete</div>
          <div className="row" style={{ gap: 2 }}>
            <span className="tiny muted">{packages.length}</span>
            <button className="icon-btn ghost sm" title="Seitenleiste einklappen" aria-label="Rechte Seitenleiste einklappen" onClick={() => setCollapsed(true)}>
              <PanelRightClose size={15} />
            </button>
          </div>
        </div>
        <PackageList />
        <button className="add-btn" style={{ marginTop: 8 }} onClick={createPackageFlow}>
          <PackagePlus size={16} /> Neues Paket erstellen
        </button>

        {staged.size > 0 && (
          <div className="callout info" style={{ marginTop: 10 }}>
            <span style={{ flex: 1 }}>{staged.size} vorgemerkt</span>
            <button className="btn sm primary" onClick={() => void s.commitStaged()}>
              Übernehmen
            </button>
          </div>
        )}

        <div className="divider" />
        <div className="h-section">Auswahl</div>
        <div className="small" aria-live="polite">
          {selection.size ? `${selection.size.toLocaleString('de-DE')} ${selection.size === 1 ? 'Medium' : 'Medien'} ausgewählt` : 'Keine Medien ausgewählt'}
        </div>
        <label className="field-label" htmlFor="qa-mode" style={{ display: 'block', marginTop: 10 }}>
          Schnellzuordnung
        </label>
        <select id="qa-mode" className="select" style={{ marginTop: 5 }} value={settings!.quickAssign} onChange={(e) => void s.updateSettings({ quickAssign: e.target.value as QuickAssignMode })}>
          {(Object.keys(QA_LABEL) as QuickAssignMode[]).map((k) => (
            <option key={k} value={k}>
              {QA_LABEL[k]}
            </option>
          ))}
        </select>

        <div className="divider" />
        <div className="h-section">Ausgabe</div>
        <div className="hint ellipsis" title={project?.outputDir ?? ''}>
          {project?.outputDir ? (
            <>
              Global: <span className="mono">{project.outputDir}</span>
            </>
          ) : (
            <span className="warn">Kein globaler Ausgabeordner festgelegt</span>
          )}
        </div>
        <div style={{ marginTop: 8 }}>
          <FolderMenu className="btn block" onPick={(id) => void chooseDirFlow('output', undefined, id)}>
            <FolderOutput size={15} /> Ausgabeordner wählen
          </FolderMenu>
        </div>
      </div>
      {/* Immer sichtbar, auch auf kleinen Bildschirmen */}
      <div className="sidebar-foot">
        <button className="btn primary block" onClick={() => s.openDialog({ type: 'export' })}>
          <Send size={15} /> Exportvorschau öffnen{pendingTotal ? ` (${pendingTotal.toLocaleString('de-DE')})` : ''}
        </button>
      </div>
    </aside>
  )
}
