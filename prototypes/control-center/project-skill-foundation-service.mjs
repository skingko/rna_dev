import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareScreenedSkillFoundation, deriveProjectTaskTypes } from '../../packages/sdk/src/skill-foundation-screen.mjs';
import { projectGenomeHash, validateProjectGenome } from '../../packages/sdk/src/project-genome.mjs';
import { ProjectGenomeStore } from './project-genome-store.mjs';
import { freezeAssignedInstalledSkills } from './installed-skill-freeze.mjs';
import { SkillMarketplaceService, referenceDiscoverySummary } from './skill-marketplace-service.mjs';
import { reserveRealTokens, releaseRealTokens, chargeRealTokens } from './budget-service.mjs';

const copy = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const identifier = value => typeof value === 'string' && !/[\0\r\n]/.test(value) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const codeOf = error => /^[A-Za-z0-9_-]{1,100}$/.test(error?.code ?? '') ? error.code : 'foundation_failed';
const count = value => Number.isFinite(value) && value >= 0 ? Math.ceil(value) : 0;
const emptyUsage = () => ({ totalTokens: 0, estimatedTokens: 0, reportedTokens: 0 });
const sourceIdentity = skill => { if (skill.source?.kind !== 'installed-skill-package') return projectGenomeHash(skill); const { frozenAt, reason, compatibility, ...source } = skill.source; return projectGenomeHash({ ...skill, source }); };
const sourceProof = frozen => hash({ scopeHash: frozen.scopeHash, imports: frozen.imports, diagnostics: frozen.diagnostics });
const selectedVersion = project => project?.versions?.find(row => row.id === project.activeVersionId);
const acquisitionPolicyOf = project => project?.skillFoundation?.acquisitionPolicy === 'reuse_only' ? 'reuse_only' : 'automatic';
const busy = (state, project) => Boolean(project?.trialVersionId || (state.sessions ?? []).some(row => row.projectId === project.id && row.activeTurnId) || project?.versions?.some(row => ['proposing', 'evaluating'].includes(row.state)) || ['queued', 'running'].includes(project?.evolution?.request?.status));
const basisHash = (state, project) => hash({ id: project.id, name: project.name, description: project.description, workspace: project.workspace, focus: project.focus, commitments: project.commitments, permissions: project.permissions, assignments: project.assignments, activeVersionId: project.activeVersionId, activeHash: selectedVersion(project)?.bundle?.hash,
  acquisitionPolicy: acquisitionPolicyOf(project),
  capabilities: (state.capabilities?.skills ?? []).filter(row => project.assignments?.skillIds?.includes(row.id)), installations: (state.capabilities?.installations ?? []).filter(row => (state.capabilities?.skills ?? []).some(skill => skill.installationId === row.installationId && project.assignments?.skillIds?.includes(skill.id))) });
const projectAt = (state, id) => state.projects.find(row => row.id === id);
const sourceCount = genome => genome.skills.filter(skill => skill.source).length;
// Compact, content-free projection for state/UI; the full receipt is screening.json.
const screeningSummary = receipt => ({ method: receipt.method, taskTypes: copy(receipt.taskTypes), pick: copy(receipt.pick ?? null), areas: receipt.areas.map(area => ({ id: area.id, taskType: area.taskType, query: area.query, candidates: area.candidates.length, picked: area.candidates.filter(row => row.screen === 'picked').length, selected: area.selected.map(row => ({ skillId: row.skillId, status: row.status })), ...(area.disposition ? { gap: area.disposition.reasonCode } : {}) })) });

export function foundationDue(project, state, { now = Date.now(), explicitRetry = false } = {}) {
  if (!project || project.archivedAt || project.simulated !== false || project.initialization?.status !== 'ready' || !selectedVersion(project)?.bundle?.genome || state && busy(state, project)) return false;
  const saved = project.skillFoundation;
  if (explicitRetry) return true;
  if (!saved || saved.status === 'queued') return true;
  if (['ready', 'partial', 'preparing'].includes(saved.status)) return false;
  return ['failed', 'stale'].includes(saved.status) && count(saved.failureCount) < 3 && Number(saved.nextRetryAt) > 0 && Number(saved.nextRetryAt) <= now;
}

