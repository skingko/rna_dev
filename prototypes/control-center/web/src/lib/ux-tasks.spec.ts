// UX audit 2026-10-03, 任务 page (checklist 35–43): counts that settle, plain words instead of codes, receipts after a scope change.
import { describe, expect, it } from 'vitest'
import { actionTask, actionTitle, adhocSplit, badgeCount, byOpen, needsUser, occurrenceText, planTasks, taskCounts, withoutHandles, withoutInternals, type TaskProjectInput } from './tasks'
import { actionReason, failureSentence, reviewDiagnosis } from './task-failure'
import { deliveryReceipt, projectActivity } from './display/activity'
// @ts-expect-error -- the host's untyped module: the port must name tasks exactly as the host does.
import { withoutHandles as hostWithoutHandles, withoutInternals as hostWithoutInternals } from '../../../task-text.mjs'

const NOW = new Date('2026-10-03T10:00:00').getTime()
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()
const project: TaskProjectInput = { id: 'p', name: '小说' }
const ended = { ended: true }
const CODE = /[a-z]+_[a-z_]+/

describe('需要你 settles once the user answered (F6, F46)', () => {
  const failed = { id: 'f', action: 'work', status: 'failed', content: '写第 9 章', finishedAt: iso(-60_000) }
  it('a failed run answered 接着做 / 不用了 leaves the open list, the page count and the tab badge', () => {
    const open = actionTask(project, failed, NOW, ended)!
    const handled = actionTask(project, { ...failed, id: 'h', attention: { acknowledgedAt: iso(0) } }, NOW, ended)!
    expect(adhocSplit([open, handled]).open.map(t => t.id)).toEqual(['f'])
    expect(adhocSplit([open, handled]).ended.map(t => t.id)).toEqual(['h'])
    expect([needsUser(open), needsUser(handled)]).toEqual([true, false])
    expect(badgeCount([open, handled])).toBe(1)
    expect(taskCounts([open, handled]).attention).toBe(1)
  })
  it('a result marked 需要你 stops counting after 知道了 (acknowledgedAt, C-e)', () => {
    const done = { id: 'd', action: 'work', status: 'completed', content: '核对', finishedAt: iso(-60_000), attention: { needsUser: true } }
    const fresh = actionTask(project, done, NOW, ended)!
    const seen = actionTask(project, { ...done, attention: { needsUser: true, acknowledgedAt: iso(0) } }, NOW, ended)!
    expect(fresh.flags).toContain('attention')
    expect(seen.flags).not.toContain('attention')
    expect(adhocSplit([fresh, seen]).open).toEqual([fresh])
  })
  it('a review answered from the conversation is counted as its row is marked (round 2)', () => {
    const review = { id: 'r', action: 'work', status: 'needs_review', content: '写第 9 章' }
    const open = actionTask(project, review, NOW, ended)!
    const answered = actionTask(project, { ...review, id: 'a', attention: { acknowledgedAt: iso(0) } }, NOW, ended)!
    expect([open.flags.includes('attention'), answered.flags.includes('attention')]).toEqual([true, false])
    expect([needsUser(open), needsUser(answered)]).toEqual([true, false])
    expect(taskCounts([open, answered]).attention).toBe(1)
  })
})

describe('host times (round 2)', () => {
  it('live actions carry epoch-ms numbers, revoked ones ISO times in their receipt', () => {
    const live = actionTask(project, { id: 'n', action: 'work', status: 'completed', content: 'x', createdAt: NOW - 120_000, startedAt: NOW - 90_000, finishedAt: NOW - 60_000 }, NOW, ended)!
    expect(live.at).toBe(NOW - 60_000)
    expect(live.when).toBe('1 分钟前')
    expect(live.flags).toContain('fresh')
    expect(actionTask(project, { id: 'q', action: 'work', status: 'queued', content: 'x', createdAt: NOW - 30_000 }, NOW)!.at).toBe(NOW - 30_000)
  })
})

