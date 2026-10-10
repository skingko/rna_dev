import { describe, expect, it } from 'vitest'
import { extOf, formatBytes, isRichPreview, normalizeRelative, parseDelimited, previewSpec, resolveRelative, sizeVerdict, toWorkspacePath, HOST_TEXT_LIMIT } from './registry'
import { sandboxedHtml, PREVIEW_CSP, HTML_SANDBOX } from './html-sandbox'
import { stepZoom, ZOOM_STEPS } from './renderers/ImagePreview'
import { columnWidth } from './renderers/TablePreview'
import { normalizeLang } from '@/lib/highlight'

describe('renderer selection', () => {
  it.each([
    ['reports/2026-09-28/daily.md', 'markdown', 'text'],
    ['README.markdown', 'markdown', 'text'],
    ['docs/page.mdx', 'markdown', 'text'],
    ['scripts/analyze_fps.py', 'code', 'text'],
    ['src/App.test.tsx', 'code', 'text'],
    ['config/game.json', 'json', 'text'],
    ['data/fps.csv', 'table', 'text'],
    ['data/fps.tsv', 'table', 'text'],
    ['data/fps.xlsx', 'excel', 'bytes'],
    ['legacy/report.xls', 'excel', 'bytes'],
    ['shots/a.PNG', 'image', 'bytes'],
    ['icons/logo.svg', 'image', 'bytes'],
    ['docs/level-design.pdf', 'pdf', 'bytes'],
    ['docs/levels.html', 'html', 'text'],
    ['docs/brief.docx', 'office', 'none'],
    ['slides/deck.pptx', 'office', 'none'],
    ['notes/todo.txt', 'text', 'text'],
    ['Dockerfile', 'code', 'text'],
    ['Makefile', 'code', 'text'],
    ['.gitignore', 'text', 'text'],
    ['dist/app.tar.gz', 'binary', 'none'],
    ['assets/font.woff2', 'binary', 'none'],
  ])('%s -> %s (%s)', (path, kind, load) => {
    const spec = previewSpec(path)
    expect(spec.kind).toBe(kind)
    expect(spec.load).toBe(load)
  })

  it('maps code suffixes to Shiki languages the highlighter actually registers', () => {
    for (const path of ['a.py', 'a.ts', 'a.tsx', 'a.go', 'a.rs', 'a.java', 'a.c', 'a.cpp', 'a.sql', 'a.yaml', 'a.toml', 'a.sh', 'a.css', 'a.kt', 'a.rb', 'Dockerfile']) {
      const lang = previewSpec(path).lang
      expect(lang, path).toBeTruthy()
      expect(normalizeLang(lang), path).toBe(lang)
    }
    expect(previewSpec('scripts/analyze_fps.py')).toMatchObject({ lang: 'python', badge: 'PY' })
  })

  it('falls back to the host MIME only when the name says nothing', () => {
    expect(previewSpec('blob', 'image/png').kind).toBe('image')
    expect(previewSpec('blob', 'application/pdf').kind).toBe('pdf')
    expect(previewSpec('blob', 'application/zip').kind).toBe('binary')
    expect(previewSpec('blob', 'text/plain; charset=utf-8').kind).toBe('text')
    expect(previewSpec('LICENSE').kind).toBe('text')
    expect(previewSpec('notes.md', 'image/png').kind).toBe('markdown')
  })

  it('previews new files richly unless they are office or opaque binaries', () => {
    expect(isRichPreview('a.md')).toBe(true)
    expect(isRichPreview('a.py')).toBe(true)
    expect(isRichPreview('a.png')).toBe(true)
    expect(isRichPreview('a.docx')).toBe(false)
    expect(isRichPreview('a.zip')).toBe(false)
  })

  it('reads suffixes from the last segment only', () => {
    expect(extOf('a.b/c')).toBe('')
    expect(extOf('dir/.env')).toBe('')
    expect(extOf('x/y.Z.JSON')).toBe('json')
  })
})

describe('size guards', () => {
  const md = previewSpec('a.md'), png = previewSpec('a.png'), docx = previewSpec('a.docx')
  it('reads unknown sizes and small files, asks for large ones, refuses huge ones', () => {
    expect(sizeVerdict(md, null)).toBe('ok')
    expect(sizeVerdict(md, 10_000)).toBe('ok')
    expect(sizeVerdict(md, md.softLimit + 1)).toBe('confirm')
    // The host truncates text reads, so text never hard-blocks.
    expect(sizeVerdict(md, 900 * 1024 * 1024)).toBe('confirm')
    expect(md.softLimit).toBeGreaterThanOrEqual(HOST_TEXT_LIMIT)
    const xlsx = previewSpec('a.xlsx')
    expect(sizeVerdict(xlsx, xlsx.hardLimit + 1)).toBe('block')
    expect(sizeVerdict(png, 40 * 1024 * 1024)).toBe('block')
    expect(sizeVerdict(docx, 900 * 1024 * 1024)).toBe('ok')
  })
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(formatBytes(null)).toBe('')
  })
})

