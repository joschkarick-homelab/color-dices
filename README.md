# 🎲 Würfelrunde

Würfelspiele für **1–10 Spieler:innen** — jede:r am eigenen Handy im Browser.
Aktuell spielbar: **Qwixx** und **Kniffel** (Auswahl auf der Startseite,
weitere Spiele lassen sich ergänzen). Mit physikalisch simulierten 3D-Würfeln
(three.js + cannon-es) und frei konfigurierbaren Hausregeln, die sich als
Vorlagen speichern lassen.

## Spielen

1. **Der Host** öffnet die App, gibt seinen Namen ein, wählt das Spiel aus,
   tippt auf **„Neues Spiel erstellen"**, legt die Hausregeln fest und teilt
   den 4-stelligen Raum-Code (oder den Einladungslink).
2. **Die Mitspieler:innen** treten mit dem Code bei. Der Host sieht in der
   Lobby, wer schon da ist, und startet das Spiel, sobald er möchte —
   auch solo oder mit bis zu 9 Gästen.
3. Losgewürfelt! Im Homelab-Deployment hält ein **Raum-Server** den
   Spielstand — Verbindungsabbrüche (Standby, App-Wechsel, Reload) sind
   unkritisch, beim Wiederverbinden kommt der aktuelle Stand vom Server.
   Ohne Server (GitHub Pages, Dev) verbinden sich die Handys **direkt per
   WebRTC** (P2P, Stern-Topologie über den Host).
4. Im Spiel einfach nach unten scrollen, um die Boards aller Mitspieler:innen
   und deren Fortschritt zu sehen.

### Als App aufs Handy 📱

Die App ist eine PWA: In Safari/Chrome **„Zum Home-Bildschirm hinzufügen"**
wählen — dann startet sie im Vollbild mit eigenem Icon, und die
Bildschirmsperre wird während des Spiels zuverlässig unterdrückt (Wake Lock,
auf iOS ab 18.4 auch in installierten Web-Apps).

### Regeln

Implementiert sind die Original-Qwixx-Regeln:

- Der aktive Spieler würfelt alle Würfel. **Alle** dürfen die Summe der
  weißen Würfel in einer beliebigen Reihe ankreuzen.
- Nur der **aktive** Spieler darf zusätzlich einen weißen mit einem farbigen
  Würfel kombinieren (erst weiß, dann farbig).
- Kreuze nur von links nach rechts; übersprungene Zahlen sind verloren.
- Die letzte Zahl einer Reihe (12 bzw. 2) darf nur mit mindestens 5 Kreuzen
  in der Reihe angekreuzt werden → Reihe wird **zugemacht** (Bonuskreuz, der
  farbige Würfel fliegt raus).
- Kreuzt der aktive Spieler nichts an, kassiert er einen **Fehlwurf** (−5).
- Ende bei **2 zugemachten Reihen** oder **4 Fehlwürfen**. Punkte laut
  Qwixx-Tabelle (1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66, 78).

### Hausregeln 📜

Beim Erstellen des Spiels lässt sich für jedes Ereignis ein eigener Text
festlegen, der allen angezeigt wird, sobald es eintritt:

| Ereignis | Auslöser |
|---|---|
| ⚪⚪ Pasch Weiß/Weiß | beide weißen Würfel zeigen dieselbe Zahl |
| ⚪🎨 Pasch Weiß/Farbig | ein weißer + ein farbiger Würfel zeigen dieselbe Zahl |
| 🛣️ Kleine Straße | 4 aufeinanderfolgende Zahlen (Farbe egal) |
| 🛤️ Große Straße | 5 aufeinanderfolgende Zahlen (Farbe egal) |
| 🔒 Reihe zugemacht | jemand schließt eine Reihe ab |
| ❌ Strafe | jemand kassiert einen Fehlwurf |
| 🏆 Sieg | jemand gewinnt |

Für die würfelbasierten Events (beide Päsche, beide Straßen) gibt es zusätzlich
die Option **„🎯 Ziel auswürfeln?"**: Ist sie aktiv, wird nach dem Event ein
einzelner Zielwürfel geworfen (per Button im Event-Banner oder über den
🎯-Chip), der eine Zahl von 1–6 bestimmt — z. B. wer wie viel verteilt. Alle
Handys sehen denselben Zielwert; das Ergebnis samt auslösendem Ereignis und
Regeltext bleibt stehen, bis es weggetippt wird.

## Kniffel

Klassisches Kniffel nach den offiziellen Regeln: Der aktive Spieler würfelt
5 Würfel, darf bis zu 3× würfeln und zwischen den Würfen Würfel festhalten
(antippen), dann eine Kategorie eintragen oder streichen. Oben gibt es ab
63 Punkten +35 Bonus, jeder weitere Kniffel bringt +100 (mit Joker-Wertung
für Full House und Straßen). Alle sehen live, wie der aktive Spieler würfelt
und hält; die Zettel der Mitspieler stehen unter dem eigenen.

### Kniffel-Hausregeln 🥃

Jede Regel besteht aus drei Bausteinen — so ist immer klar, **was mit wem
passiert**:

1. **Auslöser**: Kniffel, Zusatz-Kniffel, Viererpasch, Full House, große/kleine
   Straße, Gestrichen, Bonus geschafft, Sieg, letzter Platz.
2. **Zielperson**: der Auslöser selbst, alle anderen, alle — oder 🎲 **ein
   Würfelwurf bestimmt den Spieler** (Sitzreihenfolge = Würfelzahl).
