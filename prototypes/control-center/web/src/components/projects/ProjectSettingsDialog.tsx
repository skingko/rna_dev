/**
 * 项目概览与设置 (legacy project panel `overview` / `settings` tabs in
 * public/app.js renderProjectPanel). Overview: description, focus, workspace,
 * initialization status, known facts (with provenance), commitments and the
 * latest proactive judgments. Settings: rhythm, 先安静 30 分钟, proactive /
 * evolution switches, desktop notifications and digest hour, plus a link to
 * the full autonomy settings. 工作树与 Git (0.63, worktree design §12): whether
 * new conversations start in their own worktree, the worktrees kept for the
 * user (apply or discard), and git init for a folder that is not a repository.
 * Opened from the project "…" menu, the top bar menu, or
 * `openProjectSettings(projectId)`.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { BookOpen, BellRing, FolderGit2, Moon, Puzzle, RefreshCw, Settings2, ShieldCheck } from 'lucide-react'
import { worktreeApi } from '@/api/worktree-api'
import { loadWorktrees, useWorktrees } from '@/store/isolation-store'
import { isolationReasonText } from '@/lib/isolation'
import { loadGitStatus, useGitStatus } from '@/lib/workspace-changes'
import { RnaWorktrees } from '@/components/panels/worktree/RnaWorktrees'
import { GitInitDialog } from '@/components/git/GitInitDialog'
import { panelsApi } from '@/api/panels'
import { supportApi } from '@/api/support-api'
import type { DecisionRecord, ProjectDetail } from '@/api/project-api'
import { useApp } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { prettyPath } from '@/lib/format'
import { frequencySummary } from '@/lib/display/autonomy-frequency'
import { Button, SegmentedTabs, Skeleton } from '@/components/ui/primitives'
import { Group, Note, Row, Select, ToggleRow } from '@/components/settings/form'
import { PanelDialog } from '@/components/settings/PanelDialog'
import { openCapabilities, openMemory, openPermissions, openSettings, usePanels, type ProjectSettingsTab } from '@/components/settings/panel-store'
import { RhythmCard } from '@/components/views/RhythmCard'
import { MindCard } from '@/components/mind/MindCard'
import { useProjectDetail } from '@/components/views/useProjectDetail'
import { formatDate, useLocale, useT, type MessageKey, type TFunction } from '@/i18n'

const QUIET_MS = 30 * 60_000
type Fact = { id?: string; text: string; source?: string; simulated?: boolean; createdAt?: string }
type Commitment = { id?: string; text: string }
type OverviewProject = ProjectDetail & {
  overview?: string; focus?: string; facts?: Fact[]; commitments?: Commitment[]
  initialization?: { status?: string; message?: string; attempt?: number; maxAttempts?: number; diagnostic?: string } | null
  initiative?: ProjectDetail['initiative'] & { reviewMinMs?: number; reviewMaxMs?: number; cooldownMs?: number }
}

const INIT_LABELS: Record<string, MessageKey> = { queued: '等待模型初始化', initializing: '模型正在生成并校验项目能力', blocked: '需要配置真实模型', failed: '初始化失败', paused: '初始化已暂停', ready: '模型初始化完成' }
const FACT_SOURCES: Record<string, MessageKey> = { 'model-project-initialization': '项目初始化', 'user-observation': '用户补充', conversation: '项目对话' }
const ACTIONS: Record<string, MessageKey> = { share: '主动沟通', work: '后台研究', learn: '自主进化', wait: '保持安静', ask: '主动提问', schedule: '自主规划任务' }
/** A decided action the host did not start: said plainly so the list does not read as work that ran. */
const NOT_STARTED: Record<string, MessageKey> = { already_covered: '未开始：同样的检查刚做过，之后没有变化', exact_duplicate: '未开始：同样的行动已经有了' }

