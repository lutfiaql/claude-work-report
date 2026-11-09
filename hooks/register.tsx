import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DayRecord, KindId, TabId } from '../types'
import { SCAN_SCRIPT, parseScan, usesOf } from './history'
import {
  AMBER,
  BAR,
  DARK,
  DEFAULT_SETTINGS,
  GOLD,
  GREEN,
  HAIRLINE,
  KINDS,
  MUTED,
  TABS,
  TEXT,
  type Chart,
  type Sum,
  type ToolUse,
  activeDays,
  addDays,
  addTask,
  applySettings,
  barCell,
  bestDay,
  bigText,
  changePercent,
  chartFor,
  clockHour,
  csvOf,
  classify,
  cleanDay,
  cleanSettings,
  dayKey,
  fit,
  formatChange,
  formatDuration,
  formatHours,
  formatMoney,
  hbar,
  isTypedOrigin,
  leverage,
  longestStreak,
  minutesOf,
  monthName,
  monthTotals,
  noonOf,
  peakWindow,
  PREVIOUS_LABEL,
  prettyModel,
  previousKeys,
  projectName,
  rangeKeys,
  rangeLabel,
  shortDate,
  streak,
  sumDays,
  textWidth,
  toolUseOf,
  weekdayOf,
  withCommas,
  yearDays,
} from './logic'
import { barsSvg, chartSvg, headerSvg, heatmapSvg, pixelWidth, tilesSvg } from './svg'

const PANE = 'work-report'
const TITLE = 'Work report'
const SETTINGS_KEY = 'settings'
const HISTORY_KEY = 'history'
const HISTORY_VERSION = 3

const tabAtom = atom({ plugin: 'work-report', key: 'tab' } as const, 'today' as TabId)
// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const daysAtom = atom({ plugin: 'work-report', key: 'days' } as const, {} as Record<string, DayRecord>, {
  shape: 'days-3',
})
const settingsAtom = atom({ plugin: 'work-report', key: 'settings' } as const, DEFAULT_SETTINGS, {
  shape: 'settings-1',
})

const TAB_TITLES: Record<TabId, string> = {
  today: 'TODAY',
  week: 'LAST 7 DAYS',
  month: 'LAST 30 DAYS',
  year: 'THIS YEAR',
}

const EMPTY: Record<TabId, string> = {
  today: 'Nothing finished yet today. Your first finished task shows up here.',
  week: 'Nothing finished in the last 7 days. Your first finished task shows up here.',
  month: 'Nothing finished in the last 30 days. Your first finished task shows up here.',
  year: 'Nothing finished yet this year. Your first finished task shows up here.',
}

type Turn = { turnId: string; isTyped: boolean; startedAt: number; promptAt: number | undefined; uses: ToolUse[] }

// ------------------------------------------------------------ store and state

/** Reads this year's days (and at least the last 40) from the store into the session's state. */
async function loadFromStore($: EngineInterface): Promise<void> {
  const today = dayKey(await $.clock.now())
  const jan1 = `${noonOf(today).getFullYear()}-01-01`
  const monthAgo = addDays(today, -40)
  const cutoff = jan1 < monthAgo ? jan1 : monthAgo
  const keys = (await $.store.keys()).filter(k => k.startsWith('day:') && k.slice(4) >= cutoff)
  const loaded: Record<string, DayRecord> = {}
  for (const key of keys) {
    const day = cleanDay(await $.store.get(key))
    if (day) loaded[key.slice(4)] = day
  }
  const cfg = cleanSettings(await $.store.get(SETTINGS_KEY))
  await update($, daysAtom, () => loaded)
  await update($, settingsAtom, () => cfg)
}

type LiveTask = { key: string; kind: KindId; model: string; project: string; ms: number; hour: number }

// A rebuild replaces whole days in the store. A task that finishes while one
// runs waits here and is written once the rebuild is done, so the rebuild
// neither drops it nor, written twice, counts it twice.
let rebuilding = 0
const waiting: LiveTask[] = []

/** Adds one finished task to today's record in the store and the session's state. */
async function recordTask($: EngineInterface, kind: KindId, model: string, workedMs: number): Promise<void> {
  const now = await $.clock.now()
  // A task still counts when the folder cannot be read.
  const project = projectName(await $.session.cwd().catch(() => undefined))
  const task: LiveTask = { key: dayKey(now), kind, model, project, ms: workedMs, hour: new Date(now - workedMs).getHours() }
  if (rebuilding > 0) {
    waiting.push(task)
    return
  }
  await writeTask($, task)
}

