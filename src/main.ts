import './style.css'
import { DiceTray, type DieSpec } from './dice'
import { Net } from './net'
import {
  COLORS,
  COLOR_NAMES,
  EVENT_META,
  LOCK_INDEX,
  MAX_PENALTIES,
  MAX_PLAYERS,
  PASCH_EVENTS,
  ROW_NUMBERS,
  colorCandidates,
  colorSums,
  defaultHouseRules,
  newGame,
  REROLLABLE_EVENTS,
  rollDice,
  rollTarget,
  rowScore,
  ruleTextsFor,
  submitMove,
  totalScore,
  whiteCandidates,
  whiteSum,
  type Cell,
  type Color,
  type GameEvent,
  type GameState,
  type HouseRules,
} from './rules'

const app = document.getElementById('app')!

// ---------------------------------------------------------------------------
// App-Zustand

interface Session {
  role: 'host' | 'guest'
  code: string
  name: string
}

/** Spieler aus Host-Sicht: cid identifiziert den Gast über Reconnects hinweg. */
interface HostPlayer {
  cid: string
  name: string
  connId: number | null // aktuelle Verbindung, null = getrennt (Host selbst: immer null)
}

let net: Net | null = null
let myIdx = 0
let hostPlayers: HostPlayer[] = []
let lobbyRules: HouseRules | null = null
let state: GameState | null = null
let tray: DiceTray | null = null
let selection: { white: Cell | null; colored: Cell | null } = { white: null, colored: null }
let animating = false
let rollRequested = false
let lastAnimatedRollId = 0
let submittedRollId = 0
let shownEvents = new Set<string>()
let shownTargets = new Set<string>()
let bannerQueue: GameEvent[] = []
let bannerActive = false
let peerConnected = false
let gameMounted = false
let reconnecting = false
let wakeLock: WakeLockSentinel | null = null

// ---------------------------------------------------------------------------
// Helper

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function getName(): string {
  return localStorage.getItem('qwixx.name') ?? ''
}

/**
 * Client-ID des Gasts: identifiziert ihn beim Host über Reconnects hinweg
 * (sessionStorage, damit mehrere Tabs als eigene Spieler zählen).
 */
function getCid(): string {
  let cid = sessionStorage.getItem('qwixx.cid')
  if (!cid) {
    cid = Math.random().toString(36).slice(2, 12)
    sessionStorage.setItem('qwixx.cid', cid)
  }
  return cid
}

function saveSession(s: Session | null): void {
  if (s) sessionStorage.setItem('qwixx.session', JSON.stringify(s))
  else sessionStorage.removeItem('qwixx.session')
}

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem('qwixx.session')
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

function persistHostState(): void {
  if (state && net?.role === 'host') {
    localStorage.setItem('qwixx.hoststate', JSON.stringify(state))
  }
}

function loadHostState(): GameState | null {
  try {
    const raw = localStorage.getItem('qwixx.hoststate')
    return raw ? (JSON.parse(raw) as GameState) : null
  } catch {
    return null
  }
}

function persistHostPlayers(): void {
  localStorage.setItem(
    'qwixx.hostplayers',
    JSON.stringify(hostPlayers.map((p) => ({ cid: p.cid, name: p.name }))),
  )
}

function loadHostPlayers(): { cid: string; name: string }[] | null {
  try {
    const raw = localStorage.getItem('qwixx.hostplayers')
    return raw ? (JSON.parse(raw) as { cid: string; name: string }[]) : null
  } catch {
    return null
  }
}

function loadRules(): HouseRules {
  try {
    const raw = localStorage.getItem('qwixx.rules')
    if (raw) return { ...defaultHouseRules(), ...(JSON.parse(raw) as HouseRules) }
  } catch {
    /* ignore */
  }
  return defaultHouseRules()
}

const isMyTurn = (): boolean => state?.active === myIdx

// ---------------------------------------------------------------------------
// Verbindung stabil halten
//
// Der häufigste Abbruchgrund: Das Gerät des passiven Spielers dimmt/sperrt den
// Bildschirm, der Browser friert die Seite ein und die WebRTC-Verbindung
// stirbt nach wenigen Sekunden. Dagegen: Wake Lock (Display bleibt im Spiel
// an) + automatischer Reconnect des Gasts, falls es doch passiert.

function requestWakeLock(): void {
  if (!('wakeLock' in navigator)) return
  navigator.wakeLock.request('screen').then(
    (lock) => {
      wakeLock = lock
    },
    () => {},
  )
}

function releaseWakeLock(): void {
  void wakeLock?.release().catch(() => {})
  wakeLock = null
}

