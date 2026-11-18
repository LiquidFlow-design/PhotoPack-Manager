# PhotoPack Manager

Lokale Windows-Desktopanwendung zum schnellen, sicheren Verteilen großer Foto-, RAW- und Videosammlungen
auf mehrere Personen bzw. **Pakete** – vollständig offline, ohne Konto, Cloud oder Server.

* Mehrere Projekte mit automatischer Speicherung, mehrere Quellordner je Projekt
* Virtualisiertes Raster (getestet mit 12 000 Medien) und Fokusansicht mit Zoom/Pan bzw. Video-Player
* Zuordnung per Klick oder Taste **1–9**, Mehrfachauswahl mit Tri-State (keines / teilweise / alle), Strg+Z
* **Sammelmodus** (Exportvorschau, dann Start) und **Sofortmodus** (Hintergrundaufträge sofort)
* **Kopieren** oder **Verschieben** mit projektinternem **Wiederherstellungsbereich** (Standard 30 Tage)
* Jede Kopie wird per **SHA-256** verifiziert, niemals wird still überschrieben
* Persistente Warteschlange mit Pause, Abbruch, Wiederholung und Wiederanlauf nach Absturz
* **Paketansicht** mit eigener Reihenfolge per **Drag & Drop**, ZIP-Export je Paket
* **RAW+JPEG-Paare** und **XMP-Sidecars** werden gemeinsam zugeordnet und übertragen
* **Bewertungen** (Sterne) und **Farbmarkierungen**, Filter und Sortierung danach
* Exakte **Duplikate** (Größe + SHA-256) und **ähnliche Bilder** (Wahrnehmungs-Hash), ohne automatische Löschung
* **Präsentationsfenster** für einen zweiten Bildschirm
* Projektsicherung/-import (`.ppmproj`)
* Hell, Dunkel oder System; verstellbare, einklappbare Seitenleisten

Screenshots: [`docs/screenshots/`](docs/screenshots/).

## Installation (Windows 10/11, 64 Bit)

| Datei | Beschreibung |
|---|---|
| `PhotoPack Manager-<version>-portable.exe` | Portable Version, ohne Installation startbar |
| `PhotoPack Manager-<version>-win-x64.zip` | Entpacken und `PhotoPack Manager.exe` starten |
| `PhotoPack Manager-<version>-win-x64.exe` | Installer (NSIS) – wird auf Windows gebaut, siehe unten |

**SmartScreen:** Unsignierte Builds lösen beim ersten Start die Warnung „Der Computer wurde durch Windows
geschützt“ aus („Weitere Informationen“ → „Trotzdem ausführen“). Für die Verteilung an Dritte wird eine
Code-Signatur empfohlen (siehe „Signierung“).

