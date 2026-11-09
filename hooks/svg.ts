// The graphical pane (desktop, the editor, mobile): each section one crisp SVG,
// drawn at the pane's width in CSS pixels. Pure string building, no `$`.

import { GOLD, HAIRLINE, MUTED, TEXT } from './logic'
import type { Chart } from './logic'

const FONT = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', system-ui, sans-serif`
const CARD = '#11161D'
const TRACK = '#1A2028'
const BLUE = '#58A6FF'

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** A rough width of a text run at a size, for laying out without a font metric. */
export function textPx(text: string, size: number, weight = 400, spacing = 0): number {
  const per = weight >= 600 ? 0.6 : 0.55
  return [...text].length * (size * per + spacing)
}

function svg(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" text-rendering="geometricPrecision" shape-rendering="geometricPrecision">${body}</svg>`
}

/** The pane's width in CSS pixels, from its width in the surface's monospace cells. */
export function pixelWidth(columns: number): number {
  return Math.max(260, Math.round(columns * 7.6))
}

// -------------------------------------------------------------- header

export function headerSvg(width: number, title: string, dates: string): string {
  const titleW = textPx(title, 15, 700, 1.6)
  const datesFit = titleW + 16 + textPx(dates, 12) <= width
  const height = datesFit ? 34 : 52
  const datesY = datesFit ? 20 : 40
  const datesX = datesFit ? width : 0
  const anchor = datesFit ? 'end' : 'start'
  const ruleY = height - 4
  return svg(
    width,
    height,
    `<text x="0" y="20" fill="${TEXT}" font-size="15" font-weight="700" letter-spacing="1.6">${esc(title)}</text>` +
      `<text x="${datesX}" y="${datesY}" fill="${MUTED}" font-size="12" text-anchor="${anchor}">${esc(dates)}</text>` +
      `<rect x="0" y="${ruleY}" width="${Math.min(width, titleW).toFixed(1)}" height="2" rx="1" fill="${GOLD}"/>` +
      `<rect x="${Math.min(width, titleW).toFixed(1)}" y="${ruleY + 0.5}" width="${Math.max(0, width - titleW).toFixed(1)}" height="1" fill="${HAIRLINE}"/>`,
  )
}

// -------------------------------------------------------------- tiles

export type Tile = { label: string; value: string; note: string; color: string; change?: { text: string; color: string } }

export function tilesAcross(width: number): number {
  if (width >= 520) return 3
  if (width >= 340) return 2
  return 1
}

export function tilesSvg(width: number, tiles: readonly Tile[]): string {
  const across = tilesAcross(width)
  if (across === 1) return tileRowsSvg(width, tiles)
  const gap = 12
  const cardW = (width - gap * (across - 1)) / across
  const cardH = tiles.some(t => t.change) ? 124 : 108
  const rows = Math.ceil(tiles.length / across)
  const height = rows * cardH + (rows - 1) * gap
  let body = ''
  tiles.forEach((t, i) => {
    const x = (i % across) * (cardW + gap)
    const y = Math.floor(i / across) * (cardH + gap)
    const inner = cardW - 36
    const size = Math.max(16, Math.min(36, inner / Math.max(1, [...t.value].length * 0.6)))
    body +=
      `<rect x="${(x + 0.5).toFixed(1)}" y="${y + 0.5}" width="${(cardW - 1).toFixed(1)}" height="${cardH - 1}" rx="14" fill="${CARD}" stroke="${HAIRLINE}"/>` +
      `<text x="${(x + 18).toFixed(1)}" y="${y + 28}" fill="${MUTED}" font-size="11" font-weight="600" letter-spacing="1.2">${esc(t.label)}</text>` +
      `<text x="${(x + 18).toFixed(1)}" y="${y + 72}" fill="${t.color}" font-size="${size.toFixed(1)}" font-weight="650" letter-spacing="-0.5" font-variant-numeric="tabular-nums">${esc(t.value)}</text>` +
      `<text x="${(x + 18).toFixed(1)}" y="${y + 94}" fill="${MUTED}" font-size="11">${esc(t.note)}</text>` +
      (t.change
        ? `<text x="${(x + 18).toFixed(1)}" y="${y + 112}" fill="${t.change.color}" font-size="11" font-weight="600">${esc(t.change.text)}</text>`
        : '')
  })
  return svg(width, height, body)
}

