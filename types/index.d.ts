export type KindId = 'emails' | 'images' | 'documents' | 'coding' | 'research' | 'other'

export type TabId = 'today' | 'week' | 'month' | 'year'

/** One calendar day: how many tasks of each kind, per model, and per project. */
export type DayRecord = {
  kinds: Partial<Record<KindId, number>>
  models: Record<string, number>
  projects?: Record<string, number>
}

/** The estimate's inputs: minutes saved per task of each kind, and the hourly rate. */
export type Settings = {
  rate: number
  minutes: Record<KindId, number>
}

declare module 'claude-code' {
  interface PluginState {
    'work-report': {
      tab: TabId
      days: Shaped<Record<string, DayRecord>>
      settings: Shaped<Settings>
    }
  }
}
