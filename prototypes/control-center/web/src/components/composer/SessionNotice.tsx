/**
 * Notice above the composer (legacy renderPauseNotice): maintenance hold,
 * restored-session history, global emergency stop, paused turn (resume or
 * review interrupted operations), a turn refused until background work is
 * reviewed (go review it), and failed-turn retry. Plus the recovery
 * dialog (session-recovery-ui.js) that records conclusions for uncertain tool
 * calls before resuming — original calls are never replayed.
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { OctagonAlert, PauseCircle, RotateCcw } from 'lucide-react'
import { projectApi, type UncertainTool } from '@/api/project-api'
import type { SessionMeta, Turn } from '@/api/types'
import { useApp } from '@/store/app-store'
import { controlSession, selectProject, selectSession } from '@/store/sync'
import { draftKey } from './Composer'
import { openTasks, toast } from '@/store/ui-store'
import { refreshActions, useTasks } from '@/store/tasks-store'
import { Dialog } from '@/components/ui/overlays'
import { Button } from '@/components/ui/primitives'
import { t as tr, localized } from '@/i18n'
import { useNow } from '@/hooks/useNow'
import { panelsApi } from '@/api/panels'
import { reloadGlobals, useGlobals } from '@/components/settings/globals-store'
import { setEmergency } from '@/components/settings/emergency'
import { openProjectSettings } from '@/components/settings/panel-store'

const PAUSE_REASONS: Record<string, string> = localized({ manual: '本轮已暂停，仍可补充消息。', recovery: '本轮等待恢复，已保存的消息将接续处理。', emergency: '全局急停已解除，请按需恢复本轮。' })

export function SessionNotice({ sessionId }: { sessionId: string | null }) {
  const meta = useApp(s => (sessionId ? s.sessions[sessionId]?.meta : undefined))
  const last = useApp(s => {
    const slice = sessionId ? s.sessions[sessionId] : undefined
    if (!slice) return undefined
    return Object.values(slice.turns).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')).at(-1)
  })
  const emergency = useApp(s => s.emergency)
  const held = useApp(s => s.maintenanceHeld)
  const [busy, setBusy] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const uncertain = meta?.runtime?.recovery?.uncertainTools ?? []
  const retryable = meta?.status === 'idle' && last?.status === 'failed' && last?.modelConfig?.execution === 'rna'
  // Refused because background work waits for review: retrying fails the same way until it is settled on the task page.
  const projectId = meta?.projectId ?? null
  const refused = meta?.status === 'idle' && last?.status === 'failed' && last?.errorCode === 'background_recovery_required'
  const blocking = refused ? last as Turn & { blockingActionId?: string | null; blockingDraining?: boolean } : null
  const blockingId = blocking?.blockingActionId ?? null
  // Background work was still stopping when the turn began (C2-b): nothing to review, only to retry in a moment.
  const draining = blocking?.blockingDraining === true
  // true: still waiting for review · false: settled · null: not known here (actions not loaded, or the host did not name it).
  const stillBlocking = useTasks(s => {
    const row = refused && projectId && blockingId ? s.actions[projectId]?.find(a => a.id === blockingId) : undefined
    return row ? row.status === 'needs_review' && row.blocksExecution !== false : null
  })
  // The snapshot may predate a decision made elsewhere (a card answered, a review recorded): read it again (C2-d).
  useEffect(() => { if (projectId && blockingId) void refreshActions(projectId) }, [projectId, blockingId])
  // Without a named action, the review list still lives on 临时任务, whatever tab the task page was left on.
  const review = () => { if (projectId) openTasks(projectId, blockingId ? { key: `${projectId}:action:${blockingId}` } : null, 'adhoc') }

  // A restore-point conversation continues in a new one: same project, the last instruction already in the composer (§2.5 item 9).
  const lastInstruction = useApp(s => {
    const slice = sessionId ? s.sessions[sessionId] : undefined
    return slice ? [...slice.order].reverse().map(id => slice.items[id]).find(item => item?.kind === 'user' && (!item.source || item.source === 'user') && item.text?.trim())?.text ?? '' : ''
  })
  const continueFresh = () => {
    const projectId = meta?.projectId ?? null
    try { if (lastInstruction) localStorage.setItem(draftKey(null, projectId), lastInstruction) } catch { /* the composer just starts empty */ }
    if (projectId) selectProject(projectId)
    void selectSession(null)
  }
  // One answer for every uncertain step: carry on from how things are now, or redo it; then resume.
  const settle = async (choice: 'continue' | 'redo') => {
    if (!meta) return
    setBusy(true)
    try { await projectApi.recovery(meta.id, { choice }); await controlSession('resume') }
    catch (e) { toast((e as Error).message, 'danger') } finally { setBusy(false) }
  }
  const control = async (action: 'resume' | 'retry') => {
    setBusy(true)
    try { await controlSession(action); if (action === 'retry') toast(tr('已提交继续请求，待处理指令将从原轮次接续。')) }
    catch (e) { toast((e as Error).message, 'danger') } finally { setBusy(false) }
  }

  // A transient model failure retries by itself; show the wait, not a failure.
  const waitingRetry = retryable && last?.autoRetry?.nextAt ? Date.parse(last.autoRetry.nextAt) : null
  const now = useNow(Boolean(waitingRetry))
  const seconds = waitingRetry ? Math.max(0, Math.ceil((waitingRetry - now) / 1000)) : 0
  // Out of today's allowance: raise it or lift it right here, then carry on.
  const budget = retryable && last?.errorCode === 'budget'
  const raise = async (unlimited: boolean) => {
    setBusy(true)
    try {
      const current = (await reloadGlobals().then(() => useGlobals.getState().settings))?.realTokenBudget ?? null
      await panelsApi.patchSettings({ realTokenBudget: unlimited || current === null ? null : Math.ceil(current * 1.5) })
      await controlSession('retry')
    } catch (e) { toast((e as Error).message, 'danger') } finally { setBusy(false) }
  }

  let content: { icon: typeof PauseCircle; tone: 'warning' | 'danger' | 'default'; text: string; action?: { label: string; run: () => void }; secondary?: { label: string; run: () => void }; tertiary?: { label: string; run: () => void } } | null = null
  if (held) content = { icon: PauseCircle, tone: 'warning', text: tr('应用正在更新。现在发的消息会在更新完成后自动发出，正在进行的工作照常收尾。') }
  else if (meta?.appRecovery?.required) content = { icon: RotateCcw, tone: 'warning', text: tr('这段会话来自恢复点，只保留历史。可以在新会话里接着做，最后一条指令会带过去。'), action: emergency ? undefined : { label: tr('在新会话继续'), run: () => continueFresh() } }
  // Released as in 设置 and the top bar: the host switches back on what the stop switched off, and the line says so (C-h).
  else if (emergency) content = { icon: OctagonAlert, tone: 'danger', text: tr('全局急停中。草稿与队列已保留。'), action: { label: tr('解除急停'), run: () => void setEmergency(false).then(line => toast(line)).catch(e => toast((e as Error).message, 'danger')) } }
  else if (meta?.status === 'paused' && uncertain.length) content = {
    icon: PauseCircle, tone: 'warning', text: uncertainSentence(uncertain),
    action: { label: tr('按现在的继续'), run: () => void settle('continue') },
    secondary: { label: tr('重做这一步'), run: () => void settle('redo') },
    tertiary: { label: tr('细看…'), run: () => setRecovering(true) },
  }
  else if (meta?.status === 'paused') content = {
    icon: PauseCircle, tone: 'warning',
    text: meta.pauseReason === 'budget' ? (meta.modelConfig?.execution === 'rna' ? tr('已达到你设置的真实调用额度，本轮已暂停。') : tr('演示预算不足，本轮已暂停。')) : PAUSE_REASONS[meta.pauseReason ?? ''] ?? tr('本轮已暂停。'),
    action: { label: uncertain.length ? tr('核对操作') : tr('恢复'), run: () => (uncertain.length ? setRecovering(true) : void control('resume')) },
  }
  else if (refused && draining && retryable) content = {
    icon: RotateCcw, tone: 'default', text: tr('后台工作刚才还在停下，这一轮没有动工作区；现在可以重试。'),
    action: { label: tr('重试请求'), run: () => void control('retry') },
  }
  else if (refused && stillBlocking === false && retryable) content = {
    icon: RotateCcw, tone: 'default', text: tr('后台那项工作已经核对，可以重试刚才的请求。'),
    action: { label: tr('重试请求'), run: () => void control('retry') },
  }
  else if (refused && !draining && projectId && stillBlocking !== false) content = {
    icon: PauseCircle, tone: 'warning', text: tr('后台有一项工作被打断，结果还没核对；核对之后才能继续这里的请求。'),
    action: { label: tr('去核对'), run: review },
    ...(stillBlocking === null && retryable ? { secondary: { label: tr('重试请求'), run: () => void control('retry') } } : {}),
  }
  else if (waitingRetry && seconds > 0) content = {
    icon: RotateCcw, tone: 'default',
    text: tr('模型暂时没响应，{seconds} 秒后自动重试（第 {n}/{of} 次）。', { seconds, n: last!.autoRetry!.attempts, of: last!.autoRetry!.of }),
    action: { label: tr('立即重试'), run: () => void control('retry') },
  }
  else if (budget) content = {
    icon: PauseCircle, tone: 'warning',
    text: tr('今天的调用额度用完了。'),
    action: { label: tr('再加一半并继续'), run: () => void raise(false) },
    secondary: { label: tr('不限制'), run: () => void raise(true) },
  }
  // The project folder was moved, renamed or deleted: a retry fails the same way until it is back where the project points.
  else if (retryable && last?.errorCode === 'workspace_missing' && projectId) content = {
    icon: OctagonAlert, tone: 'warning', text: tr('找不到项目文件夹，它可能被移动、改名或删除了。放回原处后再重试。'),
    action: { label: tr('查看文件夹路径'), run: () => openProjectSettings(projectId, 'overview') },
    secondary: { label: tr('重试请求'), run: () => void control('retry') },
  }
  else if (retryable) content = {
    icon: RotateCcw, tone: 'default',
    text: last?.errorCode === 'step_limit' ? tr('已达到本次步骤保护上限，执行记录和待处理指令已保留。继续后接续处理。') : tr('上次请求未完成，内容和执行记录已保留。'),
    action: { label: last?.errorCode === 'step_limit' ? tr('继续请求') : tr('重试请求'), run: () => void control('retry') },
  }

  return (
    <>
      <AnimatePresence initial={false}>
        {content && (
          <motion.div key={content.text} role="status" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
            className="mx-2 mb-2 flex items-center gap-2.5 rounded-xl bg-subtle px-3.5 py-2 text-[13px] leading-5 text-fg-2 shadow-[inset_0_0_0_1px_var(--line)]">
            <content.icon className={content.tone === 'danger' ? 'size-4 shrink-0 text-danger' : content.tone === 'warning' ? 'size-4 shrink-0 text-warning' : 'size-4 shrink-0 text-fg-3'} strokeWidth={1.8} />
            <span className="min-w-0 flex-1">{content.text}</span>
            {content.tertiary && <button type="button" disabled={busy} onClick={content.tertiary.run} className="shrink-0 rounded text-[12.5px] text-fg-3 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">{content.tertiary.label}</button>}
            {content.secondary && <Button size="sm" variant="ghost" disabled={busy} onClick={content.secondary.run}>{content.secondary.label}</Button>}
            {content.action && <Button size="sm" disabled={busy} onClick={content.action.run}>{busy ? tr('正在提交…') : content.action.label}</Button>}
          </motion.div>
        )}
      </AnimatePresence>
      {meta && <RecoveryDialog open={recovering} onClose={() => setRecovering(false)} session={meta} tools={uncertain} />}
    </>
  )
}

