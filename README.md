# PhotoPack Manager

[![CI](https://github.com/LiquidFlow-design/PhotoPack-Manager/actions/workflows/ci.yml/badge.svg)](https://github.com/LiquidFlow-design/PhotoPack-Manager/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/LiquidFlow-design/PhotoPack-Manager?include_prereleases&label=Release)](https://github.com/LiquidFlow-design/PhotoPack-Manager/releases)

**Download:** [Releases](https://github.com/LiquidFlow-design/PhotoPack-Manager/releases) · **Feedback:** [Issues](https://github.com/LiquidFlow-design/PhotoPack-Manager/issues/new/choose)

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
* **Proton Drive** (und OneDrive) als Quelle oder Ziel; „Nur online“-Dateien werden nicht ungefragt heruntergeladen
* Windows-Bedienung: Kontextmenü (Rechtsklick/Umschalt+F10), Ordner aus dem Explorer ins Fenster ziehen,
  Fortschritt in der Taskleiste, Benachrichtigung bei Auftragsende, portabler Modus
* Projektsicherung/-import (`.ppmproj`)
* Hell, Dunkel oder System; verstellbare, einklappbare Seitenleisten

Screenshots: [`docs/screenshots/`](docs/screenshots/).

## Installation (Windows 10/11, 64 Bit)

| Datei | Beschreibung |
|---|---|
| `PhotoPack-Manager-<version>-Setup.exe` | Installer (Benutzerinstallation) |
| `PhotoPack-Manager-<version>-portable.exe` | Portable Version, ohne Installation startbar |
| `PhotoPack-Manager-<version>-win-x64.zip` | Entpacken und `PhotoPack Manager.exe` starten |
| `SHA256SUMS.txt` | Prüfsummen |

**SmartScreen:** Unsignierte Builds lösen beim ersten Start die Warnung „Der Computer wurde durch Windows
geschützt“ aus („Weitere Informationen“ → „Trotzdem ausführen“). Für die Verteilung an Dritte wird eine
Code-Signatur empfohlen (siehe „Signierung“).

Programmdaten (Datenbank, Vorschau-Cache, Wiederherstellungsbereich) liegen unter
`%APPDATA%\PhotoPack Manager\`. Die Mediendateien selbst bleiben im Dateisystem.

**Proton Drive / OneDrive:** Der Synchronisationsordner des Proton-Drive-Desktop-Clients wird automatisch
erkannt und erscheint in den Ordnermenüs („Quellordner hinzufügen“, „Ausgabeordner wählen“, Paketziel).
Dateien mit Status „Nur online verfügbar“ bekommen ein Wolken-Symbol; ihre Vorschau wird nur auf Klick geladen,
Duplikat-/Ähnlichkeitsprüfung lässt sie aus. Beim Export werden sie heruntergeladen. **Verschieben** aus Proton
Drive entfernt die Dateien über die Synchronisation auch online – die Originale bleiben im
Wiederherstellungsbereich; die Exportvorschau weist darauf hin.

**Portabler Modus:** Die portable EXE speichert ihre Daten im Ordner `PhotoPack-Daten` neben der EXE. Bei der
ZIP-Version genügt es, diesen Ordner anzulegen. Ist der Speicherort schreibgeschützt, wird `%APPDATA%` verwendet.

Prüfbericht und Windows-Abnahmeliste: [AUDIT.md](AUDIT.md).

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
| Menütaste / Umschalt+F10 | Kontextmenü für die Auswahl |
| Strg+A / Strg+Z / Strg+Y / Strg+F | Alle sichtbaren auswählen / rückgängig / wiederholen / Suche |
| Alt+0–5 | Bewertung (0 = keine) |
| Alt+6–9 | Farbmarkierung Rot / Gelb / Grün / Blau (umschalten) |
| Strg+Pfeiltasten | Paketansicht: Auswahl in der Reihenfolge verschieben |
| Entf | Paketansicht: Auswahl aus dem Paket entfernen |
| + / − / 0 | Zoom in der Fokusansicht |

## Entwicklung

Voraussetzungen: **Node.js ≥ 26.13.1 (LTS)** und npm ≥ 11.20 (siehe `.nvmrc`, `engines`; `engine-strict` ist
aktiv). npm 11 führt Installationsskripte nur nach Freigabe aus; freigegeben ist nur `ffmpeg-static`
(Entwicklungs-FFmpeg), siehe `allowScripts` in `package.json`.

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
npx playwright test a11y --trace off       # Barrierefreiheit (axe-core)
```

Unter Linux ohne Bildschirm: `xvfb-run -a npm run test:e2e`; als root zusätzlich ist `--no-sandbox`
bereits in den Testhelfern gesetzt. Alle destruktiven Tests arbeiten ausschließlich mit generierten Dateien in
temporären Ordnern (`.tmp-tests/`, Systemtemp). Testmedien manuell erzeugen:
`node scripts/gen-test-media.mjs <ordner> 40 --videos`.

Ergebnisse des letzten Laufs: [TEST_REPORT.md](TEST_REPORT.md).

## Release erstellen (GitHub Actions)

1. Version in `package.json` erhöhen, `CHANGELOG.md` und `docs/release-notes/v<version>.md` ergänzen.
2. Tag `v<version>` pushen. Der Workflow **Release** testet auf Windows und Linux, baut auf einem Windows-Runner
   Installer, portable EXE und ZIP (inkl. LGPL-FFmpeg) und legt den GitHub-Release mit Prüfsummen an
   (Versionen mit Bindestrich, z. B. `-beta.1`, als Vorabversion).
3. Signierung: Secrets `CSC_LINK` (Base64-PFX) und `CSC_KEY_PASSWORD` im Repository hinterlegen.

Der Workflow **CI** prüft jeden Push und Pull Request auf Windows und Linux. Dependabot schlägt wöchentlich
Aktualisierungen von npm-Paketen und GitHub-Actions vor.

## Windows-Build (lokal)

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
