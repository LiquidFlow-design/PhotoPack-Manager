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

## D. Version 2 – umgesetzte Vorschläge (freigegeben am 18.11.2026)

| # | Umsetzung | Entscheidungen / Einschränkungen |
|---|---|---|
| D1 | **RAW+JPEG-Paare und XMP-Sidecars.** Paare: gleicher Ordner, gleicher Basisname, genau ein RAW und ein JPEG/HEIC. Sidecars: `NAME.xmp` oder `NAME.EXT.xmp` (bei Mehrdeutigkeit gehört die XMP zum RAW). Zuordnen/Entfernen/Bewerten wirkt auf beide Partner; Sidecars werden mitkopiert und mitverschoben. | Sidecars sind interne Medien (`role = 'sidecar'`) ohne eigene Kachel und laufen durch dieselbe abgesicherte Engine (Hash, Commit, Recovery). Ihr Zielname folgt dem geplanten Namen des Hauptmediums (`IMG (2).CR3` → `IMG (2).CR3.xmp`). Muss das Hauptmedium erst **zur Laufzeit** wegen einer neu aufgetauchten Datei umbenannt werden, behält die XMP ihren geplanten Namen. Beide Verhalten sind in den Einstellungen abschaltbar. |
| D2 | **Startverzögerung im Sofortmodus** (Standard 3 s, 0–10 s): Aufträge starten erst danach; der Hinweis bietet „Rückgängig“. | Verzögerung ist im Auftrag gespeichert (`jobs.start_after`) und übersteht Neustarts. |
| D3 | **Wiederherstellungsbereich je Laufwerk** (Windows): Liegt die Quelle auf einem anderen Laufwerk als der Standardbereich, wird `X:\.photopack-recovery\<Projekt>` (versteckt) verwendet – Verschieben ist eine Umbenennung. | Nicht für Netzwerkfreigaben und nicht bei individuell gesetztem Bereich. Kann der Ordner nicht angelegt werden, gilt der Standardbereich. Abschaltbar. Diese Ordner werden beim Indexieren immer übersprungen. |
| D4 | **Projekt abschließen** im Wiederherstellungsdialog: alle gehaltenen Quellen in einem Schritt freigeben (mit Zusammenfassung). | Frist wie bei Einzelfreigabe. |
| D5 | **Ähnliche Bilder** über 64-Bit-dHash aus dem Vorschaubild; Gruppierung per Hamming-Distanz (Streng 4 / Normal 8 / Locker 12). Reiter „Ähnlich“ im Duplikatdialog, Filter „Nur ähnliche Bilder“. | Keine Löschung. Vergleich aller Paare (12 000 Medien ≈ 72 Mio. Vergleiche) in Blöcken, damit die Oberfläche reagiert. |
| D6 | **Wiederholen** mit Strg+Y bzw. Strg+Umschalt+Z. | |
| D7 | **Bewertungen (0–5 Sterne) und Farbmarkierungen** (Rot, Gelb, Grün, Blau, Violett): Alt+0–5, Alt+6–9 (Rot/Gelb/Grün/Blau), Sterne/Farben in der Fokusansicht, Filter und Sortierung. | Nur in der Projektdatenbank gespeichert (kein Schreiben in XMP – Dateien bleiben unverändert). Das Windows-Menü (Alt) ist deaktiviert, damit Alt-Kürzel frei sind. |
| D8 | **Projektsicherung** (`.ppmproj`, gzip-JSON) und **Import**. | Enthält Projekt, Quellen, Medien, Pakete inkl. Reihenfolge, Zuordnungen, Exportnachweise und Wiederherstellungseinträge – keine Mediendateien und keinen Auftragsverlauf. Existiert das Projekt bereits, wird der Import abgelehnt (sonst könnten zwei Projekte denselben Wiederherstellungsbereich verwalten). |
| D9 | **Präsentationsfenster** (Kopfzeile): auf einem zweiten Bildschirm im Vollbild, folgt dem aktiven Medium; Pfeiltasten im Präsentationsfenster steuern das Hauptfenster, F/F11 Vollbild, Esc schließt. | |
| D10 | **HEIC/HEIF-Vorschau unter Windows** über die Windows-Bildkomponente (WIC, PowerShell). | Benötigt die „HEIF-Bilderweiterungen“ aus dem Microsoft Store. **Nicht getestet** (kein Windows verfügbar). |
| D11 | **ZIP-Export je Paket** (Paketmenü): Reihenfolge = Paketreihenfolge, Sidecars direkt hinter ihrem Medium, gleiche Namen → „Name (2)“, ohne Kompression (Medien sind bereits komprimiert), ZIP64 für große Archive. | Veränderte/fehlende Quellen werden übersprungen und gemeldet. Ersetzen einer vorhandenen ZIP nur nach Bestätigung im Speicherdialog. |
| D12 | **LGPL-FFmpeg** statt GPL-Build: `scripts/fetch-ffmpeg-lgpl.mjs` lädt den LGPL-Build (gemeinsame DLLs) nach `vendor/ffmpeg/`, prüft die Lizenz und protokolliert die SHA-256; electron-builder liefert ihn unter `resources/ffmpeg` aus. `ffmpeg-static`/`ffprobe-static` sind nur noch Entwicklungsabhängigkeiten. | Der Download war in der Build-Umgebung nicht erlaubt (Zugriffsrichtlinie). Daher in dieser Sitzung **kein neuer Windows-Build**; `npm run dist:win` lädt FFmpeg automatisch. Für reproduzierbare Builds `FFMPEG_LGPL_URL` auf ein datiertes Release setzen. |

