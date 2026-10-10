/**
 * Lazy Shiki. Loaded on first code block; uses the JavaScript regex engine
 * (no WASM, CSP-friendly) and dual themes emitted as CSS variables so light
 * and dark switch without re-highlighting.
 */
import type { HighlighterCore } from 'shiki/core'

export interface Token { content: string; style?: Record<string, string> }

const LANGS: Record<string, () => Promise<unknown>> = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  // File preview (components/preview): loaded only when such a file is opened.
  'toml': () => import('shiki/langs/toml.mjs'),
  'ini': () => import('shiki/langs/ini.mjs'),
  'powershell': () => import('shiki/langs/powershell.mjs'),
  'java': () => import('shiki/langs/java.mjs'),
  'kotlin': () => import('shiki/langs/kotlin.mjs'),
  'swift': () => import('shiki/langs/swift.mjs'),
  'scala': () => import('shiki/langs/scala.mjs'),
  'c': () => import('shiki/langs/c.mjs'),
  'cpp': () => import('shiki/langs/cpp.mjs'),
  'csharp': () => import('shiki/langs/csharp.mjs'),
  'objective-c': () => import('shiki/langs/objective-c.mjs'),
  'ruby': () => import('shiki/langs/ruby.mjs'),
  'php': () => import('shiki/langs/php.mjs'),
  'lua': () => import('shiki/langs/lua.mjs'),
  'r': () => import('shiki/langs/r.mjs'),
  'dart': () => import('shiki/langs/dart.mjs'),
  'perl': () => import('shiki/langs/perl.mjs'),
  'elixir': () => import('shiki/langs/elixir.mjs'),
  'scss': () => import('shiki/langs/scss.mjs'),
  'less': () => import('shiki/langs/less.mjs'),
  'vue': () => import('shiki/langs/vue.mjs'),
  'svelte': () => import('shiki/langs/svelte.mjs'),
  'graphql': () => import('shiki/langs/graphql.mjs'),
  'proto': () => import('shiki/langs/proto.mjs'),
  'xml': () => import('shiki/langs/xml.mjs'),
  'dockerfile': () => import('shiki/langs/dockerfile.mjs'),
  'makefile': () => import('shiki/langs/makefile.mjs'),
  'cmake': () => import('shiki/langs/cmake.mjs'),
  'latex': () => import('shiki/langs/latex.mjs'),
  'groovy': () => import('shiki/langs/groovy.mjs'),
  'hcl': () => import('shiki/langs/hcl.mjs'),
  'nix': () => import('shiki/langs/nix.mjs'),
  'zig': () => import('shiki/langs/zig.mjs'),
}
const ALIAS: Record<string, string> = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', py: 'python', md: 'markdown', yml: 'yaml', rs: 'rust', htm: 'html', svg: 'xml', 'c++': 'cpp', 'c#': 'csharp', cs: 'csharp', kt: 'kotlin', rb: 'ruby', ps1: 'powershell', docker: 'dockerfile', make: 'makefile', tex: 'latex', tf: 'hcl', proto3: 'proto', jsonc: 'json', objc: 'objective-c' }

let highlighter: Promise<HighlighterCore> | null = null
const loaded = new Set<string>()
const cache = new Map<string, Token[][]>()

function getHighlighter() {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark-dimmed.mjs'),
    ])
    return createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() })
  })()
  return highlighter
}

export function normalizeLang(lang?: string): string | null {
  if (!lang) return null
  const id = ALIAS[lang.toLowerCase()] ?? lang.toLowerCase()
  return LANGS[id] ? id : null
}

export function cachedTokens(code: string, lang: string): Token[][] | undefined {
  return cache.get(`${lang}\u0000${code}`)
}

export async function highlight(code: string, rawLang: string): Promise<Token[][] | null> {
  const lang = normalizeLang(rawLang)
  if (!lang) return null
  const key = `${lang}\u0000${code}`
  const hit = cache.get(key)
  if (hit) return hit
  const hl = await getHighlighter()
  if (!loaded.has(lang)) {
    const mod = (await LANGS[lang]()) as { default: Parameters<HighlighterCore['loadLanguage']>[0] }
    await hl.loadLanguage(mod.default)
    loaded.add(lang)
  }
  const result = hl.codeToTokens(code, { lang, themes: { light: 'github-light', dark: 'github-dark-dimmed' }, defaultColor: false })
  const tokens = result.tokens.map(line => line.map(t => ({ content: t.content, style: (t.htmlStyle ?? undefined) as Record<string, string> | undefined })))
  if (cache.size > 300) cache.clear()
  cache.set(key, tokens)
  return tokens
}
