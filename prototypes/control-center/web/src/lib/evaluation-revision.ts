/**
 * Evaluation-standard revision (port of public/evaluation-revision-ui.js):
 * which versions may be revised or have a revised standard adopted, the
 * canonical suite hash the host checks (`sourceSuiteHash`), and the request
 * bodies. Pure; the component in views/evolution renders it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>

export const MAX_SUITE_BYTES = 512_000

/** Key-sorted JSON (the host's canonical form for hashing). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Rec)[key])}`).join(',')}}`
  return JSON.stringify(value) as string
}

export async function evaluationSuiteHash(suite: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(suite)))
  return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('')
}

const hidden = (version: Rec) => version.sourceDeleted || version.contextRevoked || ['proposing', 'evaluating'].includes(version.state)

export type RevisionMode =
  | { kind: 'adopt'; available: boolean; adoptedVersionId?: string; reason: string }
  | { kind: 'revise'; baselineId: string; suite: unknown }
  | null

/** What the version detail can offer: adopt a reviewed standard, revise the task standard, or nothing. */
export function revisionMode(project: Rec, version: Rec): RevisionMode {
  if (!version || hidden(version)) return null
  if (version.evaluationRevision && typeof version.evaluation?.gatePassed === 'boolean') {
    const adopted = (project.versions ?? []).find((row: Rec) => !row.sourceDeleted && !row.contextRevoked && row.standardRevision?.reviewVersionId === version.id && row.standardRevision?.revisionHash === version.evaluationRevision?.revisionHash)
    if (adopted) return { kind: 'adopt', available: false, adoptedVersionId: adopted.id, reason: 'adopted' }
    const eligibility = version.assessment?.standardAdoption
    return { kind: 'adopt', available: eligibility?.available === true, reason: eligibility?.available === true ? '' : typeof eligibility?.reason === 'string' && eligibility.reason ? eligibility.reason : '' }
  }
  const baseline = (project.versions ?? []).find((row: Rec) => row.id === project.activeVersionId)
  const suite = baseline?.bundle?.genome?.evaluationSuite
  if (!suite || version.parentVersionId !== baseline.id || !version.assessment?.candidateRetained || version.evaluationRevision) return null
  return { kind: 'revise', baselineId: baseline.id, suite }
}

export interface RevisionDraft { reason: string; suiteText: string }
export interface EvaluationRevisionInput { schemaVersion: 1; sourceSuiteHash: string; reason: string; suite: unknown }

/** Parse and freeze a draft into the host's `evaluationRevision` body; throws a user-facing Error. */
export async function buildRevision(sourceSuite: unknown, draft: RevisionDraft, messages: { reason: string; json: string }): Promise<EvaluationRevisionInput> {
  const reason = draft.reason.trim()
  if (!reason) throw new Error(messages.reason)
  let suite: unknown
  try { suite = JSON.parse(draft.suiteText) } catch { throw new Error(messages.json) }
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) throw new Error(messages.json)
  return { schemaVersion: 1, sourceSuiteHash: await evaluationSuiteHash(sourceSuite), reason, suite }
}

export interface RevisionPreview { status: 'preview'; baseVersionId?: string; revision: { revisionHash: string }; changes: unknown[] }
export function isRevisionPreview(value: unknown): value is RevisionPreview {
  const v = value as Rec | null
  return Boolean(v && v.status === 'preview' && typeof v.revision?.revisionHash === 'string' && v.revision.revisionHash && Array.isArray(v.changes))
}

export const previewBody = (versionId: string, evaluationRevision: EvaluationRevisionInput) => ({ retryVersionId: versionId, evaluationRevision, preview: true })
export const launchBody = (versionId: string, preview: RevisionPreview, evaluationRevision: EvaluationRevisionInput) => ({ retryVersionId: versionId, baseVersionId: preview.baseVersionId, evaluationRevision, reviewedRevisionHash: preview.revision.revisionHash })
export const adoptBody = (version: Rec) => ({ action: 'adopt-evaluation-standard', reviewVersionId: version.id, revisionHash: version.evaluationRevision?.revisionHash })
