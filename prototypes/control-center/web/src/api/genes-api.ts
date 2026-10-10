/**
 * Evolution v3 (docs/planning/evolution-v3-gene-tree-20260930.md): the project's
 * gene tree. GET /api/v2/projects/:id/genes; POST /api/v2/projects/:id/genes/:geneId.
 */
import { getTransport } from './client'
import type { ISODate } from './types'

export type GeneLayer = 'profile' | 'prompt' | 'skill' | 'tool' | 'guard' | 'standard' | 'system'
export type GeneStatus = 'proposed' | 'testing' | 'trial' | 'active' | 'retired' | 'rejected'

export interface GeneHistoryRow { at: ISODate; generation?: number | null; status: GeneStatus | string; note?: string }
export interface Gene {
  id: string
  layer: GeneLayer | string
  key: string
  title: string
  summary: string
  level: number
  status: GeneStatus | string
  /** sourceRemoved: the conversation (session_deleted) or message (message_rewound) the quote came from is gone, and the quote with it. */
  origin?: { kind: string; lessonId?: string; quote?: string; sourceRemoved?: 'session_deleted' | 'message_rewound' | string } | null
  generation?: number | null
  history: GeneHistoryRow[]
  runs: number
  hits: number
  createdAt?: ISODate | null
  updatedAt?: ISODate | null
  /** profile */
  kind?: string
  source?: string | null
  uses?: { recalled?: number; applied?: number; contradicted?: number } | null
  confirmed?: boolean
  /** prompt */
  body?: string
  file?: string | null
  /** skill / tool */
  size?: number
  permission?: string
  existingHits?: { files: number; total: number; at: ISODate } | null
  rejection?: { code: string; note?: string } | null
  /** skill with a plain-language summary: the original description */
  original?: string
  trigger?: string[] | null
  /** guards and skill patches: real use (clean turns — shown only —, same-point corrections, real catches, confident
   * false matches, uses lesson.applied confidently said were followed) */
  stats?: { clean?: number; missed?: number; real?: number; falseMatches?: number; applied?: number; injected?: number; recalled?: number; notFollowed?: number; viaLesson?: number } | null
  /** guard: re-judged under the current routing, a program cannot tell its rule from the file (EVO-7) */
  notCheckable?: boolean
  /** a guard whose false matches outnumber its catches (back on trial) */
  noisy?: boolean
  /** guard: the acceptance standard it helps verify */
  standardId?: string | null
  /** standard: the checks that verify it */
  checks?: { id: string; title: string }[]
  /** skill patch: the skill it was written into, and when it applies */
  skillId?: string
  when?: string
  /** skill merge (lane C): the two skills it joined, kept first */
  mergedFrom?: string[]
  /** system strand: a problem in the app or the machine, how often and when last seen */
  seen?: number
  lastSeenAt?: ISODate | null
  /** optional deep check: this generation compared with the one before it on the evaluation cases */
  deepCheckable?: boolean
  deepCheck?: DeepCheck | null
  /** a rule that left: how (undone, dropped, contradicted, ...), or the gate that stopped it (rejected:<code>, retryable:<code>) */
  fate?: string
  /** checks and skill rules: what the rule was run for (ranRecent: null until runs are counted by day) or put in front of the model (shown: null until recorded; recalled: judged relevant to a reply) — never the self-confirming level */
  exposure?: GeneExposure
  /** the scheduled work was corrected more often after this rule (under watch; the user is invited, never decided for) */
  harmWatch?: { since?: ISODate; shared: number; delta: number | null }
}
export interface GeneExposure { ran: number; ranRecent: number | null; hits: number; real: number; falseMatches: number; shown: number | null; recalled: number; applied: number; notFollowed: number; missed: number; lastRunAt?: ISODate | null }
export interface DeepCheck { status: 'running' | 'done' | 'failed'; startedAt?: ISODate; at?: ISODate; verdict?: 'better' | 'same' | 'worse' | 'unclear' | 'unavailable'; baselineScore?: number | null; candidateScore?: number | null; cases?: number | null; code?: string; reason?: string }
/** One gene in full (GET …/genes/:geneId): what the detail panel shows below the summary. */
export interface GeneContent {
  /** skill */
  name?: string
  description?: string
  instructions?: string
  resources?: string[]
  source?: string
  /** skill patch (lane B): the practice written into a skill */
  patch?: string
  when?: string
  expectation?: string
  /** tool / guard */
  permission?: string
  script?: string
  trigger?: string[] | null
  /** prompt */
  body?: string
  file?: string | null
  /** lesson */
  text?: string
  kind?: string
  evidence?: string[]
  /** system */
  detail?: string
  seen?: number
  lastSeenAt?: ISODate | null
}
export interface GeneDetailView { gene: Gene; content: GeneContent }
export interface GeneStrand { layer: GeneLayer | string; label: string; genes: Gene[] }
export interface GeneTree {
  projectId: string
  promptFile: { name: string | null; exists: boolean; default: string }
  generation: { n: number; at: ISODate | null; summary: string | null }
  generations: { n: number; at: ISODate; summary: string; geneIds: string[]; trigger: string | null }[]
  forming: boolean
  strands: GeneStrand[]
  revision?: number
}

