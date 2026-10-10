import { describe, expect, it } from 'vitest'
import { failureSentence, hostFailureHandoff, stripHandoffMarker } from './task-failure'

describe('stopped background work, in plain words', () => {
  it('never shows the code or a model-facing instruction', () => {
    expect(failureSentence('idle_timeout')).toBe('模型服务这次没有及时响应，工作没做完。')
    expect(failureSentence('connection')).toBe('模型服务这次没有及时响应，工作没做完。')
    expect(failureSentence('empty_result')).toBe('这次没有产出结果。')
    expect(failureSentence('foreground_started', 'cancelled')).toMatch(/后台先让出来了/)
    expect(failureSentence(null, 'cancelled')).toMatch(/已停止/)
    expect(hostFailureHandoff('未完成（empty_result）：接手前台…；No background result was produced。下一步先处理原因，不要原样重试。')).toBe(true)
    expect(hostFailureHandoff('交接：写完第 8、9 章，第 10 章待写。')).toBe(false)
  })

  it('hides the host-written English failure handoffs and keeps a model handoff, whichever marker it carries', () => {
    for (const line of ['Unfinished (empty_result): take over in the foreground.', 'Interrupted: the app restarted.', 'Result to verify (code): one step may have run.', 'Stopped: the user stopped this work.', 'Paused: the user paused this work.', 'HANDOFF: Stopped: the user stopped this work.', '交接：Stopped: x']) expect(hostFailureHandoff(line)).toBe(true)
    for (const line of ['HANDOFF: Chapters 8 and 9 are written; chapter 10 is left.', 'Chapters 8 and 9 are written.', '交接：写完第 8、9 章，第 10 章待写。', '']) expect(hostFailureHandoff(line)).toBe(false)
    expect(stripHandoffMarker('HANDOFF: done')).toBe('done')
    expect(stripHandoffMarker('handoff：done')).toBe('done')
    expect(stripHandoffMarker('交接：done')).toBe('done')
    expect(stripHandoffMarker('Stopped: done')).toBe('Stopped: done')
  })
})
