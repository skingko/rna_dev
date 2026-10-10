/**
 * Background project initialization, shown above the conversation. Like
 * Pi/Harness the chat is usable at once: turns run on the baseline agent and
 * the generated project version applies from the next turn after it is ready.
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, CheckCircle2, Loader2, RotateCcw } from 'lucide-react'
import { useProject } from '@/store/app-store'
import { supportApi } from '@/api/support-api'
import { toast } from '@/store/ui-store'
import { t } from '@/i18n'

interface Initialization {
  status?: 'queued' | 'initializing' | 'ready' | 'failed' | 'blocked' | 'paused' | string
  phase?: string
  attempt?: number
  maxAttempts?: number
  startedAt?: string
  requestedAt?: string
  completedAt?: string
  message?: string
}

const phaseText = (phase: string | undefined) =>
  phase === 'preparing' ? t('读取项目目录与可用能力')
    : phase === 'generating' ? t('生成项目说明与工作方法')
      : phase === 'repairing' ? t('修正生成结果')
        : t('正在准备')

function useElapsed(since: string | undefined, active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  const start = since ? Date.parse(since) : NaN
  return Number.isFinite(start) ? Math.max(0, Math.round((now - start) / 1000)) : null
}

const duration = (seconds: number) => (seconds < 60 ? t('{v} 秒', { v: seconds }) : t('{v} 分 {v2} 秒', { v: Math.floor(seconds / 60), v2: seconds % 60 }))

export function ProjectInitStatus({ projectId }: { projectId: string | null | undefined }) {
  const project = useProject(projectId) as (ReturnType<typeof useProject> & { initialization?: Initialization | null; skillFoundation?: { status?: string; attemptedAt?: string } | null }) | undefined
  const init = project?.initialization ?? null
  // After the brief, base skills are picked from the marketplace (one JEV choice) and installed.
  const picking = init?.status === 'ready' && project?.skillFoundation?.status === 'preparing'
  const running = init?.status === 'queued' || init?.status === 'initializing' || picking
  const elapsed = useElapsed(picking ? project?.skillFoundation?.attemptedAt : init?.startedAt ?? init?.requestedAt, running)
  // A just-completed initialization stays visible briefly, then leaves. The
  // previous state lives in a ref so recording it cannot re-run this effect
  // (whose cleanup would clear the timer); the mark belongs to one project, so
  // switching projects never carries it over.
  const [justReady, setJustReady] = useState<string | null>(null)
  const seen = useRef({ projectId, running })
  useEffect(() => {
    const previous = seen.current
    seen.current = { projectId, running }
    if (previous.projectId !== projectId) { setJustReady(null); return }
    if (previous.running && !running && init?.status === 'ready' && projectId) setJustReady(projectId)
  }, [projectId, running, init?.status])
  useEffect(() => {
    if (!justReady) return
    const timer = window.setTimeout(() => setJustReady(null), 6000)
    return () => window.clearTimeout(timer)
  }, [justReady])
  const [busy, setBusy] = useState(false)
  const failed = init?.status === 'failed' || init?.status === 'blocked' || init?.status === 'paused'
  const visible = Boolean(init) && (running || failed || (justReady !== null && justReady === projectId))

  const retry = async () => {
    if (!projectId) return
    setBusy(true)
    try { await supportApi.initialize(projectId) } catch (e) { toast((e as Error).message, 'danger') } finally { setBusy(false) }
  }

  let icon = <Loader2 className="size-3.5 shrink-0 animate-spin text-fg-3" strokeWidth={2} />
  let title = picking ? t('正在准备基础技能') : init?.status === 'queued' ? t('项目初始化排队中') : t('正在初始化项目')
  let detail = picking ? t('从技能市场检索并挑选 2–3 个适合的技能') : init?.status === 'queued' ? t('稍后开始生成项目说明与工作方法') : phaseText(init?.phase)
  if (running && (init?.attempt ?? 1) > 1) detail = `${detail} · ${t('第 {v}/{v2} 次', { v: init?.attempt ?? 1, v2: init?.maxAttempts ?? 4 })}`
  if (running && elapsed !== null) detail = `${detail} · ${duration(elapsed)}`
  let hint = t('可以直接开始对话；初始化完成后，从下一轮起使用生成的项目能力。')
  if (failed) {
    icon = <AlertCircle className="size-3.5 shrink-0 text-danger" strokeWidth={2} />
    title = init?.status === 'blocked' ? t('项目初始化等待模型配置') : init?.status === 'paused' ? t('项目初始化已暂停') : t('项目初始化未完成')
    detail = init?.message ?? ''
    hint = t('对话不受影响，可继续使用通用能力。')
  } else if (!running) {
    icon = <CheckCircle2 className="size-3.5 shrink-0 text-success" strokeWidth={2} />
    title = t('项目初始化完成')
    detail = t('下一轮起使用生成的项目说明、技能与工具。')
    hint = ''
  }

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          key="init"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="mx-auto w-full max-w-[var(--content-width)] px-6 pt-3"
          role="status"
          aria-live="polite"
          data-project-init={init?.status}
        >
          <div className="flex items-start gap-2.5 rounded-lg border border-line-faint bg-muted/60 px-3 py-2">
            <span className="mt-0.5">{icon}</span>
            <div className="min-w-0 flex-1 text-[12.5px] leading-5">
              <div className="text-fg-2">{title}</div>
              {detail && <div className="truncate text-fg-4" title={detail}>{detail}</div>}
              {hint && <div className="text-fg-4">{hint}</div>}
            </div>
            {failed && init?.status !== 'blocked' && (
              <button type="button" onClick={retry} disabled={busy} className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-fg-3 transition-colors hover:bg-hover hover:text-fg-2 disabled:opacity-50">
                <RotateCcw className="size-3.5" strokeWidth={1.8} />{t('重试')}
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
