import './style.css'
import { DiceTray, type DieSpec } from './dice'
import { Net } from './net'
import {
  COLORS,
  COLOR_NAMES,
  EVENT_META,
  LOCK_INDEX,
  MAX_PENALTIES,
  ROW_NUMBERS,
  colorCandidates,
  colorSums,
  defaultHouseRules,
  newGame,
  rollDice,
  rowCrossCount,
  rowScore,
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

let net: Net | null = null
let myIdx: 0 | 1 = 0
let state: GameState | null = null
let tray: DiceTray | null = null
let selection: { white: Cell | null; colored: Cell | null } = { white: null, colored: null }
let animating = false
let rollRequested = false
let lastAnimatedRollId = 0
let submittedRollId = 0
let shownEvents = new Set<string>()
let bannerQueue: GameEvent[] = []
let bannerActive = false
let peerConnected = false
let gameMounted = false

// ---------------------------------------------------------------------------
// Helper

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function getName(): string {
  return localStorage.getItem('qwixx.name') ?? ''
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
// Host-Logik

function afterHostChange(): void {
  if (!state || !net) return
  persistHostState()
  net.send({ t: 'state', s: state })
  queueResolutionEvents()
  render()
}

function hostRoll(): void {
  if (!state || state.phase !== 'playing' || state.dice) return
  rollDice(state)
  persistHostState()
  net?.send({ t: 'state', s: state })
  void animateRoll()
}

function setupHostHandlers(): void {
  if (!net) return
  net.onMessage = (m) => {
    if (!state) return
    if (m.t === 'hello') {
      // (Re-)Connect des Gasts: aktuellen Stand schicken
      if (m.name) state.names[1] = m.name
      net!.send({ t: 'state', s: state })
      render()
    } else if (m.t === 'move') {
      submitMove(state, 1, m.move)
      afterHostChange()
    } else if (m.t === 'rollreq') {
      if (state.active === 1) hostRoll()
    }
  }
  net.onPeerConnected = () => {
    peerConnected = true
    if (state) net!.send({ t: 'state', s: state })
    render()
  }
  net.onPeerDisconnected = () => {
    peerConnected = false
    render()
  }
}

// ---------------------------------------------------------------------------
// Gast-Logik

function setupGuestHandlers(): void {
  if (!net) return
  net.onMessage = (m) => {
    if (m.t !== 'state') return
    const prev = state
    state = m.s
    if (!prev || prev.matchNo !== state.matchNo) {
      // Erster Stand oder Revanche: Events/Animationen zurücksetzen
      selection = { white: null, colored: null }
      shownEvents = new Set(prev ? [] : state.events.map((e) => e.uid))
      lastAnimatedRollId = prev ? 0 : state.rollId
      submittedRollId = 0
    }
    if (!gameMounted) mountGame()
    if (state.dice && state.rollId > lastAnimatedRollId) {
      rollRequested = false
      void animateRoll()
    } else {
      queueResolutionEvents()
      render()
    }
  }
  net.onPeerDisconnected = () => {
    peerConnected = false
    render()
  }
  net.onPeerConnected = () => {
    peerConnected = true
    net!.send({ t: 'hello', name: getName() })
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

function confirmMove(): void {
  if (!state || !state.dice || animating) return
  const move = { white: selection.white, colored: selection.colored }
  submittedRollId = state.rollId
  if (net?.role === 'host') {
    submitMove(state, 0, move)
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
  queueRollEvents()
  render()
}

function queueRollEvents(): void {
  if (!state) return
  enqueueBanners(state.events.filter((e) => !e.uid.includes('-r-')))
}

function queueResolutionEvents(): void {
  if (!state) return
  enqueueBanners(state.events.filter((e) => e.uid.includes('-r-')))
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
    const el = document.createElement('div')
    el.className = 'banner-backdrop'
    el.innerHTML = `
      <div class="banner">
        <div class="emoji">${meta.emoji}</div>
        <h2>${esc(meta.title)}${e.id === 'win' && e.player ? `: ${esc(e.player)}!` : '!'}</h2>
        ${e.player && e.id !== 'win' ? `<p class="who">${esc(e.player)}${e.detail ? ` · ${esc(e.detail)}` : ''}</p>` : ''}
        ${e.id === 'win' && !e.player ? `<p class="who">Unentschieden!</p>` : ''}
        ${rule?.enabled && rule.text ? `<div class="ruletext">${esc(rule.text)}</div>` : ''}
        <div class="tap-hint">Tippen zum Schließen</div>
      </div>`
    document.body.appendChild(el)
    const close = (): void => {
      clearTimeout(timer)
      el.remove()
      resolve()
    }
    const timer = setTimeout(close, 5000)
    el.addEventListener('click', close)
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
      <h1>QWIXX</h1>
      <p class="subtitle">Zu zweit spielen – jeder am eigenen Handy</p>
      <div class="stack">
        <input type="text" id="name" placeholder="Dein Name" maxlength="16" value="${esc(getName())}" />
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
              <textarea rows="2" data-text placeholder="z. B. Alle trinken einen Schluck …" ${r.enabled ? '' : 'style="display:none"'}>${esc(r.text)}</textarea>
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
      const ta = toggle.closest('.rule-item')!.querySelector<HTMLElement>('[data-text]')!
      ta.style.display = toggle.checked ? '' : 'none'
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
      }
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
  saveSession({ role: 'host', code: net.code, name: getName() })
  setupHostHandlers()
  showLobby(net.code)
  net.onMessage = (m) => {
    if (m.t === 'hello') {
      state = newGame([getName(), m.name || 'Mitspieler:in'], rules)
      setupHostHandlers() // ab jetzt normale Spiel-Handler
      peerConnected = true
      persistHostState()
      net!.send({ t: 'state', s: state })
      mountGame()
      render()
    }
  }
}

function showLobby(code: string): void {
  const url = `${location.origin}${location.pathname}?join=${code}`
  app.innerHTML = `
    <div class="screen center">
      <p class="subtitle">Dein Raum-Code</p>
      <div class="code-display">${esc(code)}</div>
      <p class="subtitle pulse">Warte auf deine Mitspielerin …</p>
      <div class="stack">
        <button class="btn primary" id="share">📤 Einladung teilen</button>
        <button class="btn" id="cancel">Abbrechen</button>
      </div>
    </div>`
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
    saveSession(null)
    showHome()
  })
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
  myIdx = 1
  peerConnected = true
  saveSession({ role: 'guest', code: net.code, name: getName() })
  history.replaceState(null, '', location.pathname)
  setupGuestHandlers()
  net.send({ t: 'hello', name: getName() })
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
  lastAnimatedRollId = state.rollId
  shownEvents = new Set(state.events.map((e) => e.uid))
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
  mount.addEventListener('click', () => {
    if (animating) tray?.skip()
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
      afterHostChange()
    }
  } else if (action === 'leave') {
    net?.destroy()
    net = null
    state = null
    saveSession(null)
    localStorage.removeItem('qwixx.hoststate')
    tray?.dispose()
    tray = null
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
  el.innerHTML = `
    <span class="conn-dot ${peerConnected ? 'ok' : ''}"></span>
    <span>Raum ${esc(net?.code ?? '')}</span>
    <span>· Runde ${state.turn}</span>
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
      el.querySelector('#rollBtn')?.addEventListener('click', requestRoll)
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
  const oppIdx = (1 - myIdx) as 0 | 1
  const myCard = s.cards[myIdx]
  const oppCard = s.cards[oppIdx]

  const whites = s.dice && !myMoveDone() && !animating ? whiteCandidates(s, myIdx) : []
  const colors =
    s.dice && !myMoveDone() && !animating ? colorCandidates(s, myIdx, selection.white) : []

  // Turn-/Statuszeile
  let turnbar = ''
  if (s.phase === 'playing') {
    if (animating) turnbar = '🎲 Die Würfel rollen …'
    else if (!s.dice) turnbar = isMyTurn() ? '✨ Du bist am Zug!' : `${esc(s.names[s.active])} ist am Zug`
    else if (myMoveDone()) turnbar = `⏳ Warte auf ${esc(s.names[oppIdx])} …`
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
      actions = `<div class="waiting pulse">Zug abgeschickt – warte auf ${esc(s.names[oppIdx])} …</div>`
    }
  }

  const oppRows = COLORS.map(
    (c) =>
      `<span><span class="dot ${c}"></span>${rowCrossCount(oppCard, c)}</span>`,
  ).join('')

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
    <div class="opp-summary">
      <div class="head">
        <span>👤 ${esc(s.names[oppIdx])}</span>
        <span class="score">${totalScore(oppCard)} Punkte · ${oppCard.penalties} ⚠️</span>
      </div>
      <div class="opp-rows">${oppRows}</div>
    </div>
    ${s.phase === 'ended' ? renderGameOver(s) : ''}
    ${!peerConnected && s.phase !== 'ended' ? renderDisconnected() : ''}
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
          (selection.white?.color === color && selection.white.index === index) ||
          (selection.colored?.color === color && selection.colored.index === index)
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
  const rows = COLORS.map(
    (c) => `
    <tr>
      <td><span class="dot ${c}"></span>${COLOR_NAMES[c]}</td>
      <td>${rowScore(s.cards[0], c)}</td>
      <td>${rowScore(s.cards[1], c)}</td>
    </tr>`,
  ).join('')
  const winnerText =
    s.winner === -1
      ? '🤝 Unentschieden!'
      : `🏆 ${esc(s.names[s.winner!])} gewinnt!`
  return `
    <div class="banner-backdrop" style="z-index:40">
      <div class="banner">
        <div class="emoji">${s.winner === myIdx ? '🎉' : s.winner === -1 ? '🤝' : '😅'}</div>
        <h2>${winnerText}</h2>
        <table class="result-table">
          <tr><th></th><th>${esc(s.names[0])}</th><th>${esc(s.names[1])}</th></tr>
          ${rows}
          <tr><td>Strafen</td><td>−${s.cards[0].penalties * 5}</td><td>−${s.cards[1].penalties * 5}</td></tr>
          <tr class="total"><td>Gesamt</td><td>${totalScore(s.cards[0])}</td><td>${totalScore(s.cards[1])}</td></tr>
        </table>
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
  return `
    <div class="banner-backdrop" style="z-index:60">
      <div class="banner">
        <div class="emoji">📡</div>
        <h2>Verbindung getrennt</h2>
        <p class="who">${net?.role === 'host' ? 'Warte, bis sich deine Mitspielerin wieder verbindet …' : 'Verbindung zum Host verloren.'}</p>
        ${net?.role === 'guest' ? `<button class="btn primary" data-action="retry-join">🔄 Neu verbinden</button>` : ''}
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
      return `<div class="rule-item" style="text-align:left">
        <div class="rule-head"><span>${meta.emoji}</span><span class="title">${esc(meta.title)}<span class="hint">${esc(meta.hint)}</span></span></div>
        ${r.text ? `<p style="margin:8px 0 0;font-size:0.95rem">${esc(r.text)}</p>` : ''}
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
