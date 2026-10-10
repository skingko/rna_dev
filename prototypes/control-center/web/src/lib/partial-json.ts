/**
 * Tolerant reader for a streaming JSON object prefix (tool arguments while the
 * model is still writing them). Returns the top-level string fields among
 * `keys` seen so far; an unterminated last string is returned as far as it has
 * arrived. Never throws; nested values and non-strings are skipped. Mirrors
 * `partialJsonFields` in the host's live-bus.mjs.
 */
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

export const TARGET_FIELDS = ['path', 'file_path', 'command', 'query', 'pattern', 'url', 'uri', 'id', 'name', 'task'] as const

export function partialJsonFields(text: string | null | undefined, keys: readonly string[] = ['path', 'command', 'query', 'url']): Record<string, string> {
  const out: Record<string, string> = {}
  const wanted = new Set(keys)
  const source = typeof text === 'string' ? text : ''
  let i = source.indexOf('{')
  if (i < 0) return out
  const readString = (): [string, boolean] => {
    let value = ''
    i++
    while (i < source.length) {
      const char = source[i]
      if (char === '"') { i++; return [value, true] }
      if (char !== '\\') { value += char; i++; continue }
      const next = source[i + 1]
      if (next === undefined) break
      if (next === 'u') {
        const hex = source.slice(i + 2, i + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
        value += String.fromCharCode(parseInt(hex, 16)); i += 6; continue
      }
      value += ESCAPES[next] ?? next; i += 2
    }
    i = source.length
    return [value, false]
  }
  let depth = 0
  let key: string | null = null
  let expect: 'key' | 'colon' | 'value' | 'next' = 'key'
  while (i < source.length) {
    const char = source[i]
    if (char === '"') {
      if (depth !== 1) { readString(); continue }
      const [value, complete] = readString()
      if (expect === 'key') { key = complete ? value : null; expect = 'colon' }
      else if (expect === 'value') { if (key !== null && wanted.has(key) && !Object.hasOwn(out, key)) out[key] = value; expect = 'next' }
      continue
    }
    if (char === '{' || char === '[') { if (depth === 1 && expect === 'value') expect = 'next'; depth++ }
    else if (char === '}' || char === ']') { depth--; if (depth <= 0) break }
    else if (depth === 1 && char === ':' && expect === 'colon') expect = 'value'
    else if (depth === 1 && char === ',') { expect = 'key'; key = null }
    else if (depth === 1 && expect === 'value' && !/\s/.test(char)) expect = 'next'
    i++
  }
  return out
}