## E. Paketansicht und eigene Reihenfolge (Wunsch vom 18.11.2026)

* Augen-Symbol neben jedem Paket öffnet die **Paketansicht**: nur Medien dieses Pakets, Positionsnummer auf jeder Kachel.
* **Eigene Reihenfolge** (Standard in der Paketansicht): Kacheln per **Drag & Drop** verschieben (Mehrfachauswahl wird gemeinsam verschoben), per Tastatur mit **Strg+Pfeil**. Andere Sortierungen (Name, Datum, Bewertung …) lassen sich mit „Als Reihenfolge übernehmen“ festschreiben.
* Drag & Drop ist nur bei eigener Reihenfolge ohne aktive Filter möglich – sonst wäre die Zielposition mehrdeutig.
* **Entf** entfernt die Auswahl aus dem Paket (rückgängig machbar). Neue Zuordnungen werden ans Ende angehängt.
* Pakete selbst lassen sich in der Seitenleiste am Griff per Drag & Drop (oder Strg+Pfeil hoch/runter) umsortieren.
* Die Reihenfolge wird im ZIP-Export und im Präsentationsfenster (Navigation) verwendet. Beim normalen Export in Ordner hat sie **keine** Auswirkung auf die Dateinamen (siehe Rückfrage im Bericht).

## F. Vereinfachte Oberfläche

Erklärtexte wurden entfernt bzw. gekürzt: rechte Seitenleiste (Zuordnungs- und Ausgabehinweise), Hinweise beim
Umschalten auf Verschieben/Sofort, Infokasten der Exportvorschau, Duplikat- und Quellendialog, mehrere
Einstellungsbeschreibungen. Warnungen und Fehler bleiben sichtbar.

## G. Entscheidungen aus dem Audit (19.11.2026)

