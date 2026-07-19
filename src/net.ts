// P2P-Verbindung über WebRTC (PeerJS). Die App braucht dadurch keinen eigenen
// Server: Signalisierung läuft über den öffentlichen PeerJS-Broker, die
// Spieldaten fließen direkt zwischen den Handys. Der Host hält dabei je eine
// Verbindung zu jedem Gast (Stern-Topologie).

import { Peer, type DataConnection, type PeerOptions } from 'peerjs'
import type { GameState, Move } from './rules'
import type { KniffelCategory, KniffelState } from './kniffel'
import type { GameId } from './presets'

/** Zustand irgendeines Spiels; `game` fehlt bei alten Qwixx-Ständen. */
export type AnyState = GameState | KniffelState

/** Kniffel-Aktion eines Gasts (der Host führt sie aus). */
export type KniffelAction =
  | { k: 'roll'; hold: boolean[] }
  | { k: 'hold'; hold: boolean[] }
  | { k: 'score'; cat: KniffelCategory }

const ID_PREFIX = 'qwixx-de-'

/**
 * Signalisierung: Im Docker-Build läuft ein eigener PeerServer im Stack,
 * den nginx unter /peer auf derselben Origin bereitstellt (Build-Variable
 * VITE_PEER_PATH). Ohne diese Variable (Vite-Dev, GitHub Pages) wird der
 * öffentliche PeerJS-Cloud-Broker genutzt. Ein manueller Override ist
 * weiterhin per localStorage möglich, z. B.:
 *   localStorage.setItem('qwixx.peerhost', 'peer.example.de:443/qwixx')
 */
function peerOptions(): PeerOptions {
  const raw = localStorage.getItem('qwixx.peerhost')
  if (raw) {
    const match = raw.match(/^([^:/]+)(?::(\d+))?(\/.*)?$/)
    if (match) {
      const [, host, port, path] = match
      const secure = host !== 'localhost' && host !== '127.0.0.1'
      return {
        host,
        port: port ? Number(port) : secure ? 443 : 80,
        path: path ?? '/',
        secure,
      }
    }
  }
  const peerPath = import.meta.env.VITE_PEER_PATH as string | undefined
  if (peerPath) {
    const secure = location.protocol === 'https:'
    return {
      host: location.hostname,
      port: location.port ? Number(location.port) : secure ? 443 : 80,
      path: peerPath,
      secure,
    }
  }
  return {}
}
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // ohne I/L/O/0/1

export type NetMessage =
  | { t: 'hello'; name: string; cid: string } // Gast meldet sich an (auch Reconnect)
  | { t: 'welcome'; idx: number; mod?: boolean } // Spieler-Index (+ Moderator im Server-Modus)
  | { t: 'lobby'; names: string[]; game: GameId } // aktueller Lobby-Stand für alle Gäste
  | { t: 'full' } // Raum voll oder Spiel läuft bereits
  | { t: 'state'; s: AnyState }
  | { t: 'move'; move: Move } // Qwixx: Zug des Gasts
  | { t: 'rollreq' } // Qwixx: Gast ist am Zug und möchte würfeln (Host würfelt)
  | { t: 'targetreq'; uid: string } // Qwixx: Gast möchte für ein Event das Ziel auswürfeln
  | { t: 'act'; a: KniffelAction } // Kniffel: Aktion des Gasts
  | { t: 'start' } // Server-Modus: Moderator startet das Spiel
  | { t: 'rematch' } // Server-Modus: Moderator startet die Revanche

export function randomCode(len = 4): string {
  let out = ''
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return out
}

export class Net {
  readonly kind = 'p2p' as const
  /** `from` identifiziert beim Host die Verbindung; beim Gast immer der Host. */
  onMessage: (msg: NetMessage, from: number) => void = () => {}
  onPeerConnected: (id: number) => void = () => {}
  onPeerDisconnected: (id: number) => void = () => {}

  /** Darf Spiel/Revanche starten (im P2P-Modus: der Host). */
  get moderator(): boolean {
    return this.role === 'host'
  }

  private conns = new Map<number, DataConnection>()
  private nextConnId = 1

  private constructor(
    private peer: Peer,
    readonly code: string,
    readonly role: 'host' | 'guest',
  ) {
    // Geht der Tab in den Hintergrund (Standby, App-Wechsel), kappt der
    // Browser die WebSocket zum Broker und die Raum-ID ist dort nicht mehr
    // registriert — Beitritte schlagen dann mit peer-unavailable fehl.
    // Deshalb: Registrierung automatisch erneuern.
    peer.on('disconnected', () => {
      if (!peer.destroyed) peer.reconnect()
    })
    document.addEventListener('visibilitychange', this.onVisible)
  }

