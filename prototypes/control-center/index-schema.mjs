// Index rows: the project and session summaries of GET /api/v2/bootstrap and the `index` stream event
// (docs/specs/stream-protocol-v2.md §1–2). Each row is an explicit allowlist, as harness list rows
// (session-controller list.ts:107-118) and zcode's sessions-index schema (sessions-index.ts:29-56): a host field
// reaches the browser only once it is named here. The web derives its row types from these lists
// (index-schema.d.mts → web/src/api/types.ts), so a field added on one side and not the other fails `tsc`.
//
// Rows hold flags, counts, scalars and small projections of what the web reads from them; everything else is read
// from GET /api/v2/projects/:id (and the per-project routes). Rows are a function of committed state only: no
// value derived from the reading clock, or an idle project changes on every read.
//
// Pure module without imports: the web's contract tests load it as it is.

/** `hello.protocol` and `bootstrap.protocol` (3: allowlisted rows). The web reloads itself when it differs from its own. */
export const INDEX_PROTOCOL = 3;

export const SESSION_SUMMARY_FIELDS = Object.freeze([
  'id', 'title', 'projectId', 'kind', 'parentSessionId', 'status', 'pauseReason', 'mode', 'model', 'modelSelection', 'modelConfig',
  'context', 'usage', 'activeTurnId', 'plan', 'createdAt', 'updatedAt', 'archivedAt', 'simulated', 'sideChat', 'invitations',
  'worktree', 'appRecovery', 'runtime',
  // Derived from the session's items, turns, inbox and evidence outbox.
  'itemCount', 'lastItemAt', 'preview', 'inboxCount', 'waiting', 'lastInitiativeAt', 'agents', 'memoryEvidence',
]);

export const PROJECT_SUMMARY_FIELDS = Object.freeze([
  'id', 'name', 'description', 'workspacePath', 'createdAt', 'updatedAt', 'archivedAt', 'primarySessionId', 'permissions',
  'decisionMode', 'simulated', 'focus', 'taskTypes', 'initiative', 'evolution', 'rhythm', 'memory', 'activeVersionId', 'trialVersionId',
  // Derived, or small projections of large host records.
  'activeVersion', 'counts', 'genesForming', 'initialization', 'skillFoundation', 'memorySummary', 'rhythmStatus', 'initiativeRuntime',
  'schedules', 'scheduleRuntime', 'plan', 'work', 'backgroundChanges', 'git',
]);

/** An archived project is listed (已归档) and restorable, nothing more: its other fields come from the project route. */
export const ARCHIVED_PROJECT_SUMMARY_FIELDS = Object.freeze([
  'id', 'name', 'description', 'workspacePath', 'createdAt', 'updatedAt', 'archivedAt', 'primarySessionId', 'permissions',
  'decisionMode', 'simulated', 'counts',
]);

// What the web reads of each projected record (ProjectInitStatus, the project overview, the memory pages, the
// rhythm card, the task list); the full records stay on GET /api/v2/projects/:id.
export const MEMORY_SUMMARY_FIELDS = Object.freeze(['status', 'message', 'code', 'updatedAt']);
export const INITIALIZATION_FIELDS = Object.freeze(['status', 'phase', 'attempt', 'maxAttempts', 'message', 'diagnostic', 'requestedAt', 'startedAt', 'completedAt']);
export const SKILL_FOUNDATION_FIELDS = Object.freeze(['status', 'attemptedAt', 'completedAt']);
export const INITIATIVE_RUNTIME_FIELDS = Object.freeze(['status', 'availability']);
export const SCHEDULE_FIELDS = Object.freeze(['id', 'title', 'enabled', 'rule', 'destinationSessionId', 'nextRunAt', 'pausedReason', 'source', 'userEditedAt']);
export const OCCURRENCE_FIELDS = Object.freeze(['key', 'scheduleId', 'scheduledAt', 'status', 'deliveredAt', 'deliveryItemId', 'errorCode', 'actionId', 'deliveryActionId', 'sourceDeleted', 'contextRevoked']);
export const RHYTHM_LANE_FIELDS = Object.freeze(['eligible', 'reason', 'nextAt', 'state', 'quota']);
export const RHYTHM_HISTORY_FIELDS = Object.freeze(['at', 'lifecycle', 'reason', 'initiativeMode', 'evolutionMode']);
/** The rhythm card lists the latest five assessments, each reason cut at 800 characters (web lib/display/rhythm.ts). */
export const RHYTHM_HISTORY_ROWS = 5;
export const RHYTHM_REASON_CHARS = 800;

