import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { getTransport, setTransport } from '@/api/client'
import type { RequestInit, Transport } from '@/api/transport'
import { activeTab, groupIds, tabGroupId } from '@/lib/dock'
import { useApp } from '@/store/app-store'
import { useUi } from '@/store/ui-store'
import { resetPreviews } from '@/store/preview-store'
import { openTab, resetSidePanel, setContext, setViewport, useSidePanel } from '@/store/side-panel-store'
import { openHtmlInBrowser, openPreviewTab } from '@/components/side-panel/open'
import { openFilePreview, openProjectPreview } from './open'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const READY = { status: 'ready', kind: 'static', url: 'http://127.0.0.1:5999/t/index.html', entryPath: 'index.html', origin: 'http://127.0.0.1:5999' }
let posts: string[] = []
const transport: Transport = {
  kind: 'live',
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (init.method === 'POST') posts.push(path)
    return READY as T
  },
  openStream() { throw new Error('unused') },
}

let previous: Transport
const appState = useApp.getState()
beforeEach(() => {
  previous = getTransport(); setTransport(transport)
  resetSidePanel(); resetPreviews(); posts = []
  useApp.setState({ projects: { p: { id: 'p', name: 'p', workspacePath: '/w' } as never } })
  setContext({ sessionId: null, projectId: 'p' })
  setViewport({ width: 1400, height: 900 })
})
afterEach(() => { setTransport(previous); useApp.setState(appState, true); useUi.setState({ toasts: [] }) })

const flush = async (n = 5) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const layout = () => useSidePanel.getState().layout
const previewTab = () => Object.values(layout().tabs).find(tab => tab.type === 'browser' && tab.key === 'preview:p')
/** A 文件 panel showing the project, alone in its group. */
const filesPanel = () => {
  const files = openTab({ type: 'files', projectId: 'p' })
  return { files, group: tabGroupId(layout(), files)! }
}
/** The preview is in a group of its own, and the 文件 panel is still the tab its group shows. */
const besideFiles = ({ files, group }: { files: string; group: string }) => {
  const preview = previewTab()
  expect(preview).toBeDefined()
  expect(tabGroupId(layout(), preview!.id)).not.toBe(group)
  expect(activeTab(layout(), group, useSidePanel.getState().ctx)?.id).toBe(files)
}

describe('run previews open beside the 文件 panel, never over it', () => {
  it('an HTML file opened from a deliverable, a Markdown link or the review dock', async () => {
    const panel = filesPanel()
    expect(openFilePreview('p', 'report.html')).toBe(true)
    await flush()
    expect(previewTab()).toMatchObject({ url: 'http://127.0.0.1:5999/t/report.html' })
    besideFiles(panel)
  })

  it('the project’s run preview (a deliverable’s preview link)', async () => {
    const panel = filesPanel()
    await act(async () => { await openProjectPreview('p') })
    expect(previewTab()).toMatchObject({ url: READY.url })
    besideFiles(panel)
  })

  it('an HTML document’s 在浏览器中运行 (static preview of that file)', async () => {
    const panel = filesPanel()
    await act(async () => { await openHtmlInBrowser('p', 'docs/page.html') })
    expect(posts).toEqual(['/api/projects/p/preview'])
    besideFiles(panel)
  })

  it('a second preview reuses the project’s preview tab where it is; without a 文件 panel it goes where new tabs go', async () => {
    const panel = filesPanel()
    await act(async () => { await openProjectPreview('p') })
    const first = previewTab()!.id
    openFilePreview('p', 'b.html'); await flush()
    expect(previewTab()!.id).toBe(first)
    besideFiles(panel)

    resetSidePanel()
    const file = openTab({ type: 'file', projectId: 'p', path: 'a.md' })
    openPreviewTab('p', READY.url)
    expect(groupIds(layout())).toHaveLength(1)
    expect(tabGroupId(layout(), previewTab()!.id)).toBe(tabGroupId(layout(), file))
  })

  it('a caller that places the tab keeps its own placement (the tasks panel opens previews beside itself)', () => {
    const { group } = filesPanel()
    const tasks = openTab({ type: 'tasks' }, { target: { edge: 'right', of: group } })
    const tasksGroup = tabGroupId(layout(), tasks)
    openPreviewTab('p', READY.url, { target: tasksGroup })
    expect(tabGroupId(layout(), previewTab()!.id)).toBe(tasksGroup)
  })
})
