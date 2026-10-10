/**
 * Project detail reads for the workspace views. The index stream keeps the
 * project summary current; when its change signature moves we refetch only the
 * heavy fields the view asked for (debounced), and keep the last result cached
 * per project + include set so switching tabs is instant.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { projectApi, type ProjectDetail, type ProjectInclude } from '@/api/project-api'
import { useApp } from '@/store/app-store'

const cache = new Map<string, ProjectDetail>()

function signatureOf(p: Record<string, unknown> | undefined): string {
  if (!p) return ''
  return JSON.stringify([p.updatedAt, p.counts, p.activeVersion, p.trialVersionId, p.activeVersionId, p.schedules, p.scheduleRuntime, p.initiativeRuntime, p.observationSources, p.rhythmStatus, p.evolution, p.initiative])
}

export function useProjectDetail(projectId: string | null | undefined, include: ProjectInclude[]) {
  const key = `${projectId}:${include.join(',')}`
  const summary = useApp(s => (projectId ? s.projects[projectId] : undefined))
  const signature = signatureOf(summary as unknown as Record<string, unknown>)
  const [data, setData] = useState<ProjectDetail | null>(() => cache.get(key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const epoch = useRef(0)

  const load = useCallback(async () => {
    if (!projectId) return
    const mine = ++epoch.current
    setLoading(true)
    try {
      const next = await projectApi.detail(projectId, include)
      if (mine !== epoch.current) return
      cache.set(key, next)
      setData(next)
      setError(null)
    } catch (e) {
      if (mine === epoch.current) setError((e as Error).message)
    } finally {
      if (mine === epoch.current) setLoading(false)
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setData(cache.get(key) ?? null); setError(null); void load() }, [key, load])

  // Index updates: refetch at most every ~1.2s while the project keeps changing.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const t = setTimeout(() => void load(), 1200)
    return () => clearTimeout(t)
  }, [signature, load])

  // Merge the live summary (schedules, rhythm, runtime state) over the cached heavy detail.
  const merged = useMemo(() => (data && summary ? ({ ...data, ...summary, ...pickHeavy(data) } as ProjectDetail) : data), [data, summary])
  return { project: merged, error, loading, reload: load }
}

function pickHeavy(detail: ProjectDetail): Partial<ProjectDetail> {
  const out: Partial<ProjectDetail> = {}
  // The index row carries schedules without their task text and only the latest runs (protocol 3); the detail has all.
  for (const k of ['versions', 'jobs', 'decisions', 'observations', 'learningRuntime', 'facts', 'memorySessions', 'schedules', 'scheduleRuntime'] as const) {
    if (detail[k] !== undefined) (out as Record<string, unknown>)[k] = detail[k]
  }
  if (detail.initiativeRuntime && (detail.initiativeRuntime as { sdkState?: unknown }).sdkState) out.initiativeRuntime = detail.initiativeRuntime
  return out
}

export function invalidateProject(projectId: string) {
  for (const key of cache.keys()) if (key.startsWith(`${projectId}:`)) cache.delete(key)
}
