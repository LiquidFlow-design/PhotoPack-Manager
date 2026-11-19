# Audit – PhotoPack Manager

**Datum:** 19.11.2026 · **Stand:** Branch `ccr-19957b93-mq8kev` (Version 1 + Version-2-Funktionen)
**Umfang:** Datensicherheit der Datei-Engine, Verhalten unter Windows, Bedienung, Barrierefreiheit,
Sicherheit des Electron-Pakets, gepacktes Programm, Abhängigkeiten, Leistung.

**Methode:** Code-Durchsicht mit Fokus auf Windows-Semantik (NTFS/FAT/exFAT, Sperren durch Virenscanner,
OneDrive, Laufwerkstypen, Abmelden/Herunterfahren), automatisierte Tests (Unit, Integration, E2E gegen das
**gepackte** Programm), axe-Barrierefreiheitsscan, rechnerische Kontrastprüfung, Screenshots in typischen
Windows-Fenstergrößen und im Kontrastdesign, Prüfung der Electron-Härtung.

**Einschränkung:** Kein echtes Windows verfügbar. Windows-spezifisches Verhalten wurde aus dem Code und den
dokumentierten Fehlercodes von Node/libuv abgeleitet und – wo möglich – durch simulierte Fehlercodes getestet.
Die Prüfliste in Abschnitt 4 deckt ab, was nur auf einem echten Windows-PC bestätigt werden kann.

## 1. Befunde und Behebungen

Schwere: **H** = mögliche Datenschäden/-verwirrung oder Kernfunktion unbrauchbar, **M** = deutliche
Beeinträchtigung, **N** = gering.

