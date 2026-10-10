/**
 * Minimal SGR (ANSI color) parser: turns terminal output into styled spans.
 * Supports reset, bold, dim, italic, underline, 8/16 colors and 256/truecolor
 * foregrounds. Other escape sequences are dropped.
 */
export interface AnsiSpan { text: string; fg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }

// Palette resolves through CSS variables so light/dark both read well.
const BASE = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
const colorVar = (i: number, bright: boolean) => `var(--ansi-${bright ? 'bright-' : ''}${BASE[i]})`

function xterm256(n: number): string {
  if (n < 8) return colorVar(n, false)
  if (n < 16) return colorVar(n - 8, true)
  if (n < 232) {
    const c = n - 16
    const r = Math.floor(c / 36), g = Math.floor((c % 36) / 6), b = c % 6
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40)
    return `rgb(${v(r)} ${v(g)} ${v(b)})`
  }
  const l = 8 + (n - 232) * 10
  return `rgb(${l} ${l} ${l})`
}

// eslint-disable-next-line no-control-regex
const ESC = /\u001b\[([0-9;]*)([A-Za-z])|\u001b\][^\u0007]*\u0007|\r/g

export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = []
  let state: Omit<AnsiSpan, 'text'> = {}
  let last = 0
  const push = (text: string) => { if (text) spans.push({ text, ...state }) }
  for (const match of input.matchAll(ESC)) {
    push(input.slice(last, match.index))
    last = (match.index ?? 0) + match[0].length
    if (match[2] !== 'm') continue
    const codes = (match[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 0) state = {}
      else if (c === 1) state = { ...state, bold: true }
      else if (c === 2) state = { ...state, dim: true }
      else if (c === 3) state = { ...state, italic: true }
      else if (c === 4) state = { ...state, underline: true }
      else if (c === 22) state = { ...state, bold: false, dim: false }
      else if (c === 23) state = { ...state, italic: false }
      else if (c === 24) state = { ...state, underline: false }
      else if (c >= 30 && c <= 37) state = { ...state, fg: colorVar(c - 30, false) }
      else if (c >= 90 && c <= 97) state = { ...state, fg: colorVar(c - 90, true) }
      else if (c === 39) state = { ...state, fg: undefined }
      else if (c === 38 && codes[i + 1] === 5) { state = { ...state, fg: xterm256(codes[i + 2]) }; i += 2 }
      else if (c === 38 && codes[i + 1] === 2) { state = { ...state, fg: `rgb(${codes[i + 2]} ${codes[i + 3]} ${codes[i + 4]})` }; i += 4 }
    }
  }
  push(input.slice(last))
  return spans
}

export function stripAnsi(input: string): string {
  return input.replace(ESC, '')
}
