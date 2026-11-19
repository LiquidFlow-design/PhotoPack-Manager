# Änderungsprotokoll

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
