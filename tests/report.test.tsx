import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  addDays,
  addTask,
  changePercent,
  classify,
  cleanDay,
  clockHour,
  csvOf,
  DEFAULT_SETTINGS,
  formatDuration,
  leverage,
  longestStreak,
  peakWindow,
  formatChange,
  previousKeys,
  projectName,
  dayKey,
  dayOfYear,
  rangeKeys,
  streak,
  sumDays,
} from '../hooks/logic'
import type { DayRecord } from '../types'

// 3 pm local time on Monday, November 9, 2026.
const NOW = new Date(2026, 10, 9, 15, 0, 0).getTime()
const TODAY = dayKey(NOW)

const paneAt = (bodyColumns: number) =>
  ({
    plugin: 'work-report',
    component: 'Pane',
    requestId: 'work-report',
    props: {
      title: 'Work report',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  }) as const

const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** Stands for the engine beneath the plugin. */
function engine(on: On, store: Record<string, unknown> = {}, onOpen: () => void = () => undefined) {
  mock.store(on, store)
  const clock = mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'report' } }))
  on('ui.open', () => {
    onOpen()
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
  on('session.cwd', () => ({ value: '/Users/me/Projects/atlas' }))
  return clock
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

function kids(node: Node): unknown[] {
  const c = node.children ?? (node.props?.children as unknown[] | undefined) ?? []
  return Array.isArray(c) ? c : [c]
}

function flat(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (node === null || typeof node !== 'object') return ''
  return kids(node as Node).map(flat).join('')
}

/** Every row of text as drawn: each outermost Text, its nested runs joined. */
function rows(node: unknown, out: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return out
  const n = node as Node
  if (n.type === 'Text') {
    out.push(flat(n))
    return out
  }
  if (n.type === 'Button') return out
  for (const child of kids(n)) rows(child, out)
  return out
}

/** How many rounded tiles sit side by side in the widest row. */
function tilesAcross(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0
  const n = node as Node
  const children = kids(n)
  const here = children.filter(
    c => typeof c === 'object' && c !== null && (c as Node).props?.borderStyle === 'round',
  ).length
  return Math.max(here, ...children.map(tilesAcross))
}

async function rowsOf(ui: { drawn: () => Promise<unknown> }): Promise<string[]> {
  return rows(await ui.drawn())
}

const day = (kinds: DayRecord['kinds'], models: Record<string, number> = { 'claude-opus-5-5': 1 }): DayRecord => ({
  kinds,
  models,
})

// ------------------------------------------------------------------ sorting

describe('sorting a task by its tools', () => {
  test('each kind is found by its tools or files', async () => {
    expect(classify([{ tool: 'mcp__723a__create_draft' }])).toBe('emails')
    expect(classify([{ tool: 'mcp__gmail__send_message' }])).toBe('emails')
    expect(classify([{ tool: 'mcp__imagegen__generate_image' }])).toBe('images')
    expect(classify([{ tool: 'Write', file: '/tmp/cover.png' }])).toBe('images')
    expect(classify([{ tool: 'Skill', skill: 'anthropic-skills:pptx' }])).toBe('documents')
    expect(classify([{ tool: 'Write', file: '/tmp/notes/plan.docx' }])).toBe('documents')
    expect(classify([{ tool: 'WebSearch' }, { tool: 'WebFetch' }])).toBe('research')
    expect(classify([{ tool: 'mcp__youtube__get_transcript' }])).toBe('research')
    expect(classify([{ tool: 'Bash' }, { tool: 'Grep' }, { tool: 'Edit', file: '/src/a.ts' }])).toBe('coding')
    expect(classify([{ tool: 'Read', file: '/src/a.ts' }, { tool: 'Grep' }])).toBe('other')
    expect(classify([{ tool: 'WebSearch' }, { tool: 'Edit', file: '/src/a.ts' }])).toBe('coding')
    expect(classify([])).toBe('other')
  })

  test('a task that touches several kinds takes the first in order', async () => {
    expect(classify([{ tool: 'WebSearch' }, { tool: 'mcp__gmail__send_message' }])).toBe('emails')
    expect(classify([{ tool: 'WebSearch' }, { tool: 'Write', file: '/tmp/report.md' }])).toBe('documents')
    expect(classify([{ tool: 'Write', file: '/tmp/a.pdf' }, { tool: 'Write', file: '/tmp/b.mp4' }])).toBe('images')
  })
})

// ------------------------------------------------------------------ counting

test('only a typed prompt that finishes with an answer counts', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const typed = { wait: false, origin: { kind: 'composer' } } as const
  const done = (turnId: string, extra: object = {}) =>
    $.turn.complete({
      turnId,
      answer: 'done',
      durationMs: 1000,
      isAborted: false,
      reason: 'answer',
      usage: { ...USAGE, model: 'claude-opus-5-5' },
      ...extra,
    } as never)

  // 1. A typed request that searched the web: one Research task.
  await $.prompt.submit({ text: 'find me flights', ...typed } as never)
  await $.turn.start({ text: 'find me flights', turnId: 't1' })
  await $.tool.call({ tool: 'WebSearch', query: 'flights' } as never)
  // A helper agent's own turn inside it is no task of its own.
  await $.turn.start({ text: 'sub', turnId: 'a1', agentId: 'agent-1' })
  await $.turn.complete({ turnId: 'a1', agentId: 'agent-1', answer: 'r', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await done('t1')

  // 2. A slash command: not counted.
  await $.prompt.submit({ text: '/review', command: { name: 'review', args: '' }, ...typed } as never)
  await $.turn.start({ text: 'review', turnId: 't2' })
  await done('t2')

  // 3. A cancelled typed turn: not counted.
  await $.prompt.submit({ text: 'write it', ...typed } as never)
  await $.turn.start({ text: 'write it', turnId: 't3' })
  await done('t3', { reason: 'aborted', isAborted: true })

  // 4. A background notification's turn: not counted.
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' }, isMeta: true } as never)
  await $.turn.start({ text: 'task done', turnId: 't4' })
  await done('t4')

  // 5. A typed request answered by another model, with no tools: one Other task.
  await $.prompt.submit({ text: 'thanks', ...typed } as never)
  await $.turn.start({ text: 'thanks', turnId: 't5' })
  await done('t5', { usage: { ...USAGE, model: 'claude-sonnet-5-5' } })

  // 6. The desktop app's prompts arrive unclassified: they count.
  await $.prompt.submit({ text: 'draft a memo', wait: false, origin: { kind: 'unclassified' } } as never)
  await $.turn.start({ text: 'draft a memo', turnId: 't6' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/memo.docx', content: 'x' } as never)
  await done('t6')

  // 7. A host that raises no prompt event: a turn from typed text counts.
  await $.turn.start({ text: 'one more thing', turnId: 't7' })
  await done('t7')

  // Four tasks today: Research 1 (25 min), Documents 1 (30 min), Other 2 (20 min).
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  const drawn = await rowsOf(ui)
  const row = (label: string) => drawn.find(r => r.startsWith(label)) ?? ''
  expect(row('Research')).toMatch(/ 1 +0\.4 h$/)
  expect(row('Documents')).toMatch(/ 1 +0\.5 h$/)
  expect(row('Other')).toMatch(/ 2 +0\.3 h$/)
  expect(row('Emails')).toMatch(/ 0 +0 h$/)
  expect(row('Opus 5.5')).toMatch(/ 3$/)
  expect(row('Sonnet 5.5')).toMatch(/ 1$/)
  await ui.unmount()
})

// ------------------------------------------------------------------ dates and sums

test('the streak counts days in a row up to today', async () => {
  const days: Record<string, DayRecord> = {
    [TODAY]: day({ other: 1 }),
    [addDays(TODAY, -1)]: day({ emails: 2 }),
    [addDays(TODAY, -2)]: day({ research: 1 }),
    [addDays(TODAY, -4)]: day({ other: 5 }),
  }
  expect(streak(days, TODAY)).toBe(3)
  // While today has nothing yet, the streak ending yesterday still stands.
  const { [TODAY]: _dropped, ...noToday } = days
  expect(streak(noToday, TODAY)).toBe(2)
  expect(streak({}, TODAY)).toBe(0)
})

test('days add together by kind and by model', async () => {
  const days: Record<string, DayRecord> = {
    '2026-11-08': day({ emails: 2, research: 1 }, { 'claude-opus-5-5': 3 }),
    '2026-11-09': day({ emails: 1, documents: 4 }, { 'claude-opus-5-5': 2, 'claude-sonnet-5-5': 3 }),
    '2026-10-01': day({ other: 9 }),
  }
  const sum = sumDays(days, ['2026-11-08', '2026-11-09'])
  expect(sum.total).toBe(8)
  expect(sum.kinds).toEqual({ emails: 3, documents: 4, images: 0, coding: 0, research: 1, other: 0 })
  expect(sum.models).toEqual({ 'claude-opus-5-5': 5, 'claude-sonnet-5-5': 3 })
})

test('the day of the year, stepping at local noon across clock changes', async () => {
  expect(dayOfYear('2026-01-01')).toBe(1)
  expect(dayOfYear('2026-11-09')).toBe(313)
  expect(dayOfYear('2024-12-31')).toBe(366)
  expect(dayOfYear('2026-12-31')).toBe(365)
  expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
  expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
  expect(addDays('2026-03-29', -1)).toBe('2026-03-28')
  expect(rangeKeys('year', '2026-11-09')).toHaveLength(313)
  expect(rangeKeys('year', '2026-11-09')[0]).toBe('2026-01-01')
  expect(rangeKeys('month', '2026-11-09')[0]).toBe('2026-10-11')
  expect(rangeKeys('week', '2026-11-09')[0]).toBe('2026-11-03')
})

// ------------------------------------------------------------------ the pane

const SEEDED = {
  [`day:${TODAY}`]: day({ emails: 3, research: 2 }, { 'claude-opus-5-5': 4, 'claude-sonnet-5-5': 1 }),
  [`day:${addDays(TODAY, -1)}`]: day({ documents: 1 }),
  [`day:${addDays(TODAY, -20)}`]: day({ images: 2 }),
  'day:2026-03-15': day({ other: 6 }),
}

test('each tab draws its own title and chart in the terminal', async ($, on) => {
  const clock = engine(on, SEEDED)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal'] as const) {
    const ui = await $.ui.mount({ ...paneAt(80), surface })

    await ui.press({ key: 'tab-today' })
    let text = (await rowsOf(ui)).join('\n')
    expect(text).toContain('TODAY')
    expect(text).toContain('Mon Nov 9, 2026')
    expect(text).toContain('Streak: 2 days in a row')
    expect(text).toContain('Mo') // the last seven days by weekday

    await ui.press({ key: 'tab-week' })
    text = (await rowsOf(ui)).join('\n')
    expect(text).toContain('LAST 7 DAYS')
    expect(text).toContain('Nov 3 – Nov 9, 2026')
    expect(text).toContain('Tu')

    await ui.press({ key: 'tab-month' })
    text = (await rowsOf(ui)).join('\n')
    expect(text).toContain('LAST 30 DAYS')
    expect(text).toContain('Oct 11 – Nov 9, 2026')
    expect(text).toMatch(/Oct 11 +Nov 9/) // thirty daily bars, first and last date under them
    expect(text).toContain('Best day Mon Nov 9, 5 tasks · 3 active days')

    await ui.press({ key: 'tab-year' })
    text = (await rowsOf(ui)).join('\n')
    expect(text).toContain('THIS YEAR')
    expect(text).toContain('Jan 1 – Nov 9, 2026')
    expect(text).toContain('Best month Mar, 6 tasks · 4 active days')
    expect(text).toMatch(/J +F +M +A +M +J +J +A +S +O +N +D/)
    expect(text).toContain('Where the time went'.toUpperCase())
    expect(text).toContain('WHO DID THE WORK')
    expect(text).toContain('Opus 5.5')

    await ui.unmount()
  }
})

test('the chosen tab is a gold chip with dark text', async ($, on) => {
  const clock = engine(on, SEEDED)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  await ui.press({ key: 'tab-week' })
  const chips = (await ui.findAll({ type: 'Text' })).filter(t => /^ ?(Today|Week|Month|Year) ?$/.test(t.text))
  const week = chips.find(t => t.text.includes('Week'))
  const today = chips.find(t => t.text.includes('Today'))
  expect(week?.props.backgroundColor).toBe('#F2C46D')
  expect(today?.props.backgroundColor).toBe('#262B33')
  await ui.unmount()
})

test('the empty state', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...paneAt(80), surface })
    const text = (await rowsOf(ui)).join('\n')
    expect(text).toContain('Nothing finished yet today. Your first finished task shows up here.')
    expect(text).not.toContain('HOURS SAVED')
    await ui.unmount()
  }
})

