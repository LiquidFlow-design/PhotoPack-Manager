# Entscheidungen und Abweichungen

Dieses Dokument begründet technische Entscheidungen und Abweichungen gegenüber dem Auftrag
(„PhotoPack Manager – Entwicklungsauftrag“, Konzept V0.5). Abschnitt C listet Ergänzungen, die bereits
enthalten sind, Abschnitt D Vorschläge, die **nicht** umgesetzt wurden und eine Freigabe benötigen.

## A. Architektur und Technologie

| # | Entscheidung | Begründung |
|---|---|---|
| A1 | **Electron 44, React 19, TypeScript, electron-vite (Vite 8)** | Wie empfohlen; electron-vite baut Main, Preload, Worker und Renderer aus einer Konfiguration. |
| A2 | **Eigenes CSS mit Variablen statt Tailwind** | Theming (Hell/Dunkel/System) vollständig über CSS-Variablen, keine zusätzliche Build-Abhängigkeit, kleinere und gut kontrollierbare Oberfläche. Auftrag erlaubt „vergleichbare gepflegte Styling-Lösung“. |
| A3 | **Eine SQLite-Datenbank für alle Projekte** (Benutzerdatenordner) statt einer Datei je Projekt | Projektwechsel, Einstellungen und Abfragen über Projekte hinweg bleiben atomar und einfach; Recovery-Ordner sind trotzdem je Projekt getrennt. |
| A4 | **better-sqlite3 13** (N-API-Prebuilds für Windows/Linux/macOS) | Kein Neukompilieren für Electron, Cross-Build für Windows ohne Toolchain möglich. Synchrone API passt zu kurzen Transaktionen im Main-Prozess. |
| A5 | **zustand** für den Renderer-Zustand, **@tanstack/react-virtual** für das Raster, **lucide-react** für SVG-Icons, **zod** für IPC-Validierung | Kleine, gepflegte Bibliotheken. |
| A6 | Kopieren/Hashen in **Worker-Threads**; Vorschauen mit **sharp im Main-Prozess** | sharp/libvips arbeitet ohnehin im eigenen Threadpool (blockiert den Event-Loop nicht); so wird das native Modul nicht in mehreren Threads geladen. Hash-/Kopierarbeit (CPU-lastig) läuft in 2 Workern. |
| A7 | **Eigenes Schema `ppm://` mit Medien-IDs** statt `file://` | Renderer kann keine beliebigen Pfade lesen; Range-Unterstützung für Video. |
| A8 | **Ordnerwahl nur per nativem Dialog im Main-Prozess**; Bestätigungen per Einmal-Token | Der Renderer übergibt nie Dateipfade. |
| A9 | **Single-Instance-Lock** | Zwei Prozesse auf derselben Datenbank/denselben Dateien sind ein Datenverlustrisiko. |
| A10 | Video-Werkzeuge **ffmpeg-static / ffprobe-static** | Liefern geprüfte statische Binärdateien. **Achtung Lizenz:** ffmpeg-static ist ein GPL-Build. Er wird nur als separater Prozess aufgerufen; bei Weitergabe gelten die GPL-Pflichten für diese Binärdatei (siehe THIRD_PARTY_NOTICES.md). Alternative: eigenen LGPL-Build per `FFMPEG_BIN` einbinden. |
| A11 | **ExifTool (exiftool-vendored)** für RAW-Vorschauen (eingebettetes JPEG) und Aufnahmedatum | Deckt praktisch alle Kamera-RAW-Formate ab, ohne RAW-Entwicklung. Jeder Aufruf hat ein Zeitlimit; wiederholte Fehler deaktivieren ExifTool für die Sitzung, ohne die App zu blockieren. |

## B. Produktverhalten (Interpretation / Konkretisierung des Auftrags)