async function autoReconnect(): Promise<void> {
  const session = loadSession()
  if (reconnecting || peerConnected || !session || session.role !== 'guest') return
  if (!state || state.phase === 'ended') return
  reconnecting = true
  render()
  for (let attempt = 0; attempt < 3 && !peerConnected && gameMounted; attempt++) {
    try {
      const fresh = await Net.join(session.code)
      net?.destroy()
      net = fresh
      setupGuestHandlers()
      peerConnected = true
      fresh.send({ t: 'hello', name: getName(), cid: getCid() })
      break
    } catch {
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  reconnecting = false
  render()
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  // Wake Locks werden beim Verlassen des Tabs automatisch freigegeben
  if (gameMounted) requestWakeLock()
  if (net?.role === 'guest' && !peerConnected) void autoReconnect()
})

// ---------------------------------------------------------------------------
// Host-Logik

function afterHostChange(): void {
  if (!state || !net) return
  persistHostState()
  net.send({ t: 'state', s: state })
  queuePendingBanners()
  render()
}

function hostRoll(): void {
  if (!state || state.phase !== 'playing' || state.dice) return
  rollDice(state)
  persistHostState()
  net?.send({ t: 'state', s: state })
  void animateRoll()
}

function hostConnectedCount(): number {
  // Host selbst zählt immer als verbunden
  return 1 + hostPlayers.filter((p, i) => i > 0 && p.connId !== null).length
}

/** Beitritt/Reconnect eines Gasts (in Lobby und im laufenden Spiel). */
function hostHandleHello(m: { name: string; cid: string }, from: number): void {
  let idx = hostPlayers.findIndex((p) => p.cid === m.cid)
  if (idx < 0) {
    // Neuer Spieler: nur in der Lobby und solange Platz ist
    if (state || hostPlayers.length >= MAX_PLAYERS) {
      net?.sendTo(from, { t: 'full' })
      return
    }
    hostPlayers.push({ cid: m.cid, name: m.name || `Spieler ${hostPlayers.length + 1}`, connId: from })
    idx = hostPlayers.length - 1
  } else {
    // Reconnect: alte Verbindung ersetzen
    const p = hostPlayers[idx]
    if (p.connId !== null && p.connId !== from) net?.close(p.connId)
    p.connId = from
    if (m.name) {
      p.name = m.name
      if (state) state.names[idx] = m.name
    }
  }
  persistHostPlayers()
  net?.sendTo(from, { t: 'welcome', idx })
  if (state) {
    peerConnected = true
    net?.sendTo(from, { t: 'state', s: state })
    render()
  } else {
    broadcastLobby()
    showHostLobby()
  }
}

function broadcastLobby(): void {
  net?.send({ t: 'lobby', names: hostPlayers.map((p) => p.name) })
}

function setupHostHandlers(): void {
  if (!net) return
  net.onMessage = (m, from) => {
    if (m.t === 'hello') {
      hostHandleHello(m, from)
      return
    }
    if (!state) return
    const idx = hostPlayers.findIndex((p) => p.connId === from)
    if (idx <= 0) return
    if (m.t === 'move') {
      submitMove(state, idx, m.move)
      afterHostChange()
    } else if (m.t === 'rollreq') {
      if (state.active === idx) hostRoll()
    } else if (m.t === 'targetreq') {
      hostRollTarget(m.uid)
    }
  }
  net.onPeerConnected = () => {
    // Spielerzuordnung passiert erst mit der hello-Nachricht
  }
  net.onPeerDisconnected = (id) => {
    const p = hostPlayers.find((x) => x.connId === id)
    if (p) p.connId = null
    if (!state) {
      // In der Lobby fliegen Getrennte raus — sie können einfach neu beitreten
      hostPlayers = hostPlayers.filter((x, i) => i === 0 || x.connId !== null)
      persistHostPlayers()
      broadcastLobby()
      showHostLobby()
    } else {
      render()
    }
  }
}

// ---------------------------------------------------------------------------
// Gast-Logik

function setupGuestHandlers(): void {
  if (!net) return
  net.onMessage = (m) => {
    if (m.t === 'welcome') {
      myIdx = m.idx
      return
    }
    if (m.t === 'lobby') {
      if (!state) showGuestLobby(m.names)
      return
    }
    if (m.t === 'full') {
      net?.destroy()
      net = null
      saveSession(null)
      showHome('Das Spiel ist schon voll oder läuft bereits.')
      return
    }
    if (m.t !== 'state') return
    const prev = state
    state = m.s
    if (!prev || prev.matchNo !== state.matchNo) {
      // Erster Stand oder Revanche: Events/Animationen zurücksetzen
      selection = { white: null, colored: null }
      shownEvents = new Set(prev ? [] : state.events.map((e) => e.uid))
      shownTargets = new Set(prev ? [] : state.events.filter((e) => e.target).map((e) => e.uid))
      lastAnimatedRollId = prev ? 0 : state.rollId
      submittedRollId = 0
    }
    if (!gameMounted) mountGame()
    if (state.dice && state.rollId > lastAnimatedRollId) {
      rollRequested = false
      void animateRoll()
    } else {
      queuePendingBanners()
      queueTargetAnimations()
      render()
    }
  }
  net.onPeerDisconnected = () => {
    peerConnected = false
    render()
    void autoReconnect()
  }
  net.onPeerConnected = () => {
    peerConnected = true
    net!.send({ t: 'hello', name: getName(), cid: getCid() })
    render()
  }
}

// ---------------------------------------------------------------------------
// Gemeinsame Spiel-Aktionen

function requestRoll(): void {
  if (!state || !isMyTurn() || state.dice || animating) return
  if (net?.role === 'host') {
    hostRoll()
  } else {
    rollRequested = true
    net?.send({ t: 'rollreq' })
    render()
  }
}

function hostRollTarget(uid: string): void {
  if (!state) return
  const e = rollTarget(state, uid)
  if (!e) return
  persistHostState()
  net?.send({ t: 'state', s: state })
  queueTargetAnimations()
}

function requestTarget(uid: string): void {
  if (!state || animating) return
  if (net?.role === 'host') {
    hostRollTarget(uid)
  } else {
    net?.send({ t: 'targetreq', uid })
  }
}

/** Noch nicht animierte Zielwürfe abspielen (Guard: shownTargets). */
function queueTargetAnimations(): void {
  if (!state || animating) return
  const pending = state.events.find((e) => e.target && !shownTargets.has(e.uid))
  if (pending) void animateTarget(pending)
}

function confirmMove(): void {
  if (!state || !state.dice || animating) return
  const move = { white: selection.white, colored: selection.colored }
  submittedRollId = state.rollId
  if (net?.role === 'host') {
    submitMove(state, myIdx, move)
    afterHostChange()
  } else {
    net?.send({ t: 'move', move })
    render()
  }
}

function myMoveDone(): boolean {
  if (!state) return false
  return state.moves[myIdx] !== null || submittedRollId === state.rollId
}

function handleCellTap(color: Color, index: number): void {
  if (!state || !state.dice || animating || myMoveDone()) return
  const isSel = (c: Cell | null): boolean => c?.color === color && c.index === index

  if (isSel(selection.white)) {
    selection.white = null
  } else if (isSel(selection.colored)) {
    selection.colored = null
  } else {
    const whites = whiteCandidates(state, myIdx)
    const isWhite = whites.some((c) => c.color === color && c.index === index)
    const colors = colorCandidates(state, myIdx, selection.white)
    const isColor = colors.some((c) => c.color === color && c.index === index)
    if (isWhite && (!selection.white || !isColor)) {
      selection.white = { color, index }
    } else if (isColor) {
      selection.colored = { color, index }
    } else {
      return
    }
  }
  // Farbauswahl erneut prüfen (kann durch geändertes Weiß-Kreuz ungültig werden)
  if (selection.colored) {
    const valid = colorCandidates(state, myIdx, selection.white)
    if (!valid.some((c) => c.color === selection.colored!.color && c.index === selection.colored!.index)) {
      selection.colored = null
    }
  }
  render()
}

// ---------------------------------------------------------------------------
// Würfel-Animation & Event-Banner

function buildSpecs(): DieSpec[] {
  const d = state!.dice!
  const specs: DieSpec[] = [
    { kind: 'white', value: d.w1 },
    { kind: 'white', value: d.w2 },
  ]
  for (const c of COLORS) {
    const v = d[c]
    if (v !== undefined) specs.push({ kind: c, value: v })
  }
  return specs
}

async function animateRoll(): Promise<void> {
  if (!state?.dice || animating || !tray) return
  lastAnimatedRollId = state.rollId
  selection = { white: null, colored: null }
  animating = true
  render()
  try {
    await tray.roll(buildSpecs())
  } finally {
    animating = false
  }
  // Sonderregel-Banner kommen erst nach dem Setzen der Kreuze (Zug-Auflösung)
  render()
}

/** Zielwurf abspielen: ein einzelner (weißer) Zielwürfel wird geworfen. */
async function animateTarget(e: GameEvent): Promise<void> {
  if (!tray || !e.target || !e.dice || shownTargets.has(e.uid)) return
  shownTargets.add(e.uid)
  animating = true
  render()
  const specs: DieSpec[] = e.target.map((value) => ({ kind: 'white', value }))
  try {
    await tray.roll(specs)
  } finally {
    animating = false
  }
  render()
  await showTargetBanner(e)
  render()
  queueTargetAnimations()
}

/**
 * Ergebnis des Zielwurfs: zeigt das auslösende Ereignis (z. B. den Pasch)
 * samt Regeltexten und den ausgewürfelten Zielwürfel. Schließt sich bewusst
 * NICHT von selbst — nur per Tippen, damit niemand das Ergebnis verpasst.
 */
function showTargetBanner(e: GameEvent): Promise<void> {
  return new Promise((resolve) => {
    const meta = EVENT_META[e.id]
    const rule = state?.houseRules[e.id]
    const chips = e.target!.map((v) => `<span class="die-chip white">${v}</span>`).join('')
    const el = document.createElement('div')
    el.className = 'banner-backdrop'
    el.innerHTML = `
      <div class="banner">
        <div class="emoji">🎯</div>
        <h2>Ziel ausgewürfelt!</h2>
        <p class="who">${meta.emoji} ${esc(meta.title)}${e.detail ? ` · ${esc(e.detail)}` : ''}${e.player ? ` · ${esc(e.player)}` : ''}</p>
        ${rule?.enabled ? ruleTextsFor(e, rule).map((t) => `<div class="ruletext">${esc(t)}</div>`).join('') : ''}
        <div class="target-chips">${chips}</div>
        <div class="tap-hint">Tippen zum Schließen</div>
      </div>`
    document.body.appendChild(el)
    el.addEventListener('click', () => {
      el.remove()
      resolve()
    })
  })
}

/**
 * Spielfluss: 1. würfeln → 2. Kreuze setzen → 3. Sonderregeln sehen →
 * 4. Sonderziele auswürfeln. Banner erscheinen deshalb erst, wenn der Zug
 * aufgelöst ist (solange gewürfelt-aber-nicht-aufgelöst: zurückhalten).
 */
function queuePendingBanners(): void {
  if (!state) return
  if (state.dice && state.phase === 'playing') return
  enqueueBanners(state.events)
}

function enqueueBanners(events: GameEvent[]): void {
  for (const e of events) {
    if (shownEvents.has(e.uid)) continue
    shownEvents.add(e.uid)
    bannerQueue.push(e)
  }
  void processBannerQueue()
}

async function processBannerQueue(): Promise<void> {
  if (bannerActive) return
  bannerActive = true
  while (bannerQueue.length) {
    const e = bannerQueue.shift()!
    await showBanner(e)
  }
  bannerActive = false
}

function showBanner(e: GameEvent): Promise<void> {
  return new Promise((resolve) => {
    const meta = EVENT_META[e.id]
    const rule = state?.houseRules[e.id]
    const canTarget = Boolean(
      e.dice && !e.target && rule?.enabled && rule.reroll && REROLLABLE_EVENTS.includes(e.id),
    )
    const el = document.createElement('div')
    el.className = 'banner-backdrop'
    el.innerHTML = `
      <div class="banner">
        <div class="emoji">${meta.emoji}</div>
        <h2>${esc(meta.title)}${e.id === 'win' && e.player ? `: ${esc(e.player)}!` : '!'}</h2>
        ${e.player && e.id !== 'win' ? `<p class="who">${esc(e.player)}${e.detail ? ` · ${esc(e.detail)}` : ''}</p>` : ''}
        ${e.id === 'win' && !e.player ? `<p class="who">Unentschieden!</p>` : ''}
        ${rule?.enabled ? ruleTextsFor(e, rule).map((t) => `<div class="ruletext">${esc(t)}</div>`).join('') : ''}
        ${canTarget ? `<div style="height:12px"></div><button class="btn primary" id="bannerTarget">🎯 Ziel auswürfeln</button>` : ''}
        <div class="tap-hint">Tippen zum Schließen</div>
      </div>`
    document.body.appendChild(el)
    const close = (): void => {
      clearTimeout(timer)
      el.remove()
      resolve()
    }
    const timer = setTimeout(close, canTarget ? 12000 : 5000)
    el.addEventListener('click', close)
    el.querySelector('#bannerTarget')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      close()
      requestTarget(e.uid)
    })
  })
}

