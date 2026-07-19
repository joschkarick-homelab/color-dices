// Kniffel-Regelwerk: reine Spiellogik ohne UI/Netzwerk.
// Offizielle Kniffel-Regeln (Schmidt Spiele) + konfigurierbare Hausregeln
// mit Zielperson und Würfel-Varianz (wer/was/wie viel wird ausgewürfelt).

// ---------------------------------------------------------------------------
// Kategorien

export const KNIFFEL_CATEGORIES = [
  'ones',
  'twos',
  'threes',
  'fours',
  'fives',
  'sixes',
  'threeKind',
  'fourKind',
  'fullHouse',
  'smallStraight',
  'largeStraight',
  'kniffel',
  'chance',
] as const
export type KniffelCategory = (typeof KNIFFEL_CATEGORIES)[number]

export const UPPER_CATEGORIES: KniffelCategory[] = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes']
export const UPPER_BONUS_THRESHOLD = 63
export const UPPER_BONUS = 35
export const EXTRA_KNIFFEL_BONUS = 100
export const MAX_ROLLS = 3
export const KNIFFEL_ROUNDS = KNIFFEL_CATEGORIES.length // 13

export const CATEGORY_META: Record<KniffelCategory, { title: string; hint: string }> = {
  ones: { title: 'Einser', hint: 'Summe aller 1er' },
  twos: { title: 'Zweier', hint: 'Summe aller 2er' },
  threes: { title: 'Dreier', hint: 'Summe aller 3er' },
  fours: { title: 'Vierer', hint: 'Summe aller 4er' },
  fives: { title: 'Fünfer', hint: 'Summe aller 5er' },
  sixes: { title: 'Sechser', hint: 'Summe aller 6er' },
  threeKind: { title: 'Dreierpasch', hint: '3 gleiche → Summe aller Würfel' },
  fourKind: { title: 'Viererpasch', hint: '4 gleiche → Summe aller Würfel' },
  fullHouse: { title: 'Full House', hint: '3 + 2 gleiche → 25 Punkte' },
  smallStraight: { title: 'Kleine Straße', hint: '4 in Folge → 30 Punkte' },
  largeStraight: { title: 'Große Straße', hint: '5 in Folge → 40 Punkte' },
  kniffel: { title: 'Kniffel', hint: '5 gleiche → 50 Punkte' },
  chance: { title: 'Chance', hint: 'Summe aller Würfel' },
}

// ---------------------------------------------------------------------------
// Hausregeln: Ereignis → Zielperson → Aktion (mit Würfel-Varianz)

export type KniffelEventId =
  | 'kniffel'
  | 'extraKniffel'
  | 'fourKindEv'
  | 'fullHouseEv'
  | 'largeStraightEv'
  | 'smallStraightEv'
  | 'scratch'
  | 'upperBonusEv'
  | 'win'
  | 'lastPlace'

export const KNIFFEL_EVENT_META: Record<KniffelEventId, { title: string; emoji: string; hint: string }> = {
  kniffel: { title: 'Kniffel', emoji: '🎉', hint: '5 gleiche Würfel' },
  extraKniffel: { title: 'Zusatz-Kniffel', emoji: '🎊', hint: 'Noch ein Kniffel (+100)' },
  fourKindEv: { title: 'Viererpasch', emoji: '💪', hint: '4 gleiche Würfel' },
  fullHouseEv: { title: 'Full House', emoji: '🏠', hint: '3 + 2 gleiche' },
  largeStraightEv: { title: 'Große Straße', emoji: '🛤️', hint: '5 Zahlen in Folge' },
  smallStraightEv: { title: 'Kleine Straße', emoji: '🛣️', hint: '4 Zahlen in Folge' },
  scratch: { title: 'Gestrichen', emoji: '❌', hint: 'Kategorie mit 0 Punkten gestrichen' },
  upperBonusEv: { title: 'Bonus geschafft', emoji: '🎯', hint: 'Oben 63+ Punkte erreicht' },
  win: { title: 'Sieg', emoji: '🏆', hint: 'Jemand gewinnt das Spiel' },
  lastPlace: { title: 'Letzter Platz', emoji: '🥴', hint: 'Jemand wird Letzter' },
}

/** Wen trifft die Regel? 'roll' = ein Würfelwurf bestimmt den Spieler. */
export type KniffelTarget = 'self' | 'others' | 'all' | 'roll'

export const TARGET_LABELS: Record<KniffelTarget, string> = {
  self: 'Auslöser selbst',
  others: 'Alle anderen',
  all: 'Alle',
  roll: '🎲 Spieler auswürfeln',
}