test('rows fit the pane at a narrow width and a wide one, with fewer tiles when narrow', async ($, on) => {
  const clock = engine(on, SEEDED)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const expected: Array<[number, number]> = [
    [24, 1],
    [44, 2],
    [100, 3],
  ]
  for (const [width, tiles] of expected) {
    for (const tab of ['today', 'week', 'month', 'year'] as const) {
      const ui = await $.ui.mount({ ...paneAt(width), surface: 'terminal' })
      await ui.press({ key: `tab-${tab}` })
      const drawn = await ui.drawn()
      for (const row of rows(drawn)) {
        expect([...row].length <= width ? 'fits' : `too wide at ${width}: ${row}`).toBe('fits')
      }
      expect(tilesAcross(drawn)).toBe(tiles)
      await ui.unmount()
    }
  }
})

test('/report answers at once and settings change the estimate', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const opened = await $.command.run({ command: 'report', args: '' } as never)
  expect(opened.text).toContain('Opening your work report')
  const listed = await $.command.run({ command: 'report', args: 'settings' } as never)
  expect(listed.text).toContain('$50 per hour')
  expect(listed.text).toContain('30 minutes per task (Documents)')
  const rate = await $.command.run({ command: 'report', args: 'settings rate 75' } as never)
  expect(rate.text).toContain('$75')
  const emails = await $.command.run({ command: 'report', args: 'settings emails 15' } as never)
  expect(emails.text).toContain('15 minutes')
  const again = await $.command.run({ command: 'report', args: 'settings' } as never)
  expect(again.text).toContain('$75 per hour')
  expect(again.text).toContain('15 minutes per task (Emails)')
  const bad = await $.command.run({ command: 'report', args: 'settings rate lots' } as never)
  expect(bad.text).toContain('Give one name and one number')
})

