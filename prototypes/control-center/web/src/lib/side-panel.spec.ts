import { describe, expect, it } from 'vitest'
import { addressLabel, canBack, canForward, embedMode, isLoopbackHost, navBack, navCurrent, navForward, navPush, navStart, normalizeAddress } from './browser-url'
import { resolveReviewMode, reviewModes } from './review-modes'
import { isSideSession, selectionSeed, SELECTION_LIMIT } from './side-session'
import { decodeB64, encodeB64 } from '@/api/side-panel-api'

describe('browser address bar', () => {
  it('normalizes typed addresses', () => {
    expect(normalizeAddress('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeAddress('127.0.0.1:3000/app?x=1')).toBe('http://127.0.0.1:3000/app?x=1')
    expect(normalizeAddress('example.com')).toBe('https://example.com/')
    expect(normalizeAddress('  https://example.com/a  ')).toBe('https://example.com/a')
    expect(normalizeAddress('http://[::1]:8080')).toBe('http://[::1]:8080/')
    expect(normalizeAddress('about:blank')).toBe('about:blank')
  })

  it('rejects non-web schemes, search phrases and empty input', () => {
    for (const bad of ['', '   ', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'hello world', 'intranet', 'ftp://x.org']) {
      expect(normalizeAddress(bad), bad).toBeNull()
    }
  })

  it('recognizes loopback hosts', () => {
    expect(['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]'].every(isLoopbackHost)).toBe(true)
    expect(['example.com', '10.0.0.1', '128.0.0.1', 'localhost.evil.com'].some(isLoopbackHost)).toBe(false)
  })
})

describe('browser embed policy', () => {
  const app = 'http://127.0.0.1:4317'
  it('uses <webview> in the desktop shell for any http(s) page', () => {
    expect(embedMode('https://example.com/', { webview: true, appOrigin: app })).toBe('webview')
    expect(embedMode('http://127.0.0.1:5173/', { webview: true, appOrigin: app })).toBe('webview')
  })
  it('frames only loopback http pages in web mode, never the app itself', () => {
    expect(embedMode('http://127.0.0.1:5173/', { appOrigin: app })).toBe('iframe')
    expect(embedMode('http://localhost:3000/x', { appOrigin: app })).toBe('iframe')
    expect(embedMode('http://127.0.0.1:4317/', { appOrigin: app })).toBe('blocked')
    expect(embedMode('https://example.com/', { appOrigin: app })).toBe('blocked')
    expect(embedMode('https://localhost:3000/', { appOrigin: app })).toBe('blocked')
  })
  it('allows mock data: previews only when asked', () => {
    expect(embedMode('data:text/html,<p>x</p>', { allowData: true })).toBe('iframe')
    expect(embedMode('data:text/html,<p>x</p>', {})).toBe('invalid')
    expect(embedMode('javascript:alert(1)', { webview: true })).toBe('invalid')
  })
  it('labels addresses without the scheme', () => {
    expect(addressLabel('http://127.0.0.1:5173/')).toBe('127.0.0.1:5173')
    expect(addressLabel('https://example.com/a?b=1')).toBe('example.com/a?b=1')
  })
})

describe('iframe navigation stack', () => {
  it('pushes, goes back and forward, and truncates forward history on navigation', () => {
    let s = navStart('a')
    expect(canBack(s)).toBe(false)
    s = navPush(navPush(s, 'b'), 'c')
    expect(navCurrent(s)).toBe('c')
    s = navBack(navBack(s))
    expect(navCurrent(s)).toBe('a')
    expect(canForward(s)).toBe(true)
    s = navForward(s)
    expect(navCurrent(s)).toBe('b')
    s = navPush(s, 'd')
    expect(s.entries).toEqual(['a', 'b', 'd'])
    expect(canForward(s)).toBe(false)
    expect(navPush(s, 'd')).toBe(s)
    expect(navStart('').index).toBe(-1)
  })
})

describe('审查 single view switch', () => {
  it('offers 预览 / 源码 / 差异 by file type and change', () => {
    expect(reviewModes({ path: 'docs/a.md', hasChange: true, created: true })).toEqual({ modes: ['preview', 'source', 'diff'], fallback: 'preview' })
    expect(reviewModes({ path: 'docs/a.md', hasChange: true, created: false })).toEqual({ modes: ['preview', 'source', 'diff'], fallback: 'diff' })
    expect(reviewModes({ path: 'src/a.ts', hasChange: true, created: true })).toEqual({ modes: ['source', 'diff'], fallback: 'diff' })
    expect(reviewModes({ path: 'img/logo.png', hasChange: true, created: true })).toEqual({ modes: ['preview', 'diff'], fallback: 'preview' })
    expect(reviewModes({ path: 'index.html', hasChange: false })).toEqual({ modes: ['preview', 'source'], fallback: 'preview' })
    expect(reviewModes({ path: null, hasChange: true })).toEqual({ modes: ['diff'], fallback: 'diff' })
    expect(reviewModes({ path: 'bin/app.zip', hasChange: true, created: true })).toEqual({ modes: ['diff'], fallback: 'diff' })
  })
  it('keeps an explicit choice only while it is offered', () => {
    const md = reviewModes({ path: 'a.md', hasChange: true, created: false })
    expect(resolveReviewMode('source', md)).toBe('source')
    expect(resolveReviewMode(undefined, md)).toBe('diff')
    expect(resolveReviewMode('preview', reviewModes({ path: 'a.ts', hasChange: true }))).toBe('diff')
  })
})

describe('side chats', () => {
  it('identifies side sessions', () => {
    expect(isSideSession({ kind: 'side' })).toBe(true)
    expect(isSideSession({ parentSessionId: 's-1' })).toBe(true)
    expect(isSideSession({ kind: 'main', parentSessionId: 's-1' })).toBe(false)
    expect(isSideSession({})).toBe(false)
    expect(isSideSession(null)).toBe(false)
  })
  it('trims and bounds selection seeds', () => {
    expect(selectionSeed('  hi\n\n\n\nthere ')).toBe('hi\n\nthere')
    expect(selectionSeed('   ')).toBeNull()
    expect(selectionSeed('x'.repeat(SELECTION_LIMIT + 5))!.length).toBe(SELECTION_LIMIT + 1)
  })
})

describe('terminal base64 codec', () => {
  it('round-trips UTF-8 input and output bytes', () => {
    const text = 'ls -la 中文 ✓\r'
    expect(new TextDecoder().decode(decodeB64(encodeB64(text)))).toBe(text)
  })
})
