// Qwixx-Regelwerk: reine Spiellogik ohne UI/Netzwerk.
// Original-Regeln (Gamewright/NSV) + konfigurierbare Zusatz-Events ("Hausregeln").

export type Color = 'red' | 'yellow' | 'green' | 'blue'
export const COLORS: Color[] = ['red', 'yellow', 'green', 'blue']

export const COLOR_NAMES: Record<Color, string> = {
  red: 'Rot',
  yellow: 'Gelb',
  green: 'Grün',
  blue: 'Blau',
}

// Rot/Gelb: 2..12 aufsteigend — Grün/Blau: 12..2 absteigend.
export const ROW_NUMBERS: Record<Color, number[]> = {
  red: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  yellow: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  green: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2],
  blue: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2],
}

export const LOCK_INDEX = 10 // letztes Feld (12 bzw. 2) — schließt die Reihe
export const MIN_CROSSES_FOR_LOCK = 5
export const MAX_PENALTIES = 4
export const PENALTY_POINTS = 5
export const MAX_PLAYERS = 10

// Punkte nach Anzahl Kreuze (inkl. Bonuskreuz fürs Abschließen).
export const SCORE_TABLE = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66, 78]

// ---------------------------------------------------------------------------
// Hausregel-Events

export type EventId =
  | 'paschWW'
  | 'paschWC'
  | 'smallStraight'
  | 'largeStraight'
  | 'rowLocked'
  | 'penalty'
  | 'win'

export interface HouseRule {
  enabled: boolean
  text: string
  /** Darf nach dem Event ein Zielwürfel geworfen werden (bestimmt eine Zahl 1–6)? */
  reroll?: boolean
  /** Eigene Texte je Pasch-Zahl (1–6); Fallback ist `text`. Nur für Pasch-Events. */
  numberTexts?: Partial<Record<number, string>>
  /**
   * Nur für Pasch-Events: Bei welchen Pasch-Zahlen wird das Ziel ausgewürfelt?
   * Fehlt das Feld, gilt der Zielwurf für alle Zahlen (sofern `reroll` an ist).
   */
  rerollNumbers?: number[]
  /** Texte je Ziel-Ergebnis (1–6), z. B. 1 = „Tequila". Anzeige im Ziel-Banner. */
  targetTexts?: Partial<Record<number, string>>
}

/** Events, bei denen ein Zielwurf möglich ist (würfelbasierte Events). */
export const REROLLABLE_EVENTS: EventId[] = ['paschWW', 'paschWC', 'smallStraight', 'largeStraight']

/** Events, für die Texte pro Pasch-Zahl konfigurierbar sind. */
export const PASCH_EVENTS: EventId[] = ['paschWW', 'paschWC']

/** Referenz auf einen Würfel (für Zielwürfe). */
export type DieRef = 'white' | Color

export type HouseRules = Record<EventId, HouseRule>

export const EVENT_META: Record<EventId, { title: string; emoji: string; hint: string }> = {
  paschWW: { title: 'Pasch Weiß/Weiß', emoji: '⚪⚪', hint: 'Beide weißen Würfel zeigen dieselbe Zahl' },
  paschWC: { title: 'Pasch Weiß/Farbig', emoji: '⚪🎨', hint: 'Ein weißer und ein farbiger Würfel zeigen dieselbe Zahl' },
  smallStraight: { title: 'Kleine Straße', emoji: '🛣️', hint: '4 aufeinanderfolgende Zahlen (Farbe egal)' },
  largeStraight: { title: 'Große Straße', emoji: '🛤️', hint: '5 aufeinanderfolgende Zahlen (Farbe egal)' },
  rowLocked: { title: 'Reihe zugemacht', emoji: '🔒', hint: 'Jemand schließt eine Farbreihe ab' },
  penalty: { title: 'Strafe', emoji: '❌', hint: 'Jemand kassiert einen Fehlwurf (−5)' },
  win: { title: 'Sieg', emoji: '🏆', hint: 'Jemand gewinnt das Spiel' },
}

export function defaultHouseRules(): HouseRules {
  return {
    paschWW: { enabled: true, text: 'Alle trinken einen Schluck! 🍻', reroll: false },
    paschWC: { enabled: true, text: 'Wer gewürfelt hat, verteilt einen Schluck.', reroll: false },
    smallStraight: { enabled: true, text: 'Verteile 2 Schlücke.', reroll: false },
    largeStraight: { enabled: true, text: 'Alle trinken aus! 🍻', reroll: false },
    rowLocked: { enabled: true, text: 'Wer die Reihe zugemacht hat, verteilt 3 Schlücke.' },
    penalty: { enabled: true, text: 'Strafschluck für den Fehlwurf! 🥴' },
    win: { enabled: true, text: 'Wer verliert, räumt den Tisch ab. 😄' },
  }
}