export const isModelProject = (p: Pick<ProjectDetail, 'initialization' | 'decisionMode' | 'simulated'>) => Boolean(p.initialization) || p.decisionMode === 'rna-model' || p.simulated === false
/** Facts the overview may show: model projects hide simulated/demo rows (legacy filter). */
export function visibleFacts(project: OverviewProject): Fact[] {
  const actual = isModelProject(project)
  return (project.facts ?? []).filter(fact => !actual || (fact.source !== 'demo-event' && (fact.simulated === false || fact.source === 'conversation'))).slice(-5)
}
export function factProvenance(fact: Fact, t: TFunction) {
  const source = FACT_SOURCES[fact.source ?? ''] ? t(FACT_SOURCES[fact.source ?? '']) : fact.source ?? ''
  const kind = fact.simulated === false || fact.source === 'conversation' ? (fact.source === 'model-project-initialization' ? t('模型初始推断，待项目证据确认') : t('已记录的项目证据')) : t('模拟记录')
  return t('来源：{source} · {kind}', { source, kind })
}
export const quietActive = (project: Pick<OverviewProject, 'initiative'>, now = Date.now()) => Boolean(project.initiative?.quietUntil && Date.parse(project.initiative.quietUntil) > now)

export function ProjectSettingsDialog() {
  const state = usePanels(s => s.projectSettings)
  const t = useT()
  const project = useApp(s => (state ? s.projects[state.projectId] : undefined))
  const close = () => usePanels.setState({ projectSettings: null })
  return (
    <PanelDialog open={state !== null} onClose={close} size="md"
      title={project ? t('{name} · 项目设置', { name: project.name }) : t('项目设置')}
      description={t('项目的背景、正在记着的事与主动协作方式。设置只作用于此项目。')}>
      {state && (
        <>
          <div className="shrink-0 px-6 pb-3">
            <SegmentedTabs<ProjectSettingsTab> layoutId="project-settings-tab" value={state.tab} onChange={tab => usePanels.setState({ projectSettings: { ...state, tab } })} className="rounded-lg bg-subtle p-0.5"
              items={[{ id: 'overview', label: t('概览') }, { id: 'settings', label: t('主动设置') }, { id: 'git', label: t('工作树与 Git') }]} />
          </div>
          <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto border-t border-line-faint px-6 py-4">
            {project ? <ProjectSettingsBody projectId={state.projectId} tab={state.tab} /> : <Note>{t('项目不存在。')}</Note>}
          </div>
        </>
      )}
    </PanelDialog>
  )
}

/** Embeddable body (the 进化 page or a project header can host it directly). */
export function ProjectSettingsBody({ projectId, tab }: { projectId: string; tab: ProjectSettingsTab }) {
  const { project, error } = useProjectDetail(projectId, ['facts', 'decisions'])
  const t = useT()
  // 工作树与 Git reads the summary and its own routes only.
  if (tab === 'git') return <GitSettings projectId={projectId} />
  if (error && !project) return <Note tone="danger">{error}</Note>
  if (!project) return <div className="space-y-3" aria-busy><Skeleton className="h-5 w-1/2" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-4 w-2/3" /></div>
  return tab === 'overview' ? <Overview project={project as OverviewProject} /> : <InitiativeSettings project={project as OverviewProject} t={t} />
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-5 text-[12.5px] font-medium text-fg-3 first:mt-0">{children}</h3>
}

