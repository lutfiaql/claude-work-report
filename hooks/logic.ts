// Pure logic of the work report: sorting, dates, sums and the big numerals.
// Nothing here touches `$`, so the tests call it directly.

import type { DayRecord, KindId, Settings, TabId } from '../types'

export const GOLD = '#F2C46D'
export const HAIRLINE = '#262B33'
export const MUTED = '#7D8590'
export const TEXT = '#E6EDF3'
export const GREEN = '#3DD68C'
export const AMBER = '#E3B341'
export const DARK = '#0D1117'
export const BAR = '#6CB6FF'

export const KINDS: ReadonlyArray<{ id: KindId; label: string; color: string; names: string[] }> = [
  { id: 'emails', label: 'Emails', color: '#6CB6FF', names: ['emails', 'email', 'mail'] },
  { id: 'documents', label: 'Documents', color: '#E0A96D', names: ['documents', 'document', 'docs', 'doc'] },
  { id: 'images', label: 'Images and video', color: '#C297FF', names: ['images', 'image', 'video', 'media'] },
  { id: 'coding', label: 'Coding', color: '#FF8F7A', names: ['coding', 'code'] },
  { id: 'research', label: 'Research', color: '#56D4DD', names: ['research'] },
  { id: 'other', label: 'Other', color: '#8B949E', names: ['other'] },
]

export const DEFAULT_SETTINGS: Settings = {
  rate: 50,
  minutes: { emails: 10, documents: 30, images: 20, coding: 20, research: 25, other: 10 },
}

export const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
]

// ---------------------------------------------------------------- sorting

/** One tool call of a task, as much of it as sorting needs. */
export type ToolUse = { tool: string; skill?: string; file?: string }

const MEDIA_FILE = /\.(png|jpe?g|gif|webp|svg|heic|bmp|tiff?|mp4|mov|webm|mkv|avi|m4v)$/i
const DOC_FILE = /\.(docx?|pptx?|xlsx?|csv|pdf|md|markdown|txt|rtf|odt|ods|odp|pages|key|numbers)$/i
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const CODE_SEARCH = new Set(['Grep', 'Glob', 'ToolSearch', 'SearchPlugins', 'SearchSkills', 'ListSkills', 'ListPlugins'])

function shortName(tool: string): string {
  const parts = tool.split('__')
  return parts[parts.length - 1] ?? tool
}

function isEmail(use: ToolUse): boolean {
  const name = use.tool.toLowerCase()
  if (/gmail|outlook|e-?mail|mailbox|inbox|(^|[_-])mail([_-]|$)/.test(name)) return true
  // A mail server behind an opaque id still names its tools after mail.
  return name.startsWith('mcp__') && /draft|thread|spam|(^|_)label(_|$)|mark_message/.test(shortName(name))
}

function isMedia(use: ToolUse): boolean {
  const name = `${use.tool} ${use.skill ?? ''}`.toLowerCase()
  if (/screenshot/.test(name)) return false
  if (/image|video|photo|picture|(^|_)gif|dall-?e|imagen|midjourney|stable.?diffusion|(^|_)veo|sora|animation/.test(name)) return true
  return use.file !== undefined && WRITES.has(use.tool) && MEDIA_FILE.test(use.file)
}

function isDocument(use: ToolUse): boolean {
  const name = `${use.tool} ${use.skill ?? ''}`.toLowerCase()
  if (/(^|[^a-z])(docs?|docx|pptx?|xlsx?|pdf|slides?|sheets?|spreadsheet|excel|powerpoint|presentation|deck|word|notion|confluence|artifact)([^a-z]|$)/.test(name)) return true
  if (/document|spreadsheet|slide|confluencepage/.test(name)) return true
  return use.file !== undefined && WRITES.has(use.tool) && DOC_FILE.test(use.file)
}

function isCoding(use: ToolUse): boolean {
  return WRITES.has(use.tool) || use.tool === 'Bash' || use.tool === 'PowerShell'
}

function isResearch(use: ToolUse): boolean {
  if (CODE_SEARCH.has(use.tool)) return false
  if (use.tool === 'WebSearch' || use.tool === 'WebFetch') return true
  const name = use.tool.toLowerCase()
  return /web_?search|web_?fetch|(^|_)fetch|get_page_text|read_page|navigate|browse|transcript|youtube|(^|_)search(_|$)|deep-research/.test(
    `${name} ${(use.skill ?? '').toLowerCase()}`,
  )
}