// ---------------------------------------------------------------------------
// Screens: Start / Regeln / Lobby / Beitreten

function showHome(error = ''): void {
  gameMounted = false
  const session = loadSession()
  const joinParam = new URLSearchParams(location.search).get('join')
  app.innerHTML = `
    <div class="screen center">
      <div class="logo-dice">🎲</div>
      <h1>WÜRFELRUNDE</h1>
      <p class="subtitle">Für 1–10 Spieler – jeder am eigenen Handy</p>
      <div class="stack">
        <input type="text" id="name" placeholder="Dein Name" maxlength="16" value="${esc(getName())}" />
        <label class="field-label" for="gameSel">Spiel auswählen</label>
        <select id="gameSel" class="game-select">
          <option value="qwixx" selected>Qwixx</option>
        </select>
        <p class="error">${esc(error)}</p>
        <button class="btn primary" id="create">Neues Spiel erstellen</button>
        <button class="btn" id="join">Spiel beitreten</button>
        ${
          session
            ? `<button class="btn" id="resume">↩️ Spiel fortsetzen (${esc(session.code)})</button>`
            : ''
        }
      </div>
    </div>`
  const nameInput = app.querySelector<HTMLInputElement>('#name')!
  const requireName = (): string | null => {
    const n = nameInput.value.trim()
    if (!n) {
      showHome('Bitte gib zuerst deinen Namen ein.')
      return null
    }
    localStorage.setItem('qwixx.name', n)
    return n
  }
  app.querySelector('#create')!.addEventListener('click', () => {
    if (requireName()) showSetup()
  })
  app.querySelector('#join')!.addEventListener('click', () => {
    if (requireName()) showJoin(joinParam ?? '')
  })
  app.querySelector('#resume')?.addEventListener('click', () => {
    if (requireName()) void resumeSession(session!)
  })
  if (joinParam && getName()) showJoin(joinParam)
}

