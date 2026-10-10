import { describe, expect, it } from 'vitest'
import { isPreparationPhase, phaseDetail, phaseLabel, timingRows, timingSummary } from './phases'

describe('phaseLabel', () => {
  it('shows 思考中 for every host step before the first output, and names the step only as a detail', () => {
    for (const phase of ['connecting', 'preparing_workspace', 'preparing_memory', 'routing', 'preparing_context', 'starting']) expect(phaseLabel(phase)).toBe('思考中')
    expect(phaseDetail('connecting')).toBe('已发出请求，等模型开始输出')
    expect(phaseDetail('preparing_memory')).toBe('正在查找项目记忆')
    expect(phaseLabel(undefined)).toBe('思考中')
  })
  it('names the states that tell the reader something', () => {
    expect(phaseLabel('compacting')).toBe('正在整理上下文')
    expect(phaseLabel('waiting_user')).toBe('等待你的回答')
    expect(phaseLabel('queued')).toBe('排队中')
    expect(phaseLabel('retrying')).toBe('正在重试')
    expect(phaseDetail('compacting')).toBe(null)
  })
  it('treats unknown phases as connecting: 思考中, with a readable detail and never a raw id', () => {
    expect(phaseLabel('loading_skills')).toBe('思考中')
    expect(phaseDetail('loading_skills')).toBe('正在读取技能')
    expect(phaseDetail('verifying_files')).toBe('正在校验文件')
    expect(phaseLabel('xyz_frobnicate')).toBe('思考中')
    expect(phaseDetail('xyz_frobnicate')).toBe(null)
    expect(isPreparationPhase('xyz_frobnicate')).toBe(true)
  })
  it('summarizes turn timing', () => {
    expect(timingSummary({ toRequest: 810, firstToken: 1575 })).toBe('准备 0.8s · 首字 1.6s')
    expect(timingSummary({ toRequest: 810, firstToken: 1575, compactionAfter: 2100 })).toContain('回复后压缩 2.1s')
    expect(timingRows({ memory: 2, request: 760 })).toEqual([['等待记忆', '0.0s'], ['模型首字延迟', '0.8s']])
  })
  it('classifies preparation phases', () => {
    expect(isPreparationPhase('preparing_memory')).toBe(true)
    expect(isPreparationPhase('preparing_anything_new')).toBe(true)
    expect(isPreparationPhase('writing')).toBe(false)
  })
  it('names applying (0.63): a worktree conversation writing into the project folder after its answer, never 思考中', () => {
    expect(phaseLabel('applying')).toBe('正在应用到项目文件夹')
    expect(phaseDetail('applying')).toBe(null)
    expect(isPreparationPhase('applying')).toBe(false)
  })
})