function mergeInstalled(baseline, skills) {
  const merged = copy(baseline);
  for (const skill of skills) {
    const previous = merged.skills.find(row => row.id === skill.id);
    if (previous && sourceIdentity(previous) !== sourceIdentity(skill)) throw fail('foundation_source_conflict');
    if (!previous) merged.skills.push(copy(skill));
  }
  return validateProjectGenome(merged);
}
function checkAdditions(baseline, genome) {
  validateProjectGenome(genome);
  if (projectGenomeHash({ ...baseline, skills: [] }) !== projectGenomeHash({ ...genome, skills: [] })) throw fail('foundation_behavior_changed');
  for (const skill of baseline.skills) if (projectGenomeHash(genome.skills.find(row => row.id === skill.id)) !== projectGenomeHash(skill)) throw fail('foundation_behavior_changed');
  const additions = genome.skills.filter(skill => !baseline.skills.some(row => row.id === skill.id));
  if (additions.some(skill => !['installed-skill-package', 'marketplace-package'].includes(skill.source?.kind))) throw fail('foundation_source_required');
  return additions;
}
function nextAssignments(project, before, prepared) {
  const oldSkills = new Set([...(before.generatedSkills ?? before.skillManifests ?? []).map(row => row.id), ...project.versions.flatMap(version => [...(version.generatedSkills ?? version.skillManifests ?? []).map(row => row.id)])]);
  const oldTools = new Set(project.versions.flatMap(version => (version.generatedTools ?? version.toolDescriptors ?? []).map(row => row.id)));
  const previous = project.assignments ?? {}, keep = id => !oldSkills.has(id) && !oldTools.has(id);
  return { ...previous, skillIds: [...new Set([...(previous.skillIds ?? []).filter(id => !oldSkills.has(id)), ...prepared.skillManifests.map(row => row.id)])],
    toolIds: [...new Set([...(previous.toolIds ?? []).filter(id => !oldTools.has(id)), ...prepared.toolDescriptors.map(row => row.id)])], mcpServerIds: [...(previous.mcpServerIds ?? [])],
    reasons: [...(previous.reasons ?? []).filter(row => keep(row.id)), ...prepared.skillManifests.map(row => ({ kind: 'skill', id: row.id, reason: row.source ? '基础能力版本保留已核验来源的完整技能包；不代表已通过质量评估。' : '基础能力补齐保留原项目技能。' })), ...prepared.toolDescriptors.map(row => ({ kind: 'tool', id: row.id, reason: '基础能力补齐保留原项目工具及其权限。' }))] };
}

/** One explicit or scheduled legacy foundation operation. The initializer owns
 * scheduling; this service never subscribes, polls, or retries provider calls. */