function showSetup(): void {
  const rules = loadRules()
  const ids = Object.keys(EVENT_META) as (keyof typeof EVENT_META)[]
  app.innerHTML = `
    <div class="screen">
      <h1 style="font-size:1.6rem">Eure Regeln 📜</h1>
      <p class="subtitle">Was passiert bei besonderen Ereignissen? Der Text wird beiden angezeigt, sobald das Ereignis eintritt.</p>
      <div class="rules-list">
        ${ids
          .map((id) => {
            const meta = EVENT_META[id]
            const r = rules[id]
            return `
            <div class="rule-item" data-id="${id}">
              <div class="rule-head">
                <span>${meta.emoji}</span>
                <span class="title">${esc(meta.title)}<span class="hint">${esc(meta.hint)}</span></span>
                <label class="switch"><input type="checkbox" data-toggle ${r.enabled ? 'checked' : ''} /><span></span></label>
              </div>
              <div class="rule-body" ${r.enabled ? '' : 'style="display:none"'}>
                <textarea rows="2" data-text placeholder="z. B. Alle trinken einen Schluck …">${esc(r.text)}</textarea>
                ${
                  PASCH_EVENTS.includes(id)
                    ? `<details class="numrules" ${r.numberTexts && Object.keys(r.numberTexts).length ? 'open' : ''}>
                        <summary>🎲 Eigene Texte pro Pasch-Zahl (optional)</summary>
                        ${[1, 2, 3, 4, 5, 6]
                          .map(
                            (n) =>
                              `<label class="numrule"><span>${n}er</span><input type="text" data-numtext data-num="${n}" maxlength="120" value="${esc(r.numberTexts?.[n] ?? '')}" placeholder="Standardtext nutzen" /></label>`,
                          )
                          .join('')}
                      </details>`
                    : ''
                }
                ${
                  REROLLABLE_EVENTS.includes(id)
                    ? `<label class="reroll-opt"><input type="checkbox" data-reroll ${r.reroll ? 'checked' : ''} /> 🎯 Ziel auswürfeln? <span class="hint">Nach dem Ereignis bestimmt ein einzelner Zielwürfel eine Zahl von 1–6</span></label>`
                    : ''
                }
              </div>
            </div>`
          })
          .join('')}
      </div>
      <p class="error" id="err"></p>
      <button class="btn primary" id="start">Spiel erstellen</button>
      <button class="btn" id="back">Zurück</button>
    </div>`

  app.querySelectorAll<HTMLInputElement>('[data-toggle]').forEach((toggle) => {
    toggle.addEventListener('change', () => {
      const body = toggle.closest('.rule-item')!.querySelector<HTMLElement>('.rule-body')!
      body.style.display = toggle.checked ? '' : 'none'
    })
  })
  app.querySelector('#back')!.addEventListener('click', () => showHome())
  app.querySelector('#start')!.addEventListener('click', () => {
    const rules = {} as HouseRules
    app.querySelectorAll<HTMLElement>('.rule-item').forEach((item) => {
      const id = item.dataset.id as keyof HouseRules
      rules[id] = {
        enabled: item.querySelector<HTMLInputElement>('[data-toggle]')!.checked,
        text: item.querySelector<HTMLTextAreaElement>('[data-text]')!.value.trim(),
        reroll: item.querySelector<HTMLInputElement>('[data-reroll]')?.checked ?? false,
      }
      const numberTexts: Partial<Record<number, string>> = {}
      item.querySelectorAll<HTMLInputElement>('[data-numtext]').forEach((inp) => {
        const v = inp.value.trim()
        if (v) numberTexts[Number(inp.dataset.num)] = v
      })
      if (Object.keys(numberTexts).length) rules[id].numberTexts = numberTexts
    })
    localStorage.setItem('qwixx.rules', JSON.stringify(rules))
    void createGame(rules)
  })
}

