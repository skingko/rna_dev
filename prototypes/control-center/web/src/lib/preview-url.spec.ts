import { describe, expect, it } from 'vitest'
import { previewUrlFor } from './preview-url'

describe('previewUrlFor', () => {
  const base = { status: 'ready', kind: 'static', url: 'http://127.0.0.1:50698/f1f1/index.html', entryPath: 'index.html' }
  it('swaps the static entry for the requested file', () => {
    expect(previewUrlFor(base, 'index.html')).toBe('http://127.0.0.1:50698/f1f1/index.html')
    expect(previewUrlFor(base, 'levels/night race.html')).toBe('http://127.0.0.1:50698/f1f1/levels/night%20race.html')
  })
  it('keeps a dev server entry and rejects non-local URLs', () => {
    expect(previewUrlFor({ kind: 'vite', url: 'http://127.0.0.1:5173/' }, 'index.html')).toBe('http://127.0.0.1:5173/')
    expect(previewUrlFor({ kind: 'static', url: 'https://example.com/index.html', entryPath: 'index.html' }, 'index.html')).toBeNull()
  })
})
