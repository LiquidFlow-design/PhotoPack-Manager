import { FolderCog } from 'lucide-react'
import type { AppSettings } from '@shared/types'
import { api } from '../lib/api'
import { useStore } from '../state/store'
import { Modal } from './Modal'

export function SettingsDialog() {
  const close = useStore((s) => s.closeDialog)
  const settings = useStore((s) => s.settings)!
  const project = useStore((s) => s.project)
  const startup = useStore((s) => s.startup)
  const s = useStore.getState()
  const up = (patch: Partial<AppSettings>) => void s.updateSettings(patch).catch((e) => s.toast('error', (e as Error).message))

  return (
    <Modal title="Einstellungen" onClose={close} footer={<button className="btn primary" onClick={close}>Fertig</button>}>
      <div className="h-section">Darstellung</div>
      <div className="setting-row">
        <div>
          <div>Farbschema</div>
          
        </div>
        <div className="segmented" role="radiogroup" aria-label="Farbschema">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button key={t} role="radio" aria-checked={settings.theme === t} onClick={() => up({ theme: t })}>
              {{ system: 'System', light: 'Hell', dark: 'Dunkel' }[t]}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div>
          <div>Animationen</div>
          
        </div>
        <select className="select" style={{ width: 170 }} aria-label="Animationen" value={settings.reducedMotion} onChange={(e) => up({ reducedMotion: e.target.value as AppSettings['reducedMotion'] })}>
          <option value="system">System</option>
          <option value="on">Reduziert</option>
          <option value="off">Normal</option>
        </select>
      </div>
      <div className="setting-row">
        <div>
          <div>Vorschaugröße im Raster</div>
          <div className="desc">{settings.thumbSize} px</div>
        </div>
        <input type="range" min={110} max={320} step={10} aria-label="Vorschaugröße" value={settings.thumbSize} onChange={(e) => up({ thumbSize: Number(e.target.value) })} />
      </div>

      <div className="h-section" style={{ marginTop: 16 }}>
        Zuordnung
      </div>
      <div className="setting-row">
        <div>
          <div>Schnellzuordnung</div>
          
        </div>
        <select className="select" style={{ width: 230 }} aria-label="Schnellzuordnung" value={settings.quickAssign} onChange={(e) => up({ quickAssign: e.target.value as AppSettings['quickAssign'] })}>
          <option value="stay">Bild bleibt geöffnet</option>
          <option value="advance">Automatisch zum nächsten Bild</option>
          <option value="stage">Mehrere Pakete wählen, dann Enter</option>
        </select>
      </div>
      <div className="setting-row">
        <div>
          <div>Tastenkürzel 1–9</div>
          
        </div>
        <input type="checkbox" aria-label="Tastenkürzel aktiv" checked={settings.shortcutsEnabled} onChange={(e) => up({ shortcutsEnabled: e.target.checked })} />
      </div>

      <div className="setting-row">
        <div>
          <div>RAW+JPEG gemeinsam</div>
          <div className="desc">Paare gleichen Namens zusammen zuordnen und bewerten.</div>
        </div>
        <input type="checkbox" aria-label="RAW und JPEG gemeinsam" checked={settings.pairRawJpeg} onChange={(e) => up({ pairRawJpeg: e.target.checked })} />
      </div>
      <div className="setting-row">
        <div>
          <div>XMP-Sidecars mitnehmen</div>
          <div className="desc">Beim Kopieren und Verschieben.</div>
        </div>
        <input type="checkbox" aria-label="XMP-Sidecars mitnehmen" checked={settings.includeSidecars} onChange={(e) => up({ includeSidecars: e.target.checked })} />
      </div>
      <div className="setting-row">
        <div>
          <div>Startverzögerung im Sofortmodus</div>
          <div className="desc">Zeit für Strg+Z, bevor übertragen wird.</div>
        </div>
        <select className="select" style={{ width: 120 }} aria-label="Startverzögerung" value={settings.instantDelaySec} onChange={(e) => up({ instantDelaySec: Number(e.target.value) })}>
          {[0, 2, 3, 5, 10].map((n) => (
            <option key={n} value={n}>
              {n ? `${n} s` : 'Aus'}
            </option>
          ))}
        </select>
      </div>

      <div className="h-section" style={{ marginTop: 16 }}>
        Sicherheit & Wiederherstellung
      </div>
      <div className="setting-row">
        <div>
          <div>Aufbewahrungsdauer</div>
          <div className="desc">Für freigegebene Dateien.</div>
        </div>
        <div className="row">
          <input
            className="input"
            style={{ width: 80 }}
            type="number"
            min={1}
            max={3650}
            aria-label="Aufbewahrungsdauer in Tagen"
            value={settings.recoveryRetentionDays}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (v >= 1 && v <= 3650) up({ recoveryRetentionDays: v })
            }}
          />
          <span className="small muted">Tage</span>
        </div>
      </div>
      {project && (
        <div className="setting-row">
          <div style={{ minWidth: 0 }}>
            <div>Wiederherstellungsbereich dieses Projekts</div>
            <div className="desc mono ellipsis" title={project.recoveryDir}>
              {project.recoveryDir}
            </div>
            <div className="desc">Änderbar, solange der Bereich leer ist.</div>
          </div>
          <div className="row">
            <button
              className="btn sm"
              onClick={async () => {
                const r = await api.projects.chooseRecoveryDir(project.id)
                if (r.status === 'error') s.toast('error', r.message ?? '')
                if (r.status === 'chosen') {
                  const p = await api.projects.update(project.id, {})
                  useStore.setState({ project: { ...p, ui: project.ui } })
                }
              }}
            >
              <FolderCog size={13} /> Ändern
            </button>
            {project.recoveryDirCustom && (
              <button
                className="btn sm"
                onClick={async () => {
                  try {
                    const p = await api.projects.resetRecoveryDir(project.id)
                    useStore.setState({ project: { ...p, ui: project.ui } })
                  } catch (e) {
                    s.toast('error', (e as Error).message)
                  }
                }}
              >
                Standard
              </button>
            )}
          </div>
        </div>
      )}
      <div className="setting-row">
        <div>
          <div>Wiederherstellungsbereich je Laufwerk</div>
          <div className="desc">Verschieben ohne Kopie: versteckter Ordner „.photopack-recovery“ auf dem Laufwerk der Quelle.</div>
        </div>
        <input type="checkbox" aria-label="Wiederherstellungsbereich je Laufwerk" checked={settings.recoveryPerVolume} onChange={(e) => up({ recoveryPerVolume: e.target.checked })} />
      </div>
      <div className="setting-row">
        <div>
          <div>Ähnliche Bilder</div>
          <div className="desc">Empfindlichkeit der Ähnlichkeitssuche.</div>
        </div>
        <select className="select" style={{ width: 150 }} aria-label="Ähnlichkeit" value={settings.similarityThreshold} onChange={(e) => up({ similarityThreshold: Number(e.target.value) })}>
          <option value={4}>Streng</option>
          <option value={8}>Normal</option>
          <option value={12}>Locker</option>
        </select>
      </div>
      <div className="setting-row">
        <div>
          <div>Exakte Duplikaterkennung</div>
          <div className="desc">Automatisch nach jeder Indexierung.</div>
        </div>
        <input type="checkbox" aria-label="Duplikaterkennung aktiv" checked={settings.duplicateDetection} onChange={(e) => up({ duplicateDetection: e.target.checked })} />
      </div>

      <div className="h-section" style={{ marginTop: 16 }}>
        System
      </div>
      <div className="setting-row">
        <div>
          <div>Vorschau-Cache</div>
          
        </div>
        <button className="btn sm" onClick={() => void api.app.clearThumbCache().then(() => s.toast('info', 'Vorschau-Cache geleert.'))}>
          Cache leeren
        </button>
      </div>
      <div className="setting-row">
        <div>
          <div>Programmdaten</div>
          <div className="desc mono ellipsis">{startup?.userDataDir}</div>
          <div className="desc">
            Version {startup?.version} · Decoder: Bilder {startup?.tools.sharp ? '✓' : '–'}, RAW/EXIF {startup?.tools.exiftool ? '✓' : '–'}, Video {startup?.tools.ffmpeg ? '✓' : '–'}
          </div>
        </div>
        <button className="btn sm" onClick={() => void api.app.openLogFolder()}>
          Ordner öffnen
        </button>
      </div>
    </Modal>
  )
}
