// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAst } from 'rolldown/parseAst'
import { en } from './en'
import { interpolate, localized, translate } from './index'
import { usePreferences } from '@/components/settings/preferences'

const CJK = /[　-〿一-鿿＀-￯]/
const names = (text: string) => [...text.matchAll(/\{(\w+)(?:\|[^{}]*)?\}/g)].map(m => m[1]).sort()

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'i18n' || name === 'mock' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.(spec|test)\.tsx?$/.test(name) ? [path] : []
  })
}

describe('i18n catalogs', () => {
  it('keeps every placeholder of the source string in the English text', () => {
    const set = (text: string) => JSON.stringify([...new Set(names(text))])
    const broken = Object.entries(en).filter(([zh, text]) => set(zh) !== set(text)).map(([zh, text]) => `${zh} => ${text}`)
    expect(broken).toEqual([])
  })

  it('covers every Chinese value in module-level localized() tables', () => {
    const missing: string[] = []
    const root = join(__dirname, '..')
    for (const file of sources(root)) {
      const src = readFileSync(file, 'utf8')
      if (!src.includes('localized(')) continue
      const ast = parseAst(src, { lang: file.endsWith('x') ? 'tsx' : 'ts' }, file)
      const walk = (node: unknown, inside: boolean): void => {
        if (!node || typeof node !== 'object') return
        const n = node as Record<string, unknown> & { type?: string; callee?: { type: string; name?: string }; value?: unknown }
        const loc = inside || (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'localized')
        if (loc && n.type === 'Literal' && typeof n.value === 'string' && CJK.test(n.value) && !(n.value in en)) missing.push(`${file}: ${n.value}`)
        for (const [key, value] of Object.entries(n)) {
          if (key === 'key' && n.type === 'Property') continue
          if (Array.isArray(value)) value.forEach(child => walk(child, loc))
          else if (value && typeof value === 'object') walk(value, loc)
        }
      }
      walk(ast, false)
    }
    expect(missing).toEqual([])
  })

  /**
   * Every Chinese UI literal outside the catalogs, mocks and tests must go through
   * the i18n layer: a `t()` / `tr()` / `translate()` / `localized()` argument, or a
   * value in a `MessageKey`-typed table (checked against the English catalog).
   * Comparisons and string-matching calls (`includes`, `split`, …) are data, not UI.
   * Deliberate exceptions carry an `i18n-ignore` comment on the same or preceding line.
   */
  it('leaves no untranslated Chinese literal in web/src', () => {
    const WRAP = new Set(['t', 'tr', 'translate', 'localized'])
    const MATCH = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'split', 'replace', 'replaceAll', 'match', 'search', 'test', 'localeCompare', 'getItem', 'setItem', 'has', 'get'])
    const found: string[] = []
    for (const file of sources(join(__dirname, '..'))) {
      const src = readFileSync(file, 'utf8')
      if (!CJK.test(src)) continue
      const lineOf = (pos: number) => src.slice(0, pos).split('\n').length
      const ignored = new Set(src.split('\n').flatMap((line, i) => (line.includes('i18n-ignore') ? [i + 1, i + 2] : [])))
      const ast = parseAst(src, { lang: file.endsWith('x') ? 'tsx' : 'ts' }, file)
      type N = Record<string, unknown> & { type?: string; start: number; end: number }
      const typed = (n: N) => {
        const ann = (n.id as N | undefined)?.typeAnnotation ?? n.typeAnnotation ?? n.returnType
        return Boolean(ann && typeof ann === 'object' && src.slice((ann as N).start, (ann as N).end).includes('MessageKey'))
      }
      const walk = (node: unknown, keyTyped: boolean, parent?: N): void => {
        if (!node || typeof node !== 'object') return
        const n = node as N
        if (typeof n.type !== 'string') return
        if (ignored.has(lineOf(n.start))) return
        const callee = n.callee as N & { name?: string; property?: N & { name?: string }; object?: N } | undefined
        if (n.type === 'CallExpression' && callee?.type === 'Identifier' && WRAP.has(callee.name!)) return
        if (n.type === 'CallExpression' && callee?.type === 'MemberExpression' && MATCH.has(callee.property?.name ?? '')) { walk(callee.object, keyTyped, n); return }
        if (n.type === 'BinaryExpression' && ['===', '!==', '==', '!=', 'in'].includes(n.operator as string)) return
        if (['ImportDeclaration', 'TSLiteralType', 'SwitchCase', 'TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(n.type)) return
        const inKeyTable = keyTyped || typed(n)
        let text: string | null = null
        if (n.type === 'Literal' && typeof n.value === 'string') text = n.value
        else if (n.type === 'JSXText') text = n.value as string
        else if (n.type === 'TemplateLiteral') text = (n.quasis as { value: { cooked: string } }[]).map(q => q.value.cooked).join('{}')
        const isKey = parent?.type === 'Property' && parent.key === n
        if (text && CJK.test(text) && !isKey && !(inKeyTable && n.type === 'Literal' && text in en)) found.push(`${file.slice(file.indexOf('src/'))}:${lineOf(n.start)} ${text.trim().slice(0, 60)}`)
        for (const value of Object.values(n)) {
          if (Array.isArray(value)) value.forEach(child => walk(child, inKeyTable, n))
          else if (value && typeof value === 'object') walk(value, inKeyTable, n)
        }
      }
      walk(ast, false)
    }
    expect(found).toEqual([])
  })

  it('interpolates values and English plurals', () => {
    expect(interpolate('{n} {n|session|sessions}', { n: 1 })).toBe('1 session')
    expect(interpolate('{n} {n|session|sessions}', { n: 3 })).toBe('3 sessions')
    expect(interpolate('keep {missing}', {})).toBe('keep {missing}')
    expect(translate('en', '{count} 个会话 · {date} 归档', { count: 2, date: '9/28' })).toBe('2 sessions · archived 9/28')
    expect(translate('zh-CN', '{count} 个会话 · {date} 归档', { count: 2, date: '9/28' })).toBe('2 个会话 · 9/28 归档')
  })

  it('translates localized tables at read time, following the language preference', () => {
    const table = localized({ a: '仅收件箱', nested: [{ label: '每日摘要' }], plain: 'x' })
    usePreferences.setState({ language: 'en' })
    expect([table.a, table.nested[0].label, table.plain]).toEqual(['Inbox only', 'Daily digest', 'x'])
    usePreferences.setState({ language: 'zh' })
    expect(table.a).toBe('仅收件箱')
  })
})