async function writeTask($: EngineInterface, task: LiveTask): Promise<void> {
  const stored = cleanDay(await $.store.get(`day:${task.key}`))
  const day = addTask(stored ?? undefined, task.kind, task.model, task.project, { ms: task.ms, hour: task.hour })
  await $.store.set(`day:${task.key}`, day)
  await update($, daysAtom, all => ({ ...all, [task.key]: day }))
}

/**
 * Rebuilds every day from Claude Code's session history up to `until` (ms),
 * replacing what the store held for those days. Resolves how many tasks it found.
 */
async function rebuildFromHistory($: EngineInterface, until: number): Promise<number> {
  rebuilding += 1
  try {
    return await replaceFromHistory($, until)
  } finally {
    // The last rebuild to end writes what waited. The queue is checked and the
    // count lowered with no wait between, so a task finishing after this is
    // written directly.
    if (rebuilding === 1) {
      while (waiting.length > 0) {
        const task = waiting.shift()
        if (task) await writeTask($, task).catch(() => undefined)
      }
    }
    rebuilding -= 1
  }
}

async function replaceFromHistory($: EngineInterface, until: number): Promise<number> {
  const ran = await $.process.run(['/usr/bin/env', 'python3', '-I', '-', String(until)], {
    stdin: SCAN_SCRIPT,
    timeoutMs: 180_000,
  })
  const scan = ran.exitCode === 0 && !ran.isStdoutTruncated ? parseScan(ran.stdout) : null
  if (scan === null) throw new Error('history scan failed')
  const days: Record<string, DayRecord> = {}
  for (const [ts, modelIndex, tokens, cwdIndex, worked] of scan.tasks) {
    const key = dayKey(ts)
    const project = projectName(cwdIndex === undefined ? undefined : scan.cwds[cwdIndex])
    days[key] = addTask(days[key], classify(usesOf(tokens)), scan.models[modelIndex] ?? 'unknown', project, {
      ms: worked,
      hour: new Date(ts).getHours(),
    })
  }
  // The history holds every task from its earliest record up to `until`, those
  // recorded live included: it replaces the store's days in that stretch. Days
  // before it (their transcripts since cleaned up by Claude Code) are kept as
  // stored, and tasks after `until` are recorded live.
  const untilKey = dayKey(until)
  // With no history at all, nothing stored is replaced.
  if (scan.earliest !== null) {
    const fromKey = dayKey(scan.earliest)
    for (const key of (await $.store.keys()).filter(k => k.startsWith('day:'))) {
      const day = key.slice(4)
      if (day >= fromKey && day <= untilKey) await $.store.delete(key)
    }
  }
  for (const [key, day] of Object.entries(days)) await $.store.set(`day:${key}`, day)
  await $.store.set(HISTORY_KEY, { version: HISTORY_VERSION, at: until, tasks: scan.tasks.length })
  await loadFromStore($)
  return scan.tasks.length
}

async function openReport($: EngineInterface, tab?: TabId): Promise<void> {
  try {
    if (tab) await update($, tabAtom, () => tab)
    await loadFromStore($)
  } catch {
    // The pane still opens on what the session already holds.
  }
  await $.ui.open({ id: PANE, title: TITLE, backgroundColor: DARK })
}

// ------------------------------------------------------------ what a tab shows

type Row = { label: string; value: number; color: string; right: string; dim: boolean }
type Change = { text: string; color: string }

type View = {
  tab: TabId
  title: string
  dates: string
  isEmpty: boolean
  emptyText: string
  sum: Sum
  minutes: number
  rate: number
  tiles: Array<{ key: string; label: string; value: string; note: string; color: string; change?: Change }>
  kinds: Row[]
  models: Row[]
  projects: Row[]
  year: Array<{ key: string; total: number | null }>
  chart: Chart
  chartTitle: string
  summary: string
  summaryColor: string
  /** Claude's measured working time, and the estimate over it. */
  worked: string
  hours: number[]
  peak: string | null
  footer: string
  /** Plain text to paste anywhere. */
  share: string
}

