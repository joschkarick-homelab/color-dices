// Kniffel-Spielansicht: Zettel, Würfel-Chips (Halten), Ereignis-Banner mit
// Varianz-Animation und Endstand. Die Shell (main.ts) ruft die Renderer auf
// und leitet Klicks über data-action-Attribute hierher zurück.

import type { DiceTray, DieSpec } from './dice'
import {
  CATEGORY_META,
  KNIFFEL_CATEGORIES,
  KNIFFEL_EVENT_META,
  MAX_ROLLS,
  UPPER_BONUS,
  UPPER_BONUS_THRESHOLD,
  UPPER_CATEGORIES,
  eventTargets,
  filledCount,
  hasUpperBonus,
  jokerActive,
  scoreFor,
  totalScore,
  upperSum,
  type KniffelCategory,
  type KniffelEvent,
  type KniffelHouseRule,
  type KniffelState,
} from './kniffel'

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

const CAT_SHORT: Record<KniffelCategory, string> = {
  ones: '1er',
  twos: '2er',
  threes: '3er',
  fours: '4er',
  fives: '5er',
  sixes: '6er',
  threeKind: '3P',
  fourKind: '4P',
  fullHouse: 'FH',
  smallStraight: 'KS',
  largeStraight: 'GS',
  kniffel: 'KN',
  chance: 'CH',
}

// ---------------------------------------------------------------------------
// UI-Zustand (Auswahl + gezeigte Banner)

let selectedCat: KniffelCategory | null = null
let selectionRollId = -1
let shownEvents = new Set<string>()
let bannerBusy = false

/** Beim ersten Spielstand/Resume: bereits vorhandene Events nicht nachspielen. */
export function resetKniffelUi(preShownUids: string[]): void {
  shownEvents = new Set(preShownUids)
  bannerBusy = false
  selectedCat = null
  selectionRollId = -1
}

export function selectCategory(cat: KniffelCategory | null): void {
  selectedCat = cat
}

export function getSelectedCategory(): KniffelCategory | null {
  return selectedCat
}

// ---------------------------------------------------------------------------
// Würfe

/** Specs für die Wurf-Animation: nur die tatsächlich neu geworfenen Würfel. */
export function kniffelRollSpecs(s: KniffelState): DieSpec[] {
  if (!s.dice) return []
  return s.dice
    .map((value, i): DieSpec & { i: number } => ({ kind: 'white', value, i }))
    .filter((d) => s.rolled[d.i])
    .map(({ kind, value }) => ({ kind, value }))
}

// ---------------------------------------------------------------------------
// Overlay (Würfeln-Button / Status) — der animating-Fall liegt in der Shell

export interface KniffelView {
  myIdx: number
  animating: boolean
  rollRequested: boolean
  isHost: boolean
  peerConnected: boolean
}

export function renderKniffelOverlay(
  el: HTMLElement,
  s: KniffelState,
  v: KniffelView,
  onRoll: () => void,
): void {
  el.style.pointerEvents = ''
  const myTurn = s.active === v.myIdx
  if (s.phase !== 'playing') {
    el.innerHTML = ''
    return
  }
  if (myTurn && s.rollsUsed < MAX_ROLLS) {
    // Alles festgehalten → es gibt nichts zu würfeln; erst freigeben oder eintragen
    if (s.dice && s.rollsUsed >= 1 && s.held.every(Boolean)) {
      el.innerHTML = `<div class="msg bottom">🔒 Alles festgehalten – Würfel freigeben oder eintragen</div>`
      return
    }
    const label =
      s.rollsUsed === 0 ? '🎲 Würfeln' : `🎲 Nochmal würfeln (${s.rollsUsed + 1}/${MAX_ROLLS})`
    el.innerHTML = v.rollRequested
      ? `<div class="msg pulse">Würfeln …</div>`
      : `<button class="roll-btn ${s.rollsUsed > 0 ? 'again' : ''}" id="rollBtn">${label}</button>`
    el.querySelector('#rollBtn')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      onRoll()
    })
  } else if (!myTurn) {
    el.innerHTML = s.dice
      ? `<div class="msg bottom">${esc(s.names[s.active])} · Wurf ${s.rollsUsed}/${MAX_ROLLS}</div>`
      : `<div class="msg pulse">${esc(s.names[s.active])} würfelt …</div>`
  } else {
    el.innerHTML = ''
  }
}

// ---------------------------------------------------------------------------
// Spielfläche

