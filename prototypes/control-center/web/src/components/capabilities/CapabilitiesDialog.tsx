/**
 * 技能与工具: project-scoped capability management. Installed catalog with
 * assign / detach / unregister, the install & connect form (local skill, git
 * skill, npm MCP, MCP JSON import, official browser preset) with inspect,
 * and the skill marketplace (search → read pinned commit → prefill installer).
 * Port of public/capabilities-ui.js + public/skill-marketplace-ui.js.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Blocks, Bot, Boxes, Download, Plug, RefreshCw, Search, Store, Wrench } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import type { BuiltinAgentLimits, CapabilityCatalog, CapabilityInspectResult, CapabilityKind, CapabilityManifest, MarketplaceRead } from '@/api/panels-types'
import { Dialog } from '@/components/ui/overlays'
import { Button, SegmentedTabs, Skeleton } from '@/components/ui/primitives'
import { toast } from '@/store/ui-store'
import { useApp } from '@/store/app-store'
import { cn } from '@/lib/utils'
import { Badge, Disclosure, Empty, Field, FieldRow, Note, Select, Switch, TextArea, TextInput } from '@/components/settings/form'
import { PanelDialog } from '@/components/settings/PanelDialog'
import { usePanels } from '@/components/settings/panel-store'
import { ProjectPicker, useActiveProjects } from '@/components/projects/ProjectPicker'
import { SOURCE_LABELS, emptyInstallDraft, installInput, permissionNote, type InstallDraft, type InstallSource } from './install'
import { Marketplace } from './Marketplace'
import { t as tr, localized } from '@/i18n'

type Tab = 'installed' | 'market' | 'install'
const KIND_NAMES: Record<CapabilityKind, string> = localized({ skills: '技能', mcpServers: 'MCP 服务', tools: '工具' })
const KIND_ICONS: Record<CapabilityKind, typeof Wrench> = { skills: Blocks, mcpServers: Plug, tools: Wrench }
const PERMISSIONS: Record<string, string> = localized({ read: '只读', write: '写入', exec: '执行' })
const KNOWN_TOOLS: Record<string, string> = localized({ project_read: '读取项目文件', project_list: '浏览项目目录', project_write: '写入项目文件', project_edit: '编辑项目文件', project_exec: '运行项目命令', openviking_search: '检索项目记忆', openviking_read: '读取项目记忆' })
const ASSIGN_FIELD: Record<CapabilityKind, 'skillIds' | 'toolIds' | 'mcpServerIds'> = { skills: 'skillIds', tools: 'toolIds', mcpServers: 'mcpServerIds' }

/** A helper's bounds as the host enforces them: steps per run (then one wrap-up), how many run at once in one
 * conversation and across all of them, and the per-turn runaway guard. */
export function AgentLimits({ limits }: { limits: BuiltinAgentLimits }) {
  const vars = { depth: limits.depth, steps: limits.steps, finalSummarySteps: limits.finalSummarySteps, concurrent: limits.concurrent, concurrentTotal: limits.concurrentTotal, callsPerTurn: limits.callsPerTurn }
  return (
    <p className="mt-1 text-[11.5px] text-fg-4">
      {limits.concurrentTotal === undefined
        ? tr('最多 {depth} 层协作 · 每次 {steps} 步与 {finalSummarySteps} 次收束 · 每个对话同时 {concurrent} 个 · 每轮最多 {callsPerTurn} 次', vars)
        : tr('最多 {depth} 层协作 · 每次 {steps} 步与 {finalSummarySteps} 次收束 · 每个对话同时 {concurrent} 个，所有对话合计 {concurrentTotal} 个 · 每轮最多 {callsPerTurn} 次', vars)}
    </p>
  )
}

