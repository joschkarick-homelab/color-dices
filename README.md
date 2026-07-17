# 🎲 Qwixx

Qwixx für 2 Spieler:innen — jede:r am eigenen Handy im Browser. Mit physikalisch
simulierten 3D-Würfeln (three.js + cannon-es) und frei konfigurierbaren
Hausregeln für Päsche, Straßen & Co.

## Spielen

1. **Spieler 1** öffnet die App, gibt seinen Namen ein und tippt auf
   **„Neues Spiel erstellen"**, legt die Hausregeln fest und teilt den
   4-stelligen Raum-Code (oder den Einladungslink).
2. **Spieler 2** öffnet die App und tritt mit dem Code bei.
3. Losgewürfelt! Die beiden Handys verbinden sich **direkt per WebRTC**
   (P2P) — es läuft kein Spielserver, nur die Signalisierung geht über den
   kostenlosen öffentlichen [PeerJS](https://peerjs.com)-Broker.

### Regeln

Implementiert sind die Original-Qwixx-Regeln:

- Der aktive Spieler würfelt alle Würfel. **Beide** dürfen die Summe der
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
festlegen, der beiden angezeigt wird, sobald es eintritt:

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
die Option **„🎯 Ziel auswürfeln?"**: Ist sie aktiv, können nach dem Event die
beteiligten Würfel einmal neu geworfen werden (per Button im Event-Banner oder
über den 🎯-Chip), um Ziele von 1–6 zu bestimmen — z. B. wer wie viel verteilt.
Beide Handys sehen dieselben Zielwerte.

### Die Würfel 🎲

Jeder Wurf wird mit einer echten Starrkörper-Physiksimulation gewürfelt
(cannon-es), inklusive Kollisionen, Stapeln und Sound. Damit beide Handys
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

### PeerJS-Signalisierung

Im Homelab-Deployment (Variante B) läuft ein eigener
[PeerServer](https://github.com/peers/peerjs-server) als `peer`-Container im
Compose-Stack. nginx proxied ihn unter `/peer` auf derselben Domain — die App
nutzt ihn im Docker-Build automatisch (Build-Variable `VITE_PEER_PATH`).

Vite-Dev und GitHub Pages (Variante A) haben keinen eigenen Broker und
nutzen die öffentliche PeerJS-Cloud. Ein manueller Override geht weiterhin
auf beiden Geräten per Browser-Konsole:

```js
localStorage.setItem('qwixx.peerhost', 'peer.example.de:443/qwixx')
```

## Entwicklung

```bash
npm install
npm run dev        # Dev-Server
npm run typecheck  # TypeScript prüfen
npm run build      # Produktions-Build nach dist/
```

Stack: Vite + TypeScript (vanilla), three.js + cannon-es (Würfel),
PeerJS (WebRTC-Multiplayer). Die komplette Spiellogik liegt UI-frei in
[`src/rules.ts`](src/rules.ts).