export interface KniffelHouseRule {
  enabled: boolean
  /** Aktionstext hinter der Zielperson, z. B. „trinkt einen Schluck". */
  text: string
  target: KniffelTarget
  /** Anzahl (1–6) zusätzlich auswürfeln? */
  rollCount: boolean
  /** Würfeltabelle nutzen? Der Würfel wählt einen der 6 Einträge. */
  tableOn: boolean
  /** 6 Einträge (leer = „Glück gehabt"), z. B. welcher Shot. */
  table: string[]
}

export type KniffelHouseRules = Record<KniffelEventId, KniffelHouseRule>

const emptyTable = (): string[] => ['', '', '', '', '', '']

export function defaultKniffelRules(): KniffelHouseRules {
  const base = (r: Partial<KniffelHouseRule>): KniffelHouseRule => ({
    enabled: true,
    text: '',
    target: 'self',
    rollCount: false,
    tableOn: false,
    table: emptyTable(),
    ...r,
  })
  return {
    kniffel: base({
      text: 'trinken einen Shot! 🥃',
      target: 'others',
      tableOn: true,
      table: ['Tequila', 'Vodka', 'Ouzo', 'Korn', 'Rum', 'Freie Wahl'],
    }),
    extraKniffel: base({ text: 'trinken aus! 🍻', target: 'others' }),
    fourKindEv: base({ text: 'trinken einen Schluck.', target: 'all' }),
    fullHouseEv: base({ text: 'trinkt einen Schluck.', target: 'roll' }),
    largeStraightEv: base({ text: 'verteilt 3 Schlücke.', target: 'self' }),
    smallStraightEv: base({ enabled: false, text: 'verteilt 1 Schluck.', target: 'self' }),
    scratch: base({ text: 'trinkt 2 Schlücke. 🥴', target: 'self' }),
    upperBonusEv: base({ text: 'darf jemanden zum Trinken bestimmen. 👑', target: 'self' }),
    win: base({ text: 'Wer verliert, räumt den Tisch ab. 😄', target: 'all' }),
    lastPlace: base({ enabled: false, text: 'macht die nächste Runde Musik. 🎶', target: 'self' }),
  }
}

/**
 * Ereignis mit bereits aufgelöster Varianz: Der Host würfelt Zielperson,
 * Anzahl und Tabellen-Eintrag sofort beim Entstehen aus — alle Clients
 * spielen dieselben Ergebnisse nur noch ab.
 */
export interface KniffelEvent {
  uid: string
  id: KniffelEventId
  player: string // Auslöser
  playerIdx: number
  detail?: string // z. B. „Full House (25)" oder gestrichene Kategorie
  targetIdx?: number // ausgewürfelter Spieler (bei target='roll')
  count?: number // ausgewürfelte Anzahl (bei rollCount)
  tablePick?: number // 1–6: gewählter Tabellen-Eintrag (bei tableOn)
}

// ---------------------------------------------------------------------------
// Spielzustand

export interface KniffelSheet {
  filled: Partial<Record<KniffelCategory, number>>
  extraKniffels: number
}

export interface KniffelState {
  game: 'kniffel'
  phase: 'playing' | 'ended'
  names: string[]
  sheets: KniffelSheet[]
  active: number
  round: number // 1..13 (Runde des aktiven Spielers)
  rollId: number
  dice: number[] | null // 5 Würfel, null = Zug noch nicht begonnen
  held: boolean[] // festgehaltene Würfel (zwischen den Würfen)
  rolled: boolean[] // welche Würfel im letzten Wurf neu geworfen wurden
  rollsUsed: number // 0..3 im aktuellen Zug
  houseRules: KniffelHouseRules
  events: KniffelEvent[]
  winner: number | null // -1 = Unentschieden
  matchNo: number
}

export function emptySheet(): KniffelSheet {
  return { filled: {}, extraKniffels: 0 }
}

export function newKniffelGame(
  names: string[],
  houseRules: KniffelHouseRules,
  matchNo = 0,
): KniffelState {
  return {
    game: 'kniffel',
    phase: 'playing',
    names,
    sheets: names.map(() => emptySheet()),
    active: matchNo % names.length,
    round: 1,
    rollId: 0,
    dice: null,
    held: [false, false, false, false, false],
    rolled: [true, true, true, true, true],
    rollsUsed: 0,
    houseRules,
    events: [],
    winner: null,
    matchNo,
  }
}

// ---------------------------------------------------------------------------
// Punkte

function counts(dice: number[]): number[] {
  const c = [0, 0, 0, 0, 0, 0, 0]
  for (const d of dice) c[d]++
  return c
}