describe('plain words, never codes (F13, F15, F17, F51)', () => {
  it('a host deadline is not the model service', () => {
    expect(failureSentence('action_timeout', 'cancelled')).toBe('这次工作超过了单次后台时限，没做完；已做完的部分都保留着。')
    expect(failureSentence('idle_timeout')).toBe('模型服务这次没有及时响应，工作没做完。')
  })
  it('every waiting or cancel reason reads as words, an unmapped one as a general line', () => {
    expect(actionReason('below_threshold', 'cancelled')).toBe('价值低于当前门槛')
    expect(actionReason('narrator_away', 'deferred')).toBe('你暂时不在')
    expect(actionReason('foreground_busy', 'deferred')).toBe('你正在对话里工作，等这一轮结束')
    // B3 F4: a question held for the user's return waits on its record, not as a general line.
    expect(actionReason('narrator_held', 'deferred')).toBe('问题已暂存，等你回来再问')
    for (const code of ['message_contract', 'project_scope_changed', 'learning_interval', 'narrator_hold', 'some_new_code']) {
      expect(actionReason(code, 'cancelled')).not.toMatch(CODE)
      expect(actionReason(code, 'deferred')).not.toMatch(CODE)
    }
    expect(actionReason(null, 'deferred')).toBe('')
  })
  it('an unsent share says it was not sent, and why — not that work stopped, nor an earlier wait', () => {
    const share = actionTask(project, { id: 's', action: 'share', status: 'cancelled', cancellationReason: 'below_threshold', deferredReason: 'foreground_busy', content: '第 21 条赛道上线' }, NOW, ended)!
    expect(share.summary).toBe('没有发送：价值低于当前门槛')
    // The inspector words it as the row does: the wait before it was cancelled is not why it was not sent.
    const p = { id: 'p', simulated: false, jobs: [], initiativeRuntime: { sdkState: { actions: [{ id: 's', action: 'share', status: 'cancelled', cancellationReason: 'below_threshold', deferredReason: 'foreground_busy' }] } } }
    expect(projectActivity(p)[0].detail).toBe('价值低于当前门槛')
    const waiting = { ...p, initiativeRuntime: { sdkState: { actions: [{ id: 'w', action: 'share', status: 'queued', deferredReason: 'foreground_busy' }] } } }
    expect(projectActivity(waiting)[0].detail).toBe('你正在对话里工作，等这一轮结束')
  })
  it('a share / ask never shows the receipt written for the model (F12)', () => {
    const receipt = 'Structured question 7f1c0b3e-1111-2222-3333-444455556666 was delivered to the project conversation. Status: pending'
    expect(actionTask(project, { id: 'a', action: 'ask', status: 'completed', resultSummary: receipt }, NOW, ended)!.summary).toBeUndefined()
    expect(actionTask(project, { id: 'a', action: 'ask', status: 'completed', resultSummary: receipt, userSummary: '已发到对话，等你回答' }, NOW, ended)!.summary).toBe('已发到对话，等你回答')
    const p = { id: 'p', simulated: false, jobs: [], initiativeRuntime: { sdkState: { actions: [{ id: 'a', action: 'ask', status: 'completed', resultSummary: receipt }] } } }
    expect(projectActivity(p)[0].summary).toBe('')
  })
  it('a review diagnosis is a sentence and the unconfirmed step, not the host instruction or code', () => {
    const lines = reviewDiagnosis('uncertain_tool', [{ toolName: 'project_read', status: 'completed' }, { toolName: 'project_write', status: 'uncertain' }])
    expect(lines[0]).toBe('有一步操作没法确认是否完成，其余结果都保留着。')
    expect(lines[1]).toBe('没能确认是否完成的一步：写入文件')
    expect(lines.join('\n')).not.toMatch(/uncertain_tool|project_write|replay/)
    expect(reviewDiagnosis(null, [])).toEqual([])
  })
  it('a schedule run reads without its error code', () => {
    expect(occurrenceText({ status: 'failed', errorCode: 'action_timeout' })).toBe('执行失败 · 这次工作超过了单次后台时限，没做完；已做完的部分都保留着。')
    expect(occurrenceText({ status: 'needs_review', errorCode: 'uncertain_tool' })).not.toMatch(CODE)
    expect(occurrenceText({ status: 'delivered', deliveredAt: iso(0), errorCode: null })).toBe('已送达会话')
  })
  it('task names drop evidence handles, record ids and tool names, and prefer the host label (C-d)', () => {
    expect(actionTitle({}, { content: 'E16 批次独立读回验证＋为日程 rev10 同步取数。\n第二行' })).toBe('批次独立读回验证＋为日程 rev10 同步取数。')
    // The host label is the decision's title cleaned of ids and tool names; the raw title is not (round 2).
    expect(actionTitle({}, { content: '目标＝推进主线（E3）', title: '用 project_history 核对第 9 章（turn e666f3a6）', label: '用核对第 9 章' })).toBe('用核对第 9 章')
    expect(actionTitle({}, { content: '目标＝推进主线（E3）', label: '推进主线' })).toBe('推进主线')
    // A host without labels: its title and content are cleaned here.
    expect(actionTitle({}, { content: '目标', title: '核对第 9 章（turn e666f3a6）' })).toBe('核对第 9 章')
    expect(actionTitle({}, { content: '用 project_history 读失败动作 007c353e 的记录' })).toBe('用读失败动作的记录')
    const p = { id: 'p', simulated: false, jobs: [], initiativeRuntime: { sdkState: { actions: [{ id: 'w', action: 'work', status: 'running', content: '核对 E2 与 E14 的冲突\n再用 project_write 改 out/3fa9b2c1.png', reason: '用户提到矛盾（turn e666f3a6）（E5）。' }] } } }
    expect(projectActivity(p)[0]).toMatchObject({ intent: '核对的冲突\n再用改 out/3fa9b2c1.png', reason: '用户提到矛盾。' })
  })
  it('withoutHandles and withoutInternals match the host port', () => {
    for (const text of ['E16 批次独立读回验证', '核对 E2 与 E14 的冲突', 'Fix E3 then E4 later', '用户提到矛盾（E5）。', 'E1E2 stays', 'see E1234', '读回（E1, E2）', 'Check the output (E2).', 'Continue chapter 11 (E4, E5).', '根据 E3、E5 继续写', 'Draft the outline from E2 and E3.', '按 E2 和 E3 写', '根据 E3 的结论继续', 'Compare E2/E3 results'])
      expect(withoutHandles(text)).toBe(hostWithoutHandles(text))
    for (const text of ['核对（turn e666f3a6）', '用 project_history 读失败动作 007c353e', 'session: 4b1f0c2e-1111-2222-3333-444455556666 结束', 'call mcp__github__search then skill_load', 'keep project_notes.md and out/3fa9b2c1.png', 'Fix the 2026 build', 'run abc1234 again',
      'Fix the decade1 bug', 'Rewrite chapter cafe1234 now.', 'Run the deploy for session abcdef12.', 'Set #ffaa0011 as the colour', 'Check "skill_load" output', '查看任务 3fa9b2c1e 的回执', 'Run cafe1234 again', 'Turn deadbeef1 off'])
      expect(withoutInternals(text)).toBe(hostWithoutInternals(text))
    // A bare hex-looking word is an ordinary word; an id goes only where it names a record.
    expect(withoutInternals('Fix the decade1 bug')).toBe('Fix the decade1 bug')
  })
})