test('status bar button opens the pane', async ($, on) => {
  let opened = 0
  engine(on, {}, () => {
    opened += 1
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'work-report', surface, component: 'SessionMode', props: { modes: ['focus'] } })
    const text = (await rowsOf(ui)).join(' ')
    expect(text).toContain('focus')
    await ui.press({ key: 'open-report' })
    await ui.unmount()
  }
  expect(opened).toBe(2)
})

test('on desktop each tab draws its own charts as SVG', async ($, on) => {
  const clock = engine(on, SEEDED)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...paneAt(90), surface })
    const alts = async () => (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
    const sources = async () => (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.source)).join('')

    await ui.press({ key: 'tab-today' })
    let all = (await alts()).join('\n')
    expect(all).toContain('TODAY, Mon Nov 9, 2026')
    expect(all).toContain('TASKS DONE 5')
    expect(all).toContain('BY WEEKDAY: Tue 0, Wed 0, Thu 0, Fri 0, Sat 0, Sun 1, Mon 5')
    expect(await sources()).toContain('#F2C46D') // today's bar and the rule in gold

    await ui.press({ key: 'tab-month' })
    all = (await alts()).join('\n')
    expect(all).toContain('LAST 30 DAYS, Oct 11 – Nov 9, 2026')
    expect(all).toContain('TASKS DONE 8')
    expect(all).toContain('BY DAY: 11 0, 12 0')
    expect(all).toContain('20 2')
    expect(all).toContain('8 1, 9 5')

    await ui.press({ key: 'tab-year' })
    all = (await alts()).join('\n')
    expect(all).toContain('THIS YEAR, Jan 1 – Nov 9, 2026')
    expect(all).toContain('TASKS DONE 14')
    expect(all).toContain('BY MONTH: Jan 0, Feb 0, Mar 6')
    expect(all).toContain('Nov 6, Dec -')
    expect(all).toContain('Opus 5.5 7, Sonnet 5.5 1')
    const text = (await rowsOf(ui)).join('\n')
    expect(text).toContain('Best month Mar, 6 tasks · 4 active days')
    await ui.unmount()
  }
})

