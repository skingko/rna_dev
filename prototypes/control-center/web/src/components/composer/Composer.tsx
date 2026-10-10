/**
 * Composer: auto-growing editor, attachment and skill chips, a "+" launcher
 * (files/images, commands with search, skills) and slash commands, then one
 * toolbar: permission pill (orange at full access) on the left; model pill,
 * separate reasoning pill and the send/stop control on the right. Running
 * sessions get a delivery choice (steer/follow-up) and a queue dock.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, ArrowUp, Pencil, ChevronDown, CornerDownLeft, FileText, Lightbulb, ListChecks, Loader2, Lock, Plus, Shield, ShieldAlert, Sparkles, Square, Undo2, X } from 'lucide-react'
import type { Attachment as AttachmentRef, InboxEntry, ModelSelection } from '@/api/types'
import { api } from '@/api/client'
import { downloadBlob, exportSession, projectApi, type CommandCatalog } from '@/api/project-api'
import { useApp, useProject } from '@/store/app-store'
import { controlSession, selectSession, sendMessage, updateSession } from '@/store/sync'
import { openTasks, takePrefill, takenBack, toast, useUi, type CarriedTask, type ComposerFill } from '@/store/ui-store'
import { useProjectSkills } from '@/lib/skills'
import { Menu, MenuCheckItem, MenuContent, MenuTrigger } from '@/components/ui/overlays'
import { Pill, Tooltip } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { ModelPill, ReasoningPill } from './ModelPill'
import { ComposerMeters } from './ComposerMeters'
import { ComposerMenu, WorktreeChip, type ComposerMenuHandle, type MenuEntry } from './ComposerMenu'
import { clearWorktreeChoice, useWorktreeChoice, useWorktrees, worktreeChoice } from '@/store/isolation-store'
import { CommandDialog, type TextCommand } from './CommandDialog'
import { SessionNotice } from './SessionNotice'
import { NudgeStrip } from './NudgeStrip'
import { PendingAskStrip } from './PendingAskStrip'
import { OutboxStrip } from './OutboxStrip'
import { BackgroundStrip } from './BackgroundStrip'
import { queueOutbox } from '@/store/outbox'
import { inFront, presenceReporter } from '@/lib/presence'
import { openCapabilities, openPermissions } from '@/components/settings/panel-store'
import { resolveSlash, slashQuery, unavailableReason, type CommandContext, type ComposerCommand } from './commands'
import { t as tr, localized } from '@/i18n'

/** `pending`: picked before the conversation exists; uploaded right after the first send creates it. */
interface Attachment { key: string; name: string; type: string; size: number; status: 'pending' | 'uploading' | 'ready' | 'error'; file?: File; error?: string; result?: { id: string; name: string; type: string; size: number } }

export const draftKey = (id: string | null, projectId: string | null) => `rna.draft.${id ?? `new:${projectId ?? 'none'}`}`

/** What a draft holds besides its text, stored next to it: files already uploaded and "接着完成" messages taken back. */
interface DraftCarry { attachments?: AttachmentRef[]; tasks?: CarriedTask[] }
const carryKey = (key: string) => `${key}.carry`
function readCarry(key: string): DraftCarry {
  try { return JSON.parse(localStorage.getItem(carryKey(key)) ?? 'null') ?? {} } catch { return {} }
}
function writeCarry(key: string, carry: DraftCarry) {
  try { if (carry.attachments?.length || carry.tasks?.length) localStorage.setItem(carryKey(key), JSON.stringify(carry)); else localStorage.removeItem(carryKey(key)) } catch { /* ignore */ }
}
/** One task per background action: the same "接着完成" taken back twice is carried once. */
const mergeTasks = (current: CarriedTask[] = [], added: CarriedTask[] = []) => [...current, ...added.filter(task => !current.some(row => row.continues.actionId === task.continues.actionId))]
/** Uploaded files as composer chips. */
const readyChips = (refs: AttachmentRef[] = []): Attachment[] => refs.flatMap(a => (a.id ? [{ key: crypto.randomUUID(), name: a.name, type: a.type ?? '', size: a.size ?? 0, status: 'ready' as const, result: { id: a.id, name: a.name, type: a.type ?? '', size: a.size ?? 0 } }] : []))
/**
 * A fill merged into a stored draft: text after what is there (or in place of it), files and tasks added. A fill for a
 * conversation whose composer is not showing waits there, and a composer that mounts with a fill pending stores it
 * before loading its draft, so StrictMode's second run of that load (the fill already taken) still finds it.
 */
function storeFill(key: string, fill: ComposerFill) {
  try {
    const prev = localStorage.getItem(key) ?? ''
    const text = fill.text ? (fill.append && prev ? `${prev}\n\n${fill.text}` : fill.text) : prev
    if (text) localStorage.setItem(key, text)
  } catch { /* ignore */ }
  const carry = readCarry(key)
  writeCarry(key, { attachments: [...(carry.attachments ?? []), ...(fill.attachments ?? []).filter(a => a.id)], tasks: mergeTasks(carry.tasks, fill.tasks) })
}

