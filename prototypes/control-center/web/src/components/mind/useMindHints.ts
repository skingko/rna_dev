/**
 * Sidebar “needs you” hints across projects. Loads the mind only for projects
 * whose summary counts report overdue commitments (daemons
 * without the mind counts never trigger a read).
 */
import { useEffect, useMemo } from 'react'
import type { ProjectMind } from '@/api/mind-api'
import { mindHints, type MindHint } from '@/lib/mind'
import { useApp } from '@/store/app-store'
import { ensureMind, useMind } from '@/store/mind-store'

export function useMindHints(): MindHint[] {
  const projects = useApp(s => s.projects)
  const wanted = useMemo(() => Object.values(projects)
    .filter(p => !p.archivedAt && (p.counts?.overdueCommitments ?? 0) > 0)
    .map(p => p.id).sort().join('|'), [projects])
  useEffect(() => { for (const id of wanted.split('|').filter(Boolean)) void ensureMind(id) }, [wanted])
  const minds = useMind(s => s.projects)
  return useMemo(() => {
    const ids = wanted.split('|').filter(Boolean)
    const loaded: Record<string, ProjectMind | null> = {}
    const names: Record<string, string> = {}
    for (const id of ids) {
      const slot = minds[id]
      loaded[id] = slot && slot !== 'unsupported' ? slot : null
      names[id] = projects[id]?.name ?? ''
    }
    return mindHints(loaded, names)
  }, [wanted, minds, projects])
}