| # | Entscheidung | Begründung |
|---|---|---|
| B1 | **Sofortmodus + Verschieben + spätere Pakete:** Das Original wird nach den verifizierten Zielkopien in den projektinternen Wiederherstellungsbereich verschoben und bleibt dort als **kanonische Quelle „gehalten“**, bis der Nutzer es freigibt. Spätere Paketzuordnungen kopieren aus dem Wiederherstellungsbereich. | Entspricht dem Vorschlag im Auftrag (§6.6); kein Quellverlust, kein kaputter Verweis, kein erneutes Verschieben (Idempotenzschlüssel). |
| B2 | **30-Tage-Frist** gilt für **freigegebene** Einträge, gerechnet ab Verschiebung, mindestens 1 Tag ab Freigabe. Gehaltene Einträge laufen nie ab. Automatische Bereinigung nur bei laufender App (stündlich, erstmals 1 min nach Start), jede Löschung wird protokolliert. | „Recovery darf nicht allein durch Ablauf der 30 Tage eine noch benötigte Datei entfernen.“ Die Mindestfrist ab Freigabe verhindert eine sofortige Löschung nach versehentlicher Freigabe. |
| B3 | Beim Verschieben mit mehreren Zielen wird die Quelle nur nach **allen Zielkopien desselben Auftrags** entfernt. Schlägt eine fehl oder wird wegen Namenskonflikt übersprungen, bleibt die Quelle am Ort (`SOURCE_KEPT`). | §6.4, konservativ. |
| B4 | Nach Absturz **und** nach normalem Beenden werden offene Aufträge **pausiert**; der Nutzer setzt sie fort (Hinweis beim Start, Knopf in der Statusleiste). | „Nach Absturz nicht blind erneut übertragen oder löschen.“ Bewusst auch nach normalem Beenden, damit z. B. ein getrenntes Ziellaufwerk nicht sofort Fehler erzeugt. |
| B5 | **Konfliktregel je Export:** „Umbenennen → Name (2)“ (Standard) oder „Überspringen“. Identischer Inhalt am Ziel wird immer sicher übersprungen. Keine Einzelfallabfrage während des Laufs. | Persistente Hintergrundaufträge sollen nicht auf Dialoge warten; Konflikte zeigt die Exportvorschau vorab. |
| B6 | Gleiche Dateinamen innerhalb eines Exports werden **deterministisch** nach Paket → Dateiname → Originalpfad nummeriert. | §6.2 nachvollziehbar. |
| B7 | **Commit ohne Überschreiben per Hardlink**; auf Dateisystemen ohne Hardlinks (FAT32/exFAT, manche NAS) Fallback auf Existenzprüfung + Umbenennen mit prozessinterner Sperre je Zielordner. | Node `rename` überschreibt unter Windows; Hardlink schlägt bei belegtem Ziel atomar fehl. Restrisiko im Fallback: ein *fremdes* Programm legt exakt in diesem Moment dieselbe Datei an (dokumentiert). |
| B8 | Bereits exportierte Zuordnungen werden nicht erneut exportiert. Fehlt die Zieldatei inzwischen, zeigt die Vorschau dies; ein erneuter Export erfolgt nur mit ausdrücklicher Option. | „Eine ausgeführte Übertragung darf … nicht unkontrolliert wiederholt werden.“ |
| B9 | **Moduswechsel Sammeln → Sofort** überträgt bestehende, noch nicht exportierte Zuordnungen **nicht** automatisch (Hinweis wird angezeigt). Laufende Aufträge arbeiten unabhängig vom Modus mit ihrem Snapshot weiter. | Vermeidet überraschende Massenübertragungen. |
| B10 | Sofortmodus ohne Zielordner: Zuordnung wird gespeichert, kein Auftrag; Hinweis. | Keine stillen Fehler. |
| B11 | Rückgängig (Strg+Z) wirkt auf Zuordnungen. Im Sofortmodus werden noch nicht gestartete Übertragungen storniert; bereits übertragene Dateien bleiben (Hinweis). | §4.2 / §6.7. |
| B12 | Wiederherstellungsbereich standardmäßig im Benutzerdatenordner (`%APPDATA%\PhotoPack Manager\recovery\<Projekt>`), je Projekt änderbar, **solange er leer ist**. | Bestehende Dateien werden nicht automatisch umgezogen. Hinweis im UI: auf demselben Laufwerk wie die Quellen ist Verschieben eine schnelle Umbenennung; sonst Kopie + Prüfung + Löschen. |
| B13 | Filterzustand und Sortierung werden **je Projekt** gespeichert; Theme, Seitenleistenbreiten, Schnellzuordnung **global**. | §4.3 („projektbezogen oder bewusst global“). |
| B14 | Filter „Teilweise“: mit gewählten Paketen = in einigen, aber nicht allen gewählten Paketen; ohne Paketauswahl = in mindestens einem, aber nicht allen Paketen. | Konkretisierung von §4.3. |
| B15 | Paket umbenennen: künftige Exporte landen im Unterordner mit neuem Namen; bisherige Dateien bleiben am alten Ort (Hinweis im Dialog). | Keine Dateioperationen ohne Auftrag. |
| B16 | Quelle entfernen entfernt die zugehörigen Medien aus dem Projekt, **außer bereits verschobenen** (deren Original liegt im Wiederherstellungsbereich). Projekt löschen entfernt nur Datenbankeinträge; Mediendateien, Exporte und Wiederherstellungsbereich bleiben erhalten (Pfad wird angezeigt). | Keine Dateilöschung durch Verwaltungsaktionen. |
| B17 | Symbolische Links und Junctions werden beim Indexieren **nicht verfolgt**; ganze Laufwerke als Quelle sind nicht erlaubt; verschachtelte Quellen werden abgelehnt. | Schleifen- und Doppelimportschutz. |
| B18 | Ausgabe-/Paket-/Recovery-/Programmordner werden bei jeder Indexierung **immer** ausgeschlossen. Liegt ein Ziel in einer Quelle, ist eine ausdrückliche Bestätigung nötig. | §6.10. |
| B19 | HEIC/HEIF werden erkannt und exportiert, die mitgelieferte sharp-Version kann HEIC aber nicht dekodieren → „Keine Vorschau“. | Patent-/Lizenzlage des HEVC-Decoders. |

