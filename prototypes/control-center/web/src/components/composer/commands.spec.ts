import { describe, expect, it } from 'vitest'
import { COMPOSER_COMMANDS, filterCommands, resolveSlash, slashQuery, unavailableReason } from './commands'

const cmd = (id: string) => COMPOSER_COMMANDS.find(c => c.id === id)!
const ctx = { sessionId: 's1', projectId: 'p1', status: 'idle', mode: 'build' }

describe('composer commands', () => {
  it('launcher hides navigation until searching', () => {
    expect(filterCommands('', true).some(c => c.group === 'navigate')).toBe(false)
    expect(filterCommands('进化', true).map(c => c.id)).toContain('versions')
  })
  it('slash filters by id, alias or label prefix', () => {
    expect(filterCommands('co', false).map(c => c.id)).toEqual(['compact'])
    expect(filterCommands('permissions', false).map(c => c.id)).toEqual(['permission'])
  })
  it('resolves a slash line with arguments', () => {
    expect(resolveSlash('/goal 先做移动端')).toMatchObject({ command: { id: 'goal' }, argument: '先做移动端' })
    expect(resolveSlash('/unknown')).toBeNull()
    expect(slashQuery('/com')).toBe('com')
    expect(slashQuery('/com x')).toBeNull()
  })
  it('explains unavailable commands like the legacy launcher', () => {
    expect(unavailableReason(cmd('compact'), { ...ctx, status: 'running' }, null)).toBe('先结束当前轮次')
    expect(unavailableReason(cmd('stop'), ctx, null)).toBe('当前没有运行中的轮次')
    expect(unavailableReason(cmd('goal'), { ...ctx, sessionId: null }, null)).toBe('先新建一段会话')
    expect(unavailableReason(cmd('compact'), ctx, { sessionId: 's1', commands: [{ id: 'compact', available: false, reason: 'runtime_unavailable' }] })).toBe('真实运行时尚未启用')
    expect(unavailableReason(cmd('compact'), ctx, null, true)).toBe('上一个指令正在执行')
  })
})
