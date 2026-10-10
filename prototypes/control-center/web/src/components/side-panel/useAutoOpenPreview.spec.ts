import { describe, expect, it } from 'vitest'
import type { Item } from '@/api/types'
import { previewTarget } from './useAutoOpenPreview'
import { summarizeDeliverables } from '@/components/timeline/Deliverables'
import { mediaFiles } from '@/lib/tools'

const write = (id: string, path: string): Item => ({ id, kind: 'tool', turnId: 't1', tool: { name: 'project_write', kind: 'write', status: 'completed', args: { path, content: 'x' } } } as unknown as Item)
const image = (id: string, tool: Record<string, unknown>): Item => ({ id, kind: 'tool', turnId: 't1', tool: { name: 'image_generate', status: 'succeeded', output: '已生成 1 张图片', ...tool } } as unknown as Item)
const preview = (id: string, url: string): Item => ({ id, kind: 'tool', turnId: 't1', tool: { name: 'project_preview', status: 'completed', output: JSON.stringify({ url }) } } as unknown as Item)

describe('previewTarget', () => {
  it('prefers the project run preview over files', () => {
    expect(previewTarget([write('a', 'index.html'), preview('b', 'http://127.0.0.1:5173/')])).toEqual({ kind: 'url', url: 'http://127.0.0.1:5173/' })
  })
  it('then a new HTML file, then a new document', () => {
    expect(previewTarget([write('a', 'notes.md'), write('b', 'game.html')])).toEqual({ kind: 'file', path: 'game.html' })
    expect(previewTarget([write('a', 'src/main.ts'), write('b', 'README.md')])).toEqual({ kind: 'file', path: 'README.md' })
  })
  it('opens nothing for code-only turns', () => {
    expect(previewTarget([write('a', 'src/main.ts'), write('b', 'src/util.py')])).toBeNull()
  })
})

// Live, 2026-10-03: a generated image could not be seen; the turn produced it but nothing showed or opened it.
describe('generated media', () => {
  const files = [{ path: 'media/a.png', mimeType: 'image/png', bytes: 10 }, { path: 'media/a-2.png', mimeType: 'image/png', bytes: 12 }]
  it('are deliverables of the turn, and the last image opens when no document was made', () => {
    const items = [image('a', { files, args: { prompt: 'x', count: 2 } })]
    expect(summarizeDeliverables(items).produced.map(p => [p.kind, p.key])).toEqual([['media', 'media/a.png'], ['media', 'media/a-2.png']])
    expect(previewTarget(items)).toEqual({ kind: 'file', path: 'media/a-2.png' })
    expect(previewTarget([...items, write('b', 'report.md')])).toEqual({ kind: 'file', path: 'report.md' })
  })
  it('recorded before files were kept fall back to the one image path asked for; failures show nothing', () => {
    expect(mediaFiles(image('a', { args: { prompt: 'x', path: 'media/ai-future-trends.png' } }).tool)).toEqual([{ path: 'media/ai-future-trends.png', mimeType: 'image/png' }])
    expect(mediaFiles(image('a', { args: { prompt: 'x', path: 'media/x.png', count: 2 } }).tool)).toEqual([])
    expect(mediaFiles(image('a', { status: 'failed', files }).tool)).toEqual([])
  })
})