test('past days are rebuilt from the session history', async ($, on) => {
  const at = (d: number, hour: number) => new Date(2026, 10, d, hour).getTime()
  const scan = {
    models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    earliest: at(2, 10),
    tasks: [
      [at(2, 10), 0, ['WebSearch']],
      [at(2, 11), 1, ['Skill', 'skill:anthropic-skills:docx']],
      [at(5, 9), 0, ['mcp__x__create_draft']],
      [at(9, 9), 0, ['Bash', 'file:png', 'Write']],
    ],
  }
  let ran: readonly string[] = []
  const clock = engine(on, { [`day:${TODAY}`]: day({ other: 2 }) })
  on('process.run', (_, e) => {
    ran = e.argv
    return { value: { exitCode: 0, stdout: JSON.stringify(scan), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(ran.join(' ')).toContain('python3 -I -')

  const ui = await $.ui.mount({ ...paneAt(90), surface: 'desktop' })
  await ui.press({ key: 'tab-week' })
  const week = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt)).join('\n')
  // Today's two live tasks are in the history too: the history replaces them.
  expect(week).toContain('TASKS DONE 2')
  expect(week).toContain('Thu 1, Fri 0, Sat 0, Sun 0, Mon 1')
  await ui.press({ key: 'tab-month' })
  const all = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt)).join('\n')
  expect(all).toContain('TASKS DONE 4')
  expect(all).toContain('Emails 1 tasks')
  expect(all).toContain('Documents 1 tasks')
  expect(all).toContain('Images and video 1 tasks')
  expect(all).toContain('Research 1 tasks')
  expect(all).toContain('Other 0 tasks')
  expect(all).toContain('Opus 5.5 3, Sonnet 5.5 1')
  await ui.unmount()

  // `/report rebuild` answers at once.
  const answer = await $.command.run({ command: 'report', args: 'rebuild' } as never)
  expect(answer.text).toContain('Rebuilding')
})

