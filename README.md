# Reddit DE – Kommentar-Übersetzer

Firefox-Add-on, das unter **jedem** fremdsprachigen Reddit-Kommentar eine Box mit der deutschen
Übersetzung einblendet. Der Originalkommentar bleibt vollständig stehen – es wird nur ergänzt,
nie ersetzt.

## Wie es arbeitet

**Ein** Erkennungs-Aufruf pro Beitrag, danach nur noch Übersetzungen:

1. **Spracherkennung – einmal je Beitrag.** Beim ersten Kommentar eines Threads gehen bis zu
   **5 Kommentare gemeinsam in einer einzigen Anfrage** an das Modell, das für jeden davon
   einen Sprachcode zurückgibt (`en,en,de,en,en`). Die Mehrheit bestimmt die Sprache des
   Beitrags. Danach wird für diesen Thread **nie wieder** eine Erkennung durchgeführt – auch
   nicht für nachgeladene Kommentare. Das Ergebnis wird eine Woche lang gespeichert.
   Der Prompt ist so gebaut, dass englische Lehnwörter, Marken-, Spiel- und Produktnamen,
   Zitate, Code, URLs und Reddit-Kürzel (`u/name`, `r/sub`, `/s`) einen ansonsten deutschen
   Kommentar **nicht** fälschlich als englisch einstufen.
2. **Übersetzung** – nur wenn der Beitrag nicht als deutsch erkannt wurde. Der Prompt achtet auf
   Absätze, Zeilenumbrüche, Listen, Zitate, Codeblöcke, Markdown-Auszeichnung (`**fett**`,
   `*kursiv*`, `` `code` ``, `[Text](URL)`) sowie auf Tonfall und Register.

Ein deutscher Beitrag kostet damit insgesamt **einen einzigen API-Aufruf** – danach wird nichts
mehr geprüft und nichts übersetzt.

Taucht in einem fremdsprachigen Thread doch ein deutscher Kommentar auf, fängt ihn die
Übersetzung selbst ab: Das Modell ist angewiesen, bereits deutschen Text unverändert
zurückzugeben. Kommt die Antwort identisch zurück, wird die Box wieder ausgeblendet – ohne
zusätzlichen Aufruf.

Bis zu **5 Kommentare werden gleichzeitig** verarbeitet (einstellbar 1–5), der Rest wartet in
einer Warteschlange. Übersetzungen werden lokal zwischengespeichert und beim erneuten Aufruf
desselben Kommentars nicht noch einmal an die API geschickt.

Alle Anfragen laufen über die **Responses-API** (`/v1/responses`). Sollte ein Modell diese nicht
unterstützen, wechselt das Add-on automatisch und dauerhaft auf `/v1/chat/completions`.

## Installation

Doppelklick auf **`Addon installieren.bat`**. Das Skript baut das Paket, legt dessen Pfad in
die Zwischenablage und öffnet in Firefox die Seite `about:debugging`. Dort noch:

1. **„Temporäres Add-on laden…“** klicken
2. im Dateidialog **Strg + V** drücken
3. **Enter**

Alternativ von Hand: `about:debugging#/runtime/this-firefox` → „Temporäres Add-on laden…“ →
`manifest.json` in diesem Ordner auswählen.

### Dauerhaft installieren

Temporär geladene Add-ons verschwinden beim **Neustart von Firefox**. Firefox Release und Beta
installieren dauerhaft ausschließlich **signierte** Add-ons – die Einstellung
`xpinstall.signatures.required` wird dort ignoriert. Zwei Wege:

**a) Kostenlos von Mozilla signieren lassen** (empfohlen, Add-on bleibt privat):

1. Konto auf <https://addons.mozilla.org> anlegen
2. Zugangsdaten erzeugen: <https://addons.mozilla.org/developers/addon/api/key/>
3. ausführen:
   ```powershell
   powershell -ExecutionPolicy Bypass -File tools\sign.ps1
   ```
