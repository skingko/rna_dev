/**
 * 正在清理已删除的会话: durable cleanup receipts for deleted conversations
 * (`GET /api/v2/session-deletions`) with a retry (`POST /api/session-deletions/:id/retry`).
 * Receipts carry identities and statuses only, never conversation text.
 * Polls while any cleanup is pending; hidden on daemons without the route.
 * A blocked cleanup (it cannot clear on its own) says what it waits for, and offers the decision the host names
 * (`choice`, `POST /api/session-deletions/:id/decide`), confirmed by a second click.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { AlertTriangle, Check, Eraser, RotateCw } from 'lucide-react'
import { supportApi, type SessionDeletion } from '@/api/support-api'
import { panelsApi } from '@/api/panels'
import { useApp } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { Button } from '@/components/ui/primitives'
import { formatDate, useLocale, useT, type TFunction } from '@/i18n'

const POLL_MS = 5000

export function cleanupDetail(row: SessionDeletion, t: TFunction) {
  const local = row.localStatus === 'completed' ? t('本机会话文件已清理') : t('本机会话文件待清理')
  const remote = row.remoteStatus === 'completed' || row.remoteStatus === 'not_required' ? t('远端记录已处理') : row.remoteStatus === 'kept_by_user' ? t('远端记录按你的决定保留') : t('远端会话记录待清理')
  return `${local} · ${remote}`
}

/**
 * Why a blocked cleanup waits for the user, by the decision the host names and the choice it offers (its own notice
 * for one this page does not know).
 */
export function cleanupDecision(row: SessionDeletion, t: TFunction): string {
  switch (`${row.decision}:${row.choice ?? ''}`) {
    case 'execution:release_runs': return t('一项后台工作有一步操作没能确认是否完成，它的运行记录要等你核对后才能删除。请在项目的后台工作里确认它的结果，确认后清理会自动继续；也可以点“不核对，直接删除”，运行记录随对话删除，那一步是否完成将无法再核对。')
    case 'execution:': return t('一项后台工作有一步操作没能确认是否完成，它的运行记录要等你核对后才能删除。请在项目的后台工作里确认它的结果，确认后清理会自动继续。')
    case 'too_large:remove_entry': return t('有一份运行记录超出了清理能安全读取的大小，无法核对它是否属于这个对话。点“删除这份记录”会不读取直接删除它，然后继续清理。')
    case 'too_large:read_all': return t('这个项目的运行记录总量超出了清理一次能读取的上限。点“全部读取”会在这次清理中不设总量上限，读完后继续清理（可能需要一些时间）。')
    case 'too_large:': return t('有一份运行记录超出了清理能安全读取的大小，无法核对，所以没有删除。')
    case 'unsafe:remove_entry': return t('运行记录的文件夹里有链接，或有在别处也被引用的文件，清理不会顺着它们删除。点“删除这份记录”只删除这一个链接或文件名本身（它指向的内容不受影响），然后继续清理。')
    case 'unsafe:': return t('运行记录的文件夹里有链接，或有在别处也被引用的文件，清理不会顺着它们删除。检查这个文件夹后再点“重试清理”。')
    case 'damaged:remove_entry': return t('有运行记录或归档已损坏或无法识别，清理无法确认它属于哪个对话。点“删除这份记录”会不读取直接删除它，然后继续清理。')
    case 'damaged:rebuild': return t('这次删除的清理记录已损坏。点“重建清理记录”会按这个对话的标识重新查找相关数据，然后继续清理。')
    case 'damaged:': return t('有运行记录或归档已损坏或无法识别，清理无法确认它属于哪个对话，所以没有删除。')
    // Older hosts name no choice: their memory texts promise nothing to click.
    case 'memory_changed:keep_remote': return t('记忆服务的地址、密钥或账号在删除之后变了，无法确认远端记录属于这次删除。恢复原来的记忆服务设置后会自动继续；也可以点“保留远端记录”，不再删除它们，结束这次清理。')
    case 'memory_changed:': return t('记忆服务的地址、密钥或账号在删除之后变了，无法确认远端记录属于这次删除。恢复原来的记忆服务设置后会自动继续。')
    case 'memory_mismatch:keep_remote': return t('远端的对话记录与删除时记下的身份对不上，所以没有删除。点“保留远端记录”会不再删除它，结束这次清理。')
    case 'memory_mismatch:': return t('远端的对话记录与删除时记下的身份对不上，所以没有删除。')
    case 'memory_differs:keep_remote': return t('远端的一份证据文件已不是当初写入的内容，无法确认归属，所以没有删除。点“保留远端记录”会不再删除它，结束这次清理。')
    case 'memory_differs:': return t('远端的一份证据文件已不是当初写入的内容，无法确认归属，所以没有删除。')
    default: return row.notice || t('这项清理无法自行完成，需要你决定。')
  }
}

/** The button for the decision a blocked cleanup offers (null: nothing to decide here, or a choice this page does not know). */
export function cleanupChoiceLabel(row: SessionDeletion, t: TFunction): string | null {
  switch (row.status === 'blocked' ? row.choice : null) {
    case 'release_runs': return t('不核对，直接删除')
    case 'remove_entry': return t('删除这份记录')
    case 'read_all': return t('全部读取')
    case 'rebuild': return t('重建清理记录')
    case 'keep_remote': return t('保留远端记录')
    default: return null
  }
}