  private onVisible = (): void => {
    if (document.visibilityState === 'visible' && this.peer.disconnected && !this.peer.destroyed) {
      this.peer.reconnect()
    }
  }

  /**
   * Raum eröffnen. Bei Code-Kollision wird automatisch neu gewürfelt.
   * `fixedCode` erlaubt es dem Host, nach einem Seiten-Reload denselben
   * Raum wieder zu öffnen.
   */
  static host(fixedCode?: string): Promise<Net> {
    return new Promise((resolve, reject) => {
      let attempts = 0
      const tryOpen = (): void => {
        const code = attempts === 0 && fixedCode ? fixedCode : randomCode()
        const peer = new Peer(ID_PREFIX + code, peerOptions())
        peer.on('open', () => {
          const net = new Net(peer, code, 'host')
          peer.on('connection', (conn) => net.attach(conn))
          resolve(net)
        })
        peer.on('error', (err) => {
          if ((err as { type?: string }).type === 'unavailable-id' && attempts++ < 5) {
            peer.destroy()
            tryOpen()
          } else {
            reject(err)
          }
        })
      }
      tryOpen()
    })
  }

  static join(code: string): Promise<Net> {
    const id = ID_PREFIX + code.toUpperCase()
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerOptions())
      let attempts = 0
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        peer.destroy()
        reject(err)
      }
      const timeout = setTimeout(
        () => fail(new Error('Zeitüberschreitung – Code richtig? Ist das Spiel noch offen?')),
        20000,
      )
      const tryConnect = (): void => {
        if (settled) return
        const conn = peer.connect(id, { reliable: true })
        conn.on('open', () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          const net = new Net(peer, code.toUpperCase(), 'guest')
          net.attach(conn)
          resolve(net)
        })
      }
      peer.on('error', (err) => {
        // Der Host registriert sich nach Standby ggf. gerade neu beim
        // Broker — bei „Raum nicht gefunden" darum erst ein paarmal
        // nachfassen, bevor wir aufgeben.
        if ((err as { type?: string }).type === 'peer-unavailable') {
          if (attempts++ < 4) setTimeout(tryConnect, 2000)
          else fail(new Error('Raum nicht gefunden – Code richtig? Ist das Spiel auf dem anderen Gerät noch geöffnet?'))
        } else {
          fail(err)
        }
      })
      peer.on('open', tryConnect)
    })
  }

  private attach(conn: DataConnection): void {
    const id = this.nextConnId++
    this.conns.set(id, conn)
    conn.on('data', (data) => this.onMessage(data as NetMessage, id))
    conn.on('close', () => {
      if (this.conns.get(id) === conn) {
        this.conns.delete(id)
        this.onPeerDisconnected(id)
      }
    })
    if (conn.open) this.onPeerConnected(id)
    else conn.on('open', () => this.onPeerConnected(id))
  }

  /** An alle offenen Verbindungen senden (beim Gast: an den Host). */
  send(msg: NetMessage): void {
    for (const conn of this.conns.values()) {
      if (conn.open) conn.send(msg)
    }
  }

  sendTo(id: number, msg: NetMessage): void {
    const conn = this.conns.get(id)
    if (conn?.open) conn.send(msg)
  }

  /** Verbindung gezielt schließen (z. B. alte Verbindung nach Reconnect). */
  close(id: number): void {
    const conn = this.conns.get(id)
    this.conns.delete(id)
    conn?.close()
  }

  get connected(): boolean {
    return [...this.conns.values()].some((c) => c.open)
  }

  destroy(): void {
    document.removeEventListener('visibilitychange', this.onVisible)
    this.peer.destroy()
  }
}

// ---------------------------------------------------------------------------
// Server-Modus: Raum-Server statt P2P
//
// Der Raum-Server (server/rooms.ts) hält den Spielstand und führt alle
// Aktionen selbst aus. Damit dürfen Verbindungen jederzeit abreißen — beim
// Wiederverbinden kommt der aktuelle Stand vom Server, auch für den Raum-
// Ersteller. Jeder Client verhält sich wie ein Gast; `moderator` markiert
// den Ersteller (darf starten/Revanche).

/**
 * Adresse des Raum-Servers, falls konfiguriert (sonst P2P-Modus).
 * Docker-Build: VITE_ROOM_PATH (nginx-Proxy /rooms). Manueller Override:
 *   localStorage.setItem('qwixx.roomhost', '127.0.0.1:9300')
 */