// ------------------------------------------------------------------ enhancements

test('the previous stretch, the change against it, and project names', async () => {
  expect(previousKeys('today', '2026-11-09')).toEqual(['2026-11-08'])
  expect(previousKeys('week', '2026-11-09')[0]).toBe('2026-10-27')
  expect(previousKeys('week', '2026-11-09')[6]).toBe('2026-11-02')
  expect(previousKeys('month', '2026-11-09')[29]).toBe('2026-10-10')
  expect(previousKeys('year', '2026-11-09')[0]).toBe('2025-01-01')
  expect(previousKeys('year', '2026-11-09').at(-1)).toBe('2025-11-09')
  expect(changePercent(15, 10)).toBe(50)
  expect(changePercent(5, 10)).toBe(-50)
  expect(changePercent(5, 0)).toBe(null)
  expect(formatChange(24)).toBe('+24%')
  expect(formatChange(-8)).toBe('−8%')
  expect(formatChange(0)).toBe('same')
  expect(projectName('/Users/me/Projects/atlas')).toBe('atlas')
  expect(projectName('/Users/me/Downloads/acme/files')).toBe('acme/files')
  expect(projectName('/Users/me/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-1')).toBe('No folder')
  expect(projectName(undefined)).toBe('Unknown')
})

test('tiles show the change, projects are listed, and the year has a heatmap', async ($, on) => {
  const clock = engine(on, {
    [`day:${TODAY}`]: { kinds: { coding: 4 }, models: { 'claude-opus-5-5': 4 }, projects: { atlas: 3, notes: 1 } },
    [`day:${addDays(TODAY, -1)}`]: { kinds: { coding: 2 }, models: { 'claude-opus-5-5': 2 }, projects: { atlas: 2 } },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...paneAt(90), surface: 'desktop' })
  await ui.press({ key: 'tab-today' })
  let all = (await ui.findAll({ type: 'Svg' })).map(s => `${String(s.props.alt)}\n${String(s.props.source)}`).join('\n')
  expect(all).toContain('+100% vs yesterday')
  expect(all).toContain('Coding 4 tasks, 1.3 h')
  expect(all).toContain('Where you worked: atlas 3, notes 1')
  await ui.press({ key: 'tab-year' })
  all = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt)).join('\n')
  expect(all).toContain('Every day this year: 2 active days')
  await ui.unmount()

  // The terminal shows the change and the projects too, within its width.
  for (const width of [30, 80]) {
    const term = await $.ui.mount({ ...paneAt(width), surface: 'terminal' })
    await term.press({ key: 'tab-today' })
    const lines = await rowsOf(term)
    expect(lines.join('\n')).toContain('WHERE YOU WORKED')
    expect(lines.join('\n')).toMatch(/\+100%/)
    for (const line of lines) expect([...line].length <= width ? 'fits' : `too wide: ${line}`).toBe('fits')
    await term.unmount()
  }
})

