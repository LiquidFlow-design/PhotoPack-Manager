# PhotoPack Manager – Architektur

## 1. Überblick

```
┌──────────────────────── Electron Main-Prozess (Node) ────────────────────────┐
│  index.ts        Lebenszyklus, Fenster, Single-Instance, Beenden mit Pause      │
│  ipc.ts          Validierte IPC-Handler (zod), native Ordnerdialoge             │
│  protocol.ts     ppm://thumb|preview|media/<id>  (Range-fähig, nur IDs)         │
│  services/                                                                      │
│    app-service.ts   Orchestrierung: Projekte öffnen, Indexierung, Pläne, Events │
│    media-tools.ts   Vorschauen/Metadaten (sharp, ExifTool, FFmpeg/ffprobe)      │
│  core/   (ohne Electron-Abhängigkeit → in Vitest direkt testbar)                │
│    engine.ts        Persistente Auftragswarteschlange + Zustandsautomaten       │
│    planner.ts       Exportplan als Snapshot, Konflikte, Platzprüfung            │
│    recovery.ts      Wiederherstellungsbereich: halten/freigeben/bereinigen      │
│    sources.ts       Quellen, Ausschlüsse, Indexierung                           │
│    assignments.ts   Zuordnungen; Sofortmodus erzeugt Aufträge                   │
│    packages.ts, projects.ts, settings.ts, duplicates.ts, paths.ts, fsx.ts       │
│    fileops.ts + file-worker.ts + worker-pool.ts  Kopieren/Hashen in Workern     │
│  db/  database.ts (WAL, FK, Migrationen), migrations.ts                         │
└───────────────▲─────────────────────────────────────────────▲──────────────────┘
                │ contextBridge (preload/index.ts, Sandbox)    │ ppm:// (nur Medien-IDs)
┌───────────────┴──────────── Renderer (React, ohne Node) ─────┴──────────────────┐
│  state/store.ts (zustand)  · components/ (Header, Seitenleisten, Toolbar,         │
│  FilterPopover, MediaGrid (virtualisiert), FocusView, StatusBar) · dialogs/       │
│  shared/ filters.ts, assignment.ts (reine, getestete Logik)                       │
└──────────────────────────────────────────────────────────────────────────────────┘
```