| # | Bereich | Schwere | Befund | Behebung | Nachweis |
|---|---|---|---|---|---|
| A1 | Windows · OneDrive | **H** | Unter Windows meldet das Verzeichnislesen jeden Analysepunkt als Verknüpfung – auch OneDrive-Dateien und -Ordner. Die Indexierung hätte sie als Symlink übersprungen; ein „Bilder“-Ordner in OneDrive wäre leer erschienen. | Bei „Verknüpfung“ wird per `lstat` nachgeprüft; nur echte Symlinks/Junctions werden übersprungen. | `sources.test.ts` „Windows-Analysepunkte“ |
| A2 | Windows · Virenscanner | **H** | Hält z. B. Defender die Zwischendatei nach dem Hardlink-Commit kurz fest, scheiterte das Löschen der Zwischendatei; der Code wertete das als „Name belegt“ und hätte eine zweite Zieldatei „Name (2)“ erzeugt (Duplikat). | Commit und Aufräumen getrennt; Löschen mit Wiederholungen; Ziel gilt als festgeschrieben. | `fsx.test.ts` (2 Tests) |
| A3 | Windows · FAT32/exFAT | **H** | Auf SD-Karten/USB-Sticks liefert Windows beim Hardlink `EISDIR`; dieser Code fehlte in der Rückfallliste → Export auf solche Laufwerke wäre gescheitert. | `EISDIR` ergänzt; Rückfall Existenzprüfung + Umbenennen. | `fsx.test.ts` „FAT32/exFAT“ |
| A4 | Gepacktes Programm | **H** (potenziell) | Ist das Worker-Skript nicht ladbar (z. B. asar-Problem), startete der Pool die Worker endlos neu; `error` und `exit` lösten je einen Neustart aus. | Selbsttest beim Start, begrenzte Neustarts, Rückfall auf Kopieren im Hauptprozess. Status `fileOps` in den Startinformationen. | `worker-pool.test.ts`; gepacktes Programm meldet `fileOps: worker` |
| A5 | Stromausfall | **M** | Mit `synchronous=NORMAL` konnten bei Stromausfall die letzten Statuswechsel fehlen, obwohl die Quelle schon verschoben war → Original im Wiederherstellungsbereich ohne Datenbankeintrag. | Zustände **vor** nicht umkehrbaren Schritten (Quelle verschieben/löschen, Recovery-Kopie nach Wiederherstellung löschen) werden mit `durable()` synchron auf die Platte geschrieben; übrige Schritte sind wiederholbar. Statuswechsel und Protokoll je in einer Transaktion. | Absturztests (11) weiterhin grün; Messung siehe TEST_REPORT |
| A6 | Windows · Speicherkarten | **M** | „Wiederherstellungsbereich je Laufwerk“ hätte beim Verschieben von einer SD-Karte das Original **auf der Karte** belassen (Karte wird nicht frei; Formatieren in der Kamera zerstört die Sicherung). | Nur Laufwerkstyp „Fixed“ (per .NET `DriveInfo`) erhält einen eigenen Bereich; Wechseldatenträger, Netzlaufwerke, unbekannt → Standardbereich. | `features-v2.test.ts` „nur feste Laufwerke …“ |
| A7 | Re-Import | **M** | Schutz vor Re-Import galt nur für Ordner des eigenen Projekts; der Exportordner eines anderen Projekts in einer Quelle wäre eingelesen worden. | Ausgabe-, Paket- und Wiederherstellungsordner **aller** Projekte werden ausgeschlossen. | `sources.test.ts` „Re-Import-Schutz über Projekte hinweg“ |
| A8 | Bedienung | **M** | Hinweis „Übertragung startet in 3 s“ zeigte die Schaltfläche „Rückgängig“ nicht an. | Aktionen in Hinweisen werden gerendert. | E2E „‚Rückgängig‘ im Hinweis verhindert die Übertragung“ |
| A9 | Bedienung · Laptop | **M** | Bei 1366×768 mit 125 % Skalierung lag „Exportvorschau öffnen“ außerhalb des sichtbaren Bereichs. | Knopf fest am unteren Rand der Paketleiste. | Screenshot 1093×614 |
| A10 | Bedienung · schmale Fenster | N | Automatisches Einklappen nahm zuerst die Paketleiste weg (die zum Zuordnen gebraucht wird). | Quellenleiste klappt zuerst ein. | Screenshot 800×600 |
| A11 | Bedienung · geringe Höhe | N | Fokusansicht: Paketknöpfe brachen in mehrere Zeilen um, Bild schrumpfte auf ~10 %. | Paketknöpfe einzeilig, horizontal scrollbar, kompakter. | Screenshot 800×600 |
| A12 | Bedienung | N | Exportvorschau ohne Ausgabeordner: Fehler ohne direkte Lösung. | Knopf „Ausgabeordner wählen“ im Hinweis, Vorschau lädt neu. | manuell |
| A13 | Windows-Bedienung | N | Fenstergröße/-position/Maximiert wurden nicht gespeichert. | Wird gespeichert und nur übernommen, wenn sie auf einem vorhandenen Bildschirm liegt. | E2E „Persistenz nach Neustart“ |
| A14 | Windows · Abmelden | N | Beim Abmelden/Herunterfahren beendet Windows das Programm, bevor das asynchrone Pausieren läuft. | `session-end`: Aufträge sofort pausieren, Datenbank-Checkpoint. | Code-Durchsicht |
| A15 | Barrierefreiheit | M | axe: zu geringer Kontrast („Keine Vorschau“), Name von Kacheln/Paketknöpfen weicht vom sichtbaren Text ab (Windows-Sprachsteuerung „Klicke Anna“ trifft nicht). Rechnerisch weitere Farbtokens < 4,5 : 1 im hellen Design. | Tokens angepasst (alle Text-Paare ≥ 4,5 : 1); Namen aus sichtbarem Inhalt, Zusatzinfos für Screenreader. | `a11y.spec.ts`: 22 Ansichten/Dialoge hell+dunkel ohne schwerwiegende Verstöße |
| A16 | Windows · Hoher Kontrast | N | Keine Anpassung für Windows-Kontrastdesigns (Auswahl kaum erkennbar). | `forced-colors`-Regeln: Auswahl, Tri-State, Umschalter in Systemfarben; Paketfarben bleiben. | Screenshot Kontrastdesign |
| A17 | Sicherheit | M | Electron-Fuses nicht gesetzt: signierte EXE ließe sich per `ELECTRON_RUN_AS_NODE` als Node-Laufzeit missbrauchen. | Fuses: RunAsNode aus, NODE_OPTIONS/Inspect aus, nur asar mit Integritätsprüfung, Cookie-Verschlüsselung. | gepackt: startet normal, Node-Modus wirkungslos |
| A18 | Sicherheit | N | IPC akzeptierte im fertigen Programm auch `http://localhost`-Absender. | Nur im Entwicklungsmodus. | Code |
| A19 | Windows | N | Ohne Installer fehlte die AppUserModelId (Taskleisten-Gruppierung der portablen Version). | Gesetzt. | Code |