export interface GameEvent {
  uid: string
  id: EventId
  player?: string // Name, falls das Event von einer Person ausgelöst wurde
  detail?: string // z. B. "Rot" bei Reihe zugemacht
  dice?: DieRef[] // Würfel, die das Event ausgelöst haben (macht es zielwurf-fähig)
  target?: number[] // ausgewürfeltes Ziel: ein einzelner Würfel (1 Element), gesetzt nach dem Zielwurf
  numbers?: number[] // Pasch-Zahl(en) des Events — wählt ggf. den Text aus numberTexts
}

// ---------------------------------------------------------------------------
// Spielzustand

export interface DiceValues {
  w1: number
  w2: number
  red?: number
  yellow?: number
  green?: number
  blue?: number
}

export interface Cell {
  color: Color
  index: number
}

export interface Move {
  white: Cell | null
  colored: Cell | null // nur für aktiven Spieler relevant
}

export interface PlayerCard {
  crosses: Record<Color, number[]> // angekreuzte Feld-Indizes, aufsteigend
  penalties: number
}

export interface GameState {
  game?: 'qwixx' // fehlt bei alten Spielständen — Abwesenheit bedeutet Qwixx
  phase: 'lobby' | 'playing' | 'ended'
  names: string[] // Index 0 = Host, 1–10 Spieler insgesamt
  cards: PlayerCard[]
  active: number
  turn: number
  rollId: number // erhöht sich bei jedem Wurf → Client weiß, wann animiert wird
  dice: DiceValues | null
  moves: (Move | null)[] // eingereichte Züge, null = noch nicht bestätigt
  lockedRows: Color[]
  houseRules: HouseRules
  events: GameEvent[] // Events des aktuellen Wurfs/der letzten Auflösung
  winner: number | null // Spieler-Index, -1 = Unentschieden
  matchNo: number // für Revanche (Startspieler wechselt)
}

export function emptyCard(): PlayerCard {
  return { crosses: { red: [], yellow: [], green: [], blue: [] }, penalties: 0 }
}

export function newGame(
  names: string[],
  houseRules: HouseRules,
  matchNo = 0,
): GameState {
  return {
    phase: 'playing',
    names,
    cards: names.map(() => emptyCard()),
    active: matchNo % names.length,
    turn: 1,
    rollId: 0,
    dice: null,
    moves: names.map(() => null),
    lockedRows: [],
    houseRules,
    events: [],
    winner: null,
    matchNo,
  }
}

// ---------------------------------------------------------------------------
// Würfeln

export function rollDice(state: GameState, random: () => number = Math.random): void {
  const d = (): number => 1 + Math.floor(random() * 6)
  const dice: DiceValues = { w1: d(), w2: d() }
  for (const c of COLORS) {
    if (!state.lockedRows.includes(c)) dice[c] = d()
  }
  state.dice = dice
  state.rollId++
  state.moves = state.names.map(() => null)
  state.events = detectRollEvents(state)
}

export function whiteSum(dice: DiceValues): number {
  return dice.w1 + dice.w2
}

export function colorSums(dice: DiceValues, color: Color): number[] {
  const v = dice[color]
  if (v === undefined) return []
  return [...new Set([dice.w1 + v, dice.w2 + v])]
}

function detectRollEvents(state: GameState): GameEvent[] {
  const dice = state.dice!
  const events: GameEvent[] = []
  const add = (id: EventId, detail?: string, involved?: DieRef[], numbers?: number[]) => {
    if (!state.houseRules[id].enabled) return
    events.push({
      uid: `${state.rollId}-${id}-${events.length}`,
      id,
      player: state.names[state.active],
      detail,
      dice: involved,
      numbers,
    })
  }

  if (dice.w1 === dice.w2) {
    add('paschWW', `Weiß ${dice.w1} & ${dice.w1}`, ['white', 'white'], [dice.w1])
  }

  const wcMatches = COLORS.filter((c) => {
    const v = dice[c]
    return v !== undefined && (v === dice.w1 || v === dice.w2)
  })
  if (wcMatches.length > 0) {
    add(
      'paschWC',
      wcMatches.map((c) => `${COLOR_NAMES[c]} ${dice[c]}`).join(', '),
      ['white', ...wcMatches],
      [...new Set(wcMatches.map((c) => dice[c]!))],
    )
  }

  // Alle Würfel als (Referenz, Wert)-Paare — für Straßen-Erkennung inkl. Beteiligter
  const pool: [DieRef, number][] = [
    ['white', dice.w1],
    ['white', dice.w2],
    ...COLORS.filter((c) => dice[c] !== undefined).map((c): [DieRef, number] => [c, dice[c]!]),
  ]
  const values = new Set(pool.map(([, v]) => v))
  const runOf = (len: number): number[] | null => {
    for (let start = 1; start + len - 1 <= 6; start++) {
      const run = Array.from({ length: len }, (_, i) => start + i)
      if (run.every((v) => values.has(v))) return run
    }
    return null
  }
  const diceForRun = (run: number[]): DieRef[] => {
    const used = new Set<number>()
    return run.map((v) => {
      const idx = pool.findIndex(([, val], i) => val === v && !used.has(i))
      used.add(idx)
      return pool[idx][0]
    })
  }

  const large = runOf(5)
  const small = runOf(4)
  if (large) add('largeStraight', large.join('-'), diceForRun(large))
  else if (small) add('smallStraight', small.join('-'), diceForRun(small))

  return events
}