describe('path helpers', () => {
  const root = '/Users/me/Projects/ink-bird'
  it('turns tool paths into workspace-relative ones and rejects escapes', () => {
    expect(toWorkspacePath(`${root}/reports/2026-09-28/daily.md`, root)).toBe('reports/2026-09-28/daily.md')
    expect(toWorkspacePath(`${root}/`, root)).toBeNull()
    expect(toWorkspacePath('./src/../docs/a.md', root)).toBe('docs/a.md')
    expect(toWorkspacePath('/Users/me/Projects/ink-bird-evil/x.md', root)).toBeNull()
    expect(toWorkspacePath('/etc/passwd', root)).toBeNull()
    expect(toWorkspacePath('../outside.md', root)).toBeNull()
    expect(toWorkspacePath('/abs/without/workspace.md', null)).toBeNull()
    expect(toWorkspacePath('https://example.com/a.md', root)).toBeNull()
    expect(toWorkspacePath('a\\b.md', root)).toBeNull()
  })
  it('normalizes relative paths', () => {
    expect(normalizeRelative('a//b/./c')).toBe('a/b/c')
    expect(normalizeRelative('a/../../b')).toBeNull()
    expect(normalizeRelative('')).toBeNull()
  })
  it('resolves document references against the document directory', () => {
    const doc = 'reports/2026-09-28/daily.md'
    expect(resolveRelative(doc, '../../shots/fps_trend.png')).toBe('shots/fps_trend.png')
    expect(resolveRelative(doc, 'chart%20a.png?raw=1#x')).toBe('reports/2026-09-28/chart a.png')
    expect(resolveRelative('README.md', 'docs/a.md')).toBe('docs/a.md')
    expect(resolveRelative(doc, '../../../../etc/passwd')).toBeNull()
    for (const href of ['https://x.dev/a.png', '//cdn/x.png', 'data:image/png;base64,AA', 'mailto:a@b.c', '#top', '/abs.png', 'javascript:alert(1)']) expect(resolveRelative(doc, href)).toBeNull()
  })
})

describe('delimited text', () => {
  it('handles quotes, doubled quotes, CRLF, BOM and a trailing newline', () => {
    const { rows, truncated } = parseDelimited('﻿a,b\r\n"x, y","say ""hi"""\r\n1,\n', ',')
    expect(rows).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['1', '']])
    expect(truncated).toBe(false)
  })
  it('supports tabs, multi-line quoted fields and row caps', () => {
    expect(parseDelimited('a\tb\n"l1\nl2"\tc', '\t').rows).toEqual([['a', 'b'], ['l1\nl2', 'c']])
    const capped = parseDelimited('1\n2\n3\n4\n', ',', 2)
    expect(capped.rows).toEqual([['1'], ['2']])
    expect(capped.truncated).toBe(true)
  })
  it('sizes columns from content, counting CJK wide', () => {
    expect(columnWidth(['a'])).toBe(72)
    expect(columnWidth(['设备名称很长很长'])).toBeGreaterThan(columnWidth(['abcdefgh']))
    expect(columnWidth(['x'.repeat(500)])).toBe(360)
  })
})

describe('HTML sandbox', () => {
  it('injects the CSP meta inside <head> without disturbing the doctype', () => {
    const out = sandboxedHtml('<!doctype html><html><head><title>t</title></head><body><script>alert(1)</script></body></html>')
    expect(out.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(out).toContain(PREVIEW_CSP)
  })
  it('creates a head when the document has none', () => {
    expect(sandboxedHtml('<p>x</p>')).toMatch(/^<head><meta http-equiv="Content-Security-Policy"[^>]+><meta name="referrer" content="no-referrer"><\/head><p>x<\/p>$/)
    expect(sandboxedHtml('<!DOCTYPE html>\n<body>x</body>').startsWith('<!DOCTYPE html><head><meta')).toBe(true)
    expect(sandboxedHtml('<html lang="zh"><body/></html>').startsWith('<html lang="zh"><head><meta')).toBe(true)
  })
  it('grants the iframe nothing and the document no network or scripts', () => {
    expect(HTML_SANDBOX).toBe('')
    expect(PREVIEW_CSP).toMatch(/default-src 'none'/)
    expect(PREVIEW_CSP).not.toMatch(/script-src/)
  })
})

describe('image zoom steps', () => {
  it('steps through the fixed ladder and clamps at the ends', () => {
    expect(stepZoom(1, 1)).toBe(1.5)
    expect(stepZoom(1, -1)).toBe(0.75)
    expect(stepZoom(0.62, 1)).toBe(0.75)
    expect(stepZoom(0.62, -1)).toBe(0.5)
    expect(stepZoom(ZOOM_STEPS.at(-1)!, 1)).toBe(ZOOM_STEPS.at(-1))
    expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(ZOOM_STEPS[0])
  })
})