export class ProjectSkillFoundationService {
  // Market-first foundation: search → name+description list → ONE JEV choice
  // (DecisionService.pickSkills) picks 2–3 → pinned install. `pick` is the host
  // JEV adapter; without a judge backend no package is chosen (gaps are recorded).
  constructor(store, { genomeStore = new ProjectGenomeStore(store), marketplaceService = new SkillMarketplaceService(store), freeze = freezeAssignedInstalledSkills, prepare = prepareScreenedSkillFoundation, pick = null, now = Date.now } = {}) {
    this.store = store; this.genomes = genomeStore; this.marketplaces = marketplaceService; this.freeze = freeze; this.prepare = prepare; this.pick = pick; this.now = now; this.running = new Map();
  }
  async run(project, { signal, model, apiKey, provider, prepare = this.prepare, explicitRetry = false } = {}) {
    const projectId = typeof project === 'string' ? project : project.id;
    if (!identifier(projectId)) throw fail('foundation_project_unavailable');
    const initial = projectAt(this.store.state, projectId), prior = initial?.skillFoundation;
    if (!initial || initial.archivedAt || initial.simulated !== false || initial.initialization?.status !== 'ready' || !selectedVersion(initial)?.bundle?.genome) throw fail('foundation_project_unavailable');
    if (this.running.has(projectId) || busy(this.store.state, initial) || this.store.maintenanceHeld || this.store.state.emergency) return { status: 'deferred', code: 'foundation_busy' };
    if (!explicitRetry && ['ready', 'partial', 'preparing'].includes(prior?.status)) return { status: prior.status, replayed: true, foundation: copy(prior) };
    if (!explicitRetry && (count(prior?.failureCount) >= 3 || Number(prior?.nextRetryAt) > this.now())) return { status: 'deferred', code: 'foundation_retry_deferred', foundation: copy(prior) };
    const operationId = randomUUID(), basisVersionId = initial.activeVersionId, basis = basisHash(this.store.state, initial), acquisitionPolicy = acquisitionPolicyOf(initial), attemptedAt = new Date(this.now()).toISOString();
    const controller = new AbortController(), mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const current = { operationId, controller }; this.running.set(projectId, current);
    const dir = resolve(`${this.store.file}.skill-foundation`, projectId, operationId), reservationPrefix = `skill-foundation:${projectId}:${operationId}:`;
    let prepared, publicationAttempted = false, published = false, expectedPublication, references, frozen, baselineRecord, claimed = false;
    const requests = [], usage = emptyUsage(); let requestArtifact = Promise.resolve();
    const guard = (state = this.store.state) => {
      mergedSignal.throwIfAborted(); const target = projectAt(state, projectId);
      if (!target || target.archivedAt || target.initialization?.status !== 'ready' || this.store.maintenanceHeld || state.emergency || busy(state, target) || basisHash(state, target) !== basis) throw fail('foundation_stale');
      if (claimed && target.skillFoundation?.operationId !== operationId) throw fail('foundation_stale');
      return target;
    };
    const artifact = async (name, value) => { await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); };
    const track = event => {
      if (event.type === 'foundation_request_start') { this.store.mutate(state => { const target = guard(state), row = target.skillFoundation.requests.find(row => row.requestId === event.requestId); if (!row || row.settled) throw fail('foundation_request_identity'); row.requestStarted = true; }); const row = requests.find(row => row.requestId === event.requestId); if (row) row.requestStarted = true; }
      if (event.type !== 'foundation_request_end') return;
      const row = requests.find(row => row.requestId === event.requestId);
      // Provider observations and the durable accounting ledger are separate.
      // A failed fsync cannot erase known usage or cause a second charge when
      // failure cleanup sees the same request again.
      if (row?.observationRecorded) return;
      if (!row && event.admitted === true) throw fail('foundation_request_identity');
      const tokens = count(event.usage?.totalTokens), estimated = Math.min(tokens, count(event.usage?.estimatedTokens));
      const receipt = { requestId: event.requestId, requestIndex: event.requestIndex, estimatedTokens: count(event.estimatedTokens ?? row?.estimatedTokens), admitted: event.admitted === true, requestStarted: event.requestStarted === true, completed: event.completed === true, usageReported: event.usageReported === true, cancelledBeforeSend: event.cancelledBeforeSend === true, usage: copy(event.usage ?? { totalTokens: 0, estimatedTokens: 0 }), observationRecorded: true, settled: false, ledger: { status: 'pending' } };
      if (row) Object.assign(row, receipt); else requests.push(receipt);
      const observation = row ?? receipt;
      usage.totalTokens += tokens; usage.estimatedTokens += estimated; usage.reportedTokens += tokens - estimated;
      try {
        const settled = { ...copy(receipt), settled: true, ledger: { status: 'settled' } };
        this.store.mutate(state => {
          const target = projectAt(state, projectId), saved = target?.skillFoundation?.operationId === operationId ? target.skillFoundation.requests : null;
          if (saved?.find(row => row.requestId === event.requestId)?.settled) return;
          releaseRealTokens(state, `${reservationPrefix}${event.requestId}`, { now: this.now() }); chargeRealTokens(state, tokens - estimated, { now: this.now() }); chargeRealTokens(state, estimated, { estimated: true, now: this.now() });
          if (saved) { const index = saved.findIndex(row => row.requestId === event.requestId); if (index < 0) saved.push(copy(settled)); else saved[index] = copy(settled); }
        });
        Object.assign(observation, settled);
      } catch (error) {
        const target = projectAt(this.store.state, projectId), saved = target?.skillFoundation?.operationId === operationId ? target.skillFoundation.requests.find(row => row.requestId === event.requestId) : undefined;
        observation.ledger = { status: 'unknown', persistenceCode: codeOf(error), settlementVisible: saved?.settled === true && hash(saved.usage) === hash(observation.usage), retryCharge: false };
        throw error;
      } finally {
        const frozen = copy(observation);
        requestArtifact = requestArtifact.then(() => artifact(`request-${event.requestIndex ?? requests.length}-${event.requestId}.json`, frozen));
        // onEvent is synchronous; surface an artifact write failure at the next
        // awaited boundary without an unhandled rejection during provider work.
        requestArtifact.catch(() => {});
      }
    };
    const settlePending = () => {
      if (this.store.persistence?.failed) return;
      for (const row of requests.filter(row => !row.observationRecorded)) track({ type: 'foundation_request_end', requestId: row.requestId, requestIndex: row.requestIndex, admitted: true, requestStarted: row.requestStarted, completed: false, usageReported: false, cancelledBeforeSend: !row.requestStarted,
        usage: { totalTokens: row.requestStarted ? row.estimatedTokens : 0, estimatedTokens: row.requestStarted ? row.estimatedTokens : 0 } });
    };
    const finalState = (status, extra = {}) => ({ schemaVersion: 1, operationId, status, basisVersionId, sourceHash: basis, acquisitionPolicy, attemptedAt, completedAt: new Date(this.now()).toISOString(), artifactDir: dir, failureCount: explicitRetry ? 0 : count(prior?.failureCount), usage: copy(usage), requests: copy(requests), evaluationPerformed: false, qualityClaim: 'none', ...extra });
    try {
      mergedSignal.throwIfAborted();
      this.store.mutate(state => { const target = guard(state); target.skillFoundation = { ...finalState('preparing'), completedAt: undefined }; });
      claimed = true;
      baselineRecord = await this.genomes.read(projectId, basisVersionId); guard();
      if (baselineRecord.hash !== selectedVersion(initial).bundle.hash) throw fail('foundation_stale');
      const baseline = validateProjectGenome(baselineRecord.genome);
      frozen = await this.freeze(this.store, projectId, { signal: mergedSignal }); guard();
      const merged = mergeInstalled(baseline, frozen.skills), installedInputs = frozen.skills.map(skill => merged.skills.find(row => row.id === skill.id));
      references = this.marketplaces.authoring(projectId, { baseline: merged, purpose: 'foundation', allowAcquisition: acquisitionPolicy !== 'reuse_only' });
      await artifact('inputs.json', { projectId, operationId, basisVersionId, baselineHash: baselineRecord.hash, sourceHash: basis, acquisitionPolicy, importedSources: frozen.imports, importDiagnostics: frozen.diagnostics, scopeHash: frozen.scopeHash, sourceCountBefore: sourceCount(baseline) });
      const taskTypes = deriveProjectTaskTypes({ title: initial.name, description: initial.description, focus: initial.focus, taskTypes: initial.taskTypes });
      const result = await prepare({ project: { id: projectId, title: initial.name, description: initial.description, focus: initial.focus, skillQueries: Array.isArray(initial.skillQueries) ? [...initial.skillQueries] : undefined, constraints: copy(initial.commitments ?? []), skillFoundation: { acquisitionPolicy } }, taskTypes, ...(this.pick ? { pick: input => this.pick({ ...input, projectId, signal: mergedSignal }) } : {}), baseline, existingInstalledSkills: installedInputs, model, apiKey, ...(provider ? { provider } : {}), signal: mergedSignal,
        referenceTools: references.tools, referencePolicy: references.policy, referenceContext: references.context,
        beforeRequest: async ({ requestId, requestIndex, estimatedTokens }) => {
          guard(); if (requests.some(row => row.requestId === requestId)) throw fail('foundation_request_identity');
          const pending = { requestId, requestIndex, estimatedTokens, requestStarted: false, settled: false };
          this.store.mutate(state => { const target = guard(state); reserveRealTokens(state, `${reservationPrefix}${requestId}`, estimatedTokens, { now: this.now() }); target.skillFoundation.requests.push(copy(pending)); });
          requests.push(pending);
        }, onEvent: track });
      guard(); if (requests.some(row => !row.settled)) throw fail('foundation_request_incomplete'); await requestArtifact;
      const finalGenome = validateProjectGenome(result.genome), additions = checkAdditions(baseline, finalGenome);
      // Independently reapply the host source policy. A custom SDK hook cannot
      // introduce a source merely by returning a hash-consistent forged object.
      const verified = validateProjectGenome(await references.policy.finalizeGenome(copy(merged)));
      if (projectGenomeHash(verified) !== projectGenomeHash(finalGenome)) throw fail('foundation_source_conflict');
      // Ready: every area selected with ≥2 distinct packages (unchanged), or every
      // area closed by a selection or an evidence-backed "nothing fits / nothing
      // found" screen result with ≥1 package. Unavailable/needs-selection stay partial.
      const discovery = references.snapshot(), coverage = copy(discovery.coverage ?? []), distinct = new Set(coverage.flatMap(row => row.skillIds ?? [])).size;
      const complete = coverage.length >= 2 && (coverage.every(row => row.status === 'selected') && distinct >= 2 || distinct >= 1 && coverage.every(row => row.status === 'selected' || row.status === 'deferred' && ['screened_out', 'no_results'].includes(row.reasonCode)));
      const status = complete ? 'ready' : 'partial', referenceDiscovery = referenceDiscoverySummary(discovery);
      await artifact('reference-sources.json', discovery);
      const latestBase = await this.genomes.read(projectId, basisVersionId); if (latestBase.hash !== baselineRecord.hash) throw fail('foundation_stale');
      const latestFreeze = await this.freeze(this.store, projectId, { signal: mergedSignal }); if (sourceProof(latestFreeze) !== sourceProof(frozen)) throw fail('foundation_stale'); guard();
      if (result.screening) await artifact('screening.json', result.screening);
      const state = finalState(status, { coverage, sourceCount: sourceCount(finalGenome), diagnostics: copy(frozen.diagnostics), referenceDiscovery, imports: copy(frozen.imports), addedSkillIds: additions.map(row => row.id), ...(result.screening ? { screening: screeningSummary(result.screening) } : {}) });
      if (!additions.length) {
        state.versionId = basisVersionId;
        await artifact('result.json', { ...state, added: false, versionId: basisVersionId });
        this.store.mutate(snapshot => { guard(snapshot).skillFoundation = { ...state, versionId: basisVersionId }; });
        return { status, added: false, foundation: copy(state) };
      }
      const versionId = randomUUID(); prepared = await this.genomes.prepare(initial, { genome: finalGenome, versionId, parentVersionId: basisVersionId, signal: mergedSignal });
      guard(); await artifact('result.json', { ...state, versionId, added: true, genomeHash: prepared.record.hash, publication: 'prepared_not_committed' });
      await prepared.commit(); guard();
      const expectedAssignments = nextAssignments(initial, selectedVersion(initial), prepared);
      expectedPublication = { versionId, hash: prepared.record.hash, recordHash: hash(prepared.record), assignments: copy(expectedAssignments), skillManifests: copy(prepared.skillManifests) }; publicationAttempted = true;
      this.store.mutate(snapshot => {
        const target = guard(snapshot), config = snapshot.capabilities;
        if (!config || !Array.isArray(config.skills)) throw fail('foundation_capabilities_unavailable');
        // Generated names are the project's, stable across versions (EVO-3): this project's own managed manifest of the
        // same id is replaced (one manifest per id); a row of that id from anywhere else is a real conflict.
        const incoming = new Set(prepared.skillManifests.map(skill => skill.id));
        if (config.skills.some(row => incoming.has(row.id) && !(row.managed === 'project-genome' && row.projectId === target.id))) throw fail('foundation_version_conflict');
        snapshot.capabilities.skills = [...config.skills.filter(row => !incoming.has(row.id)), ...copy(prepared.skillManifests)]; config.revision = count(config.revision) + 1;
        target.assignments = copy(expectedAssignments); target.capabilityRevision = count(target.capabilityRevision) + 1;
        const retainedIds = new Set([...expectedAssignments.skillIds, ...expectedAssignments.toolIds]);
        target.capabilitySnapshot = { ...(target.capabilitySnapshot ?? {}), skillHashes: { ...Object.fromEntries(Object.entries(target.capabilitySnapshot?.skillHashes ?? {}).filter(([id]) => retainedIds.has(id))), ...Object.fromEntries(prepared.skillManifests.map(row => [row.id, row.contentHash])) },
          tools: [...(target.capabilitySnapshot?.tools ?? []).filter(row => expectedAssignments.toolIds.includes(row.id) && !prepared.toolDescriptors.some(next => next.id === row.id)), ...copy(prepared.toolDescriptors)] };
        const version = { id: versionId, version: `foundation-${target.versions.length}`, title: status === 'ready' ? '基础技能已补齐' : '基础技能已补充 · 仍有缺口', state: 'active', source: 'skill-foundation', parentVersionId: basisVersionId, bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors,
          systemPrompt: finalGenome.systemPrompt, evaluationSuite: finalGenome.evaluationSuite, assignments: copy(expectedAssignments), createdAt: new Date(this.now()).toISOString(), simulated: false, artifactDir: dir, referenceDiscovery, skillFoundation: { ...state, versionId }, evaluation: null, evaluationPerformed: false, qualityClaim: 'none' };
        target.versions.push(version); target.activeVersionId = versionId; target.skillFoundation = { ...state, versionId }; target.updatedAt = new Date(this.now()).toISOString();
      });
      published = true; await artifact('publication.json', { versionId, genomeHash: prepared.record.hash, publication: 'committed', evaluationPerformed: false });
      return { status, added: true, versionId, foundation: copy(projectAt(this.store.state, projectId).skillFoundation) };
    } catch (error) {
      const exactPublished = () => {
        const target = projectAt(this.store.state, projectId), version = target?.versions.find(row => row.id === expectedPublication?.versionId);
        return expectedPublication && target.activeVersionId === expectedPublication.versionId && target.skillFoundation?.operationId === operationId && version?.source === 'skill-foundation' && version.parentVersionId === basisVersionId && version.bundle?.hash === expectedPublication.hash && hash(version.bundle) === expectedPublication.recordHash && hash(target.assignments) === hash(expectedPublication.assignments) && expectedPublication.skillManifests.every(skill => (this.store.state.capabilities?.skills ?? []).some(row => row.id === skill.id && hash(row) === hash(skill)));
      };
      if (publicationAttempted && error.committed === true && exactPublished()) { published = true; await artifact('publication-uncertain.json', { code: 'foundation_durability_unknown', versionId: expectedPublication.versionId, filesRetained: true }).catch(() => {}); throw Object.assign(fail('foundation_durability_unknown'), { committed: true, versionId: expectedPublication.versionId }); }
      if (prepared && !published) await prepared.rollback();
      settlePending();
      const stale = mergedSignal.aborted || codeOf(error).includes('stale') || codeOf(error) === 'installed_skill_scope_changed';
      const failureCount = stale ? count(prior?.failureCount) : (explicitRetry ? 0 : count(prior?.failureCount)) + 1;
      const state = finalState(stale ? 'stale' : 'failed', { code: codeOf(error), failureCount, nextRetryAt: stale || codeOf(error) === 'marketplace_rate_limit' ? this.now() + 60 * 60 * 1000 : failureCount < 3 ? this.now() + 6 * 60 * 60 * 1000 : null, sourceCount: baselineRecord ? sourceCount(baselineRecord.genome) : 0, diagnostics: copy(frozen?.diagnostics ?? []), ...(references ? { referenceDiscovery: referenceDiscoverySummary(references.snapshot()) } : {}) });
      await requestArtifact.catch(() => {}); await artifact('failure.json', state).catch(() => {});
      if (references) await artifact('reference-sources-failed.json', references.snapshot()).catch(() => {});
      if (!published && !this.store.persistence?.failed) this.store.mutate(snapshot => { const target = projectAt(snapshot, projectId); if (target?.skillFoundation?.operationId === operationId) target.skillFoundation = { ...state, acquisitionPolicy: acquisitionPolicyOf(target) }; });
      if (published) throw error;
      return { status: state.status, code: state.code, foundation: state };
    } finally {
      // SDK normally settles every admission, including failures. Only an
      // interrupted/custom lifecycle may leave an outstanding reservation.
      try { settlePending(); await requestArtifact.catch(() => {}); } finally { this.running.delete(projectId); }
    }
  }
  close() { for (const current of this.running.values()) current.controller.abort(); }
}