function viewOf(tab: TabId, all: Record<string, DayRecord>, cfg: typeof DEFAULT_SETTINGS, today: string): View {
  const keys = rangeKeys(tab, today)
  const sum = sumDays(all, keys)
  const minutes = minutesOf(sum, cfg)
  const before = sumDays(all, previousKeys(tab, today))
  const changeOf = (now: number, then: number): Change | undefined => {
    const pct = changePercent(now, then)
    if (pct === null) return undefined
    return { text: `${formatChange(pct)} ${PREVIOUS_LABEL[tab]}`, color: pct > 0 ? GREEN : pct < 0 ? AMBER : MUTED }
  }
  const timeChange = changeOf(minutes, minutesOf(before, cfg))
  const taskChange = changeOf(sum.total, before.total)

  let summary: string
  let summaryColor = TEXT
  if (tab === 'today' || tab === 'week') {
    const days = streak(all, today)
    summaryColor = days > 0 ? GREEN : MUTED
    const longest = longestStreak(all)
    const best = longest > days ? ` · longest ${longest}` : ''
    summary = days === 0 ? `No streak yet${best ? `.${best}` : '.'}` : days === 1 ? `Streak: 1 day${best}` : `Streak: ${days} days in a row${best}`
  } else if (tab === 'month') {
    const best = bestDay(all, keys)
    const active = activeDays(all, keys)
    summary = best
      ? `Best day ${weekdayOf(best.key)} ${shortDate(best.key)}, ${best.total} tasks · ${active} active days`
      : `${active} active days`
  } else {
    const totals = monthTotals(all, today)
    let bestIndex = 0
    totals.forEach((n, i) => {
      if (n > (totals[bestIndex] ?? 0)) bestIndex = i
    })
    const active = activeDays(all, keys)
    summary = `Best month ${monthName(bestIndex)}, ${totals[bestIndex] ?? 0} tasks · ${active} active days`
  }

  const models = Object.entries(sum.models)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, n]) => ({ label: prettyModel(id), value: n, color: BAR, right: '', dim: false }))
  const projectList = Object.entries(sum.projects).sort((a, b) => b[1] - a[1])
  const share = (n: number) => `${Math.round((n / Math.max(1, sum.total)) * 100)}%`
  const projects: Row[] = projectList
    .slice(0, 5)
    .map(([name, n]) => ({ label: name, value: n, color: '#8B949E', right: share(n), dim: false }))
  const rest = projectList.slice(5).reduce((a, [, n]) => a + n, 0)
  if (rest > 0) {
    projects.push({ label: `${projectList.length - 5} more`, value: rest, color: HAIRLINE, right: share(rest), dim: true })
  }

  const lever = leverage(minutes, sum.ms)
  const worked =
    sum.ms >= 60000
      ? `Claude worked ${formatDuration(sum.ms)} on these${lever ? ` · about ${lever} that back in your time (estimate)` : ''}`
      : ''
  const peak = peakWindow(sum.hours)
  const topKinds = KINDS.filter(k => sum.kinds[k.id] > 0)
    .sort((a, b) => sum.kinds[b.id] - sum.kinds[a.id])
    .slice(0, 3)
    .map(k => `${k.label} ${sum.kinds[k.id]}`)
  const shareText = [
    `Work report · ${TAB_TITLES[tab].charAt(0)}${TAB_TITLES[tab].slice(1).toLowerCase()} (${rangeLabel(tab, today)})`,
    `${withCommas(sum.total)} tasks finished · about ${formatHours(minutes)} hours saved · worth about ${formatMoney(minutes, cfg.rate)} (estimate at $${cfg.rate}/h)`,
    topKinds.length > 0 ? topKinds.join(' · ') : '',
    worked,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    tab,
    title: TAB_TITLES[tab],
    dates: rangeLabel(tab, today),
    isEmpty: sum.total === 0,
    emptyText: EMPTY[tab],
    sum,
    minutes,
    rate: cfg.rate,
    tiles: [
      { key: 'hours', label: 'HOURS SAVED', value: formatHours(minutes), note: 'estimate', color: GREEN, change: timeChange },
      { key: 'tasks', label: 'TASKS DONE', value: withCommas(sum.total), note: 'finished', color: TEXT, change: taskChange },
      {
        key: 'worth',
        label: 'WORTH',
        value: formatMoney(minutes, cfg.rate),
        note: `estimate at $${cfg.rate}/h`,
        color: GOLD,
        change: timeChange,
      },
    ],
    kinds: KINDS.map(k => ({
      label: k.label,
      value: sum.kinds[k.id],
      color: k.color,
      right: `${formatHours(sum.kinds[k.id] * (cfg.minutes[k.id] ?? 0))} h`,
      dim: sum.kinds[k.id] === 0,
    })),
    models,
    projects,
    year: tab === 'year' ? yearDays(all, today) : [],
    chart: chartFor(tab, all, today),
    chartTitle: tab === 'year' ? 'BY MONTH' : tab === 'month' ? 'BY DAY' : 'BY WEEKDAY',
    summary,
    summaryColor,
    worked,
    hours: sum.hours,
    peak: peak ? `Busiest ${peak.label}` : null,
    footer: `Estimate: minutes saved per task at $${cfg.rate}/h. /report settings to change.`,
    share: shareText,
  }
}