export function renderKniffelDyn(el: HTMLElement, s: KniffelState, v: KniffelView, extraOverlay: string): void {
  const myTurn = s.active === v.myIdx && s.phase === 'playing'
  const sheet = s.sheets[v.myIdx]
  const canChoose = myTurn && s.dice !== null && s.rollsUsed >= 1 && !v.animating
  const joker = s.dice ? jokerActive(s) : false

  // Auswahl zurücksetzen, wenn ein neuer Wurf kam oder der Zug vorbei ist
  if (selectionRollId !== s.rollId || !canChoose) {
    if (selectionRollId !== s.rollId) selectedCat = null
    selectionRollId = s.rollId
  }
  if (selectedCat && sheet.filled[selectedCat] !== undefined) selectedCat = null

  // Statuszeile
  let turnbar = ''
  if (s.phase === 'playing') {
    if (v.animating) turnbar = '🎲 Die Würfel rollen …'
    else if (myTurn) {
      turnbar =
        s.rollsUsed === 0
          ? '✨ Du bist am Zug!'
          : s.rollsUsed < MAX_ROLLS
            ? `Halten & nochmal würfeln – oder eintragen (Wurf ${s.rollsUsed}/${MAX_ROLLS})`
            : 'Wähle eine Kategorie zum Eintragen'
    } else {
      turnbar = `${esc(s.names[s.active])} ist am Zug`
    }
  }

  // Würfel-Chips (Halten)
  let diceRow = ''
  if (s.dice && !v.animating) {
    const canHold = myTurn && s.rollsUsed >= 1 && s.rollsUsed < MAX_ROLLS
    diceRow = `<div class="kdice">${s.dice
      .map((val, i) => {
        const held = s.held[i]
        return `<button class="kdie ${held ? 'held' : ''}" ${
          canHold ? `data-action="kdie" data-i="${i}"` : 'disabled'
        }>${val}${held ? '<span class="klock">🔒</span>' : ''}</button>`
      })
      .join('')}</div>${canHold ? '<div class="khint">Antippen = festhalten · nochmal antippen = wieder freigeben</div>' : ''}`
  }

  // Zettel
  const row = (cat: KniffelCategory): string => {
    const filled = sheet.filled[cat]
    const meta = CATEGORY_META[cat]
    let val: string
    let cls = 'krow'
    let clickable = false
    if (filled !== undefined) {
      cls += ' done'
      val = filled === 0 ? '–' : String(filled)
      if (filled === 0) cls += ' zero'
    } else if (canChoose) {
      const pts = scoreFor(s.dice!, cat, joker)
      val = String(pts)
      cls += pts > 0 ? ' cand' : ' scratchable'
      clickable = true
      if (selectedCat === cat) cls += ' selected'
    } else {
      val = ''
    }
    return `<button class="${cls}" ${clickable ? `data-action="kcat" data-cat="${cat}"` : 'disabled'} title="${esc(meta.hint)}">
      <span class="kname">${esc(meta.title)}</span><span class="kpts">${val}</span>
    </button>`
  }
  const upper = UPPER_CATEGORIES.map(row).join('')
  const lower = KNIFFEL_CATEGORIES.filter((c) => !UPPER_CATEGORIES.includes(c)).map(row).join('')
  const us = upperSum(sheet)
  const bonusRow = `<div class="krow bonusrow"><span class="kname">Bonus (ab ${UPPER_BONUS_THRESHOLD})</span><span class="kpts">${
    hasUpperBonus(sheet) ? `+${UPPER_BONUS} 🎉` : `${us}/${UPPER_BONUS_THRESHOLD}`
  }</span></div>`
  const extra = sheet.extraKniffels
    ? `<div class="krow bonusrow"><span class="kname">Zusatz-Kniffel</span><span class="kpts">+${sheet.extraKniffels * 100} 🎊</span></div>`
    : ''

  // Bestätigen
  let actions = ''
  if (canChoose && selectedCat) {
    const pts = scoreFor(s.dice!, selectedCat, joker)
    const label =
      pts > 0
        ? `✅ ${CATEGORY_META[selectedCat].title} eintragen (${pts} Punkte)`
        : `❌ ${CATEGORY_META[selectedCat].title} streichen (0)`
    actions = `<div class="actions"><button class="btn ${pts > 0 ? 'primary' : 'danger'}" data-action="kconfirm">${label}</button></div>`
  } else if (canChoose) {
    actions = `<div class="waiting">Tippe eine Kategorie an${s.rollsUsed < MAX_ROLLS ? ' – oder würfle nochmal' : ''}</div>`
  }

  // Mitspieler
  const others = s.names
    .map((_, i) => i)
    .filter((i) => i !== v.myIdx)
    .map((i) => {
      const sh = s.sheets[i]
      const badges = i === s.active && s.phase === 'playing' ? '🎲' : ''
      const cells = KNIFFEL_CATEGORIES.map((c) => {
        const f = sh.filled[c]
        return `<span class="kmini ${f === undefined ? 'open' : ''}">${CAT_SHORT[c]}<b>${
          f === undefined ? '·' : f === 0 ? '–' : f
        }</b></span>`
      }).join('')
      return `
      <div class="opp-summary">
        <div class="head">
          <span>👤 ${esc(s.names[i])} ${badges}</span>
          <span class="score">${totalScore(sh)} Punkte · ${filledCount(sh)}/13</span>
        </div>
        <div class="kmini-grid">${cells}</div>
        <div class="opp-rows">Oben: ${upperSum(sh)}/${UPPER_BONUS_THRESHOLD}${hasUpperBonus(sh) ? ' ✅ Bonus' : ''}${sh.extraKniffels ? ` · 🎊 ×${sh.extraKniffels}` : ''}</div>
      </div>`
    })
    .join('')

  el.innerHTML = `
    <div class="turnbar">${turnbar}</div>
    ${diceRow}
    <div class="ksheet">
      <div class="ksec"><div class="khead">Oben</div>${upper}${bonusRow}</div>
      <div class="ksec"><div class="khead">Unten</div>${lower}${extra}</div>
    </div>
    <div class="bottom-panel">
      <div class="khint" style="margin:0">Runde ${s.round}/13</div>
      <div class="score-chip">${totalScore(sheet)} Punkte</div>
    </div>
    ${actions}
    ${others ? `<div class="opp-title">Mitspieler</div>${others}` : ''}
    ${s.phase === 'ended' ? renderKniffelGameOver(s, v) : ''}
    ${extraOverlay}
  `
}

