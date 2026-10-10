// Wrap Chinese UI strings in t() / localized() using the oxc AST (rolldown/parseAst).
// Usage (from web/): node scripts/i18n-wrap.mjs <file...>
//   - JSX text runs and CJK attribute strings -> {t('…', { vars })}
//   - CJK literals / template literals inside functions -> t('…{name}…', { name })
//   - module-level object/array tables containing CJK -> localized(…)
//   - skips comparisons, includes()/split() arguments, imports, object keys, existing t() calls
// Wrapped keys are appended to .i18n-keys.txt; then `npx tsc` lists every key the English
// catalog (src/i18n/en/*.ts) still lacks. Review module-level reports printed to stderr.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const web = process.cwd()
const require = createRequire(web + '/package.json')
const { parseAst } = await import(require.resolve('rolldown/parseAst'))

const CJK = /[　-〿一-鿿＀-￯]/
const SKIP_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'split', 'replace', 'replaceAll', 'match', 'test', 'localeCompare', 'getItem', 'setItem', 'querySelector', 'querySelectorAll'])
const SKIP_CALLEES = new Set(['t', 'tr', 'translate', 'localized', 'useT', 'console', 'Error', 'ApiError', 'matchMedia'])
const SKIP_ATTRS = new Set(['className', 'key', 'id', 'href', 'src', 'type', 'name', 'layoutId', 'value', 'role'])
const q = s => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`

function transform(file) {
  const src = readFileSync(file, 'utf8')
  const lang = file.endsWith('.tsx') ? 'tsx' : 'ts'
  const ast = parseAst(src, { lang }, file)
  const conflict = /(?:\(|,\s*|^\s*|\bconst |\blet |\bfunction\s*\w*\()\bt\b\s*(?:[,):=]|=>)/m.test(src.replace(/\bt\(/g, ''))
  const T = conflict ? 'tr' : 't'
  const edits = [], keys = [], reports = []
  let needT = false, needLocalized = false
  const wrappedDecls = new Set()

  const isFn = n => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'MethodDefinition'].includes(n.type)
  const text = n => src.slice(n.start, n.end)
  function placeholder(expr, used) {
    let base = expr.type === 'Identifier' ? expr.name : expr.type === 'MemberExpression' && !expr.computed && expr.property.type === 'Identifier' ? expr.property.name : expr.type === 'ChainExpression' && expr.expression.type === 'MemberExpression' && !expr.expression.computed ? expr.expression.property.name : 'v'
    if (!/^[A-Za-z_]\w*$/.test(base)) base = 'v'
    let name = base, i = 2
    while (used.has(name)) name = `${base}${i++}`
    used.add(name); return name
  }
  function varsObject(parts) {
    return `{ ${parts.map(([name, expr, rendered]) => (expr.type === 'Identifier' && expr.name === name && rendered === name ? name : `${name}: ${rendered}`)).join(', ')} }`
  }
  const add = (start, end, build) => edits.push({ start, end, build })

  function literalContextSkip(node, parents) {
    const p = parents.at(-1), g = parents.at(-2)
    if (!p) return true
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression', 'TSLiteralType', 'SwitchCase', 'TSEnumMember', 'TSPropertySignature', 'TSImportType', 'TSExternalModuleReference'].includes(p.type)) return true
    if (p.type === 'Property' && p.key === node) return true
    if (p.type === 'BinaryExpression' && ['===', '!==', '==', '!=', 'in'].includes(p.operator)) return true
    if (p.type === 'CallExpression') {
      const c = p.callee
      if (c.type === 'Identifier' && SKIP_CALLEES.has(c.name)) return true
      if (c.type === 'MemberExpression' && c.property.type === 'Identifier' && (SKIP_METHODS.has(c.property.name) || (c.object.type === 'Identifier' && SKIP_CALLEES.has(c.object.name)))) return true
    }
    if (p.type === 'NewExpression' && p.callee.type === 'Identifier' && /Error$/.test(p.callee.name)) return false
    for (const a of parents) if (a.type === 'CallExpression' && a.callee.type === 'Identifier' && ['t', 'tr', 'localized'].includes(a.callee.name)) return true
    void g
    return false
  }
  function moduleLevel(parents) { return !parents.some(isFn) }
  function wrapModuleDecl(parents, node) {
    const decl = [...parents].reverse().find(n => n.type === 'VariableDeclarator')
    const top = decl && parents.indexOf(decl) <= 3
    let init = decl?.init
    while (init && ['TSAsExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'].includes(init.type)) init = init.expression
    if (decl && top && init && ['ObjectExpression', 'ArrayExpression'].includes(init.type)) {
      if (!wrappedDecls.has(decl)) {
        wrappedDecls.add(decl)
        needLocalized = true
        const edit = { start: decl.init.start, end: decl.init.end, build: render => `localized(${render(decl.init.start, decl.init.end, edit)})` }
        edits.push(edit)
      }
      return true
    }
    reports.push(`${file}:${src.slice(0, node.start).split('\n').length} module-level ${text(node).slice(0, 60)}`)
    return false
  }
  function collectModuleKeys(node) { if (node.type === 'Literal' && typeof node.value === 'string' && CJK.test(node.value)) keys.push(node.value) }

  function walk(node, parents) {
    if (!node || typeof node.type !== 'string') return
    // JSX children runs
    if ((node.type === 'JSXElement' || node.type === 'JSXFragment') && node.children?.length) handleChildren(node.children, parents.concat(node))
    if (node.type === 'JSXAttribute' && node.value?.type === 'Literal' && typeof node.value.value === 'string' && CJK.test(node.value.value)) {
      const name = node.name.type === 'JSXIdentifier' ? node.name.name : ''
      if (!SKIP_ATTRS.has(name) && !name.startsWith('data-')) {
        needT = true; keys.push(node.value.value)
        const v = node.value.value
        add(node.value.start, node.value.end, () => `{${T}(${q(v)})}`)
        return
      }
    }
    if (node.type === 'Literal' && typeof node.value === 'string' && CJK.test(node.value) && parents.at(-1)?.type !== 'JSXAttribute') {
      if (!literalContextSkip(node, parents)) {
        if (moduleLevel(parents)) { if (wrapModuleDecl(parents, node)) collectModuleKeys(node) }
        else { needT = true; keys.push(node.value); const v = node.value; add(node.start, node.end, () => `${T}(${q(v)})`) }
      }
    }
    if (node.type === 'TemplateLiteral' && parents.at(-1)?.type !== 'TaggedTemplateExpression' && node.quasis.some(qq => CJK.test(qq.value.cooked ?? ''))) {
      if (!literalContextSkip(node, parents)) {
        if (moduleLevel(parents)) reports.push(`${file}:${src.slice(0, node.start).split('\n').length} module-level template ${text(node).slice(0, 60)}`)
        else {
          needT = true
          const used = new Set(), parts = []
          let key = ''
          node.quasis.forEach((qq, i) => {
            key += qq.value.cooked
            const expr = node.expressions[i]
            if (expr) { const name = placeholder(expr, used); parts.push([name, expr]); key += `{${name}}` }
          })
          keys.push(key)
          add(node.start, node.end, render => `${T}(${q(key)}, ${varsObject(parts.map(([n, e]) => [n, e, render(e.start, e.end)]))})`)
          // still walk expressions for nested strings
          for (const e of node.expressions) walk(e, parents.concat(node))
          return
        }
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'parent' || k === 'children' && (node.type === 'JSXElement' || node.type === 'JSXFragment')) continue
      if (Array.isArray(v)) v.forEach(c => c && typeof c === 'object' && walk(c, parents.concat(node)))
      else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, parents.concat(node))
    }
  }

  const jsxy = e => JSON.stringify(e).includes('"JSX')
  function handleChildren(children, parents) {
    let run = []
    const flush = () => {
      const hasCjk = run.some(c => c.type === 'JSXText' && CJK.test(c.value))
      if (hasCjk) emitRun(run, parents)
      else for (const c of run) if (c.type === 'JSXExpressionContainer') walk(c, parents)
      run = []
    }
    for (const c of children) {
      if (c.type === 'JSXText' || (c.type === 'JSXExpressionContainer' && c.expression.type !== 'JSXEmptyExpression' && !jsxy(c.expression))) run.push(c)
      else { flush(); walk(c, parents) }
    }
    flush()
  }
  function emitRun(run, parents) {
    // trim leading/trailing non-CJK-free whitespace-only texts and expressions at the edges that are not between CJK texts
    while (run.length && run[0].type === 'JSXText' && !run[0].value.trim()) run.shift()
    while (run.length && run.at(-1).type === 'JSXText' && !run.at(-1).value.trim()) run.pop()
    if (!run.length) return
    const first = run[0], last = run.at(-1)
    const lead = first.type === 'JSXText' ? first.value.match(/^\s*/)[0] : ''
    const trail = last.type === 'JSXText' ? last.value.match(/\s*$/)[0] : ''
    const used = new Set(), parts = []
    let key = ''
    run.forEach((c, i) => {
      if (c.type === 'JSXText') {
        // JSX whitespace rules: per line trim (keep inner-line spaces), drop blank lines, join with one space.
        const lines = c.value.split('\n')
        let v = lines.length === 1 ? c.value : lines.map((line, j) => { let x = line; if (j > 0) x = x.replace(/^\s+/, ''); if (j < lines.length - 1) x = x.replace(/\s+$/, ''); return x }).filter(x => x.length).join(' ')
        if (i === 0) v = v.replace(/^\s+/, '')
        if (i === run.length - 1) v = v.replace(/\s+$/, '')
        key += v
      } else {
        const expr = c.expression
        if (expr.type === 'Literal' && typeof expr.value === 'string') { key += expr.value; return }
        const name = placeholder(expr, used); parts.push([name, expr]); key += `{${name}}`
        walk(expr, parents)
      }
    })
    needT = true; keys.push(key)
    const start = first.start + lead.length, end = last.end - trail.length
    add(start, end, render => parts.length ? `{${T}(${q(key)}, ${varsObject(parts.map(([n, e]) => [n, e, render(e.start, e.end)]))})}` : `{${T}(${q(key)})}`)
  }

  walk(ast, [])
  if (!edits.length) return { file, keys, reports, changed: false }
  edits.sort((a, b) => a.start - b.start || b.end - a.end)
  function render(start, end, skip) {
    let out = '', pos = start
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]
      if (e === skip) continue
      if (e.start < pos || e.start >= end || e.end > end) continue
      out += src.slice(pos, e.start)
      out += e.build(render)
      pos = e.end
    }
    return out + src.slice(pos, end)
  }
  let next = render(0, src.length)
  const names = [needT ? (T === 't' ? 't' : 't as tr') : null, needLocalized ? 'localized' : null].filter(Boolean)
  if (names.length) {
    const existing = next.match(/^import \{([^}]*)\} from '@\/i18n'\n/m)
    if (existing) next = next.replace(existing[0], `import {${existing[1].replace(/\s+$/, '')}, ${names.join(', ')} } from '@/i18n'\n`)
    else {
      const imports = ast.body.filter(n => n.type === 'ImportDeclaration')
      const at = imports.length ? imports.at(-1).end + 1 : 0
      next = next.slice(0, at) + `import { ${names.join(', ')} } from '@/i18n'\n` + next.slice(at)
    }
  }
  writeFileSync(file, next)
  return { file, keys, reports, changed: true }
}

for (const file of process.argv.slice(2)) {
  const r = transform(file)
  appendFileSync('.i18n-keys.txt', r.keys.map(k => k + '\n').join(''))
  for (const line of r.reports) process.stderr.write(line + '\n')
  process.stdout.write(`${r.changed ? 'M' : '-'} ${file} (${r.keys.length})\n`)
}
