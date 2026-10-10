/**
 * 应用更新: the running version and where updates come from. Versions are not
 * switched or rolled back by hand; once the GitHub repository is public, new
 * releases are checked and installed automatically when the app is idle.
 */
import { useEffect, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { panelsApi } from '@/api/panels'
import type { Health } from '@/api/panels-types'
import { Button } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { Group, Note, SettingsSection, ValueRow, formatDateTime } from '../form'
import type { SectionProps } from '../SettingsDialog'
import { t } from '@/i18n'

interface UpdateCheck { status: 'available' | 'current' | 'source_unavailable' | 'unreachable'; current?: string; latest?: string | null; source: string; checkedAt: string; releaseUrl?: string }

export default function UpdatesSection(_: SectionProps) {
  void _
  const [health, setHealth] = useState<Health | null>(null)
  const [check, setCheck] = useState<UpdateCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try { setCheck(await panelsApi.updateCheck()) } catch { setCheck({ status: 'unreachable', source: 'https://github.com/skingko/rna_dev/releases', checkedAt: new Date().toISOString() }) } finally { setBusy(false) }
  }
  useEffect(() => { void panelsApi.health().then(setHealth).catch(() => {}); void run() }, [])
  const note = !check ? t('正在检查更新…')
    : check.status === 'available' ? t('发现新版本 {v}，会在应用空闲时自动安装。', { v: check.latest ?? '' })
      : check.status === 'current' ? t('已是最新版本。')
        : check.status === 'source_unavailable' ? t('更新源（GitHub 仓库）尚未公开，暂时无法自动更新；公开后会自动开始检查。')
          : t('暂时无法连接更新源，稍后会再次检查。')
  return (
    <>
      <SettingsSection title={t('当前版本')}>
        <Group>
          <ValueRow label={t('应用')} value={health?.version ?? '—'} />
          <ValueRow label="Rna SDK" value={health?.sdkVersion ?? '—'} />
        </Group>
      </SettingsSection>
      <SettingsSection title={t('自动更新')} description={t('新版本从 GitHub 正式发布中获取，在没有进行中的工作时自动安装并完成核对；不提供手动切换或回退版本。')}>
        <Note tone={check?.status === 'available' ? 'success' : 'default'}>{note}</Note>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={busy} leading={<RefreshCw className={cn('size-3.5', busy && 'spin')} />} onClick={() => void run()}>{t('检查更新')}</Button>
          <a href={check?.releaseUrl ?? check?.source ?? 'https://github.com/skingko/rna_dev/releases'} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] text-fg-3 hover:bg-hover hover:text-fg">{t('发布记录')}<ExternalLink className="size-3" /></a>
          {check && <span className="text-[12px] text-fg-4">{t('上次检查 {v}', { v: formatDateTime(check.checkedAt) })}</span>}
        </div>
      </SettingsSection>
    </>
  )
}