## 2. Geprüft ohne Befund

* **Datei-Engine:** Invarianten I1–I6, Abgleich nach Absturz an 11 Punkten, Idempotenz, Pause/Abbruch,
  gesperrte Dateien, volle Datenträger, veränderte/fehlende Quellen – unverändert grün.
* **Groß-/Kleinschreibung (NTFS):** Konfliktprüfung über `stat` ist auf NTFS ohnehin case-insensitiv;
  Pfadschlüssel werden unter Windows klein geschrieben.
* **Windows-Rename überschreibt:** Alle Commits nutzen Hardlink bzw. Existenzprüfung; der Recovery-Pfad ist je
  Vorgang eindeutig.
* **Lange Pfade (> 260 Zeichen):** Node nutzt intern `\\?\`-Pfade; Dateioperationen funktionieren. Externe
  Decoder (ExifTool, FFmpeg) können bei sehr langen Pfaden scheitern → nur „Keine Vorschau“.
* **Ungültige Zeichen/reservierte Namen** in Paketordnern werden ersetzt (`CON`, `aux` …).
* **Freier Speicher** über `statfs` (unter Windows `GetDiskFreeSpaceEx`), Fehler → Prüfung entfällt, Laufzeitfehler `ENOSPC` bleibt abgefangen.
* **Tastatur unter deutscher Belegung:** AltGr (= Strg+Alt) löst keine Alt-Kürzel aus; Paketkürzel nur ohne
  Texteingabe; Menüleiste ist entfernt, damit Alt-Kürzel funktionieren.
* **Gepacktes Programm:** komplette E2E-Suite (17 Tests) gegen das gepackte Programm bestanden; Worker-Threads
  laden aus dem asar-Archiv.
* **Abhängigkeiten:** `npm audit --omit=dev`: 0 Befunde. Im Build-Werkzeug (electron-builder → minimatch)
  eine moderate Meldung, wird nicht ausgeliefert.
* **Toter Code:** `tsc --noUnusedLocals/--noUnusedParameters` ohne Befund.

## 3. Bekannte Grenzen (bewusst nicht geändert)

* **OneDrive „Nur online verfügbar“:** Lesen löst den Download aus. Die Hintergrund-Vorschauerzeugung kann
  daher einen kompletten Online-Ordner herunterladen. Node kann den Online-Status nicht abfragen
  (Vorschlag V6).
* Ist eine Zwischendatei nach dem Commit dauerhaft gesperrt, bleibt eine `.ppm-….tmp` im Zielordner zurück
  (Inhalt identisch, kein Verlust).
* HEIC-Vorschau (WIC) und Laufwerkstyp-Erkennung nutzen PowerShell; in Umgebungen mit eingeschränkter
  PowerShell (Constrained Language Mode) entfallen HEIC-Vorschau bzw. Recovery je Laufwerk (sicherer Rückfall).
* Windows-Installer und LGPL-FFmpeg konnten in der Build-Umgebung nicht erzeugt bzw. geladen werden (Wine-Absturz,
  Zugriffsrichtlinie). Auf Windows: `npm run dist:win`.

## 4. Prüfliste für die Abnahme auf Windows 10/11

Bitte auf einem echten PC durchgehen (je ✓/✗ notieren). Ich werte die Ergebnisse gern aus.

**Installation & Start**
- [ ] Installer und portable EXE starten; SmartScreen-Hinweis erscheint nur bei unsignierten Builds.
- [ ] Zweiter Start bringt das vorhandene Fenster nach vorn (keine zweite Instanz).
- [ ] Fenster öffnet nach Neustart mit gleicher Größe/Position (auch maximiert; auch nach Abziehen des 2. Monitors sichtbar).
- [ ] Einstellungen → Programmdaten zeigt „Decoder: Bilder ✓, RAW/EXIF ✓, Video ✓“.

**Quellen**
- [ ] Ordner auf C:, auf externer USB-Festplatte, auf SD-Karte, auf Netzlaufwerk (UNC und Laufwerksbuchstabe).
- [ ] OneDrive-Bilderordner: Dateien „immer verfügbar“ und „nur online“ erscheinen (Hinweis: Online-Dateien werden geladen).
- [ ] Symlink/Junction im Quellordner wird übersprungen (Quellen verwalten zeigt Anzahl).

**Export / Verschieben**
- [ ] Kopieren auf NTFS, exFAT-Stick und Netzlaufwerk; keine `.ppm-*.tmp` bleiben zurück.
- [ ] Datei in der Windows-Fotos-App geöffnet → Verschieben: Meldung „gesperrt“, automatische Wiederholung, Quelle bleibt.
- [ ] Verschieben von SD-Karte: Original landet im Standard-Wiederherstellungsbereich (nicht auf der Karte), Karte wird frei.
- [ ] Verschieben von Laufwerk D: (fest): versteckter Ordner `D:\.photopack-recovery` entsteht, Verschieben ist sofort fertig.
- [ ] USB-Stick während Export abziehen → Fehler „Ziel nicht erreichbar“, nach Einstecken „Fehlgeschlagene wiederholen“ erfolgreich.
- [ ] Windows während eines Exports abmelden → nach Anmeldung: Auftrag pausiert, Fortsetzen ohne Doppel-Dateien.
- [ ] Ziel mit sehr langem Pfad (> 260 Zeichen) funktioniert.

**Bedienung**
- [ ] 1366×768 bei 125 % und Full HD bei 150 %: alle Knöpfe erreichbar, Export-Knopf sichtbar.
- [ ] Tasten 1–9, Alt+1–5 (Sterne), Alt+6–9 (Farben), Strg+Z/Y mit deutscher Tastatur; AltGr+7 („{“) in der Suche tippt nur Zeichen.
- [ ] Drag & Drop in der Paketansicht mit Maus und Touchpad; Strg+Pfeiltasten.
- [ ] Präsentationsfenster auf zweitem Monitor im Vollbild; Pfeiltasten dort steuern die Auswahl.
- [ ] Hell/Dunkel/System folgt Windows-Einstellung; Titelleiste passt sich an.
- [ ] Windows-Kontrastdesign (Einstellungen → Barrierefreiheit → Kontrastdesigns): Auswahl und Pakete erkennbar.
- [ ] Sprachausgabe (Narrator): Kacheln und Paketknöpfe werden verständlich vorgelesen.
- [ ] HEIC-Datei vom iPhone: Vorschau mit installierter „HEIF-Bilderweiterung“.
- [ ] MP4 (H.264), MOV, MKV, HEVC-Video: Wiedergabe oder klare Meldung, Export funktioniert.

## 5. Vorschläge (nicht umgesetzt – Freigabe erforderlich)

| # | Vorschlag | Nutzen |
|---|---|---|
| V1 | **Kontextmenü (Rechtsklick)** auf Kacheln: Pakete, Bewertung, „Im Explorer anzeigen“, aus Paket entfernen | Windows-übliche Bedienung |
| V2 | **Ordner aus dem Explorer ins Fenster ziehen** = Quelle hinzufügen | schneller Einstieg |
| V3 | **Fortschritt in der Taskleiste** und Windows-Benachrichtigung bei Auftragsende/Fehlern | lange Exporte im Hintergrund |
| V4 | **Echter portabler Modus**: Programmdaten neben der portablen EXE statt in `%APPDATA%` | Betrieb vom USB-Stick |
| V5 | **Reihenfolge als Nummer voranstellen** beim Export (`001_…`, optional) | Paketreihenfolge auch in Explorer/Druckdiensten |
| V6 | OneDrive-„Nur online“-Dateien erkennen und Vorschauen dafür nur auf Anforderung erzeugen | kein ungewollter Massendownload |