// ------------------------------------------------------------------ round three

test('the longest streak, the busiest hours, and measured time', async () => {
  const days: Record<string, DayRecord> = {
    '2026-10-01': day({ other: 1 }),
    '2026-10-02': day({ other: 1 }),
    '2026-10-03': day({ other: 1 }),
    '2026-10-04': day({ other: 1 }),
    '2026-10-06': day({ other: 1 }),
    '2026-11-08': day({ other: 1 }),
    '2026-11-09': day({ other: 1 }),
  }
  expect(longestStreak(days)).toBe(4)
  expect(longestStreak({})).toBe(0)
  const hours = new Array<number>(24).fill(0)
  hours[15] = 5
  hours[16] = 4
  hours[9] = 6
  expect(peakWindow(hours)?.label).toBe('3 pm – 5 pm')
  expect(peakWindow(new Array<number>(24).fill(0))).toBe(null)
  expect(clockHour(0)).toBe('12 am')
  expect(clockHour(12)).toBe('12 pm')
  expect(clockHour(23)).toBe('11 pm')
  expect(formatDuration(30_000)).toBe('<1 min')
  expect(formatDuration(45 * 60_000)).toBe('45 min')
  expect(formatDuration(3.2 * 3_600_000)).toBe('3.2 h')
  expect(leverage(600, 60 * 60_000)).toBe('10×')
  expect(leverage(90, 60 * 60_000)).toBe('1.5×')
  expect(leverage(90, 0)).toBe(null)
})

test('a task adds its working time and hour; odd stored values are dropped', async () => {
  let d = addTask(undefined, 'coding', 'm', 'atlas', { ms: 120_000, hour: 15 })
  d = addTask(d, 'coding', 'm', 'atlas', { ms: 9 * 3_600_000, hour: 15 })
  expect(d.ms).toBe(120_000 + 4 * 3_600_000) // a session left open counts at most 4 hours
  expect(d.hours?.[15]).toBe(2)
  expect(cleanDay({ kinds: { coding: 2 }, models: {}, ms: 5, hours: [1, 2] })?.hours).toBe(undefined)
  expect(cleanDay({ kinds: { coding: 2 }, models: {}, ms: -5 })?.ms).toBe(undefined)
  expect(cleanDay({ kinds: { coding: 'x', other: 1 }, models: { a: 1 } })).toEqual({ kinds: { other: 1 }, models: { a: 1 } })
  expect(cleanDay(null)).toBe(null)
  const csv = csvOf({ '2026-11-09': d }, ['2026-11-08', '2026-11-09'], DEFAULT_SETTINGS).split('\n')
  expect(csv[0]).toBe('date,emails,documents,images,coding,research,other,tasks,minutes_saved_estimate,value_estimate,claude_minutes')
  expect(csv[1]).toBe('2026-11-09,0,0,0,2,0,0,2,40,33.33,242')
  expect(csv).toHaveLength(2)
})