async function createGame(rules: HouseRules): Promise<void> {
  showWaiting('Raum wird erstellt …')
  net?.destroy()
  try {
    net = await Net.host()
  } catch (e) {
    showHome(`Verbindung fehlgeschlagen: ${(e as Error).message ?? e}`)
    return
  }
  myIdx = 0
  lobbyRules = rules
  hostPlayers = [{ cid: 'host', name: getName(), connId: null }]
  persistHostPlayers()
  saveSession({ role: 'host', code: net.code, name: getName() })
  setupHostHandlers()
  showHostLobby()
}

/** Lobby des Hosts: zeigt, wer schon da ist, und startet das Spiel auf Knopfdruck. */
function showHostLobby(): void {
  if (!net || state) return
  const code = net.code
  const url = `${location.origin}${location.pathname}?join=${code}`
  app.innerHTML = `
    <div class="screen center">
      <p class="subtitle">Dein Raum-Code</p>
      <div class="code-display">${esc(code)}</div>
      <div class="player-list">
        ${hostPlayers
          .map(
            (p, i) => `
          <div class="player-item">
            <span class="conn-dot ok"></span>
            <span class="pname">${esc(p.name)}</span>
            ${i === 0 ? '<span class="tag">👑 Host</span>' : ''}
          </div>`,
          )
          .join('')}
      </div>
      <p class="subtitle ${hostPlayers.length < MAX_PLAYERS ? 'pulse' : ''}">
        ${hostPlayers.length} von ${MAX_PLAYERS} Spielern${hostPlayers.length < MAX_PLAYERS ? ' · weitere können beitreten …' : ' · Raum voll'}
      </p>
      <div class="stack">
        <button class="btn primary" id="start">▶️ Spiel starten (${hostPlayers.length} Spieler)</button>
        <button class="btn" id="share">📤 Einladung teilen</button>
        <button class="btn" id="cancel">Abbrechen</button>
      </div>
    </div>`
  app.querySelector('#start')!.addEventListener('click', hostStartGame)
  app.querySelector('#share')!.addEventListener('click', () => {
    const text = `Spiel eine Runde Qwixx mit mir! Code: ${code}`
    if (navigator.share) {
      void navigator.share({ title: 'Qwixx', text, url })
    } else {
      void navigator.clipboard.writeText(`${text}\n${url}`)
      alert('Link kopiert!')
    }
  })
  app.querySelector('#cancel')!.addEventListener('click', () => {
    net?.destroy()
    net = null
    hostPlayers = []
    saveSession(null)
    localStorage.removeItem('qwixx.hostplayers')
    showHome()
  })
}

function hostStartGame(): void {
  if (!net || state) return
  state = newGame(
    hostPlayers.map((p) => p.name),
    lobbyRules ?? loadRules(),
  )
  peerConnected = true
  persistHostState()
  net.send({ t: 'state', s: state })
  mountGame()
  render()
}

/** Warte-Lobby des Gasts: zeigt die bereits beigetretenen Spieler. */
function showGuestLobby(names: string[]): void {
  gameMounted = false
  app.innerHTML = `
    <div class="screen center">
      <div class="logo-dice">🎲</div>
      <p class="subtitle">Du bist drin!</p>
      <div class="player-list">
        ${names
          .map(
            (n, i) => `
          <div class="player-item">
            <span class="conn-dot ok"></span>
            <span class="pname">${esc(n)}</span>
            ${i === 0 ? '<span class="tag">👑 Host</span>' : ''}
          </div>`,
          )
          .join('')}
      </div>
      <p class="subtitle pulse">Warte, bis ${esc(names[0] ?? 'der Host')} das Spiel startet …</p>
    </div>`
}

function showJoin(prefill = ''): void {
  app.innerHTML = `
    <div class="screen center">
      <h1 style="font-size:1.6rem">Spiel beitreten</h1>
      <div class="stack">
        <input type="text" id="code" class="code" placeholder="CODE" maxlength="4" value="${esc(prefill)}" autocapitalize="characters" autocomplete="off" />
        <p class="error" id="err"></p>
        <button class="btn primary" id="go">Beitreten</button>
        <button class="btn" id="back">Zurück</button>
      </div>
    </div>`
  const codeInput = app.querySelector<HTMLInputElement>('#code')!
  app.querySelector('#back')!.addEventListener('click', () => {
    history.replaceState(null, '', location.pathname)
    showHome()
  })
  app.querySelector('#go')!.addEventListener('click', () => void joinGame(codeInput.value.trim()))
  if (prefill) void joinGame(prefill)
}

async function joinGame(code: string): Promise<void> {
  if (code.length < 4) return
  showWaiting('Verbinde …')
  net?.destroy()
  try {
    net = await Net.join(code)
  } catch (e) {
    showJoin('')
    const err = app.querySelector('#err')
    if (err) err.textContent = `Beitritt fehlgeschlagen: ${(e as Error).message ?? 'Code prüfen!'}`
    return
  }
  peerConnected = true
  saveSession({ role: 'guest', code: net.code, name: getName() })
  history.replaceState(null, '', location.pathname)
  setupGuestHandlers()
  net.send({ t: 'hello', name: getName(), cid: getCid() })
  showWaiting('Verbunden! Warte auf den Spielstart …')
}

