/**
 * 进化 — the project's gene tree (docs/planning/evolution-v3-gene-tree-20260930.md §4),
 * drawn like a skill tree in the app's own quiet style: the project at its
 * current generation on top, five branches below (画像 / 提示 / 技能 / 工具与守卫 /
 * 标准, plus 系统 once lane C has recorded a problem in the app itself), each a card whose genes hang on one thin line. Neutral dots are in
 * force, the accent marks what is on trial or new, dashed is being verified.
 * Clicking a gene opens one plain sentence, why it exists, how it has been
 * used, and the only actions a person needs: 对 / 记错了 / 不再用.
 *
 * One surface, two shells (design 4.1): the 进化 page (`layout: 'page'`) and
 * the 进化 panel (`layout: 'panel'`, with 在主视图中打开 in its ⋯ menu). It
 * lays out by its own width (container queries, from 260 px up); a hidden
 * surface catches up with the host's changes when it shows again.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { BookOpen, Check, ChevronRight, Cpu, Microscope, Pencil, ScrollText, ShieldCheck, Target, UserRound, X, type LucideIcon } from 'lucide-react'
import { genesApi, type EvolutionStatus, type Gene, type GeneContent, type GeneStrand, type GeneTree } from '@/api/genes-api'
import { Observability, laneLines } from './EvolutionObservability'
import { Markdown } from '@/components/markdown/Markdown'
import { useApp } from '@/store/app-store'
import { useMind } from '@/store/mind-store'
import { toast } from '@/store/ui-store'
import { Button } from '@/components/ui/primitives'
import { SplitView, Badge } from './kit'
import { SurfaceMenu } from './SurfaceMenu'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { t, localized } from '@/i18n'

interface Branch { key: string; label: string; hint: string; layers: string[] }
const BRANCHES: Branch[] = localized([
  { key: 'profile', label: '画像', hint: '你的偏好、约束和做事习惯', layers: ['profile'] },
  { key: 'prompt', label: '提示', hint: '项目说明里的每一段', layers: ['prompt'] },
  { key: 'skill', label: '技能', hint: '做事的方法', layers: ['skill'] },
  { key: 'tools', label: '工具与守卫', hint: '自动检查和专用工具', layers: ['tool', 'guard'] },
  { key: 'standard', label: '标准', hint: '怎样算做好了', layers: ['standard'] },
  { key: 'system', label: '系统', hint: 'Rna 自身或这台机器的问题，不是项目做法', layers: ['system'] },
])
/** Kept out of the localized table: components are not strings to translate. */
const ICONS: Record<string, LucideIcon> = { profile: UserRound, prompt: ScrollText, skill: BookOpen, tools: ShieldCheck, standard: Target, system: Cpu }
const STATUS_LABELS: Record<string, string> = localized({ active: '生效中', trial: '试用中', testing: '验证中', proposed: '提议中', retired: '已停用', rejected: '未通过' })
const LAYER_LABELS: Record<string, string> = localized({ profile: '画像', prompt: '提示', skill: '技能', tool: '工具', guard: '守卫', standard: '标准', system: '系统' })
/** A system record is a problem, not a rule: it is still happening or solved. */
const SYSTEM_STATUS: Record<string, string> = localized({ active: '仍在发生', retired: '已解决' })
const statusLabel = (gene: Gene) => (gene.layer === 'system' ? SYSTEM_STATUS[gene.status] : undefined) ?? STATUS_LABELS[gene.status] ?? gene.status
/** Genes shown per branch before "展开". */
const VISIBLE = 6
const RANK: Record<string, number> = { trial: 0, testing: 1, proposed: 1, active: 2, retired: 4, rejected: 5 }
const DAY = 86400000
const isNew = (gene: Gene, tree: GeneTree | null) => Boolean(tree?.generation.n && gene.generation === tree.generation.n && gene.createdAt && Date.now() - Date.parse(gene.createdAt) < DAY)
const order = (genes: Gene[]) => [...genes].sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3) || (b.level ?? 0) - (a.level ?? 0) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))

export interface EvolutionSurfaceProps {
  projectId: string
  sessionId?: string | null
  /** On screen: changes from the host are read now, or once it shows again. */
  visible: boolean
  layout: 'page' | 'panel'
  /** A panel's 在主视图中打开. */
  onShowInMain?: () => void
}

