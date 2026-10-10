/**
 * Background subagent (E2): a compact live row — role · task · status ·
 * elapsed · last tool / tool count — that expands to the summary, usage and
 * diagnostics, with cancel and "send message" while it runs. Its completion
 * delivery (source 'subagent') renders as a system notice, never a bubble.
 */
import { memo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, Bot, CircleSlash, Eye, GitMerge, Loader2, Send, Sparkles, Square, Trash2, Undo2 } from 'lucide-react'
import { projectApi } from '@/api/project-api'
import { worktreeApi } from '@/api/worktree-api'
import { ApiError } from '@/api/transport'
import type { Item, SubagentInfo } from '@/api/types'
import { useApp, useItem } from '@/store/app-store'
import { toast, toggleDisclosure, useUi } from '@/store/ui-store'
import { elapsed, formatDuration, formatTokens } from '@/lib/format'
import { useNow } from '@/hooks/useNow'
import { DisclosureRow } from '@/components/ui/primitives'
import { Markdown } from '@/components/markdown/Markdown'
import { cn } from '@/lib/utils'
import { conflictKindText, isolationReasonText, subagentMergeView, USER_ONLY } from '@/lib/isolation'
import { loadWorktrees, refreshIsolation, useIsolation } from '@/store/isolation-store'
import { loadGitStatus } from '@/lib/workspace-changes'
import { openApplyHistory, openWorktreeAt } from '@/components/panels/worktree/sheets'
import { TwoStepConfirm } from './TwoStepConfirm'
import { t, localized, interpolate } from '@/i18n'

const STATUS: Record<string, { label: string; tone: string }> = localized({
  running: { label: '进行中', tone: 'text-accent-text' },
  completed: { label: '已完成', tone: 'text-success' },
  failed: { label: '未完成', tone: 'text-danger' },
  cancelled: { label: '已取消', tone: 'text-warning-text' },
  interrupted: { label: '已中断', tone: 'text-warning-text' },
})
const DELIVERY: Record<string, string> = localized({ awaiting: '等待送达', joined: '已并入本轮', reported: '已汇报', pending: '待送达', steered: '已在运行中加入', noticed: '已通知', woke: '已开启后续轮次', none: '不送达' })
// The SDK's role names (agent-delegation.mjs), in the interface language.
const ROLE: Record<string, string> = localized({ scout: '项目侦察', planner: '方案规划', reviewer: '交付审阅', worker: '实现协作' })

/** The subagent's status in words (the trajectory detail shares it). */
export const subagentStatusLabel = (status?: string) => STATUS[status ?? '']?.label ?? status ?? ''
/** The role in the interface language; the host's stored `roleName` (Chinese) only for a role this list does not know. */
export const subagentRoleName = (sub: Pick<SubagentInfo, 'roleName' | 'role'>) => ROLE[sub.role ?? ''] || sub.roleName || t('子代理')