3. **Aktion mit Varianz**: fester Text, optional 🎲 **Anzahl auswürfeln** (1–6)
   und/oder eine 🎲 **Würfeltabelle** mit 6 frei beschriftbaren Einträgen
   (z. B. welcher Shot; leere Felder = Glück gehabt).

Beispiel: *Kniffel!* → Zielperson auswürfeln → **Ben** → Tabelle auswürfeln →
**3 = Tequila**. Jede ausgewürfelte Stufe rollt sichtbar über den Würfeltisch
(blau = wer, rot = wie oft, gelb = was), das Banner fasst alles zusammen und
bleibt stehen, bis es weggetippt wird.

### Regel-Vorlagen 💾

Hausregeln (Qwixx und Kniffel) lassen sich im Setup als benannte Vorlagen
speichern, laden und löschen. Vorlagen sind aktuell **global auf dem Gerät**
gespeichert (localStorage); die Persistenz-Schicht ([`src/presets.ts`](src/presets.ts))
ist mit `owner`-Feld und async API bereits so gebaut, dass später ein Backend
mit user-gebundenen Vorlagen dieselbe Schnittstelle bedienen kann.

### Die Würfel 🎲

Jeder Wurf wird mit einer echten Starrkörper-Physiksimulation gewürfelt
(cannon-es), inklusive Kollisionen, Stapeln und Sound. Damit alle Handys
trotz unabhängiger Simulation **dieselben Augenzahlen** sehen, entscheidet
der Host die Werte; die Simulation läuft zuerst unsichtbar durch, dann werden
die Würfelseiten passend belegt und der Wurf sichtbar abgespielt. Schief
gelandete Würfel werden — wie am echten Tisch — automatisch neu geworfen.
Tipp: Während der Animation tippen = vorspulen.

## Deployment

### Variante A: GitHub Pages (kein eigener Server)

Der Workflow [`pages.yml`](.github/workflows/pages.yml) baut die App bei jedem
Push auf `main` und deployt sie nach GitHub Pages. Einmalig aktivieren:
**Settings → Pages → Source: „GitHub Actions"**.

> Hinweis: Bei einem privaten Repo braucht GitHub Pages einen Pro-Plan —
> sonst das Repo öffentlich stellen oder Variante B nutzen.

### Variante B: Homelab (GHCR + Tailscale)

Gleicher Flow wie bei TimeHub / Date-App:

1. [`build.yml`](.github/workflows/build.yml) baut das Image und pusht nach
   `ghcr.io/joschkarick-homelab/color-dices:latest`.
2. [`deploy.yml`](.github/workflows/deploy.yml) verbindet sich per Tailscale
   mit dem LXC, kopiert `docker-compose.prod.yml` + `stack.env` und macht
   `docker compose pull && up -d`.

Benötigte Secrets (wie gehabt): `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`,
`DEPLOY_USER`, `DEPLOY_HOST` — plus optional `HOST_PORT` (Default 8090).
Dazu die Repository-Variable `DEPLOY_PATH` (Zielverzeichnis auf dem LXC). Da das Repo privat ist, muss der LXC einmalig per
`docker login ghcr.io` (PAT mit `read:packages`) angemeldet sein — oder das
GHCR-Package auf „public" gestellt werden.

Lokal testen: `docker compose up --build` → http://localhost:8090

### Raum-Server (empfohlen) & PeerJS-Fallback

Im Homelab-Deployment (Variante B) läuft der **Raum-Server**
([`server/rooms.ts`](server/rooms.ts)) als `rooms`-Container im Compose-Stack
(Image-Tag `:rooms`, nginx-Proxy unter `/rooms`, Build-Variable
`VITE_ROOM_PATH`). Er nutzt dieselben Engine-Module wie der Client, hält
Lobby + Spielstand im Speicher und führt alle Aktionen selbst aus. Dadurch
sind Verbindungsabbrüche egal: Jeder Client — auch der Raum-Ersteller — kann
das Handy sperren, die App wechseln oder neu laden und steigt per Client-ID
nahtlos wieder ein. Räume werden nach längerer Inaktivität aufgeräumt; ein
Container-Neustart beendet laufende Spiele.

Ohne Raum-Server (Vite-Dev, GitHub Pages) läuft der P2P-Modus über den
[PeerServer](https://github.com/peers/peerjs-server) (`peer`-Container,
`/peer`-Proxy, `VITE_PEER_PATH`) bzw. die öffentliche PeerJS-Cloud.
Manuelle Overrides per Browser-Konsole:

```js
localStorage.setItem('qwixx.roomhost', '127.0.0.1:9300') // Raum-Server direkt
localStorage.setItem('qwixx.roomhost', 'off')            // Server-Modus abschalten
localStorage.setItem('qwixx.peerhost', 'peer.example.de:443/qwixx')
```

## Entwicklung

```bash
npm install
npm run dev           # Dev-Server
npm run typecheck     # TypeScript prüfen (Client + Server)
npm run build         # Produktions-Build nach dist/
npm run build:server  # Raum-Server-Bundle nach dist-server/
```

Stack: Vite + TypeScript (vanilla), three.js + cannon-es (Würfel),
PeerJS (WebRTC-Multiplayer). Die komplette Spiellogik liegt UI-frei in
[`src/rules.ts`](src/rules.ts).
