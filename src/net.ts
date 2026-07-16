// P2P-Verbindung über WebRTC (PeerJS). Die App braucht dadurch keinen eigenen
// Server: Signalisierung läuft über den öffentlichen PeerJS-Broker, die
// Spieldaten fließen direkt zwischen den beiden Handys.

import { Peer, type DataConnection, type PeerOptions } from 'peerjs'
import type { GameState, Move } from './rules'

const ID_PREFIX = 'qwixx-de-'

/**
 * Standardmäßig läuft die Signalisierung über den kostenlosen öffentlichen
 * PeerJS-Broker. Wer einen eigenen PeerServer betreibt, kann ihn per
 * localStorage-Eintrag nutzen, z. B.:
 *   localStorage.setItem('qwixx.peerhost', 'peer.example.de:443/qwixx')
 */
function peerOptions(): PeerOptions {
  const raw = localStorage.getItem('qwixx.peerhost')
  if (!raw) return {}
  const match = raw.match(/^([^:/]+)(?::(\d+))?(\/.*)?$/)
  if (!match) return {}
  const [, host, port, path] = match
  const secure = host !== 'localhost' && host !== '127.0.0.1'
  return {
    host,
    port: port ? Number(port) : secure ? 443 : 80,
    path: path ?? '/',
    secure,
  }
}
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // ohne I/L/O/0/1

export type NetMessage =
  | { t: 'hello'; name: string }
  | { t: 'state'; s: GameState }
  | { t: 'move'; move: Move }
  | { t: 'rollreq' } // Gast ist am Zug und möchte würfeln (Host würfelt)
  | { t: 'targetreq'; uid: string } // Gast möchte für ein Event das Ziel auswürfeln

export function randomCode(len = 4): string {
  let out = ''
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return out
}

export class Net {
  onMessage: (msg: NetMessage) => void = () => {}
  onPeerConnected: () => void = () => {}
  onPeerDisconnected: () => void = () => {}

  private constructor(
    private peer: Peer,
    private conn: DataConnection | null,
    readonly code: string,
    readonly role: 'host' | 'guest',
  ) {}

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
          const net = new Net(peer, null, code, 'host')
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
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerOptions())
      const timeout = setTimeout(() => {
        peer.destroy()
        reject(new Error('Zeitüberschreitung – Code richtig? Ist das Spiel noch offen?'))
      }, 15000)
      peer.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
      peer.on('open', () => {
        const conn = peer.connect(ID_PREFIX + code.toUpperCase(), { reliable: true })
        conn.on('open', () => {
          clearTimeout(timeout)
          const net = new Net(peer, null, code.toUpperCase(), 'guest')
          net.attach(conn)
          resolve(net)
        })
      })
    })
  }

  private attach(conn: DataConnection): void {
    // Nur eine Gegenstelle: bestehende Verbindung wird ersetzt (Reconnect).
    if (this.conn && this.conn.open && this.conn !== conn) this.conn.close()
    this.conn = conn
    conn.on('data', (data) => this.onMessage(data as NetMessage))
    conn.on('close', () => {
      if (this.conn === conn) this.onPeerDisconnected()
    })
    if (conn.open) this.onPeerConnected()
    else conn.on('open', () => this.onPeerConnected())
  }

  send(msg: NetMessage): void {
    if (this.conn?.open) this.conn.send(msg)
  }

  get connected(): boolean {
    return this.conn?.open ?? false
  }

  destroy(): void {
    this.peer.destroy()
  }
}