function Overview({ project }: { project: OverviewProject }) {
  const t = useT()
  const locale = useLocale()
  const actual = isModelProject(project)
  const facts = visibleFacts(project)
  const decisions = [...(project.decisions ?? [])].slice(-6).reverse() as DecisionRecord[]
  const init = project.initialization
  const [busy, setBusy] = useState(false)
  const initialize = async () => {
    setBusy(true)
    try { await supportApi.initialize(project.id); toast(t('已重新安排项目初始化。')) } catch (e) { toast((e as Error).message, 'danger') } finally { setBusy(false) }
  }
  return (
    <div className="text-[13.5px] leading-[1.7]" data-project-overview={project.id}>
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--brand-mark)] text-[15px] font-semibold text-[var(--brand-mark-fg)]" style={{ fontFamily: 'var(--font-brand)', fontStyle: 'italic' }} aria-hidden>{project.name.slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-fg">{project.name}</h3>
          <p className="text-fg-3">{project.description || t('持续协作中的项目')}</p>
        </div>
      </div>
      {project.overview && <p className="mt-3 text-fg-2">{project.overview}</p>}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
        <dt className="text-fg-4">{t('当前关注')}</dt><dd className="min-w-0 text-fg-2">{project.focus || t('尚未设定')}</dd>
        <dt className="text-fg-4">{t('工作目录')}</dt><dd className="min-w-0 truncate font-mono text-[12px] text-fg-2" title={project.workspacePath}>{project.workspacePath ? prettyPath(project.workspacePath) : t('未记录')}</dd>
      </dl>

      {init?.status && init.status !== 'ready' && (
        <div className="mt-4 rounded-xl bg-subtle px-4 py-3">
          <strong className="text-[13.5px] text-fg">{INIT_LABELS[init.status] ? t(INIT_LABELS[init.status]) : init.status}</strong>
          {init.attempt ? <span className="ml-2 text-[12px] text-fg-4">{t('生成 / 修复 {attempt} / {max}', { attempt: init.attempt, max: init.maxAttempts ?? 4 })}</span> : null}
          {init.message && <p className="mt-1 text-[12.5px] text-fg-3">{init.message}</p>}
          {['blocked', 'failed', 'paused'].includes(init.status) && <Button className="mt-2" size="sm" variant="secondary" disabled={busy} leading={<RefreshCw className="size-3.5" />} onClick={() => void initialize()}>{t('重试初始化')}</Button>}
        </div>
      )}

      <MindCard projectId={project.id} className="mt-4" onOpen={() => usePanels.setState({ projectSettings: null })} />

      <Heading>{t('已经知道的项目背景')}</Heading>
      {facts.length ? (
        <ul className="space-y-1.5">
          {facts.map((fact, i) => (
            <li key={fact.id ?? i} className="rounded-lg bg-subtle px-3 py-2">
              <p className="text-fg">{fact.text}</p>
              <p className="text-[11.5px] text-fg-4">{factProvenance(fact, t)}</p>
            </li>
          ))}
        </ul>
      ) : <p className="text-[12.5px] text-fg-4">{t('还没有新的项目证据。继续对话或让 Rna 在后台工作，都会积累新的项目证据。')}</p>}

      {(project.commitments?.length ?? 0) > 0 && (
        <>
          <Heading>{t('正在记着的事')}</Heading>
          <ul className="space-y-1.5">{project.commitments!.map((c, i) => <li key={c.id ?? i} className="rounded-lg bg-subtle px-3 py-2 text-fg">{c.text}</li>)}</ul>
        </>
      )}

      <Heading>{t('最近的主动判断')}</Heading>
      {decisions.length ? (
        <ul className="space-y-1.5">
          {decisions.map(d => (
            <li key={d.id} className="rounded-lg px-3 py-2 shadow-[inset_0_0_0_1px_var(--line)]">
              <div className="flex items-center gap-2 text-[12.5px]">
                <strong className="font-medium text-fg">{ACTIONS[d.action ?? ''] ? t(ACTIONS[d.action ?? '']) : d.action}</strong>
                {d.admission && NOT_STARTED[d.admission.reason] && <span className="text-fg-4">{t(NOT_STARTED[d.admission.reason])}</span>}
                {d.at && <time className="ml-auto text-fg-4">{formatDate(d.at, locale)}</time>}
              </div>
              {d.reason && <p className="mt-0.5 line-clamp-3 text-[12.5px] text-fg-3">{d.reason}</p>}
            </li>
          ))}
        </ul>
      ) : <p className="text-[12.5px] text-fg-4">{actual ? t('项目初始化后会自行理解当前状态，无需先设定目标。没有新发现时保持安静，并逐步延长复查间隔。') : t('没有值得处理的新信息时，不反复发言或消耗预算。')}</p>}

      <div className="mt-5 flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" leading={<ShieldCheck className="size-3.5" />} onClick={() => openPermissions(project.id)}>{t('项目权限与后台执行范围')}</Button>
        <Button size="sm" variant="ghost" leading={<BookOpen className="size-3.5" />} onClick={() => { usePanels.setState({ projectSettings: null }); openMemory(project.id) }}>{t('项目记忆')}</Button>
        <Button size="sm" variant="ghost" leading={<Puzzle className="size-3.5" />} onClick={() => { usePanels.setState({ projectSettings: null }); openCapabilities(project.id) }}>{t('技能与工具')}</Button>
      </div>
      <p className="mt-4 text-[12px] leading-[1.7] text-fg-4">{actual ? t('配置模型持续理解项目与对话，自行选择等待、研究、主动沟通或整理候选。研究使用项目已分配的工具；候选仍需独立评估。后台运行需保持 daemon 在线。') : t('此示例项目的主动判断与版本生成仍为模拟；真实聊天通过 Rna SDK。后台运行需保持 daemon 在线。')}</p>
    </div>
  )
}

