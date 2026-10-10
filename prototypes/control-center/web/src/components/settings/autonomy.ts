/**
 * Autonomy presentation and the project PATCH body, ported from
 * public/autonomy-frequency.js and renderAutonomy in public/settings-ui.js.
 * The rhythm projection lives in lib/display/rhythm and is re-exported here.
 */
import type { ProjectDetail } from '@/api/panels-types'
import { t, localized } from '@/i18n'

export const FREQUENCY_PRESETS = localized([
  { id: 'active', label: '积极', values: [15000, 300000, 30000, 900000] },
  { id: 'balanced', label: '均衡', values: [30000, 900000, 300000, 3600000] },
  { id: 'quiet', label: '安静', values: [300000, 3600000, 900000, 21600000] },
] as const)

export function frequencyValues(project: ProjectDetail): number[] {
  return [project.initiative?.reviewMinMs ?? 30000, project.initiative?.reviewMaxMs ?? 900000, project.initiative?.cooldownMs ?? 300000, project.evolution?.minIntervalMs ?? 3600000]
}
export function frequencyPreset(values: number[]): string {
  return FREQUENCY_PRESETS.find(preset => preset.values.every((value, index) => value === values[index]))?.id ?? 'custom'
}
export function durationLabel(ms: number) {
  return ms === 0 ? t('不设最短间隔') : ms % 3600000 === 0 ? t('{v} 小时', { v: ms / 3600000 }) : ms % 60000 === 0 ? t('{v} 分钟', { v: ms / 60000 }) : t('{v} 秒', { v: ms / 1000 })
}

/* ---------------------------------------------------------------- rhythm */

// One projection for the project page and settings, so a new host reason code is labelled once.
export { adaptiveRhythmDisplay, rhythmChangesAt, rhythmReason, type RhythmDisplay } from '@/lib/display/rhythm'

/* --------------------------------------------------------- PATCH payload */

export interface AutonomyDraft {
  actual: boolean
  rhythm: 'auto' | 'manual'
  enabled: boolean
  muted: boolean
  deferTyping: boolean
  evolve: boolean
  focus: string
  /** Seconds, as typed. */
  frequency: [string, string, string, string]
  relevance: string
  budget: string
  quiet: 'keep' | 'off' | '30' | '60' | '480'
  /** P3 reach settings; only sent to daemons that report inbox counts (P3+). */
  reach: boolean
  desktopNotifications: boolean
  /** Local hour 0–23 of the daily digest, as typed. */
  digestHour: string
}

export const DIGEST_DEFAULT_HOUR = 9

export function readFrequency(draft: Pick<AutonomyDraft, 'frequency'>) { return draft.frequency.map(value => Math.round(Number(value) * 1000)) }

/** PATCH /api/projects/:id body, identical to the legacy autonomy form. */
export function autonomyPayload(draft: AutonomyDraft, now = Date.now()) {
  const [reviewMinMs, reviewMaxMs, cooldownMs, minIntervalMs] = readFrequency(draft)
  const manual = !draft.actual || draft.rhythm === 'manual'
  const initiative: Record<string, unknown> = {
    enabled: draft.enabled, notificationMuted: draft.muted, deferWhileTyping: draft.deferTyping,
    ...(manual ? { reviewMinMs, reviewMaxMs, cooldownMs } : {}),
    ...(draft.actual ? { tokenBudget: draft.budget.trim() === '' ? null : Number(draft.budget) } : { minRelevance: Number(draft.relevance), budgetUsd: Number(draft.budget) }),
  }
  if (draft.actual && draft.reach) {
    initiative.desktopNotifications = draft.desktopNotifications
    const hour = Number(draft.digestHour)
    initiative.digestHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DIGEST_DEFAULT_HOUR
  }
  if (draft.quiet !== 'keep') initiative.quietUntil = draft.quiet === 'off' ? null : new Date(now + Number(draft.quiet) * 60000).toISOString()
  return {
    focus: draft.focus,
    ...(draft.actual ? { rhythm: { control: draft.rhythm } } : {}),
    initiative,
    evolution: { enabled: draft.evolve, ...(manual ? { minIntervalMs } : {}) },
  }
}

export function autonomyDraft(project: ProjectDetail): AutonomyDraft {
  const actual = project.decisionMode === 'rna-model' || project.simulated === false
  const initiative = project.initiative ?? {}
  const values = frequencyValues(project)
  const status = (project as { rhythmStatus?: { control?: 'auto' | 'manual' } }).rhythmStatus
  return {
    actual,
    rhythm: status?.control ?? project.rhythm?.control ?? 'auto',
    enabled: Boolean(initiative.enabled),
    muted: Boolean(initiative.notificationMuted),
    deferTyping: initiative.deferWhileTyping !== false,
    evolve: Boolean(project.evolution?.enabled),
    focus: project.focus ?? '',
    frequency: values.map(v => String(v / 1000)) as AutonomyDraft['frequency'],
    relevance: String(initiative.minRelevance ?? 0.5),
    budget: actual ? (initiative.tokenBudget == null ? '' : String(initiative.tokenBudget)) : String(initiative.budgetUsd ?? 0.5),
    quiet: 'keep',
    reach: typeof (project.counts as { inbox?: number } | undefined)?.inbox === 'number',
    desktopNotifications: initiative.desktopNotifications === true,
    digestHour: String(Number.isInteger(initiative.digestHour) ? initiative.digestHour : DIGEST_DEFAULT_HOUR),
  }
}
