# Testbericht

**Stand:** 19.11.2026 (nach Audit, siehe AUDIT.md) · Version 1.0.0-beta.1 + Version-2-Funktionen
**Umgebung der Testläufe:** Linux x64 (Ubuntu 24.04, Container), Node.js 22.23, Electron 44.11,
Chromium-Rendering unter Xvfb (Software-Rendering, keine GPU). **Nicht** auf einem echten Windows-System
ausgeführt – siehe „Nicht geprüft“.

Alle Angaben unten stammen aus tatsächlich ausgeführten Läufen. Destruktive Tests verwenden ausschließlich
generierte Dateien in temporären Ordnern.

## 1. Zusammenfassung

| Suite | Befehl | Ergebnis |
|---|---|---|
| Unit + Integration (Vitest) | `npm test` | **109 / 109 bestanden** (12 Dateien) |
| Electron-E2E (Playwright) | `npm run test:e2e` | **19 / 19 bestanden** (Kern 10, Version 2 7, Barrierefreiheit 1, UI-Leistung 1) |
| E2E gegen **gepacktes** Programm | `PPM_E2E_EXE=release/linux-unpacked/photopack-manager npx playwright test app features` | **16 / 16 bestanden** (asar, Worker, Decoder im Paketzustand) |
| Barrierefreiheit (axe-core) | `npx playwright test a11y` | 22 Ansichten/Dialoge, hell + dunkel: **keine** schwerwiegenden/kritischen Verstöße |
| Skalierung 12 000 Medien (Vitest) | `npm run test:perf` | **7 / 7 bestanden** |
| Typprüfung | `npm run typecheck` | fehlerfrei (Main, Renderer, E2E) |
| Gepackte App (Linux-Variante desselben asar-Layouts) | `node scripts/smoke.mjs … release/linux-unpacked/photopack-manager` | Start, Indexierung, Vorschauen (Bild/Video), Decoder-Status ok |
| Windows-Build | `electron-builder --win portable zip --x64` | Stand Version 1: portable EXE + ZIP erzeugt; NSIS nicht (Wine-Absturz). **Version 2 nicht neu gebaut**: Der Download des LGPL-FFmpeg wurde in dieser Umgebung durch die Zugriffsrichtlinie blockiert. |

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

**Version 2 (`tests/integration/features-v2.test.ts`, `tests/e2e/features.spec.ts`)**

| Funktion | Test(s) | Status |
|---|---|---|
| Sidecars (`IMG.xmp`, `IMG.CR3.xmp`), verwaiste XMP ignoriert | „erkennt Sidecars …“ | ✓ |
| RAW+JPEG-Paare: gemeinsame Zuordnung/Entfernung, Export inkl. Sidecar, Sidecar-Name folgt umbenanntem Hauptmedium | 3 Integrationstests + E2E „RAW+JPEG-Paar …“ | ✓ |
| Sidecars beim Verschieben im Wiederherstellungsbereich | „Verschieben nimmt Sidecars mit …“ | ✓ |
| Paketreihenfolge: anhängen, umsortieren, persistent nach Neustart | „neue Zuordnungen werden angehängt …“ | ✓ |
| Paketansicht, **Drag & Drop**, Strg+Pfeil, Sortierung übernehmen, Entf, Strg+Z/Strg+Y | E2E „Paketansicht …“ | ✓ |
| Pakete in der Seitenleiste umsortieren (Tastatur) | E2E „Pakete per Tastatur …“ | ✓ (Drag & Drop der Pakete nur manuell im Screenshot-Lauf, nicht automatisiert) |
| ZIP-Export: Reihenfolge, Namenskollision, Sidecar, Integrität (`unzip -t`), veränderte Quelle übersprungen | „ZIP-Export folgt der Paketreihenfolge …“ | ✓ |
| Bewertungen/Farben inkl. Paarpartner; Tastatur Alt+4/Alt+6; Filter | Integration + E2E | ✓ |
| Projektsicherung: Export, Import in frische Datenbank (IDs neu, Reihenfolge, Exporte, Recovery), Doppelimport abgelehnt, defekte Datei | 2 Tests | ✓ |
| Wiederherstellungsbereich je Laufwerk (Pfadwahl für Windows simuliert) | „wählt unter Windows …“ | ✓ (Logik); echtes Verschieben auf Windows-Laufwerke **nicht getestet** |
| Projekt abschließen | „gibt alle gehaltenen Quellen frei“ | ✓ |
| Ähnliche Bilder (gleiches Motiv in anderer Größe/Qualität gruppiert, anderes Motiv nicht) | „gruppiert visuell ähnliche Bilder …“ | ✓ |
| Startverzögerung im Sofortmodus, Rückgängig innerhalb der Frist | „Sofortmodus-Gnadenfrist …“ | ✓ |
| Präsentationsfenster folgt Auswahl, Navigation zurück ins Hauptfenster | E2E „Präsentationsfenster …“ | ✓ (ein Bildschirm; Vollbild auf zweitem Monitor nicht prüfbar) |
| HEIC über WIC (Windows) | – | **nicht getestet** |
| LGPL-FFmpeg-Bezug | – | **nicht ausgeführt** (Download blockiert); Entwicklung/Tests nutzen weiterhin ffmpeg-static |

Weitere Tests: Indexierung (Formate, Ausschluss von Ausgabeordnern in der Quelle, Symlink-Schleifen,
Re-Scan neu/geändert/fehlend, nicht erreichbare Quelle), Quellprüfung (verschachtelt, in Ausgabe/Recovery),
Paketverwaltung (Namenskonflikte, Kürzeltausch, Löschen ohne Dateiverlust), Migrationen (WAL, Fremdschlüssel),
Idempotenz, Pause/Fortsetzen/Abbruch, Fehler nach atomarem Verschieben, Rückfall auf verifizierte Exportkopie
(manipulierte Kopie wird abgelehnt).

## 3. Leistungsmessungen (12 000 synthetische Medien)

**Nachmessung nach dem Audit (19.11.):** Export kleiner Dateien 238 Dateien/s, große Dateien 273 MB/s,
Indexierung 0,91 s, Duplikatprüfung 3,3 s. Die Umgebung lief in diesem Durchgang insgesamt ca. 25–40 % langsamer
(auch unveränderte Teile wie Indexierung und Hashing); ein Teil des Rückgangs beim Export stammt aus der neuen
Stromausfall-Absicherung (A5). Die Tabellen unten sind die Werte vom 18.11.

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
| 15 000 Zuordnungen speichern (inkl. Paar-/Sidecar-Erweiterung) | 110 ms |
| Exportplan mit 15 000 Vorgängen | 0,55 s |
| Duplikatprüfung (11 998 Kandidaten gehasht) | 2,3 s |
| Ähnlichkeitsgruppierung (12 000 Hashes, 72 Mio. Vergleiche) | 0,27 s, längste Event-Loop-Pause 49 ms |
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
* HEIC/HEIF: Vorschau nur unter Windows mit installierter HEIF-Erweiterung (über WIC, ungetestet); sonst „Keine Vorschau“, Export möglich.
* Bewertungen und Farbmarkierungen werden nicht in XMP-Dateien geschrieben (nur Projektdatenbank).
* Hardlink-Fallback auf FAT32/exFAT/einigen NAS: kurzes Zeitfenster, in dem ein **fremdes** Programm eine
  gleichnamige Datei anlegen könnte (eigene Vorgänge sind serialisiert).
* Der Wiederherstellungsbereich bietet **keinen Schutz bei Datenträgerausfall**.
* Bildpausen beim Scrollen wurden nur unter Software-Rendering gemessen.