/**
 * Ist für dieses Event (noch) ein Zielwurf möglich? Berücksichtigt bei
 * Pasch-Events die konfigurierten Pasch-Zahlen (z. B. 1er-Pasch ohne Ziel).
 */
export function canRollTarget(state: GameState, e: GameEvent): boolean {
  if (!e.dice || e.target) return false
  const rule = state.houseRules[e.id]
  if (!rule?.enabled || !rule.reroll || !REROLLABLE_EVENTS.includes(e.id)) return false
  if (PASCH_EVENTS.includes(e.id) && rule.rerollNumbers && e.numbers?.length) {
    return e.numbers.some((n) => rule.rerollNumbers!.includes(n))
  }
  return true
}

/**
 * Zielwurf für ein würfelbasiertes Hausregel-Event: Ein einzelner Würfel
 * bestimmt das Ziel (1–6). Pro Event nur einmal möglich. Gibt das
 * aktualisierte Event zurück, sonst null.
 */
export function rollTarget(
  state: GameState,
  uid: string,
  random: () => number = Math.random,
): GameEvent | null {
  // Zielwürfe sind erst dran, wenn der Zug aufgelöst ist (Kreuze gesetzt).
  if (state.phase === 'playing' && state.dice) return null
  const e = state.events.find((x) => x.uid === uid)
  if (!e || !canRollTarget(state, e)) return null
  e.target = [1 + Math.floor(random() * 6)]
  return e
}

// ---------------------------------------------------------------------------
// Kreuz-Validierung

function lastCrossIndex(card: PlayerCard, color: Color): number {
  const arr = card.crosses[color]
  return arr.length ? arr[arr.length - 1] : -1
}

export function canCross(
  card: PlayerCard,
  cell: Cell,
  lockedRows: Color[],
): boolean {
  if (lockedRows.includes(cell.color)) return false
  if (cell.index <= lastCrossIndex(card, cell.color)) return false
  if (cell.index === LOCK_INDEX && card.crosses[cell.color].length < MIN_CROSSES_FOR_LOCK) {
    return false
  }
  return true
}

/** Alle Felder, die mit der Weiß-Summe angekreuzt werden dürfen (alle Spieler). */
export function whiteCandidates(state: GameState, player: number): Cell[] {
  if (!state.dice) return []
  const sum = whiteSum(state.dice)
  const card = state.cards[player]
  const out: Cell[] = []
  for (const color of COLORS) {
    const index = ROW_NUMBERS[color].indexOf(sum)
    if (index >= 0 && canCross(card, { color, index }, state.lockedRows)) {
      out.push({ color, index })
    }
  }
  return out
}

/** Farbwürfel-Kombis für den aktiven Spieler — nach evtl. bereits gewähltem Weiß-Kreuz. */
export function colorCandidates(
  state: GameState,
  player: number,
  tentativeWhite: Cell | null,
): Cell[] {
  if (!state.dice || player !== state.active) return []
  const card = withCross(state.cards[player], tentativeWhite)
  const out: Cell[] = []
  for (const color of COLORS) {
    for (const sum of colorSums(state.dice, color)) {
      const index = ROW_NUMBERS[color].indexOf(sum)
      if (index >= 0 && canCross(card, { color, index }, state.lockedRows)) {
        if (!out.some((c) => c.color === color && c.index === index)) {
          out.push({ color, index })
        }
      }
    }
  }
  return out
}

function withCross(card: PlayerCard, cell: Cell | null): PlayerCard {
  if (!cell) return card
  return {
    penalties: card.penalties,
    crosses: {
      ...card.crosses,
      [cell.color]: [...card.crosses[cell.color], cell.index].sort((a, b) => a - b),
    },
  }
}