async function resumeSession(session: Session): Promise<void> {
  if (session.role === 'guest') {
    await joinGame(session.code)
    return
  }
  const saved = loadHostState()
  if (!saved) {
    saveSession(null)
    showHome('Kein gespeichertes Spiel gefunden.')
    return
  }
  showWaiting('Raum wird wieder geöffnet …')
  try {
    net = await Net.host(session.code)
  } catch (e) {
    showHome(`Konnte Raum nicht öffnen: ${(e as Error).message ?? e}`)
    return
  }
  myIdx = 0
  state = saved
  const savedPlayers = loadHostPlayers()
  hostPlayers =
    savedPlayers && savedPlayers.length === saved.names.length
      ? savedPlayers.map((p) => ({ ...p, connId: null }))
      : saved.names.map((n, i) => ({ cid: i === 0 ? 'host' : `unknown-${i}`, name: n, connId: null }))
  lastAnimatedRollId = state.rollId
  shownEvents = new Set(state.events.map((e) => e.uid))
  shownTargets = new Set(state.events.filter((e) => e.target).map((e) => e.uid))
  saveSession({ role: 'host', code: net.code, name: session.name })
  setupHostHandlers()
  mountGame()
  render()
}

function showWaiting(msg: string): void {
  gameMounted = false
  app.innerHTML = `
    <div class="screen center">
      <div class="logo-dice">🎲</div>
      <p class="subtitle pulse">${esc(msg)}</p>
    </div>`
}

// ---------------------------------------------------------------------------
// Spiel-Screen

function mountGame(): void {
  gameMounted = true
  requestWakeLock()
  app.innerHTML = `
    <div id="game">
      <div class="topbar" id="topbar"></div>
      <div id="diceMount">
        <div class="dice-overlay" id="diceOverlay"></div>
      </div>
      <div id="gameDyn"></div>
    </div>`
  const mount = document.getElementById('diceMount')!
  tray?.dispose()
  tray = new DiceTray(mount)
  tray.muted = localStorage.getItem('qwixx.muted') === '1'
  mount.addEventListener('click', (ev) => {
    // Nur echte Taps auf den Würfeltisch überspringen — Klicks auf Buttons im
    // Overlay (z. B. „Würfeln") blubbern hierher und würden sonst die gerade
    // gestartete Animation sofort zu Ende spulen.
    if (animating && !(ev.target as HTMLElement).closest('button')) tray?.skip()
  })
  document.getElementById('gameDyn')!.addEventListener('click', onDynClick)
  document.getElementById('topbar')!.addEventListener('click', onDynClick)
}

function onDynClick(ev: Event): void {
  const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]')
  if (!target) return
  const action = target.dataset.action!
  if (action === 'cell') {
    handleCellTap(target.dataset.color as Color, Number(target.dataset.index))
  } else if (action === 'confirm') {
    confirmMove()
  } else if (action === 'target') {
    requestTarget(target.dataset.uid!)
  } else if (action === 'mute') {
    if (tray) {
      tray.muted = !tray.muted
      localStorage.setItem('qwixx.muted', tray.muted ? '1' : '0')
    }
    render()
  } else if (action === 'rules') {
    showRulesOverlay()
  } else if (action === 'rematch') {
    if (state && net?.role === 'host') {
      state = newGame(state.names, state.houseRules, state.matchNo + 1)
      selection = { white: null, colored: null }
      lastAnimatedRollId = 0
      submittedRollId = 0
      shownEvents = new Set()
      shownTargets = new Set()
      afterHostChange()
    }
  } else if (action === 'leave') {
    net?.destroy()
    net = null
    state = null
    hostPlayers = []
    saveSession(null)
    localStorage.removeItem('qwixx.hoststate')
    localStorage.removeItem('qwixx.hostplayers')
    tray?.dispose()
    tray = null
    releaseWakeLock()
    showHome()
  } else if (action === 'retry-join') {
    const session = loadSession()
    if (session) void resumeSession(session)
  }
}

function render(): void {
  if (!state || !gameMounted) return
  renderTopbar()
  renderDiceOverlay()
  renderDyn()
}

function renderTopbar(): void {
  const el = document.getElementById('topbar')
  if (!el || !state) return
  const n = state.names.length
  let connInfo = ''
  let dotOk = peerConnected
  if (net?.role === 'host') {
    const connected = hostConnectedCount()
    dotOk = connected === n
    if (n > 1) connInfo = `<span>· 👥 ${connected}/${n}</span>`
  } else if (n > 1) {
    connInfo = `<span>· 👥 ${n}</span>`
  }
  el.innerHTML = `
    <span class="conn-dot ${dotOk ? 'ok' : ''}"></span>
    <span>Raum ${esc(net?.code ?? '')}</span>
    <span>· Runde ${state.turn}</span>
    ${connInfo}
    <span class="spacer"></span>
    <button class="icon-btn" data-action="rules" title="Hausregeln">📜</button>
    <button class="icon-btn" data-action="mute" title="Ton">${tray?.muted ? '🔇' : '🔊'}</button>
  `
}

function renderDiceOverlay(): void {
  const el = document.getElementById('diceOverlay')
  if (!el || !state) return
  if (animating) {
    el.innerHTML = `<div class="msg" style="align-self:flex-end;margin-bottom:8px;font-size:0.75rem;opacity:0.8">Tippen zum Überspringen</div>`
    el.style.pointerEvents = 'none'
    return
  }
  el.style.pointerEvents = ''
  if (state.phase === 'playing' && !state.dice) {
    if (isMyTurn()) {
      el.innerHTML = rollRequested
        ? `<div class="msg pulse">Würfeln …</div>`
        : `<button class="roll-btn" id="rollBtn">🎲 Würfeln</button>`
      el.querySelector('#rollBtn')?.addEventListener('click', (ev) => {
        ev.stopPropagation()
        requestRoll()
      })
    } else {
      el.innerHTML = `<div class="msg pulse">${esc(state.names[state.active])} würfelt …</div>`
    }
  } else {
    el.innerHTML = ''
  }
}

