/**
 * Empty / new-session state. The only place with a WebGL background
 * (ReactBits Threads, lazy-loaded). Entrance is one GSAP timeline that
 * staggers transform/opacity; reduced motion skips straight to the end.
 */
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ArrowRight, GitCompare, ListChecks, MessageCircleQuestion, PlayCircle, SearchCheck, Telescope, type LucideIcon } from 'lucide-react'
import { projectApi, type SessionSuggestion } from '@/api/project-api'
import { useApp, useProject } from '@/store/app-store'
import { fillComposer, useUi } from '@/store/ui-store'
import { prettyPath } from '@/lib/format'
import BlurText from '@/components/reactbits/BlurText'
import SpotlightCard from '@/components/reactbits/SpotlightCard'
import { Composer } from '@/components/composer/Composer'
import { BrandMark } from './Sidebar'
import { t, localized } from '@/i18n'

const Threads = lazy(() => import('@/components/reactbits/Threads'))

/** Only when the host cannot be asked: starters. Normally the cards come from the project's state (GET /api/v2/suggestions). */
const STARTERS: SessionSuggestion[] = localized([
  { kind: 'explore', title: '梳理项目现状', text: '先通读项目结构和最近的改动，告诉我现在的状态和最值得推进的三件事。' },
  { kind: 'continue', title: '继续上次的工作', text: '回顾上一次会话的结论和未完成事项，接着把剩下的部分做完。' },
  { kind: 'check', title: '检查最近的改动', text: '检查最近修改过的文件，找出可能的问题并给出修复建议。' },
])
const ICONS: Record<string, LucideIcon> = { continue: PlayCircle, answer: MessageCircleQuestion, review: SearchCheck, plan: ListChecks, check: GitCompare, explore: Telescope }

/** The project's suggestions; asked again once while the host is still writing them. */
function useSuggestions(projectId: string | null) {
  const [rows, setRows] = useState<SessionSuggestion[] | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setRows(null)
    const load = (again: boolean) => projectApi.suggestions(projectId, controller.signal).then(result => {
      setRows(result.suggestions?.length ? result.suggestions : STARTERS)
      if (result.refreshing && again) timer = setTimeout(() => void load(false), 6000)
    }, () => { if (!controller.signal.aborted) setRows(STARTERS) })
    void load(true)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [projectId])
  return rows
}

export function EmptyHero({ onSent }: { onSent: () => void }) {
  const projectId = useApp(s => s.selectedProjectId)
  const project = useProject(projectId)
  const suggestions = useSuggestions(projectId ?? null)
  const root = useRef<HTMLDivElement>(null)
  const dark = useUi(s => s.theme) === 'dark' || (useUi(s => s.theme) === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const mm = gsap.matchMedia()
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const tl = gsap.timeline({ defaults: { ease: 'power3.out', duration: 0.7 } })
      tl.from(el.querySelector('[data-hero="mark"]'), { y: 10, scale: 0.9, opacity: 0, duration: 0.6 })
        .from(el.querySelectorAll('[data-hero="sub"]'), { y: 8, opacity: 0 }, '-=0.25')
        .from(el.querySelector('[data-hero="composer"]'), { y: 14, opacity: 0, duration: 0.8 }, '-=0.45')
        .from(el.querySelectorAll('[data-hero="card"]'), { y: 10, opacity: 0, stagger: 0.07, duration: 0.6 }, '-=0.55')
    })
    return () => mm.revert()
  }, [projectId])

  return (
    <div ref={root} className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-5">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[42%] opacity-[0.45] [mask-image:linear-gradient(to_top,black_30%,transparent)]" aria-hidden>
        <Suspense fallback={null}>
          <Threads color={dark ? [0.55, 0.61, 0.96] : [0.31, 0.39, 0.85]} amplitude={0.9} distance={0.1} />
        </Suspense>
      </div>
      <div className="relative flex w-full max-w-[680px] flex-1 flex-col justify-center pb-[12vh] pt-10">
        <div data-hero="mark" className="mb-6"><BrandMark size={40} /></div>
        <BlurText
          text={t('今天想推进什么？')}
          animateBy="letters"
          direction="bottom"
          delay={45}
          stepDuration={0.28}
          className="text-[28px] font-semibold leading-[1.3] tracking-[-0.01em] text-fg"
        />
        <p data-hero="sub" className="mt-2.5 text-[14px] leading-6 text-fg-3">
          {project ? <>{t('在「{name}」中开始新会话', { name: project.name })}<span className="ml-2 text-fg-4">{prettyPath(project.workspacePath)}</span></> : t('选择左侧的项目，或直接描述你的想法')}
        </p>
        <div data-hero="composer" className="mt-7">
          <Composer variant="hero" onSent={onSent} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(suggestions ?? []).map((s, index) => { const Icon = ICONS[s.kind] ?? ListChecks; return (
            <div data-hero="card" key={`${index}:${s.title}`}>
              <SpotlightCard as="button" onClick={() => fillComposer(s.text)} className="block h-full w-full text-left">
                {/* Compact single row on phones; icon / title / description card from sm up. */}
                <div className="flex h-full items-center gap-2.5 px-3.5 py-3 sm:flex-col sm:items-stretch sm:gap-1.5 sm:py-3.5">
                  <span className="flex items-center justify-between">
                    <Icon className="size-4 text-fg-3 transition-colors duration-200 group-hover/spot:text-accent" strokeWidth={1.7} />
                    <ArrowRight className="hidden size-3.5 text-fg-4 opacity-0 transition-[opacity,transform] duration-200 group-hover/spot:translate-x-0.5 group-hover/spot:opacity-100 sm:block" />
                  </span>
                  <span className="text-[13px] font-medium text-fg sm:mt-1">{s.title}</span>
                  <span className="hidden text-[12px] leading-[1.6] text-fg-4 sm:line-clamp-2">{s.text}</span>
                </div>
              </SpotlightCard>
            </div>
          ) })}
          {/* While the first answer is on its way the row keeps its height, so nothing below jumps. */}
          {!suggestions && [0, 1, 2].map(index => <div key={index} data-hero="card" aria-hidden className="h-[92px] rounded-xl bg-subtle/60 shadow-[inset_0_0_0_1px_var(--line)]" />)}
        </div>
      </div>
    </div>
  )
}