/** The 进化 page as it was before the panel (callers that render the page directly). */
export function EvolutionView({ projectId }: { projectId: string }) {
  return <EvolutionSurface projectId={projectId} visible layout="page" />
}

export function EvolutionSurface({ projectId, visible, layout, onShowInMain }: EvolutionSurfaceProps) {
  const [tree, setTree] = useState<GeneTree | null>(null)
  const [status, setStatus] = useState<EvolutionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const revision = useApp(s => s.revision)
  const focus = useMind(s => (s.focus?.projectId === projectId ? s.focus : null))
  const statusAt = useRef(0)
  const reload = useCallback(async () => {
    try { setTree(await genesApi.tree(projectId)); setError(null) } catch (e) { setError((e as Error).message) }
    // Where each lane is and why nothing happens (EVO-12): a quiet extra read (at most one every few seconds: the project's
    // revision moves with every change), never an error of the page.
    if (Date.now() - statusAt.current < 5000) return
    statusAt.current = Date.now()
    void genesApi.status(projectId).then(setStatus).catch(() => { statusAt.current = 0 /* the tree is the page; the lane line is a bonus */ })
  }, [projectId])
  useEffect(() => { void reload() }, [reload])
  // Follow the host: a new generation or a routed lesson changes the project revision. Hidden, it reads once shown.
  const last = useRef(revision)
  const stale = useRef(false)
  useEffect(() => {
    if (revision === last.current) return
    last.current = revision
    if (!visible) { stale.current = true; return }
    const timer = setTimeout(() => void reload(), 400)
    return () => clearTimeout(timer)
  }, [revision, reload, visible])
  useEffect(() => { if (visible && stale.current) { stale.current = false; void reload() } }, [visible, reload])
  useEffect(() => { if (focus) setSelected(`lesson:${focus.id}`) }, [focus?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const branches = useMemo(() => BRANCHES.map(branch => ({ branch, genes: order((tree?.strands ?? []).filter((row: GeneStrand) => branch.layers.includes(String(row.layer))).flatMap(row => row.genes)) })).filter(row => row.branch.key !== 'system' || row.genes.length), [tree])
  const gene = useMemo(() => branches.flatMap(row => row.genes).find(row => row.id === selected) ?? null, [branches, selected])
  const branchOf = (id: string) => branches.find(row => row.genes.some(item => item.id === id))?.branch ?? BRANCHES[0]
  // Standard titles by key, for a guard's 对应标准 row.
  const standards = useMemo(() => Object.fromEntries((tree?.strands ?? []).filter(row => row.layer === 'standard').flatMap(row => row.genes).map(row => [row.key, row.title])), [tree])

  const menu = layout === 'panel' && onShowInMain ? <SurfaceMenu onShowInMain={onShowInMain} /> : null
  if (error) return <div className="flex min-h-0 flex-1 flex-col">{menu && <div className="flex justify-end px-1.5 pt-1.5">{menu}</div>}<Empty>{t('进化树暂时读不到：{message}', { message: error })}</Empty></div>
  const all = branches.flatMap(row => row.genes)
  return (
    <SplitView detailLabel={gene ? gene.title : ''} onClose={() => setSelected(null)}
      detail={gene ? <GeneDetail projectId={projectId} gene={gene} branch={branchOf(gene.id)} standards={standards} onChanged={reload} /> : null}
      list={
        <div className="@container/evolution w-full" data-evolution-surface={layout}>
          <div className={cn('@container mx-auto w-full max-w-[1080px] px-4 pb-12 @[640px]/evolution:px-6', layout === 'panel' ? 'pt-3' : 'pt-5')}>
            <Headline tree={tree} status={status} actions={menu} />
            {!tree ? <TreeSkeleton /> : all.length === 0 ? <Empty>{t('项目初始化完成后，这里会长出它的能力树。')}</Empty> : (
              <SkillTree tree={tree} branches={branches} all={all} selected={selected} onSelect={setSelected} />
            )}
            {tree && all.length > 0 && <Legend />}
            {tree && <Records tree={tree} projectId={projectId} />}
          </div>
        </div>
      } />
  )
}

export function Headline({ tree, status, actions }: { tree: GeneTree | null; status: EvolutionStatus | null; actions?: ReactNode }) {
  return (
    <div>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[17px] font-semibold text-fg">{t('进化')}</h1>
          {tree?.generation.summary && <p className="min-w-0 text-[13px] text-fg-3">{t('最近：{summary}', { summary: tree.generation.summary })}{tree.generation.at ? ` · ${relativeTime(tree.generation.at)}` : ''}</p>}
        </div>
        {actions && <div className="-mr-2 -mt-0.5 shrink-0">{actions}</div>}
      </div>
      {/* EVO-12: the gene lanes' own state (what each is waiting for), not the retired whole-genome learning lane's quota. */}
      {status && (status.enabled
        ? <p className="mt-1 text-[12px] leading-[1.6] text-fg-4" data-evolution-lanes>{laneLines(status.status).join(' · ')}</p>
        : <p className="mt-1 text-[12px] leading-[1.6] text-fg-4" data-evolution-lanes>{t('进化已关闭，已有的规则照常起作用。')}</p>)}
    </div>
  )
}

/** The project node on top, a connector fanning out to five branch cards. */
function SkillTree({ tree, branches, all, selected, onSelect }: { tree: GeneTree; branches: { branch: Branch; genes: Gene[] }[]; all: Gene[]; selected: string | null; onSelect: (id: string) => void }) {
  const n = tree.generation.n, trial = all.filter(row => row.status === 'trial' || row.status === 'testing').length
  const inForce = all.filter(row => row.status === 'active' || row.status === 'trial').length
  return (
    <div className="mt-6">
      <div className="flex justify-center">
        <div className={cn('relative min-w-[200px] rounded-xl bg-elevated px-5 py-3 text-center shadow-[inset_0_0_0_1px_var(--line)]', tree.forming && 'shadow-[inset_0_0_0_1px_var(--accent)]')}>
          <div className="text-[15px] font-semibold text-fg">{n ? t('第 {n} 代', { n }) : t('起点')}</div>
          <div className="mt-0.5 text-[12px] text-fg-3">
            {t('{count} 个基因在起作用', { count: inForce })}{trial ? ` · ${t('{count} 个试用中', { count: trial })}` : ''}{tree.forming ? ` · ${t('正在裂变…')}` : ''}
          </div>
        </div>
      </div>
      {/* Connector: down from the project, across the five branches (wide layouts only). */}
      <div aria-hidden className="relative hidden h-7 @[760px]:block">
        <span className="absolute left-1/2 top-0 h-3.5 w-px bg-line-strong" />
        <span className="absolute left-[10%] right-[10%] top-3.5 h-px bg-line-strong" />
      </div>
      <div className={cn('mt-5 grid grid-cols-1 gap-3 @[480px]:grid-cols-2 @[760px]:mt-0 @[760px]:gap-0', branches.length > 5 ? '@[760px]:grid-cols-6' : '@[760px]:grid-cols-5')}>
        {branches.map(({ branch, genes }, index) => <BranchCard key={branch.key} branch={branch} genes={genes} tree={tree} selected={selected} onSelect={onSelect} index={index} />)}
      </div>
    </div>
  )
}

function BranchCard({ branch, genes, tree, selected, onSelect, index }: { branch: Branch; genes: Gene[]; tree: GeneTree; selected: string | null; onSelect: (id: string) => void; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const reduced = useReducedMotion()
  const live = genes.filter(row => row.status !== 'retired' && row.status !== 'rejected'), gone = genes.length - live.length
  const shown = expanded ? genes : live.slice(0, VISIBLE), hidden = genes.length - shown.length
  const Icon = ICONS[branch.key] ?? BookOpen
  return (
    <section aria-label={branch.label} className="relative @[760px]:px-1.5">
      <span aria-hidden className="absolute -top-3.5 left-1/2 hidden h-3.5 w-px bg-line-strong @[760px]:block" />
      <div className="h-full rounded-xl bg-base px-2.5 pb-2 pt-3 shadow-[inset_0_0_0_1px_var(--line)]">
        <header className="flex items-center gap-1.5 px-1.5" title={branch.hint}>
          <Icon className="size-3.5 shrink-0 text-fg-3" strokeWidth={1.8} />
          <h2 className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg-2">{branch.label}</h2>
          <span className="text-[11.5px] tabular-nums text-fg-4">{live.length}</span>
        </header>
        {shown.length ? (
          <ul className="relative mt-2 before:absolute before:bottom-3 before:left-[13px] before:top-3 before:w-px before:bg-line">
            {shown.map((gene, i) => (
              <motion.li key={gene.id} initial={reduced ? false : { opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduced ? 0 : 0.02 * (index * 3 + i), duration: 0.18 }}>
                <GeneRow gene={gene} fresh={isNew(gene, tree)} selected={gene.id === selected} onSelect={() => onSelect(gene.id)} />
              </motion.li>
            ))}
          </ul>
        ) : <p className="mt-2 px-1.5 pb-1 text-[12px] leading-[1.6] text-fg-4">{t('还没有')}</p>}
        {(hidden > 0 || expanded) && (
          <button type="button" onClick={() => setExpanded(value => !value)} className="mt-0.5 w-full rounded-md px-1.5 py-1 text-left text-[12px] text-fg-4 outline-none hover:bg-hover hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
            {expanded ? t('收起') : gone && hidden === gone ? t('{count} 个已停用', { count: gone }) : t('还有 {count} 个', { count: hidden })}
          </button>
        )}
      </div>
    </section>
  )
}

const KIND_LABELS: Record<string, string> = localized({ preference: '偏好', constraint: '约束', pitfall: '易错点', success_habit: '好做法' })

function GeneRow({ gene, fresh, selected, onSelect }: { gene: Gene; fresh: boolean; selected: boolean; onSelect: () => void }) {
  const retired = gene.status === 'retired' || gene.status === 'rejected'
  // Profile genes read "偏好：…": the kind (in the interface language) is quieter than the rule itself.
  const split = gene.layer === 'profile' ? /^([^：:]{1,4}[：:])(.+)$/.exec(gene.title) : null
  const kind = split ? (gene.kind && KIND_LABELS[gene.kind] ? t('{kind}：', { kind: KIND_LABELS[gene.kind] }) : split[1]) : undefined, rest = split?.[2]
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} aria-label={`${gene.title} · ${statusLabel(gene)}`}
      className={cn('group relative flex w-full items-start gap-2 rounded-lg py-1.5 pl-1.5 pr-1.5 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]', selected ? 'bg-active' : 'hover:bg-hover')}>
      <span className="relative z-[1] mt-[5px] grid size-3 shrink-0 place-items-center rounded-full bg-base"><StatusDot status={gene.status} /></span>
      <span className={cn('min-w-0 flex-1 text-[12.5px] leading-[1.5]', retired ? 'text-fg-4 line-through decoration-fg-4/50' : 'text-fg-2 group-hover:text-fg')}>
        <span className="line-clamp-2">{kind ? <><span className="text-fg-4">{kind}</span>{rest}</> : gene.title}</span>
      </span>
      {fresh ? <span className="mt-px shrink-0 rounded-[5px] bg-accent-softer px-1 text-[10.5px] leading-[18px] text-accent-text">{t('新')}</span>
        : (gene.level ?? 0) >= 2 && <span className="mt-px shrink-0 text-[10.5px] leading-[18px] tabular-nums text-fg-4" title={t('{n} 级', { n: gene.level })}>Lv{gene.level}</span>}
    </button>
  )
}

function StatusDot({ status }: { status: string }) {
  if (status === 'trial') return <span className="relative size-2 rounded-full bg-accent ring-[3px] ring-accent-soft" />
  if (status === 'testing' || status === 'proposed') return <span className="size-2 rounded-full border border-dashed border-fg-3" />
  if (status === 'retired' || status === 'rejected') return <span className="size-2 rounded-full bg-fg-4/40" />
  return <span className="size-2 rounded-full bg-fg-3" />
}

function Legend() {
  const items: [string, ReactNode][] = [
    [t('生效中'), <StatusDot key="a" status="active" />],
    [t('试用中'), <StatusDot key="b" status="trial" />],
    [t('验证中'), <StatusDot key="c" status="testing" />],
    [t('这一代新增'), <span key="d" className="rounded-[5px] bg-accent-softer px-1 text-[10.5px] leading-4 text-accent-text">{t('新')}</span>],
  ]
  return <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-fg-4">{items.map(([label, icon]) => <span key={label} className="inline-flex items-center gap-1.5">{icon}{label}</span>)}</div>
}

function TreeSkeleton() {
  return (
    <div className="mt-6 space-y-6" aria-hidden>
      <div className="mx-auto h-[62px] w-[200px] rounded-xl bg-subtle" />
      <div className="grid grid-cols-2 gap-3 @[760px]:grid-cols-5">{Array.from({ length: 5 }, (_, index) => <div key={index} className="h-40 rounded-xl bg-subtle" />)}</div>
    </div>
  )
}

function Records({ tree, projectId }: { tree: GeneTree; projectId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="mt-8 border-t border-line-faint pt-4">
      <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)} className="flex items-center gap-1.5 rounded text-[12.5px] text-fg-4 outline-none hover:text-fg-2 focus-visible:ring-2 focus-visible:ring-[var(--line-focus)]">
        <ChevronRight className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')} />{t('详细记录')}
      </button>
      {open && (
        <div className="mt-2 pl-5 text-[13px] text-fg-3">
          {/* EVO-15: the instruction file is the user's own; evolution reads it (a rule it states is not learned again) and never writes it. */}
          <p className="mb-2 text-fg-4">{tree.promptFile.exists ? t('项目说明文件：{name}（Rna 和其他代理每次都会读它；进化不会改写它，要改请直接编辑）', { name: tree.promptFile.name ?? '' }) : t('还没有项目说明文件；在项目根目录新建 {name}，Rna 和其他代理每次都会读它', { name: tree.promptFile.default })}</p>
          {tree.generations.length ? <ul className="space-y-1">{tree.generations.map(row => <li key={row.n} className="flex gap-3"><span className="w-14 shrink-0 tabular-nums text-fg-4">{t('第 {n} 代', { n: row.n })}</span><span className="min-w-0 flex-1">{row.summary}</span><span className="shrink-0 text-fg-4">{relativeTime(row.at)}</span></li>)}</ul> : <p className="text-fg-4">{t('还没有进化过。')}</p>}
          {/* D3: what the evolution measured about itself: exposure, dispositions, outcomes by generation, the scoreboard. */}
          <div className="mt-4 border-t border-line-faint pt-3"><h3 className="text-[12.5px] font-medium text-fg-3">{t('进化观测')}</h3><Observability projectId={projectId} /></div>
        </div>
      )}
    </section>
  )
}