/** A narrow pane's tiles: one short card per figure, words left and the number right. */
function tileRowsSvg(width: number, tiles: readonly Tile[]): string {
  const gap = 10
  const cardH = 76
  const height = tiles.length * cardH + (tiles.length - 1) * gap
  let body = ''
  tiles.forEach((t, i) => {
    const y = i * (cardH + gap)
    const room = Math.max(60, width * 0.5 - 18)
    const size = Math.max(16, Math.min(32, room / Math.max(1, [...t.value].length * 0.6)))
    body +=
      `<rect x="0.5" y="${y + 0.5}" width="${width - 1}" height="${cardH - 1}" rx="12" fill="${CARD}" stroke="${HAIRLINE}"/>` +
      `<text x="16" y="${y + 26}" fill="${MUTED}" font-size="11" font-weight="600" letter-spacing="1.2">${esc(t.label)}</text>` +
      `<text x="16" y="${y + 46}" fill="${MUTED}" font-size="11">${esc(t.note)}</text>` +
      (t.change
        ? `<text x="16" y="${y + 63}" fill="${t.change.color}" font-size="11" font-weight="600">${esc(t.change.text)}</text>`
        : '') +
      `<text x="${width - 16}" y="${y + 50}" fill="${t.color}" font-size="${size.toFixed(1)}" font-weight="650" text-anchor="end" letter-spacing="-0.5" font-variant-numeric="tabular-nums">${esc(t.value)}</text>`
  })
  return svg(width, height, body)
}

// -------------------------------------------------------------- section heading

function heading(width: number, text: string): string {
  const w = [...text].length * (11 * 0.68 + 1.2) + 4 // capitals run wider than mixed case
  return (
    `<text x="0" y="12" fill="${MUTED}" font-size="11" font-weight="600" letter-spacing="1.2">${esc(text)}</text>` +
    `<rect x="${(w + 10).toFixed(1)}" y="8" width="${Math.max(0, width - w - 10).toFixed(1)}" height="1" fill="${HAIRLINE}"/>`
  )
}

// -------------------------------------------------------------- bar rows

export type BarRow = { label: string; value: number; color: string; right: string; dim?: boolean }

export function barsSvg(width: number, title: string, rows: readonly BarRow[], showRight: boolean): string {
  const rowH = 30
  const top = 28
  const height = top + rows.length * rowH
  const labelW = width >= 420 ? 150 : width >= 320 ? 120 : 96
  const countW = 40
  const rightW = showRight ? (width >= 320 ? 64 : 54) : 0
  const barX = labelW
  const barW = Math.max(24, width - labelW - countW - rightW - 12)
  const max = Math.max(1, ...rows.map(r => r.value))
  let body = heading(width, title)
  rows.forEach((r, i) => {
    const y = top + i * rowH
    const cy = y + 15
    const fill = r.value > 0 ? Math.max(6, (r.value / max) * barW) : 0
    const textColor = r.dim ? MUTED : TEXT
    body +=
      `<circle cx="5" cy="${cy}" r="4" fill="${r.color}"${r.dim ? ' opacity="0.45"' : ''}/>` +
      `<text x="16" y="${cy + 4.5}" fill="${textColor}" font-size="13">${esc(clip(r.label, labelW - 22, 13))}</text>` +
      `<rect x="${barX}" y="${cy - 4}" width="${barW.toFixed(1)}" height="8" rx="4" fill="${TRACK}"/>` +
      (fill > 0 ? `<rect x="${barX}" y="${cy - 4}" width="${fill.toFixed(1)}" height="8" rx="4" fill="${r.color}"/>` : '') +
      `<text x="${(barX + barW + 12 + countW - 4).toFixed(1)}" y="${cy + 4.5}" fill="${textColor}" font-size="13" font-weight="600" text-anchor="end" font-variant-numeric="tabular-nums">${r.value}</text>` +
      (showRight
        ? `<text x="${width}" y="${cy + 4.5}" fill="${MUTED}" font-size="12" text-anchor="end" font-variant-numeric="tabular-nums">${esc(r.right)}</text>`
        : '')
  })
  return svg(width, height, body)
}

