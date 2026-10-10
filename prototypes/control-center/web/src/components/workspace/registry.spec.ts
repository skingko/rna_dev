import { describe, expect, it } from 'vitest'
import { naturalBinding, type SideTabInput } from '@/store/side-panel-store'
import './builtin-panels'
import { getPanel, isKeepAlive, panelTypes, registerPanel, unregisterPanel } from './registry'

/** One sample tab per built-in type. */
const SAMPLES: SideTabInput[] = [
  { type: 'launcher' },
  { type: 'tool', sessionId: 's', itemId: 'i' },
  { type: 'review', sessionId: 's' },
  { type: 'file', projectId: 'p', path: 'a.md' },
  { type: 'change-review', projectId: 'p', changeId: 'c' },
  { type: 'agent-browser', sessionId: 's' },
  { type: 'browser', url: 'http://localhost:1/' },
  { type: 'terminal', projectId: 'p' },
  { type: 'side-chat', parentSessionId: 's', ordinal: 1 },
]

const kind = (binding: ReturnType<typeof naturalBinding>) => (binding === 'workspace' ? 'workspace' : 'session' in binding ? 'session' : 'project')

describe('panel registry (P-6)', () => {
  it('registers every side-panel type from its body, without the retired overview and before any tasks panel', () => {
    expect(panelTypes().sort()).toEqual(SAMPLES.map(tab => tab.type).sort())
    expect(getPanel('overview')).toBeUndefined()
    expect(getPanel('tasks')).toBeUndefined()
  })

  it('declares the binding the store gives those tabs, and keeps pages, terminals, the agent browser and side chats alive', () => {
    for (const sample of SAMPLES) expect([sample.type, getPanel(sample.type)!.binding]).toEqual([sample.type, kind(naturalBinding(sample))])
    expect(SAMPLES.filter(tab => isKeepAlive(tab.type)).map(tab => tab.type).sort()).toEqual(['agent-browser', 'browser', 'side-chat', 'terminal'])
  })

  it('takes later registrations (a new tab type) and replaces a type’s definition', () => {
    const icon = () => null
    registerPanel({ type: 'tasks', title: () => 'A', icon, binding: 'workspace', render: () => null })
    registerPanel({ type: 'tasks', title: () => 'B', icon, binding: 'workspace', render: () => null })
    expect(getPanel('tasks')!.title({ id: 't', type: 'tasks', binding: 'workspace' })).toBe('B')
    unregisterPanel('tasks')
    expect(getPanel('tasks')).toBeUndefined()
  })
})