## C. Bereits enthaltene Ergänzungen (bitte bestätigen oder ablehnen)

Diese Punkte gehen leicht über den Mindestumfang hinaus, unterstützen aber direkt die vereinbarten Abläufe.
Jeder Punkt ist klein und kann auf Wunsch entfernt werden.

1. Filter-Popover zusätzlich mit **Exportstatus** (ausstehend/vollständig exportiert) und **Speicherort** (verschoben/Quelle fehlt).
2. Exportvorschau mit Paketauswahl („nur dieses Paket exportieren“) und Option „fehlende Zieldateien erneut exportieren“.
3. **Rückfallquelle:** Wurde eine Datei im Wiederherstellungsbereich bereinigt, kann eine verifizierte Exportkopie mit identischem SHA-256 spätere Paketzuordnungen bedienen.
4. „Im Explorer anzeigen“ in der Fokusansicht, „Zielordner öffnen“ im Paketmenü, „Ordner öffnen“ im Wiederherstellungsdialog.
5. Einstellungen: Vorschaugröße im Raster, Animationen (System/Reduziert/Normal), Vorschau-Cache leeren.
6. Paketdots an jeder Kachel (gefüllt = exportiert, Ring = ausstehend), Badge „verschoben“ / „fehlt“ / „DUP“.
7. Paket-Kürzel werden beim Neuvergeben automatisch getauscht statt abgelehnt.

## D. Vorschläge für Folgeversionen (nicht umgesetzt – Freigabe erforderlich)

| # | Vorschlag | Nutzen | Aufwand |
|---|---|---|---|
| D1 | **RAW+JPEG-Paare und XMP-Sidecars** gemeinsam behandeln (Zuordnung und Export als Einheit) | Fotografen-Workflow, keine verwaisten Sidecars | mittel |
| D2 | **Kurze Gnadenfrist im Sofortmodus** (z. B. 3 s), in der Strg+Z die Übertragung vor dem Start verhindert | weniger Fehlübertragungen bei schnellem Arbeiten | gering |
| D3 | **Wiederherstellungsbereich je Laufwerk** automatisch (z. B. `X:\.photopack-recovery`), damit Verschieben immer eine schnelle Umbenennung ist | deutlich schneller bei großen Videos | mittel (Berechtigungen, versteckte Ordner auf Nutzerlaufwerken) |
| D4 | „**Projekt abschließen**“: alle gehaltenen Quellen eines Projekts in einem Schritt freigeben, mit Zusammenfassung | einfachere Aufräumphase | gering |
| D5 | Visuelle Ähnlichkeit (perceptual hashing) für Beinahe-Duplikate | Serienbilder ausdünnen | mittel |
| D6 | Wiederholen (Strg+Y) für Zuordnungen | Komfort | gering |
| D7 | Bewertungen/Farbmarkierungen und Filter darauf | Vorauswahl vor Paketzuordnung | mittel |
| D8 | Projekt-Sicherung/Export (Datenbankauszug je Projekt) und Import | Umzug auf anderen PC | mittel |
| D9 | Zweitfenster/Vollbild-Vorschau für einen zweiten Monitor | Präsentation/Sichtung | mittel |
| D10 | HEIC-Vorschau über den Windows-Codec (WIC) | iPhone-Fotos | mittel |
| D11 | Export als ZIP je Paket | Weitergabe per Upload | gering |
| D12 | LGPL-FFmpeg-Build statt GPL-Build bündeln | einfachere Lizenzlage | gering (Build-Pipeline) |