export function CapabilitiesDialog() {
  const state = usePanels(s => s.capabilities)
  const selected = useApp(s => s.selectedProjectId)
  const projects = useActiveProjects()
  const [projectId, setProjectId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('installed')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!state) return
    setProjectId(state.projectId ?? selected ?? projects[0]?.id ?? null)
    setTab(state.tab)
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <PanelDialog open={state !== null} onClose={() => usePanels.setState({ capabilities: null })} guard={() => (busy ? tr('请等待当前安装操作结束。') : null)} title={tr('技能与工具')} description={tr('能力随项目使用。也可以直接在对话中请 AI 安装技能或接入工具。')} size="xl">
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-6 pb-3">
        <SegmentedTabs<Tab> layoutId="cap-tab" value={tab} onChange={setTab} className="rounded-lg bg-subtle p-0.5" items={[
          { id: 'installed', label: <span className="inline-flex items-center gap-1.5"><Boxes className="size-3.5" />{tr('已安装')}</span> },
          { id: 'market', label: <span className="inline-flex items-center gap-1.5"><Store className="size-3.5" />{tr('技能市场')}</span> },
          { id: 'install', label: <span className="inline-flex items-center gap-1.5"><Download className="size-3.5" />{tr('安装与接入')}</span> },
        ]} />
        <span className="flex-1" />
        <ProjectPicker value={projectId} onChange={setProjectId} />
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto border-t border-line-faint px-6 py-5">
        {projectId ? <CapabilitiesBody key={projectId} projectId={projectId} tab={tab} setTab={setTab} onBusy={setBusy} /> : <Empty>{tr('先选择一个项目，再管理它的技能与工具。')}</Empty>}
      </div>
    </PanelDialog>
  )
}

function CapabilitiesBody({ projectId, tab, setTab, onBusy }: { projectId: string; tab: Tab; setTab: (t: Tab) => void; onBusy: (b: boolean) => void }) {
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null)
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>({ text: tr('正在读取能力目录…') })
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<InstallDraft>(emptyInstallDraft)
  const [prefillNote, setPrefillNote] = useState<string | null>(null)
  useEffect(() => onBusy(busy), [busy, onBusy])

  const load = useCallback(async () => {
    setStatus(s => (s?.error ? { text: tr('正在读取能力目录…') } : s))
    try { const next = await panelsApi.capabilities(projectId); setCatalog(next); setStatus(null) } catch (e) { setStatus({ text: (e as Error).message, error: true }) }
  }, [projectId])
  useEffect(() => { void load() }, [load])

  const change = async (path: 'assign' | 'remove', payload: Record<string, unknown>) => {
    if (busy) return
    setBusy(true); setStatus({ text: tr('正在更新项目能力…') })
    try {
      if (path === 'assign') await panelsApi.assignCapability(projectId, payload)
      else await panelsApi.removeCapability(projectId, payload as { kind: CapabilityKind; id: string })
      await load(); toast(path === 'assign' ? tr('已用于当前项目') : tr('已移出当前项目'))
    } catch (e) { setStatus({ text: (e as Error).message, error: true }) } finally { setBusy(false) }
  }

  const fromMarket = (value: MarketplaceRead) => {
    if (busy) { toast(tr('请等待当前安装操作结束。')); return }
    const pinned = value.installInput?.source ?? {}
    setDraft({ ...emptyInstallDraft(), source: 'git-skill', repository: pinned.repository ?? '', subdirectory: pinned.subdirectory ?? '.', ref: pinned.ref ?? '', activate: false })
    setPrefillNote(tr('已选择固定提交 {v}。请核对来源与许可证，再点击「仅安装」。', { v: value.commit.slice(0, 12) }))
    setTab('install')
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={tab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={{ duration: 0.18 }}>
        {tab === 'installed' && <Installed catalog={catalog} status={status} busy={busy} onChange={change} onReload={load} projectId={projectId} onInstall={() => setTab('install')} />}
        {tab === 'market' && <Marketplace projectId={projectId} onSelect={fromMarket} />}
        {tab === 'install' && <InstallForm projectId={projectId} draft={draft} setDraft={setDraft} note={prefillNote} busy={busy} setBusy={setBusy} onInstalled={async () => { await load(); setDraft(emptyInstallDraft()); setPrefillNote(null) }} />}
      </motion.div>
    </AnimatePresence>
  )
}