test('the pane shows Claude\'s working time, the busiest hours, and copies a summary', async ($, on) => {
  const hours = new Array<number>(24).fill(0)
  hours[15] = 3
  const clock = engine(on, {
    [`day:${TODAY}`]: { kinds: { coding: 3 }, models: { 'claude-opus-5-5': 3 }, ms: 30 * 60_000, hours },
  })
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...paneAt(surface === 'terminal' ? 60 : 90), surface })
    await ui.press({ key: 'tab-today' })
    const lines = (await rowsOf(ui)).join(' ')
    expect(lines).toContain('Claude worked 30 min on these · about 2.0× that back in your time (estimate)')
    expect(lines).toContain('Busiest 3 pm – 5 pm')
    // A note that does not fit its tile is shortened, never cut mid-number.
    expect(lines).not.toMatch(/\$\d*…/)
    await ui.press({ key: 'copy-summary' })
    await ui.unmount()
  }
  expect(copied).toHaveLength(2)
  expect(copied[0]).toContain('3 tasks finished · about 1 hours saved · worth about $50 (estimate at $50/h)')
  expect(copied[0]).toContain('Coding 3')

  const viaCommand = await $.command.run({ command: 'report', args: 'export' } as never)
  expect(viaCommand.text).toContain('Copied this year as CSV')
  expect(copied[2]).toContain(`${TODAY},0,0,0,3,0,0,3,60,50.00,30`)
})

test('a rebuild keeps saved days older than the history it can still read', async ($, on) => {
  const at = (d: number, hour: number) => new Date(2026, 10, d, hour).getTime()
  const clock = engine(on, {
    'day:2026-03-15': day({ documents: 4 }), // saved long ago; Claude Code has since deleted its transcript
    'day:2026-11-02': day({ other: 9 }), // inside the history: replaced by what the history says
  })
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: JSON.stringify({
        models: ['claude-opus-5-5'],
        cwds: ['/Users/me/atlas'],
        earliest: at(2, 9),
        tasks: [[at(2, 10), 0, ['Bash'], 0, 60_000]],
      }),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...paneAt(90), surface: 'desktop' })
  await ui.press({ key: 'tab-year' })
  const all = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt)).join('\n')
  expect(all).toContain('TASKS DONE 5') // March's 4 kept, November 2 now its 1
  expect(all).toContain('Documents 4 tasks')
  expect(all).toContain('Coding 1 tasks')
  await ui.unmount()
})

test('a rebuild with no history at all replaces nothing', async ($, on) => {
  const clock = engine(on, { 'day:2026-03-15': day({ documents: 4 }), 'day:2026-11-02': day({ other: 9 }) })
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: JSON.stringify({ models: [], cwds: [], tasks: [], earliest: null }),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...paneAt(90), surface: 'desktop' })
  await ui.press({ key: 'tab-year' })
  const all = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt)).join('\n')
  expect(all).toContain('TASKS DONE 13')
  await ui.unmount()
})

test('a task that finishes while history is being rebuilt is neither lost nor counted twice', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const clock = engine(on, { [`day:${TODAY}`]: day({ other: 2 }) })
  on('process.run', async () => {
    await gate // the history scan is still running
    return {
      value: {
        exitCode: 0,
        stdout: JSON.stringify({
          models: ['claude-opus-5-5'],
          cwds: ['/Users/me/atlas'],
          earliest: NOW - 3_600_000,
          tasks: [[NOW - 3_600_000, 0, ['WebSearch'], 0, 60_000]],
        }),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  // A typed request finishes while the scan waits.
  await $.prompt.submit({ text: 'draft the memo', wait: false, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'draft the memo', turnId: 'r1' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/memo.docx', content: 'x' } as never)
  await $.turn.complete({ turnId: 'r1', answer: 'done', durationMs: 5000, isAborted: false, reason: 'answer', usage: { ...USAGE, model: 'claude-opus-5-5' } } as never)

  release()
  await clock.settle()
  const ui = await $.ui.mount({ ...paneAt(90), surface: 'desktop' })
  await ui.press({ key: 'tab-today' })
  const all = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt)).join('\n')
  // The history's one task (research) plus the live one (documents); the two
  // old stored tasks were replaced by the history.
  expect(all).toContain('TASKS DONE 2')
  expect(all).toContain('Research 1 tasks')
  expect(all).toContain('Documents 1 tasks')
  await ui.unmount()
})