function renderKniffelGameOver(s: KniffelState, v: KniffelView): string {
  const solo = s.names.length === 1
  const order = s.names.map((_, i) => i).sort((a, b) => totalScore(s.sheets[b]) - totalScore(s.sheets[a]))
  const rows = order
    .map((i, rank) => {
      const sh = s.sheets[i]
      return `
      <div class="rank-item ${i === v.myIdx ? 'me' : ''}">
        <div class="rank-head">
          <span class="place">${solo ? '🏁' : rank === 0 ? '🏆' : `${rank + 1}.`}</span>
          <span class="pname">${esc(s.names[i])}${i === v.myIdx ? ' (du)' : ''}</span>
          <span class="pts">${totalScore(sh)} Punkte</span>
        </div>
        <div class="rank-detail">
          <span>Oben ${upperSum(sh)}${hasUpperBonus(sh) ? ` +${UPPER_BONUS}` : ''}</span>
          <span>Kniffel ${sh.filled.kniffel ?? 0}${sh.extraKniffels ? ` +${sh.extraKniffels * 100}` : ''}</span>
        </div>
      </div>`
    })
    .join('')
  const winnerText = solo
    ? `🏁 Fertig! ${totalScore(s.sheets[0])} Punkte`
    : s.winner === -1
      ? '🤝 Unentschieden!'
      : `🏆 ${esc(s.names[s.winner!])} gewinnt!`
  return `
    <div class="banner-backdrop" style="z-index:40">
      <div class="banner" style="max-height:85dvh;overflow-y:auto">
        <div class="emoji">${solo ? '🏁' : s.winner === v.myIdx ? '🎉' : s.winner === -1 ? '🤝' : '😅'}</div>
        <h2>${winnerText}</h2>
        <div class="ranking">${rows}</div>
        ${
          v.isHost
            ? `<button class="btn primary" data-action="rematch">🔄 Revanche</button>`
            : `<p class="subtitle pulse">Revanche startet ${esc(s.names[0])} …</p>`
        }
        <div style="height:8px"></div>
        <button class="btn" data-action="leave">Spiel verlassen</button>
      </div>
    </div>`
}

// ---------------------------------------------------------------------------
// Hausregel-Übersicht (📜 im Spiel)

export function kniffelRulesOverlayHtml(s: KniffelState): string {
  const ids = Object.keys(KNIFFEL_EVENT_META) as (keyof typeof KNIFFEL_EVENT_META)[]
  const items = ids
    .filter((id) => s.houseRules[id]?.enabled)
    .map((id) => {
      const meta = KNIFFEL_EVENT_META[id]
      const r = s.houseRules[id]
      const targetLabel =
        r.target === 'self' ? 'Auslöser' : r.target === 'others' ? 'Alle anderen' : r.target === 'all' ? 'Alle' : '🎲 wird ausgewürfelt'
      const table = r.tableOn
        ? `<p style="margin:6px 0 0;font-size:0.8rem;color:var(--muted)">🎲 Tabelle: ${r.table
            .map((t, i) => `${i + 1}=${esc(t || '—')}`)
            .join(' · ')}</p>`
        : ''
      return `<div class="rule-item" style="text-align:left">
        <div class="rule-head"><span>${meta.emoji}</span><span class="title">${esc(meta.title)}<span class="hint">${esc(meta.hint)}</span></span></div>
        <p style="margin:8px 0 0;font-size:0.95rem">${esc(targetLabel)} → ${esc(r.text)}</p>
        ${r.rollCount ? `<p style="margin:6px 0 0;font-size:0.8rem;color:var(--muted)">🎲 Anzahl (1–6) wird ausgewürfelt</p>` : ''}
        ${table}
      </div>`
    })
    .join('')
  return items || '<p class="subtitle">Keine Hausregeln aktiv.</p>'
}

