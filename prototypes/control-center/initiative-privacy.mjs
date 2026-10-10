import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// The privacy identity of a project's initiative (PDL-1/MEM-2) and what the project's own records say about its folder.
// Shared by the initiative controller (its scope, the drift restore, legacy adoption) and the memory evidence restore.

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ACTION_CONTRACT_REVISION = 'rna-project-actions-v3';
/**
 * Privacy: the action contract, the project's identity, its workspace folder and that folder's identity as the
 * directory observer knows it. A change revokes what the old scope produced (`privacyRevoked`).
 */
export function initiativePrivacyInputs(project) {
  const directorySource = project.observationSources?.find(row => row.id === 'workspace');
  const directoryAuthority = directorySource?.identityRevoked || directorySource?.sourceRevision > 1 ? [{ workspaceSourceRevision: directorySource.sourceRevision ?? 1, identityRevoked: directorySource.identityRevoked === true }] : [];
  return ['initiative-privacy-v1', ACTION_CONTRACT_REVISION, project.id, project.workspace, ...directoryAuthority];
}
/** The directory observer's binding of the project folder (project-observation-service.mjs `binding`). */
export const workspaceBinding = project => typeof project?.workspace === 'string' && project.workspace ? hash([project.id, resolve(project.workspace)]) : null;
const REBIND_REASONS = new Set(['workspace_source_changed', 'workspace_root_changed']);
/**
 * What the project's records say about its folder having changed. Before the scope split (≤ 0.64) a folder move or a
 * folder identity change rotated the same single hash as drift and left the same bare `contextRevoked`, so this is
 * all a migration has to tell them apart: the directory observer's source (its revision is bumped and its identity
 * held when the folder identity changes) and its retained workspace_change observations (each names the binding and
 * source revision it was observed under; a rebind withdraws the stale ones with a workspace_* reason).
 * - changed: the records show the folder or its identity changed at some point;
 * - previous: the evidence ids (`observation:<id>`) of observations made under an earlier folder or identity;
 * - lastPrevious: the latest time (ms) an earlier folder or identity was observed, -Infinity when unknown;
 * - currentSince: the earliest time (ms) the current folder and identity were observed, Infinity when never (or held).
 * Best effort: a move that left no observation (the observer off, or its rows archived) leaves no trace.
 */
export function workspaceHistory(project) {
  const source = project?.observationSources?.find(row => row.id === 'workspace');
  const binding = workspaceBinding(project), revision = source?.sourceRevision ?? 1, held = source?.identityRevoked === true;
  const previous = new Set(); let lastPrevious = -Infinity, currentSince = Infinity;
  for (const row of project?.observations ?? []) {
    if (row?.kind !== 'workspace_change' || typeof row.data?.source?.bindingId !== 'string') continue;
    const at = Date.parse(row.createdAt ?? '');
    const current = !held && row.data.source.bindingId === binding && (row.data.source.revision ?? 1) === revision && !REBIND_REASONS.has(row.data.revocationReason);
    if (current) { if (at < currentSince) currentSince = at; continue; }
    previous.add(`observation:${row.id}`);
    if (at > lastPrevious) lastPrevious = at;
  }
  return { changed: held || revision > 1 || previous.size > 0, previous, lastPrevious, currentSince };
}
/**
 * In which folder something was made, by the records: 'current', 'previous' or 'unknown'. `privacyScope`/`scope`: a
 * job recorded since 0.65 names the privacy scope it ran under, which settles it. Otherwise it is 'previous' when it
 * cites an observation of an earlier folder or was made no later than one was last observed, 'current' when nothing
 * shows a change or it was made once the current folder was observed, and 'unknown' in between.
 */
export function workspaceEra(history, { at, evidenceIds = [], privacyScope = null, scope = null } = {}) {
  if (typeof privacyScope === 'string' && typeof scope === 'string') return privacyScope === scope ? 'current' : 'previous';
  if ((Array.isArray(evidenceIds) ? evidenceIds : []).some(id => history.previous.has(id))) return 'previous';
  if (!history.changed) return 'current';
  if (Number.isFinite(at) && at >= history.currentSince) return 'current';
  if (Number.isFinite(at) && at <= history.lastPrevious) return 'previous';
  return 'unknown';
}
