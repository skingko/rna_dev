/**
 * 任务类型 (P4): the unit of evolution and of baseline-skill search. 1–4
 * types, or automatic inference from the project title / description
 * (`PATCH …/task-types { taskTypes: null }`). Hidden on daemons without it.
 */
import { useEffect, useState } from 'react'
import { evolutionApi, type TaskType, type TaskTypesView } from '@/api/evolution-api'
import { TASK_TYPES } from '@/lib/evolution'
import { toast } from '@/store/ui-store'
import { Button } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import { Badge, Note, SettingsSection } from '../form'
import { useRegistered, type SectionProps } from '../SettingsDialog'
import { t as tr } from '@/i18n'

export function TaskTypesSection({ projectId, registerBusy, registerDirty }: { projectId: string } & Pick<SectionProps, 'registerBusy' | 'registerDirty'>) {
  const [view, setView] = useState<TaskTypesView | null | 'unsupported'>(null)
  const [draft, setDraft] = useState<TaskType[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    evolutionApi.taskTypes(projectId).then(v => { if (!live) return; setView(v ?? 'unsupported'); setDraft(v?.taskTypes ?? []) }).catch(e => live && setError((e as Error).message))
    return () => { live = false }
  }, [projectId])
  const dirty = view !== null && view !== 'unsupported' && JSON.stringify([...draft].sort()) !== JSON.stringify([...view.taskTypes].sort())
  useRegistered(registerBusy, `task-types-${projectId}`, busy)
  useRegistered(registerDirty, `task-types-${projectId}`, dirty)
  if (view === 'unsupported') return null
  const vocabulary = TASK_TYPES.filter(t => !view?.vocabulary || view.vocabulary.includes(t.id))
  const toggle = (id: TaskType) => setDraft(d => (d.includes(id) ? d.filter(x => x !== id) : d.length >= 4 ? d : [...d, id]))
  const save = async (types: TaskType[] | null) => {
    setBusy(true); setError(null)
    try { const next = await evolutionApi.setTaskTypes(projectId, types); setView(next); setDraft(next.taskTypes); toast(types === null ? tr('已恢复自动推断任务类型。') : tr('已保存任务类型。')) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <SettingsSection className="mt-8" title={<span className="inline-flex items-center gap-2">{tr('任务类型')}{view && <Badge tone={view.explicit ? 'accent' : 'default'}>{view.explicit ? tr('手动指定') : tr('自动推断')}</Badge>}</span>}
      description={tr('项目的进化与基础技能检索以任务类型为单位。选择 1–4 个；不指定时根据项目名称与介绍自动推断。')}>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={tr('任务类型')}>
        {vocabulary.map(t => {
          const on = draft.includes(t.id)
          return (
            <button key={t.id} type="button" aria-pressed={on} disabled={busy || !view || (!on && draft.length >= 4)} onClick={() => toggle(t.id)}
              className={cn('h-8 rounded-lg px-3 text-[12.5px] transition-colors disabled:opacity-45', on ? 'bg-accent-soft font-medium text-accent-text shadow-[inset_0_0_0_1px_var(--accent)]' : 'bg-subtle text-fg-3 hover:text-fg')}>
              {t.label}
            </button>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={busy || !dirty || draft.length === 0} onClick={() => void save(draft)}>{tr('保存任务类型')}</Button>
        {view && view.explicit && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>{tr('恢复自动推断')}</Button>}
        {draft.length >= 4 && <span className="text-[12px] text-fg-4">{tr('最多 4 个')}</span>}
      </div>
      {error && <Note tone="danger" className="mt-2">{error}</Note>}
    </SettingsSection>
  )
}
