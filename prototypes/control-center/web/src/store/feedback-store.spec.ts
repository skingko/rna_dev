import { beforeEach, describe, expect, it } from 'vitest'
import { setTransport } from '@/api/client'
import { ApiError, type RequestInit, type Transport } from '@/api/transport'
import { effectiveVote, feedbackKey, sendFeedback, useFeedback } from './feedback-store'

function transport(handler: (path: string, init: RequestInit) => unknown): Transport {
  return {
    kind: 'mock',
    async request<T>(path: string, init: RequestInit = {}): Promise<T> { return handler(path, init) as T },
    openStream: () => { throw new Error('no streams') },
  }
}

const key = feedbackKey('s', 'i')
beforeEach(() => useFeedback.setState({ votes: {}, unsupported: false }))

describe('feedback store', () => {
  it('prefers the local vote over the echoed one', () => {
    expect(effectiveVote(undefined, { vote: 'up' })).toBe('up')
    expect(effectiveVote({ vote: null, pending: false }, { vote: 'up' })).toBeNull()
    expect(effectiveVote(undefined, null)).toBeNull()
  })

  it('shows the vote immediately and posts it with the comment', async () => {
    const bodies: unknown[] = []
    setTransport(transport((path, init) => { bodies.push([path, init.method, init.body]); return { feedback: { vote: 'down' } } }))
    const pending = sendFeedback('s', 'i', 'down')
    expect(useFeedback.getState().votes[key]).toMatchObject({ vote: 'down', pending: true })
    await pending
    await sendFeedback('s', 'i', 'down', '太啰嗦')
    expect(useFeedback.getState().votes[key]).toMatchObject({ vote: 'down', comment: '太啰嗦', pending: false })
    expect(bodies).toEqual([
      ['/api/v2/sessions/s/items/i/feedback', 'POST', { vote: 'down' }],
      ['/api/v2/sessions/s/items/i/feedback', 'POST', { vote: 'down', comment: '太啰嗦' }],
    ])
  })

  it('rolls back on failure and hides the controls on older daemons', async () => {
    setTransport(transport(() => ({})))
    await sendFeedback('s', 'i', 'up')
    setTransport(transport(() => { throw new ApiError('boom', 500) }))
    expect(await sendFeedback('s', 'i', null)).toBe(false)
    expect(useFeedback.getState().votes[key]).toMatchObject({ vote: 'up' })
    expect(useFeedback.getState().unsupported).toBe(false)
    setTransport(transport(() => { throw new ApiError('missing', 404) }))
    await sendFeedback('s', 'j', 'down')
    expect(useFeedback.getState().votes[feedbackKey('s', 'j')]).toBeUndefined()
    expect(useFeedback.getState().unsupported).toBe(true)
  })
})
