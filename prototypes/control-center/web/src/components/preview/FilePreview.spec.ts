import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tooltip } from 'radix-ui'
import { setTransport, getTransport } from '@/api/client'
import { ApiError, type Transport } from '@/api/transport'
import { FilePreview } from './FilePreview'

// React 19 act() environment flag.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const files: Record<string, { content?: string; size: number; status?: number }> = {
  'reports/daily.md': { content: '# 日报\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n', size: 60 },
  'src/main.py': { content: 'def main():\n    return 1\n', size: 26 },
  'big/huge.md': { content: '# huge', size: 3 * 1024 * 1024 },
  'data/blob.dat': { size: 10, status: 415 },
  'gone.md': { size: 0, status: 404 },
}
const requests: string[] = []

function fakeTransport(): Transport {
  return {
    kind: 'live',
    async request<T>(path: string): Promise<T> {
      requests.push(path)
      const url = new URL(path, 'http://x')
      const target = url.searchParams.get('path') ?? ''
      if (url.pathname.endsWith('/files')) {
        const entries = Object.entries(files).filter(([p]) => p.split('/').slice(0, -1).join('/') === target).map(([p, f]) => ({ name: p.split('/').at(-1)!, path: p, type: 'file', size: f.size }))
        return { path: target, entries } as T
      }
      const file = files[target]
      if (!file || file.status === 404) throw new ApiError('文件或目录不存在。', 404)
      if (file.status) throw new ApiError('此文件不是 UTF-8 文本，请下载查看。', file.status)
      return { path: target, content: file.content, bytes: file.size, truncated: false } as T
    },
    openStream() { throw new Error('unused') },
  }
}

let root: Root, host: HTMLDivElement, previous: Transport
beforeEach(() => {
  previous = getTransport(); setTransport(fakeTransport()); requests.length = 0
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); setTransport(previous) })

async function render(path: string) {
  await act(async () => { root.render(createElement(Tooltip.Provider, null, createElement(FilePreview, { projectId: 'p1', path }))) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

describe('FilePreview', () => {
  it('renders Markdown documents (GFM table + task list) instead of raw syntax', async () => {
    await render('reports/daily.md')
    expect(host.querySelector('[data-preview-kind="markdown"]')).not.toBeNull()
    expect(host.querySelector('.md-doc h1')?.textContent).toBe('日报')
    expect(host.querySelectorAll('.md-doc table td')).toHaveLength(2)
    expect(host.querySelector('.md-doc input[type="checkbox"]')).not.toBeNull()
    expect(host.textContent).not.toContain('| a |')
    expect(host.textContent).toContain('60 B')
  })

  it('renders code with line numbers and a language badge', async () => {
    await render('src/main.py')
    expect(host.querySelector('[data-preview-kind="code"]')).not.toBeNull()
    expect([...host.querySelectorAll('.code-lines .ln')].map(n => n.textContent)).toEqual(['1', '2'])
    expect(host.textContent).toContain('PY')
  })

  it('asks before reading a large file, then reads it on 仍然打开', async () => {
    await render('big/huge.md')
    expect(host.textContent).toContain('仍然打开')
    expect(requests.some(r => r.includes('/file?'))).toBe(false)
    const button = [...host.querySelectorAll('button')].find(b => b.textContent === '仍然打开')!
    await act(async () => { button.click() })
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(host.querySelector('.md-doc h1')?.textContent).toBe('huge')
  })

  it('falls back to a download card for non-UTF-8 text and a retry card when missing', async () => {
    await render('data/blob.dat')
    expect(host.textContent).toContain('这是二进制文件，无法以文本预览。')
    expect(host.querySelector('a[download]')).not.toBeNull()
    await render('gone.md')
    expect(host.textContent).toContain('文件不存在或已被移动')
    expect([...host.querySelectorAll('button')].some(b => b.textContent === '重试')).toBe(true)
  })
})