/** "I'm not sure X finished; it now looks like Y. Carry on from here?" (plan §2.5 item 8) */
function uncertainSentence(tools: UncertainTool[]) {
  const first = tools[0], path = first.observed?.path ?? (typeof (first.arguments as { path?: unknown } | undefined)?.path === 'string' ? (first.arguments as { path: string }).path : null)
  const what = first.toolName === 'project_write' && path ? tr('写入 {path}', { path }) : first.toolName === 'project_edit' && path ? tr('修改 {path}', { path }) : first.toolName === 'project_exec' ? tr('运行命令') : first.toolName
  const seen = first.observed
  const state = !seen ? '' : !seen.exists ? tr('现在 {path} 还不存在。', { path: seen.path }) : seen.lines ? (seen.lastLine ? tr('现在 {path} 有 {lines} 行，最后一行是“{last}”。', { path: seen.path, lines: seen.lines, last: seen.lastLine }) : tr('现在 {path} 有 {lines} 行。', { path: seen.path, lines: seen.lines })) : ''
  const head = tools.length > 1 ? tr('有 {n} 步操作不确定有没有做完（先是“{what}”）。', { n: tools.length, what }) : tr('我不确定“{what}”有没有做完。', { what })
  return `${head}${state}${tr('按现在的样子继续吗？')}`
}