// ---------------------------------------------------------------------------
// Zug einreichen & auflösen

export function submitMove(state: GameState, player: number, move: Move): void {
  if (state.phase !== 'playing' || !state.dice) return
  if (player < 0 || player >= state.moves.length || state.moves[player]) return
  state.moves[player] = move
  if (state.moves.every((m) => m !== null)) resolveTurn(state)
}

function resolveTurn(state: GameState): void {
  const dice = state.dice!
  const lockedBefore = [...state.lockedRows]
  const events: GameEvent[] = []
  const newlyLocked: Color[] = []
  const wSum = whiteSum(dice)
  let uid = 0
  const add = (id: EventId, player?: string, detail?: string) => {
    if (id !== 'win' && !state.houseRules[id].enabled) return
    events.push({ uid: `${state.rollId}-r-${id}-${uid++}`, id, player, detail })
  }

  for (let p = 0; p < state.cards.length; p++) {
    const move = state.moves[p] ?? { white: null, colored: null }
    const card = state.cards[p]
    let crossed = 0

    const w = move.white
    if (w && ROW_NUMBERS[w.color][w.index] === wSum && canCross(card, w, lockedBefore)) {
      card.crosses[w.color] = [...card.crosses[w.color], w.index].sort((a, b) => a - b)
      crossed++
      if (w.index === LOCK_INDEX && !newlyLocked.includes(w.color)) newlyLocked.push(w.color)
      if (w.index === LOCK_INDEX) add('rowLocked', state.names[p], COLOR_NAMES[w.color])
    }

    if (p === state.active) {
      const c = move.colored
      if (
        c &&
        colorSums(dice, c.color).includes(ROW_NUMBERS[c.color][c.index]) &&
        canCross(card, c, lockedBefore)
      ) {
        card.crosses[c.color] = [...card.crosses[c.color], c.index].sort((a, b) => a - b)
        crossed++
        if (c.index === LOCK_INDEX && !newlyLocked.includes(c.color)) newlyLocked.push(c.color)
        if (c.index === LOCK_INDEX) add('rowLocked', state.names[p], COLOR_NAMES[c.color])
      }
      if (crossed === 0) {
        card.penalties++
        add('penalty', state.names[p], `Strafe ${card.penalties}/${MAX_PENALTIES}`)
      }
    }
  }

  state.lockedRows = [...lockedBefore, ...newlyLocked]

  const gameOver =
    state.lockedRows.length >= 2 ||
    state.cards.some((c) => c.penalties >= MAX_PENALTIES)

  if (gameOver) {
    state.phase = 'ended'
    const scores = state.cards.map(totalScore)
    const best = Math.max(...scores)
    const tied = scores.filter((s) => s === best).length > 1
    state.winner = tied ? -1 : scores.indexOf(best)
    add('win', state.winner === -1 ? undefined : state.names[state.winner])
  } else {
    state.active = (state.active + 1) % state.cards.length
    state.turn++
    state.dice = null
    state.moves = state.names.map(() => null)
  }

  // Wurf-Events (Pasch, Straße) bleiben erhalten — sie werden erst nach der
  // Auflösung angezeigt und können danach noch Zielwürfe bekommen.
  state.events = [...state.events, ...events]
}

/**
 * Anzuzeigende Regeltexte für ein Event: Bei Pasch-Events mit konfigurierten
 * Texten pro Zahl gewinnen diese, sonst der allgemeine Text.
 */
export function ruleTextsFor(e: GameEvent, rule: HouseRule): string[] {
  const out: string[] = []
  if (e.numbers?.length && rule.numberTexts) {
    for (const n of e.numbers) {
      const t = rule.numberTexts[n]?.trim()
      if (t) out.push(`${n}er-Pasch: ${t}`)
    }
  }
  if (!out.length && rule.text) out.push(rule.text)
  return out
}

// ---------------------------------------------------------------------------
// Punkte

export function rowCrossCount(card: PlayerCard, color: Color): number {
  const arr = card.crosses[color]
  // Abschluss-Kreuz (Lock-Feld) zählt doppelt (Bonuskreuz).
  return arr.length + (arr.includes(LOCK_INDEX) ? 1 : 0)
}

export function rowScore(card: PlayerCard, color: Color): number {
  return SCORE_TABLE[rowCrossCount(card, color)]
}

export function totalScore(card: PlayerCard): number {
  const rows = COLORS.reduce((sum, c) => sum + rowScore(card, c), 0)
  return rows - card.penalties * PENALTY_POINTS
}