function clip(text: string, px: number, size: number): string {
  const max = Math.max(3, Math.floor(px / (size * 0.5)))
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…'
}

// -------------------------------------------------------------- chart

export function chartSvg(width: number, title: string, chart: Chart, labels: readonly string[]): string {
  const top = 28
  const valueRoom = 16
  const plotH = 96
  const labelRoom = 22
  const height = top + valueRoom + plotH + labelRoom
  const n = chart.values.length
  const slot = width / n
  const barW = Math.max(2, Math.min(30, slot * (n > 12 ? 0.68 : 0.56)))
  const max = Math.max(1, ...chart.values)
  const base = top + valueRoom + plotH
  let body = heading(width, title)
  body += `<rect x="0" y="${base}" width="${width}" height="1" fill="${HAIRLINE}"/>`
  const showValues = n <= 12 && slot >= 22
  const active = chart.values.filter((v, i) => !chart.future[i])
  const average = active.length > 0 ? active.reduce((a, b) => a + b, 0) / active.length : 0
  // The average line and its label go over the bars: drawn after them.
  let overlay = ''
  if (n > 7 && average > 0) {
    const ay = base - (average / max) * plotH
    const label = `avg ${average < 10 ? average.toFixed(1) : Math.round(average)}`
    overlay +=
      `<line x1="0" x2="${width}" y1="${ay.toFixed(1)}" y2="${ay.toFixed(1)}" stroke="${MUTED}" stroke-width="1" stroke-dasharray="3 4" opacity="0.7"/>` +
      `<rect x="${(width - textPx(label, 10) - 8).toFixed(1)}" y="${(ay - 15).toFixed(1)}" width="${(textPx(label, 10) + 8).toFixed(1)}" height="14" rx="3" fill="#0D1117" opacity="0.9"/>` +
      `<text x="${width - 4}" y="${(ay - 4.5).toFixed(1)}" fill="${MUTED}" font-size="10" text-anchor="end">${label}</text>`
  }
  chart.values.forEach((v, i) => {
    const cx = slot * i + slot / 2
    const x = cx - barW / 2
    const isFuture = chart.future[i] === true
    const isCurrent = i === chart.current
    if (!isFuture) {
      if (v > 0) {
        const bh = Math.max(4, (v / max) * plotH)
        const r = Math.min(4, barW / 2)
        const color = isCurrent ? GOLD : BLUE
        const opacity = isCurrent ? 1 : 0.78
        body += `<path d="${roundedTop(x, base - bh, barW, bh, r)}" fill="${color}" opacity="${opacity}"/>`
        if (showValues) {
          body += `<text x="${cx.toFixed(1)}" y="${(base - bh - 5).toFixed(1)}" fill="${isCurrent ? GOLD : MUTED}" font-size="11" text-anchor="middle" font-variant-numeric="tabular-nums">${v}</text>`
        }
      } else {
        body += `<rect x="${x.toFixed(1)}" y="${base - 2}" width="${barW.toFixed(1)}" height="2" rx="1" fill="${HAIRLINE}"/>`
      }
    } else {
      body += `<rect x="${(x + 0.5).toFixed(1)}" y="${(base - 12).toFixed(1)}" width="${Math.max(1, barW - 1).toFixed(1)}" height="12" rx="2" fill="none" stroke="${HAIRLINE}" stroke-dasharray="2 2"/>`
    }
    const label = labels[i] ?? ''
    if (label !== '') {
      body += `<text x="${cx.toFixed(1)}" y="${base + 16}" fill="${isCurrent ? TEXT : MUTED}" font-size="11"${isCurrent ? ' font-weight="600"' : ''} text-anchor="middle">${esc(label)}</text>`
    }
  })
  body += overlay
  return svg(width, height, body)
}

function roundedTop(x: number, y: number, w: number, barH: number, r: number): string {
  const rr = Math.min(r, barH)
  return `M${x.toFixed(1)},${(y + barH).toFixed(1)} V${(y + rr).toFixed(1)} Q${x.toFixed(1)},${y.toFixed(1)} ${(x + rr).toFixed(1)},${y.toFixed(1)} H${(x + w - rr).toFixed(1)} Q${(x + w).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + rr).toFixed(1)} V${(y + barH).toFixed(1)} Z`
}


