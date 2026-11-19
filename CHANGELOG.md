# Änderungsprotokoll

## 1.0.0-beta.2 – Updates über GitHub (19.11.2026)

### Neu
- **Updates über GitHub-Releases:** Die Installer-Version sucht beim Start nach einer neuen Version, lädt sie im
  Hintergrund und installiert sie beim Beenden (oder sofort über „Jetzt neu starten“). Portable EXE und ZIP melden
  neue Versionen mit Link zum Download. Einstellungen → Updates: „Nach Updates suchen“, Suche beim Start abschaltbar.
  Laufende Übertragungen werden nie für ein Update unterbrochen.
- **Grafikbeschleunigung abschaltbar** (Einstellungen → System, wirkt nach Neustart) – Abhilfe bei
  Darstellungsfehlern einzelner Grafiktreiber, z. B. doppelt angezeigtem Mauszeiger über der Paketleiste.

### Behoben
- Paket-Taste direkt nach dem Wechsel der Schnellzuordnung nutzte auf langsamen Rechnern noch den alten Modus.

### Hinweis
- Version 1.0.0-beta.1 enthält noch keine Update-Funktion: beta.2 bitte einmal manuell installieren.
  Ab dann kommen Updates automatisch.

## 1.0.0-beta.1 – erster Test-Release (19.11.2026)

Erste testbare Version für Windows 10/11 (64 Bit). **Testversion** – bitte zunächst nur mit Kopien bzw.
gesicherten Daten verwenden und Rückmeldungen über die Issue-Vorlage „Fehler melden“ geben.

### Funktionen
- Projekte, mehrere Quellordner, virtualisiertes Raster (getestet mit 12 000 Medien), Fokusansicht mit Zoom/Video
- Pakete mit Tasten 1–9, Mehrfachauswahl mit Tri-State, Rückgängig/Wiederholen
- Sammel- und Sofortmodus; Kopieren und Verschieben mit SHA-256-Prüfung und Wiederherstellungsbereich
- Absturzsichere, persistente Auftragswarteschlange
- Paketansicht mit eigener Reihenfolge (Drag & Drop), ZIP-Export, Nummernpräfix
- RAW+JPEG-Paare, XMP-Sidecars, Bewertungen, Farbmarkierungen
- Exakte Duplikate und ähnliche Bilder (ohne Löschung)
- Proton Drive und OneDrive inkl. „Nur online“-Dateien
- Kontextmenü, Ordner aus dem Explorer ziehen, Taskleisten-Fortschritt, Benachrichtigungen, portabler Modus
- Präsentationsfenster, Projektsicherung, Hell/Dunkel/System, Windows-Kontrastdesigns

### Technik
- Node.js 26.13.1 LTS (Build), Electron 45.4.1, TypeScript 7, SQLite (WAL)
- FFmpeg als LGPL-Build, gehärtetes Electron-Paket (Fuses)
