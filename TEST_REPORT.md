# Testbericht

**Stand:** 18.11.2026 · Version 1.0.0-beta.1
**Umgebung der Testläufe:** Linux x64 (Ubuntu 24.04, Container), Node.js 22.23, Electron 44.11,
Chromium-Rendering unter Xvfb (Software-Rendering, keine GPU). **Nicht** auf einem echten Windows-System
ausgeführt – siehe „Nicht geprüft“.

Alle Angaben unten stammen aus tatsächlich ausgeführten Läufen. Destruktive Tests verwenden ausschließlich
generierte Dateien in temporären Ordnern.

## 1. Zusammenfassung

| Suite | Befehl | Ergebnis |
|---|---|---|
| Unit + Integration (Vitest) | `npm test` | **86 / 86 bestanden** (9 Dateien) |
| Electron-E2E (Playwright) | `npm run test:e2e` | **10 / 10 bestanden** (2 Wiederholungsläufe stabil) |
| UI-Leistung 12 000 Medien (Playwright) | `npx playwright test perf` | bestanden |
| Skalierung 12 000 Medien (Vitest) | `npm run test:perf` | **6 / 6 bestanden** |
| Typprüfung | `npm run typecheck` | fehlerfrei (Main, Renderer, E2E) |
| Gepackte App (Linux-Variante desselben asar-Layouts) | `node scripts/smoke.mjs … release/linux-unpacked/photopack-manager` | Start, Indexierung, Vorschauen (Bild/Video), Decoder-Status ok |
| Windows-Build | `electron-builder --win portable zip --x64` | portable EXE + ZIP erzeugt; **NSIS-Installer nicht** (Wine-Absturz in der Build-Umgebung) |

## 2. Abdeckung der Pflicht-Testfälle (Auftrag §9)

| Anforderung | Test(s) | Status |
|---|---|---|
| Projekt erstellen, schließen, wieder öffnen; Einstellungen/Zuordnungen bleiben | `projects.test.ts` „Projekt erstellen, schließen, wieder öffnen …“; E2E „Theme umschalten und Persistenz nach Neustart“ | ✓ |
| Filter-Popover, Kombinationen, Chips, Clear-all, Tastatur | `filters.test.ts` (8 Tests); E2E „Filter-Popover …“ (Esc schließt, Badge-Zähler, Chips entfernen, Zurücksetzen) | ✓ |
| Einzel-/Mehrfachauswahl, Tri-State | `assignment.test.ts` (5); E2E „Einzelauswahl + Taste 1, Tri-State …, Strg+Z“ (Strg-/Shift-Klick, teilweise→ergänzen→entfernen) | ✓ |
| 1–9-Kürzel, automatischer/manueller Wechsel | E2E „Schnellzuordnung: automatisch weiter und ‚mehrere wählen, dann Enter‘“; E2E „Paketkürzel werden während Texteingabe nicht ausgelöst“ | ✓ |
| Sofort-/Sammelmodus, Wechsel bei laufenden Jobs, Copy/Move-Snapshot | `engine.test.ts` „Snapshot bleibt bei Moduswechsel unverändert“, „Moduswechsel während eines laufenden Sofortauftrags …“; E2E Sammel- und Sofortmodus | ✓ |
| Ein Medium in mehreren Paketen | `engine.test.ts` „ein Medium in mehreren Paketen“, „Mehrfachzuordnung: Quelle erst nach allen Zielkopien entfernt“ | ✓ |
| Zusätzliche Pakete **nach** dem ersten Sofort-Verschieben | `engine.test.ts` „Sofortmodus: weiteres Paket nach dem ersten Verschieben …“, „schnelle Folgezuordnungen (zwei Aufträge) verlieren nichts“; E2E „Sofortmodus + Verschieben, danach weiteres Paket …“ | ✓ |
| Gleiche Dateinamen | „löst gleiche Dateinamen deterministisch auf“ | ✓ |
| Identische Inhalte | „überspringt identische vorhandene Zieldatei …“; Duplikaterkennung | ✓ |
| Veränderte Quelle | „erkennt veränderte Quelle nach der Planung“ (Quelle bleibt, `SOURCE_KEPT`) | ✓ |
| Fehlende Quelle | „meldet fehlende Quelle“ | ✓ |
| Fehlender/unerreichbarer Zielordner | „blockiert Plan ohne Zielordner und bei unerreichbarem Ziel“ | ✓ |
| Gesperrte Datei | „gesperrte Datei: automatische Wiederholung“, „dauerhaft gesperrt …“ (simuliert per `EBUSY`) | ✓ (Simulation) |
| Unzureichender Speicherplatz | „Speicher voll: Abbruch ohne Teildatei …“ (`ENOSPC`), „… Platzprüfung blockiert den Plan“ | ✓ (Simulation) |
| Simulierte Abstürze zwischen Kopie, Hash, Commit, Recovery, Quellentfernung | `crash.test.ts`: 7 Punkte gleicher Datenträger, 3 Punkte über Datenträgergrenze (`/dev/shm`), 1 Punkt Wiederherstellung – jeweils Neustart, Abgleich, Fortsetzen; geprüft: jede Zieldatei genau einmal mit korrektem Hash, Quelle vollständig im Recovery-Bereich, keine Zwischendateien | ✓ |
| RAW ohne Vorschau, Video ohne unterstützten Codec, beschädigte Dateien | `media-tools.test.ts` (RAW ohne eingebettete Vorschau, defektes JPEG, MKV/MPEG-4, hängender Decoder) | ✓ |
| Recovery-Wiederherstellung, 30-Tage-Ablauf, sichere Bereinigung | `recovery.test.ts` (8 Tests: Original-/Alternativpfad, Konflikt, gehaltene nie bereinigt, Ablauf 29/31 Tage, Mindestfrist, Protokoll) | ✓ |
| 10k+ synthetische Medien, UI-Reaktionsfähigkeit, Cache-Verhalten | `tests/perf/scale.test.ts`, `tests/e2e/perf.spec.ts`; Cache-Invalidierung in `media-tools.test.ts` | ✓ |