// -------------------------------------------------------------- year heatmap

const HEAT = ['#161B22', '#3B2F17', '#6B5222', '#B08A3E', '#F2C46D']

/** The level of a day's count among the year's: 0 for none, 1 to 4 by quartile of the busy days. */
export function heatLevel(total: number, cuts: readonly number[]): number {
  if (total <= 0) return 0
  let level = 1
  for (const cut of cuts) if (total > cut) level += 1
  return Math.min(4, level)
}

/** A calendar of the year, one square per day, weeks as columns, as GitHub draws contributions. */
export function heatmapSvg(width: number, title: string, days: ReadonlyArray<{ key: string; total: number | null }>, firstWeekday: number, today: string): string {
  const top = 28
  const left = 26
  const weeks = Math.ceil((days.length + firstWeekday) / 7)
  let gap = 3
  let cell = Math.min(18, Math.floor((width - left - (weeks - 1) * gap) / weeks))
  // Too narrow for the whole year at a readable size: the latest weeks that fit.
  let firstCol = 0
  if (cell < 8) {
    gap = 2
    cell = 8
    const fit = Math.max(1, Math.floor((width - left + gap) / (cell + gap)))
    const todayIndex = Math.max(0, days.findIndex(d => d.key === today))
    const todayCol = Math.floor((todayIndex + firstWeekday) / 7)
    firstCol = Math.max(0, todayCol - fit + 1)
  }
  const shownWeeks = Math.min(weeks - firstCol, Math.floor((width - left + gap) / (cell + gap)))
  const gridW = shownWeeks * cell + (shownWeeks - 1) * gap
  const height = top + 16 + 7 * cell + 6 * gap + 26
  const busy = days.map(d => d.total ?? 0).filter(n => n > 0).sort((a, b) => a - b)
  const q = (f: number) => busy[Math.min(busy.length - 1, Math.floor(busy.length * f))] ?? 0
  const cuts = busy.length > 0 ? [q(0.25), q(0.5), q(0.75)] : []
  let body = heading(width, title)
  let lastMonth = -1
  let lastLabelX = -100
  days.forEach((d, i) => {
    const slot = i + firstWeekday
    const col = Math.floor(slot / 7) - firstCol
    if (col < 0 || col >= shownWeeks) return
    const row = slot % 7
    const x = left + col * (cell + gap)
    const y = top + 16 + row * (cell + gap)
    const month = Number(d.key.slice(5, 7)) - 1
    // A month's name over the first week it starts in, when there is room.
    if (month !== lastMonth) {
      if (x - lastLabelX >= 28) {
        body += `<text x="${x}" y="${top + 10}" fill="${MUTED}" font-size="10">${MONTHS_SHORT[month]}</text>`
        lastLabelX = x
      }
      lastMonth = month
    }
    if (d.total === null) {
      body += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="none" stroke="${HAIRLINE}" stroke-width="0.6"/>`
    } else {
      const fill = HEAT[heatLevel(d.total, cuts)] ?? HEAT[0]
      const ring = d.key === today ? ` stroke="${TEXT}" stroke-width="1"` : ''
      body += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${fill}"${ring}><title>${d.key}: ${d.total} tasks</title></rect>`
    }
  })
  ;['Mon', 'Wed', 'Fri'].forEach((label, i) => {
    const row = i * 2 + 1
    body += `<text x="0" y="${top + 16 + row * (cell + gap) + cell - 2}" fill="${MUTED}" font-size="9">${label}</text>`
  })
  const legendY = top + 16 + 7 * cell + 6 * gap + 18
  const lx = Math.min(width, left + gridW) - (HEAT.length * (cell + 3)) - 64
  body += `<text x="${lx}" y="${legendY}" fill="${MUTED}" font-size="10">Less</text>`
  HEAT.forEach((c, i) => {
    body += `<rect x="${lx + 28 + i * (cell + 3)}" y="${legendY - cell + 2}" width="${cell}" height="${cell}" rx="2" fill="${c}"/>`
  })
  body += `<text x="${lx + 32 + HEAT.length * (cell + 3)}" y="${legendY}" fill="${MUTED}" font-size="10">More</text>`
  return svg(width, height, body)
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