4. Das signierte XPI aus `dist\` per Doppelklick installieren

Bei jeder neuen Version die `version` in `manifest.json` erhöhen und erneut signieren.

**b) Firefox Developer Edition, Nightly oder ESR verwenden:** dort
`about:config` → `xpinstall.signatures.required = false` setzen und das XPI aus `dist\`
per Doppelklick installieren.

## Einrichtung

1. `about:addons` → Reddit DE → **Einstellungen** (oder direkt `src/options.html`)
2. Erscheint oben der Abschnitt **Berechtigung**: **„Zugriff auf api.openai.com erlauben“**
   klicken. Firefox erteilt Add-ons Server-Zugriffe unter Manifest V3 nicht automatisch – ohne
   diese Freigabe schlägt jeder API-Aufruf fehl.
3. **API-Key** eintragen (`sk-…`, von <https://platform.openai.com/api-keys>)
4. **Verbindung testen** – gibt das Modell einen deutschen Beispieltext zurück, passt alles
5. **Speichern**, dann offene Reddit-Tabs neu laden

## Modelle

Voreingestellt ist **`gpt-5.4-mini`** – das stärkste Modell aus dem Kontingent mit
2,5 Mio. Token pro Tag. Alternativ stehen `gpt-5-mini`, `gpt-4.1-mini`, `gpt-4o-mini`,
die Nano-Varianten sowie `o4-mini`/`o3-mini` zur Auswahl; die großen Modelle (`gpt-5.4`,
`gpt-5`, `gpt-4.1`, `gpt-4o`) teilen sich das kleinere Kontingent von 250 k Token pro Tag.

Das Gratis-Kontingent setzt voraus, dass im OpenAI-Konto das Teilen von API-Daten aktiviert
ist. Darüber hinausgehende Nutzung wird normal abgerechnet.

## Einstellungen

| Option | Bedeutung |
| --- | --- |
| Add-on aktiv | Schaltet alle Boxen ein/aus |
| Automatisch übersetzen | Aus: unter jedem Kommentar erscheint stattdessen ein Knopf |
| Nur sichtbare Kommentare | Übersetzt erst beim Heranscrollen – spart in langen Threads sehr viel |
| Zwischenspeichern | Verhindert doppelte API-Aufrufe für denselben Text |
| Lokal vorfiltern | Erkennt offensichtlich deutsche Beiträge ohne API-Aufruf (schneller, ungenauer) |
| Spracherkennung | `Einmal pro Beitrag` (Standard) oder `Für jeden Kommentar einzeln` |
| Gleichzeitige Übersetzungen | 1–5 parallele Anfragen |
| Mindestlänge | Kürzere Kommentare werden ignoriert |
| Denkaufwand | `minimal`/`low`/`medium` für gpt-5- und o-Modelle |
| Anfragen protokollieren | Sendet `store: true` – Anfragen erscheinen in den OpenAI-Logs (Standard: an) |
| Ausführliche Konsolenausgabe | Schreibt Token-Verbrauch je Aufruf in die Konsole des Add-ons |

## Nachvollziehen, was verbraucht wird

**In den OpenAI-Logs.** Mit eingeschalteter Protokollierung geht jede Anfrage mit `store: true`
und Metadaten an die API und ist unter <https://platform.openai.com/logs> einsehbar – inklusive
Volltext, Modell, Dauer und Token-Verbrauch. Filtern lässt sich nach:

| Metadatum | Inhalt |
| --- | --- |
| `app` | immer `reddit-de-translator` |
| `kind` | `detect`, `translate` oder `test` |
| `post` | Reddit-Beitrags-ID, z. B. `t3_1vz4sl7` |
| `from` | erkannte Ausgangssprache der Übersetzung |
| `chars` | Zeichenzahl des gesendeten Textes |
| `budget` | zugeteiltes Token-Budget der Antwort |
| `samples` | Anzahl der Kommentare in der Erkennungs-Stichprobe |

So lässt sich in den Logs direkt sehen, welcher Beitrag wie viele Aufrufe verursacht hat und
welcher Kommentar besonders teuer war.

**Im Add-on.** Die Einstellungsseite zeigt unter *Protokoll und Verbrauch* den heutigen und den
gesamten Token-Verbrauch, aufgeteilt nach Ein- und Ausgabe, Anzahl der Aufrufe sowie deren
Aufteilung in Erkennung und Übersetzung. Separat ausgewiesen werden **Denk-Token**
(`reasoning_tokens`) – der häufigste Grund für unerwartet hohen Verbrauch. Sind sie auffällig
hoch, hilft der **Denkaufwand** `minimal`.

**In der Konsole.** Mit eingeschalteter ausführlicher Ausgabe erscheint zu jedem Aufruf eine
Zeile in der Add-on-Konsole (`about:debugging` → beim Add-on auf *Untersuchen*):

```
[Reddit DE] translate  gpt-5.4-mini  Eingabe 412 / Ausgabe 380 (davon Denken 128)  gesamt 792  1.8s  t3_abc  340 Zeichen
```

Die Protokollierung lässt sich jederzeit abschalten – dann geht `store: false` mit und es werden
keine Metadaten übertragen.

## Token sparen

* **Spracherkennung** auf `Einmal pro Beitrag` lassen (Standard). Ein Thread mit 200
  Kommentaren kostet damit einen Erkennungs-Aufruf statt 200.
* **Nur sichtbare Kommentare** eingeschaltet lassen (Standard).
* **Lokal vorfiltern** aktivieren, wenn du überwiegend in deutschen Subreddits unterwegs bist –
  dann entfällt auch der eine Erkennungs-Aufruf.
* Mindestlänge erhöhen (z. B. 15), damit „lol“ oder „this“ nicht übersetzt werden.

## Aufbau

```
manifest.json           Manifest V3 (Firefox)
src/background.js       API-Aufrufe, Warteschlange (max. 5 parallel), Cache, Prompts
src/content.js          Kommentar-Erkennung, Textextraktion mit Zeilenstruktur, Box-Rendering
src/content.css         Gestaltung der Box (folgt Reddits Hell/Dunkel-Design)
src/options.html/js     Einstellungsseite
Addon installieren.bat  Installer (Doppelklick)
tools/build.ps1         Baut dist\reddit-de-translator-<version>.xpi
tools/install.ps1       Baut das Paket und öffnet die Ladeseite in Firefox
tools/sign.ps1          Signierung über Mozilla für die dauerhafte Installation
test/fixture.html       Testseite mit nachgebauter Reddit-Struktur (nur für Entwicklung)
test/background.test.js Prüft Aufrufzahl, Responses-API, Rückfall, Logging und Statistik
```

Unterstützt das neue Reddit (`shreddit-comment`) und `old.reddit.com`. Nachgeladene Kommentare
(„Mehr Kommentare laden“, SPA-Navigation) werden über einen `MutationObserver` erfasst.

Die Antwort des Modells wird nie als HTML eingefügt, sondern als DOM-Knoten aufgebaut; Links
werden nur mit `http(s)`-Schema übernommen.

## Entwicklung

```bash
node test/background.test.js
```

prüft ohne Browser und ohne API-Key, dass je Beitrag genau ein Erkennungs-Aufruf entsteht, dass
die Responses-API im erwarteten Format angesprochen wird, dass der Rückfall auf Chat Completions
greift und dass `store`, Metadaten und Token-Statistik stimmen.

`test/fixture.html` bildet die DOM-Struktur echter Reddit-Kommentare nach und stubbt die
Extension-API. Jede Box zeigt dort genau den Text, der an die API gehen würde:

```bash
python -m http.server 8765
```

Dann `http://localhost:8765/test/fixture.html` öffnen. Die Ordner `test/` und `.claude/` gehören
nicht ins fertige Add-on-Paket.
