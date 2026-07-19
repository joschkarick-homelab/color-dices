// Raum-Server: hält Lobby und Spielstand serverseitig und führt alle
// Spielaktionen selbst aus (gleiche Engine-Module wie der Client).
//
// Damit dürfen Verbindungen jederzeit abreißen — Handys sperren, Apps
// wechseln, Browser neu laden: Beim Wiederverbinden (join mit bekannter
// Client-ID) kommt der aktuelle Stand vom Server, auch für den Ersteller.
// Räume leben im Speicher; ein Neustart des Containers beendet sie.

import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  MAX_PLAYERS,
  newGame,
  rollDice,
  rollTarget,
  submitMove,
  type HouseRules,
} from '../src/rules'
import {
  kniffelRoll,
  kniffelScore,
  newKniffelGame,
  setHeld,
  type KniffelHouseRules,
} from '../src/kniffel'
import type { AnyState, KniffelAction, NetMessage } from '../src/net'
import type { GameId } from '../src/presets'

const PORT = Number(process.env.PORT ?? 9300)
const ROOM_IDLE_MS = 24 * 60 * 60 * 1000 // Raum spätestens nach 24 h aufräumen
const ROOM_EMPTY_MS = 2 * 60 * 60 * 1000 // leere Räume (alle offline) nach 2 h
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

type ClientMsg =
  | { t: 'create'; game: GameId; rules: unknown; name: string; cid: string }
  | { t: 'join'; code: string; name: string; cid: string }
  | NetMessage

interface Player {
  cid: string
  name: string
  ws: WebSocket | null
}

interface Room {
  code: string
  game: GameId
  rules: HouseRules | KniffelHouseRules
  creatorCid: string
  players: Player[]
  state: AnyState | null
  lastActivity: number
}

const rooms = new Map<string, Room>()

function randomCode(): string {
  let out = ''
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return out
}

function send(ws: WebSocket | null, msg: unknown): void {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(room: Room, msg: unknown): void {
  for (const p of room.players) send(p.ws, msg)
}

function broadcastLobby(room: Room): void {
  broadcast(room, { t: 'lobby', names: room.players.map((p) => p.name), game: room.game })
}

function broadcastState(room: Room): void {
  room.lastActivity = Date.now()
  broadcast(room, { t: 'state', s: room.state })
}

function isKniffel(s: AnyState): s is Extract<AnyState, { game: 'kniffel' }> {
  return (s as { game?: string }).game === 'kniffel'
}

// ---------------------------------------------------------------------------
// Raum-Logik (Spiegel der bisherigen Host-Logik aus main.ts)

function startGame(room: Room): void {
  if (room.state && room.state.phase !== 'ended') return
  const names = room.players.map((p) => p.name)
  const matchNo = room.state ? room.state.matchNo + 1 : 0
  room.state =
    room.game === 'kniffel'
      ? newKniffelGame(names, room.rules as KniffelHouseRules, matchNo)
      : newGame(names, room.rules as HouseRules, matchNo)
  broadcastState(room)
}

function handleGameMsg(room: Room, idx: number, m: NetMessage): void {
  const state = room.state
  if (!state) return
  if (isKniffel(state)) {
    if (m.t !== 'act') return
    const a: KniffelAction = m.a
    if (state.active !== idx) return
    if (a.k === 'roll') {
      if (kniffelRoll(state, a.hold)) broadcastState(room)
    } else if (a.k === 'hold') {
      if (setHeld(state, a.hold)) broadcastState(room)
    } else if (a.k === 'score') {
      if (kniffelScore(state, a.cat)) broadcastState(room)
    }
    return
  }
  if (m.t === 'move') {
    submitMove(state, idx, m.move)
    broadcastState(room)
  } else if (m.t === 'rollreq') {
    if (state.active === idx && state.phase === 'playing' && !state.dice) {
      rollDice(state)
      broadcastState(room)
    }
  } else if (m.t === 'targetreq') {
    if (rollTarget(state, m.uid)) broadcastState(room)
  }
}

/** Beitritt oder Reconnect (join und hello nutzen denselben Pfad). */
function joinRoom(room: Room, ws: WebSocket, cid: string, name: string): number | null {
  let idx = room.players.findIndex((p) => p.cid === cid)
  if (idx < 0) {
    if (room.state || room.players.length >= MAX_PLAYERS) {
      send(ws, { t: 'joinfail', reason: 'Das Spiel ist schon voll oder läuft bereits.' })
      return null
    }
    room.players.push({ cid, name: name || `Spieler ${room.players.length + 1}`, ws })
    idx = room.players.length - 1
  } else {
    const p = room.players[idx]
    if (p.ws && p.ws !== ws) p.ws.close()
    p.ws = ws
    if (name) {
      p.name = name
      if (room.state) room.state.names[idx] = name
    }
  }
  room.lastActivity = Date.now()
  send(ws, { t: 'welcome', idx, mod: cid === room.creatorCid })
  if (room.state) {
    send(ws, { t: 'state', s: room.state })
    broadcastLobby(room) // Namensänderungen auch in der Lobby-Ansicht spiegeln
  } else {
    broadcastLobby(room)
  }
  return idx
}

function leaveRoom(room: Room, ws: WebSocket): void {
  const p = room.players.find((x) => x.ws === ws)
  if (!p) return
  p.ws = null
  if (!room.state) {
    if (p.cid === room.creatorCid) {
      // Ersteller weg, Spiel nie gestartet → Raum auflösen
      broadcast(room, { t: 'full' })
      rooms.delete(room.code)
      return
    }
    room.players = room.players.filter((x) => x !== p)
    broadcastLobby(room)
  }
  room.lastActivity = Date.now()
}

// ---------------------------------------------------------------------------
// WebSocket-Server

const http = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('ok')
})
const wss = new WebSocketServer({ server: http })