Weitere Tests: Indexierung (Formate, Ausschluss von Ausgabeordnern in der Quelle, Symlink-Schleifen,
Re-Scan neu/geändert/fehlend, nicht erreichbare Quelle), Quellprüfung (verschachtelt, in Ausgabe/Recovery),
Paketverwaltung (Namenskonflikte, Kürzeltausch, Löschen ohne Dateiverlust), Migrationen (WAL, Fremdschlüssel),
Idempotenz, Pause/Fortsetzen/Abbruch, Fehler nach atomarem Verschieben, Rückfall auf verifizierte Exportkopie
(manipulierte Kopie wird abgelehnt).

## 3. Leistungsmessungen (12 000 synthetische Medien)

Container ohne GPU, lokale SSD, Dateien sehr klein (Metadaten-/Verwaltungsaufwand dominiert). Werte sind
Einzelmessungen; auf Windows mit NTFS, Virenscanner und echten Mediengrößen sind andere Werte zu erwarten.

**Kern (Vitest, `npm run test:perf`)**

| Messung | Wert |
|---|---|
| Indexierung 12 000 Dateien (24 Ordner) | 0,72 s |
| Erneute Indexierung, unverändert | 0,51 s |
| Medienliste aus SQLite laden | 9 ms (≈ 3,7 MB als JSON) |
| Filtern + Sortieren (alle, nach Name) | 22 ms |
| Filtern (Typ + Suche) + Sortieren nach Größe | 5 ms |
| 15 000 Zuordnungen speichern | 46 ms |
| Exportplan mit 15 000 Vorgängen | 0,55 s |
| Duplikatprüfung (11 998 Kandidaten gehasht) | 2,1 s |
| Export 15 000 kleine Dateien (Kopie + fsync + SHA-256-Verifikation + Commit) | 42,5 s ≈ **353 Dateien/s** |
| Export 20 × 32 MB (Kopie + Verifikation) | 1,6 s ≈ **392 MB/s** |

Optimierung während der Entwicklung: Die Warteschlangenabfrage war zunächst quadratisch (112 Dateien/s);
mit Index `job_items(job_id, status, seq)` und EXISTS-Abfragen 3,2-fach schneller.

**Oberfläche (Playwright, `tests/e2e/perf.spec.ts`, Xvfb/Software-Rendering)**

