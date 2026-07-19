// Persistenz für Hausregel-Vorlagen.
//
// Die API ist bewusst async und jede Vorlage trägt ein `owner`-Feld:
// Aktuell speichert `LocalPresetStore` global im localStorage des Geräts
// (owner = null). Später kann ein Backend-Store mit Nutzerkonten dieselbe
// Schnittstelle implementieren (owner = User-ID), ohne dass sich an der
// Setup-UI etwas ändert.

export type GameId = 'qwixx' | 'kniffel'

export interface RulePreset<T = unknown> {
  id: string
  name: string
  game: GameId
  owner: string | null // null = global/geräteweit; später: User-ID
  updatedAt: number
  rules: T
}

export interface PresetStore {
  list(game: GameId): Promise<RulePreset[]>
  save(preset: RulePreset): Promise<void>
  remove(id: string): Promise<void>
}

const STORAGE_KEY = 'dice.rulepresets'

class LocalPresetStore implements PresetStore {
  private load(): RulePreset[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? (JSON.parse(raw) as RulePreset[]) : []
    } catch {
      return []
    }
  }

  private persist(presets: RulePreset[]): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets))
  }

  list(game: GameId): Promise<RulePreset[]> {
    return Promise.resolve(
      this.load()
        .filter((p) => p.game === game)
        .sort((a, b) => a.name.localeCompare(b.name)),
    )
  }

  save(preset: RulePreset): Promise<void> {
    const presets = this.load().filter((p) => p.id !== preset.id)
    presets.push(preset)
    this.persist(presets)
    return Promise.resolve()
  }

  remove(id: string): Promise<void> {
    this.persist(this.load().filter((p) => p.id !== id))
    return Promise.resolve()
  }
}

export const presetStore: PresetStore = new LocalPresetStore()

export function newPresetId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