interface Session {
  room: Room | null
  cid: string
}

wss.on('connection', (ws: WebSocket) => {
  const session: Session = { room: null, cid: '' }

  ws.on('message', (raw: unknown) => {
    let m: ClientMsg
    try {
      m = JSON.parse(String(raw)) as ClientMsg
    } catch {
      return
    }

    if (m.t === 'create') {
      let code = randomCode()
      while (rooms.has(code)) code = randomCode()
      const room: Room = {
        code,
        game: m.game === 'kniffel' ? 'kniffel' : 'qwixx',
        rules: m.rules as HouseRules | KniffelHouseRules,
        creatorCid: m.cid,
        players: [],
        state: null,
        lastActivity: Date.now(),
      }
      rooms.set(code, room)
      session.room = room
      session.cid = m.cid
      send(ws, { t: 'created', code })
      joinRoom(room, ws, m.cid, m.name)
      return
    }

    if (m.t === 'join') {
      const room = rooms.get(m.code.toUpperCase())
      if (!room) {
        send(ws, { t: 'joinfail', reason: 'Raum nicht gefunden – Code richtig?' })
        return
      }
      session.cid = m.cid
      if (joinRoom(room, ws, m.cid, m.name) !== null) session.room = room
      return
    }

    const room = session.room
    if (!room) return
    room.lastActivity = Date.now()
    const idx = room.players.findIndex((p) => p.ws === ws)

    if (m.t === 'hello') {
      joinRoom(room, ws, m.cid || session.cid, m.name)
      return
    }
    if (idx < 0) return
    if (m.t === 'start' || m.t === 'rematch') {
      if (room.players[idx].cid === room.creatorCid) startGame(room)
      return
    }
    handleGameMsg(room, idx, m)
  })

  ws.on('close', () => {
    if (session.room) leaveRoom(session.room, ws)
  })
})

// Aufräumen: verlassene und uralte Räume entsorgen
setInterval(() => {
  const now = Date.now()
  for (const [code, room] of rooms) {
    const empty = room.players.every((p) => !p.ws || p.ws.readyState !== p.ws.OPEN)
    if (now - room.lastActivity > ROOM_IDLE_MS || (empty && now - room.lastActivity > ROOM_EMPTY_MS)) {
      rooms.delete(code)
    }
  }
}, 10 * 60 * 1000)

http.listen(PORT, () => {
  console.log(`Raum-Server läuft auf Port ${PORT}`)
})
