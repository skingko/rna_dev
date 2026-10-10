/**
 * 技能市场: public SKILL catalogs. Reading shows pinned-commit source as text
 * and never executes anything; "查看安装选项" only prefills the installer.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ExternalLink, FileText, GitCommitHorizontal, Scale, Search } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import type { MarketplaceProvider, MarketplaceRead, MarketplaceResult } from '@/api/panels-types'
import { Button, Skeleton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { Disclosure, Empty, Note, Select } from '@/components/settings/form'
import { t } from '@/i18n'

const https = (value?: string) => { try { const url = new URL(value ?? ''); return url.protocol === 'https:' ? url.href : null } catch { return null } }

export function Marketplace({ projectId, onSelect }: { projectId: string; onSelect: (value: MarketplaceRead) => void }) {
  const [providers, setProviders] = useState<MarketplaceProvider[] | null>(null)
  const [provider, setProvider] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: t('正在读取市场来源…') })
  const [results, setResults] = useState<MarketplaceResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [reading, setReading] = useState<{ item: MarketplaceResult; path?: string; value?: MarketplaceRead; error?: string } | null>(null)
  const [root, setRoot] = useState<MarketplaceRead | null>(null)
  const lifetime = useRef(new AbortController())
  const searchRev = useRef(0), readRev = useRef(0)
  const signal = () => AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(20000)])

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    panelsApi.marketplaces(controller.signal).then(value => {
      const list = value.providers ?? []
      setProviders(list); setProvider(list[0]?.id ?? '')
      setStatus({ text: list.length ? t('输入关键词搜索。未配置密钥也可尝试公开或匿名搜索。') : t('当前没有可用的技能市场来源。') })
    }).catch(error => { if (!controller.signal.aborted) setStatus({ text: t('{message} 可稍后重新打开重试。', { message: (error as Error).message }), error: true }) })
    return () => controller.abort()
  }, [])

  const search = async (e: FormEvent) => {
    e.preventDefault()
    if (query.trim().length < 2) return
    const rev = ++searchRev.current; readRev.current++
    setReading(null); setRoot(null); setResults(null); setSearching(true); setStatus({ text: t('正在搜索公开技能…') })
    try {
      const response = await panelsApi.marketplaceSearch({ provider, query: query.trim(), limit: 10, projectId }, signal())
      if (rev !== searchRev.current) return
      const entries = response.results ?? []
      setResults(entries)
      setStatus({ text: entries.length ? t('找到 {length} 项；当前最多展示 10 项。排名与热度不代表代码质量或安全评估。', { length: entries.length }) : t('没有找到匹配技能。可调整关键词或切换市场。') })
    } catch (error) {
      if (rev === searchRev.current) setStatus({ text: t('搜索未完成：{message} 可以重试或切换市场；无需先填写密钥才能浏览公开来源。', { message: (error as Error).message }), error: true })
    } finally { if (rev === searchRev.current) setSearching(false) }
  }

  const read = async (item: MarketplaceResult, path?: string) => {
    const rev = ++readRev.current, sRev = searchRev.current
    setReading({ item, path })
    try {
      const value = await panelsApi.marketplaceRead({ provider: item.provider, id: item.id, ...(path ? { path } : {}), projectId }, signal())
      if (rev !== readRev.current || sRev !== searchRev.current) return
      if (!/^[a-f0-9]{40}$/i.test(value.commit) || value.installInput?.kind !== 'skill' || value.installInput?.source?.type !== 'git' || value.installInput.source.ref !== value.commit) throw new Error(t('来源未固定到可校验的提交，不能进入安装。'))
      if (path && root && root.commit !== value.commit) throw new Error(t('来源版本已变化，请重新阅读技能。'))
      if (!path) setRoot(value)
      setReading({ item, path, value })
    } catch (error) {
      if (rev === readRev.current) setReading({ item, path, error: (error as Error).message })
    }
  }

  const source = providers?.find(p => p.id === provider)
  const base = root ?? reading?.value

  return (
    <div className="grid min-h-[420px] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="min-w-0">
        <p className="mb-3 text-[12.5px] leading-[1.6] text-fg-3">{t('搜索公开 SKILL 技能，先阅读固定版本的说明、资源与许可证，再选择安装。市场内容是外部资料，不会自动执行；这不是通用插件或 MCP 宿主。')}</p>
        <form onSubmit={search} className="flex gap-2">
          {providers && providers.length > 1 && (
            <Select aria-label={t('技能市场')} value={provider} onChange={v => { searchRev.current++; readRev.current++; setProvider(v); setResults(null); setReading(null); setRoot(null); setStatus({ text: t('已切换市场，输入关键词重新搜索。') }) }} className="w-32 shrink-0" options={providers.map(p => ({ value: p.id, label: p.name }))} />
          )}
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-base px-3 shadow-[inset_0_0_0_1px_var(--line-strong)] focus-within:shadow-[inset_0_0_0_1.5px_var(--accent)]">
            <Search className="size-3.5 shrink-0 text-fg-4" />
            <input value={query} onChange={e => setQuery(e.target.value)} required minLength={2} maxLength={160} placeholder={t('搜索技能，例如 frontend、research')} aria-label={t('搜索公开技能')} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4" />
          </label>
          <Button type="submit" variant="primary" className="h-9" disabled={!providers?.length || searching}>{t('搜索')}</Button>
        </form>
        {source && (
          <p className="mt-2 flex items-center gap-1 text-[11.5px] text-fg-4">
            {source.authentication === 'configured' ? t('已配置访问凭据') : source.authentication === 'anonymous_limited' ? t('匿名搜索 · 可能受服务限流') : t('公开搜索 · 无需密钥')}
            {https(source.docsUrl) && <> · <a href={https(source.docsUrl)!} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-accent-text hover:underline">{t('市场说明')}<ExternalLink className="size-3" /></a></>}
          </p>
        )}
        <p role="status" className={cn('mt-3 text-[12px]', status.error ? 'text-danger' : 'text-fg-4')}>{status.text}</p>
        <div className="mt-2 space-y-1.5">
          {searching && [0, 1, 2].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
          {results?.map(item => (
            <button key={`${item.provider}:${item.id}`} type="button" onClick={() => void read(item)} className={cn('block w-full rounded-xl p-3 text-left transition-[background-color,box-shadow]', reading?.item.id === item.id ? 'bg-accent-softer shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_35%,transparent)]' : 'shadow-[inset_0_0_0_1px_var(--line)] hover:bg-hover')}>
              <strong className="block truncate text-[13px] font-medium text-fg">{item.name}</strong>
              <span className="mt-0.5 line-clamp-2 block text-[12px] leading-[1.55] text-fg-3">{item.description || t('此来源没有摘要。')}</span>
              <span className="mt-1 block truncate text-[11px] text-fg-4">{t('{repository} · 未审查的公开来源', { repository: item.repository })}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-w-0">
        <AnimatePresence mode="wait">
          {!reading ? (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Empty>{t('选择一项技能，阅读固定提交的说明、资源与许可证。')}</Empty>
            </motion.div>
          ) : (
            <motion.section key={`${reading.item.id}:${reading.path ?? ''}`} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="rounded-2xl p-4 shadow-[0_0_0_1px_var(--line)]">
              {reading.error ? (
                <Note tone="danger" action={<Button size="sm" onClick={() => void read(reading.item, reading.path)}>{t('重新读取')}</Button>}>{t('读取未完成：{error}', { error: reading.error })}</Note>
              ) : !reading.value ? (
                <div className="space-y-2"><p className="text-[12px] text-fg-4">{t('正在读取固定提交的源文件…')}</p><Skeleton className="h-4 w-2/3" /><Skeleton className="h-40 w-full rounded-lg" /></div>
              ) : (
                <>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-[14px] font-semibold text-fg">{reading.item.name} · {reading.value.path}</h3>
                      <p className="truncate text-[11.5px] text-fg-4">{reading.value.repository} · {reading.value.subdirectory || '.'}</p>
                    </div>
                    {reading.value.path !== 'SKILL.md' && <Button size="sm" variant="ghost" leading={<ArrowLeft className="size-3.5" />} onClick={() => void read(reading.item)}>{t('技能说明')}</Button>}
                  </div>
                  <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-fg-3"><GitCommitHorizontal className="size-3.5" />{t('固定提交 {commit}', { commit: reading.value.commit })}</p>
                  <p className="font-mono text-[10.5px] text-fg-4">SHA-256 {reading.value.contentHash} · {reading.value.bytes} B</p>
                  <pre tabIndex={0} aria-label={t('外部技能源文件')} className="mt-3 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-3 font-mono text-[11.5px] leading-[1.65] text-fg-2">{reading.value.content}</pre>
                  <p className="mt-3 text-[12px] leading-[1.6] text-fg-3">{base?.licenseFiles?.length ? t('发布或再分发前请核对以下许可证；有文件不代表已审查授权条件。') : t('未发现独立许可证文件。不要将其视为允许再分发；请自行核对来源的授权条件。')}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {base?.licenseFiles?.map(license => <Button key={license.path} size="sm" variant="ghost" leading={<Scale className="size-3.5" />} onClick={() => void read(reading.item, license.resourcePath)}>{t('许可证 · {path}', { path: license.path })}</Button>)}
                    {https(reading.item.sourceUrl) && <a className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] text-fg-3 hover:bg-hover hover:text-fg" href={https(reading.item.sourceUrl)!} target="_blank" rel="noopener noreferrer">{t('来源仓库')}<ExternalLink className="size-3" /></a>}
                    {https(reading.item.catalogUrl) && <a className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] text-fg-3 hover:bg-hover hover:text-fg" href={https(reading.item.catalogUrl)!} target="_blank" rel="noopener noreferrer">{t('市场页面')}<ExternalLink className="size-3" /></a>}
                  </div>
                  {base?.resources?.length ? (
                    <Disclosure summary={t('附带资源 · {length}', { length: base.resources.length })} className="mt-1">
                      <div className="flex flex-col items-start">
                        {base.resources.map(resource => <button key={resource.path} type="button" onClick={() => void read(reading.item, resource.path)} className="flex items-center gap-1.5 rounded px-1 py-0.5 font-mono text-[11.5px] text-fg-3 hover:bg-hover hover:text-fg"><FileText className="size-3" />{resource.path} · {resource.bytes} B</button>)}
                      </div>
                    </Disclosure>
                  ) : null}
                  <div className="mt-4 flex items-center gap-3 border-t border-line-faint pt-3">
                    <Button variant="primary" disabled={!base} onClick={() => base && onSelect(base)}>{t('查看安装选项')}</Button>
                    <span className="text-[11.5px] leading-[1.5] text-fg-4">{t('只填写已固定提交的安装表单；不会在此自动安装、启用或运行脚本。')}</span>
                  </div>
                </>
              )}
            </motion.section>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