/** Where each evolution lane is and why nothing happens (GET …/genes/observability?view=status): data only. */
export interface EvolutionStatus {
  at: ISODate
  enabled: boolean
  status: {
    generation: { n: number; at: ISODate; summary: string | null; trigger: string | null } | null
    /** A: lessons waiting for a rule */
    A: { state: 'idle' | 'due'; due: number; retrying: number; last: ISODate | null }
    /** B: corrections queued for review */
    B: { state: 'idle' | 'queued' | 'cooldown'; queued: number; cooldownUntil?: ISODate; last: ISODate | null }
    /** C: the contrast analysis: spaced (ran lately), due, or waiting for enough trouble */
    C: { state: 'spaced' | 'due' | 'waiting'; trouble: number; needed: number; nextAt?: ISODate; lastAnalysisAt: ISODate | null; last: ISODate | null }
  }
  revision?: number
}
export type DispositionKind = 'gene' | 'terminal' | 'retryable' | 'pending'
export interface GeneObservability extends EvolutionStatus {
  genes: (GeneExposure & { id: string; layer: string; title: string; status: string; generation: number | null; injectedRecent?: number; harmWatch?: { at?: ISODate; shared?: number; delta?: number | null; invitedAt?: ISODate } })[]
  /** matched pairs of the same schedule before and after a rule's generation, and the correction rates on both sides */
  harm: { geneId: string; title: string; shared: number; schedules: number; before: { rate: number | null; settled: number }; onset?: { rate: number | null }; after: { rate: number | null; settled: number }; delta: number | null; onsetDelta?: number | null; latestBadAt?: number | null; harmful: boolean; state: 'ok' | 'watching' | 'invited' }[]
  dispositions: {
    lessons: { counts: Record<DispositionKind, Record<string, number>>; recent: { lessonId: string; at: ISODate | null; kind: DispositionKind; code: string; attempts?: number }[] }
    corrections: { counts: Record<string, Record<string, number>>; recent: { at: ISODate; kind: DispositionKind; code: string; exhausted?: boolean; scheduleId?: string }[] }
    /** rules no longer in force: the retired by how they left (retiredAs), the rejected by the gate that stopped them, the weather-caused stops apart */
    genes: { retired: Record<string, number>; rejected: Record<string, number>; retryable: Record<string, number> }
  }
  generations: { n: number; at: ISODate; summary: string; trigger: string | null; corrected: number; undone: number; approved: number; accepted: number; failed: number; bad: number; known: number; rate: number | null; before: { bad: number; known: number; rate: number | null } | null }[]
  scoreboard: { geneId: string; layer: string; title: string; generation: number; at: ISODate; status: string; expectation: string; scope: { kind: 'schedule' | 'foreground'; ids?: string[] }; before?: { bad: number; known: number }; after?: { bad: number; known: number }; applied: number; real: number; missed: number; verdict: 'held' | 'again' | 'pending' }[]
  outcomes: { total: number; byOutcome: Record<string, number>; schedules: { scheduleId: string; title: string | null; occurrences: number; latestAt: ISODate | null; [outcome: string]: unknown }[] }
  bloat: { ratio: number | null; minimum: number; evidence: number; rules: { id: string; title: string; shown: number | null; applied: number; observed: number; unproven: boolean }[] }
  contrasts: { at: ISODate; turns: number; trouble: number; pairs?: number; clusters: number; analyzed: boolean; focus?: string; patches?: number; committed?: number; system?: number; retire?: number; merged?: boolean }[]
  funnel: Record<string, Record<string, number> | string> | null
  /** host-worded notes in the interface language */
  notes: string[]
}

const enc = encodeURIComponent
export const genesApi = {
  /** The lanes' state alone (cheap): the page's header and the rhythm card. */
  status: (projectId: string) => getTransport().request<EvolutionStatus>(`/api/v2/projects/${enc(projectId)}/genes/observability?view=status`),
  observability: (projectId: string) => getTransport().request<GeneObservability>(`/api/v2/projects/${enc(projectId)}/genes/observability`),
  tree: (projectId: string) => getTransport().request<GeneTree>(`/api/v2/projects/${enc(projectId)}/genes`),
  detail: (projectId: string, geneId: string) => getTransport().request<GeneDetailView>(`/api/v2/projects/${enc(projectId)}/genes/${enc(geneId)}`),
  act: (projectId: string, geneId: string, body: { action: 'confirm' | 'revoke' | 'deep_check' } | { action: 'rewrite'; text: string }) =>
    getTransport().request<{ geneId: string; action: string; generation?: number | null }>(`/api/v2/projects/${enc(projectId)}/genes/${enc(geneId)}`, { method: 'POST', body }),
}