/**
 * Sorts a task into one kind by the tools it used. When a task touches several
 * kinds the first in this order wins: Emails, Images and video, Documents,
 * Coding, Research, Other.
 */
export function classify(uses: readonly ToolUse[]): KindId {
  if (uses.some(isEmail)) return 'emails'
  if (uses.some(isMedia)) return 'images'
  if (uses.some(isDocument)) return 'documents'
  if (uses.some(isCoding)) return 'coding'
  if (uses.some(isResearch)) return 'research'
  return 'other'
}

/** Reads what sorting needs from a tool call's input. */
export function toolUseOf(e: { tool: string; [k: string]: unknown }): ToolUse {
  const use: ToolUse = { tool: String(e.tool) }
  const skill = e.skill
  if (typeof skill === 'string') use.skill = skill
  for (const field of ['file_path', 'notebook_path', 'path']) {
    const v = e[field]
    if (typeof v === 'string') {
      use.file = v
      break
    }
  }
  return use
}

/** Prompt origins that are machinery, not a person typing a request. */
const AUTOMATED = new Set([
  'task-notification',
  'scheduled-trigger',
  'peer',
  'peer-send-message',
  'projects-relay',
  'channel',
  'coordinator',
  'observer',
  'observer-activity',
  'auto-continuation',
  'slack-ping',
  'plugin',
])

/**
 * Whether a prompt's origin is a person typing. Everything but known machinery
 * counts: the desktop app's prompts arrive as `unclassified` or `sdk`, the
 * terminal's as `composer`, a phone's as `bridge`.
 */
export function isTypedOrigin(kind: string): boolean {
  return !AUTOMATED.has(kind)
}

// ---------------------------------------------------------------- dates

const pad = (n: number) => String(n).padStart(2, '0')

/** The local calendar day of a moment, as `YYYY-MM-DD`. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local noon of a day key: the moment every date step lands on. */
export function noonOf(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0)
}

/** The day key `n` days after `key` (negative for before), stepped at local noon. */
export function addDays(key: string, n: number): string {
  const noon = noonOf(key)
  return dayKey(new Date(noon.getFullYear(), noon.getMonth(), noon.getDate() + n, 12).getTime())
}

/** 1 for January 1, 365 or 366 for December 31. */
export function dayOfYear(key: string): number {
  const noon = noonOf(key)
  const jan1 = new Date(noon.getFullYear(), 0, 1, 12)
  return Math.round((noon.getTime() - jan1.getTime()) / 86_400_000) + 1
}