function GeneDetail({ projectId, gene: treeGene, branch, standards, onChanged }: { projectId: string; gene: Gene; branch: Branch; standards: Record<string, string>; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [full, setFull] = useState<GeneContent | null>(null)
  const [fresh, setFresh] = useState<Pick<Gene, 'summary' | 'original'> | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    setLoading(true); setFull(null); setFresh(null)
    genesApi.detail(projectId, treeGene.id).then(view => { if (live) { setFull(view.content); setFresh({ summary: view.gene.summary, original: view.gene.original }) } }).catch(() => { if (live) setFull(null) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [projectId, treeGene.id, treeGene.updatedAt, treeGene.summary])
  // A plain-language summary written after the tree loaded arrives with the detail.
  const gene = fresh?.summary ? { ...treeGene, ...fresh } : treeGene
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(gene.summary)
  useEffect(() => { setEditing(false); setDraft(gene.summary) }, [gene.id, gene.summary])
  const act = async (body: { action: 'confirm' | 'revoke' | 'deep_check' } | { action: 'rewrite'; text: string }, done: string) => {
    setBusy(true)
    try { await genesApi.act(projectId, gene.id, body); toast(done); setEditing(false); onChanged() } catch (e) { toast((e as Error).message, 'danger') } finally { setBusy(false) }
  }
  const lesson = gene.id.startsWith('lesson:'), guard = gene.layer === 'guard', patch = gene.id.startsWith('skill-patch:'), merge = gene.id.startsWith('skill-merge:'), system = gene.layer === 'system'
  const actionable = lesson || ((guard || patch || merge) && gene.status !== 'retired' && gene.status !== 'rejected')
  const stats = gene.stats ?? {}
  const rows: [string, ReactNode][] = []
  if (gene.origin?.quote) rows.push([t('为什么'), <q key="q">{gene.origin.quote}</q>])
  else if (gene.origin?.sourceRemoved) rows.push([t('为什么'), gene.origin.sourceRemoved === 'message_rewound' ? t('原话所在的消息已被编辑或删除') : t('原话所在的对话已删除')])
  if (guard) rows.push([t('用过'), !gene.runs ? t('还没运行过') : stats.real || stats.falseMatches ? t('运行 {runs} 次，确认 {real} 处真问题，{falseMatches} 处误报已略过', { runs: gene.runs, real: stats.real ?? 0, falseMatches: stats.falseMatches ?? 0 }) : t('运行 {runs} 次，抓到 {hits} 处', { runs: gene.runs, hits: gene.hits })])
  // D3: what the rule was run for or put in front of the model, never its level (which is derived from these counts).
  if (guard && gene.runs && gene.exposure?.ranRecent !== null && gene.exposure?.ranRecent !== undefined) rows.push([t('近 7 天'), t('运行 {n} 次', { n: gene.exposure.ranRecent })])
  if (patch && gene.exposure && gene.exposure.shown !== null && gene.exposure.shown !== undefined) rows.push([t('用到'), t('放进回合 {shown} 次，照着做 {applied} 次', { shown: gene.exposure.shown, applied: gene.exposure.applied })])
  if ((guard || patch) && gene.harmWatch && gene.status !== 'retired' && gene.status !== 'rejected') rows.push([t('对照'), t('同一个定时任务在它出现后被纠正得更多，正在观察；要不要停用由你决定')])
  if (patch && full?.name) rows.push([t('写进了'), t('技能「{name}」', { name: full.name })])
  if (patch && gene.when) rows.push([t('用在'), gene.when])
  // Trial → active from evidence (EVO-13): a check's confirmed real catches, a rule's confidently followed uses — with no
  // same-point correction. Turns without a correction are not evidence. A check that never ran says so in 用过.
  if (guard && gene.status === 'trial' && !gene.noisy && gene.runs) rows.push([t('试用'), t('确认抓到 {real}/3 处真问题', { real: Math.min(3, stats.real ?? 0) })])
  if (patch && gene.status === 'trial') rows.push([t('试用'), t('照它做了 {applied}/3 次，没被纠正', { applied: Math.min(3, stats.applied ?? 0) })])
  // EVO-7: re-judged under the current routing, a program cannot tell this rule from the file.
  if (guard && gene.notCheckable && gene.status !== 'retired') rows.push([t('重新判断'), t('程序从文件里查不出这条规则，可以不再用；规则本身会留下')])
  if ((guard || patch) && stats.missed) rows.push([t('被纠正'), t('同一件事又被纠正过 {n} 次', { n: stats.missed })])
  if (guard && gene.standardId && standards[gene.standardId]) rows.push([t('对应标准'), standards[gene.standardId]])
  if (gene.layer === 'standard' && gene.checks?.length) rows.push([t('由谁检查'), gene.checks.map(row => row.title).join(t('、'))])
  if (guard && gene.existingHits) rows.push([t('加入时'), t('现有 {files} 个文件里发现 {total} 处', { files: gene.existingHits.files, total: gene.existingHits.total })])
  if (lesson && gene.uses) rows.push([t('用过'), t('用上 {applied} 次，被推翻 {contradicted} 次', { applied: gene.uses.applied ?? 0, contradicted: gene.uses.contradicted ?? 0 })])
  if (gene.layer === 'prompt' && gene.file) rows.push([t('在哪'), gene.file])
  if (gene.layer === 'skill' && full?.source) rows.push([t('来源'), SOURCE_LABELS[full.source] ?? full.source])
  if ((guard || gene.layer === 'tool') && full?.trigger?.length) rows.push([t('何时运行'), t('写完 {files} 后自动检查', { files: full.trigger.join(t('、')) })])
  if (gene.rejection?.note) rows.push([t('未通过'), gene.rejection.note])
  if (system && gene.seen) rows.push([t('出现'), gene.lastSeenAt ? t('{n} 次，最近 {when}', { n: gene.seen, when: relativeTime(gene.lastSeenAt) }) : t('{n} 次', { n: gene.seen })])
  const check = gene.deepCheck
  if (check) rows.push([t('深入检查'), check.status === 'running' ? t('进行中…') : check.status === 'failed' ? t('没完成') : check.verdict === 'unavailable' ? t('项目还没有评测用例，没法对比') : check.verdict === 'better' ? t('这一代比上一代好（{a} → {b}）', { a: score(check.baselineScore), b: score(check.candidateScore) }) : check.verdict === 'worse' ? t('这一代比上一代差（{a} → {b}），可以考虑不再用', { a: score(check.baselineScore), b: score(check.candidateScore) }) : check.verdict === 'same' ? t('和上一代差不多（{a} → {b}）', { a: score(check.baselineScore), b: score(check.candidateScore) }) : t('结果不明确')])
  return (
    <div className="space-y-4 text-[14px] leading-[1.7] text-fg-2">
      <div className="flex flex-wrap items-center gap-2">
        {(() => { const Icon = ICONS[branch.key] ?? BookOpen; return <Icon className="size-3.5 text-fg-3" strokeWidth={1.8} /> })()}
        <span className="text-[12.5px] text-fg-3">{LAYER_LABELS[gene.layer] ?? gene.layer}</span>
        <Badge tone={gene.layer === 'system' ? gene.status === 'active' ? 'warning' : 'default' : gene.status === 'active' ? 'success' : gene.status === 'trial' || gene.status === 'testing' ? 'warning' : 'default'}>{statusLabel(gene)}</Badge>
        {(gene.level ?? 0) > 0 && <span className="text-[12.5px] text-fg-4">{t('{n} 级', { n: gene.level ?? 0 })}</span>}
      </div>
      {editing ? (
        <form className="flex items-center gap-1.5" onSubmit={e => { e.preventDefault(); if (draft.trim()) void act({ action: 'rewrite', text: draft.trim() }, t('已改好')) }}>
          <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setEditing(false) } }} aria-label={t('换成更准确的说法…')} className="h-8 min-w-0 flex-1 rounded-md bg-elevated px-2.5 text-[13.5px] text-fg outline-none shadow-[inset_0_0_0_1px_var(--line)] focus:shadow-[inset_0_0_0_1px_var(--line-focus)]" />
          <Button size="sm" variant="primary" type="submit" disabled={busy || !draft.trim()}>{t('保存')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('取消')}</Button>
        </form>
      ) : <p className="text-[15px] text-fg">{gene.summary}</p>}
      {gene.noisy && <p className="rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning-text">{t('误报较多，已退回试用。它的命中会先经过判断，确认是真问题才交给我处理。')}</p>}
      {gene.layer === 'prompt' && gene.body && gene.body !== gene.summary && <p className="whitespace-pre-wrap rounded-lg bg-subtle px-3 py-2 text-[13px] text-fg-3">{gene.body}</p>}
      {rows.length > 0 && <dl className="space-y-1.5 text-[13px]">{rows.map(([label, value]) => <div key={label} className="flex gap-3"><dt className="w-14 shrink-0 text-fg-4">{label}</dt><dd className="min-w-0 flex-1 text-fg-2">{value}</dd></div>)}</dl>}
      {actionable && !editing && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Button size="sm" variant="secondary" leading={<Check className="size-3.5" />} disabled={busy} onClick={() => void act({ action: 'confirm' }, t('好，以后照这样做。'))}>{t('对')}</Button>
          {lesson && <Button size="sm" variant="ghost" leading={<Pencil className="size-3.5" />} disabled={busy} onClick={() => setEditing(true)}>{t('记错了')}</Button>}
          <Button size="sm" variant="ghost" leading={<X className="size-3.5" />} disabled={busy} onClick={() => void act({ action: 'revoke' }, t('好，这条不再用了。'))}>{t('不再用')}</Button>
          {gene.deepCheckable && check?.status !== 'running' && <Button size="sm" variant="ghost" leading={<Microscope className="size-3.5" />} disabled={busy} title={t('用项目的评测用例对比这一代和上一代；要花一些时间和额度')} onClick={() => void act({ action: 'deep_check' }, t('开始深入检查了，结果会显示在这里。'))}>{t('深入检查')}</Button>}
        </div>
      )}
      {system && gene.status === 'active' && !editing && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Button size="sm" variant="secondary" leading={<Check className="size-3.5" />} disabled={busy} onClick={() => void act({ action: 'revoke' }, t('好，记为已解决。'))}>{t('已解决')}</Button>
        </div>
      )}
      <FullContent gene={gene} content={full} loading={loading} />
      {gene.history.length > 0 && (
        <details className="text-[12.5px] text-fg-4"><summary className="cursor-pointer">{t('经过')}</summary>
          <ul className="mt-1 space-y-0.5">{gene.history.slice().reverse().map((row, index) => <li key={index}>{relativeTime(row.at)} · {(system ? SYSTEM_STATUS[row.status] : undefined) ?? STATUS_LABELS[row.status] ?? row.status}{row.note ? ` · ${row.note}` : ''}</li>)}</ul>
        </details>
      )}
    </div>
  )
}