function renderDyn(): void {
  const el = document.getElementById('gameDyn')
  if (!el || !state) return
  const s = state
  const myCard = s.cards[myIdx]
  const others = s.names.map((_, i) => i).filter((i) => i !== myIdx)

  const whites = s.dice && !myMoveDone() && !animating ? whiteCandidates(s, myIdx) : []
  const colors =
    s.dice && !myMoveDone() && !animating ? colorCandidates(s, myIdx, selection.white) : []

  // Wer hat seinen Zug noch nicht bestätigt? (für Warte-Anzeigen)
  const pendingNames = s.names.filter((_, i) => i !== myIdx && s.moves[i] === null)
  const pendingText =
    pendingNames.length > 2
      ? `${pendingNames.length} Spieler`
      : pendingNames.map((n) => esc(n)).join(' & ')

  // Turn-/Statuszeile
  let turnbar = ''
  if (s.phase === 'playing') {
    if (animating) turnbar = '🎲 Die Würfel rollen …'
    else if (!s.dice) turnbar = isMyTurn() ? '✨ Du bist am Zug!' : `${esc(s.names[s.active])} ist am Zug`
    else if (myMoveDone()) turnbar = pendingNames.length ? `⏳ Warte auf ${pendingText} …` : '⏳ Zug wird ausgewertet …'
    else turnbar = isMyTurn() ? 'Wähle deine Kreuze' : 'Weiße Summe nutzen? (optional)'
  }

  // Würfel-Summen-Chips
  let sums = ''
  if (s.dice && !animating) {
    sums += `<span class="sum-chip white">⚪ ${s.dice.w1} + ${s.dice.w2} = ${whiteSum(s.dice)}</span>`
    if (isMyTurn()) {
      for (const c of COLORS) {
        const list = colorSums(s.dice, c)
        if (list.length) {
          sums += `<span class="sum-chip ${c}">${esc(COLOR_NAMES[c])} ${list.join(' / ')}</span>`
        }
      }
    }
  }
  // Ausstehende Zielwürfe — erst nach der Zug-Auflösung, bis zum nächsten Wurf
  if (!animating && s.phase === 'playing' && !s.dice) {
    for (const e of s.events) {
      const rule = s.houseRules[e.id]
      if (e.dice && !e.target && rule.enabled && rule.reroll) {
        sums += `<button class="sum-chip target-btn" data-action="target" data-uid="${e.uid}">🎯 ${esc(EVENT_META[e.id].title)}${e.detail ? ` (${esc(e.detail)})` : ''}: Ziel auswürfeln</button>`
      }
    }
  }

  const board = renderCard(myCard, s, { whites, colors, interactive: true })

  // Bestätigen-Button
  let actions = ''
  if (s.phase === 'playing' && s.dice && !animating) {
    if (!myMoveDone()) {
      const hasSel = selection.white || selection.colored
      const hasCands = whites.length > 0 || colors.length > 0
      let label: string
      if (hasSel) label = '✅ Zug bestätigen'
      else if (!isMyTurn()) label = '➖ Passen'
      else if (hasCands) label = '⚠️ Ohne Kreuz bestätigen → Strafe (−5)'
      else label = '❌ Nichts möglich → Strafe (−5)'
      actions = `<div class="actions"><button class="btn ${hasSel ? 'primary' : isMyTurn() ? 'danger' : ''}" data-action="confirm">${label}</button></div>`
    } else {
      actions = pendingNames.length
        ? `<div class="waiting pulse">Zug abgeschickt – warte auf ${pendingText} …</div>`
        : `<div class="waiting pulse">Zug abgeschickt …</div>`
    }
  }

  // Boards der Mitspieler: beim Runterscrollen sieht man, wie weit alle sind
  const oppSections = others
    .map((i) => {
      const card = s.cards[i]
      const disconnected =
        net?.role === 'host' && i > 0 && hostPlayers[i] && hostPlayers[i].connId === null
      const badges = [
        i === s.active && s.phase === 'playing' ? '🎲' : '',
        s.phase === 'playing' && s.dice && s.moves[i] !== null ? '✅' : '',
        disconnected ? '📡' : '',
      ]
        .filter(Boolean)
        .join(' ')
      return `
      <div class="opp-summary">
        <div class="head">
          <span>👤 ${esc(s.names[i])} ${badges}</span>
          <span class="score">${totalScore(card)} Punkte · ${card.penalties} ⚠️</span>
        </div>
        <div class="opp-board">${renderCard(card, s, { whites: [], colors: [], interactive: false })}</div>
      </div>`
    })
    .join('')

  el.innerHTML = `
    <div class="turnbar">${turnbar}</div>
    <div class="sums">${sums}</div>
    <div class="board">${board}</div>
    ${actions}
    <div class="bottom-panel">
      <div class="penalties">
        Strafen:
        ${Array.from({ length: MAX_PENALTIES }, (_, i) => `<span class="penalty-box">${i < myCard.penalties ? '✕' : ''}</span>`).join('')}
      </div>
      <div class="score-chip">${totalScore(myCard)} Punkte</div>
    </div>
    ${oppSections ? `<div class="opp-title">Mitspieler</div>${oppSections}` : ''}
    ${s.phase === 'ended' ? renderGameOver(s) : ''}
    ${net?.role === 'guest' && !peerConnected && s.phase !== 'ended' ? renderDisconnected() : ''}
  `
}

