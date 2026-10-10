import { constants } from 'node:fs';
import { lstat, readdir, open, unlink, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { digest } from '../../packages/sdk/src/journal.mjs';
import { atomicWrite, syncDirectory } from './durable-files.mjs';
import { revokeLearningSources } from '../../packages/sdk/src/learning.mjs';
import { sourceScope, withdrawSources } from './source-revocation.mjs';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const sha = text => createHash('sha256').update(text).digest('hex');
const fail = (code, detail) => { throw Object.assign(new Error(code), { code }, detail); };
const types = ['actions', 'jobs', 'decisions', 'failures', 'seen'];
// A blocked cleanup names what blocked it, so the user's decision can act on exactly that (review D2-3): `entry` (one
// managed file or folder below a project's run folder, as { root, path }), `limit: 'cumulative'` (the read budget of
// one pass, not one file), `actionIds` (runs whose outcome is unconfirmed) or `scope: 'record'` (the deletion record).
const ENTRY_CODES = new Set(['SESSION_EVIDENCE_READ_LIMIT', 'SESSION_EVIDENCE_STORAGE_UNSAFE', 'SESSION_EVIDENCE_JOURNAL_UNKNOWN', 'SESSION_EVIDENCE_JOURNAL_INVALID', 'SESSION_EVIDENCE_JOURNAL_IDENTITY', 'SESSION_EVIDENCE_ARCHIVE_UNKNOWN', 'SESSION_EVIDENCE_ARCHIVE_INVALID', 'SESSION_EVIDENCE_CONTEXT_INVALID', 'SESSION_EVIDENCE_IDENTITY_INVALID']);
/** Runs `work` for one managed entry; a failure it raises without a more precise entry of its own names this one. */
async function onEntry(entry, work) {
  try { return await work(); }
  catch (error) { if (error && typeof error === 'object' && ENTRY_CODES.has(error.code) && !error.entry && !error.limit && !error.scope) error.entry = entry; throw error; }
}
const ENTRY_ROOTS = new Set(['.rna', '.archive', '.evolution']);
const ENTRY_PART = /^(?!\.{1,2}$)[^/\\\0]{1,255}$/;
/**
 * A blocked entry the user may remove (D2-3): under `.rna/initiative/<project>/`, `.archive/{initiative,learning}/<project>/`
 * or `.evolution/<project>/`, at least one level below the project's own folder, every part a plain name.
 */
export function removableEntry(entry) {
  if (!entry || typeof entry !== 'object' || !ENTRY_ROOTS.has(entry.root) || typeof entry.path !== 'string' || entry.path.length > 1024) return false;
  const parts = entry.path.split('/');
  if (parts.some(part => !ENTRY_PART.test(part))) return false;
  const [namespace, projectId] = entry.root === '.evolution' ? [null, parts[0]] : parts;
  const depth = entry.root === '.evolution' ? 1 : 2;
  if (entry.root === '.rna' && namespace !== 'initiative' || entry.root === '.archive' && !['initiative', 'learning'].includes(namespace)) return false;
  return safeId(projectId) && parts.length > depth;
}
/**
 * The user's decision on a blocked cleanup (D2-3): remove one managed entry without reading it. Every folder on the way
 * must be a real folder (never followed through a link); the entry itself is unlinked when it is a link or a file, and
 * removed with what it holds when it is a folder (rm never follows a link inside it).
 * @returns {Promise<boolean>} whether something was removed
 */
export async function removeBlockedEntry(stateFile, entry) {
  if (!removableEntry(entry)) fail('SESSION_EVIDENCE_IDENTITY_INVALID');
  const parts = entry.path.split('/'); let path = resolve(`${stateFile}${entry.root}`);
  if (!await directory(path)) return false;
  for (const part of parts.slice(0, -1)) { path = join(path, part); if (!await directory(path)) return false; }
  const target = join(path, parts.at(-1));
  let stat; try { stat = await lstat(target); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (stat.isDirectory() && !stat.isSymbolicLink()) await rm(target, { recursive: true, force: true }); else await unlink(target);
  syncDirectory(path);
  return true;
}
/**
 * The user's decision on a damaged deletion record (D2-3): a fresh evidence capture keyed on the conversation's identity
 * (its id still matches every row and file that names it), keeping the resolutions already on record.
 */
export function rebuiltSessionEvidence(record) {
  const kept = list => Array.isArray(list) ? unique(list) : [];
  return { schemaVersion: 1, messageIds: [], turnIds: [], observationIds: [], actionIds: [], failureIds: [], archiveFiles: [], journalActionIds: [], resolvedActionIds: kept(record?.evidence?.resolvedActionIds), ...(Array.isArray(record?.evidence?.userReleasedActionIds) ? { userReleasedActionIds: kept(record.evidence.userReleasedActionIds) } : {}) };
}
const marker = '源会话已删除；仅保留执行与计费回执。';
const copy = value => structuredClone(value);
const unique = values => [...new Set(values.filter(safeId))];
const sourceId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:.@/-]{0,319}$/.test(value);
const sourceKeys = values => [...new Set(values.filter(sourceId))];
function identity(record) {
  if (!safeId(record.sessionId) || record.projectId !== null && record.projectId !== undefined && !safeId(record.projectId)) fail('SESSION_EVIDENCE_IDENTITY_INVALID');
}
function normalized(record) {
  identity(record);
  const source = record.evidence, damaged = code => fail(code, { scope: 'record' });
  if (!source || source.schemaVersion !== 1) damaged('SESSION_EVIDENCE_CAPTURE_MISSING');
  for (const key of ['messageIds', 'turnIds', 'observationIds', 'actionIds', 'failureIds']) if (!Array.isArray(source[key]) || source[key].some(id => !safeId(id))) damaged('SESSION_EVIDENCE_IDENTITY_INVALID');
  for (const key of ['learningEpisodeKeys', 'learningEvidenceIds', 'learningReviewIds', 'evolutionVersionIds']) if (source[key] !== undefined && (!Array.isArray(source[key]) || source[key].some(id => !(key === 'learningEvidenceIds' ? sourceId : safeId)(id)))) damaged('SESSION_EVIDENCE_IDENTITY_INVALID');
  if (source.learningArchiveFiles !== undefined && (!Array.isArray(source.learningArchiveFiles) || source.learningArchiveFiles.some(hash => !/^[a-f0-9]{64}$/.test(hash)))) damaged('SESSION_EVIDENCE_IDENTITY_INVALID');
  return { ...copy(source), archiveFiles: copy(source.archiveFiles ?? []), journalActionIds: unique(source.journalActionIds ?? []), resolvedActionIds: unique(source.resolvedActionIds ?? []), learningEpisodeKeys: unique(source.learningEpisodeKeys ?? []), learningEvidenceIds: sourceKeys(source.learningEvidenceIds ?? []), learningReviewIds: unique(source.learningReviewIds ?? []), evolutionVersionIds: unique(source.evolutionVersionIds ?? []), learningArchiveFiles: copy(source.learningArchiveFiles ?? []) };
}
function matcher(record, evidence) {
  const messages = new Set(evidence.messageIds), turns = new Set(evidence.turnIds), observations = new Set(evidence.observationIds), actions = new Set(evidence.actionIds), failures = new Set(evidence.failureIds);
  const learningIds = new Set(evidence.learningEvidenceIds ?? []);
  const event = id => typeof id === 'string' && (learningIds.has(id) || id.startsWith(`episode:turn:${record.sessionId}:`) || id.startsWith(`episode:feedback:${record.sessionId}:`) || id.startsWith('episode:work:') && actions.has(id.slice(13)) || messages.has(id) || observations.has(id) || actions.has(id) || id.startsWith('message:') && messages.has(id.slice(8)) || id.startsWith('observation:') && observations.has(id.slice(12)) || /^turn:([^:]+):[^:]+$/.test(id) && turns.has(id.split(':')[1]) || /^action:([^:]+):[^:]+$/.test(id) && actions.has(id.split(':')[1]));
  const row = value => Boolean(value && (value.sessionId === record.sessionId || value.sourceSessionId === record.sessionId || value.controlSourceSessionIds?.includes(record.sessionId) || value.controls?.some(command => command.sourceSessionId === record.sessionId) || value.deletedSessionId === record.sessionId || value.revokedSessionIds?.includes(record.sessionId) || value.sourceIds?.includes(`session:${record.sessionId}`) || event(value.evidenceId) || value.evidenceIds?.some(event) || value.rhythm?.evidenceIds?.some(event) || actions.has(value.actionId) || actions.has(value.jobId) || value.data && (value.data.sessionId === record.sessionId || value.data.sourceSessionId === record.sessionId || value.data.deletedSessionId === record.sessionId || messages.has(value.data.messageId) || turns.has(value.data.turnId) || actions.has(value.data.jobId))));
  return { event, row, actions, failures, observations };
}
/**
 * What was derived from the conversation, to a fixed point. Its deliveries into the project's other conversations
 * keep the citations their action had when it was delivered (an archive or a pre-split drift revocation wiped the
 * action's own), so a delivery item citing it names its action (a share has no job to link it otherwise).
 */
function graph(record, evidence, project, archives = [], state = null) {
  const rows = [ ...(project?.jobs ?? []).map(value => ({kind:'jobs',value})), ...(project?.decisions ?? []).map(value => ({kind:'decisions',value})), ...(project?.initiativeRuntime?.sdkState?.actions ?? []).map(value => ({kind:'actions',value})), ...archives ];
  const deliveries = project ? (state?.sessions ?? []).filter(session => session.projectId === project.id && session.id !== record.sessionId).flatMap(session => (session.items ?? []).filter(item => typeof item.initiativeActionId === 'string' && Array.isArray(item.evidenceIds) && item.evidenceIds.length)) : [];
  let changed;
  do {
    changed = false; const match = matcher(record, evidence);
    for (const observation of project?.observations ?? []) if (match.row(observation) && safeId(observation.id) && !evidence.observationIds.includes(observation.id)) { evidence.observationIds.push(observation.id); changed = true; }
    // A background work line is keyed `<actionId>-changes`: its run is the action.
    for (const item of deliveries) { const id = item.initiativeActionId.replace(/-changes$/, ''); if (safeId(id) && !evidence.actionIds.includes(id) && item.evidenceIds.some(match.event)) { evidence.actionIds.push(id); changed = true; } }
    for (const {kind,value,hash} of rows) if (['actions','jobs'].includes(kind) && (match.actions.has(value.id) || match.row(value))) {
      // An archived receipt with an unusable id is that one file's problem (it can be removed on the user's word).
      if (!safeId(value.id)) fail('SESSION_EVIDENCE_IDENTITY_INVALID', hash && safeId(record.projectId) ? { entry: { root: '.archive', path: `initiative/${record.projectId}/${kind}/${hash}.json` } } : undefined);
      if (!evidence.actionIds.includes(value.id)) { evidence.actionIds.push(value.id); changed = true; }
      if (safeId(value.failure?.id) && !evidence.failureIds.includes(value.failure.id)) { evidence.failureIds.push(value.failure.id); changed = true; }
    }
  } while (changed);
  learningGraph(record, evidence, project);
  return evidence;
}
function learningGraph(record, evidence, project) {
  for (const key of ['learningEpisodeKeys', 'learningEvidenceIds', 'learningReviewIds', 'evolutionVersionIds']) evidence[key] ??= [];
  const match = matcher(record, evidence), sdk = project?.learningRuntime?.sdkState;
  for (const row of sdk?.episodes ?? []) if (match.row(row) || match.event(row.id)) {
    if (safeId(row.key) && !evidence.learningEpisodeKeys.includes(row.key)) evidence.learningEpisodeKeys.push(row.key);
    if (sourceId(row.id) && !evidence.learningEvidenceIds.includes(row.id)) evidence.learningEvidenceIds.push(row.id);
  }
  for (const row of sdk?.reviews ?? []) if (match.row(row) || row.episodeKeys?.some(key => evidence.learningEpisodeKeys.includes(key))) {
    if (safeId(row.id) && !evidence.learningReviewIds.includes(row.id)) evidence.learningReviewIds.push(row.id);
    if (safeId(row.result?.versionId) && !evidence.evolutionVersionIds.includes(row.result.versionId)) evidence.evolutionVersionIds.push(row.result.versionId);
  }
  const updated = matcher(record, evidence);
  for (const version of project?.versions ?? []) if (updated.row(version) || evidence.learningReviewIds.includes(version.learningReviewId) || version.learningContextSources?.some(row => updated.event(row.evidenceId))) {
    if (safeId(version.id) && !evidence.evolutionVersionIds.includes(version.id)) evidence.evolutionVersionIds.push(version.id);
  }
  evolutionSearchGraph(evidence, project);
}
function evolutionSearchGraph(evidence, project) {
  let changed;
  do {
    changed = false;
    for (const version of project?.versions ?? []) if (safeId(version.id) && !evidence.evolutionVersionIds.includes(version.id) && version.searchSourceVersionIds?.some(id => evidence.evolutionVersionIds.includes(id))) {
      evidence.evolutionVersionIds.push(version.id); changed = true;
    }
  } while (changed);
}
/** Called before deletion: only identities enter the durable deletion outbox. */
export function captureSessionEvidence(state, session) {
  const record = { sessionId: session.id, projectId: session.projectId ?? null }; identity(record);
  const evidence = { schemaVersion: 1, messageIds: unique([...(session.items ?? []).map(item => item.id), ...(session.inbox ?? []).map(item => item.id), ...(session.submissions ?? []).map(item => item.message?.id)]), turnIds: unique((session.turns ?? []).map(turn => turn.id)), observationIds: [], actionIds: unique((session.items ?? []).flatMap(item => [item.initiativeActionId, item.interaction?.actionId, item.initiative?.jobId])), failureIds: [], archiveFiles: [], journalActionIds: [] };
  const project = state.projects.find(project => project.id === record.projectId);
  graph(record, evidence, project, [], state);
  // Project deletion removes the hot action records before file cleanup. Keep
  // the host's existing resolution identity so older archived uncertainty cannot
  // override an explicit completed/not-executed receipt after that removal.
  // Every resolved action of the project counts, not only the ones this
  // conversation references: discovery may later link a run through its prompt
  // snapshot, after the project state that held its receipt is gone (X-1).
  evidence.resolvedActionIds = unique([...(project?.jobs ?? []), ...(project?.initiativeRuntime?.sdkState?.actions ?? [])].filter(resolvedByHand).map(action => action.id));
  return evidence;
}
const resolvedByHand = action => Boolean(action?.resolvedAt && ['user', 'host'].includes(action.resolutionSource) && ['completed', 'cancelled'].includes(action.status));
/**
 * Project deletion (X-1): no executor will ever resume or reconcile this project's runs, and no page is left to
 * resolve them on. Called in the deletion transaction (after the run handles were cancelled, before the project's
 * state goes): every action and job still open or of unknown outcome gets a host resolution (reason
 * `project_deleted`), so the session deletion records captured next carry it.
 * @returns {number} how many were resolved
 */
export function resolveDeletedProjectActions(project, now = Date.now()) {
  if (!project) return 0;
  const open = row => row && !resolvedByHand(row) && (unresolved(row) || ['queued', 'running', 'paused', 'needs_review', 'interrupted'].includes(row.status));
  let resolved = 0;
  for (const action of project.initiativeRuntime?.sdkState?.actions ?? []) if (open(action)) { Object.assign(action, { status: 'cancelled', resolutionOutcome: 'unknown', resolutionReason: 'project_deleted', resolvedAt: now, resolutionSource: 'host', blocksExecution: false }); resolved++; }
  for (const job of project.jobs ?? []) if (open(job)) { Object.assign(job, { status: 'cancelled', resolutionOutcome: 'unknown', resolutionReason: 'project_deleted', resolvedAt: new Date(now).toISOString(), resolutionSource: 'host' }); resolved++; }
  return resolved;
}
const numeric = value => Number.isFinite(value) && value >= 0;
function usageReceipt(value) { return Object.fromEntries(Object.entries(value ?? {}).filter(([key, value]) => ['input','output','cacheRead','cacheWrite','totalTokens','estimatedTokens','costUsd'].includes(key) && numeric(value))); }
/** No free-text errors, prompts, question answers, file arguments or output survive. */
function receipt(row) {
  const result = { sourceDeleted: true, contextRevoked: true };
  for (const key of ['id','actionId','jobId','projectId','sessionId','versionId','parentVersionId']) if (safeId(row[key])) result[key] = row[key];
  for (const key of ['action','kind','status','lane','decisionMode','resolutionSource']) if (typeof row[key] === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(row[key])) result[key] = row[key];
  for (const key of ['at','createdAt','updatedAt','completedAt','finishedAt','startedAt','resolvedAt','revision','attempt','tokens','tokenBudget','usedTokens','estimatedTokens','reservedTokens']) if (numeric(row[key]) || typeof row[key] === 'string' && /^\d{4}-\d\d-\d\dT[\d:.+-]+Z?$/.test(row[key])) result[key] = row[key];
  for (const key of ['intentKey','sessionDigest','contextDigest']) if (typeof row[key] === 'string' && /^[a-f0-9]{64}$/.test(row[key])) result[key] = row[key];
  for (const key of ['simulated','blocksExecution']) if (typeof row[key] === 'boolean') result[key] = row[key];
  for (const key of ['usage','chargedUsage']) if (row[key]) result[key] = usageReceipt(row[key]);
  if (row.failure) result.failure = failureReceipt(row.failure);
  if (typeof row.errorCode === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(row.errorCode)) result.errorCode = row.errorCode;
  result.evidenceIds = []; result.content = marker;
  if (row.status === 'needs_review' || row.blocksExecution) result.reasonForReview = '原文已移除；外部执行结果仍未确认，须核对后明确解除。';
  return result;
}
function failureReceipt(row) {
  const result = { message: marker, sourceDeleted: true };
  for (const key of ['id','code','phase','source']) if (typeof row[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(row[key])) result[key] = row[key];
  for (const key of ['at','httpStatus','recoveredAt']) if (numeric(row[key])) result[key] = row[key];
  if (typeof row.retryable === 'boolean') result.retryable = row.retryable;
  if (row.request) result.request = Object.fromEntries(Object.entries(row.request).filter(([key,value]) => ['attempt','responseBytes'].includes(key) && numeric(value) || ['id','providerId','modelId','stopReason'].includes(key) && typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value) || key === 'responseSha256' && /^[a-f0-9]{64}$/.test(value)));
  return result;
}
/** Mutates a Store transaction only; safe to repeat after old writers settle. */
export function scrubSessionEvidence(state, record) {
  const evidence = normalized(record), project = state.projects.find(project => project.id === record.projectId); if (!project) return { scrubbed: 0 };
  graph(record, evidence, project, [], state); const match = matcher(record,evidence); let scrubbed = 0;
  for (const observation of project.observations ?? []) if (match.observations.has(observation.id) || match.row(observation)) { observation.text = marker; observation.data = { deletedSessionId: record.sessionId }; if (observation.status === 'pending') observation.status = 'superseded'; scrubbed++; }
  project.facts = (project.facts ?? []).filter(fact => !match.event(fact.evidenceId));
  for (const key of ['jobs','decisions']) project[key] = (project[key] ?? []).map(row => { if (!match.actions.has(row.id) && !match.row(row)) return row; scrubbed++; return receipt(row); });
  // Proactive inbox receipts (P3): keep counts/feedback, drop the message text.
  for (const entry of project.inbox ?? []) if (!entry.sourceDeleted && (entry.sessionId === record.sessionId || entry.digestSessionId === record.sessionId || match.actions.has(entry.actionId))) { entry.text = marker; entry.sourceDeleted = true; entry.contextRevoked = true; entry.heldForDigest = false; scrubbed++; }
  const runtime = project.initiativeRuntime, sdk = runtime?.sdkState;
  if (sdk) {
    sdk.events = (sdk.events ?? []).filter(event => !match.event(event.id));
    sdk.actions = (sdk.actions ?? []).map(action => { if (!match.actions.has(action.id) && !match.row(action)) return action; scrubbed++; return receipt(action); });
    if (sdk.lastDecision && (match.row(sdk.lastDecision) || match.row({ sourceIds: runtime.lastDecisionSourceIds }))) {
      sdk.lastDecision = { ...receipt(sdk.lastDecision), reason: marker };
      delete runtime.lastDecisionSourceIds;
      scrubbed++;
    }
    if (match.failures.has(sdk.lastFailure?.id)) sdk.lastFailure = failureReceipt(sdk.lastFailure);
  }
  if (runtime && match.row({ sourceIds: runtime.lastDecisionSourceIds })) delete runtime.lastDecisionSourceIds;
  if (match.failures.has(runtime?.lastFailure?.id)) runtime.lastFailure = failureReceipt(runtime.lastFailure);
  const rhythm = project.rhythmRuntime;
  if (rhythm) {
    // A wait decision may have no outer citations while its semantic rhythm
    // assessment quotes a conversation. Host-captured input source IDs also
    // cover implicit use that the model did not cite. Remove derived text and its
    // acceptance watermark; accounting/admission ledgers are not conversation
    // content and must survive to prevent free automatic reviews after delete.
    if (match.row(rhythm.assessment) || match.row({ sourceIds: rhythm.assessmentSourceIds })) {
      for (const key of ['assessment', 'assessmentSourceIds', 'assessedAt', 'decisionIdentity', 'evidenceKey']) delete rhythm[key];
      scrubbed++;
    }
    if (Array.isArray(rhythm.history)) rhythm.history = rhythm.history.filter(row => { if (!match.row(row)) return true; scrubbed++; return false; });
  }
  if (project.learningRuntime?.sdkState) {
    const learning = copy(project.learningRuntime.sdkState), removedSource = `session:${record.sessionId}`;
    for (const row of learning.episodes ?? []) if (evidence.learningEpisodeKeys.includes(row.key) || match.event(row.id)) row.sourceIds = [...new Set([...(row.sourceIds ?? []), removedSource])];
    for (const row of learning.reviews ?? []) if (evidence.learningReviewIds.includes(row.id)) row.sourceIds = [...new Set([...(row.sourceIds ?? []), removedSource])];
    project.learningRuntime.sdkState = revokeLearningSources(learning, [removedSource], 'session_deleted');
  }
  for (const version of project.versions ?? []) if (evidence.evolutionVersionIds.includes(version.id)) {
    Object.assign(version, { sourceDeleted: true, contextRevoked: true, title: '来源会话已删除的项目候选', notice: marker });
    for (const key of ['learningIntent','proposal','authorAbstention','repairEvidence','evaluationEvidence','referenceDiscovery','learningContextSources','learningContextReads','assessment','searchSummary','searchReview','searchFeedback','searchSourceVersionIds']) delete version[key];
    version.evidenceIds = []; if (version.error) version.error = { code: version.error.code, message: marker };
    if (version.evaluation) version.evaluation = evaluationReceipt(version.evaluation);
    scrubbed++;
  }
  if (evidence.evolutionVersionIds.includes(project.evolution?.request?.versionId)) project.evolution.request = { ...receipt(project.evolution.request), summary: marker };
  // The mind and the genes (MIND-8, X-6): requests, plan items and quotes from the conversation stop steering.
  const scope = sourceScope({ sessionId: record.sessionId }), mind = withdrawSources(state, project, scope, { mode: 'deleted' });
  scrubbed += mind.withdrawn + mind.stripped + mind.notes + mind.genes;
  state.events = (state.events ?? []).filter(event => !match.row(event));
  return { scrubbed };
}
function evaluationReceipt(value) {
  const result = { sourceDeleted: true, contextRevoked: true };
  for (const key of ['gatePassed','evaluationComplete','candidateStandardUsed','simulated']) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const key of ['baseline','score','baselineScore','candidateScore','cases','scoredCases','skippedCases']) if (typeof value[key] === 'number' || value[key] === null) result[key] = value[key];
  for (const key of ['stage','earlyStopReason','scope','statisticalClaim','judgeContext','methodologyVersion','completedAt','suiteHash','criteriaHash','baselineHash','candidateHash','candidateSuiteHash','evaluationRuntimeHash']) if (sourceId(value[key])) result[key] = value[key];
  if (value.gates) result.gates = Object.fromEntries(Object.entries(value.gates).filter(([key, flag]) => sourceId(key) && (flag === null || typeof flag === 'boolean')));
  if (value.usage) result.usage = usageReceipt(value.usage);
  return result;
}
async function directory(path) {
  let stat; try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SESSION_EVIDENCE_STORAGE_UNSAFE'); return true;
}
async function rootPath(stateFile, suffix, projectId, namespace = 'initiative') {
  const root = resolve(`${stateFile}${suffix}`); if (!await directory(root)) return null;
  const initiative = join(root,namespace); if (!await directory(initiative)) return null;
  const project = join(initiative,projectId); return await directory(project) ? project : null;
}
// One pass reads at most this much of JSON records and counts at most this many files (`limits` lowers them for
// tests), unless the user lifted the limit for this cleanup (record.readLimit 'none', D2-3); one file or journal line
// is never read past 32 MB.
export const SESSION_EVIDENCE_PASS_LIMITS = Object.freeze({ bytes: 256 * 1024 * 1024, files: 20000 });
const FILE_BYTES = 32 * 1024 * 1024;
const passBudget = (record, limits = SESSION_EVIDENCE_PASS_LIMITS) => ({ bytes: 0, files: 0, unlimited: record?.readLimit === 'none', limits: { ...SESSION_EVIDENCE_PASS_LIMITS, ...limits } });
function countFile(budget) { if (++budget.files > budget.limits.files && !budget.unlimited) fail('SESSION_EVIDENCE_READ_LIMIT', { limit: 'cumulative' }); }
// A link where a record should be is refused like any other link (O_NOFOLLOW answers ELOOP).
async function openOwned(path) {
  try { return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ELOOP') fail('SESSION_EVIDENCE_STORAGE_UNSAFE'); throw error; }
}
async function readOwned(path, budget) {
  const file = await openOwned(path);
  try {
    const before = await file.stat();
    // A file that is also linked from elsewhere is not this folder's to read or remove.
    if (!before.isFile() || before.nlink !== 1) fail('SESSION_EVIDENCE_STORAGE_UNSAFE');
    if (before.size > FILE_BYTES) fail('SESSION_EVIDENCE_READ_LIMIT');
    if ((budget.bytes += before.size) > budget.limits.bytes && !budget.unlimited) fail('SESSION_EVIDENCE_READ_LIMIT', { limit: 'cumulative' });
    const text = await file.readFile('utf8'), after = await file.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('SESSION_EVIDENCE_CHANGED'); return text;
  } finally { await file.close(); }
}
// History volume is not a memory budget. Scan the hash chain incrementally so
// a long-running project cannot permanently exhaust one aggregate read cap.
// Individual records remain bounded and a writer changing the file invalidates
// the entire discovery before any deletion manifest is committed.
async function* journalLines(path, budget) {
  let file; try { file = await openOwned(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1) fail('SESSION_EVIDENCE_STORAGE_UNSAFE');
    const chunk = Buffer.alloc(65536), decoder = new StringDecoder('utf8'); let pending = '', position = 0;
    while (position < before.size) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (!bytesRead) fail('SESSION_EVIDENCE_CHANGED');
      position += bytesRead; budget.bytes += bytesRead; pending += decoder.write(chunk.subarray(0, bytesRead));
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (Buffer.byteLength(line) > FILE_BYTES) fail('SESSION_EVIDENCE_READ_LIMIT');
        yield line;
      }
      if (Buffer.byteLength(pending) > FILE_BYTES) fail('SESSION_EVIDENCE_READ_LIMIT');
    }
    pending += decoder.end();
    if (pending || !before.size) fail('SESSION_EVIDENCE_JOURNAL_INVALID');
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('SESSION_EVIDENCE_CHANGED');
  } finally { await file.close(); }
}
/** One content-addressed JSON record (an archived receipt or learning review); null when it is gone. */
async function archivedRecord(path, name, budget) {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('SESSION_EVIDENCE_ARCHIVE_UNKNOWN');
  let text; try { text = await readOwned(path, budget); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (sha(text) !== name.slice(0, -5)) fail('SESSION_EVIDENCE_ARCHIVE_INVALID');
  let value; try { value = JSON.parse(text); } catch { fail('SESSION_EVIDENCE_ARCHIVE_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SESSION_EVIDENCE_ARCHIVE_INVALID');
  return value;
}
async function archives(stateFile, projectId,budget) {
  const root = await rootPath(stateFile,'.archive',projectId), result=[]; if (!root) return result;
  for (const kind of types) {
    const path=join(root,kind); if (!await onEntry({ root: '.archive', path: `initiative/${projectId}/${kind}` }, () => directory(path))) continue;
    for (const name of await readdir(path)) {
      countFile(budget);
      const value = await onEntry({ root: '.archive', path: `initiative/${projectId}/${kind}/${name}` }, () => archivedRecord(join(path, name), name, budget));
      if (value) result.push({kind,hash:name.slice(0,-5),value});
    }
  }
  return result;
}
async function learningArchives(stateFile, projectId, budget) {
  const root = await rootPath(stateFile, '.archive', projectId, 'learning'), rows = [];
  if (!root || !await onEntry({ root: '.archive', path: `learning/${projectId}/reviews` }, () => directory(join(root, 'reviews')))) return rows;
  for (const name of await readdir(join(root, 'reviews'))) {
    countFile(budget);
    const value = await onEntry({ root: '.archive', path: `learning/${projectId}/reviews/${name}` }, () => archivedRecord(join(root, 'reviews', name), name, budget));
    if (value) rows.push({ hash: name.slice(0, -5), value });
  }
  return rows;
}
async function evolutionRoot(stateFile, projectId) {
  const root = resolve(`${stateFile}.evolution`); if (!await directory(root)) return null;
  const project = join(root, projectId); return await directory(project) ? project : null;
}
async function discoverEvolutionSources(stateFile, record, evidence, budget) {
  const root = await evolutionRoot(stateFile, record.projectId); if (!root) return;
  const match = matcher(record, evidence), links = [];
  for (const versionId of await readdir(root)) {
    const folder = { root: '.evolution', path: `${record.projectId}/${versionId}` };
    if (!safeId(versionId)) fail('SESSION_EVIDENCE_IDENTITY_INVALID', { entry: folder });
    if (!await onEntry(folder, () => directory(join(root, versionId)))) continue;
    if (evidence.evolutionVersionIds.includes(versionId)) continue;
    for (const name of ['evidence.json', 'learning-context.json', 'learning-intent.json', 'proposal.json', 'search-policy.json', 'author-review.json']) {
      countFile(budget);
      const found = await onEntry({ root: '.evolution', path: `${record.projectId}/${versionId}/${name}` }, async () => {
        let text; try { text = await readOwned(join(root, versionId, name), budget); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        let value; try { value = JSON.parse(text); } catch { fail('SESSION_EVIDENCE_ARCHIVE_INVALID'); }
        if (name === 'search-policy.json') {
          if (!Array.isArray(value.sourceVersionIds) || value.sourceVersionIds.some(id => !safeId(id))) fail('SESSION_EVIDENCE_ARCHIVE_INVALID');
          return { sources: value.sourceVersionIds };
        }
        if (value.sourceEvidenceIds !== undefined && (!Array.isArray(value.sourceEvidenceIds) || value.sourceEvidenceIds.some(id => typeof id !== 'string'))) fail('SESSION_EVIDENCE_ARCHIVE_INVALID');
        return { ids: [...(value.evidence ?? []).map(row => row.id), ...(value.learningIntent?.evidenceIds ?? []), ...(value.diagnosis?.evidenceIds ?? []), ...(value.abstention?.evidenceIds ?? []), ...(value.sourceEvidenceIds ?? [])] };
      });
      if (!found) continue;
      if (found.sources) { links.push({ versionId, sources: found.sources }); continue; }
      if (found.ids.some(match.event)) { evidence.evolutionVersionIds.push(versionId); break; }
    }
  }
  let changed;
  do {
    changed = false;
    for (const row of links) if (!evidence.evolutionVersionIds.includes(row.versionId) && row.sources.some(id => evidence.evolutionVersionIds.includes(id))) {
      evidence.evolutionVersionIds.push(row.versionId); changed = true;
    }
  } while (changed);
}
function learningReviewReceipt(row, record) {
  return { ...receipt(row), sourceRevoked: true, revocationReason: 'session_deleted',
    ...(['reviewing', 'executing', 'queued_experiment', 'completed', 'no_change', 'deferred', 'failed', 'interrupted'].includes(row.statusBeforeRevocation) ? { statusBeforeRevocation: row.statusBeforeRevocation } : {}),
    episodeKeys: unique(row.episodeKeys ?? []), sourceIds: sourceKeys(row.sourceIds ?? []).filter(id => id !== `session:${record.sessionId}`),
    ...(row.result ? { result: { ...(sourceId(row.result.status) ? { status: row.result.status } : {}), ...(safeId(row.result.versionId) ? { versionId: row.result.versionId } : {}), ...(row.result.usage ? { usage: usageReceipt(row.result.usage) } : {}) } } : {}) };
}
async function purgeLearningArtifacts(stateFile, record, evidence, budget) {
  let scrubbedLearningArchives = 0, scrubbedEvolutionArtifacts = 0;
  const archiveRoot = await rootPath(stateFile, '.archive', record.projectId, 'learning');
  for (const digest of evidence.learningArchiveFiles) {
    if (!archiveRoot || !await onEntry({ root: '.archive', path: `learning/${record.projectId}/reviews` }, () => directory(join(archiveRoot, 'reviews')))) continue;
    const path = join(archiveRoot, 'reviews', `${digest}.json`);
    await onEntry({ root: '.archive', path: `learning/${record.projectId}/reviews/${digest}.json` }, async () => {
      let text; try { text = await readOwned(path, budget); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (sha(text) !== digest) fail('SESSION_EVIDENCE_ARCHIVE_INVALID');
      const replacement = JSON.stringify(learningReviewReceipt(JSON.parse(text), record)), nextHash = sha(replacement);
      if (nextHash !== digest) { atomicWrite(join(archiveRoot, 'reviews', `${nextHash}.json`), replacement); await unlink(path); syncDirectory(join(archiveRoot, 'reviews')); scrubbedLearningArchives++; }
    });
  }
  const root = await evolutionRoot(stateFile, record.projectId); if (!root) return { scrubbedLearningArchives, scrubbedEvolutionArtifacts };
  for (const versionId of evidence.evolutionVersionIds) {
    const dir = join(root, versionId); if (!await onEntry({ root: '.evolution', path: `${record.projectId}/${versionId}` }, () => directory(dir))) continue;
    // Published bundles live under .genomes and are deliberately untouched.
    // Baseline and frozen-suite files are executable project assets/contracts,
    // not copies of the admitted conversation snapshot.
    for (const name of ['evidence.json', 'learning-context.json', 'learning-intent.json', 'proposal.json', 'proposal-validation.json', 'author-review.json', 'reference-sources.json', 'search-policy.json', 'evaluation.json', 'failure.json', 'trace.jsonl', 'result.json']) await onEntry({ root: '.evolution', path: `${record.projectId}/${versionId}/${name}` }, async () => {
      const path = join(dir, name); let text;
      try { text = await readOwned(path, budget); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (name === 'evidence.json' || name === 'learning-context.json' || name === 'search-policy.json' || name === 'author-review.json') { await unlink(path); syncDirectory(dir); scrubbedEvolutionArtifacts++; return; }
      let replacement;
      if (name === 'trace.jsonl') {
        if (text && !text.endsWith('\n')) fail('SESSION_EVIDENCE_ARCHIVE_INVALID');
        const rows = text.trim() ? text.trimEnd().split('\n').map(line => { let row; try { row = JSON.parse(line); } catch { fail('SESSION_EVIDENCE_ARCHIVE_INVALID'); } return { ...receipt(row), ...(sourceId(row.type) ? { type: row.type } : {}), ...(sourceId(row.phase) ? { phase: row.phase } : {}) }; }) : [];
        replacement = rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '';
      } else {
        let row; try { row = JSON.parse(text); } catch { fail('SESSION_EVIDENCE_ARCHIVE_INVALID'); }
        replacement = JSON.stringify({ ...receipt(row), ...evaluationReceipt(row), versionId, artifact: name });
      }
      const contents = value => name === 'trace.jsonl' ? value.trim() ? value.trimEnd().split('\n').map(line => JSON.parse(line)) : [] : JSON.parse(value);
      if (digest(contents(replacement)) !== digest(contents(text))) { atomicWrite(path, replacement); scrubbedEvolutionArtifacts++; }
    });
  }
  return { scrubbedLearningArchives, scrubbedEvolutionArtifacts };
}
function unresolved(action) { return action && !action.resolvedAt && (action.blocksExecution===true || ['uncertain_tool','tool_uncertain','process_cleanup_uncertain'].includes(action.errorCode ?? action.failure?.code)); }
// createExecTool owns this exact layout. Logs are private session material;
// accept them without reading potentially huge output, but reject unknown
// children, links and hardlinks before the enclosing journal can be purged.
async function executionLogs(path, budget, entry) {
  if (!await onEntry(entry, () => directory(path))) return;
  for (const name of await readdir(path)) {
    countFile(budget);
    const childEntry = { ...entry, path: `${entry.path}/${name}` };
    if (!/^rna-exec-[A-Za-z0-9_-]{6}$/.test(name)) fail('SESSION_EVIDENCE_JOURNAL_UNKNOWN', { entry: childEntry });
    const child = join(path, name);
    if (!await onEntry(childEntry, () => directory(child))) continue;
    for (const file of await readdir(child)) {
      countFile(budget);
      const fileEntry = { ...entry, path: `${childEntry.path}/${file}` };
      if (file !== 'output.log') fail('SESSION_EVIDENCE_JOURNAL_UNKNOWN', { entry: fileEntry });
      const stat = await lstat(join(child, file));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('SESSION_EVIDENCE_STORAGE_UNSAFE', { entry: fileEntry });
    }
  }
}
async function journals(stateFile,record,evidence,budget) {
  const root=await rootPath(stateFile,'.rna',record.projectId), result=[]; if (!root) return result;
  for (const actionId of await readdir(root)) {
    // A run's journal folder: its own problems name it (or the one file in it) for the user's decision.
    const folder = { root: '.rna', path: `initiative/${record.projectId}/${actionId}` };
    if (!safeId(actionId)) fail('SESSION_EVIDENCE_JOURNAL_UNKNOWN', { entry: folder });
    if (!await onEntry(folder, () => directory(join(root,actionId)))) continue;
    const name=`${digest(actionId).slice(0,24)}.rna.jsonl`; let files; try { files=await readdir(join(root,actionId)); } catch(error) { if(error.code==='ENOENT') continue; throw error; }
    if (!files.length) continue;
    for (const file of files) if(file!==name&&file!==`${name}.lock`) {
      if (file === 'exec') { await executionLogs(join(root, actionId, file), budget, { ...folder, path: `${folder.path}/exec` }); continue; }
      // Journal sidecars: torn tails, the verified-prefix checkpoint (and its
      // temp), compaction backups and an interrupted compaction's temp.
      const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', fileEntry = { ...folder, path: `${folder.path}/${file}` };
      if(!file.startsWith(`${name}.`)||!new RegExp(`^(?:torn-${uuid}|checkpoint|checkpoint\\.tmp-${uuid}|precompact-\\d+-\\d+|compact-${uuid})$`).test(file.slice(name.length+1))) fail('SESSION_EVIDENCE_JOURNAL_UNKNOWN', { entry: fileEntry });
      const stat=await lstat(join(root,actionId,file)); if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1) fail('SESSION_EVIDENCE_STORAGE_UNSAFE', { entry: fileEntry });
    }
    if (files.includes(`${name}.lock`)) {
      let lock; try { lock=JSON.parse(await readOwned(join(root,actionId,`${name}.lock`),budget)); } catch {fail('SESSION_BACKGROUND_CLEANUP_PENDING');}
      if (!Number.isSafeInteger(lock.pid)||lock.pid<1) fail('SESSION_BACKGROUND_CLEANUP_PENDING');
      try {process.kill(lock.pid,0); fail('SESSION_BACKGROUND_CLEANUP_PENDING');} catch(error) {if(error.code!=='ESRCH') throw error;}
    }
    let previous=null, number=0, linked=evidence.actionIds.includes(actionId), pending=new Map(), contextEvidenceIds=[];
    // JSON archives use their own in-memory cap; journal bytes are streamed.
    const journalBudget = { bytes: 0 };
    await onEntry(folder, async () => { for await (const line of journalLines(join(root,actionId,name),journalBudget)) {
      let row; try {row=JSON.parse(line);} catch {fail('SESSION_EVIDENCE_JOURNAL_INVALID');}
      const {hash,...body}=row; if(body.seq!==++number||body.prevHash!==previous||digest(body)!==hash) fail('SESSION_EVIDENCE_JOURNAL_INVALID'); previous=hash;
      if(number===1 && (row.type!=='session_header'||row.data?.format!=='rna-session'||row.data.version!==1||row.data.sessionId!==actionId||row.data.projectId!==record.projectId)) fail('SESSION_EVIDENCE_JOURNAL_IDENTITY');
      if(row.type==='tool_intent') pending.set(row.data.callKey,row.data);
      if(row.type==='tool_completed') pending.delete(row.data.callKey);
      if(row.type==='tool_uncertain') pending.set(row.data.callKey,{...pending.get(row.data.callKey),...row.data});
      const contexts=[row.data?.item?.context,row.data?.message?.context,row.data?.context];
      for(const entries of contexts) for(const context of entries??[]) if(context.source==='project-evidence') {
        let value; try {value=JSON.parse(context.text);} catch {fail('SESSION_EVIDENCE_CONTEXT_INVALID');}
        const match=matcher(record,evidence);
        // Background prompts receive the same rhythmStatus projection as the
        // planner. Its historical reason can retain source text even after the
        // recent-conversation window no longer contains that session.
        const rhythm = value.project?.rhythmStatus;
        const rhythmRows = [rhythm?.assessment, ...(Array.isArray(rhythm?.history) ? rhythm.history : [])];
        const rhythmIds = rhythmRows.flatMap(row => Array.isArray(row?.evidenceIds) ? row.evidenceIds : []).filter(id => typeof id === 'string');
        contextEvidenceIds.push(...(value.evidence??[]).map(event=>event.id).filter(id=>typeof id==='string'), ...rhythmIds);
        if(value.project?.recentConversation?.some(message=>message.sessionId===record.sessionId||evidence.messageIds.includes(message.id))||value.evidence?.some(event=>match.event(event.id))||rhythmIds.some(match.event)||rhythmRows.some(match.row)||match.row({sourceIds:rhythm?.assessmentSourceIds})) linked=true;
      }
    } });
    if (number) result.push({actionId,linked,contextEvidenceIds,pendingExecution:[...pending.values()].some(tool=>tool.requiresResolution===true||tool.effect!=='read'&&tool.idempotent!==true)});
  }
  return result;
}
/** Read only managed private evidence, never workspace files or runtimeFile fields. */
export async function discoverSessionEvidence(stateFile,record,{state,limits}={}) {
  const evidence=normalized(record); if (!record.projectId) return {...evidence,discovered:true};
  const budget=passBudget(record,limits), rows=await archives(stateFile,record.projectId,budget), project=state?.projects?.find(project=>project.id===record.projectId);
  graph(record,evidence,project,rows,state);
  const logs=await journals(stateFile,record,evidence,budget);
  let changed; do {
    changed=false; const match=matcher(record,evidence);
    for(const log of logs) if((log.linked||log.contextEvidenceIds.some(match.event))&&!evidence.actionIds.includes(log.actionId)) {evidence.actionIds.push(log.actionId);changed=true;}
    const count=evidence.actionIds.length;graph(record,evidence,project,rows,state);if(evidence.actionIds.length!==count)changed=true;
  } while(changed);
  const match=matcher(record,evidence);
  const actions=[...(project?.initiativeRuntime?.sdkState?.actions??[]),...(project?.jobs??[]),...rows.filter(row=>['actions','jobs'].includes(row.kind)).map(row=>row.value)];
  evidence.resolvedActionIds=unique([...(evidence.resolvedActionIds??[]),...actions.filter(resolvedByHand).map(action=>action.id)]);
  // A project that no longer exists can never resume, reconcile or show its runs: an execution of unknown outcome
  // there is resolved by the host (reason project_deleted), never left to block the deletion forever (X-1).
  const projectGone=Array.isArray(state?.projects)&&!project;
  if(projectGone) {
    const ids=unique([...actions.filter(action=>match.actions.has(action.id)&&unresolved(action)).map(action=>action.id),...logs.filter(log=>match.actions.has(log.actionId)&&log.pendingExecution).map(log=>log.actionId)]).filter(id=>!evidence.resolvedActionIds.includes(id));
    if(ids.length) { evidence.hostResolvedActionIds=unique([...(evidence.hostResolvedActionIds??[]),...ids]); evidence.hostResolution='project_deleted'; evidence.resolvedActionIds=unique([...evidence.resolvedActionIds,...ids]); }
  }
  // Every run whose outcome is unconfirmed is named, so the deletion waits on exactly those (D2-1) and the user can
  // decide on them (D2-3).
  const unconfirmed=unique([...actions.filter(action=>match.actions.has(action.id)&&unresolved(action)).map(action=>action.id),...logs.filter(log=>match.actions.has(log.actionId)&&log.pendingExecution).map(log=>log.actionId)]).filter(id=>!evidence.resolvedActionIds.includes(id));
  if(unconfirmed.length) fail('SESSION_BACKGROUND_EXECUTION_UNCONFIRMED',{actionIds:unconfirmed});
  for(const log of logs) if(match.actions.has(log.actionId)&&!evidence.journalActionIds.includes(log.actionId)) evidence.journalActionIds.push(log.actionId);
  for(const row of rows) if(match.row(row.value)||['actions','jobs'].includes(row.kind)&&match.actions.has(row.value.id)||row.kind==='failures'&&match.failures.has(row.value.id)||row.kind==='seen'&&match.event(row.value.id)) if(!evidence.archiveFiles.some(file=>file.kind===row.kind&&file.hash===row.hash)) evidence.archiveFiles.push({kind:row.kind,hash:row.hash});
  for (const row of await learningArchives(stateFile, record.projectId, budget)) if (match.row(row.value) || evidence.learningReviewIds.includes(row.value.id) || row.value.episodeKeys?.some(key => evidence.learningEpisodeKeys.includes(key))) {
    if (!evidence.learningArchiveFiles.includes(row.hash)) evidence.learningArchiveFiles.push(row.hash);
    if (safeId(row.value.id) && !evidence.learningReviewIds.includes(row.value.id)) evidence.learningReviewIds.push(row.value.id);
    if (safeId(row.value.result?.versionId) && !evidence.evolutionVersionIds.includes(row.value.result.versionId)) evidence.evolutionVersionIds.push(row.value.result.versionId);
  }
  await discoverEvolutionSources(stateFile, record, evidence, budget);
  evolutionSearchGraph(evidence, project);
  evidence.discovered=true; return evidence;
}
/** The host must persist the discovered identity manifest and settle all writers first. */
export async function purgeSessionEvidenceFiles(stateFile,record,{writersSettled=false,limits}={}) {
  const evidence=normalized(record); if(!writersSettled||evidence.discovered!==true) fail('SESSION_BACKGROUND_CLEANUP_PENDING');
  if(!record.projectId) return {removedArchives:0,removedJournals:0};
  const archiveRoot=await rootPath(stateFile,'.archive',record.projectId), budget=passBudget(record,limits); let removedArchives=0,removedJournals=0;
  for(const entry of evidence.archiveFiles) {
    if(!types.includes(entry.kind)||!/^([a-f0-9]{64})$/.test(entry.hash)) fail('SESSION_EVIDENCE_IDENTITY_INVALID',{scope:'record'});
    if(!archiveRoot||!await onEntry({root:'.archive',path:`initiative/${record.projectId}/${entry.kind}`},()=>directory(join(archiveRoot,entry.kind)))) continue;
    await onEntry({root:'.archive',path:`initiative/${record.projectId}/${entry.kind}/${entry.hash}.json`},async()=>{
      const path=join(archiveRoot,entry.kind,`${entry.hash}.json`); let text; try{text=await readOwned(path,budget);}catch(error){if(error.code==='ENOENT')return;throw error;}
      if(sha(text)!==entry.hash) fail('SESSION_EVIDENCE_ARCHIVE_INVALID');
      const original=JSON.parse(text), replacement=entry.kind==='failures'?failureReceipt(original):receipt(original);
      const serialized=JSON.stringify(replacement), hash=sha(serialized);
      if(hash!==entry.hash) {atomicWrite(join(archiveRoot,entry.kind,`${hash}.json`),serialized);try {await unlink(path);} catch(error) {if(error.code!=='ENOENT')throw error;}syncDirectory(join(archiveRoot,entry.kind));removedArchives++;}
    });
  }
  // Recheck headers, hash chains, locks and unresolved tools immediately before unlink.
  const logs=await journals(stateFile,record,evidence,budget), root=await rootPath(stateFile,'.rna',record.projectId);
  for(const actionId of evidence.journalActionIds) {
    const log=logs.find(log=>log.actionId===actionId); if(!log||!root)continue;
    if(!evidence.actionIds.includes(actionId)) fail('SESSION_EVIDENCE_IDENTITY_INVALID',{scope:'record'});
    // Discovery already checked resolutions; current untrusted journal content cannot
    // authorize itself. An unresolved tool remains pending unless host gave a receipt.
    if(log.pendingExecution&&!evidence.resolvedActionIds?.includes(actionId)) fail('SESSION_BACKGROUND_EXECUTION_UNCONFIRMED',{actionIds:[actionId]});
    await rm(join(root,actionId),{recursive:true,force:true});syncDirectory(root);removedJournals++;
  }
  const learning = await purgeLearningArtifacts(stateFile, record, evidence, budget);
  return {removedArchives,removedJournals, ...(learning.scrubbedLearningArchives ? { scrubbedLearningArchives: learning.scrubbedLearningArchives } : {}), ...(learning.scrubbedEvolutionArtifacts ? { scrubbedEvolutionArtifacts: learning.scrubbedEvolutionArtifacts } : {})};
}