/* ------------------------------------------------------------- installed */

function Installed({ catalog, status, busy, onChange, onReload, projectId, onInstall }: { catalog: CapabilityCatalog | null; status: { text: string; error?: boolean } | null; busy: boolean; onChange: (path: 'assign' | 'remove', payload: Record<string, unknown>) => void; onReload: () => Promise<void>; projectId: string; onInstall: () => void }) {
  const [filter, setFilter] = useState<'all' | CapabilityKind>('all')
  const [unregister, setUnregister] = useState<{ kind: CapabilityKind; manifest: CapabilityManifest } | null>(null)
  const assigned = catalog?.assignments ?? {}
  const total = (['skillIds', 'toolIds', 'mcpServerIds'] as const).reduce((sum, key) => sum + (assigned[key]?.length ?? 0), 0)
  const sections = useMemo(() => (['skills', 'mcpServers', 'tools'] as CapabilityKind[]).map(kind => {
    const rows = [...new Map((catalog?.[kind] ?? []).map(row => [row.id, row] as const)).values()]
    const ids = assigned[ASSIGN_FIELD[kind]] ?? []
    if (kind === 'tools') for (const id of assigned.toolIds ?? []) if (KNOWN_TOOLS[id] && !rows.some(row => row.id === id)) rows.unshift({ id, name: KNOWN_TOOLS[id], description: tr('项目内置能力'), builtin: true, enabled: true })
    rows.sort((a, b) => Number(ids.includes(b.id)) - Number(ids.includes(a.id)) || String(a.name || a.id).localeCompare(String(b.name || b.id)))
    return { kind, rows, ids }
  }), [catalog, assigned])

  if (!catalog) return status?.error ? <Note tone="danger" action={<Button size="sm" onClick={() => void onReload()}>{tr('重试')}</Button>}>{status.text}</Note> : <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}</div>

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {([['all', tr('全部')], ['skills', tr('技能')], ['mcpServers', 'MCP'], ['tools', tr('工具')]] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={cn('h-7 rounded-full px-3 text-[12.5px] transition-colors', filter === value ? 'bg-accent-soft font-medium text-accent-text' : 'text-fg-3 hover:bg-hover hover:text-fg')}>{label}</button>
        ))}
        <span className={cn('ml-2 text-[12px]', status?.error ? 'text-danger' : 'text-fg-4')} role="status">{status?.text ?? tr('当前项目已分配 {total} 项能力', { total })}</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={busy} leading={<RefreshCw className="size-3.5" />} onClick={() => void onReload()}>{tr('刷新')}</Button>
        <Button size="sm" variant="secondary" disabled={busy} leading={<Download className="size-3.5" />} onClick={onInstall}>{tr('安装能力')}</Button>
      </div>

      {(catalog.builtinAgents?.length || catalog.builtinPlugins?.length) ? (
        <Disclosure summary={tr('内置能力与协作助手')} className="mb-4">
          <p className="mb-3 text-[12px] leading-[1.6] text-fg-3">{tr('这些能力已集成在 Rna 宿主中。是否能在当前项目调用，仍取决于分配、权限、运行模式和调用额度；不是安装或额外授权。')}</p>
          {catalog.builtinAgents?.length ? (
            <>
              <p className="mb-2 text-[12px] font-medium text-fg-2">{tr('协作助手')}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {catalog.builtinAgents.map(agent => (
                  <div key={agent.id} className="rounded-xl p-3 shadow-[inset_0_0_0_1px_var(--line)]">
                    <div className="flex items-center gap-2"><Bot className="size-3.5 text-fg-3" /><strong className="flex-1 text-[13px] font-medium">{agent.name}</strong><Badge>{agent.readOnly ? tr('只读') : tr('依项目权限执行')}</Badge></div>
                    <p className="mt-1 text-[12px] leading-[1.55] text-fg-3">{agent.description}</p>
                    {agent.limits && <AgentLimits limits={agent.limits} />}
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[12px] leading-[1.6] text-fg-4">{tr('子任务沿用父会话所选模型与额度，不自行扩展权限、安装工具或递归派生助手。实现类助手还要求父会话允许修改项目文件；停止父任务会取消子任务。')}</p>
            </>
          ) : null}
          {catalog.builtinPlugins?.length ? (
            <>
              <p className="mb-2 mt-4 text-[12px] font-medium text-fg-2">{tr('内置能力组合')}</p>
              <div className="space-y-1">
                {catalog.builtinPlugins.map(plugin => (
                  <div key={plugin.id} className="flex items-baseline gap-3 text-[12.5px]"><strong className="w-36 shrink-0 font-medium text-fg-2">{plugin.name}</strong><span className="min-w-0 truncate text-[11.5px] text-fg-4">{plugin.capabilities.join(' · ')}</span></div>
                ))}
              </div>
            </>
          ) : null}
        </Disclosure>
      ) : null}

      <div className="space-y-6">
        {sections.filter(s => filter === 'all' || filter === s.kind).map(({ kind, rows, ids }) => {
          const Icon = KIND_ICONS[kind]
          return (
            <section key={kind}>
              <h3 className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-fg-2"><Icon className="size-3.5 text-fg-4" />{KIND_NAMES[kind]}<span className="font-normal text-fg-4">· {rows.length}</span></h3>
              {rows.length ? (
                <div className="grid gap-2 lg:grid-cols-2">
                  {rows.map(manifest => (
                    <CapabilityCard key={`${kind}:${manifest.id}`} kind={kind} manifest={manifest} active={ids.includes(manifest.id)} catalog={catalog} busy={busy}
                      onAssign={() => onChange('assign', { [ASSIGN_FIELD[kind]]: [manifest.id], activate: true, ...(kind === 'mcpServers' && !manifest.enabled ? { toolPermission: 'exec' } : {}), reason: tr('在项目能力面板选择') })}
                      onDetach={() => onChange('remove', { kind, id: manifest.id })}
                      onUnregister={() => setUnregister({ kind, manifest })} />
                  ))}
                </div>
              ) : <p className="rounded-xl px-4 py-3 text-[12.5px] text-fg-4 shadow-[inset_0_0_0_1px_var(--line-faint)]">{tr('还没有接入此类能力。')}</p>}
            </section>
          )
        })}
      </div>
      <UnregisterDialog target={unregister} projectId={projectId} onClose={() => setUnregister(null)} onDone={onReload} />
    </>
  )
}

function CapabilityCard({ kind, manifest, active, catalog, busy, onAssign, onDetach, onUnregister }: { kind: CapabilityKind; manifest: CapabilityManifest; active: boolean; catalog: CapabilityCatalog; busy: boolean; onAssign: () => void; onDetach: () => void; onUnregister: () => void }) {
  const install = catalog.installations?.find(row => row.status === 'installed' && row.entries.some(entry => entry.kind === kind && entry.id === manifest.id))
  const npm = install?.sources.find(s => s.type === 'npm'), git = install?.sources.find(s => s.type === 'git')
  const grantLabel = kind === 'tools' && ['write', 'exec'].includes(manifest.permission ?? '') ? tr('授予{v}权限', { v: PERMISSIONS[manifest.permission!] }) : manifest.enabled ? tr('用于此项目') : kind === 'mcpServers' ? tr('启用并授权') : tr('启用到项目')
  return (
    <article className={cn('flex flex-col rounded-xl p-3.5 transition-shadow', active ? 'bg-accent-softer shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_22%,transparent)]' : 'shadow-[inset_0_0_0_1px_var(--line)]')} data-capability-id={manifest.id}>
      <div className="flex items-start gap-2">
        <strong className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg" title={manifest.id}>{manifest.name || manifest.id}</strong>
        <Badge tone={active ? 'accent' : manifest.enabled ? 'default' : 'warning'}>{active ? tr('用于此项目') : manifest.enabled ? tr('可用') : tr('未启用')}</Badge>
      </div>
      <p className="mt-1 line-clamp-2 text-[12px] leading-[1.55] text-fg-3">{manifest.description || KIND_NAMES[kind]}</p>
      {kind === 'mcpServers' && (
        <Disclosure summary={tr('{v} · {v2} 个已发现工具', { v: manifest.transport === 'http' ? tr('远端连接') : tr('本地进程'), v2: manifest.discoveredTools?.length ?? 0 })}>
          {manifest.discoveredTools?.length ? manifest.discoveredTools.map(tool => (
            <div key={tool.name} className="flex justify-between text-[12px]"><span className="font-mono text-fg-2">{tool.name}</span><span className="text-fg-4">{tool.granted ? tr('{v}权限', { v: PERMISSIONS[tool.permission ?? ''] || tr('执行') }) : tr('未授权')}</span></div>
          )) : <p className="text-[12px] text-fg-4">{tr('显式启用后发现工具；仅安装不会启动服务。')}</p>}
        </Disclosure>
      )}
      <div className="mt-auto space-y-0.5 pt-2 text-[11.5px] text-fg-4">
        {npm ? <p>{npm.name} · {npm.version}</p> : git ? <p>Git · {git.commit?.slice(0, 10)}</p> : null}
        {kind === 'tools' && <p>{tr('{v}{v2}权限{v3}', { v: manifest.builtin ? tr('内置 · ') : '', v2: PERMISSIONS[manifest.permission ?? ''] || tr('执行'), v3: manifest.permission === 'exec' ? tr(' · 允许在主机执行，非沙箱环境') : '' })}</p>}
        {kind === 'mcpServers' && !manifest.enabled && <p>{tr('启用并授权将允许发现的工具执行操作。')}</p>}
      </div>
      <div className="mt-2 flex items-center gap-1">
        {manifest.generated ? <span className="text-[11.5px] text-fg-4">{tr('项目版本生成 · 在项目版本中编辑')}</span> : (
          <>
            {active ? <Button size="sm" variant="ghost" disabled={busy} onClick={onDetach}>{tr('移出项目')}</Button> : <Button size="sm" variant="accent-soft" disabled={busy} onClick={onAssign}>{grantLabel}</Button>}
            {!manifest.builtin && <Button size="sm" variant="ghost" className="text-danger hover:text-danger" disabled={busy} onClick={onUnregister}>{tr('注销')}</Button>}
          </>
        )}
      </div>
    </article>
  )
}

function UnregisterDialog({ target, projectId, onClose, onDone }: { target: { kind: CapabilityKind; manifest: CapabilityManifest } | null; projectId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setError(null) }, [target])
  const commit = async () => {
    if (!target) return
    setBusy(true); setError(null)
    try { await panelsApi.removeCapability(projectId, { kind: target.kind, id: target.manifest.id, uninstall: true }); onClose(); await onDone(); toast(tr('能力已注销')) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog
      open={target !== null}
      onOpenChange={open => { if (!open && !busy) onClose() }}
      title={tr('注销「{v}」？', { v: target?.manifest.name || target?.manifest.id })}
      description={tr('此操作将从可用目录移除能力。其他项目仍在使用时无法注销；在途调用与已安装文件会保留。')}
      footer={<><Button variant="ghost" autoFocus disabled={busy} onClick={onClose}>{tr('取消')}</Button><Button variant="danger" disabled={busy} onClick={() => void commit()}>{tr('注销能力')}</Button></>}
    >
      {error && <p className="text-[12.5px] text-danger" role="alert">{error}</p>}
    </Dialog>
  )
}

/* --------------------------------------------------------------- install */

function InstallForm({ projectId, draft, setDraft, note, busy, setBusy, onInstalled }: { projectId: string; draft: InstallDraft; setDraft: (d: InstallDraft) => void; note: string | null; busy: boolean; setBusy: (b: boolean) => void; onInstalled: () => Promise<void> }) {
  const [requestId, setRequestId] = useState<string | null>(null)
  const [preview, setPreview] = useState<CapabilityInspectResult | null>(null)
  const [result, setResult] = useState<{ text: string; tone: 'default' | 'success' | 'danger' } | null>(note ? { text: note, tone: 'default' } : null)
  useEffect(() => { if (note) setResult({ text: note, tone: 'default' }) }, [note])
  const set = (patch: Partial<InstallDraft>) => { setDraft({ ...draft, ...patch }); setRequestId(null); setPreview(null) }

  const run = async (install: boolean, form: HTMLFormElement | null) => {
    if (busy || (form && !form.reportValidity())) return
    let payload
    try { payload = installInput(draft) } catch (e) { setResult({ text: (e as Error).message, tone: 'danger' }); return }
    setBusy(true); setResult({ text: install ? tr('正在安装并校验…') : tr('正在检查来源…'), tone: 'default' })
    try {
      if (install) {
        const id = requestId ?? crypto.randomUUID()
        setRequestId(id)
        const response = await panelsApi.installCapability(projectId, { ...payload, requestId: id })
        setResult({ text: response.activated ? tr('安装完成，已用于当前项目。下一模型步骤可使用新能力。') : tr('安装完成，可在目录中按需启用。'), tone: 'success' })
        setRequestId(null)
        await onInstalled(); toast(tr('能力已安装'))
      } else {
        setPreview(await panelsApi.inspectCapability(projectId, payload))
        setResult({ text: tr('来源已检查，可继续安装。'), tone: 'success' })
      }
    } catch (e) { setResult({ text: (e as Error).message || tr('操作失败，可以修改配置后重试。'), tone: 'danger' }) } finally { setBusy(false) }
  }
  const onSubmit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void run(true, e.currentTarget) }
  const s = draft.source
  const field = (label: ReactNode, control: ReactNode, help?: ReactNode) => <Field label={label} help={help}>{control}</Field>

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-2xl space-y-4">
      <FieldRow>
        {field(tr('来源'), <Select<InstallSource> aria-label={tr('来源')} value={s} onChange={v => set({ source: v })} options={(Object.keys(SOURCE_LABELS) as InstallSource[]).map(k => ({ value: k, label: SOURCE_LABELS[k] }))} />)}
        {s !== 'mcp-json' && field(tr('显示名称（可选）'), <TextInput value={draft.name} placeholder={tr('使用来源中的名称')} onChange={e => set({ name: e.target.value })} />)}
      </FieldRow>
      {s === 'local-skill' && field(tr('包含 SKILL.md 的目录'), <TextInput required value={draft.localPath} placeholder="/Users/you/skills/my-skill" onChange={e => set({ localPath: e.target.value })} />)}
      {s === 'git-skill' && (
        <>
          {field(tr('仓库地址'), <TextInput required value={draft.repository} placeholder="https://github.com/owner/repository.git" onChange={e => set({ repository: e.target.value })} />)}
          <FieldRow>
            {field(tr('技能所在子目录'), <TextInput value={draft.subdirectory} placeholder={tr('例如 skills/research')} onChange={e => set({ subdirectory: e.target.value })} />, tr('目录中应包含 SKILL.md 及其附带资源。'))}
            {field(tr('分支、标签或提交（可选）'), <TextInput value={draft.ref} placeholder={tr('默认分支')} onChange={e => set({ ref: e.target.value })} />)}
          </FieldRow>
        </>
      )}
      {s === 'npm-mcp' && (
        <>
          {field(tr('npm 包'), <TextInput required value={draft.packageName} placeholder={tr('@scope/mcp-server 或 package@version')} onChange={e => set({ packageName: e.target.value })} />, tr('安装时固定解析出的版本，不在每次对话中重新下载。'))}
          <FieldRow>
            {field(tr('启动入口（可选）'), <TextInput value={draft.bin} placeholder={tr('多个入口时填写')} onChange={e => set({ bin: e.target.value })} />)}
            {field(tr('启动参数（可选）'), <TextArea rows={3} value={draft.args} placeholder={tr('每行一个启动参数')} onChange={e => set({ args: e.target.value })} />)}
          </FieldRow>
        </>
      )}
      {s === 'browser-preset' && field(tr('浏览器路径（可选）'), <TextInput value={draft.browserExecutable} placeholder={tr('自动查找已安装的 Chrome / Chromium')} onChange={e => set({ browserExecutable: e.target.value })} />, tr('使用独立无头浏览器，不连接个人标签页或登录资料。无需 API 密钥；安装时会实际启动并验证快照和截图。'))}
      {s === 'mcp-json' && field(tr('mcpServers 配置'), <TextArea rows={7} required spellCheck={false} className="font-mono text-[12px]" value={draft.json} placeholder='{ "mcpServers": { "service": { "command": "npx", "args": ["-y", "package"] } } }' onChange={e => set({ json: e.target.value })} />, tr('支持 stdio 与 Streamable HTTP。凭据使用 ${ENV_NAME} 引用，不粘贴明文密钥。'))}
      <label className="flex items-center gap-3 rounded-xl px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)]">
        <span className="flex-1 text-[13px] font-medium text-fg">{tr('安装后在当前项目启用')}</span>
        <Switch checked={draft.activate} onChange={v => set({ activate: v })} label={tr('安装后在当前项目启用')} />
      </label>
      <Note tone={['npm-mcp', 'mcp-json', 'browser-preset'].includes(s) && draft.activate ? 'warning' : 'default'}>{permissionNote(draft)}</Note>
      {preview && (
        <div className="rounded-xl bg-subtle p-4 text-[12.5px] leading-[1.6] text-fg-2">
          <strong className="mb-1 block">{tr('来源检查结果')}</strong>
          {(preview.servers?.map(row => `${row.id} · ${row.package || (row.transport === 'http' ? tr('远端服务') : tr('本地进程'))}`) ?? [preview.name ? `${preview.name}${preview.version ? ` · ${preview.version}` : ''}` : preview.repository || tr('本地能力')]).map(line => <p key={line}>{line}</p>)}
          {preview.description && <p className="text-fg-3">{preview.description}</p>}
          <p className="mt-1 text-[12px] text-fg-4">{preview.source === 'git' ? tr('已检查来源格式；仓库内容会在安装时下载并校验。') : tr('尚未启动 MCP，也没有授予项目工具。')}</p>
          {preview.scripts?.length ? <p className="text-[12px] text-warning">{tr('此包声明了安装脚本。默认跳过；依赖这些脚本的服务可能无法启动。')}</p> : null}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span role="status" className={cn('min-w-0 flex-1 text-[12px]', result?.tone === 'danger' ? 'text-danger' : result?.tone === 'success' ? 'text-success' : 'text-fg-3')}>{result?.text}</span>
        <Button variant="secondary" disabled={busy} leading={<Search className="size-3.5" />} onClick={e => void run(false, (e.currentTarget as HTMLButtonElement).form)}>{tr('检查来源')}</Button>
        <Button variant="primary" type="submit" disabled={busy}>{draft.activate ? tr('安装并启用') : tr('仅安装')}</Button>
      </div>
    </form>
  )
}