| # | Entscheidung | Begründung |
|---|---|---|
| G1 | Datenbank `synchronous=NORMAL`, aber Zustände **vor nicht umkehrbaren Dateischritten** mit `durable()` (FULL) | Volle Synchronisation jeder Transaktion halbierte den Durchsatz kleiner Dateien; alle übrigen Schritte sind nach Stromausfall durch den Abgleich wiederholbar (identische Ziele werden erkannt). |
| G2 | Recovery je Laufwerk nur für Laufwerkstyp „Fixed“ | Speicherkarten müssen beim Verschieben frei werden; Sicherung darf nicht auf dem Medium liegen, das danach formatiert wird. |
| G3 | Re-Import-Schutz projektübergreifend | Auch Exporte anderer Projekte sind keine neuen Quellmedien. |
| G4 | Electron-Fuses im Paket (RunAsNode, NODE_OPTIONS, Inspect aus; nur asar mit Integritätsprüfung) | Schutz gegen Missbrauch der signierten EXE. Folge: Das *gepackte* Programm lässt sich nicht mehr per Playwright fernsteuern; E2E gegen das Paket: `npx electron-builder --linux dir -c.electronFuses.enableNodeCliInspectArguments=true -c.electronFuses.runAsNode=true` (nur für Tests; 17/17 bestanden). |
| G5 | Einklapp-Reihenfolge: Quellenleiste vor Paketleiste | Pakete werden beim Sichten ständig gebraucht. |
| G6 | Fensterlage wird gespeichert | Windows-übliches Verhalten. |

## H. Version 3 (19.11.2026): Toolchain, Design, Proton Drive, Audit-Vorschläge