export function useSessionDeletions(active: boolean) {
  const [rows, setRows] = useState<SessionDeletion[] | null>(null)
  const load = useCallback(async () => {
    try { const result = await supportApi.sessionDeletions(); setRows(result ? result.deletions : null) } catch { /* keep the last list */ }
  }, [])
  const pending = rows?.some(row => row.status !== 'completed') ?? false
  useEffect(() => { if (active) void load() }, [active, load])
  useEffect(() => {
    if (!active || !pending) return
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [active, pending, load])
  return { rows, reload: load }
}

export function CleanupRows({ active }: { active: boolean }) {
  const t = useT()
  const locale = useLocale()
  const projects = useApp(s => s.projects)
  const { rows, reload } = useSessionDeletions(active)
  const [busy, setBusy] = useState<string | null>(null)
  // The decision is taken on a second click within a few seconds (it removes or keeps records for good).
  const [armed, setArmed] = useState<string | null>(null)
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(disarm.current), [])
  const pending = (rows ?? []).filter(row => row.status !== 'completed')
  if (!pending.length) return null

  const decide = async (row: SessionDeletion) => {
    if (armed !== row.sessionId) { setArmed(row.sessionId); clearTimeout(disarm.current); disarm.current = setTimeout(() => setArmed(null), 5000); return }
    clearTimeout(disarm.current); setArmed(null); setBusy(row.sessionId)
    try {
      const result = await panelsApi.decideDeletion(row.sessionId, String(row.choice))
      const status = result.cleanup?.status
      toast(status === 'completed' ? t('会话记录已完成清理。') : status === 'blocked' ? t('清理仍需要你决定。') : t('清理尚未完成，稍后会自动重试。'), status === 'completed' ? 'success' : 'default')
      await reload()
    } catch (error) { toast((error as Error).message, 'danger') } finally { setBusy(null) }
  }

  const retry = async (row: SessionDeletion) => {
    setBusy(row.sessionId)
    try {
      const result = await panelsApi.retryDeletion(row.sessionId)
      const status = result.cleanup?.status
      toast(status === 'completed' ? t('会话记录已完成清理。') : status === 'blocked' ? t('清理仍需要你决定。') : t('清理尚未完成，稍后会自动重试。'), status === 'completed' ? 'success' : 'default')
      await reload()
    } catch (error) { toast((error as Error).message, 'danger') } finally { setBusy(null) }
  }

  return (
    <section aria-labelledby="cleanup-heading" className="mt-4 border-t border-line-faint pt-3">
      <h3 id="cleanup-heading" className="px-3 pb-1 text-[12px] font-medium text-fg-3">{t('正在清理已删除的会话')}</h3>
      {pending.map(row => {
        const review = row.status === 'recovery_review'
        // Blocked: nothing will clear it on its own, so it says what it waits for instead of promising a retry.
        const blocked = row.status === 'blocked'
        const attention = review || blocked
        const project = row.projectId ? projects[row.projectId] : undefined
        const choice = blocked ? cleanupChoiceLabel(row, t) : null
        return (
          <motion.div key={row.sessionId} layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex items-start gap-3 rounded-xl px-3 py-2.5" data-cleanup-session-id={row.sessionId}>
            <span className={attention ? 'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning' : 'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-fg-3'}>
              {attention ? <AlertTriangle className="size-4" /> : <Eraser className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <strong className="block truncate text-[13.5px] font-medium text-fg">{blocked ? t('清理需要你决定') : review ? t('清理待核对') : t('聊天记录清理中')}</strong>
              <span className="block text-[12px] text-fg-4">
                {t('会话 {id}', { id: row.sessionId.slice(0, 8) })}{project ? ` · ${project.name}` : ''} · {cleanupDetail(row, t)}
              </span>
              <span className="block text-[12px] leading-[1.6] text-fg-4">
                {blocked ? cleanupDecision(row, t) : review ? t('应用恢复后需要核对这项清理，确认后再继续；不会自动重复删除。') : t('服务恢复后自动继续；项目文件和已提取的项目记忆保留。')}
                {row.retryAt && !attention ? ` ${t('下次自动重试：{time}', { time: formatDate(row.retryAt, locale) })}` : ''}
                {row.attempts > 1 ? ` · ${t('已尝试 {n} 次', { n: row.attempts })}` : ''}
                {row.code ? <span className="ml-1 font-mono text-[11px] text-fg-4">{row.code}</span> : null}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              {choice ? (
                <Button size="sm" variant={armed === row.sessionId ? 'primary' : 'secondary'} disabled={busy !== null} leading={<Check className="size-3.5" />} onClick={() => void decide(row)} data-cleanup-decide={row.sessionId}>
                  {armed === row.sessionId ? t('再点一次确认') : choice}
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" disabled={busy !== null} leading={<RotateCw className={busy === row.sessionId ? 'size-3.5 spin' : 'size-3.5'} />} onClick={() => void retry(row)} data-cleanup-retry={row.sessionId}>
                {t('重试清理')}
              </Button>
            </div>
          </motion.div>
        )
      })}
    </section>
  )
}