const sum = (dice: number[]): number => dice.reduce((a, b) => a + b, 0)

function hasRun(dice: number[], len: number): boolean {
  const vals = new Set(dice)
  for (let start = 1; start + len - 1 <= 6; start++) {
    if (Array.from({ length: len }, (_, i) => start + i).every((v) => vals.has(v))) return true
  }
  return false
}

const isFullHouse = (dice: number[]): boolean => {
  const c = counts(dice).filter((n) => n > 0)
  return c.includes(3) && c.includes(2)
}

const isFiveSame = (dice: number[]): boolean => counts(dice).includes(5)

/**
 * Punkte, die `dice` in `cat` bringen würden. `joker` = Kniffel-Joker:
 * Ein weiterer Kniffel (Kniffel-Feld schon mit 50 gefüllt) darf jede offene
 * Kategorie mit vollen Punkten belegen.
 */
export function scoreFor(dice: number[], cat: KniffelCategory, joker = false): number {
  const c = counts(dice)
  const upperIdx = UPPER_CATEGORIES.indexOf(cat)
  if (upperIdx >= 0) {
    const face = upperIdx + 1
    return c[face] * face
  }
  switch (cat) {
    case 'threeKind':
      return c.some((n) => n >= 3) ? sum(dice) : 0
    case 'fourKind':
      return c.some((n) => n >= 4) ? sum(dice) : 0
    case 'fullHouse':
      return isFullHouse(dice) || (joker && isFiveSame(dice)) ? 25 : 0
    case 'smallStraight':
      return hasRun(dice, 4) || (joker && isFiveSame(dice)) ? 30 : 0
    case 'largeStraight':
      return hasRun(dice, 5) || (joker && isFiveSame(dice)) ? 40 : 0
    case 'kniffel':
      return isFiveSame(dice) ? 50 : 0
    case 'chance':
      return sum(dice)
    default:
      return 0
  }
}

export function upperSum(sheet: KniffelSheet): number {
  return UPPER_CATEGORIES.reduce((acc, c) => acc + (sheet.filled[c] ?? 0), 0)
}

export function hasUpperBonus(sheet: KniffelSheet): boolean {
  return upperSum(sheet) >= UPPER_BONUS_THRESHOLD
}

export function totalScore(sheet: KniffelSheet): number {
  const all = KNIFFEL_CATEGORIES.reduce((acc, c) => acc + (sheet.filled[c] ?? 0), 0)
  return all + (hasUpperBonus(sheet) ? UPPER_BONUS : 0) + sheet.extraKniffels * EXTRA_KNIFFEL_BONUS
}

export function filledCount(sheet: KniffelSheet): number {
  return Object.keys(sheet.filled).length
}

/** Gilt für den aktuellen Wurf die Kniffel-Joker-Regel? */
export function jokerActive(state: KniffelState): boolean {
  return (
    state.dice !== null && isFiveSame(state.dice) && state.sheets[state.active].filled.kniffel === 50
  )
}

// ---------------------------------------------------------------------------
// Aktionen (nur der Host führt sie aus)

export function kniffelRoll(
  state: KniffelState,
  hold: boolean[],
  random: () => number = Math.random,
): boolean {
  if (state.phase !== 'playing' || state.rollsUsed >= MAX_ROLLS) return false
  const d = (): number => 1 + Math.floor(random() * 6)
  const held = state.rollsUsed === 0 ? [false, false, false, false, false] : hold.slice(0, 5)
  const dice = state.dice ?? [0, 0, 0, 0, 0]
  for (let i = 0; i < 5; i++) {
    if (!held[i] || state.dice === null) dice[i] = d()
  }
  // Alles festgehalten → es gibt nichts zu würfeln
  if (state.dice !== null && held.every(Boolean)) return false
  state.dice = dice
  state.held = held
  state.rolled = held.map((h) => !h || state.rollsUsed === 0)
  state.rollsUsed++
  state.rollId++
  return true
}

export function setHeld(state: KniffelState, hold: boolean[]): boolean {
  if (state.phase !== 'playing' || state.dice === null) return false
  if (state.rollsUsed < 1 || state.rollsUsed >= MAX_ROLLS) return false
  state.held = hold.slice(0, 5).map(Boolean)
  return true
}