function renderCard(
  card: GameState['cards'][number],
  s: GameState,
  opts: { whites: Cell[]; colors: Cell[]; interactive: boolean },
): string {
  return COLORS.map((color) => {
    const crosses = card.crosses[color]
    const last = crosses.length ? crosses[crosses.length - 1] : -1
    const locked = s.lockedRows.includes(color)
    const cells = ROW_NUMBERS[color]
      .map((num, index) => {
        const crossed = crosses.includes(index)
        const isCandW = opts.whites.some((c) => c.color === color && c.index === index)
        const isCandC = opts.colors.some((c) => c.color === color && c.index === index)
        const sel =
          opts.interactive &&
          ((selection.white?.color === color && selection.white.index === index) ||
            (selection.colored?.color === color && selection.colored.index === index))
        const cls = [
          'cell',
          index === LOCK_INDEX ? 'lockcell' : '',
          crossed ? 'crossed' : '',
          !crossed && index < last ? 'dead' : '',
          isCandW ? 'cand-white' : '',
          isCandC ? 'cand-color' : '',
          sel ? 'selected' : '',
        ]
          .filter(Boolean)
          .join(' ')
        const clickable = opts.interactive && (isCandW || isCandC || sel)
        return `<button class="${cls}" ${clickable ? `data-action="cell" data-color="${color}" data-index="${index}"` : 'disabled'}>${crossed || sel ? '' : num}</button>`
      })
      .join('')
    return `<div class="row ${color} ${locked ? 'locked' : ''}">${cells}<span class="lock-indicator">${locked ? '🔒' : '🔓'}</span></div>`
  }).join('')
}

function renderGameOver(s: GameState): string {
  const solo = s.names.length === 1
  const order = s.names
    .map((_, i) => i)
    .sort((a, b) => totalScore(s.cards[b]) - totalScore(s.cards[a]))
  const rows = order
    .map((i, rank) => {
      const card = s.cards[i]
      const colorPts = COLORS.map(
        (c) => `<span><span class="dot ${c}"></span>${rowScore(card, c)}</span>`,
      ).join('')
      return `
      <div class="rank-item ${i === myIdx ? 'me' : ''}">
        <div class="rank-head">
          <span class="place">${solo ? '🏁' : rank === 0 ? '🏆' : `${rank + 1}.`}</span>
          <span class="pname">${esc(s.names[i])}${i === myIdx ? ' (du)' : ''}</span>
          <span class="pts">${totalScore(card)} Punkte</span>
        </div>
        <div class="rank-detail">${colorPts}<span>⚠️ −${card.penalties * 5}</span></div>
      </div>`
    })
    .join('')
  const winnerText = solo
    ? `🏁 Fertig! ${totalScore(s.cards[0])} Punkte`
    : s.winner === -1
      ? '🤝 Unentschieden!'
      : `🏆 ${esc(s.names[s.winner!])} gewinnt!`
  return `
    <div class="banner-backdrop" style="z-index:40">
      <div class="banner" style="max-height:85dvh;overflow-y:auto">
        <div class="emoji">${solo ? '🏁' : s.winner === myIdx ? '🎉' : s.winner === -1 ? '🤝' : '😅'}</div>
        <h2>${winnerText}</h2>
        <div class="ranking">${rows}</div>
        ${
          net?.role === 'host'
            ? `<button class="btn primary" data-action="rematch">🔄 Revanche</button>`
            : `<p class="subtitle pulse">Revanche startet ${esc(s.names[0])} …</p>`
        }
        <div style="height:8px"></div>
        <button class="btn" data-action="leave">Spiel verlassen</button>
      </div>
    </div>`
}

function renderDisconnected(): string {
  if (reconnecting) {
    return `
      <div class="banner-backdrop" style="z-index:60">
        <div class="banner">
          <div class="emoji">📡</div>
          <h2>Verbindung unterbrochen</h2>
          <p class="who pulse">Stelle Verbindung wieder her …</p>
        </div>
      </div>`
  }
  return `
    <div class="banner-backdrop" style="z-index:60">
      <div class="banner">
        <div class="emoji">📡</div>
        <h2>Verbindung getrennt</h2>
        <p class="who">Verbindung zum Host verloren.</p>
        <button class="btn primary" data-action="retry-join">🔄 Neu verbinden</button>
        <div style="height:8px"></div>
        <button class="btn" data-action="leave">Spiel verlassen</button>
      </div>
    </div>`
}

function showRulesOverlay(): void {
  if (!state) return
  const items = (Object.keys(EVENT_META) as (keyof typeof EVENT_META)[])
    .filter((id) => state!.houseRules[id].enabled)
    .map((id) => {
      const meta = EVENT_META[id]
      const r = state!.houseRules[id]
      const numTexts = r.numberTexts
        ? Object.entries(r.numberTexts)
            .map(([n, t]) => `<p style="margin:6px 0 0;font-size:0.9rem">${n}er: ${esc(t ?? '')}</p>`)
            .join('')
        : ''
      return `<div class="rule-item" style="text-align:left">
        <div class="rule-head"><span>${meta.emoji}</span><span class="title">${esc(meta.title)}<span class="hint">${esc(meta.hint)}</span></span></div>
        ${r.text ? `<p style="margin:8px 0 0;font-size:0.95rem">${esc(r.text)}</p>` : ''}
        ${numTexts}
        ${r.reroll ? `<p style="margin:6px 0 0;font-size:0.8rem;color:var(--muted)">🎯 Ziel wird ausgewürfelt</p>` : ''}
      </div>`
    })
    .join('')
  const el = document.createElement('div')
  el.className = 'banner-backdrop'
  el.innerHTML = `
    <div class="banner" style="max-height:80dvh;overflow-y:auto">
      <h2>📜 Eure Hausregeln</h2>
      <div class="rules-list" style="margin-top:10px">${items || '<p class="subtitle">Keine Hausregeln aktiv.</p>'}</div>
      <div class="tap-hint">Tippen zum Schließen</div>
    </div>`
  el.addEventListener('click', () => el.remove())
  document.body.appendChild(el)
}

// ---------------------------------------------------------------------------
// Start

showHome()