export function roomServerUrl(): string | null {
  const raw = localStorage.getItem('qwixx.roomhost')
  if (raw) {
    if (raw === 'off') return null // Server-Modus gezielt abschalten
    const secure = !raw.startsWith('localhost') && !raw.startsWith('127.0.0.1')
    return `${secure ? 'wss' : 'ws'}://${raw}`
  }
  const path = import.meta.env.VITE_ROOM_PATH as string | undefined
  if (path) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`
  return null
}

/** Nachrichten, die nur zwischen Client und Raum-Server laufen. */
type RoomClientMsg =
  | { t: 'create'; game: GameId; rules: unknown; name: string; cid: string }
  | { t: 'join'; code: string; name: string; cid: string }
  | NetMessage
type RoomServerMsg = { t: 'created'; code: string } | { t: 'joinfail'; reason: string } | NetMessage

export class RoomNet {
  readonly kind = 'server' as const
  readonly role = 'guest' as const // alle Clients nutzen die Gast-Pfade
  code = ''
  moderator = false
  onPeerConnected: (id: number) => void = () => {}
  onPeerDisconnected: (id: number) => void = () => {}

  private _onMessage: ((msg: NetMessage, from: number) => void) | null = null
  private queue: NetMessage[] = []

  /** Nachrichten vor dem Setzen des Handlers werden gepuffert. */
  set onMessage(fn: (msg: NetMessage, from: number) => void) {
    this._onMessage = fn
    for (const m of this.queue.splice(0)) fn(m, 0)
  }

  private constructor(private ws: WebSocket) {}

  private static connect(
    firstMsg: RoomClientMsg,
    resolveOn: (m: RoomServerMsg, net: RoomNet) => boolean,
  ): Promise<RoomNet> {
    const url = roomServerUrl()
    if (!url) return Promise.reject(new Error('Kein Raum-Server konfiguriert'))
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const net = new RoomNet(ws)
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        ws.close()
        reject(err)
      }
      const timeout = setTimeout(() => fail(new Error('Zeitüberschreitung – Server erreichbar?')), 15000)
      ws.onopen = () => ws.send(JSON.stringify(firstMsg))
      ws.onerror = () => fail(new Error('Verbindung zum Spielserver fehlgeschlagen'))
      ws.onclose = () => {
        if (!settled) fail(new Error('Verbindung zum Spielserver getrennt'))
        else net.onPeerDisconnected(0)
      }
      ws.onmessage = (ev) => {
        let m: RoomServerMsg
        try {
          m = JSON.parse(String(ev.data)) as RoomServerMsg
        } catch {
          return
        }
        if (m.t === 'created') {
          net.code = m.code
          return
        }
        if (m.t === 'joinfail' || (m.t === 'full' && !settled)) {
          fail(new Error(m.t === 'joinfail' ? m.reason : 'Das Spiel ist schon voll oder läuft bereits.'))
          return
        }
        if (m.t === 'welcome') net.moderator = !!m.mod
        if (!settled && resolveOn(m, net)) {
          settled = true
          clearTimeout(timeout)
          resolve(net)
        }
        net.deliver(m as NetMessage)
      }
    })
  }

  /** Raum erstellen; auflösen, sobald der Server Code + Spieler-Index bestätigt. */
  static create(game: GameId, rules: unknown, name: string, cid: string): Promise<RoomNet> {
    return RoomNet.connect({ t: 'create', game, rules, name, cid }, (m, net) => m.t === 'welcome' && net.code !== '')
  }

  static join(code: string, name: string, cid: string): Promise<RoomNet> {
    return RoomNet.connect({ t: 'join', code: code.toUpperCase(), name, cid }, (m, net) => {
      if (m.t === 'welcome') net.code = code.toUpperCase()
      return m.t === 'welcome'
    })
  }

  private deliver(m: NetMessage): void {
    if (this._onMessage) this._onMessage(m, 0)
    else this.queue.push(m)
  }

  send(msg: NetMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  // Nur im P2P-Host-Modus relevant — hier bewusst wirkungslos.
  sendTo(_id: number, _msg: NetMessage): void {}
  close(_id: number): void {}

  get connected(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  destroy(): void {
    this.ws.onclose = null
    this.ws.close()
  }
}

/** Gemeinsame Schnittstelle beider Netz-Implementierungen. */
export type GameNet = Net | RoomNet