export function Composer({ variant = 'dock', onSent }: { variant?: 'dock' | 'hero'; onSent?: () => void }) {
  const sessionId = useApp(s => s.selectedSessionId)
  // Editing a sent message: its text comes back here; sending rewinds the conversation to it first.
  const editing = useUi(s => (s.editing && s.editing.sessionId === sessionId ? s.editing : null))
  const projectId = useApp(s => s.selectedProjectId)
  // Session-level fields only: text deltas must not re-render the composer.
  const meta = useApp(s => (s.selectedSessionId ? s.sessions[s.selectedSessionId]?.meta : undefined))
  const project = useProject(meta?.projectId ?? projectId)
  const configuration = useApp(s => s.configuration)
  const lastDecision = useApp(s => {
    const sl = s.selectedSessionId ? s.sessions[s.selectedSessionId] : undefined
    if (!sl) return null
    const id = sl.meta.activeTurnId ?? [...sl.structure.rows].reverse().find(r => r.type === 'turn')?.key.slice(5)
    return id ? sl.turns[id]?.modelConfig?.reasoningDecision ?? null : null
  })
  const running = Boolean(meta && meta.status !== 'idle')

  const [text, setText] = useState('')
  const editingKey = editing ? `${editing.sessionId}:${editing.itemId}` : null
  useEffect(() => { if (editing) { setText(editing.text); requestAnimationFrame(() => editor.current?.focus()) } }, [editingKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [tasks, setTasks] = useState<CarriedTask[]>([])
  const [sending, setSending] = useState(false)
  const [delivery, setDelivery] = useState<'steer' | 'followup'>('steer')
  const [localMode, setLocalMode] = useState<'build' | 'plan'>('build')
  const [localModel, setLocalModel] = useState<ModelSelection | null>(null)
  const [menu, setMenu] = useState<{ source: 'launcher' | 'slash'; query: string } | null>(null)
  const [catalog, setCatalog] = useState<CommandCatalog | null>(null)
  const [commandBusy, setCommandBusy] = useState(false)
  const [dialog, setDialog] = useState<TextCommand | null>(null)
  const [modelOpen, setModelOpen] = useState(false)
  const [permOpen, setPermOpen] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const menuRef = useRef<ComposerMenuHandle>(null)
  const composing = useRef(false)
  const suppressed = useRef<string | null>(null)
  const skills = useProjectSkills(project?.id)

  const mode = (meta?.mode as 'build' | 'plan' | undefined) ?? localMode
  const selection = meta?.modelSelection ?? localModel ?? configuration?.defaultModel ?? null
  const context: CommandContext = { sessionId, projectId: project?.id ?? null, status: meta?.status ?? 'idle', mode }

  // Draft per session: its text, uploaded files and carried tasks.
  const key = draftKey(sessionId, projectId)
  // The first send from a new conversation creates it, which changes the key: what is going out with
  // that message (files still uploading, skills) stays, so a failed upload is still there to retry.
  const carrying = useRef<string | null>(null)
  useEffect(() => {
    setMenu(null); setCatalog(null)
    if (carrying.current === key) { carrying.current = null; return }
    // A fill that came while no composer was showing goes into the draft it is meant for, then this one loads.
    const fill = takePrefill()
    if (fill) storeFill(fill.sessionId ? draftKey(fill.sessionId, null) : key, fill)
    try { setText(localStorage.getItem(key) ?? '') } catch { setText('') }
    const carry = readCarry(key)
    setAttachments(readyChips(carry.attachments)); setTasks(carry.tasks ?? []); setSkillIds([])
  }, [key])
  useEffect(() => {
    const t = setTimeout(() => {
      try { if (text) localStorage.setItem(key, text); else localStorage.removeItem(key) } catch { /* ignore */ }
      writeCarry(key, { attachments: attachments.flatMap(a => (a.status === 'ready' && a.result ? [a.result] : [])), tasks })
    }, 250)
    return () => clearTimeout(t)
  }, [key, text, attachments, tasks])

  // Auto-grow (field-sizing where supported, measured fallback otherwise).
  useLayoutEffect(() => {
    const el = editor.current
    if (!el || CSS.supports?.('field-sizing', 'content')) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`
  }, [text])

  useEffect(() => { editor.current?.focus() }, [sessionId])

  /** Text (with files already uploaded and carried tasks) coming back: a suggestion replaces the text, a taken-back message goes after it. */
  const restore = (fill: Omit<ComposerFill, 'at' | 'sessionId'>) => {
    if (fill.text) setText(prev => (fill.append && prev ? `${prev}\n\n${fill.text}` : fill.text))
    const files = readyChips(fill.attachments)
    if (files.length) setAttachments(prev => [...prev, ...files])
    if (fill.tasks?.length) setTasks(prev => mergeTasks(prev, fill.tasks))
    requestAnimationFrame(() => { const el = editor.current; if (!el) return; el.focus(); el.setSelectionRange(el.value.length, el.value.length) })
  }
  // Taken once from the store: the dock composer that replaces the hero after the first send must not
  // put the suggestion that was just sent back in (and over its stored draft).
  const prefillAt = useUi(s => s.prefill?.at ?? null)
  useEffect(() => {
    const fill = takePrefill()
    if (!fill) return
    if (fill.sessionId && fill.sessionId !== sessionId) storeFill(draftKey(fill.sessionId, null), fill)
    else restore(fill)
  }, [prefillAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // Host command availability for the open menu.
  const status = meta?.status
  useEffect(() => {
    if (!menu || !sessionId) return
    let live = true
    void projectApi.commands(sessionId).then(value => { if (live) setCatalog(value) }).catch(() => {})
    return () => { live = false }
  }, [Boolean(menu), sessionId, status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Presence: typing makes proactive messages wait; having this conversation in front
  // counts as being here, so what was held while the user was away arrives now.
  const presence = useRef<ReturnType<typeof presenceReporter> | null>(null)
  useEffect(() => {
    const pid = meta?.projectId
    if (!pid || !sessionId) return
    const reporter = presenceReporter({ send: body => api.presence(pid, sessionId, body), here: inFront })
    presence.current = reporter
    const check = () => reporter.check()
    const timer = window.setInterval(check, 5000)
    window.addEventListener('focus', check); window.addEventListener('blur', check); document.addEventListener('visibilitychange', check)
    check()
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', check); window.removeEventListener('blur', check); document.removeEventListener('visibilitychange', check)
      reporter.stop(); if (presence.current === reporter) presence.current = null
    }
  }, [meta?.projectId, sessionId])
  const reportTyping = useCallback(() => presence.current?.typed(), [])

  const uploading = attachments.some(a => a.status === 'uploading')
  // A failed upload blocks sending: the message must never silently go out without a file the user attached.
  const failedUpload = attachments.some(a => a.status === 'error')
  const canSend = (text.trim().length > 0 || attachments.some(a => a.status === 'ready' || a.status === 'pending') || tasks.length > 0) && !sending && !uploading && !failedUpload && !commandBusy

  const onTextChange = (value: string) => {
    setText(value)
    reportTyping()
    const q = slashQuery(value)
    if (q !== null && suppressed.current !== `${sessionId}:${value}`) setMenu({ source: 'slash', query: q })
    else if (menu?.source === 'slash') setMenu(null)
  }

  const closeMenu = (refocus: boolean) => {
    if (menu?.source === 'slash') suppressed.current = `${sessionId}:${text}`
    setMenu(null)
    if (refocus) requestAnimationFrame(() => editor.current?.focus())
  }

  /* ---------------------------------------------------------- commands */

  const executeHost = async (command: string, value: string, requestId: string) => {
    if (!sessionId) throw new Error(tr('先开始一段会话。'))
    const args = command === 'compact' ? (value ? { instructions: value } : {}) : command === 'plan' ? { mode: value } : { text: value }
    const result = await projectApi.runCommand(sessionId, command, requestId, args)
    toast(command === 'compact' ? (result?.result?.compacted === false ? tr('当前上下文无需压缩。') : tr('上下文已压缩，完整聊天记录仍保留。'))
      : command === 'plan' ? (value === 'plan' ? tr('已进入只读计划模式。') : tr('已切换执行模式。'))
        : command === 'goal' ? tr('项目当前关注已保存。') : tr('项目反馈已保存。'))
    if (command === 'plan') void updateLocalMode(value as 'plan' | 'build')
  }
  const updateLocalMode = (value: 'plan' | 'build') => {
    const id = useApp.getState().selectedSessionId
    if (!id) return
    useApp.setState(s => {
      const slice = s.sessions[id]
      return slice ? { sessions: { ...s.sessions, [id]: { ...slice, meta: { ...slice.meta, mode: value } } } } : {}
    })
  }
  /** Inline host command: reuse the request id for the same text so a retry is idempotent. */
  const executeInline = async (command: string, value: string) => {
    const k = `rna.inline-command.${sessionId}.${command}`
    let previous: { text: string; requestId: string } | null = null
    try { previous = JSON.parse(localStorage.getItem(k) ?? 'null') } catch { /* ignore */ }
    const request = previous?.text === value ? previous : { text: value, requestId: crypto.randomUUID() }
    try { localStorage.setItem(k, JSON.stringify(request)) } catch { /* ignore */ }
    await executeHost(command, value, request.requestId)
    try { localStorage.removeItem(k) } catch { /* ignore */ }
  }

  const run = async (command: ComposerCommand, argument: string, fromLauncher: boolean) => {
    const reason = unavailableReason(command, context, catalog, commandBusy)
    if (reason) { toast(reason); return false }
    setMenu(null)
    setCommandBusy(true)
    try {
      switch (command.id) {
        case 'goal': case 'feedback': case 'compact':
          if (argument.trim()) await executeInline(command.id, argument.trim())
          else setDialog(command.id)
          break
        case 'plan': case 'build': {
          const target = command.id === 'build' || argument === 'build' ? 'build' : fromLauncher ? (mode === 'plan' ? 'build' : 'plan') : 'plan'
          if (argument && !['plan', 'build'].includes(argument)) throw new Error(tr('计划模式参数只接受 plan 或 build。'))
          if (!sessionId) { setLocalMode(target); toast(target === 'plan' ? tr('新会话将以只读计划模式开始。') : tr('新会话将以执行模式开始。')); break }
          await executeInline('plan', target)
          break
        }
        case 'file': fileInput.current?.click(); break
        case 'permission': if (!project) throw new Error(tr('需要项目会话')); openPermissions(project.id); break
        case 'model': setModelOpen(true); break
        case 'project': openTasks(project?.id ?? 'all'); break
        case 'versions': useUi.setState({ view: 'evolution' }); break
        case 'skills': openCapabilities(project?.id ?? null); break
        case 'new': await selectSession(null); break
        case 'stop': await controlSession('stop'); break
        case 'export': downloadBlob(`rna-session-${sessionId}.zip`, await exportSession(sessionId!)); toast(tr('已导出本会话的脱敏可读记录。')); break
      }
      return true
    } catch (error) { toast((error as Error).message, 'danger'); return false }
    finally { setCommandBusy(false) }
  }

  const chooseEntry = (entry: MenuEntry) => {
    if (entry.type === 'skill') {
      setSkillIds(prev => (prev.includes(entry.skill.id) ? prev.filter(id => id !== entry.skill.id) : [...prev, entry.skill.id]))
      setMenu(null)
      requestAnimationFrame(() => editor.current?.focus())
      return
    }
    const fromSlash = menu?.source === 'slash'
    const original = text
    void run(entry.command, '', !fromSlash).then(ok => { if (ok && fromSlash) setText(current => (current === original ? '' : current)) })
  }

  /* ------------------------------------------------------------- send */

  const submit = async () => {
    const value = text.trim()
    if (!canSend) return
    const slash = !attachments.length ? resolveSlash(value) : null
    if (slash) {
      const original = text
      const ok = await run(slash.command, slash.argument, false)
      if (ok) setText(current => (current === original ? '' : current))
      return
    }
    // Carried "接着完成" messages go out after what was typed, each its own message with its task, queued behind
    // a running turn (never joining it), as when the host first posted them. With nothing typed, the first leads.
    const carried = tasks
    const typed = Boolean(value) || attachments.length > 0
    // During an app update the message waits in the outbox and goes out by itself afterwards (§2.5 item 10).
    if (useApp.getState().maintenanceHeld && !editing && !attachments.length) {
      // A new conversation keeps its 在独立工作树中运行 choice while it waits (0.63).
      if (value) queueOutbox({ sessionId, projectId, text: value, worktree: !sessionId && worktreeChoice(projectId) })
      if (value && !sessionId && projectId) clearWorktreeChoice(projectId)
      for (const task of carried) queueOutbox({ sessionId, projectId, text: task.text, continues: task.continues })
      setText(''); setTasks([])
      return
    }
    setSending(true)
    const snapshot = text
    if (editing && sessionId) {
      try { await api.rewindItem(sessionId, editing.itemId, 'user_edit'); useUi.setState({ editing: null }) }
      catch (error) { setSending(false); toast(tr('编辑未完成：{message}', { message: (error as Error).message }), 'danger'); return }
    }
    const skillSnapshot = skillIds
    setText(''); setTasks([])
    // Sent text is no longer a draft. Removed now, not by the debounced save: creating the conversation
    // changes the key first, and the old key would keep the message for the next new conversation.
    try { localStorage.removeItem(key); localStorage.removeItem(carryKey(key)) } catch { /* ignore */ }
    const pending = attachments.filter(a => a.status === 'pending' && a.file)
    const first = typed ? null : carried[0]
    // The conversation this goes to: the carried tasks follow it there even if the user switches away meanwhile.
    let target = sessionId
    let led = false, sent = 0
    try {
      await sendMessage(first?.text ?? value, { delivery: running ? (first ? 'followup' : delivery) : 'send', continues: first?.continues, mode, modelSelection: meta ? undefined : selection, attachments: attachments.flatMap(a => (a.status === 'ready' && a.result ? [a.result] : [])), skillIds: skillSnapshot,
        onCreated: created => { target = created; carrying.current = draftKey(created, null) },
        prepareAttachments: created => uploadPending(created, pending) })
      led = true; sent = first ? 1 : 0
      setAttachments([]); setSkillIds(prev => prev.filter(id => !skillSnapshot.includes(id)))
      for (const task of carried.slice(sent)) { await sendMessage(task.text, { sessionId: target ?? undefined, delivery: 'followup', continues: task.continues }); sent++ }
      onSent?.()
    } catch (error) {
      const unsent = carried.slice(sent)
      // The update started between the check and the send: queue it instead of failing.
      if ((error as { code?: string }).code === 'maintenance_held' && (led || !attachments.length)) {
        if (!led && typed) { queueOutbox({ sessionId, projectId, text: value, worktree: !sessionId && worktreeChoice(projectId) }); if (!sessionId && projectId) clearWorktreeChoice(projectId) }
        for (const task of unsent) queueOutbox({ sessionId: target, projectId, text: task.text, continues: task.continues })
        return
      }
      if (!led && typed) setText(current => current || snapshot)
      // Unsent tasks go back to their own conversation's composer, waiting in its draft when another one is in front.
      if (unsent.length) {
        if (!target || useApp.getState().selectedSessionId === target) setTasks(current => mergeTasks(current, unsent))
        else storeFill(draftKey(target, null), { text: '', at: Date.now(), tasks: unsent })
      }
      toast(tr('发送失败：{message}', { message: (error as Error).message }), 'danger')
    } finally {
      setSending(false)
      editor.current?.focus()
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu?.source === 'slash' && menuRef.current?.onKey(e)) return
    // ↑ in an empty composer edits your last message (the chat-app convention); Esc leaves editing.
    if (e.key === 'ArrowUp' && !text && !editing && !running && sessionId && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const slice = useApp.getState().sessions[sessionId]
      const last = slice ? Object.values(slice.items).filter(item => item.kind === 'user' && item.turnId && !item.optimistic && item.source !== 'subagent' && item.source !== 'interaction-answer').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) : undefined
      if (last) { e.preventDefault(); useUi.setState({ editing: { sessionId, itemId: last.id, text: last.text ?? '' } }); return }
    }
    if (e.key === 'Escape' && editing) { e.preventDefault(); useUi.setState({ editing: null }); setText(''); return }
    if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const changeModel = async (next: ModelSelection) => {
    if (!meta) { setLocalModel(next); return }
    try { await updateSession({ modelSelection: next }); toast(running ? tr('已保存，下一轮使用所选模型。') : tr('模型已更新。')) }
    catch (e) { toast(tr('模型保存失败：{message}', { message: (e as Error).message }), 'danger') }
  }
  const changeMode = async (next: 'build' | 'plan') => {
    if (!meta) { setLocalMode(next); return }
    try { await updateSession({ mode: next }) } catch (e) { toast((e as Error).message, 'danger') }
  }
  const changePermission = async (level: string) => {
    if (!project) return
    try {
      const current = await api.getPermissions(project.id)
      // 读写并执行命令 here covers all of the project's work, background included, with no per-action prompts (zcode yolo / harness full access).
      const background = level === 'execute' ? 'inherit' : current.settings.background
      await api.setPermissions(project.id, level, background)
      useApp.setState(s => ({ projects: { ...s.projects, [project.id]: { ...project, permissions: { ...project.permissions, workspace: level, background } } } }))
      toast(level === 'execute' ? tr('已设为「读写并执行命令」：前台和后台都可直接读写和执行，不再逐项询问。') : tr('项目执行权限已更新；后台权限保持不变。'))
    } catch (e) { toast((e as Error).message, 'danger') }
  }

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return
    if (!sessionId) {
      setAttachments(prev => [...prev, ...Array.from(files).map(file => ({ key: crypto.randomUUID(), name: file.name, type: file.type, size: file.size, status: 'pending' as const, file }))])
      return
    }
    for (const file of Array.from(files)) {
      const entry: Attachment = { key: crypto.randomUUID(), name: file.name, type: file.type, size: file.size, status: 'uploading', file }
      setAttachments(prev => [...prev, entry])
      await uploadEntry(sessionId, entry)
    }
  }
  // Files dropped anywhere in the window attach here (plan §2.4); drops another target handled are left alone.
  const addFilesRef = useRef(addFiles)
  addFilesRef.current = addFiles
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'))
    const over = (e: DragEvent) => { if (hasFiles(e) && !e.defaultPrevented) e.preventDefault() }
    const drop = (e: DragEvent) => { if (!hasFiles(e) || e.defaultPrevented) return; e.preventDefault(); void addFilesRef.current(e.dataTransfer?.files ?? null) }
    document.addEventListener('dragover', over)
    document.addEventListener('drop', drop)
    return () => { document.removeEventListener('dragover', over); document.removeEventListener('drop', drop) }
  }, [])
  /** Files picked before the conversation existed, uploaded once it does. Each keeps its own outcome: one that
   * failed stays as an error chip (retry or remove), which blocks sending, and is never dropped silently. */
  const uploadPending = async (target: string, pending: Attachment[]) => {
    if (!pending.length) return []
    const keys = new Set(pending.map(a => a.key))
    setAttachments(prev => prev.map(a => (keys.has(a.key) ? { ...a, status: 'uploading' } : a)))
    const results = await Promise.allSettled(pending.map(a => api.uploadAttachment(target, a.file!)))
    const outcome = new Map(pending.map((a, i) => [a.key, results[i]]))
    setAttachments(prev => prev.map(a => {
      const r = outcome.get(a.key)
      return !r ? a : r.status === 'fulfilled' ? { ...a, status: 'ready', result: r.value, error: undefined } : { ...a, status: 'error', error: (r.reason as Error).message }
    }))
    const failed = results.find(r => r.status === 'rejected')
    if (failed) throw failed.reason
    return results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
  }
  const uploadEntry = async (target: string, entry: Attachment) => {
    setAttachments(prev => prev.map(a => a.key === entry.key ? { ...a, status: 'uploading', error: undefined } : a))
    try {
      const result = await api.uploadAttachment(target, entry.file!)
      setAttachments(prev => prev.map(a => a.key === entry.key ? { ...a, status: 'ready', result } : a))
    } catch (error) {
      const message = (error as Error).message
      setAttachments(prev => prev.map(a => a.key === entry.key ? { ...a, status: 'error', error: message } : a))
      toast(tr('「{name}」上传失败：{message}', { name: entry.name, message }), 'danger')
    }
  }

  const hero = variant === 'hero'
  const skillName = (id: string) => skills.find(s => s.id === id)?.name ?? id
  // 0.63: a new conversation of a project that will run in its own worktree says so above the editor.
  const worktreeOn = useWorktreeChoice(sessionId ? null : project?.id ?? null)
  const worktreeShown = useWorktrees(sessionId ? null : project?.id ?? null, { enabled: worktreeOn }).data?.isolation.enabled === true && worktreeOn

  return (
    <div className={cn('@container/composer mx-auto w-full', hero ? 'max-w-[680px]' : 'max-w-[calc(var(--content-width)+48px)] px-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4')}>
      <QueueDock sessionId={sessionId} inbox={meta?.inbox ?? []} onRecover={entry => { const fill = takenBack([entry]); if (fill) restore(fill) }} />
      <SessionNotice sessionId={sessionId} />
      <OutboxStrip sessionId={sessionId} projectId={projectId} />
      <BackgroundStrip projectId={meta?.projectId ?? projectId} turnRunning={running} />
      <PendingAskStrip sessionId={sessionId} />
      <NudgeStrip sessionId={sessionId} typing={Boolean(text.trim()) || Boolean(editing)} />
      <div className="relative">
        <AnimatePresence>
          {menu && (
            <ComposerMenu ref={menuRef} source={menu.source} query={menu.query} context={context} catalog={catalog} busy={commandBusy}
              skills={skills} attachedSkills={skillIds} onChoose={chooseEntry} onClose={closeMenu} />
          )}
        </AnimatePresence>
        <div
          className="composer-surface rounded-[var(--composer-radius)] bg-elevated shadow-[var(--shadow-composer)] transition-shadow duration-200 focus-within:shadow-[var(--shadow-composer-focus)]"
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); void addFiles(e.dataTransfer.files) }}
        >
          <AnimatePresence initial={false}>
            {editing && (
              <div className="flex items-center gap-2 px-3 pt-2.5 text-[12.5px] text-fg-3">
                <Pencil className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{tr('编辑消息：发送后会从这条消息起重新开始，之后的回复和相关上下文一并撤掉')}</span>
                <button type="button" aria-label={tr('取消编辑')} onClick={() => { useUi.setState({ editing: null }); setText('') }} className="grid size-5 place-items-center rounded-md text-fg-4 hover:bg-hover hover:text-fg"><X className="size-3" /></button>
              </div>
            )}
            {(attachments.length > 0 || skillIds.length > 0 || tasks.length > 0 || worktreeShown) && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-wrap gap-1.5 px-3 pt-3">
                {!sessionId && <WorktreeChip projectId={project?.id ?? null} />}
                {attachments.map(a => (
                  <span key={a.key} title={a.error} className={cn('inline-flex h-7 max-w-72 items-center gap-1.5 rounded-lg bg-subtle pl-2 pr-1 text-[12.5px] text-fg-2', a.status === 'error' && 'bg-danger-soft text-danger')}>
                    {a.status === 'uploading' ? <Loader2 className="size-3.5 spin" /> : a.status === 'error' ? <AlertCircle className="size-3.5" /> : <FileText className="size-3.5" />}
                    <span className="truncate">{a.name}</span>
                    {a.status === 'error' && <span className="shrink-0">{tr('上传失败')}</span>}
                    {a.status === 'error' && sessionId && a.file && <button type="button" onClick={() => void uploadEntry(sessionId, a)} className="shrink-0 rounded-md px-1 underline-offset-2 hover:underline">{tr('重试')}</button>}
                    <button type="button" aria-label={tr('移除 {name}', { name: a.name })} onClick={() => setAttachments(prev => prev.filter(x => x.key !== a.key))} className="grid size-5 place-items-center rounded-md text-fg-4 hover:bg-hover hover:text-fg"><X className="size-3" /></button>
                  </span>
                ))}
                {tasks.map(task => (
                  <Tooltip key={task.continues.actionId} content={tr('发送时单独成一条消息，带上这项后台任务的完整记录')}>
                    <span className="inline-flex h-7 max-w-72 items-center gap-1.5 rounded-lg bg-subtle pl-2 pr-1 text-[12.5px] text-fg-2">
                      <ListChecks className="size-3.5 shrink-0" />
                      <span className="truncate">{task.text}</span>
                      <button type="button" aria-label={tr('移除 {name}', { name: task.text })} onClick={() => setTasks(prev => prev.filter(x => x.continues.actionId !== task.continues.actionId))} className="grid size-5 place-items-center rounded-md text-fg-4 hover:bg-hover hover:text-fg"><X className="size-3" /></button>
                    </span>
                  </Tooltip>
                ))}
                {skillIds.map(id => (
                  <span key={id} className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-lg bg-accent-softer pl-2 pr-1 text-[12.5px] text-accent-text">
                    <Sparkles className="size-3.5" />
                    <span className="truncate">{skillName(id)}</span>
                    <button type="button" aria-label={tr('移除技能 {v}', { v: skillName(id) })} onClick={() => setSkillIds(prev => prev.filter(x => x !== id))} className="grid size-5 place-items-center rounded-md opacity-70 hover:bg-hover hover:opacity-100"><X className="size-3" /></button>
                  </span>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
          <textarea
            ref={editor}
            value={text}
            rows={hero ? 3 : 1}
            maxLength={16000}
            onChange={e => onTextChange(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => { if (menu?.source === 'slash') setTimeout(() => setMenu(m => (m?.source === 'slash' && document.activeElement !== editor.current ? null : m)), 120) }}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={() => { composing.current = false }}
            onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); void addFiles(e.clipboardData.files) } }}
            placeholder={running ? tr('补充想法或调整方向…') : hero ? tr('描述你想推进的事情，Rna 会先理解项目再动手…') : tr('继续讨论，补充想法，输入 / 使用指令…')}
            aria-label={tr('给 Rna Agent 发送消息')}
            aria-controls={menu ? 'composer-command-menu' : undefined}
            aria-expanded={menu?.source === 'slash' ? true : undefined}
            aria-autocomplete="list"
            className={cn(
              'block max-h-[280px] w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-[1.6] text-fg outline-none placeholder:text-fg-4 [field-sizing:content]',
              hero ? 'min-h-[92px]' : 'min-h-[52px]',
            )}
          />
          <div className="flex items-center gap-1 px-2 pb-2 pt-1">
            <Tooltip content={tr('添加文件、指令与技能')} shortcut="/">
              <button
                type="button"
                aria-label={tr('添加文件、指令与技能')}
                aria-haspopup="listbox"
                aria-expanded={menu?.source === 'launcher'}
                onMouseDown={e => e.preventDefault()}
                onClick={() => (menu?.source === 'launcher' ? closeMenu(true) : setMenu({ source: 'launcher', query: '' }))}
                className={cn('grid size-8 shrink-0 place-items-center rounded-full text-fg-2 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-fg active:scale-95', menu?.source === 'launcher' && 'bg-active text-fg')}
              >
                <Plus className={cn('size-[18px] transition-transform duration-200', menu?.source === 'launcher' && 'rotate-45')} strokeWidth={1.8} />
              </button>
            </Tooltip>
            <input ref={fileInput} type="file" multiple hidden onChange={e => { void addFiles(e.target.files); e.target.value = '' }} />
            {project && <PermissionPill level={project.permissions?.workspace} open={permOpen} onOpenChange={setPermOpen} onChange={l => void changePermission(l)} />}
            {mode === 'plan' && <ModePill mode={mode} onChange={m => void changeMode(m)} />}
            <span className="flex-1" />
            <div className="hidden items-center gap-0.5 @[520px]/composer:flex">
              <ModelPill selection={selection} onChange={s => void changeModel(s)} open={modelOpen} onOpenChange={setModelOpen} />
              <ReasoningPill selection={selection} decision={lastDecision} onChange={s => void changeModel(s)} />
            </div>
            <div className="flex items-center @[520px]/composer:hidden">
              <ReasoningPill selection={selection} decision={lastDecision} onChange={s => void changeModel(s)} compact />
            </div>
            {running && text.trim() && <DeliveryPill value={delivery} onChange={setDelivery} />}
            <SendButton running={running} canSend={canSend} sending={sending} onSend={() => void submit()} onStop={() => void controlSession('stop').catch(e => toast((e as Error).message, 'danger'))} />
          </div>
        </div>
      </div>
      {!hero && <ComposerMeters />}
      <CommandDialog command={dialog} sessionId={sessionId} initial={dialog === 'goal' ? ((project as { focus?: string } | undefined)?.focus ?? '') : ''}
        contextLabel={`${project?.name ?? tr('未选择项目')} · ${meta?.title ?? tr('新会话')}`}
        onClose={() => { setDialog(null); requestAnimationFrame(() => editor.current?.focus()) }}
        execute={(command, value, requestId) => executeHost(command, value, requestId)} />
    </div>
  )
}

export function SendButton({ running, canSend, sending, onSend, onStop }: { running: boolean; canSend: boolean; sending: boolean; onSend: () => void; onStop: () => void }) {
  const stop = running && !canSend
  return (
    <Tooltip content={stop ? tr('停止当前轮次') : tr('发送')} shortcut={stop ? undefined : '↵'}>
      <button
        type="button"
        onClick={stop ? onStop : onSend}
        disabled={!stop && !canSend}
        aria-label={stop ? tr('停止当前轮次') : tr('发送消息')}
        className={cn(
          'ml-1 grid size-8 shrink-0 place-items-center rounded-[var(--send-radius)] transition-[background-color,color,transform,opacity] duration-150 ease-out active:scale-95',
          stop ? 'bg-fg text-fg-inverted hover:opacity-90' : canSend ? 'bg-[var(--send-bg)] text-[var(--send-fg)] shadow-xs hover:opacity-90' : 'bg-[var(--send-disabled-bg)] text-[var(--send-disabled-fg)]',
        )}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={stop ? 'stop' : sending ? 'sending' : 'send'} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={{ duration: 0.14 }} className="grid place-items-center">
            {stop ? <Square className="size-3 fill-current" /> : sending ? <Loader2 className="size-4 spin" /> : <ArrowUp className="size-4" strokeWidth={2.4} />}
          </motion.span>
        </AnimatePresence>
      </button>
    </Tooltip>
  )
}

function ModePill({ mode, onChange }: { mode: 'build' | 'plan'; onChange: (m: 'build' | 'plan') => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Pill leading={<Lightbulb />} trailing={<ChevronDown className="!size-3 opacity-60" />} tone="accent">{tr('计划')}</Pill>
      </MenuTrigger>
      <MenuContent side="top" className="w-64">
        <MenuCheckItem checked={mode === 'build'} onSelect={() => onChange('build')} description={tr('讨论并执行，过程中可以随时调整')}>{tr('执行')}</MenuCheckItem>
        <MenuCheckItem checked={mode === 'plan'} onSelect={() => onChange('plan')} description={tr('先分析和制定方案，再决定如何实施')}>{tr('计划')}</MenuCheckItem>
      </MenuContent>
    </Menu>
  )
}

// Named as in the permissions dialog and the terminal, so the level the terminal asks for is the one picked here.
const PERMISSIONS = localized([
  { id: 'read', label: '只读检查', description: '允许查看项目文件；后台权限独立设置。', icon: Lock },
  { id: 'write', label: '读写项目文件', description: '允许在项目目录内读写文件；后台权限独立设置。', icon: Shield },
  { id: 'execute', label: '读写并执行命令', description: '前台和后台都可读写项目文件、以当前用户权限执行命令，不再逐项询问；并非操作系统沙箱。外部 MCP 仍需单独授权。', icon: ShieldAlert },
])

function PermissionPill({ level, open, onOpenChange, onChange }: { level?: string; open: boolean; onOpenChange: (o: boolean) => void; onChange: (level: string) => void }) {
  const current = PERMISSIONS.find(p => p.id === level)
  const Icon = current?.icon ?? Shield
  const full = level === 'execute'
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger asChild>
        <Pill leading={<Icon />} trailing={<ChevronDown className="!size-3 opacity-60" />} tone={full ? 'warning' : 'default'} className={cn('hidden sm:inline-flex', full && 'bg-transparent hover:bg-warning-soft data-[state=open]:bg-warning-soft')} aria-label={tr('项目执行权限：{v}', { v: current?.label ?? tr('原有授权') })}>
          {/* Label collapses to the icon when the composer is narrow (e.g. with the dock open). */}
          <span className="hidden @[460px]/composer:inline">{current?.label ?? tr('原有授权')}</span>
        </Pill>
      </MenuTrigger>
      <MenuContent side="top" className="w-80">
        {!current && <p className="px-2.5 pb-1 pt-1.5 text-[12px] leading-[1.6] text-fg-3">{tr('尚未设置统一权限，继续使用原有已分配工具的授权。')}</p>}
        {PERMISSIONS.map(p => (
          <MenuCheckItem key={p.id} checked={level === p.id} onSelect={() => onChange(p.id)} description={p.description}>{p.label}</MenuCheckItem>
        ))}
      </MenuContent>
    </Menu>
  )
}

function DeliveryPill({ value, onChange }: { value: 'steer' | 'followup'; onChange: (v: 'steer' | 'followup') => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Pill leading={<CornerDownLeft />} trailing={<ChevronDown className="!size-3 text-fg-4" />} tone="accent">
          {value === 'steer' ? tr('下一步加入') : tr('下一轮补充')}
        </Pill>
      </MenuTrigger>
      <MenuContent side="top" align="end" className="w-64">
        <MenuCheckItem checked={value === 'steer'} onSelect={() => onChange('steer')} description={tr('在下一个步骤边界加入当前轮次')}>{tr('下一步加入')}</MenuCheckItem>
        <MenuCheckItem checked={value === 'followup'} onSelect={() => onChange('followup')} description={tr('当前轮次结束后再开始处理')}>{tr('下一轮补充')}</MenuCheckItem>
      </MenuContent>
    </Menu>
  )
}

/** Messages waiting to join the turn. A subagent's result reads as its notice line (never the prompt written for
 * the model) and is not the user's to take back and edit. */
function QueueDock({ sessionId, inbox, onRecover }: { sessionId: string | null; inbox: InboxEntry[]; onRecover: (entry: InboxEntry) => void }) {
  const withdraw = async (entry: InboxEntry) => {
    if (!sessionId) return
    try {
      const result = await api.withdrawInbox(sessionId, entry.id)
      onRecover({ ...entry, ...(result?.recovered as Partial<InboxEntry> | undefined) })
    } catch (e) { toast((e as Error).message, 'danger') }
  }
  return (
    <AnimatePresence initial={false}>
      {inbox.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="mx-3 mb-[-10px] rounded-t-2xl bg-subtle px-3 pb-4 pt-2 shadow-[inset_0_0_0_1px_var(--line-faint)]"
        >
          <div className="mb-1 text-[11.5px] font-medium text-fg-4">{tr('等待加入 · {length}', { length: inbox.length })}</div>
          <AnimatePresence initial={false}>
            {inbox.map(entry => {
              const agent = entry.source === 'subagent'
              return (
                <motion.div key={entry.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex h-8 items-center gap-2 text-[13px]">
                  <span className="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-[11px] text-fg-3 shadow-xs">{entry.delivery === 'followup' ? tr('下一轮') : tr('下一步')}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-2">{agent ? entry.notice?.trim() || tr('子代理的结果') : entry.text}</span>
                  {!agent && <button type="button" disabled={entry.deliveryStatus === 'accepted'} onClick={() => void withdraw(entry)} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-fg-3 hover:bg-hover hover:text-fg disabled:opacity-60"><Undo2 className="size-3.5" />{entry.deliveryStatus === 'accepted' ? tr('已接收') : tr('取回编辑')}</button>}
                </motion.div>
              )
            })}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