// ---------------------------------------------------------------------------
// Ereignis-Banner mit Varianz-Animation

export interface KniffelBannerCtx {
  tray: DiceTray | null
  getAnimating(): boolean
  setAnimating(b: boolean): void
  render(): void
}

function varianceSpecs(s: KniffelState, e: KniffelEvent): DieSpec[] {
  const specs: DieSpec[] = []
  if (e.targetIdx !== undefined && s.names.length <= 6) {
    specs.push({ kind: 'blue', value: e.targetIdx + 1 })
  }
  if (e.count) specs.push({ kind: 'red', value: e.count })
  if (e.tablePick) specs.push({ kind: 'yellow', value: e.tablePick })
  return specs
}

export function queueKniffelBanners(s: KniffelState, ctx: KniffelBannerCtx): void {
  if (bannerBusy) return
  if (!s.events.some((e) => !shownEvents.has(e.uid))) return
  void processBannerQueue(s, ctx)
}

async function processBannerQueue(s: KniffelState, ctx: KniffelBannerCtx): Promise<void> {
  bannerBusy = true
  try {
    for (;;) {
      const e = s.events.find((ev) => !shownEvents.has(ev.uid))
      if (!e) break
      shownEvents.add(e.uid)
      const rule = s.houseRules[e.id]
      // Läuft noch eine Wurf-Animation? Kurz warten.
      while (ctx.getAnimating()) await new Promise((r) => setTimeout(r, 200))
      const specs = varianceSpecs(s, e)
      if (specs.length && ctx.tray) {
        ctx.setAnimating(true)
        ctx.render()
        try {
          await ctx.tray.roll(specs)
        } finally {
          ctx.setAnimating(false)
        }
        ctx.render()
      }
      await showKniffelBanner(s, e, rule)
    }
  } finally {
    bannerBusy = false
    ctx.render()
  }
}

/**
 * Banner: Auslöser → Betroffene → Aktion, jede ausgewürfelte Stufe mit dem
 * passenden Würfel-Chip. Schließt nur per Tippen — niemand verpasst etwas.
 */
function showKniffelBanner(s: KniffelState, e: KniffelEvent, rule: KniffelHouseRule | undefined): Promise<void> {
  return new Promise((resolve) => {
    const meta = KNIFFEL_EVENT_META[e.id]
    const targets = eventTargets(s, e)
    const targetLabel =
      rule?.target === 'others'
        ? `Alle außer ${e.player}`
        : rule?.target === 'all'
          ? 'Alle'
          : targets.join(' & ')
    const lines: string[] = []
    if (e.targetIdx !== undefined) {
      const chip = s.names.length <= 6 ? `<span class="die-chip sm blue">${e.targetIdx + 1}</span>` : '🎲'
      lines.push(`<div class="kv-line">${chip} Ausgewürfelt: <b>${esc(s.names[e.targetIdx])}</b></div>`)
    }
    if (e.tablePick) {
      const entry = rule?.table[e.tablePick - 1]?.trim()
      lines.push(
        `<div class="kv-line"><span class="die-chip sm yellow">${e.tablePick}</span> ${
          entry ? `Tabelle: <b>„${esc(entry)}"</b>` : 'Tabelle: Feld leer – Glück gehabt! 🍀'
        }</div>`,
      )
    }
    if (e.count) {
      lines.push(`<div class="kv-line"><span class="die-chip sm red">${e.count}</span> Anzahl: <b>${e.count}×</b></div>`)
    }
    const action = rule?.text
      ? `<div class="ruletext">${esc(targetLabel)} ${esc(rule.text)}</div>`
      : ''
    const el = document.createElement('div')
    el.className = 'banner-backdrop'
    el.innerHTML = `
      <div class="banner">
        <div class="emoji">${meta.emoji}</div>
        <h2>${esc(meta.title)}!</h2>
        <p class="who">${esc(e.player)}${e.detail ? ` · ${esc(e.detail)}` : ''}</p>
        ${action}
        ${lines.join('')}
        <div class="tap-hint">Tippen zum Schließen</div>
      </div>`
    document.body.appendChild(el)
    el.addEventListener('click', () => {
      el.remove()
      resolve()
    })
  })
}
