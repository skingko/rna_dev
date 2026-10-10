/**
 * Dialog for commands that need text: 目标 / 反馈 / 压缩 (legacy
 * createCommandDialog). Drafts persist per session+command. When the outcome is
 * unknown (the response never arrived), the request keeps its id so
 * "核对同一请求" asks about the same run; when the daemon answered with a
 * failure, only "重新执行" (a new request) is offered. A compaction runs on
 * after the dialog closes; its progress and result show in the conversation.
 */
import { useEffect, useRef, useState } from 'react'
import { Dialog } from '@/components/ui/overlays'
import { Button } from '@/components/ui/primitives'
import { ApiError } from '@/api/transport'
import { t, localized } from '@/i18n'

export type TextCommand = 'goal' | 'feedback' | 'compact'

const LABELS: Record<TextCommand, [string, string, string, string]> = localized({
  goal: ['项目当前关注', '当前关注', '保存关注', '这是项目持续关注的方向，不要求你为每一次主动协作创建目标。'],
  feedback: ['项目反馈', '反馈内容', '保存反馈', '反馈保留在当前项目，供后续研究和自主进化使用，不会发送到外部反馈服务。'],
  compact: ['压缩会话上下文', '需要保留的重点（可选）', '开始压缩', '使用当前模型生成真实摘要并计入用量。完整聊天记录仍保留；当前轮次必须已结束。'],
})

export function CommandDialog({ command, sessionId, contextLabel, initial = '', onClose, execute }: {
  command: TextCommand | null; sessionId: string | null; contextLabel: string; initial?: string
  onClose: () => void; execute: (command: TextCommand, text: string, requestId: string) => Promise<void>
}) {
  const key = command && sessionId ? `rna.command-draft.${sessionId}.${command}` : ''
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [canRetryNew, setCanRetryNew] = useState(false)
  // The daemon never answered: the same request may still have finished, so it can be checked.
  const [uncertain, setUncertain] = useState(false)
  const request = useRef<{ text: string; id: string } | null>(null)

  useEffect(() => {
    if (!command) return
    let saved: { text?: string; request?: { text: string; id: string } } | null = null
    try { saved = JSON.parse(localStorage.getItem(key) ?? 'null') } catch { /* ignore */ }
    setText(saved?.text ?? initial); request.current = saved?.request ?? null; setError(''); setCanRetryNew(false); setUncertain(false)
  }, [command, key]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!command) return null
  const [title, label, action, help] = LABELS[command]
  const persist = (value: string, req = request.current) => { try { localStorage.setItem(key, JSON.stringify({ text: value, ...(req ? { request: req } : {}) })) } catch { /* ignore */ } }

  const submit = async (fresh = false) => {
    const value = text.trim()
    if (busy || (command !== 'compact' && !value)) return
    if (fresh || !request.current || request.current.text !== value) request.current = { text: value, id: crypto.randomUUID() }
    persist(text)
    setBusy(true); setCanRetryNew(false); setUncertain(false); setError(command === 'compact' ? t('压缩在后台进行，可以关闭此窗口；进度和结果会显示在对话里。') : t('正在执行…'))
    try { await execute(command, value, request.current.id); try { localStorage.removeItem(key) } catch { /* ignore */ } onClose() }
    // A dropped connection or a timeout (status 0) never heard back either.
    catch (e) { setError((e as Error).message); setCanRetryNew(true); setUncertain(!(e instanceof ApiError) || e.status === 0) }
    finally { setBusy(false) }
  }

  // A running compaction does not need the dialog open.
  const closable = !busy || command === 'compact'
  const retryNew = <Button variant={uncertain ? 'ghost' : 'primary'} disabled={busy} title={t('明确发起新请求；模型压缩可能产生新的调用用量。')} onClick={() => void submit(true)}>{t('重新执行')}</Button>
  return (
    <Dialog open onOpenChange={o => { if (!o && closable) onClose() }} title={title} description={<>{contextLabel}<br />{help}</>}
      footer={<>
        {canRetryNew && uncertain && retryNew}
        <Button variant="ghost" disabled={!closable} onClick={onClose}>{busy ? t('关闭') : t('取消')}</Button>
        {canRetryNew && !uncertain ? retryNew
          : <Button variant="primary" disabled={busy || (command !== 'compact' && !text.trim())} onClick={() => void submit()}>{canRetryNew ? t('核对同一请求') : action}</Button>}
      </>}>
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">{label}</span>
        <textarea autoFocus value={text} disabled={busy} maxLength={command === 'feedback' ? 8000 : 4000} rows={5}
          onChange={e => { setText(e.target.value); request.current = null; persist(e.target.value, null) }}
          className="min-h-32 w-full resize-y rounded-lg bg-subtle px-3 py-2 text-[13.5px] leading-[1.6] text-fg outline-none shadow-[inset_0_0_0_1px_var(--line)] focus:shadow-[inset_0_0_0_1px_var(--line-focus)]" />
      </label>
      {error && <p role="status" className="mt-2 text-[12.5px] text-fg-3">{error}</p>}
    </Dialog>
  )
}
