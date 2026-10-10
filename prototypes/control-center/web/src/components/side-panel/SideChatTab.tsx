/**
 * 辅助对话 tab: a compact, fully interactive conversation bound to the
 * current session (its own `kind: 'side'` session on the host). Reuses the
 * main timeline in its compact variant plus a slim composer; an optional
 * quoted selection seeds the context. "加入主对话" promotes the latest answer.
 * Kept mounted while hidden; hidden for 30 s, it lets its session stream go.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CornerUpLeft, Eye, Hammer, Loader2, MessagesSquare, Quote, RotateCw } from 'lucide-react'
import { api } from '@/api/client'
import { sideChatApi } from '@/api/side-panel-api'
import { useApp } from '@/store/app-store'
import { useSidePanel, type SideTabData } from '@/store/side-panel-store'
import { sendSideMessage, stopSideSession, watchSideSession } from '@/store/side-sync'
import { toast } from '@/store/ui-store'
import { Timeline } from '@/components/timeline/Timeline'
import { SendButton } from '@/components/composer/Composer'
import { Button, IconButton, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { typingElsewhere, useStreamWhileVisible } from '@/components/workspace/visibility'
import { createSideSession } from './open'
import { useT } from '@/i18n'

type SideChatData = Extract<SideTabData, { type: 'side-chat' }>

export function SideChatTab({ tab, active = true }: { tab: SideChatData; active?: boolean }) {
  const t = useT()
  const seed = useSidePanel(s => s.seeds[tab.id] ?? null)
  const [failed, setFailed] = useState<string | null>(null)

  // A restored tab whose creation never finished: create it now (deduped across remounts).
  useEffect(() => {
    if (tab.sideSessionId) return
    let live = true
    setFailed(null)
    createSideSession(tab.id, tab.parentSessionId, seed).catch(e => { if (live) setFailed((e as Error).message) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sideSessionId, tab.id, tab.parentSessionId])

  if (!tab.sideSessionId) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-6">
        {failed ? (
          <div className="flex max-w-[320px] flex-col items-center gap-2 text-center">
            <span className="grid size-10 place-items-center rounded-xl bg-danger-soft text-danger"><MessagesSquare className="size-5" /></span>
            <p className="text-[13.5px] font-medium text-fg">{t('无法创建辅助对话')}</p>
            <p className="text-[12.5px] text-fg-3">{failed}</p>
            <Button size="sm" className="mt-2" leading={<RotateCw className="size-3.5" />} onClick={() => { setFailed(null); createSideSession(tab.id, tab.parentSessionId, seed).catch(e => setFailed((e as Error).message)) }}>{t('重试')}</Button>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-fg-3"><Loader2 className="size-4 spin" />{t('正在创建辅助对话…')}</p>
        )}
      </div>
    )
  }
  return <SideConversation key={tab.sideSessionId} sideId={tab.sideSessionId} parentId={tab.parentSessionId} seed={seed} active={active} />
}

function SideConversation({ sideId, parentId, seed, active }: { sideId: string; parentId: string; seed: { text: string } | null; active: boolean }) {
  const t = useT()
  // Connection budget (design 1.8): a side chat kept mounted while hidden (another tab, another conversation) lets its
  // session stream go after the grace period; shown again, it subscribes anew and its snapshot catches it up.
  const streaming = useStreamWhileVisible(active)
  useEffect(() => (streaming ? watchSideSession(sideId) : undefined), [sideId, streaming])
  const rows = useApp(s => s.sessions[sideId]?.structure.rows.length ?? -1)
  const selection = useApp(s => s.sessions[sideId]?.meta.sideChat?.selection?.excerpt ?? null)
  const mode = useApp(s => s.sessions[sideId]?.meta.mode ?? null)
  const parentTitle = useApp(s => s.sessionIndex[parentId]?.title ?? s.sessions[parentId]?.meta.title ?? '')
  const lastAnswer = useApp(s => {
    const slice = s.sessions[sideId]
    if (!slice) return null
    for (let i = slice.order.length - 1; i >= 0; i--) {
      const item = slice.items[slice.order[i]]
      if (item?.kind === 'assistant' && item.text && !item.streaming && !item.source) return item.id
    }
    return null
  })
  const [follow, setFollow] = useState(0)
  const [promoting, setPromoting] = useState(false)
  const quote = selection ?? seed?.text ?? null

  const promote = async () => {
    if (!lastAnswer) return
    setPromoting(true)
    try { await sideChatApi.promote(sideId, lastAnswer); toast(t('已把这条回答加入主对话')) }
    catch (e) { toast((e as Error).message, 'danger') }
    finally { setPromoting(false) }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-side-chat={sideId}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-faint pl-4 pr-1.5 text-[12px] text-fg-4">
        <span className="min-w-0 flex-1 truncate">{parentTitle ? t('基于「{title}」 · 不会打断主对话', { title: parentTitle }) : t('不会打断主对话')}</span>
        {mode && <ModeToggle sessionId={sideId} mode={mode} />}
        <IconButton label={t('把最新回答加入主对话')} size="sm" disabled={!lastAnswer || promoting} onClick={() => void promote()}><CornerUpLeft /></IconButton>
      </div>
      {quote && (
        <figure className="mx-4 mt-3 flex shrink-0 gap-2 rounded-lg bg-subtle px-3 py-2 text-[12.5px] leading-[1.6] text-fg-3 shadow-[inset_0_0_0_0.5px_var(--line-faint)]">
          <Quote className="mt-0.5 size-3.5 shrink-0 text-fg-4" />
          <blockquote className="line-clamp-4 min-w-0 whitespace-pre-wrap break-words" title={quote}>{quote}</blockquote>
        </figure>
      )}
      {rows > 0 ? (
        <Timeline sessionId={sideId} followSignal={follow} compact />
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center px-8 text-center">
          {rows === -1
            ? <Loader2 className="size-4 spin text-fg-4" />
            : <p className="max-w-[280px] text-[13px] leading-relaxed text-fg-3">{quote ? t('就这段内容提问，回答只出现在这里。') : t('在这里追问或试探想法，主对话不会被打断。')}</p>}
        </div>
      )}
      <SideComposer sessionId={sideId} onSent={() => setFollow(n => n + 1)} />
    </div>
  )
}

/** New side chats start read-only (plan mode); the user can allow edits and commands here. */
function ModeToggle({ sessionId, mode }: { sessionId: string; mode: string }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const plan = mode === 'plan'
  const toggle = async () => {
    setBusy(true)
    try { await api.patchSession(sessionId, { mode: plan ? 'build' : 'plan' }) }
    catch (e) { toast((e as Error).message, 'danger') }
    finally { setBusy(false) }
  }
  return (
    <Tooltip content={plan ? t('只读：只分析和回答，不改文件、不运行命令。点击允许执行。') : t('可执行：可以修改文件和运行命令。点击改回只读。')}>
      <button type="button" disabled={busy} onClick={() => void toggle()} aria-pressed={!plan}
        className={cn('inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium transition-colors disabled:opacity-50', plan ? 'bg-subtle text-fg-3 hover:text-fg-2' : 'bg-warning-soft text-warning-text')}>
        {plan ? <Eye className="size-3" /> : <Hammer className="size-3" />}{plan ? t('只读') : t('可执行')}
      </button>
    </Tooltip>
  )
}

