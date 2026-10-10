import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// zustand 5 selectors run inside useSyncExternalStore: one that builds a new
// array or object on every call (filter, map, `?? []`, a literal) never settles
// and React stops the whole app with "Maximum update depth exceeded" (0.39.0's
// OutboxStrip). Select the stored value and derive outside, or use useShallow.
const HOOKS = ['useApp', 'useOutbox', 'useTasks', 'useMind', 'useInbox', 'useConfiguration', 'usePanels', 'useGlobals', 'usePreferences', 'useTimelineFocus', 'useSkillCatalogs', 'useSidePanel', 'useUi', 'useFeedback', 'useSeen', 'useChangeDetail', 'useBackgroundLive', 'useSessionAgents', 'usePreviews', 'useSurfaceRouter', 'useGitStatus']
const ALLOCATING_CALLS = new Set(['filter', 'map', 'slice', 'concat', 'flatMap', 'sort', 'toSorted', 'reverse', 'keys', 'values', 'entries', 'fromEntries', 'assign'])

/** Index of the parenthesis/bracket/brace matching the closing one at `end`. */
function opening(text: string, end: number) {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  const stack: string[] = []
  for (let index = end; index >= 0; index--) {
    const char = text[index]
    if (char in pairs) stack.push(pairs[char])
    else if (char === stack.at(-1)) { stack.pop(); if (!stack.length) return index }
  }
  return -1
}
/** Whether an arrow body's value is a fresh array or object on every call (`… .filter(…)`, `x ?? []`, `({ … })`, `[ … ]`). */
function allocates(body: string): boolean {
  let text = body.trim()
  if (!text || text.startsWith('{')) return false // a block body: not judged here
  // Unwrap parentheses around the whole expression, then judge each branch of a top-level ternary by its tail.
  while (text.startsWith('(') && text.endsWith(')') && opening(text, text.length - 1) === 0) {
    const inner = text.slice(1, -1).trim()
    if (inner.startsWith('{')) return true // ({ … })
    text = inner
  }
  if (/\?\?\s*(\[\]|\{\})$/.test(text) || text.startsWith('[')) return true
  if (!text.endsWith(')')) return false
  const open = opening(text, text.length - 1)
  const name = /\.?([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(0, open))
  return Boolean(name && ALLOCATING_CALLS.has(name[1]) && name[0].startsWith('.'))
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : []
  })
}
/** The selector text of each single-line `useX(s => …)` call, up to its closing parenthesis. */
function selectors(source: string) {
  const found: { hook: string; text: string; line: number }[] = []
  const pattern = new RegExp(`\\b(${HOOKS.join('|')})\\(\\s*\\(?([a-z]+)\\)?\\s*=>`, 'g')
  for (const match of source.matchAll(pattern)) {
    let depth = 1, index = match.index! + match[0].length
    const start = source.lastIndexOf('(', index) + 1
    while (index < source.length && depth) { const char = source[index]; if (char === '(') depth++; else if (char === ')') depth--; index++ }
    found.push({ hook: match[1], text: source.slice(start, index - 1), line: source.slice(0, match.index).split('\n').length })
  }
  return found
}

describe('store selectors', () => {
  it('recognize a selector that allocates', () => {
    expect(allocates(' s.entries.filter(row => row.sessionId === id)')).toBe(true)
    expect(allocates(' s.value?.providers ?? []')).toBe(true)
    expect(allocates(' ({ a: s.a })')).toBe(true)
    expect(allocates(' s.entries')).toBe(false)
    expect(allocates(" (running ? '' : processSummary(ids.map(id => s.items[id]).filter(Boolean)))")).toBe(false)
    expect(allocates(' Object.values(s.projects).filter(p => p.archivedAt).length')).toBe(false)
  })
  it('never allocate a new array or object on each call', () => {
    const offenders: string[] = []
    for (const file of files(join(__dirname, '..'))) {
      const source = readFileSync(file, 'utf8')
      for (const row of selectors(source)) {
        const body = row.text.slice(row.text.indexOf('=>') + 2)
        if (allocates(body)) offenders.push(`${file.split('/src/')[1]}:${row.line} ${row.hook}(${row.text.trim().slice(0, 120)})`)
      }
    }
    expect(offenders).toEqual([])
  })
})