| # | Entscheidung | Begründung / Einschränkung |
|---|---|---|
| H1 | **Node.js 26.13.1 LTS**, Electron 45.4.1, TypeScript 7.0, alle Pakete auf neuestem Stand; `engines` + `.nvmrc` + `engine-strict` | Wunsch „nur aktuellste Pakete“. Electron 45 enthält intern **Node 24** – das ist die von Electron ausgelieferte Laufzeit und erst mit einer neueren Electron-Hauptversion änderbar. |
| H2 | npm-11-`allowScripts`: nur `ffmpeg-static` erlaubt; `better-sqlite3` (bringt fertige Binärdateien mit) und `electron-winstaller` (nicht genutzt) verweigert | Weniger fremder Code bei der Installation. |
| H3 | **Neues Design**: dunkles Dashboard mit violettem Akzent (#6d4dff), flache Karten statt Glas (Glas nur noch bei Popover/Dialog), Suche/Glocke/Projekt-Avatar in der Kopfleiste, Medientyp-Reiter, Paket-Pillen auf Karten | Nach Designvorlage. Hell/System bleiben (Vorgabe des Auftrags) in gleicher Formensprache. Alle Text-Farbpaare ≥ 4,5 : 1. Ein einzelner Medientyp wird als Reiter gezeigt, nicht zusätzlich als Filter-Chip. |
| H4 | **Proton Drive**: Erkennung über die Windows-Registrierung (`SyncRootManager`, gilt für alle Cloud-Files-Anbieter) mit Rückfall auf `%USERPROFILE%\Proton Drive\<Konto>`; Auswahl über Ordnermenüs (Dialog startet im Proton-Drive-Ordner) | Der Renderer übergibt nur die ID des erkannten Ordners, keine Pfade. |
| H5 | „Nur online“-Erkennung per Dateiattribut (RECALL_ON_DATA_ACCESS/RECALL_ON_OPEN/OFFLINE) über PowerShell 5.1-kompatibles Skript, nur Metadaten | Lesen würde den Download auslösen. Vorschau nur auf Klick, Duplikat-/Ähnlichkeitsprüfung lässt solche Dateien aus. |
| H6 | Verschieben aus Cloud-Ordnern **immer per verifizierter Kopie + Löschen**, nie per Umbenennen | Umbenennen von Cloud-Platzhaltern aus dem Sync-Ordner heraus ist anbieterabhängig; Kopieren ist sicher. |
| H7 | Kontextmenü als eigenes (gestaltetes, zugängliches) Menü statt nativem Windows-Menü | Tri-State der Pakete, Sterne und Farben lassen sich nativ nicht darstellen. |
| H8 | Ordner-Ablage aus dem Explorer: Pfade ermittelt nur die Preload-Schicht aus echten Dateiobjekten (`webUtils.getPathForFile`) | Die Seite kann keine Pfade vortäuschen (künstliche Dateien haben keinen Pfad – getestet). |
| H9 | Benachrichtigungen nur für Sammelexporte/Wiederherstellungen und bei Fehlern, nur wenn das Fenster nicht im Vordergrund ist; Taskleiste: Fortschritt aller offenen Aufträge, gelb = pausiert, rot = Fehler | Sofortmodus würde sonst je Zuordnung melden. |
| H10 | Portabler Modus: Daten in `PhotoPack-Daten` neben der EXE (portable EXE automatisch, ZIP-Version wenn der Ordner existiert); schreibgeschützt → `%APPDATA%` mit Hinweis | |
| H11 | Nummernpräfix (`001_`) als Projekteinstellung, gilt für Sammel- und Sofortexport; Position = Rang im Paket über alle Hauptmedien, Sidecars übernehmen den Präfix | Stabil, auch wenn nur ein Teil exportiert wird. Bereits exportierte Dateien werden nicht umbenannt. |

## I. Updates und Grafik (19.11.2026, Wunsch: „Update über GitHub“)

| # | Entscheidung | Begründung / Einschränkung |
|---|---|---|
| I1 | **electron-updater** mit GitHub-Releases (`LiquidFlow-design/PhotoPack-Manager`); der Release-Workflow lädt `latest.yml` und `*.blockmap` mit hoch und prüft, dass `latest.yml` auf den Installer zeigt | Standardweg für electron-builder-Installer; differenzielle Downloads über die Blockmap. |
| I2 | **Suche beim Start** (8 s nach dem Start, einmal pro Sitzung), abschaltbar; zusätzlich „Nach Updates suchen“ | Freigegeben. Ohne Suche bleibt das Programm vollständig offline. Fehler der automatischen Suche (z. B. offline) werden nur in den Einstellungen angezeigt, nicht als Meldung. |
| I3 | **Installer-Version:** Hintergrund-Download, Installation beim Beenden oder sofort per „Jetzt neu starten“ – Sofort-Neustart nur ohne laufende Übertragungen | Freigegeben. Datensicherheit vor Bequemlichkeit; beim normalen Beenden werden Aufträge wie bisher sicher pausiert. |
| I4 | **Portable EXE / ZIP:** nur Hinweis mit Link zur Release-Seite | Diese Varianten können sich nicht selbst ersetzen; der Installer würde eine zweite, installierte Kopie anlegen. Erkennung: `PORTABLE_EXECUTABLE_DIR` bzw. fehlendes Deinstallationsprogramm neben der EXE. |
| I5 | Vorabversionen (`-beta`) erhalten auch Vorabversionen als Update, stabile Versionen nur stabile; kein Downgrade | Verhalten von electron-updater (`allowPrerelease` aus der eigenen Version). |
| I6 | Unsignierte Updates: Prüfung über SHA-512 aus `latest.yml`, keine Signaturprüfung | Erst mit Code-Signatur möglich (dann `publisherName` setzen). SmartScreen kann beim Update-Installer erneut warnen. |
| I7 | Die Release-Seite öffnet der Main-Prozess mit fester GitHub-Adresse; der Renderer kann keine URLs übergeben | Sicherheitsmodell unverändert (keine Navigation, keine freien Adressen). |
| I8 | **Grafikbeschleunigung abschaltbar** (Einstellung + `launch.json` im Datenordner, da vor dem Start von Chromium nötig) | Gemeldet: doppelter Mauszeiger über der Paketleiste, nur unter Windows, nicht nachstellbar. Die App zeichnet keinen eigenen Zeiger; Ursache sehr wahrscheinlich Grafiktreiber/Overlay-Ebenen. Abschalten der GPU-Beschleunigung ist die übliche Abhilfe – Wirkung noch zu bestätigen. |