function SideComposer({ sessionId, onSent }: { sessionId: string; onSent: () => void }) {
  const t = useT()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const running = useApp(s => Boolean(s.sessions[sessionId] && s.sessions[sessionId].meta.status !== 'idle'))
  const editor = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const canSend = text.trim().length > 0 && !sending

  useEffect(() => { requestAnimationFrame(() => { if (!typingElsewhere(editor.current?.closest('[data-side-chat]'))) editor.current?.focus() }) }, [sessionId])
  useLayoutEffect(() => {
    const el = editor.current
    if (!el || CSS.supports?.('field-sizing', 'content')) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [text])

  const submit = async () => {
    const value = text.trim()
    if (!value || sending) return
    setSending(true)
    try { await sendSideMessage(sessionId, value); setText(''); onSent() }
    catch (e) { toast((e as Error).message, 'danger') }
    finally { setSending(false) }
  }
  // Follow-ups the stopped turn never took come back into the input, after anything typed since.
  const stop = async () => {
    try {
      const recovered = await stopSideSession(sessionId)
      if (recovered) setText(current => (current.trim() ? `${current.trimEnd()}\n\n${recovered}` : recovered))
    } catch (e) { toast((e as Error).message, 'danger') }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() }
  }
  return (
    <div className="shrink-0 px-3 pb-3 pt-1">
      <div className="flex items-end gap-1 rounded-2xl bg-elevated py-1.5 pl-3.5 pr-1.5 shadow-[var(--shadow-composer)] transition-shadow focus-within:shadow-[var(--shadow-composer-focus)]">
        <textarea
          ref={editor}
          value={text}
          rows={1}
          maxLength={16000}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          placeholder={running ? t('补充想法或调整方向…') : t('在辅助对话中提问…')}
          aria-label={t('在辅助对话中发送消息')}
          className={cn('block max-h-[180px] min-h-[34px] flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-[1.55] text-fg outline-none placeholder:text-fg-4 [field-sizing:content]')}
        />
        <SendButton running={running} canSend={canSend} sending={sending} onSend={() => void submit()} onStop={() => void stop()} />
      </div>
    </div>
  )
}