/** The day keys a tab covers, oldest first, ending today. */
export function rangeKeys(tab: TabId, today: string): string[] {
  const count = tab === 'today' ? 1 : tab === 'week' ? 7 : tab === 'month' ? 30 : dayOfYear(today)
  const keys: string[] = []
  for (let i = count - 1; i >= 0; i--) keys.push(addDays(today, -i))
  return keys
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function weekdayOf(key: string): string {
  return WEEKDAYS[noonOf(key).getDay()] ?? ''
}

export function shortDate(key: string): string {
  const d = noonOf(key)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** The dates on the right of the title bar. */
export function rangeLabel(tab: TabId, today: string): string {
  const keys = rangeKeys(tab, today)
  const first = keys[0] ?? today
  const year = noonOf(today).getFullYear()
  if (tab === 'today') return `${weekdayOf(today)} ${shortDate(today)}, ${year}`
  return `${shortDate(first)} – ${shortDate(today)}, ${year}`
}

/** The stretch just before a tab's: yesterday, the 7 or 30 days before, or last year to the same day. */
export function previousKeys(tab: TabId, today: string): string[] {
  if (tab === 'year') {
    const d = noonOf(today)
    const sameDay = new Date(d.getFullYear() - 1, d.getMonth(), Math.min(d.getDate(), 28), 12)
    return rangeKeys('year', dayKey(sameDay.getTime()))
  }
  const keys = rangeKeys(tab, today)
  return rangeKeys(tab, addDays(today, -keys.length))
}

/** What the previous stretch is called beside a change. */
export const PREVIOUS_LABEL: Record<TabId, string> = {
  today: 'vs yesterday',
  week: 'vs previous 7 days',
  month: 'vs previous 30 days',
  year: 'vs last year',
}

/** The change from `before` to `now` as a signed whole percent, or null when there was nothing before. */
export function changePercent(now: number, before: number): number | null {
  if (before <= 0) return null
  return Math.round(((now - before) / before) * 100)
}

/** `+24%`, `-8%`, `same`. */
export function formatChange(change: number): string {
  if (change === 0) return 'same'
  return `${change > 0 ? '+' : '−'}${Math.abs(change)}%`
}

/** A project's display name from a working directory. */
export function projectName(cwd: string | undefined): string {
  if (!cwd) return 'Unknown'
  if (cwd.includes('/scratch-workspaces/') || cwd.includes('\\scratch-workspaces\\')) return 'No folder'
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  const base = parts[parts.length - 1] ?? cwd
  // A folder named for what it holds (files, src) reads better with its parent.
  if (GENERIC_FOLDERS.has(base.toLowerCase()) && parts.length >= 2) return `${parts[parts.length - 2]}/${base}`
  return base
}

const GENERIC_FOLDERS = new Set(['files', 'src', 'app', 'apps', 'code', 'repo', 'project', 'projects', 'workspace', 'main', 'dev', 'site', 'web'])

// ---------------------------------------------------------------- sums

export type Sum = {
  total: number
  kinds: Record<KindId, number>
  models: Record<string, number>
  projects: Record<string, number>
  /** Milliseconds Claude spent working on these tasks (measured, not estimated). */
  ms: number
  /** Tasks by the local hour they started, midnight first. */
  hours: number[]
}

export function emptySum(): Sum {
  return {
    total: 0,
    kinds: { emails: 0, documents: 0, images: 0, coding: 0, research: 0, other: 0 },
    models: {},
    projects: {},
    ms: 0,
    hours: new Array<number>(24).fill(0),
  }
}

export function dayTotal(day: DayRecord | undefined): number {
  if (!day) return 0
  let n = 0
  for (const k of KINDS) n += day.kinds[k.id] ?? 0
  return n
}

/** Adds the given days together. */
export function sumDays(days: Readonly<Record<string, DayRecord>>, keys: readonly string[]): Sum {
  const sum = emptySum()
  for (const key of keys) {
    const day = days[key]
    if (!day) continue
    for (const k of KINDS) {
      const n = day.kinds[k.id] ?? 0
      sum.kinds[k.id] += n
      sum.total += n
    }
    for (const [model, n] of Object.entries(day.models)) sum.models[model] = (sum.models[model] ?? 0) + n
    for (const [project, n] of Object.entries(day.projects ?? {})) sum.projects[project] = (sum.projects[project] ?? 0) + n
    sum.ms += day.ms ?? 0
    day.hours?.forEach((n, hour) => {
      if (hour < 24) sum.hours[hour] = (sum.hours[hour] ?? 0) + n
    })
  }
  return sum
}

/** One finished task added to a day's record. */
export type TaskExtra = {
  /** How long Claude worked on it, in milliseconds. */
  ms?: number
  /** The local hour it started, 0 to 23. */
  hour?: number
}

/** The longest Claude may have worked on one task: anything longer is a session left open. */
export const MAX_TASK_MS = 4 * 60 * 60 * 1000

export function addTask(day: DayRecord | undefined, kind: KindId, model: string, project?: string, extra: TaskExtra = {}): DayRecord {
  const base: DayRecord = day ?? { kinds: {}, models: {} }
  const next: DayRecord = {
    kinds: { ...base.kinds, [kind]: (base.kinds[kind] ?? 0) + 1 },
    models: { ...base.models, [model]: (base.models[model] ?? 0) + 1 },
  }
  if (project !== undefined || base.projects !== undefined) {
    next.projects = { ...(base.projects ?? {}) }
    if (project !== undefined) next.projects[project] = (next.projects[project] ?? 0) + 1
  }
  const ms = extra.ms !== undefined && extra.ms > 0 ? Math.min(MAX_TASK_MS, Math.round(extra.ms)) : 0
  if (ms > 0 || base.ms !== undefined) next.ms = (base.ms ?? 0) + ms
  if (extra.hour !== undefined || base.hours !== undefined) {
    const hours = base.hours ? [...base.hours] : new Array<number>(24).fill(0)
    if (extra.hour !== undefined && extra.hour >= 0 && extra.hour < 24) hours[extra.hour] = (hours[extra.hour] ?? 0) + 1
    next.hours = hours
  }
  return next
}

/** The most days in a row with a task, in all the days given. */
export function longestStreak(days: Readonly<Record<string, DayRecord>>): number {
  const active = Object.keys(days)
    .filter(k => dayTotal(days[k]) > 0)
    .sort()
  let best = 0
  let run = 0
  let previous = ''
  for (const key of active) {
    run = previous !== '' && addDays(previous, 1) === key ? run + 1 : 1
    best = Math.max(best, run)
    previous = key
  }
  return best
}

/** The busiest two-hour window of the day, as `3 pm – 5 pm`, or null with no tasks. */
export function peakWindow(hours: readonly number[]): { start: number; label: string } | null {
  let best = -1
  let start = 0
  for (let hour = 0; hour < 24; hour++) {
    const n = (hours[hour] ?? 0) + (hours[(hour + 1) % 24] ?? 0)
    // On a tie, the window that starts on the busier hour.
    if (n > best || (n === best && (hours[hour] ?? 0) > (hours[start] ?? 0))) {
      best = n
      start = hour
    }
  }
  if (best <= 0) return null
  return { start, label: `${clockHour(start)} – ${clockHour((start + 2) % 24)}` }
}

/** 0 reads `12 am`, 15 reads `3 pm`. */
export function clockHour(hour: number): string {
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve} ${hour < 12 ? 'am' : 'pm'}`
}

/** A measured duration: `45 min`, `3.2 h`, `18 h`. */
export function formatDuration(ms: number): string {
  const minutes = ms / 60000
  if (minutes < 1) return ms > 0 ? '<1 min' : '0 min'
  if (minutes < 60) return `${Math.round(minutes)} min`
  return `${formatHours(minutes)} h`
}

/** Estimated time saved over Claude's measured working time, as `4.4×`, or null when either is zero. */
export function leverage(savedMinutes: number, workedMs: number): string | null {
  if (savedMinutes <= 0 || workedMs < 60000) return null
  const ratio = savedMinutes / (workedMs / 60000)
  return `${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}×`
}

/** Every day in `keys` as CSV: date, tasks per kind, total, minutes saved (estimate), Claude's minutes. */
export function csvOf(days: Readonly<Record<string, DayRecord>>, keys: readonly string[], settings: Settings): string {
  const header = ['date', ...KINDS.map(k => k.id), 'tasks', 'minutes_saved_estimate', 'value_estimate', 'claude_minutes']
  const lines = [header.join(',')]
  for (const key of keys) {
    const day = days[key]
    const total = dayTotal(day)
    if (total === 0) continue
    const sum = sumDays(days, [key])
    const minutes = minutesOf(sum, settings)
    lines.push(
      [
        key,
        ...KINDS.map(k => String(sum.kinds[k.id])),
        String(total),
        String(Math.round(minutes)),
        ((minutes / 60) * settings.rate).toFixed(2),
        String(Math.round(sum.ms / 60000)),
      ].join(','),
    )
  }
  return lines.join('\n')
}

/** Every day of the year `today` falls in, January 1 first, with its task count (null past today). */
export function yearDays(days: Readonly<Record<string, DayRecord>>, today: string): Array<{ key: string; total: number | null }> {
  const year = noonOf(today).getFullYear()
  const out: Array<{ key: string; total: number | null }> = []
  let key = `${year}-01-01`
  while (noonOf(key).getFullYear() === year) {
    out.push({ key, total: key > today ? null : dayTotal(days[key]) })
    key = addDays(key, 1)
  }
  return out
}

export function minutesOf(sum: Sum, settings: Settings): number {
  let m = 0
  for (const k of KINDS) m += sum.kinds[k.id] * (settings.minutes[k.id] ?? 0)
  return m
}

/** Days in a row with at least one task, ending today (or yesterday while today has none yet). */
export function streak(days: Readonly<Record<string, DayRecord>>, today: string): number {
  let key = dayTotal(days[today]) > 0 ? today : addDays(today, -1)
  let n = 0
  while (dayTotal(days[key]) > 0 && n < 3660) {
    n += 1
    key = addDays(key, -1)
  }
  return n
}

export function activeDays(days: Readonly<Record<string, DayRecord>>, keys: readonly string[]): number {
  return keys.filter(k => dayTotal(days[k]) > 0).length
}

export function bestDay(days: Readonly<Record<string, DayRecord>>, keys: readonly string[]): { key: string; total: number } | null {
  let best: { key: string; total: number } | null = null
  for (const key of keys) {
    const total = dayTotal(days[key])
    if (total > 0 && (best === null || total > best.total)) best = { key, total }
  }
  return best
}

/** Tasks per calendar month of the year `today` falls in, January first. */
export function monthTotals(days: Readonly<Record<string, DayRecord>>, today: string): number[] {
  const year = noonOf(today).getFullYear()
  const totals = new Array<number>(12).fill(0)
  for (const [key, day] of Object.entries(days)) {
    const d = noonOf(key)
    if (d.getFullYear() !== year) continue
    totals[d.getMonth()] = (totals[d.getMonth()] ?? 0) + dayTotal(day)
  }
  return totals
}

export function monthName(index: number): string {
  return MONTHS[index] ?? ''
}

// ---------------------------------------------------------------- chart

export type Chart = {
  values: number[]
  labels: string[]
  /** The bar drawn in gold. */
  current: number
  /** Bars past today: drawn empty. */
  future: boolean[]
}

export function chartFor(tab: TabId, days: Readonly<Record<string, DayRecord>>, today: string): Chart {
  if (tab === 'year') {
    const values = monthTotals(days, today)
    const current = noonOf(today).getMonth()
    return {
      values,
      labels: MONTHS.map(m => m.slice(0, 1)),
      current,
      future: values.map((_, i) => i > current),
    }
  }
  const keys = rangeKeys(tab === 'month' ? 'month' : 'week', today)
  return {
    values: keys.map(k => dayTotal(days[k])),
    labels: keys.map(k => (tab === 'month' ? String(noonOf(k).getDate()) : weekdayOf(k).slice(0, 2))),
    current: keys.length - 1,
    future: keys.map(() => false),
  }
}

const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** The glyph of one bar in one of `rows` rows (row 0 the top). */
export function barCell(value: number, max: number, row: number, rows: number): string {
  if (max <= 0 || value <= 0) return row === rows - 1 ? '▁' : ' '
  const eighths = Math.max(1, Math.round((value / max) * rows * 8))
  const fromBottom = rows - 1 - row
  const filled = eighths - fromBottom * 8
  if (filled >= 8) return '█'
  if (filled <= 0) return ' '
  return EIGHTHS[filled] ?? ' '
}

/** A horizontal bar `width` cells wide, `value / max` of it filled, in eighths. */
export function hbar(value: number, max: number, width: number): string {
  if (width <= 0) return ''
  if (max <= 0 || value <= 0) return ''
  const eighths = Math.max(1, Math.round((value / max) * width * 8))
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  const PARTS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
  return '█'.repeat(full) + (PARTS[part] ?? '')
}

// ---------------------------------------------------------------- numbers

export function formatHours(minutes: number): string {
  const hours = minutes / 60
  if (hours === 0) return '0'
  if (hours < 10) return (Math.round(hours * 10) / 10).toFixed(1).replace(/\.0$/, '')
  return String(Math.round(hours))
}

export function formatMoney(minutes: number, rate: number): string {
  const dollars = Math.round((minutes / 60) * rate)
  return `$${withCommas(dollars)}`
}

/** 12345 reads 12,345 (no Intl needed). */
export function withCommas(n: number): string {
  const digits = String(Math.abs(Math.round(n)))
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return (n < 0 ? '-' : '') + out
}

const GLYPHS: Record<string, [string, string, string]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
  '.': [' ', ' ', '╻'],
  ',': [' ', ' ', '┛'],
  '$': ['┏╋╸', '┗╋┓', '╺╋┛'],
}

/** A number drawn three rows tall in heavy box-drawing lines, or null when a character has no glyph. */
export function bigText(text: string): [string, string, string] | null {
  const rows: [string, string, string] = ['', '', '']
  const chars = [...text]
  for (let i = 0; i < chars.length; i++) {
    const g = GLYPHS[chars[i] ?? '']
    if (!g) return null
    const gap = i === chars.length - 1 ? '' : ' '
    rows[0] += g[0] + gap
    rows[1] += g[1] + gap
    rows[2] += g[2] + gap
  }
  return rows
}

export function textWidth(text: string): number {
  return [...text].length
}

/** `claude-opus-5-5` reads `Opus 5.5`; an id it does not know is kept. */
export function prettyModel(id: string): string {
  if (id === 'unknown' || id === '') return 'Model not recorded'
  const m = /^(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/i.exec(id)
  if (!m) return id
  const family = (m[1] ?? '').charAt(0).toUpperCase() + (m[1] ?? '').slice(1)
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

export function fit(text: string, width: number): string {
  const chars = [...text]
  if (chars.length <= width) return text + ' '.repeat(width - chars.length)
  if (width <= 1) return chars.slice(0, width).join('')
  return chars.slice(0, width - 1).join('') + '…'
}

// ---------------------------------------------------------------- settings command

export function settingsText(settings: Settings): string {
  const lines = [
    'Work report settings (used for the estimates):',
    `  rate        $${settings.rate} per hour`,
    ...KINDS.map(k => `  ${fit(k.names[0] ?? k.id, 11)} ${settings.minutes[k.id]} minutes per task (${k.label})`),
    '',
    'Change one with /report settings rate 75 or /report settings emails 15.',
  ]
  return lines.join('\n')
}

/** Reads `/report settings ...`: the new settings when they change, and what to say. */
export function applySettings(args: string, settings: Settings): { settings?: Settings; text: string } {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { text: settingsText(settings) }
  const [name = '', raw = ''] = words
  const value = Number(raw)
  const lower = name.toLowerCase()
  if (raw === '' || !Number.isFinite(value) || words.length > 2) {
    return { text: `Give one name and one number, for example /report settings rate 75.` }
  }
  if (lower === 'rate') {
    if (value <= 0 || value > 100_000) return { text: 'The rate must be a number above 0 and at most 100000.' }
    const next = { ...settings, rate: Math.round(value * 100) / 100 }
    return { settings: next, text: `Hourly rate set to $${next.rate}. Estimates now use it.` }
  }
  const kind = KINDS.find(k => k.names.includes(lower))
  if (!kind) {
    return { text: `I don't know "${name}". Use rate, emails, documents, images, research or other.` }
  }
  if (value < 0 || value > 1440) return { text: 'Minutes must be between 0 and 1440.' }
  const minutes = Math.round(value * 10) / 10
  const next = { ...settings, minutes: { ...settings.minutes, [kind.id]: minutes } }
  return { settings: next, text: `${kind.label} now count ${minutes} minutes saved per task.` }
}

