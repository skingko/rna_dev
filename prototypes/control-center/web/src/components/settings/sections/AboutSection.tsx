/** 关于: versions and the only remaining entry to the legacy interface. */
import { useEffect, useState } from 'react'
import { panelsApi } from '@/api/panels'
import type { Health } from '@/api/panels-types'
import { useApp } from '@/store/app-store'
import { BrandMark } from '@/components/shell/Sidebar'
import { Group, SettingsSection, ValueRow } from '../form'
import type { SectionProps } from '../SettingsDialog'
import { t } from '@/i18n'

export default function AboutSection(_: SectionProps) {
  void _
  const mode = useApp(s => s.mode)
  const [health, setHealth] = useState<Health | null>(null)
  useEffect(() => { void panelsApi.health().then(setHealth).catch(() => {}) }, [])
  return (
    <>
      <div className="mb-8 flex items-center gap-4">
        <BrandMark size={48} />
        <div>
          <h3 className="text-[18px] font-semibold tracking-[-0.01em]">Rna Agent</h3>
          <p className="text-[12.5px] text-fg-3">{t('持续对话 · 项目记忆 · 主动协作')}</p>
        </div>
      </div>
      <SettingsSection title={t('版本')}>
        <Group>
          <ValueRow label={t('应用')} value={health?.version ?? '—'} />
          <ValueRow label="Rna SDK" value={health?.sdkVersion ?? '—'} />
          <ValueRow label="Node" value={health?.node ?? '—'} />
          <ValueRow label={t('读取接口')} value={mode === 'v2' ? t('增量协议 v2') : mode === 'legacy' ? t('兼容模式') : '—'} />
        </Group>
      </SettingsSection>
    </>
  )
}