const OUTCOMES: [string, string][] = localized([['', '请选择核对结论'], ['completed', '已完成，结果已核实'], ['not-executed', '已确认没有执行'], ['abandoned', '结束旧操作，保留结果未知']])

export function RecoveryDialog({ open, onClose, session, tools }: { open: boolean; onClose: () => void; session: SessionMeta; tools: UncertainTool[] }) {
  const [values, setValues] = useState<Record<string, { status: string; note: string }>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    for (const tool of tools) {
      const v = values[tool.callKey]
      if (!v?.status) { setError(tr('请选择「{toolName}」的核对结论。', { toolName: tool.toolName })); return }
      if (!v.note?.trim()) { setError(tr('请填写「{toolName}」的核对说明。', { toolName: tool.toolName })); return }
    }
    // Freeze every conclusion before the first await.
    const conclusions = tools.map(t => ({ callKey: t.callKey, status: values[t.callKey].status, note: values[t.callKey].note.trim() }))
    setBusy(true); setError('')
    try {
      for (const c of conclusions) await projectApi.recovery(session.id, c)
      await controlSession('resume')
      onClose()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={o => { if (!o && !busy) onClose() }} title={tr('核对中断操作')}
      description={tr('文件操作会先自动读取当前状态。以下操作仍缺少可核实的结果；记录结论后，原调用不会被重放。')}
      footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>{tr('返回')}</Button><Button variant="primary" disabled={busy} onClick={() => void submit()}>{tools.length ? tr('保存并继续') : tr('核对并继续')}</Button></>}>
      <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
        {tools.map(tool => {
          const v = values[tool.callKey] ?? { status: '', note: '' }
          const set = (patch: Partial<typeof v>) => setValues(prev => ({ ...prev, [tool.callKey]: { ...v, ...patch } }))
          return (
            <section key={tool.callKey} className="rounded-xl bg-subtle p-3">
              <strong className="text-[13.5px] text-fg">{tool.toolName}</strong>
              <details className="mt-1 text-[12.5px]"><summary className="cursor-pointer text-fg-3">{tr('查看原操作')}</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[12px] text-fg-2">{JSON.stringify(tool.arguments, null, 2)}</pre></details>
              <select aria-label={tr('{toolName} 操作结论', { toolName: tool.toolName })} value={v.status} disabled={busy} onChange={e => set({ status: e.target.value })} className="mt-2 h-9 w-full rounded-lg bg-base px-2.5 text-[13px] text-fg shadow-[inset_0_0_0_1px_var(--line)] outline-none">
                {OUTCOMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <textarea aria-label={tr('核对说明')} value={v.note} disabled={busy} maxLength={4000} rows={3} onChange={e => set({ note: e.target.value })}
                placeholder={tr('记录已检查的文件、回执或进程；如果结果未知，请说明仍需核实的事项。')}
                className="mt-2 w-full resize-y rounded-lg bg-base px-2.5 py-2 text-[13px] text-fg shadow-[inset_0_0_0_1px_var(--line)] outline-none placeholder:text-fg-4" />
            </section>
          )
        })}
        {error && <p role="status" className="text-[12.5px] text-danger">{error}</p>}
      </div>
    </Dialog>
  )
}
