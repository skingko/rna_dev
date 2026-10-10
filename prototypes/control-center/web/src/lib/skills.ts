/**
 * Human skill names. Skill ids are often generated (`gen-369075cf2a5376d7-
 * daily-research-workflow`) or prefixed (`skill-frontend-design`); the UI
 * resolves them through project capability metadata, then the loaded
 * SKILL.md front matter, and only then a humanized id — never the raw id.
 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { projectApi, type ProjectSkill } from '@/api/project-api'
export { frontMatterName, humanizeSkillId, localSkillId, skillDisplayName } from './skill-names'

interface SkillCatalogState { byProject: Record<string, ProjectSkill[] | 'loading' | 'error'>; assigned: Record<string, string[]> }
export const useSkillCatalogs = create<SkillCatalogState>(() => ({ byProject: {}, assigned: {} }))

export function loadSkillCatalog(projectId: string, force = false) {
  const current = useSkillCatalogs.getState().byProject[projectId]
  if (!force && current && current !== 'error') return
  useSkillCatalogs.setState(s => ({ byProject: { ...s.byProject, [projectId]: 'loading' } }))
  projectApi.capabilities(projectId)
    .then(result => useSkillCatalogs.setState(s => ({ byProject: { ...s.byProject, [projectId]: result.skills ?? [] }, assigned: { ...s.assigned, [projectId]: result.assignments?.skillIds ?? [] } })))
    .catch(() => useSkillCatalogs.setState(s => ({ byProject: { ...s.byProject, [projectId]: 'error' } })))
}

export function useSkillCatalog(projectId: string | null | undefined): ProjectSkill[] {
  const entry = useSkillCatalogs(s => (projectId ? s.byProject[projectId] : undefined))
  useEffect(() => { if (projectId) loadSkillCatalog(projectId) }, [projectId])
  return Array.isArray(entry) ? entry : EMPTY
}
const EMPTY: ProjectSkill[] = []


/** Skills that belong to this project (its assignments), without the built-in
 * generic ones and without other projects' skills from the shared registry. */
export function useProjectSkills(projectId: string | null | undefined): ProjectSkill[] {
  const all = useSkillCatalog(projectId)
  const assigned = useSkillCatalogs(s => (projectId ? s.assigned[projectId] : undefined))
  return useMemo(() => {
    const wanted = new Set(assigned ?? []), seen = new Set<string>()
    return all.filter(skill => wanted.has(skill.id) && !skill.builtin && !seen.has(skill.id) && Boolean(seen.add(skill.id)))
  }, [all, assigned])
}
