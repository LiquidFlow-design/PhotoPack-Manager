# Drittanbieter-Komponenten

PhotoPack Manager liefert folgende Komponenten mit bzw. nutzt sie zur Laufzeit. Die vollständigen
Lizenztexte liegen im jeweiligen Paket (`node_modules/<paket>/LICENSE*`) bzw. neben den Binärdateien.

| Komponente | Zweck | Lizenz |
|---|---|---|
| Electron (Chromium, Node.js) | Laufzeitumgebung | MIT (Chromium: BSD u. a.) |
| better-sqlite3 (SQLite) | Datenbank | MIT (SQLite: Public Domain) |
| sharp / libvips (`@img/sharp-*`) | Bildvorschauen | Apache-2.0; libvips-Binärdateien LGPL-3.0-or-later |
| exiftool-vendored / ExifTool | RAW-Vorschauen, EXIF-Daten | MIT; ExifTool: Perl Artistic License / GPL |
| FFmpeg / FFprobe (LGPL-Build, BtbN/FFmpeg-Builds) | Video-Thumbnails, Video-Metadaten | **LGPL-2.1-or-later**, gemeinsame DLLs in `resources/ffmpeg` (austauschbar) |
| ffmpeg-static / ffprobe-static | nur Entwicklung und Tests, nicht ausgeliefert | GPL-3.0-or-later (Binärdatei) / MIT |
| yazl | ZIP-Export | MIT |
| electron-updater (+ builder-util-runtime, js-yaml, semver, fs-extra u. a.) | Updates über GitHub-Releases | MIT |
| React, React DOM | Oberfläche | MIT |
| zustand | Zustandsverwaltung | MIT |
| @tanstack/react-virtual | Virtualisiertes Raster | MIT |
| lucide-react | SVG-Icons | ISC |
| zod | IPC-Eingabevalidierung | MIT |

## Hinweise zu FFmpeg (LGPL)

Ausgeliefert wird ein LGPL-Build von FFmpeg mit gemeinsam genutzten Bibliotheken (DLLs), der als eigenständiger
Prozess aufgerufen wird. Die Bibliotheken liegen unverändert in `resources/ffmpeg/` und können ersetzt werden.
Quellcode: https://ffmpeg.org bzw. https://github.com/BtbN/FFmpeg-Builds (Build-Skripte). Lizenztext:
`resources/ffmpeg/LICENSE.txt`. Herkunft und Prüfsumme des verwendeten Archivs: `vendor/ffmpeg/<ziel>/MANIFEST.json`.

## Hinweise zu libvips (LGPL)

Die libvips-Bibliotheken werden dynamisch geladen und liegen unverändert im Ordner
`resources/app.asar.unpacked/node_modules/@img/` und können dort ausgetauscht werden.
