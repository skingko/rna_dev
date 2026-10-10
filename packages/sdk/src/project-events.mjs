import { createHash } from 'node:crypto';
import { canonicalJSON } from './journal.mjs';

export const PROJECT_EVENT_INBOX_VERSION = 1;
export const PROJECT_EVENT_LIMITS = Object.freeze({ maxSources: 32, maxPending: 128, maxSummaryChars: 2000, maxChanges: 64, maxDataBytes: 16384, maxStateBytes: 4194304 });

export class ProjectEventError extends Error {
  constructor(message, code = 'invalid_project_event') { super(message); this.name = 'ProjectEventError'; this.code = code; }
}
const fail = (message, code) => { throw new ProjectEventError(message, code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys, name) => { if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`Invalid ${name} fields`); };
const identifier = (value, field) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value)) fail(`Invalid ${field}`); return value; };
const integer = (value, field, min = 0, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${field}`); return value; };
const instant = (value, field) => integer(value, field, 0, 8640000000000000);
const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const clone = value => structuredClone(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function limitsFor(value = {}) {
  exact(value, Object.keys(PROJECT_EVENT_LIMITS), 'limits');
  const limits = { ...PROJECT_EVENT_LIMITS, ...value };
  for (const [key, limit] of Object.entries(limits)) integer(limit, key, 1, PROJECT_EVENT_LIMITS[key]);
  return limits;
}

function dataFor(value, limits) {
  if (value === undefined) return undefined;
  exact(value, ['changes', 'totalChanges', 'truncated'], 'observation data');
  const result = {};
  if (value.changes !== undefined) {
    if (!Array.isArray(value.changes) || value.changes.length > limits.maxChanges) fail('Invalid observation changes');
    const paths = new Set();
    result.changes = value.changes.map(row => {
      exact(row, ['path', 'change', 'sha256'], 'file change');
      if (typeof row.path !== 'string' || !row.path || row.path.length > 1024 || row.path.includes('\\') || /^[\/]|^[a-zA-Z]:/.test(row.path)
        || /[\u0000-\u001f\u007f]/.test(row.path) || row.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(row.path)) fail('Invalid relative change path');
      paths.add(row.path);
      if (!['created', 'modified', 'deleted'].includes(row.change) || row.sha256 !== undefined && !sha256(row.sha256)) fail('Invalid file change');
      return { path: row.path, change: row.change, ...(row.sha256 === undefined ? {} : { sha256: row.sha256 }) };
    });
  }
  if (value.totalChanges !== undefined) { integer(value.totalChanges, 'totalChanges'); if (value.totalChanges < (result.changes?.length ?? 0)) fail('totalChanges omits listed changes'); result.totalChanges = value.totalChanges; }
  if (value.truncated !== undefined) { if (typeof value.truncated !== 'boolean') fail('Invalid truncated flag'); result.truncated = value.truncated; }
  if (value.truncated === false && value.totalChanges !== undefined && value.totalChanges !== (result.changes?.length ?? 0)) fail('Untruncated changes must be complete');
  if (Buffer.byteLength(canonicalJSON(result)) > limits.maxDataBytes) fail('Observation data exceeds its byte limit');
  return result;
}

function contentFor(input, limits) {
  identifier(input.kind, 'event kind');
  if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > limits.maxSummaryChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.summary)) fail('Invalid event summary');
  if (input.coalesceKey !== undefined) identifier(input.coalesceKey, 'coalesce key');
  if (input.observedAt !== undefined) instant(input.observedAt, 'observedAt');
  const data = dataFor(input.data, limits);
  return { kind: input.kind, summary: input.summary, ...(data === undefined ? {} : { data }), ...(input.coalesceKey === undefined ? {} : { coalesceKey: input.coalesceKey }), ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }) };
}

function eventIdentity(value) {
  return { projectId: value.projectId, bindingId: value.bindingId, sourceId: value.sourceId, sourceRevision: value.sourceRevision, sequence: value.sequence, contentHash: value.contentHash };
}
function eventId(value) { return `external-${hash(eventIdentity(value))}`; }

function validateState(value, { projectId, bindingId, limits }) {
  exact(value, ['version', 'projectId', 'bindingId', 'revision', 'sources', 'pending', 'checkpoint'], 'inbox state');
  if (value.version !== PROJECT_EVENT_INBOX_VERSION || value.projectId !== projectId || value.bindingId !== bindingId) fail('Inbox belongs to a different project, workspace or schema', 'project_event_binding_mismatch');
  integer(value.revision, 'inbox revision');
  if (!Array.isArray(value.sources) || value.sources.length > limits.maxSources || !Array.isArray(value.pending) || value.pending.length > limits.maxPending) fail('Inbox exceeds configured capacity');
  const sources = new Map();
  for (const source of value.sources) {
    exact(source, ['id', 'revision', 'kind', 'revoked', 'sequence', 'contentHash', 'updatedAt'], 'source');
    identifier(source.id, 'source id'); identifier(source.kind, 'source kind'); integer(source.revision, 'source revision', 1); integer(source.sequence, 'source sequence'); instant(source.updatedAt, 'source update');
    if (sources.has(source.id) || typeof source.revoked !== 'boolean' || (source.sequence === 0 ? source.contentHash !== null : !sha256(source.contentHash))) fail('Invalid source watermark');
    sources.set(source.id, source);
  }
  const ids = new Set(), coalesced = new Set();
  for (const row of value.pending) {
    exact(row, ['id', 'projectId', 'bindingId', 'sourceId', 'sourceRevision', 'sourceKind', 'sequence', 'contentHash', 'kind', 'summary', 'data', 'coalesceKey', 'observedAt', 'receivedAt', 'trust', 'instruction', 'coverage'], 'pending event');
    integer(row.sequence, 'event sequence', 1); integer(row.sourceRevision, 'event source revision', 1); instant(row.receivedAt, 'receivedAt');
    const source = sources.get(row.sourceId), content = contentFor(row, limits);
    if (!source || source.revoked || row.sourceRevision !== source.revision || row.sourceKind !== source.kind || row.sequence > source.sequence || row.projectId !== projectId || row.bindingId !== bindingId || row.trust !== 'untrusted' || row.instruction !== false || row.contentHash !== hash(content) || row.id !== eventId(row) || ids.has(row.id)) fail('Invalid pending event identity');
    if (row.sequence === source.sequence && row.contentHash !== source.contentHash) fail('Event disagrees with source watermark');
    exact(row.coverage, ['firstSequence', 'lastSequence', 'observations'], 'event coverage');
    integer(row.coverage.firstSequence, 'coverage start', 1, row.sequence); integer(row.coverage.lastSequence, 'coverage end', row.sequence, row.sequence); integer(row.coverage.observations, 'coverage count', 1, row.sequence - row.coverage.firstSequence + 1);
    if (row.coalesceKey !== undefined) { const key = canonicalJSON([row.sourceId, row.coalesceKey]); if (coalesced.has(key)) fail('Duplicate coalesced event'); coalesced.add(key); }
    ids.add(row.id);
  }
  if (value.checkpoint !== null) {
    exact(value.checkpoint, ['receiptId', 'at', 'eventIds'], 'checkpoint'); identifier(value.checkpoint.receiptId, 'checkpoint receipt'); instant(value.checkpoint.at, 'checkpoint at');
    if (!Array.isArray(value.checkpoint.eventIds) || !value.checkpoint.eventIds.length || value.checkpoint.eventIds.length > limits.maxPending || new Set(value.checkpoint.eventIds).size !== value.checkpoint.eventIds.length || value.checkpoint.eventIds.some(id => typeof id !== 'string' || !/^external-[a-f0-9]{64}$/.test(id) || ids.has(id))) fail('Invalid checkpoint events');
  }
  if (Buffer.byteLength(canonicalJSON(value)) > limits.maxStateBytes) fail('Inbox exceeds its byte limit', 'project_event_capacity');
  return clone(value);
}

/**
 * Create a single-owner inbox. saveState must atomically persist the complete
 * snapshot before resolving; a rejection blocks further delivery until reload.
 * Source sequence is an adapter-owned durable cursor, never a wall-clock age.
 */
export function createProjectEventInbox({ projectId, bindingId, limits: rawLimits, state, saveState, now = Date.now } = {}) {
  identifier(projectId, 'project id'); identifier(bindingId, 'workspace binding');
  if (typeof saveState !== 'function' || typeof now !== 'function') fail('A durable saveState and clock are required');
  const limits = limitsFor(rawLimits), context = { projectId, bindingId, limits };
  let confirmed = validateState(state ?? { version: PROJECT_EVENT_INBOX_VERSION, projectId, bindingId, revision: 0, sources: [], pending: [], checkpoint: null }, context);
  let chain = Promise.resolve(), blocked = false;
  const usable = () => { if (blocked) fail('Event persistence outcome is unconfirmed; reload the durable inbox before continuing', 'project_event_persistence_uncertain'); };
  const time = () => instant(now(), 'clock');
  const mutate = (operation, transition) => {
    const run = chain.then(async () => {
      usable();
      const draft = clone(confirmed), result = transition(draft);
      if (!result.changed) return clone(result.result);
      draft.revision = integer(confirmed.revision + 1, 'next inbox revision');
      const next = validateState(draft, context);
      try { await saveState(clone(next), { expectedRevision: confirmed.revision, nextRevision: next.revision, operation }); }
      catch (cause) { blocked = true; throw Object.assign(new ProjectEventError('Event checkpoint could not be confirmed; reload durable state', 'project_event_persistence_uncertain'), { cause }); }
      confirmed = next;
      return clone(result.result);
    });
    chain = run.catch(() => {});
    return run;
  };
  return {
    snapshot() { return clone(confirmed); },
    status() { return { persistence: blocked ? 'uncertain' : 'confirmed', revision: confirmed.revision, pending: confirmed.pending.length, sources: confirmed.sources.length, limits: clone(limits) }; },
    pending({ limit = limits.maxPending } = {}) { usable(); integer(limit, 'pending limit', 1, limits.maxPending); return clone(confirmed.pending.slice(0, limit)); },
    registerSource(input) {
      input = clone(input);
      return mutate('register_source', draft => {
        exact(input, ['id', 'revision', 'kind'], 'source registration'); identifier(input.id, 'source id'); identifier(input.kind, 'source kind'); integer(input.revision, 'source revision', 1);
        const previous = draft.sources.find(row => row.id === input.id);
        if (previous?.revoked) fail('A revoked source identity cannot be reused', 'project_event_source_revoked');
        if (previous && input.revision < previous.revision) return { changed: false, result: { status: 'stale', invalidatedEventIds: [] } };
        if (previous && input.revision === previous.revision) {
          if (input.kind !== previous.kind) fail('Source revision has conflicting configuration', 'project_event_source_conflict');
          return { changed: false, result: { status: 'unchanged', invalidatedEventIds: [] } };
        }
        if (!previous && draft.sources.length >= limits.maxSources) return { changed: false, result: { status: 'backpressure', invalidatedEventIds: [] } };
        const invalidatedEventIds = draft.pending.filter(row => row.sourceId === input.id).map(row => row.id);
        draft.pending = draft.pending.filter(row => row.sourceId !== input.id);
        const source = { ...input, revoked: false, sequence: 0, contentHash: null, updatedAt: time() };
        if (previous) draft.sources[draft.sources.indexOf(previous)] = source; else draft.sources.push(source);
        return { changed: true, result: { status: previous ? 'updated' : 'registered', invalidatedEventIds } };
      });
    },
    revokeSource(input) {
      input = clone(input);
      return mutate('revoke_source', draft => {
        exact(input, ['id', 'revision'], 'source revocation'); identifier(input.id, 'source id'); integer(input.revision, 'source revision', 1);
        const source = draft.sources.find(row => row.id === input.id);
        if (!source) fail('Cannot revoke an unregistered source', 'project_event_source_unknown');
        if (input.revision !== source.revision) return { changed: false, result: { status: 'stale', invalidatedEventIds: [] } };
        if (source.revoked) return { changed: false, result: { status: 'unchanged', invalidatedEventIds: [] } };
        const invalidatedEventIds = draft.pending.filter(row => row.sourceId === input.id).map(row => row.id);
        draft.pending = draft.pending.filter(row => row.sourceId !== input.id); source.revoked = true; source.updatedAt = time();
        return { changed: true, result: { status: 'revoked', invalidatedEventIds } };
      });
    },
    ingest(input) {
      input = clone(input);
      return mutate('ingest', draft => {
        exact(input, ['sourceId', 'sourceRevision', 'sequence', 'kind', 'summary', 'data', 'coalesceKey', 'observedAt'], 'event'); identifier(input.sourceId, 'source id'); integer(input.sourceRevision, 'source revision', 1); integer(input.sequence, 'event sequence', 1);
        const content = contentFor(input, limits), contentHash = hash(content), source = draft.sources.find(row => row.id === input.sourceId);
        if (!source) fail('Observation source is not registered', 'project_event_source_unknown');
        if (source.revoked) return { changed: false, result: { status: 'revoked' } };
        if (input.sourceRevision !== source.revision || input.sequence < source.sequence) return { changed: false, result: { status: 'stale' } };
        if (input.sequence === source.sequence) {
          if (contentHash !== source.contentHash) fail('Source sequence has conflicting content', 'project_event_sequence_conflict');
          return { changed: false, result: { status: 'duplicate' } };
        }
        const previous = input.coalesceKey === undefined ? undefined : draft.pending.find(row => row.sourceId === source.id && row.coalesceKey === input.coalesceKey);
        if (!previous && draft.pending.length >= limits.maxPending) return { changed: false, result: { status: 'backpressure' } };
        const event = { projectId, bindingId, sourceId: source.id, sourceRevision: source.revision, sourceKind: source.kind, sequence: input.sequence, contentHash, ...content, receivedAt: time(), trust: 'untrusted', instruction: false,
          coverage: { firstSequence: previous?.coverage.firstSequence ?? input.sequence, lastSequence: input.sequence, observations: (previous?.coverage.observations ?? 0) + 1 } };
        event.id = eventId(event);
        if (previous) draft.pending[draft.pending.indexOf(previous)] = event; else draft.pending.push(event);
        source.sequence = input.sequence; source.contentHash = contentHash; source.updatedAt = event.receivedAt;
        return { changed: true, result: { status: previous ? 'coalesced' : 'accepted', eventId: event.id, ...(previous ? { supersededEventId: previous.id } : {}), coverage: event.coverage } };
      });
    },
    checkpoint(input) {
      input = clone(input);
      return mutate('checkpoint', draft => {
        exact(input, ['eventIds', 'receiptId'], 'checkpoint request'); identifier(input.receiptId, 'checkpoint receipt');
        if (!Array.isArray(input.eventIds) || !input.eventIds.length || input.eventIds.length > limits.maxPending || new Set(input.eventIds).size !== input.eventIds.length || input.eventIds.some(id => typeof id !== 'string' || !/^external-[a-f0-9]{64}$/.test(id))) fail('Invalid checkpoint event IDs');
        const acknowledged = draft.pending.filter(row => input.eventIds.includes(row.id)).map(row => row.id);
        if (!acknowledged.length) return { changed: false, result: { status: 'unchanged', acknowledged: [] } };
        draft.pending = draft.pending.filter(row => !acknowledged.includes(row.id));
        draft.checkpoint = { receiptId: input.receiptId, eventIds: acknowledged, at: time() };
        return { changed: true, result: { status: 'checkpointed', acknowledged } };
      });
    },
  };
}