* **Renderer** hat keinen Node-Zugriff (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`),
  strikte CSP im Produktions-Build, keine Navigation/neuen Fenster, alle Berechtigungsanfragen werden abgelehnt.
* **Keine Pfade aus dem Renderer**: Ordner werden ausschließlich über native Dialoge im Main-Prozess gewählt.
  Bestätigungspflichtige Pfade (z. B. Ausgabeordner innerhalb einer Quelle) werden im Main-Prozess unter
  einem Einmal-Token vorgemerkt; der Renderer bestätigt nur das Token.
* **Medienzugriff** über das eigene Schema `ppm://`: Der Renderer kennt nur Medien-IDs; der Main-Prozess liest den
  Pfad aus der Datenbank. Range-Requests für Video-Seeking werden unterstützt.
* **Single-Instance-Lock** verhindert zwei Prozesse auf derselben Datenbank.

## 2. IPC

Alle Kanäle heißen `ppm:<gruppe>.<methode>` und werden aus `API_METHODS` (src/shared/api.ts) abgeleitet, damit
Preload und Main nicht auseinanderlaufen. Jeder Handler hat ein zod-Tupelschema; ungültige Eingaben werden
abgelehnt. Antworten haben die Form `{ ok: true, value } | { ok: false, error }`. Absender werden auf das eigene
Fenster (`file://` bzw. Dev-Server) geprüft.

| Gruppe | Methoden |
|---|---|
| app | startup, getSettings, updateSettings, clearThumbCache, openLogFolder |
| projects | list, create, open, rename, remove, update, saveUi, chooseOutputDir, clearOutputDir, chooseRecoveryDir, resetRecoveryDir, tasks, cancelTask |
| sources | add, confirmAdd, rescan, remove, list |
| media | list, rows, detail, reveal, revealPath |
| packages | list, create, update, remove, chooseTargetDir, clearTargetDir, openTarget |
| assign | apply, list |
| exports | preview, start |
| jobs | list, items, pause, resume, cancel, retry |
| recovery | overview, restore, release, hold, purge, openFolder |
| duplicates | scan, groups |

Ereignisse Main → Renderer über `ppm:event` (`AppEvent`): media-changed (voll oder ID-Liste; Vorschau-Ereignisse
werden zu 150-ms-Bündeln zusammengefasst), packages-/assignments-/sources-/jobs-changed, task-progress,
recovery-changed, theme-changed, notice.

## 3. Datenbankschema (SQLite, WAL, Fremdschlüssel)

Eine Datenbank `photopack.sqlite` im Benutzerdatenordner enthält alle Projekte. Migrationen über
`PRAGMA user_version` (src/main/db/migrations.ts), jede Migration in einer Transaktion.

| Tabelle | Zweck / wichtige Felder |
|---|---|
| `app_settings` | globale UI-Einstellungen (Theme, Layout, Schnellzuordnung, Aufbewahrung …) als JSON |
| `projects` | Name, Ausgabeordner, Modus (collect/instant), Operation (copy/move), Konfliktregel, eigener Recovery-Ordner, `ui_state` (Filter/Sortierung je Projekt) |
| `sources` | Quellordner, `real_path` (Symlinks aufgelöst), Scanstatus, Ausschlüsse |
| `media` | `original_path`, `path_key` (eindeutig je Projekt), `current_path` (kanonischer Ort), `location` (source/recovery/missing), Größe, mtime, SHA-256, Metadaten, Vorschau-Status, Duplikatgruppe. **Keine BLOBs.** |
| `packages` | Name (eindeutig je Projekt), Farbe, Kürzel 1–9 (partiell eindeutig), individueller Zielordner |
| `media_packages` | Zuordnung n:m |
| `jobs` | Auftrag: Art, Modus, Operation, Konfliktregel, Status, Snapshot-Zusammenfassung, `interrupted` |
| `job_items` | Einzelvorgang: Art (copy/release_source/restore), **Snapshot** (src_path, src_size, src_mtime, src_sha256, dest_dir, dest_name), Zwischendatei, Endpfad, Ergebnis-Hash, Versuche, Fehler; **Idempotenzschlüssel** mit partiellem Unique-Index (`WHERE active = 1`) |
| `job_item_events` | zeitgestempelte Statusübergänge jedes Eintrags |
| `transfer_destinations` | erfolgreich erzeugte/erkannte Zieldateien je (Medium, Paket) inkl. SHA-256 – verhindert Doppelexport |
| `recovery_items` | Dateien im Wiederherstellungsbereich: Originalpfad, Pfad, Hash, Status, Frist |
| `operation_log` | Protokoll aller relevanten Aktionen (inkl. Löschungen im Wiederherstellungsbereich) |

Indizes: u. a. `media(project_id, size)` (Duplikatkandidaten), `media(project_id, sha256)`,
`job_items(job_id, status, seq)` (Warteschlange in O(log n) je Auswahl).

## 4. Zustandsautomaten und Invarianten

### Invarianten

* **I1** Eine Quelldatei wird erst entfernt, wenn **alle** Zielkopien ihres Auftrags verifiziert vorliegen **und**
  eine Kopie im Wiederherstellungsbereich existiert (gleicher Datenträger: atomare Umbenennung; anderer
  Datenträger: Kopie → SHA-256-Prüfung → Commit → erst dann Löschen der Quelle).
* **I2** Zieldateien werden nie überschrieben: Commit per Hardlink (`EEXIST` bei Belegung), Fallback
  Existenzprüfung + Umbenennen auf Dateisystemen ohne Hardlinks; Commits je Zielordner serialisiert.
* **I3** Jede Zwischendatei `.ppm-<itemId>.tmp` liegt im Zielordner (also auf dem Ziellaufwerk) und ist im
  Auftragseintrag vermerkt, bevor sie entsteht.
* **I4** Eine abgeschlossene Übertragung (`transfer_destinations`) wird nicht erneut geplant; aktive Einträge
  sind über den Idempotenzschlüssel eindeutig (kein Doppelauftrag bei Moduswechsel/Neustart).
* **I5** Nach einem Absturz werden unterbrochene Einträge anhand des Dateisystems abgeglichen; alle offenen
  Aufträge werden pausiert und erst durch den Nutzer fortgesetzt.
* **I6** Das Entfernen einer Zuordnung, eines Pakets, einer Quelle oder eines Projekts löscht nie exportierte
  Dateien. Gehaltene Dateien im Wiederherstellungsbereich werden nie automatisch gelöscht.

### Auftrag (`jobs.status`)

```
queued ──(erster Eintrag startet)──▶ running ──(alle Einträge terminal)──▶ completed | completed_with_errors
  │  ▲                                 │  ▲
  │  └──────── resume ──── paused ◀────┘  │   (pause, Programmende, Absturz-Abgleich)
  └──────────────── cancel ───────────────┴──▶ cancelled
completed_with_errors ──retry──▶ running
```

### Kopiereintrag (`kind = copy`)

```
pending ─▶ [Quelle auflösen: aktueller Ort → Snapshot-Pfad → verifizierte Exportkopie]
        ─▶ [Ziel identisch vorhanden?] ──ja──▶ skipped(identical) + transfer_destination
        ─▶ copying      (tmp_path vermerkt; Kopie + SHA-256 der gelesenen Bytes; fsync)
        ─▶ verifying    (tmp erneut lesen und hashen; Quelle unverändert?)
        ─▶ committing   (final_path vermerkt; Hardlink/Rename ohne Überschreiben; ggf. „Name (n)“)
        ─▶ done         (transfer_destination, media.sha256)
Fehler: transient (gesperrt, I/O, Prüfsumme) → failed + retry_at (max. 3 Versuche, 2/10/30 s)
        dauerhaft (Quelle fehlt/verändert, Ziel fehlt, Speicher voll, Zugriff) → failed
Pause/Abbruch während copying/verifying → Zwischendatei gelöscht → pending | cancelled
```

### Verschiebe-Eintrag (`kind = release_source`)

```
waiting ──(alle Kopien desselben Auftrags für das Medium done/identisch)──▶ Start
        ──(eine Kopie endgültig fehlgeschlagen/übersprungen)──▶ failed(SOURCE_KEPT)  [Quelle bleibt]
Start: Quelle unverändert (Größe+mtime)? erwarteter Hash = Hash der Zielkopien
  gleicher Datenträger:  source_removing ─(rename Quelle → Recovery)─▶ done
  anderer Datenträger:   recovery_copying ─(Kopie+Hash)─▶ recovery_committed ─▶ source_removing ─(unlink)─▶ done
done: recovery_item = held, media.location = recovery, media.current_path = Recovery-Pfad
```

### Wiederherstellung (`kind = restore`)

```
pending ─▶ copying ─▶ verifying ─▶ committing (Originalpfad oder Alternativordner, ohne Überschreiben)
        ─▶ source_removing (verifizierte Wiederherstellung → Recovery-Kopie entfernen) ─▶ done
```

### Wiederherstellungsbereich (`recovery_items.status`)

```
staging ─▶ held ──(Nutzer gibt frei)──▶ released ──(Frist abgelaufen, App läuft)──▶ purged
   │        │  ▲                          │
   │        │  └────────── hold ──────────┘
   │        └──(Wiederherstellung)──▶ restored        (manuelles Löschen: held|released → purged)
   └──(Abbruch/Absturz, Quelle noch vorhanden)──▶ discarded
```

### Abgleich nach Absturz (`engine.reconcile()`)

| Zustand beim Absturz | Prüfung | Ergebnis |
|---|---|---|
| copy: copying / verifying | – | Zwischendatei löschen → pending |
| copy: committing | Endpfad existiert mit erwartetem Hash? | ja → done; nein → Zwischendatei löschen → pending |
| release: Quelle existiert noch | – | evtl. Recovery-Kopie löschen → waiting (von vorn) |
| release: Quelle fehlt, Recovery-Kopie gültig (Hash) | – | Verschieben abschließen → done |
| release: beides fehlt | – | failed + Protokoll-Fehler (extern verändert), nie stillschweigend |
| restore: committing/source_removing | Ziel mit erwartetem Hash? | ja → abschließen; nein → pending |
| verwaiste `staging`-Einträge | Quelle existiert? | nur dann Kopie verwerfen |

Diese Pfade sind durch simulierte Abstürze an 10 Fehlerpunkten getestet (tests/integration/crash.test.ts).

### Sofortmodus + Verschieben + spätere Pakete

* Ein Medium gilt als **verschoben**, sobald sein Verschiebe-Eintrag `done` ist: Die Quelle liegt verifiziert im
  projektinternen Wiederherstellungsbereich (`media.location = recovery`) und ist dort die **kanonische Quelle**.
* Spätere Paketzuordnungen erzeugen reine Kopieraufträge **aus dem Wiederherstellungsbereich**; die Quelle wird
  kein zweites Mal „verschoben“ (Idempotenzschlüssel `release:<medium>:<größe>:<mtime>`).
* Schnelle Folgezuordnungen (Taste 1, dann 2) erzeugen zwei Aufträge; der zweite liest bei Bedarf aus dem
  Wiederherstellungsbereich (Quellauflösung zur Laufzeit, Inhalt per Snapshot-Fingerprint/Hash geprüft).
* Der Modus „Mehrere Pakete wählen, dann Enter“ bündelt mehrere Ziele in **einem** Auftrag.
* Gehaltene Recovery-Dateien laufen nie automatisch ab. Erst nach ausdrücklicher Freigabe beginnt die
  Bereinigung (Frist 30 Tage ab Verschiebung, mindestens 1 Tag ab Freigabe). Wurde eine Datei bereinigt, kann
  eine verifizierte Exportkopie mit identischem SHA-256 als Quelle dienen; sonst wird das Medium als fehlend
  gemeldet.

## 5. Warteschlange

* Persistenz vollständig in SQLite; der Speicher hält nur laufende Einträge.
* Parallelität 2; nie zwei Einträge desselben Mediums gleichzeitig; Commits je Zielordner serialisiert.
* Auswahl je Auftrag (ältester zuerst) mit Index `job_items(job_id, status, seq)`.
* Kopieren und Hashen laufen in einem Worker-Thread-Pool (2 Worker); der Main-Prozess orchestriert nur.
* Statusänderungen werden gebündelt (≤ 5/s) an den Renderer gemeldet.

## 6. Vorschauen und Leistung

* Indexierung: asynchrones `opendir`, Batches à 500 in Transaktionen, keine Symlink-/Junction-Verfolgung,
  geschützte Ordner (Ausgabe, Paketziele, Recovery, Programmdaten) werden immer ausgeschlossen.
* Vorschauen: On-Demand über `ppm://thumb/<id>` mit Prioritäts-Warteschlange (sichtbare zuerst) und Hintergrund-
  vorverarbeitung niedriger Priorität; Disk-Cache `cache/thumbs/<sha1(id|size|mtime|ext)>.webp` → automatische
  Invalidierung bei Dateiänderung. RAW: eingebettete JPEG-Vorschau via ExifTool; Video: Einzelbild via FFmpeg
  (Timeout 20 s). Fehler werden je Medium vermerkt und blockieren nichts.
* Renderer: komplette Medienliste (≈ 300 Byte/Medium) im Speicher, Filtern/Sortieren 12 000 Medien ≈ 20 ms;
  zeilenweise Virtualisierung (@tanstack/react-virtual), `loading="lazy"`.