/** Merge a PATCH into the cached summary so switches respond before the index event. */
function patchLocal(projectId: string, patch: Record<string, unknown>) {
  useApp.setState(s => {
    const current = s.projects[projectId] as unknown as Record<string, unknown> | undefined
    if (!current) return {}
    const next: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(patch)) next[key] = value && typeof value === 'object' && current[key] && typeof current[key] === 'object' ? { ...(current[key] as object), ...(value as object) } : value
    return { projects: { ...s.projects, [projectId]: next as never } }
  })
}

function InitiativeSettings({ project, t }: { project: OverviewProject; t: TFunction }) {
  const locale = useLocale()
  const actual = isModelProject(project)
  const [busy, setBusy] = useState<string | null>(null)
  const quiet = quietActive(project)
  const initiative = project.initiative ?? {}
  const save = async (key: string, patch: Record<string, unknown>, message: string) => {
    setBusy(key)
    try { await panelsApi.patchProject(project.id, patch); patchLocal(project.id, patch); toast(message, 'success') } catch (e) { toast((e as Error).message, 'danger') } finally { setBusy(null) }
  }
  const toggleQuiet = () => void save('quiet', { initiative: { quietUntil: quiet ? null : new Date(Date.now() + QUIET_MS).toISOString() } }, quiet ? t('已恢复主动发言。') : t('接下来 30 分钟保持安静。'))
  const rhythm = (project.rhythmStatus as { control?: string } | null)?.control
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))
  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-[1.7] text-fg-2">{t('主动性属于项目。停止聊天中的一次执行，不会关闭整个项目的关注与学习。')}</p>
      {actual && project.rhythmStatus && <RhythmCard project={project} compact />}
      <p className="text-[12.5px] leading-[1.7] text-fg-3">{rhythm === 'auto' ? t('节奏根据项目状态自动调整；手动开关和预算始终生效。') : frequencySummary(project)}</p>

      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-subtle px-4 py-3">
        <Moon className="size-4 text-fg-3" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-fg">{quiet ? t('安静至 {time}', { time: formatDate(initiative.quietUntil!, locale, { hour: '2-digit', minute: '2-digit', hour12: false }) }) : t('先安静 30 分钟')}</p>
          <p className="text-[12px] leading-[1.6] text-fg-3">{actual ? t('安静期仅暂停主动发言，后台仍可研究和整理候选。关闭主动能力才会停止后台工作。输入时延后接话，当前回复结束后再沟通。') : t('安静期内暂停主动发言和新后台动作，观察仍会保留。正在输入时会延后主动消息；不会用通知抢占当前回复。')}</p>
        </div>
        <Button size="sm" variant={quiet ? 'secondary' : 'primary'} disabled={busy !== null} onClick={toggleQuiet} data-quiet-toggle>{quiet ? (actual ? t('恢复主动发言') : t('恢复项目主动能力')) : t('先安静 30 分钟')}</Button>
      </div>

      <Group>
        <ToggleRow label={t('主动协作')} description={t('关闭后项目不再主动研究、沟通或安排任务；已有对话不受影响。')} checked={initiative.enabled !== false} disabled={busy !== null}
          onChange={v => void save('initiative', { initiative: { enabled: v } }, v ? t('已开启项目主动协作。') : t('已暂停项目主动协作。'))} />
        <ToggleRow label={t('自主进化')} description={t('根据真实工作记录复盘并生成候选；候选仍需评估，不会自动启用。')} checked={project.evolution?.enabled !== false} disabled={busy !== null}
          onChange={v => void save('evolution', { evolution: { enabled: v } }, v ? t('已开启自主进化。') : t('已关闭自主进化。'))} />
        <ToggleRow label={<span className="inline-flex items-center gap-1.5"><BellRing className="size-3.5" />{t('桌面通知')}</span>} description={t('允许紧急的主动消息同时发送桌面通知；关闭时降为对话内消息。')} checked={initiative.desktopNotifications === true} disabled={busy !== null}
          onChange={v => void save('notify', { initiative: { desktopNotifications: v } }, v ? t('已开启桌面通知。') : t('已关闭桌面通知。'))} />
        <Row label={t('每日摘要时间')} description={t('暂存的发现每天在此时合并为一条摘要消息。')}>
          <Select aria-label={t('每日摘要时间')} className="w-28" value={String(initiative.digestHour ?? 9)} options={hours} disabled={busy !== null}
            onChange={v => void save('digest', { initiative: { digestHour: Number(v) } }, t('每日摘要时间已更新。'))} />
        </Row>
      </Group>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" leading={<Settings2 className="size-3.5" />} onClick={() => { usePanels.setState({ projectSettings: null }); openSettings('autonomy') }}>{t('打开完整主动设置')}</Button>
        <span className="text-[12px] text-fg-4">{t('复查窗口、主动发言间隔和自动进化间隔在完整主动设置中统一管理。新证据仍会及时唤醒判断。')}</span>
      </div>
    </div>
  )
}