export const SubagentCard = memo(function SubagentCard({ sessionId, itemId }: { sessionId: string; itemId: string }) {
  const item = useItem(sessionId, itemId)
  const sub = item?.subagent
  const key = `agent:${itemId}`
  const running = sub?.status === 'running'
  const open = useUi(s => s.disclosure[key] ?? false)
  const now = useNow(running)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<'cancel' | 'message' | null>(null)
  if (!item || !sub) return null
  const status = STATUS[sub.status] ?? { label: sub.status, tone: 'text-fg-3' }
  const ms = elapsed(sub.startedAt, running ? null : sub.endedAt ?? null, now)
  const role = subagentRoleName(sub)
  const task = (sub.task || item.text || '').replace(/\s+/g, ' ')
  const activity = running ? [sub.lastTool ? t('最近 {lastTool}', { lastTool: sub.lastTool }) : '', sub.toolCount ? t('{toolCount} 次工具', { toolCount: sub.toolCount }) : ''].filter(Boolean).join(' · ') : sub.toolCount ? t('{toolCount} 次工具', { toolCount: sub.toolCount }) : ''

  const cancel = async () => {
    setBusy('cancel')
    try { await projectApi.cancelAgent(sessionId, sub.agentId); toast(t('已取消子代理，结果会以通知送达本会话。')) }
    catch (e) { toast((e as Error).message, 'danger') } finally { setBusy(null) }
  }
  const send = async () => {
    const text = message.trim()
    if (!text) return
    setBusy('message')
    try { await projectApi.messageAgent(sessionId, sub.agentId, text); setMessage(''); toast(t('消息已送达子代理。')) }
    catch (e) { toast(e instanceof ApiError && e.status === 409 ? t('子代理已结束，消息未送达。') : (e as Error).message, 'danger') } finally { setBusy(null) }
  }

  return (
    <div className="my-0.5">
      <DisclosureRow
        icon={running ? <Loader2 className="spin" /> : sub.status === 'failed' ? <AlertCircle className="text-danger" /> : sub.status === 'completed' ? <Bot /> : <CircleSlash className="text-warning-text" />}
        title={<span className={cn(running && 'text-shimmer')}>{role}</span>}
        summary={<span>{task}</span>}
        meta={<span className="inline-flex items-center gap-2"><span className={status.tone}>{status.label}</span>{activity && <span className="hidden sm:inline">{activity}</span>}{ms !== null && <span>{formatDuration(Math.max(ms, 1000))}</span>}</span>}
        expandable
        open={open}
        onToggle={() => toggleDisclosure(key)}
      />
      <MergeLine sessionId={sessionId} sub={sub} />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
            className="mb-2 ml-6 mt-1 space-y-2 rounded-xl bg-inset px-3.5 py-3 text-[13px] shadow-[inset_0_0_0_1px_var(--line-faint)]">
            {sub.task && <p className="leading-[1.7] text-fg-2"><span className="text-fg-3">{t('任务：')}</span>{sub.task}</p>}
            {sub.summary ? <Markdown text={sub.summary} variant="compact" className="text-[13.5px]" /> : running ? <p className="text-fg-3">{t('子代理在后台运行，完成后结果会送达本会话；可以继续对话。')}</p> : null}
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-fg-3">
              {sub.usage?.totalTokens ? <span>{t('用量 {v} tokens{v2}', { v: formatTokens(sub.usage.totalTokens), v2: sub.usage.estimated ? t('（估算）') : '' })}</span> : null}
              {sub.messages ? <span>{t('收到 {messages} 条补充消息', { messages: sub.messages })}</span> : null}
              {sub.delivery && <span>{DELIVERY[sub.delivery] ?? sub.delivery}</span>}
              {sub.code && <span className="text-danger">{t('诊断：{code}', { code: sub.code })}</span>}
            </p>
            {sub.cleanupUncertain && <p className="text-[12.5px] text-warning-text">{t('有未确认完成的操作，请核对相关文件或进程。')}</p>}
            {sub.merge?.status === 'shared_root' && <p className="text-[12px] text-fg-4">{t('和主对话共用项目文件夹：{reason}', { reason: isolationReasonText(sub.merge.reason) })}</p>}
            {(sub.merge?.conflicts?.length ?? 0) > 0 && (
              <ul className="space-y-0.5 text-[12px]" data-merge-conflicts>
                {sub.merge!.conflicts!.map(row => (
                  <li key={row.path} className="flex min-w-0 gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-fg-2" title={row.path}>{row.path}</span>
                    <span className="shrink-0 text-fg-4">{conflictKindText(row.kind)}{USER_ONLY.has(row.kind) ? ` · ${t('需要你决定')}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
            {running && (
              <div className="flex items-center gap-1.5 pt-1">
                <input value={message} onChange={e => setMessage(e.target.value)} maxLength={4000} disabled={busy !== null}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
                  placeholder={t('给子代理补充说明…')} aria-label={t('给子代理发送消息')}
                  className="h-8 min-w-0 flex-1 rounded-lg bg-base px-2.5 text-[13px] text-fg outline-none shadow-[inset_0_0_0_1px_var(--line)] placeholder:text-fg-4 focus:shadow-[inset_0_0_0_1px_var(--line-focus)]" />
                <button type="button" onClick={() => void send()} disabled={busy !== null || !message.trim()} aria-label={t('发送消息')} className="grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-hover hover:text-fg disabled:opacity-40"><Send className="size-3.5" /></button>
                <button type="button" onClick={() => void cancel()} disabled={busy !== null} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] text-fg-3 hover:bg-danger-soft hover:text-danger disabled:opacity-40"><Square className="size-3 fill-current" />{t('取消')}</button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

const lineButton = 'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-[var(--line-focus)] disabled:opacity-40 [&_svg]:size-3'
/** Why a worker's changes were not merged (`merge.reason` of a pending worker). Since 2026-10-05 the host merges by
 * itself only a worker that finished while the main conversation's turn ran (or that opened a follow-up turn):
 * `unfinished` (failed, interrupted, ran out of steps) and `parent_idle` (no turn was running when it was settled:
 * idle, paused on a question, or a restart) wait here for 合并 / 丢弃. A merge held on the user's Git operation is
 * merged by the host only if a turn runs when it ends; `apply_interrupted` is a merge a crash cut off, which the
 * "interrupted apply" card above the composer settles first. */
const PENDING: Record<string, string> = localized({
  unfinished: '子代理没有做完，改动没有合并',
  parent_idle: '主对话没有在运行，改动没有自动合并',
  cancelled: '已取消，改动没有合并',
  read_only: '项目只读，改动没有合并',
  git_operation: '项目文件夹正在进行 Git 操作，改动暂未合并',
  apply_interrupted: '合并被重启打断，请先处理输入框上方的卡片',
})

/**
 * How a worker's changes reached the parent's files (0.63, worktree design §4.1): merged (with 回退这次合并),
 * conflicts waiting on the main conversation — then, once it is idle, 让 Rna 处理 / 丢弃 / 查看改动, plus 合并 when
 * nothing of it was written yet (an all-or-nothing merge while idle, A4) —, changes not merged (合并 / 丢弃), or
 * dropped. Every write goes through the host (`…/agents/:agentId/merge`).
 */
function MergeLine({ sessionId, sub }: { sessionId: string; sub: SubagentInfo }) {
  const parentBusy = useApp(s => (s.sessions[sessionId]?.meta.status ?? s.sessionIndex[sessionId]?.status ?? 'idle') !== 'idle')
  const projectId = useApp(s => s.sessions[sessionId]?.meta.projectId ?? s.sessionIndex[sessionId]?.projectId ?? null)
  const worktreePath = useIsolation(s => (projectId && sub.worktreeId ? s.worktrees[projectId]?.data?.worktrees.find(row => row.id === sub.worktreeId)?.path ?? null : null))
  const [busy, setBusy] = useState<'merge' | 'handoff' | 'view' | null>(null)
  const view = subagentMergeView(sub, parentBusy)
  if (view.kind === 'none' || view.kind === 'shared_root') return null
  const settled = () => { if (projectId) { refreshIsolation(projectId, sessionId); void loadGitStatus(projectId) } }
  const act = async (action: 'merge' | 'handoff') => {
    setBusy(action)
    try {
      const result = await worktreeApi.agentMerge(sessionId, sub.agentId, action)
      if (action === 'handoff') toast(t('已开始一轮，让 Rna 处理这些改动。'))
      else toast(result.conflicts?.length ? t('已合并 {n} 个文件；{m} 个文件仍有冲突。', { n: result.applied?.length ?? 0, m: result.conflicts.length }) : t('已合并 {n} 个文件。', { n: result.applied?.length ?? 0 }), result.conflicts?.length ? 'default' : 'success')
      settled()
    } catch (e) { toast((e as Error).message, 'danger') } finally { setBusy(null) }
  }
  const look = async () => {
    if (!projectId) return
    let path = worktreePath
    if (!path && sub.worktreeId) {
      setBusy('view')
      await loadWorktrees(projectId)
      setBusy(null)
      path = useIsolation.getState().worktrees[projectId]?.data?.worktrees.find(row => row.id === sub.worktreeId)?.path ?? null
    }
    if (path) openWorktreeAt(projectId, path)
    else toast(t('这个子代理的工作树已经不在了。'), 'danger')
  }
  const drop = (label: string) => (
    <TwoStepConfirm title={view.kind === 'merged' ? t('回退这次合并') : t('丢弃这个子代理的改动')} confirmLabel={view.kind === 'merged' ? t('确认回退') : t('确认丢弃')} danger forceable={false}
      emptyText={t('改动还没有合并进你的文件，丢弃后它的工作树会删除。')}
      preview={() => worktreeApi.previewAgentDrop(sessionId, sub.agentId)}
      confirm={plan => worktreeApi.confirmAgentDrop(sessionId, sub.agentId, plan.confirm)}
      onDone={() => { toast(view.kind === 'merged' ? t('已回退这次合并。') : t('已丢弃这个子代理的改动。'), 'success'); settled() }}
      trigger={(start, pending) => <button type="button" className={lineButton} disabled={pending || busy !== null} onClick={start}>{view.kind === 'merged' ? <Undo2 /> : <Trash2 />}{label}</button>} />
  )
  return (
    <div className="mb-1 ml-6 text-[12.5px] leading-[1.6] text-fg-3" data-subagent-merge={view.kind}>
      {view.kind === 'merged' && (
        <div className="flex flex-wrap items-center gap-1">
          <GitMerge className="size-3.5 text-fg-4" />
          {/* Conflicts settled by keeping your files as they were: nothing was written, so there is nothing to roll back. */}
          {view.applyIds.length ? <><span>{t('已合并 {n} 个文件', { n: view.files })}</span>{drop(t('回退这次合并'))}</> : <span>{t('冲突已处理，保留了你的文件，没有写入改动')}</span>}
        </div>
      )}
      {view.kind === 'conflict' && (
        <div className="flex flex-wrap items-center gap-1">
          <AlertCircle className="size-3.5 text-warning-text" />
          <span className="text-warning-text">{view.waiting ? t('有 {n} 个文件冲突，等待主对话', { n: view.files }) : view.unmerged ? t('有 {n} 个文件冲突，还没有合并任何改动', { n: view.files }) : t('有 {n} 个文件冲突', { n: view.files })}</span>
          {!view.waiting && (
            <>
              {/* Merged all or nothing while the conversation was idle: 合并 brings the clean files in, the conflicts stay listed. */}
              {view.unmerged && <button type="button" className={lineButton} disabled={busy !== null} onClick={() => void act('merge')}><GitMerge />{t('合并')}</button>}
              <button type="button" className={lineButton} disabled={busy !== null} onClick={() => void act('handoff')}><Sparkles />{t('让 Rna 处理')}</button>
              {drop(t('丢弃'))}
              <button type="button" className={lineButton} disabled={busy !== null || !projectId} onClick={() => void look()}><Eye />{t('查看改动')}</button>
            </>
          )}
        </div>
      )}
      {view.kind === 'pending' && (
        <div className="flex flex-wrap items-center gap-1">
          <span>{(view.reason && PENDING[view.reason]) || t('有未合并的改动')}</span>
          <button type="button" className={lineButton} disabled={busy !== null} onClick={() => void act('merge')}><GitMerge />{t('合并')}</button>
          {drop(t('丢弃'))}
          {sub.worktreeId && <button type="button" className={lineButton} disabled={busy !== null || !projectId} onClick={() => void look()}><Eye />{t('查看改动')}</button>}
        </div>
      )}
      {view.kind === 'dropped' && (view.reason !== 'missing' && view.applyIds.length
        // Its merge was rolled back (回退这次合并); 撤销回退 lives with the record in the apply history.
        ? <p className="flex flex-wrap items-center gap-1 text-fg-4"><Undo2 className="size-3.5" /><span>{t('已回退这次合并')}</span>
            {projectId && <><span aria-hidden>·</span><button type="button" className={lineButton} onClick={() => openApplyHistory(projectId, { focus: view.applyIds.at(-1), sessionId })}>{t('查看')}</button></>}</p>
        : <p className={view.reason === 'missing' ? 'text-warning-text' : 'text-fg-4'}>{view.reason === 'missing' ? t('子代理的工作树不见了，它的改动没能合并') : t('已丢弃这个子代理的改动')}</p>)}
    </div>
  )
}

const NOTICE: Record<string, string> = localized({ completed: '子代理完成：{name} · {summary}', failed: '子代理未完成：{name} · {summary}', cancelled: '子代理已取消：{name} · {summary}', interrupted: '子代理已中断：{name} · {summary}' })

/**
 * What a subagent delivery says to the reader. The host's `displayText` (C-c)
 * when present; deliveries recorded before it carry only the prompt written for
 * the model ("[宿主通知 · 子代理完成] agentId=… 角色=…（scout） 状态=…"), so its role and
 * result line are read back out of that fixed host format, never shown raw.
 * `failed` (the warning tone) comes from the subagent's own status (`status`, from its
 * card) or the status that prompt states; the wording itself is never matched.
 */
export function subagentNoticeText(item: Pick<Item, 'text' | 'displayText'>, status?: string | null): { text: string; failed: boolean } {
  const text = item.text ?? ''
  const head = /^\[宿主通知 · 子代理[^\]]*\][^\n]*?角色=([^（\n]*)(?:（([^）\n]*)）)?[^\n]*?状态=(\w+)/.exec(text)
  const settled = status ?? head?.[3] ?? null
  const failed = Boolean(settled) && settled !== 'completed' && settled !== 'running'
  if (item.displayText) return { text: item.displayText, failed }
  if (!head) return { text, failed }
  const body = /\n(?:结果|说明)：([\s\S]*?)(?:\n这是宿主转交的|$)/.exec(text)?.[1] ?? ''
  // One line, as the host's own notice summarizes a result.
  const summary = body.replace(/\s+/g, ' ').trim().slice(0, 600)
  const template = NOTICE[head[3]] ?? NOTICE.failed
  const name = ROLE[head[2] ?? ''] || head[1].trim() || t('子代理')
  return { text: interpolate(template, { name, summary }).replace(/ · $/, ''), failed }
}

/** Each subagent's status in a session by agentId, built once per items snapshot for all the notices that ask. */
const statusIndex = new WeakMap<Record<string, Item>, Map<string, string>>()
function subagentStatus(items: Record<string, Item> | undefined, agentId: string | undefined): string | null {
  if (!items || !agentId) return null
  let index = statusIndex.get(items)
  if (!index) {
    index = new Map()
    for (const row of Object.values(items)) if (row.kind === 'subagent' && row.subagent?.agentId) index.set(row.subagent.agentId, row.subagent.status)
    statusIndex.set(items, index)
  }
  return index.get(agentId) ?? null
}

/** Completion delivery from a subagent: a system notice, not a user bubble. */
export function SubagentNotice({ sessionId, item }: { sessionId: string; item: Item }) {
  const status = useApp(s => subagentStatus(s.sessions[sessionId]?.items, item.agentId))
  const { text, failed } = subagentNoticeText(item, status)
  return (
    <div className="flex items-start gap-2 py-1 text-[12.5px] leading-5 text-fg-3">
      <Bot className={cn('mt-0.5 size-3.5 shrink-0', failed ? 'text-warning-text' : 'text-fg-3')} strokeWidth={1.8} />
      <span className="line-clamp-3 whitespace-pre-wrap">{text}</span>
    </div>
  )
}