const score = (value: number | null | undefined) => (typeof value === 'number' ? value.toFixed(2) : '—')

const SOURCE_LABELS: Record<string, string> = localized({ generated: '项目自己写的', 'marketplace-package': '技能市场', 'installed-skill-package': '已安装的技能包' })

/** SKILL.md without its front matter or a first heading that only repeats the skill's name (the panel already shows it). */
function skillBody(text: string, names: (string | undefined)[]) {
  let body = text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trimStart()
  const heading = body.match(/^#\s+(.+)\r?\n/)
  if (heading && names.some(name => name && name.trim().toLowerCase() === heading[1].trim().toLowerCase())) body = body.slice(heading[0].length).trimStart()
  return body
}

/** Everything behind the one-line summary: a skill's whole instructions, a tool's script, a lesson's evidence. */
function FullContent({ gene, content, loading }: { gene: Gene; content: GeneContent | null; loading: boolean }) {
  if (loading) return <div className="space-y-2 border-t border-line-faint pt-4" aria-hidden>{[88, 72, 80].map(width => <div key={width} className="h-3 rounded bg-subtle" style={{ width: `${width}%` }} />)}</div>
  if (!content) return null
  const section = (title: string, children: ReactNode) => <section className="border-t border-line-faint pt-4"><h3 className="mb-2 text-[12px] font-medium text-fg-3">{title}</h3>{children}</section>
  if (gene.id.startsWith('skill-patch:') && content.patch) return (
    <>
      {section(t('写进技能的做法'), <div className="rounded-lg bg-subtle px-3.5 py-3"><Markdown text={content.patch} variant="document" className="text-[13px]" /></div>)}
      {content.expectation && section(t('你会看到的变化'), <p className="text-[13px] leading-[1.7] text-fg-2">{content.expectation}</p>)}
    </>
  )
  if (gene.layer === 'skill' && content.instructions) return (
    <>
      {gene.original && gene.original !== gene.summary && <p className="text-[12.5px] leading-[1.65] text-fg-4">{gene.original}</p>}
      {section(t('技能全文'), <div className="rounded-lg bg-subtle px-3.5 py-3"><Markdown text={skillBody(content.instructions, [content.name, gene.title])} variant="document" className="text-[13px]" /></div>)}
      {content.resources?.length ? section(t('附带资料'), <ul className="space-y-0.5 font-mono text-[12px] text-fg-3">{content.resources.map(path => <li key={path}>{path}</li>)}</ul>) : null}
    </>
  )
  if ((gene.layer === 'guard' || gene.layer === 'tool') && content.script) return (
    <>
      <details className="border-t border-line-faint pt-4 text-[12.5px]"><summary className="cursor-pointer text-fg-3">{t('检查脚本')}</summary>
        <pre className="mt-2 max-h-[420px] overflow-auto rounded-lg bg-subtle px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-fg-2">{content.script}</pre>
      </details>
    </>
  )
  if (gene.layer === 'profile' && content.evidence?.length) return section(t('你当时说的'), <ul className="space-y-1.5">{content.evidence.map((row, index) => <li key={index} className="border-l-2 border-line pl-2.5 text-[13px] leading-[1.65] text-fg-3">{row}</li>)}</ul>)
  if (gene.layer === 'system' && content.detail) return section(t('细节'), <p className="text-[13px] leading-[1.7] text-fg-2">{content.detail}</p>)
  if (gene.layer === 'standard' && content.description && content.description !== gene.summary) return section(t('全文'), <p className="text-[13px] leading-[1.7] text-fg-2">{content.description}</p>)
  return null
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="mt-10 text-center text-[13.5px] leading-[1.7] text-fg-4">{children}</p>
}