/** Kategorie eintragen (oder streichen) und den Zug auflösen. */
export function kniffelScore(
  state: KniffelState,
  cat: KniffelCategory,
  random: () => number = Math.random,
): boolean {
  if (state.phase !== 'playing' || state.dice === null || state.rollsUsed < 1) return false
  const sheet = state.sheets[state.active]
  if (sheet.filled[cat] !== undefined) return false

  const joker = jokerActive(state)
  const points = scoreFor(state.dice, cat, joker)
  const bonusBefore = hasUpperBonus(sheet)
  sheet.filled[cat] = points
  if (joker) sheet.extraKniffels++

  const events = detectEvents(state, cat, points, joker, bonusBefore, random)

  // Spielende oder nächster Spieler
  if (state.sheets.every((s) => filledCount(s) >= KNIFFEL_ROUNDS)) {
    state.phase = 'ended'
    const scores = state.sheets.map(totalScore)
    const best = Math.max(...scores)
    const tiedBest = scores.filter((s) => s === best).length > 1
    state.winner = tiedBest ? -1 : scores.indexOf(best)
    if (!tiedBest) {
      addEvent(state, events, 'win', state.winner, undefined, random)
      const worst = Math.min(...scores)
      if (scores.filter((s) => s === worst).length === 1) {
        addEvent(state, events, 'lastPlace', scores.indexOf(worst), undefined, random)
      }
    }
  } else {
    state.active = (state.active + 1) % state.names.length
    state.round = filledCount(state.sheets[state.active]) + 1
  }

  state.dice = null
  state.held = [false, false, false, false, false]
  state.rollsUsed = 0
  state.events = [...state.events, ...events]
  return true
}

// ---------------------------------------------------------------------------
// Ereignisse & Varianz

function ruleFor(state: KniffelState, id: KniffelEventId): KniffelHouseRule | null {
  const r = state.houseRules[id]
  return r?.enabled ? r : null
}

/**
 * Varianz sofort auflösen: Zielperson/Anzahl/Tabelle würfelt der Host beim
 * Entstehen des Events aus — Clients spielen nur noch die Animation ab.
 */
function addEvent(
  state: KniffelState,
  out: KniffelEvent[],
  id: KniffelEventId,
  playerIdx: number,
  detail: string | undefined,
  random: () => number,
): void {
  const rule = ruleFor(state, id)
  if (!rule) return
  const e: KniffelEvent = {
    uid: `${state.rollId}-${id}-${out.length}`,
    id,
    player: state.names[playerIdx],
    playerIdx,
    detail,
  }
  if (rule.target === 'roll') {
    e.targetIdx = Math.floor(random() * state.names.length)
  }
  if (rule.rollCount) e.count = 1 + Math.floor(random() * 6)
  if (rule.tableOn) e.tablePick = 1 + Math.floor(random() * 6)
  out.push(e)
}

function detectEvents(
  state: KniffelState,
  cat: KniffelCategory,
  points: number,
  joker: boolean,
  bonusBefore: boolean,
  random: () => number,
): KniffelEvent[] {
  const dice = state.dice!
  const p = state.active
  const sheet = state.sheets[p]
  const events: KniffelEvent[] = []
  const add = (id: KniffelEventId, detail?: string): void => addEvent(state, events, id, p, detail, random)

  const c = counts(dice)
  if (isFiveSame(dice)) {
    if (joker) add('extraKniffel', `Kniffel Nr. ${sheet.extraKniffels + 1} (+100)`)
    else add('kniffel', dice.join('-'))
  } else if (c.some((n) => n >= 4)) {
    add('fourKindEv', `${c.findIndex((n) => n >= 4)}er-Pasch`)
  } else if (isFullHouse(dice)) {
    add('fullHouseEv', [...dice].sort((a, b) => a - b).join('-'))
  }
  if (!isFiveSame(dice)) {
    if (hasRun(dice, 5)) add('largeStraightEv', [...new Set(dice)].sort((a, b) => a - b).join('-'))
    else if (hasRun(dice, 4)) add('smallStraightEv')
  }
  if (points === 0) add('scratch', `${CATEGORY_META[cat].title} gestrichen`)
  if (!bonusBefore && hasUpperBonus(sheet)) add('upperBonusEv', `${upperSum(sheet)} Punkte oben`)
  return events
}

/**
 * Betroffene Spieler eines Events auflösen (Namen, fürs Banner/Protokoll).
 */
export function eventTargets(state: KniffelState, e: KniffelEvent): string[] {
  const rule = state.houseRules[e.id]
  switch (rule?.target) {
    case 'others':
      return state.names.filter((_, i) => i !== e.playerIdx)
    case 'all':
      return [...state.names]
    case 'roll':
      return e.targetIdx !== undefined ? [state.names[e.targetIdx]] : []
    default:
      return [state.names[e.playerIdx]]
  }
}