/** Settings read back from the store, with anything missing or wrong filled from the defaults. */
export function cleanSettings(raw: unknown): Settings {
  const out: Settings = { rate: DEFAULT_SETTINGS.rate, minutes: { ...DEFAULT_SETTINGS.minutes } }
  if (raw === null || typeof raw !== 'object') return out
  const r = raw as { rate?: unknown; minutes?: Record<string, unknown> }
  if (typeof r.rate === 'number' && r.rate > 0) out.rate = r.rate
  if (r.minutes && typeof r.minutes === 'object') {
    for (const k of KINDS) {
      const v = r.minutes[k.id]
      if (typeof v === 'number' && v >= 0) out.minutes[k.id] = v
    }
  }
  return out
}

/** A day record read back from the store, or null when it is not one. */
export function cleanDay(raw: unknown): DayRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as { kinds?: Record<string, unknown>; models?: Record<string, unknown>; projects?: Record<string, unknown> }
  const day: DayRecord = { kinds: {}, models: {} }
  for (const k of KINDS) {
    const v = r.kinds?.[k.id]
    if (typeof v === 'number' && v > 0) day.kinds[k.id] = v
  }
  for (const [m, v] of Object.entries(r.models ?? {})) if (typeof v === 'number' && v > 0) day.models[m] = v
  if (r.projects && typeof r.projects === 'object') {
    day.projects = {}
    for (const [p, v] of Object.entries(r.projects)) if (typeof v === 'number' && v > 0) day.projects[p] = v
  }
  const extra = raw as { ms?: unknown; hours?: unknown }
  if (typeof extra.ms === 'number' && extra.ms >= 0) day.ms = extra.ms
  if (Array.isArray(extra.hours) && extra.hours.length === 24 && extra.hours.every(n => typeof n === 'number' && n >= 0)) {
    day.hours = extra.hours as number[]
  }
  return day
}
