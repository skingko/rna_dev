import { useMemo } from 'react'
import { FolderOpen } from 'lucide-react'
import { useApp } from '@/store/app-store'
import type { ProjectDetail } from '@/api/panels-types'
import { Select } from '@/components/settings/form'
import { t } from '@/i18n'

/** Active (non-archived) projects in sidebar order. */
export function useActiveProjects() {
  const projects = useApp(s => s.projects)
  const order = useApp(s => s.projectOrder)
  return useMemo(() => order.map(id => projects[id]).filter(p => p && !p.archivedAt) as ProjectDetail[], [projects, order])
}

export function useProjectDetail(projectId: string | null | undefined) {
  return useApp(s => (projectId ? s.projects[projectId] as ProjectDetail | undefined : undefined))
}

export function ProjectPicker({ value, onChange, className }: { value: string | null; onChange: (id: string) => void; className?: string }) {
  const projects = useActiveProjects()
  if (!projects.length) return null
  return (
    <div className={className}>
      <Select
        aria-label={t('选择项目')}
        value={value && projects.some(p => p.id === value) ? value : ''}
        onChange={id => id && onChange(id)}
        placeholder={t('选择项目')}
        className="h-8 w-56 text-[12.5px]"
        options={projects.map(p => ({ value: p.id, label: <span className="inline-flex items-center gap-1.5"><FolderOpen className="size-3.5 text-fg-4" />{p.name}</span> }))}
      />
    </div>
  )
}
