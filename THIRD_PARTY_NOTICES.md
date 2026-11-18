# Drittanbieter-Komponenten

PhotoPack Manager liefert folgende Komponenten mit bzw. nutzt sie zur Laufzeit. Die vollständigen
Lizenztexte liegen im jeweiligen Paket (`node_modules/<paket>/LICENSE*`) bzw. neben den Binärdateien.

| Komponente | Zweck | Lizenz |
|---|---|---|
| Electron (Chromium, Node.js) | Laufzeitumgebung | MIT (Chromium: BSD u. a.) |
| better-sqlite3 (SQLite) | Datenbank | MIT (SQLite: Public Domain) |
| sharp / libvips (`@img/sharp-*`) | Bildvorschauen | Apache-2.0; libvips-Binärdateien LGPL-3.0-or-later |
| exiftool-vendored / ExifTool | RAW-Vorschauen, EXIF-Daten | MIT; ExifTool: Perl Artistic License / GPL |
| ffmpeg-static (FFmpeg) | Video-Thumbnails | **GPL-3.0-or-later** (Binary-Build) |
| ffprobe-static (FFprobe) | Video-Metadaten | MIT (Wrapper); FFprobe-Binärdatei: GPL/LGPL je nach Build |
| React, React DOM | Oberfläche | MIT |
| zustand | Zustandsverwaltung | MIT |
| @tanstack/react-virtual | Virtualisiertes Raster | MIT |
| lucide-react | SVG-Icons | ISC |
| zod | IPC-Eingabevalidierung | MIT |

## Hinweise zu FFmpeg (GPL)

FFmpeg/FFprobe werden als **eigenständige Programme** (separate Prozesse) aufgerufen und nicht in die
Anwendung eingebunden. Bei Weitergabe der Anwendung sind die GPL-Pflichten für diese Binärdateien zu
beachten (Lizenztext beilegen, Bezugsquelle des Quellcodes nennen:
https://github.com/eugeneware/ffmpeg-static bzw. https://ffmpeg.org). Alternativ kann ein LGPL-Build von
FFmpeg verwendet werden (siehe DECISIONS.md, Abschnitt „Video-Werkzeuge“).

## Hinweise zu libvips (LGPL)

Die libvips-Bibliotheken werden dynamisch geladen und liegen unverändert im Ordner
`resources/app.asar.unpacked/node_modules/@img/` und können dort ausgetauscht werden.