/** The chart's labels on the graphical surfaces: weekdays, every fifth day, or months. */
function graphicLabels(view: View, today: string, width: number): string[] {
  const n = view.chart.values.length
  if (view.tab === 'year') {
    const short = width / 12 < 30
    return view.chart.labels.map((_, i) => (short ? monthName(i).slice(0, 1) : monthName(i)))
  }
  const keys = rangeKeys(view.tab === 'month' ? 'month' : 'week', today)
  if (view.tab === 'month') {
    return keys.map((k, i) => ((n - 1 - i) % 5 === 0 ? String(noonOf(k).getDate()) : ''))
  }
  return keys.map(k => weekdayOf(k))
}

const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) =>
  hour % 6 === 0 ? (hour === 0 ? '12a' : hour === 12 ? '12p' : hour < 12 ? `${hour}a` : `${hour - 12}p`) : '',
)

// ------------------------------------------------------------ layout helpers

function wrapWords(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`
    if (textWidth(next) <= width) line = next
    else {
      if (line !== '') lines.push(line)
      line = textWidth(word) > width ? fit(word, width) : word
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

function tilesPerRow(width: number): number {
  if (width >= 60) return 3
  if (width >= 40) return 2
  return 1
}

// ------------------------------------------------------------ the module

export const register: Register = on => {
  // What the last prompt was: typed by the person, not, or not seen at all
  // (some hosts start a turn without raising prompt.submit to plugins).
  let pending: 'typed' | 'not' | null = null
  let current: Turn | null = null

  let promptAt: number | undefined
  // History is read up to just before the prompt of any turn still running, so
  // that turn is counted once, live, when it finishes.
  const runningSince = (): number | undefined =>
    current === null ? undefined : (current.promptAt ?? current.startedAt) - 1000

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'report',
        description: 'Open the work report: tasks done and the time they saved (estimate)',
        argumentHint: '[today|week|month|year|settings|copy|export|rebuild]',
        immediate: true,
      })
    } catch {
      // Without the command the status bar button still opens the pane.
    }
    void (async () => {
      await loadFromStore($)
      const history = (await $.store.get(HISTORY_KEY)) as { version?: number } | undefined
      if (history?.version !== HISTORY_VERSION) await rebuildFromHistory($, runningSince() ?? (await $.clock.now()))
    })().catch(() => undefined)
    return next(e)
  })

  // ---------------------------------------------------------- recording

  on('prompt.submit', async ($, e, next) => {
    const isTyped = e.command === undefined && e.isMeta !== true && isTypedOrigin(e.origin.kind)
    if (isTyped && e.turnId === undefined) promptAt = await $.clock.now()
    if (isTyped && e.turnId !== undefined && current !== null && current.turnId === e.turnId) {
      // Folded into the running turn: that turn is the task.
      current.isTyped = true
    } else {
      pending = isTyped ? 'typed' : 'not'
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      // No prompt seen: a turn that starts from typed text that is no slash command.
      const isTyped = pending === null ? e.text.trim() !== '' && !e.text.trimStart().startsWith('/') : pending === 'typed'
      current = { turnId: e.turnId, isTyped, startedAt: await $.clock.now(), promptAt, uses: [] }
      pending = null
      promptAt = undefined
    }
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (current !== null && current.uses.length < 500) current.uses.push(toolUseOf(e))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && current !== null && current.turnId === e.turnId) {
      const turn = current
      current = null
      if (turn.isTyped && e.reason === 'answer' && !e.isAborted) {
        try {
          await recordTask($, classify(turn.uses), e.usage?.model ?? 'unknown', e.durationMs)
        } catch {
          // A failed write loses this one task; the turn goes on.
        }
      }
    }
    return next(e)
  })

  // ---------------------------------------------------------- the command

  on('command.run', { command: 'report' }, async ($, e) => {
    try {
      const args = e.args.trim()
      const [first = '', ...rest] = args.split(/\s+/)
      const word = first.toLowerCase()
      if (word === 'settings') {
        const cfg = cleanSettings(await $.store.get(SETTINGS_KEY))
        const result = applySettings(rest.join(' '), cfg)
        if (result.settings) {
          const saved = result.settings
          await $.store.set(SETTINGS_KEY, saved)
          await update($, settingsAtom, () => saved)
        }
        return { text: result.text }
      }
      if (word === 'copy' || word === 'export') {
        await loadFromStore($)
        const tab = await read($, tabAtom)
        const all = await read($, daysAtom)
        const cfg = await read($, settingsAtom)
        const today = dayKey(await $.clock.now())
        const text = word === 'copy' ? viewOf(tab, all, cfg, today).share : csvOf(all, rangeKeys('year', today), cfg)
        const copied = await $.ui.copy({ text }).catch(() => ({ isCopied: false }))
        if (copied.isCopied) {
          return {
            text:
              word === 'copy'
                ? `Copied the ${TAB_TITLES[tab].toLowerCase()} summary to your clipboard.`
                : 'Copied this year as CSV (one row per active day) to your clipboard.',
          }
        }
        return { text: `Your clipboard could not be reached, so here it is:\n\n${text}` }
      }
      if (word === 'rebuild') {
        void (async () => {
          await rebuildFromHistory($, runningSince() ?? (await $.clock.now()))
          await openReport($)
        })().catch(() => undefined)
        return { text: 'Rebuilding the report from your session history. The pane updates when it is done.' }
      }
      if (word === '' || word === 'today' || word === 'week' || word === 'month' || word === 'year') {
        const tab = word === '' ? undefined : (word as TabId)
        void openReport($, tab).catch(() => undefined)
        return { text: 'Opening your work report. Hours and dollars are estimates.' }
      }
      return {
        text: 'Use /report to open the pane, /report week (or today, month, year) to open a tab, /report settings to see and change the estimate, /report copy for a summary to paste, /report export for this year as CSV, or /report rebuild to recount from your session history.',
      }
    } catch {
      return { text: 'The work report could not do that just now. Try /report again in a moment.' }
    }
  }).catch(() => ({ text: 'The work report could not do that just now. Try /report again in a moment.' }))

  // ---------------------------------------------------------- status bar button

  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const modes = e.props.modes
    return (
      <Box flexDirection="row" gap={1}>
        {modes.length > 0 && <Text dimColor>{modes.join(' & ')}</Text>}
        <Button key="open-report" plain onPress={() => void openReport($).catch(() => undefined)}>
          <Text backgroundColor={HAIRLINE} color={TEXT}> Report </Text>
        </Button>
      </Box>
    )
  })

  // ---------------------------------------------------------- the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = Math.max(16, e.props.bodyColumns)
    const tab = await read($, tabAtom)
    const all = await read($, daysAtom)
    const cfg = await read($, settingsAtom)
    const today = dayKey(await $.clock.now())
    const view = viewOf(tab, all, cfg, today)

    // Tabs: chips, the chosen one gold with dark text.
    const chipPad = columns >= 30 ? ' ' : ''
    const short = columns < 22
    const tabs = (
      <Box flexDirection="row" gap={1}>
        {TABS.map(t => {
          const isOn = t.id === tab
          const label = `${chipPad}${short ? t.label.slice(0, 1) : t.label}${chipPad}`
          return (
            <Button key={`tab-${t.id}`} plain onPress={() => void update($, tabAtom, () => t.id)}>
              <Text backgroundColor={isOn ? GOLD : HAIRLINE} color={isOn ? DARK : TEXT} bold={isOn}>
                {label}
              </Text>
            </Button>
          )
        })}
      </Box>
    )

    // ------------------------------------------------ graphical surfaces
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const px = pixelWidth(columns)
      const header = (
        <Svg source={headerSvg(px, view.title, view.dates)} alt={`${view.title}, ${view.dates}`} />
      )
      if (view.isEmpty) {
        return (
          <Box flexDirection="column" gap="md">
            {tabs}
            {header}
            <Text color={MUTED}>{view.emptyText}</Text>
          </Box>
        )
      }
      const labels = graphicLabels(view, today, px)
      const chartAlt = `${view.chartTitle}: ${view.chart.values
        .map((v, i) => `${labels[i] || view.chart.labels[i] || i + 1} ${view.chart.future[i] ? '-' : v}`)
        .join(', ')}`
      return (
        <Box flexDirection="column" gap="md">
          {tabs}
          {header}
          <Box flexDirection="column" gap="xs">
            <Svg
              source={tilesSvg(px, view.tiles)}
              alt={view.tiles.map(t => `${t.label} ${t.value} (${t.note}${t.change ? `, ${t.change.text}` : ''})`).join(', ')}
            />
            {view.worked !== '' && <Text color={MUTED}>{view.worked}</Text>}
          </Box>
          <Svg
            source={barsSvg(px, 'WHERE THE TIME WENT', view.kinds, true)}
            alt={`Where the time went: ${view.kinds.map(k => `${k.label} ${k.value} tasks, ${k.right}`).join('; ')}`}
          />
          {view.models.length > 0 && (
            <Svg
              source={barsSvg(px, 'WHO DID THE WORK', view.models, false)}
              alt={`Who did the work: ${view.models.map(m => `${m.label} ${m.value}`).join(', ')}`}
            />
          )}
          {view.projects.length > 0 && (
            <Svg
              source={barsSvg(px, 'WHERE YOU WORKED', view.projects, true)}
              alt={`Where you worked: ${view.projects.map(p => `${p.label} ${p.value}`).join(', ')}`}
            />
          )}
          <Box flexDirection="column" gap="xs">
            <Svg source={chartSvg(px, view.chartTitle, view.chart, labels)} alt={chartAlt} />
            <Text color={view.summaryColor} weight="medium">
              {view.summary}
            </Text>
          </Box>
          {view.peak !== null && (
            <Box flexDirection="column" gap="xs">
              <Svg
                source={chartSvg(px, 'WHEN YOU WORK', { values: view.hours, labels: [], current: -1, future: [] }, HOUR_LABELS)}
                alt={`When you work: ${view.hours.map((n, hour) => `${clockHour(hour)} ${n}`).join(', ')}`}
              />
              <Text color={MUTED}>{view.peak}</Text>
            </Box>
          )}
          {view.tab === 'year' && (
            <Svg
              source={heatmapSvg(px, 'EVERY DAY THIS YEAR', view.year, noonOf(`${today.slice(0, 4)}-01-01`).getDay(), today)}
              alt={`Every day this year: ${view.year.filter(d => (d.total ?? 0) > 0).length} active days`}
            />
          )}
          <Box flexDirection="row" gap="sm" alignItems="center">
            <Button key="copy-summary" plain onPress={press => void $.ui.copy({ text: view.share, surface: press.surface })}>
              <Text backgroundColor={HAIRLINE} color={TEXT}> Copy summary </Text>
            </Button>
            <Text color={MUTED} size="footnote">
              {view.footer}
            </Text>
          </Box>
        </Box>
      )
    }

    // ------------------------------------------------ the terminal
    const width = columns
    const titleFits = textWidth(view.title) + 2 + textWidth(view.dates) <= width
    const titleW = Math.min(textWidth(view.title), width)
    const titleBar = (
      <Box flexDirection="column">
        {titleFits ? (
          <Text>
            <Text bold color={TEXT}>{view.title}</Text>
            <Text color={MUTED}>{' '.repeat(width - textWidth(view.title) - textWidth(view.dates)) + view.dates}</Text>
          </Text>
        ) : (
          <Text bold color={TEXT}>{fit(view.title, width).trimEnd()}</Text>
        )}
        {!titleFits && <Text color={MUTED}>{fit(view.dates, width).trimEnd()}</Text>}
        <Text>
          <Text color={GOLD}>{'━'.repeat(titleW)}</Text>
          <Text color={HAIRLINE}>{'─'.repeat(width - titleW)}</Text>
        </Text>
      </Box>
    )

    if (view.isEmpty) {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {titleBar}
          <Box flexDirection="column">
            {wrapWords(view.emptyText, width).map(line => (
              <Text color={MUTED}>{line}</Text>
            ))}
          </Box>
        </Box>
      )
    }

    // Tiles.
    const perRow = tilesPerRow(width)
    const tileW = Math.floor((width - (perRow - 1)) / perRow)
    const inner = tileW - 4
    const hasChange = view.tiles.some(t => t.change !== undefined)
    const drawTile = (t: View['tiles'][number]) => {
      const big = bigText(t.value)
      const isBig = big !== null && textWidth(big[0]) <= inner
      return (
        <Box borderStyle="round" borderColor={HAIRLINE} width={tileW} paddingX={1} flexDirection="column">
          <Text color={MUTED} bold>{fit(t.label, inner).trimEnd()}</Text>
          {isBig && big ? (
            big.map(row => <Text color={t.color}>{row}</Text>)
          ) : (
            [
              <Text> </Text>,
              <Text color={t.color} bold>{fit(t.value, inner).trimEnd()}</Text>,
              <Text> </Text>,
            ]
          )}
          <Text color={MUTED}>{fit(textWidth(t.note) <= inner ? t.note : 'estimate', inner).trimEnd()}</Text>
          {hasChange && <Text color={t.change?.color ?? MUTED}>{fit(t.change?.text ?? '', inner).trimEnd() || ' '}</Text>}
        </Box>
      )
    }
    const tileRows: Array<View['tiles']> = []
    for (let i = 0; i < view.tiles.length; i += perRow) tileRows.push(view.tiles.slice(i, i + perRow))

    // Section heading: small muted capitals and a hairline.
    const heading = (text: string) => (
      <Text>
        <Text color={MUTED} bold>{text}</Text>
        <Text color={HAIRLINE}>{' ' + '─'.repeat(Math.max(0, width - textWidth(text) - 1))}</Text>
      </Text>
    )

    // Where the time went.
    const labelW = width >= 50 ? 17 : width >= 36 ? 12 : 9
    const countW = 5
    const hoursW = width >= 36 ? 8 : 7
    const barW = Math.max(1, width - labelW - countW - hoursW)
    const maxKind = Math.max(1, ...view.kinds.map(k => k.value))
    const kindRows = view.kinds.map(k => (
      <Text>
        <Text color={k.dim ? MUTED : TEXT}>{fit(k.label, labelW - 1) + ' '}</Text>
        <Text color={k.color}>{fit(hbar(k.value, maxKind, barW - 1), barW)}</Text>
        <Text color={k.dim ? MUTED : TEXT}>{String(k.value).padStart(countW)}</Text>
        <Text color={MUTED}>{k.right.padStart(hoursW)}</Text>
      </Text>
    ))

    // Who did the work.
    const maxModel = Math.max(1, ...view.models.map(m => m.value))
    const modelBarW = Math.max(1, width - labelW - countW)
    const modelRows = view.models.map(m => (
      <Text>
        <Text color={TEXT}>{fit(m.label, labelW - 1) + ' '}</Text>
        <Text color={BAR}>{fit(hbar(m.value, maxModel, modelBarW - 1), modelBarW)}</Text>
        <Text color={TEXT}>{String(m.value).padStart(countW)}</Text>
      </Text>
    ))

    // Where you worked.
    const maxProject = Math.max(1, ...view.projects.map(p => p.value))
    const projectRows = view.projects.map(p => (
      <Text>
        <Text color={p.dim ? MUTED : TEXT}>{fit(p.label, labelW - 1) + ' '}</Text>
        <Text color={MUTED}>{fit(hbar(p.value, maxProject, barW - 1), barW)}</Text>
        <Text color={p.dim ? MUTED : TEXT}>{String(p.value).padStart(countW)}</Text>
        <Text color={MUTED}>{p.right.padStart(hoursW)}</Text>
      </Text>
    ))

    // When you work: one row, an hour (or two, when narrow) per cell.
    const buckets = width >= 24 ? view.hours : view.hours.reduce<number[]>((acc, n, hour) => {
      acc[Math.floor(hour / 2)] = (acc[Math.floor(hour / 2)] ?? 0) + n
      return acc
    }, [])
    const cellW = Math.max(1, Math.floor(width / buckets.length))
    const maxHour = Math.max(1, ...buckets)
    const hourStrip = buckets.map(n => barCell(n, maxHour, 0, 1).repeat(cellW)).join('')
    const hourLabels =
      width >= 24 && cellW >= 2
        ? [0, 6, 12, 18]
            .map(hour => fit(hour === 0 ? '12a' : hour === 12 ? '12p' : hour < 12 ? `${hour}a` : `${hour - 12}p`, cellW * 6))
            .join('')
            .trimEnd()
        : ''

    // The chart, three rows tall.
    const chart = view.chart
    const keys = rangeKeys(tab, today)
    const shown = Math.min(chart.values.length, width)
    const skip = chart.values.length - shown
    const values = chart.values.slice(skip)
    const slot = Math.max(1, Math.floor(width / shown))
    const barWidth = slot >= 3 ? slot - 1 : 1
    const gapW = slot - barWidth
    const maxBar = Math.max(1, ...values)
    const chartRows = [0, 1, 2].map(row => (
      <Text>
        {values.map((v, i) => {
          const index = i + skip
          const isFuture = chart.future[index] === true
          const glyph = isFuture ? ' ' : barCell(v, maxBar, row, 3)
          const color = isFuture || v === 0 ? HAIRLINE : index === chart.current ? GOLD : BAR
          return <Text color={color}>{glyph.repeat(barWidth) + ' '.repeat(i === values.length - 1 ? 0 : gapW)}</Text>
        })}
      </Text>
    ))
    let labelRow: string
    if (tab === 'month') {
      const first = keys[skip] ?? keys[0] ?? today
      const left = shortDate(first)
      const right = shortDate(today)
      const span = shown * slot - gapW
      labelRow =
        textWidth(left) + textWidth(right) + 1 <= span
          ? left + ' '.repeat(span - textWidth(left) - textWidth(right)) + right
          : fit(right, span)
    } else {
      const labels = chart.labels.slice(skip)
      labelRow = labels
        .map((l, i) => {
          const cell = slot >= 3 || tab === 'year' ? l.slice(0, Math.max(1, barWidth)) : l.slice(0, 1)
          return i === labels.length - 1 ? cell : fit(cell, slot)
        })
        .join('')
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {titleBar}
        <Box flexDirection="column">
          {tileRows.map(group => (
            <Box flexDirection="row" gap={1}>
              {group.map(drawTile)}
            </Box>
          ))}
        </Box>
        <Box flexDirection="column">
          {heading('WHERE THE TIME WENT')}
          {kindRows}
        </Box>
        <Box flexDirection="column">
          {heading('WHO DID THE WORK')}
          {modelRows.length > 0 ? modelRows : <Text color={MUTED}>No model recorded.</Text>}
        </Box>
        {projectRows.length > 0 && (
          <Box flexDirection="column">
            {heading('WHERE YOU WORKED')}
            {projectRows}
          </Box>
        )}
        <Box flexDirection="column">
          {heading(view.chartTitle)}
          {chartRows}
          <Text color={MUTED}>{labelRow}</Text>
          {wrapWords(view.summary, width).map(line => (
            <Text color={view.summaryColor}>{line}</Text>
          ))}
        </Box>
        {view.peak !== null && (
          <Box flexDirection="column">
            {heading('WHEN YOU WORK')}
            <Text color={BAR}>{hourStrip}</Text>
            {hourLabels !== '' && <Text color={MUTED}>{hourLabels}</Text>}
            <Text color={MUTED}>{fit(view.peak, width).trimEnd()}</Text>
          </Box>
        )}
        {view.worked !== '' && (
          <Box flexDirection="column">
            {wrapWords(view.worked, width).map(line => (
              <Text color={MUTED}>{line}</Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column">
          <Button key="copy-summary" plain onPress={press => void $.ui.copy({ text: view.share, surface: press.surface })}>
            <Text backgroundColor={HAIRLINE} color={TEXT}>{width >= 16 ? ' Copy summary ' : ' Copy '}</Text>
          </Button>
          {wrapWords(view.footer, width).map(line => (
            <Text color={MUTED}>{line}</Text>
          ))}
        </Box>
      </Box>
    )
  })
}