| Messung | Wert |
|---|---|
| Quelle hinzufügen → 12 000 Medien indexiert und Raster sichtbar | 2,1 s |
| 50 × Pfeiltaste (jeweils mit Neuzeichnen) | 0,74 s (≈ 15 ms je Schritt) |
| Sprung ans Ende (Ende-Taste) | 94 ms |
| DOM-Kacheln gleichzeitig | 32 (Virtualisierung wirksam) |
| Strg+A (12 000 auswählen) | 30 ms |
| Taste 1 → 12 000 Medien zuordnen (inkl. Speichern) | 350 ms |
| Suche (inkl. 160 ms Eingabeverzögerung) | 308 ms |
| Längste Bildpause beim kontinuierlichen Scrollen (2 s) | 139 ms (Software-Rendering, parallele Vorschauerzeugung) |

Realistisches Budget (Empfehlung, nicht auf Windows gemessen): Navigation/Zuordnung < 50 ms je Aktion,
Filterwechsel < 100 ms bei 20 000 Medien; Export großer Dateien durch Datenträger begrenzt (jede Datei wird
einmal gelesen, einmal geschrieben und zur Prüfung erneut gelesen).

## 4. Windows-Build

| Artefakt | Ergebnis |
|---|---|
| `release/PhotoPack Manager-1.0.0-beta.1-portable.exe` | erzeugt (Cross-Build, unsigniert, ≈ 160 MB) |
| `release/PhotoPack Manager-1.0.0-beta.1-win-x64.zip` | erzeugt (Cross-Build, unsigniert) |
| NSIS-Installer | **nicht erzeugt**: electron-builder benötigt unter Linux Wine; Wine 9.0 stürzte in diesem Container bereits bei `wineboot` ab (`free(): invalid pointer`). Auf Windows: `npm run dist:win`. |
| Inhalt geprüft | `win-unpacked`: better-sqlite3 `win32-x64.node`, `@img/sharp-win32-x64` (libvips-DLLs), `exiftool.exe` + Perl-Laufzeit, `ffmpeg.exe`, `ffprobe.exe` liegen in `app.asar.unpacked`. |
| Start der Windows-EXE | **nicht geprüft** (kein Windows verfügbar, Wine defekt). Das identische asar-/unpacked-Layout wurde mit der gepackten Linux-Variante erfolgreich gestartet und getestet. |

Gefundener und behobener Fehler im gepackten Zustand: ExifTool lag in der Linux-Variante im asar-Archiv; ein
hängender Aufruf blockierte die Vorschauerzeugung. Behoben durch `asarUnpack` für beide ExifTool-Pakete,
Zeitlimits für alle Decoder-Aufrufe und Entkopplung von Metadaten und Vorschau (Test „hängender Decoder …“).

## 5. Nicht geprüft / bekannte Einschränkungen

* **Kein Test auf echtem Windows 10/11**: NTFS-Sperrverhalten, Virenscanner, Netzlaufwerke (SMB), externe
  Laufwerke beim Abziehen, Pfade > 260 Zeichen, Windows-Hell/Dunkel-Umschaltung, SmartScreen, Installer.
  Gesperrte Dateien und volle Datenträger sind nur simuliert (Fehlercodes `EBUSY`/`ENOSPC`).
* **Echte Kamera-RAW-Dateien** wurden nicht getestet (keine Nutzerdaten, keine frei verwendbaren Muster im
  Container); geprüft ist nur der Fehlerpfad (RAW ohne Vorschau). Die Vorschau nutzt das eingebettete JPEG
  (`JpgFromRaw`/`PreviewImage`) via ExifTool.
* Video-Wiedergabe hängt von den Codecs der Electron-Chromium-Version ab (H.264/AAC, VP8/VP9, AV1; HEVC nur mit
  Hardware-Unterstützung). Nicht abspielbare Videos zeigen einen Hinweis; Zuordnung/Export funktionieren.
* HEIC/HEIF: keine Vorschau (Decoder nicht in sharp enthalten), Export möglich.
* Hardlink-Fallback auf FAT32/exFAT/einigen NAS: kurzes Zeitfenster, in dem ein **fremdes** Programm eine
  gleichnamige Datei anlegen könnte (eigene Vorgänge sind serialisiert).
* Der Wiederherstellungsbereich bietet **keinen Schutz bei Datenträgerausfall**.
* Bildpausen beim Scrollen wurden nur unter Software-Rendering gemessen.