/** The named own fields of `source`, in list order (undefined values dropped, as JSON does). */
export function pick(source, fields) {
  if (!source || typeof source !== 'object') return source ?? null;
  const row = {};
  for (const key of fields) if (Object.hasOwn(source, key) && source[key] !== undefined) row[key] = source[key];
  return row;
}

/**
 * The schedule line of the row: how many schedules are active and the earliest next run (`schedules[].nextRunAt`, an
 * anchor). Not `dueCount`: it counts the anchors the reading clock has passed, so a schedule coming due would change an
 * idle project's row by itself. The web counts due schedules from the row's `schedules` at render time.
 */
export const RHYTHM_SCHEDULE_FIELDS = Object.freeze(['activeCount', 'nextAt']);

/** project.rhythmStatus as the rhythm card reads it: the lanes, the schedule line and the latest assessments. */
export function rhythmStatusRow(status) {
  if (!status || typeof status !== 'object') return status ?? null;
  const lane = value => value && typeof value === 'object' ? pick(value, RHYTHM_LANE_FIELDS) : value ?? null;
  const assessment = status.assessment;
  return {
    ...pick(status, ['control', 'lifecycle', 'assessmentRequired', 'effective']),
    schedule: status.schedule ? pick(status.schedule, RHYTHM_SCHEDULE_FIELDS) : null,
    initiative: lane(status.initiative), evolution: lane(status.evolution),
    assessment: assessment && typeof assessment === 'object' ? { lifecycle: assessment.lifecycle, reason: assessment.reason, initiative: { mode: assessment.initiative?.mode }, evolution: { mode: assessment.evolution?.mode } } : null,
    assessedAt: status.assessedAt ?? null,
    history: (Array.isArray(status.history) ? status.history : []).slice(-RHYTHM_HISTORY_ROWS).map(row => {
      const view = pick(row, RHYTHM_HISTORY_FIELDS);
      if (typeof view.reason === 'string' && view.reason.length > RHYTHM_REASON_CHARS) view.reason = view.reason.slice(0, RHYTHM_REASON_CHARS);
      return view;
    }),
  };
}

const OPEN_OCCURRENCE = row => !row.deliveredAt && !['delivered', 'failed', 'cancelled', 'skipped', 'expired'].includes(row.status);
const at = value => { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? time : -Infinity; };
/**
 * project.scheduleRuntime for the task list and the background runs (scheduleRows, deliveryStages): per schedule its
 * latest occurrence and its latest delivered one, every occurrence still open, and the ones of the runs the row lists
 * (`runKeys`, from `work`). The host keeps up to 127 settled occurrences per project; the whole history is on the
 * project route.
 */
export function scheduleRuntimeRow(runtime, { runKeys = [], runActions = [] } = {}) {
  if (!runtime || typeof runtime !== 'object') return runtime ?? null;
  const occurrences = Array.isArray(runtime.occurrences) ? runtime.occurrences.filter(row => row && typeof row === 'object') : [];
  const keep = new Set(), latest = new Map(), delivered = new Map(), keys = new Set(runKeys), actions = new Set(runActions);
  for (const row of occurrences) {
    if (OPEN_OCCURRENCE(row) || keys.has(row.key) || actions.has(row.actionId) || actions.has(row.deliveryActionId)) keep.add(row);
    const newest = latest.get(row.scheduleId); if (!newest || at(row.scheduledAt) >= at(newest.scheduledAt)) latest.set(row.scheduleId, row);
    if (row.deliveredAt) { const last = delivered.get(row.scheduleId); if (!last || at(row.scheduledAt) >= at(last.scheduledAt)) delivered.set(row.scheduleId, row); }
  }
  for (const row of [...latest.values(), ...delivered.values()]) keep.add(row);
  return { occurrences: occurrences.filter(row => keep.has(row)).map(row => pick(row, OCCURRENCE_FIELDS)) };
}
