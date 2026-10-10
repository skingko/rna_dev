/**
 * 浏览器 · Rna: the page the agent is driving, live (zcode shows its agent
 * using the in-app browser in the side panel). Frames come from the
 * conversation's own isolated browser over GET /api/sessions/:id/browser-view;
 * the view is to watch — the agent keeps control. The address can be opened
 * in a normal browser tab to look around by hand.
 */
import { useEffect, useState } from 'react'
import { ExternalLink, Globe, MonitorPlay } from 'lucide-react'
import { getTransport } from '@/api/client'
import type { SideTabData } from '@/store/side-panel-store'
import { openBrowserTab } from './open'
import { useStreamWhileVisible } from '@/components/workspace/visibility'
import { browserVerb } from '@/lib/tools'
import { IconButton } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

type Tab = Extract<SideTabData, { type: 'agent-browser' }>
interface ViewState { live: boolean; attached: boolean; url: string; title: string; action: { name: string; detail?: string } | null }
interface Frame { data: string; mime?: string; width?: number | null; height?: number | null; url?: string; at: number }

/** `browser_click` (as the host calls it) or `mcp__<server>__browser_click` → `click`. */
const actionOf = (name: string) => /(?:^|__)browser_([a-z_]+)$/.exec(name)?.[1] ?? name

export function AgentBrowserTab({ tab, active = true }: { tab: Tab; active?: boolean }) {
  const t = useT()
  const [state, setState] = useState<ViewState>({ live: false, attached: false, url: '', title: '', action: null })
  const [frame, setFrame] = useState<Frame | null>(null)
  // Connection budget (design 1.8): hidden for 30 s, the view stops streaming; shown again, it picks up the current page.
  const streaming = useStreamWhileVisible(active)
  useEffect(() => { setFrame(null) }, [tab.sessionId])
  useEffect(() => {
    if (!streaming) return
    const source = getTransport().openStream(`/api/sessions/${encodeURIComponent(tab.sessionId)}/browser-view`)
    source.addEventListener('state', event => { try { setState(JSON.parse(event.data)) } catch { /* ignore */ } })
    source.addEventListener('frame', event => { try { setFrame(JSON.parse(event.data)) } catch { /* ignore */ } })
    return () => source.close()
  }, [tab.sessionId, streaming])
  const url = state.url || frame?.url || ''
  const web = /^https?:\/\//.test(url)
  const status = state.action ? `${browserVerb(actionOf(state.action.name))}${state.action.detail ? ` ${state.action.detail}` : ''}`
    : state.live ? t('等待下一步') : frame ? t('浏览器已关闭，显示的是最后的画面') : t('还没有打开浏览器')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-faint px-3 text-[12.5px]">
        <span className={cn('relative inline-flex size-1.5 shrink-0 rounded-full', state.action ? 'bg-accent' : state.live ? 'bg-success' : 'bg-idle')} aria-hidden>
          {state.action && <span className="absolute inset-0 rounded-full bg-accent dot-ring" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-fg-2" aria-live="polite">{status}</span>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-faint px-3 text-[12.5px]">
        <Globe className="size-3.5 shrink-0 text-fg-4" />
        <span className="min-w-0 flex-1 truncate text-fg-3" title={url}>{state.title ? `${state.title} · ` : ''}{url || t('空白页')}</span>
        {web && <IconButton label={t('在浏览器标签页中打开')} size="sm" onClick={() => openBrowserTab(url)}><ExternalLink /></IconButton>}
      </div>
      <div className="grid min-h-0 flex-1 place-items-center overflow-hidden bg-inset p-2">
        {frame
          ? <img src={`data:${frame.mime ?? 'image/jpeg'};base64,${frame.data}`} alt={t('Rna 正在使用的页面')} className="max-h-full max-w-full rounded-md object-contain shadow-[0_0_0_1px_var(--line-faint)]" draggable={false} />
          : <div className="flex max-w-[260px] flex-col items-center gap-2 text-center text-[13px] text-fg-4"><MonitorPlay className="size-6" strokeWidth={1.5} />{t('Rna 用浏览器测试页面时，这里会实时显示它看到的画面。')}</div>}
      </div>
    </div>
  )
}