/**
 * 工作树与 Git: whether new conversations start in their own worktree (the composer switch's initial value; only
 * offered where isolation can be used, and always switchable off), the worktrees kept for the user, and — for a
 * folder that is not a repository yet — git init (worktree design §10, §12).
 */
function GitSettings({ projectId }: { projectId: string }) {
  const t = useT()
  const locale = useLocale()
  const project = useApp(s => s.projects[projectId])
  const worktrees = useWorktrees(projectId)
  const git = useGitStatus(s => s.rows[projectId]?.status ?? null)
  const [busy, setBusy] = useState(false)
  const [initOpen, setInitOpen] = useState(false)
  useEffect(() => { void loadGitStatus(projectId, { minAgeMs: 2000 }); void loadWorktrees(projectId, { minAgeMs: 2000 }) }, [projectId])
  const isolation = worktrees.data?.isolation
  const on = Boolean(project?.git?.sessionWorktreeDefault)
  const plain = git?.repo === 'none' && !git.unavailable
  const readOnly = project?.permissions?.workspace === 'read'
  const setDefault = async (value: boolean) => {
    setBusy(true)
    try {
      await worktreeApi.setSessionWorktreeDefault(projectId, value)
      patchLocal(projectId, { git: { sessionWorktreeDefault: value } })
      toast(value ? t('新对话默认在独立工作树中运行。') : t('新对话默认在项目文件夹里运行。'), 'success')
    } catch (e) { toast((e as Error).message, 'danger') } finally { setBusy(false) }
  }
  return (
    <div className="space-y-4 text-[13px] leading-[1.7]" data-project-git={projectId}>
      {plain && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-subtle px-4 py-3">
          <FolderGit2 className="size-4 text-fg-3" />
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium text-fg">{t('这个项目文件夹不是 Git 仓库')}</p>
            <p className="text-[12px] leading-[1.6] text-fg-3">{t('初始化后，改动面板能对比提交，Rna 也能在独立工作树里工作并随时回退。不会添加远端，也不会推送。')}</p>
          </div>
          <Button size="sm" variant="primary" disabled={readOnly} onClick={() => setInitOpen(true)} data-git-init>{t('初始化…')}</Button>
          <GitInitDialog projectId={projectId} open={initOpen} onClose={() => setInitOpen(false)} />
        </div>
      )}
      {project?.git?.init && <p className="text-[12.5px] text-fg-3">{t('Rna 在 {time} 把这个文件夹初始化为 Git 仓库（分支 {branch}）。', { time: formatDate(project.git.init.at, locale), branch: project.git.init.branch })}</p>}
      <Group>
        <ToggleRow label={t('新对话默认在独立工作树中运行')}
          description={isolation && !isolation.enabled ? t('现在不能用：{reason}。', { reason: isolationReasonText(isolation.reason) }) : t('新建对话时“在独立工作树中运行”的初始值；每个对话仍可在新建时自己选。')}
          checked={on} disabled={busy || readOnly || (!on && !isolation?.enabled)} onChange={v => void setDefault(v)} />
      </Group>
      <div>
        <h3 className="mb-1 text-[12.5px] font-medium text-fg-3">{t('保留的工作树')}</h3>
        <RnaWorktrees projectId={projectId} filter="kept" />
      </div>
    </div>
  )
}
