import { afterEach, describe, expect, it } from 'vitest'
import { getTransport, setTransport } from '@/api/client'
import { stopSideSession } from './side-sync'

const previous = getTransport()
afterEach(() => setTransport(previous))

describe('side chat stop', () => {
  it('returns the follow-ups the stopped turn never took, without queued subagent results', async () => {
    const sent: string[] = []
    setTransport({ ...previous, request: async <T,>(path: string) => {
      sent.push(path)
      return { recovered: [{ id: 'm1', text: '再看一下第二段', delivery: 'steer' }, { id: 'm2', text: '[宿主通知] …', delivery: 'steer', source: 'subagent' }, { id: 'm3', text: '  顺便改标题 ', delivery: 'followup' }] } as T
    } })
    expect(await stopSideSession('side-1')).toBe('再看一下第二段\n\n顺便改标题')
    expect(sent).toEqual(['/api/sessions/side-1/control'])
  })

  it('returns nothing when no message was waiting', async () => {
    setTransport({ ...previous, request: async <T,>() => ({}) as T })
    expect(await stopSideSession('side-1')).toBe('')
  })
})