describe('after a scope change, the record stays as a receipt (F40, F12 display via C-d)', () => {
  it('a revoked action is named by its label and never by the placeholder content', () => {
    const revoked = { id: 'r', action: 'work', status: 'completed', revoked: true, content: 'Previous project scope; retained only as an action receipt.', label: '把第 1–10 章重写', receipt: { label: '把第 1–10 章重写', status: 'completed', startedAt: iso(-3_600_000), finishedAt: iso(-1_800_000), handoff: '第 1–10 章已替换。' } }
    const task = actionTask(project, revoked, NOW, ended)!
    expect(task).toMatchObject({ title: '把第 1–10 章重写', revoked: true, state: 'done', controls: [], summary: '第 1–10 章已替换。', at: NOW - 1_800_000 })
    expect(actionTask(project, { ...revoked, label: undefined, receipt: null }, NOW, ended)!.title).toBe('自主执行')
  })
})

describe('a plan line is not live work (F47)', () => {
  it('a line stopped background work moved back reads 上次停在这里 and keeps the plan order (F85, round 2)', () => {
    const plan = { doing: [{ id: 'd', text: '复查第 3 章', status: 'doing', updatedAt: iso(-86_400_000) }],
      next: [{ id: 'n1', text: '写第 4 章', status: 'next', updatedAt: iso(-1000) }, { id: 'n2', text: '写第 5 章', status: 'next', updatedAt: iso(-5000), interruptedAt: iso(-6000) }], done: [] }
    const tasks = planTasks({ ...project, plan } as TaskProjectInput, NOW)
    expect(tasks.map(t => [t.id, t.stateLabel, t.planIndex])).toEqual([['d', '正在做', 0], ['n2', '上次停在这里', 1], ['n1', '接下来', 2]])
    expect(tasks[1].when).toBe('上次停在这里')
    // On the page: the plan's order, not the latest edit first (a 接下来 line edited later stays below 正在做).
    expect([...tasks].reverse().sort(byOpen).map(t => t.id)).toEqual(['d', 'n2', 'n1'])
  })
  it('正在做 has no live state and no badge count', () => {
    const tasks = planTasks({ ...project, plan: { doing: [{ id: 'd', text: '复查第 3 章', status: 'doing', updatedAt: iso(-86_400_000) }], next: [{ id: 'n', text: '写第 4 章', status: 'next' }], done: [] } } as TaskProjectInput, NOW)
    expect(tasks.map(t => t.state)).toEqual(['scheduled', 'scheduled'])
    expect(tasks[0].stateLabel).toBe('正在做')
    expect(taskCounts(tasks).active).toBe(0)
    expect(badgeCount(tasks)).toBe(0)
  })
})

describe('delivery location (F59)', () => {
  it('a share message and an ask card carry the item to open', () => {
    expect(deliveryReceipt({ id: 'i1', kind: 'assistant', source: 'initiative', initiativeActionId: 's', createdAt: iso(0) }, 'sess')).toEqual(['share:s', { at: iso(0), sessionId: 'sess', itemId: 'i1' }])
    expect(deliveryReceipt({ id: 'i2', kind: 'question', source: 'interaction', interaction: { id: 'q', source: 'initiative', actionId: 'a', status: 'pending' } }, 'sess')?.[0]).toBe('ask:a')
    expect(deliveryReceipt({ id: 'i3', kind: 'assistant', source: 'initiative', initiativeActionId: 's', contextRevoked: true }, 'sess')).toBeNull()
    const p = { id: 'p', simulated: false, jobs: [], initiativeRuntime: { sdkState: { actions: [{ id: 's', action: 'share', status: 'completed' }] } } }
    expect(projectActivity(p, [{ id: 'sess', projectId: 'p', items: [{ id: 'i1', kind: 'assistant', source: 'initiative', initiativeActionId: 's' }] }])[0]).toMatchObject({ deliverySessionId: 'sess', deliveryItemId: 'i1' })
  })
})