Programmdaten (Datenbank, Vorschau-Cache, Wiederherstellungsbereich) liegen unter
`%APPDATA%\PhotoPack Manager\`. Die Mediendateien selbst bleiben im Dateisystem.

## Nutzung in Kürze

1. **Projekt anlegen** (Kopfzeile → Projektname) und **Quellordner hinzufügen** (linke Seitenleiste).
2. **Pakete erstellen** (rechte Seitenleiste), **Ausgabeordner wählen**. Jedes Paket erhält dort einen
   Unterordner; im Paketmenü (⋯) kann ein individueller Zielordner, Farbe und Tastenkürzel gesetzt werden.
3. Medien auswählen (Klick, Strg+Klick, Shift+Klick, Strg+A) und per Klick auf ein Paket oder Taste 1–9 zuordnen.
   Doppelklick/Enter öffnet die Fokusansicht; Pfeiltasten navigieren; Esc kehrt zurück.
4. **Sammelmodus:** „Exportvorschau öffnen“ zeigt Mengen, Konflikte und Speicherplatz; dann starten.
   **Sofortmodus:** Jede neue Zuordnung wird sofort im Hintergrund übertragen.
5. **Verschieben:** Die Quelle wird erst entfernt, wenn alle Zielkopien geprüft sind, und bleibt im
   Wiederherstellungsbereich („gehalten“). Dort lässt sie sich wiederherstellen, freigeben oder löschen.
6. **Paketansicht** (Augen-Symbol am Paket): Inhalt prüfen und per Drag & Drop sortieren.

Schnellzuordnung (rechte Seitenleiste oder Einstellungen): „Bild bleibt geöffnet“, „Nach Zuordnung weiter“
oder „Mehrere Pakete wählen, dann Enter“.

| Taste | Funktion |
|---|---|
| 1–9 | Paket zuordnen/umschalten (nicht während Texteingabe) |
| Pfeiltasten, Pos1/Ende | Navigation (Shift erweitert die Auswahl im Raster) |
| Enter | Fokusansicht / weiter / vorgemerkte Pakete übernehmen |
| Esc | Dialog/Popover schließen, zurück zum Raster |
| Strg+A / Strg+Z / Strg+Y / Strg+F | Alle sichtbaren auswählen / rückgängig / wiederholen / Suche |
| Alt+0–5 | Bewertung (0 = keine) |
| Alt+6–9 | Farbmarkierung Rot / Gelb / Grün / Blau (umschalten) |
| Strg+Pfeiltasten | Paketansicht: Auswahl in der Reihenfolge verschieben |
| Entf | Paketansicht: Auswahl aus dem Paket entfernen |
| + / − / 0 | Zoom in der Fokusansicht |

## Entwicklung

Voraussetzungen: Node.js ≥ 22.12, npm.

```bash
npm install
npm run dev          # Entwicklungsmodus mit Hot Reload
npm run build        # Produktionsbuild nach out/
npm start            # gebaute App starten
npm run typecheck
```

Projektstruktur und Datenfluss: [ARCHITECTURE.md](ARCHITECTURE.md). Begründete Abweichungen und offene
Vorschläge: [DECISIONS.md](DECISIONS.md).

## Tests

```bash
npm test                                   # Unit- und Integrationstests (Vitest, 86 Tests)
npm run test:perf                          # Skalierung mit 12 000 synthetischen Medien
npm run test:e2e                           # Electron-E2E (Playwright), baut vorher
npx playwright test perf --trace off       # UI-Reaktionsfähigkeit mit 12 000 Medien
```

Unter Linux ohne Bildschirm: `xvfb-run -a npm run test:e2e`; als root zusätzlich ist `--no-sandbox`
bereits in den Testhelfern gesetzt. Alle destruktiven Tests arbeiten ausschließlich mit generierten Dateien in
temporären Ordnern (`.tmp-tests/`, Systemtemp). Testmedien manuell erzeugen:
`node scripts/gen-test-media.mjs <ordner> 40 --videos`.

Ergebnisse des letzten Laufs: [TEST_REPORT.md](TEST_REPORT.md).

## Windows-Build

**Auf Windows (empfohlen, inkl. Installer):**

```powershell
npm ci
npm run dist:win     # release\…-win-x64.exe (Installer) und …-portable.exe
```

`dist:win` lädt vorher den LGPL-Build von FFmpeg nach `vendor/ffmpeg/` (`npm run fetch:ffmpeg -- win32-x64`).

**Cross-Build von Linux/macOS:** Die Windows-Binärdateien (sharp/libvips, ExifTool, LGPL-FFmpeg) werden zusätzlich
geladen, ohne die lokalen Abhängigkeiten zu verändern:

```bash
npm run build
node scripts/prepare-win-deps.mjs
npx electron-builder --win portable zip --x64            # ohne Wine: -c.win.signAndEditExecutable=false
```

Der NSIS-Installer benötigt unter Linux ein funktionierendes Wine (32 Bit). In der Build-Umgebung dieses
Projekts stürzte Wine ab; deshalb wurden dort nur portable EXE und ZIP erzeugt (siehe TEST_REPORT.md).

### Signierung

Ohne Zertifikat wird nicht signiert. Für signierte Builds `CSC_LINK` (PFX-Datei oder Base64) und
`CSC_KEY_PASSWORD` setzen oder Azure Trusted Signing über `win.azureSignOptions` in `electron-builder.yml`
konfigurieren. Signierte Builds reduzieren SmartScreen-Warnungen (EV-Zertifikate sofort, OV-Zertifikate nach
Aufbau von Reputation).

### Reproduzierbarkeit

Versionen sind über `package-lock.json` fixiert (`npm ci`). Native Module werden nicht neu kompiliert
(`npmRebuild: false`; better-sqlite3 und sharp liefern N-API-Prebuilds). Externe Werkzeuge stammen aus
versionierten npm-Paketen (exiftool-vendored) bzw. für FFmpeg aus einem LGPL-Release, dessen Herkunft und
SHA-256 in `vendor/ffmpeg/<ziel>/MANIFEST.json` protokolliert werden (für feste Versionen `FFMPEG_LGPL_URL` setzen).

## Datensicherheit – das Wichtigste

* Zieldateien werden nie überschrieben; identische Inhalte werden erkannt und übersprungen.
* Kopien entstehen als Zwischendatei auf dem Ziellaufwerk, werden per SHA-256 geprüft und erst dann
  festgeschrieben.
* Beim Verschieben wird die Quelle erst nach **allen** geprüften Zielkopien in den Wiederherstellungsbereich
  verschoben (anderes Laufwerk: verifizierte Kopie, dann Löschen der Quelle).
* Das Entfernen von Zuordnungen, Paketen, Quellen oder Projekten löscht nie Dateien.
* Nach einem Absturz gleicht die App unterbrochene Vorgänge mit dem Dateisystem ab und pausiert alle Aufträge.
* **Keine absolute Garantie:** Der Wiederherstellungsbereich schützt nicht vor Ausfall oder Verlust des
  Datenträgers. Wichtige Daten zusätzlich sichern.

## Lizenzen

Siehe [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (u. a. FFmpeg und libvips unter LGPL).
