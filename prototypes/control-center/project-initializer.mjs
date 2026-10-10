import { createHash, randomUUID } from 'node:crypto';
import { reasoningFor, setupEffortInput } from './internal-reasoning.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapProject, projectBootstrapSchema, ProviderError, SDK_VERSION } from '../../packages/sdk/src/index.mjs';
import { bootstrapProjectLite } from '../../packages/sdk/src/bootstrap-lite.mjs';
import { SkillMarketplaceService, referenceDiscoverySummary } from './skill-marketplace-service.mjs';
import { smokeProjectGenome, validateProjectGenome } from '../../packages/sdk/src/project-genome.mjs';
import { resolveModel } from './configuration.mjs';
import { builtinSkills, projectWorkspace } from './capability-service.mjs';
import { ProjectGenomeStore } from './project-genome-store.mjs';
import { createProjectSchedule } from '../../packages/sdk/src/project-schedules.mjs';
import { projectScheduleDefaults, scheduleRuleText, runTime } from './project-schedule-service.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { initialScheduleIntent } from './project-schedule-intent.mjs';
import { reserveRealTokens, releaseRealTokens, chargeRealTokens } from './budget-service.mjs';
import { readProjectOrientation } from '../../packages/sdk/src/project-context.mjs';
import { prepareJudgmentPolicy, validJudgmentPolicy, judgmentPolicyEnabled } from './judgment-policy-service.mjs';
import { ProjectSkillFoundationService, foundationDue } from './project-skill-foundation-service.mjs';
import { purposeProvider } from './usage-cache-service.mjs';

const sourceHash = project => createHash('sha256').update(JSON.stringify([project.name, project.description, project.workspace])).digest('hex');
const now = () => new Date().toISOString();
const finishReasonDiagnostic = value => value === undefined ? undefined : new ProviderError('', { providerFinishReason: value }).providerFinishReason;
// SDK generators report their own request lifecycle (reservations, usage); injected test generators do not.
const SDK_GENERATORS = new Set([bootstrapProject, bootstrapProjectLite]);
const MAX_PARALLEL = 3;
const hasBundle = project => project.versions?.some(version => version.id === project.activeVersionId && version.bundle?.schemaVersion === 1 && version.bundle.genome);
const projectSessions = (state, project) => state.sessions.filter(session => session.projectId === project.id && !session.archivedAt);
const mayMigrate = (state, project) => !project.initialization && project.simulated !== false && projectSessions(state, project).some(session => session.turns?.some(turn => turn.modelConfig?.execution === 'rna'));
const generatedId = id => /^gen-[a-f0-9]{16}-|^gen_[a-f0-9]{8}_/.test(id);
/**
 * The first message of an initialized project, in the interface language. The schedules it saved are named as the user
 * reads a schedule (每天 09:00；下次 10月3日 09:00), never as the rule's JSON or a UTC instant.
 */
function initializationMessage(result, { addedSchedules, scheduleWarnings, language }) {
  const say = (zh, en) => inLanguage(language, { zh, en }), count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const cases = result.genome.evaluationSuite.cases.length, skills = result.genome.skills.length, tools = result.genome.tools.length;
  const built = result.method === 'brief-v1'
    ? say(`已根据项目标题与介绍写好项目说明和工作方法，并设定了 ${cases} 个示例任务作为初始评估；基础技能会从技能市场挑选安装，项目专用工具在后续使用中逐步生成。`, `Wrote the project brief and working method from its title and description, with ${count(cases, 'sample task')} as the first evaluation. Basic skills will be picked from the skill marketplace; project tools are made as the project is used.`)
    : say(`已根据项目标题与介绍创建系统说明、${skills} 项项目技能和 ${tools} 个自动化工具，并实际执行通过工具冒烟校验。初始评估标准包含 ${cases} 个案例，可在项目版本中编辑为新版本。`, `Created the project brief, ${count(skills, 'project skill')} and ${count(tools, 'automation tool')} from its title and description, and ran the tools once to check them. The first evaluation has ${count(cases, 'case')}; edit it as a new version under the project's versions.`);
  const line = row => { const next = row.nextRunAt ? runTime(row.nextRunAt, row.rule?.timeZone ?? projectScheduleDefaults().timeZone, language) : ''; return say(`• ${row.title}：${scheduleRuleText(row.rule, 'zh')}${next ? `；下次 ${next}` : ''}`, `• ${row.title}: ${scheduleRuleText(row.rule, 'en')}${next ? `; next run ${next}` : ''}`); };
  return [result.overview, built, say(`当前关注：${result.focus}`, `Current focus: ${result.focus}`),
    ...(addedSchedules.length ? [`${say(`已保存 ${addedSchedules.length} 项定时任务（未指定时间时采用应用默认值，可在项目设置修改）：`, `Saved ${count(addedSchedules.length, 'scheduled task')} (a time you did not give uses the app default; change it in the project settings):`)}\n${addedSchedules.map(line).join('\n')}`] : []),
    ...(scheduleWarnings.length ? [say(`${scheduleWarnings.length} 项日程建议未注册：与用户明确限制或已有日程冲突，或缺少用户需求来源。请在项目日程中查看当前实际安排。`, `Not registered: ${count(scheduleWarnings.length, 'suggested schedule')}, because of a limit you set or an existing schedule, or with no request of yours behind it. The project's schedules show what is actually arranged.`)] : []),
    ...(result.openQuestions.length ? [`${say('需要澄清：', 'To clarify:')}\n${result.openQuestions.map(question => `• ${question}`).join('\n')}`] : [])].join('\n\n');
}
function externalAssignments(value, managedIds) {
  if (!value) return value;
  const kept = id => !generatedId(id) && !managedIds.has(id);
  return { ...value, skillIds: (value.skillIds ?? []).filter(kept), toolIds: (value.toolIds ?? []).filter(kept), reasons: (value.reasons ?? []).filter(reason => kept(reason.id)) };
}
const memoryDeclarations = () => [
  { name: 'openviking_search', description: 'Search the candidate summaries of memory related to the current project; expand the overview and the original as needed.', parameters: { type: 'object', properties: { query: { type: 'string' }, level: { enum: ['L0', 'L1', 'L2'] } }, required: ['query'], additionalProperties: false }, execute: () => { throw new Error('Initialization only catalogs existing capabilities.'); } },
  { name: 'openviking_read', description: 'Using the viking:// URI (uri/expandUri) of an openviking_search result or a memory candidate, read a directory overview or a memory file original of the current project memory as needed. Use project_read for file paths of workspace source, documents and the like.', parameters: { type: 'object', properties: { uri: { type: 'string', description: 'A viking:// URI (uri/expandUri) from a current-project memory search result or candidate.' }, level: { enum: ['L0', 'L1', 'L2'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['uri'], additionalProperties: false }, execute: () => { throw new Error('Initialization only catalogs existing capabilities.'); } }
];
function mergeAssignments(...values) {
  const result = { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] };
  for (const value of values) if (value) {
    for (const key of ['skillIds', 'toolIds', 'mcpServerIds']) for (const id of value[key] ?? []) if (!result[key].includes(id)) result[key].push(id);
    for (const reason of value.reasons ?? []) if (!result.reasons.some(item => item.kind === reason.kind && item.id === reason.id)) result.reasons.push(reason);
  }
  return result;
}
function preservedState(project, state) {
  const authenticMetadata = project.simulated === false && project.initialization?.sourceWasDemo !== true;
  const messages = projectSessions(state, project).flatMap(session => (session.items ?? []).filter(item => item.kind === 'user' && item.source !== 'demo-event').map(item => ({ id: item.id, sessionId: session.id, text: String(item.text ?? '').slice(0, 1500), createdAt: item.createdAt, source: 'user-conversation' }))).sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  const userMessageIds = new Set(messages.map(item => item.id));
  const usable = row => row.source !== 'demo-event' && (row.source === 'conversation' || row.simulated === false || userMessageIds.has(row.messageId));
  const evidence = row => ({ id: row.id, text: String(row.text ?? '').slice(0, 1500), source: row.source ?? 'recorded-project-evidence', ...(row.evidenceId ? { evidenceId: row.evidenceId } : {}), ...(row.messageId ? { messageId: row.messageId } : {}), provenance: row.source === 'conversation' || userMessageIds.has(row.messageId) ? 'user-conversation' : 'recorded-non-simulated-evidence' });
  return { overview: authenticMetadata ? project.overview ?? '' : '', focus: project.focus ?? '', facts: (project.facts ?? []).filter(usable).slice(-30).map(evidence), openQuestions: authenticMetadata ? (project.openQuestions ?? []).slice(-20) : [], milestones: (project.milestones ?? []).filter(row => row.simulated === false || authenticMetadata && row.simulated !== true).slice(-20).map(row => ({ title: row.title, description: row.description, status: row.status })), commitments: (project.commitments ?? []).filter(usable).slice(-20).map(evidence), userMessages: messages.slice(-20), provenanceNote: 'Legacy simulated observations are omitted. Conversation evidence is user input, not proof of implementation or execution. Recorded facts retain their source and may still be mistaken. Focus is the current editable project setting.' };
}
export class ProjectInitializer {
  constructor(store, capabilityService, { generate = bootstrapProjectLite, genomeStore = new ProjectGenomeStore(store), marketplaceService = new SkillMarketplaceService(store), autoFoundation = true, foundationService, isBusy = () => false, decisions = null } = {}) {
    // decisions: the judge of setup's reasoning effort (internal reasoning); none in hosts without one.
    this.decisions = decisions;
    this.store = store; this.capabilities = capabilityService; this.generate = generate; this.genomes = genomeStore; this.marketplaces = marketplaceService; this.running = new Map(); this.closed = false;
    this.autoFoundation = autoFoundation; this.foundation = foundationService ?? new ProjectSkillFoundationService(store, { genomeStore, marketplaceService }); this.isBusy = isBusy;
    if (autoFoundation && store.state.projects.some(project => project.skillFoundation?.status === 'preparing')) store.mutate(state => { for (const project of state.projects) if (project.skillFoundation?.status === 'preparing') Object.assign(project.skillFoundation, { status: 'stale', code: 'foundation_interrupted', nextRetryAt: Date.now() + 3600000, message: '上次基础技能准备未完成，当前已生效能力保留；不会重放未确认操作。' }); });
    this.unsubscribe = store.subscribe(() => this.schedule(), { display: false }); this.schedule();
  }
  modelFor(project) {
    const session = projectSessions(this.store.state, project).find(session => session.id === project.primarySessionId);
    return resolveModel(this.store.state.configuration, session?.modelSelection?.providerId && session.modelSelection.providerId !== 'demo' ? session.modelSelection : null);
  }
  schedule() { if (this.scheduled || this.closed) return; this.scheduled = true; queueMicrotask(() => { this.scheduled = false; if (!this.closed) this.pump(); }); }
  pump() {
    for (const [id, current] of this.running) { const project = this.store.state.projects.find(p => p.id === id); if (this.store.state.emergency || !project || project.archivedAt || sourceHash(project) !== current.hash || current.foundation && (projectSessions(this.store.state, project).some(session => session.activeTurnId) || this.isBusy(id))) current.controller.abort(); }
    // Several projects initialize side by side; one slow project never queues the others.
    if (this.store.maintenanceHeld || this.store.state.emergency || this.running.size >= MAX_PARALLEL) return;
    let project = this.store.state.projects.find(project => {
      if (project.archivedAt || this.running.has(project.id)) return false;
      // A queued (new or retried) initialization never waits for conversation: turns pin their project
      // version at start. Upgrading a legacy/demo project still waits until its active turn ends.
      if (project.initialization?.status === 'queued') return true;
      if (projectSessions(this.store.state, project).some(session => session.activeTurnId)) return false;
      if (!hasBundle(project) && mayMigrate(this.store.state, project)) return true;
      if (project.initialization?.status !== 'blocked' || project.initialization.reason !== 'configured_model_required') return false;
      try { return this.modelFor(project).execution === 'rna'; } catch { return false; }
    });
    let foundation = false;
    if (!project && this.autoFoundation) { project = this.store.state.projects.find(project => !this.running.has(project.id) && hasBundle(project) && !this.isBusy(project.id) && foundationDue(project, this.store.state)); foundation = Boolean(project); }
    if (!project) return;
    let available; try { available = this.modelFor(project).execution === 'rna'; } catch { available = false; }
    if (!available) { if (foundation) return; this.store.mutate(state => { const target = state.projects.find(p => p.id === project.id); target.initialization = { ...target.initialization, status: 'blocked', reason: 'configured_model_required', message: '请先配置并选择真实模型，再初始化项目。' }; }); return; }
    const current = { projectId: project.id, hash: sourceHash(project), migration: Boolean(project.versions?.length || project.facts?.length || projectSessions(this.store.state, project).some(session => session.turns?.length)), controller: new AbortController() };
    current.foundation = foundation;
    this.running.set(project.id, current);
    const run = async () => { if (!foundation) return this.run(project, current); const model = this.modelFor(project), provider = this.store.state.configuration.providers.find(row => row.id === model.providerId); return this.foundation.run(project, { signal: current.controller.signal, model, apiKey: this.store.configurationService.secret(provider.id, provider), provider: purposeProvider(this.store, undefined, 'skill-foundation', { projectId: project.id }) }); };
    current.promise = run().catch(error => { this.lastError = error.code ?? 'foundation_failed'; }).finally(() => { this.running.delete(project.id); this.schedule(); });
    this.schedule();
  }
  async run(project, current) {
    let registry, reportedUsage, prepared, published = false, modelRequested = false, reserved = 0, requestTracking = false, pendingRequest = false, chargedReported = 0, chargedEstimated = 0;
    let validationFile, repairEvidenceCount = 0, expectedPublication;
    const reservationKey = `initialize:${project.id}`;
    const judgmentPolicyRevision = project.judgmentPolicy?.revision ?? null;
    const settleUsage = () => {
      const total = Math.max(0, Number(reportedUsage?.totalTokens) || 0), estimated = Math.min(total, Math.max(0, Number(reportedUsage?.estimatedTokens) || 0)), reported = total - estimated;
      this.store.mutate(state => {
        releaseRealTokens(state, reservationKey);
        chargeRealTokens(state, Math.max(0, reported - chargedReported));
        chargeRealTokens(state, Math.max(0, estimated - chargedEstimated), { estimated: true });
        const target = state.projects.find(p => p.id === current.projectId);
        if (target?.initialization && reportedUsage) { target.initialization.usage = structuredClone(reportedUsage); delete target.initialization.estimatedUsage; }
      });
      chargedReported = Math.max(chargedReported, reported); chargedEstimated = Math.max(chargedEstimated, estimated); reserved = 0;
    };
    try {
      const model = this.modelFor(project), provider = this.store.state.configuration.providers.find(provider => provider.id === model.providerId), apiKey = this.store.configurationService.secret(provider.id, provider);
      const prior = preservedState(project, this.store.state), sourceWasDemo = project.initialization?.sourceWasDemo ?? project.simulated !== false;
      this.store.mutate(state => { const target = state.projects.find(p => p.id === project.id); target.simulated = false; target.decisionMode = 'uninitialized'; target.initialization = { ...target.initialization, status: 'initializing', sourceWasDemo, phase: 'preparing', startedAt: now(), sourceHash: current.hash, migration: current.migration, ...(current.migration ? { preservedState: prior } : {}), modelSelection: { providerId: model.providerId, modelId: model.modelId, reasoning: model.reasoning } }; delete target.initialization.providerFinishReason; });
      await mkdir(projectWorkspace(project.workspace), { recursive: true, mode: 0o700 });
      const capabilities = await this.capabilities.registry(project, memoryDeclarations(), { includeMutations: true, signal: current.controller.signal }); registry = capabilities.registry;
      // A project genome belongs to one immutable version. It is never an
      // installable global capability or bootstrap input for another project.
      const managedIds = new Set();
      for (const collection of [registry.skills, registry.tools]) for (const [id, manifest] of collection) if (generatedId(id) || manifest.generated || manifest.managed === 'project-genome') { managedIds.add(id); collection.delete(id); }
      const catalog = await registry.catalog(), outputLimit = model.maxOutputTokens, maxAttempts = 4;
      const workspaceContext = await readProjectOrientation({ cwd: projectWorkspace(project.workspace), tools: [...registry.tools.values()], signal: current.controller.signal });
      // Internal reasoning (spec p1 effort, phase 2): setup's effort is the provider default where it adapts; elsewhere the
      // JEV route only records until its own probe (SHADOW_ONLY_PURPOSES). The effective value is kept on the record.
      const effort = await reasoningFor({ decisions: this.decisions, configuration: this.store.state.configuration, project, model, purpose: 'setup', call: setupEffortInput({ task: [project.name, project.description].filter(Boolean).join('\n'), migration: current.migration, existingFiles: workspaceContext?.entries?.length ?? 0, existingDocuments: workspaceContext?.documents?.length ?? 0 }), signal: current.controller.signal }).catch(() => ({ reasoning: model.reasoning, record: { source: 'fallback' } }));
      if (effort.reasoning !== model.reasoning) this.store.mutate(state => { const target = state.projects.find(p => p.id === project.id); if (target?.initialization?.modelSelection) target.initialization.modelSelection.reasoning = effort.reasoning; });
      // SDK requests reserve their own current prompt+output headroom. A custom
      // injected generator without lifecycle events retains a one-call fallback.
      const estimatedHeadroom = Math.ceil(Buffer.byteLength(JSON.stringify({ catalog, schema: projectBootstrapSchema, title: project.name, description: project.description, preservedProjectState: prior, workspaceContext })) / 3) + outputLimit + 4096;
      this.store.mutate(state => { if (!SDK_GENERATORS.has(this.generate)) reserved = reserveRealTokens(state, reservationKey, estimatedHeadroom); state.projects.find(p => p.id === project.id).initialization.phase = 'generating'; });
      modelRequested = !SDK_GENERATORS.has(this.generate);
      const references = this.marketplaces.authoring(project.id, { purpose: 'initialization' });
      let result, mainReceipt;
      const request = { ...(this.store.usageLedger ? { provider: purposeProvider(this.store, undefined, 'initialization', { projectId: project.id }) } : {}), // Skills come from the foundation step (market list → one JEV choice → install); the
        // project author never researches the marketplace itself.
        referenceTools: [], title: project.name, description: project.description, ...(current.migration ? { existingState: prior } : {}), workspaceContext, judgmentPolicyContext: { enabled: judgmentPolicyEnabled(this.store) }, schedulingContext: { ...projectScheduleDefaults(), existingSchedules: project.schedules ?? [], now: now(), delivery: 'project_conversation' }, catalog, model: { ...model, reasoning: effort.reasoning, maxOutputTokens: outputLimit }, apiKey, signal: current.controller.signal, maxAttempts,
        beforeRequest: ({ estimatedTokens }) => {
          requestTracking = true; current.controller.signal.throwIfAborted();
          this.store.mutate(state => { reserved = reserveRealTokens(state, reservationKey, estimatedTokens); });
        },
        onEvent: event => {
          if (event.type === 'bootstrap_start' || event.type === 'bootstrap_repair') this.store.mutate(state => {
            const target = state.projects.find(p => p.id === project.id);
            if (!target || target.archivedAt || this.closed || current.controller.signal.aborted || sourceHash(target) !== current.hash || target.initialization?.status !== 'initializing') return;
            Object.assign(target.initialization, { attempt: event.attempt, maxAttempts, phase: event.type === 'bootstrap_repair' || event.attempt > 1 ? 'repairing' : 'generating' });
            delete target.initialization.providerFinishReason;
            if (event.type === 'bootstrap_repair') { const message = String(event.reason ?? '').replaceAll(apiKey || '\0', '[REDACTED]').slice(0, 2000); target.initialization.lastError = message; target.initialization.diagnostic = message; }
          });
          if (event.type === 'bootstrap_request_start') { modelRequested = true; pendingRequest = true; mainReceipt = { id: event.requestId, complete: false }; }
          if (event.type === 'bootstrap_usage') reportedUsage = structuredClone(event.usage);
          if (event.type === 'bootstrap_request_end') {
            if (mainReceipt?.id && mainReceipt.id === event.requestId && event.completed === true && ['stop', 'toolUse'].includes(event.stopReason) && !event.cancelledBeforeSend) mainReceipt.complete = true;
            reportedUsage = structuredClone(event.usage); settleUsage(); pendingRequest = false;
            this.store.mutate(state => {
              const target = state.projects.find(p => p.id === project.id);
              if (!target || target.archivedAt || sourceHash(target) !== current.hash || target.initialization?.status !== 'initializing') return;
              const reason = finishReasonDiagnostic(event.providerFinishReason);
              if (reason === undefined) delete target.initialization.providerFinishReason;
              else target.initialization.providerFinishReason = reason;
            });
          }
        }
      };
      try {
        result = await this.generate(request);
      reportedUsage = result.usage ?? reportedUsage;
      } catch (error) { if (error.usage) reportedUsage = structuredClone(error.usage); throw error;
      } finally {
        const dir = join(`${this.store.file}.initialization`, project.id), referenceFile = join(dir, `${randomUUID()}-references.json`), snapshot = references.snapshot();
        await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(referenceFile, JSON.stringify({ projectId: project.id, createdAt: now(), ...snapshot }, null, 2), { flag: 'wx', mode: 0o600 });
        this.store.mutate(state => { const target = state.projects.find(p => p.id === project.id); if (target && !target.archivedAt && sourceHash(target) === current.hash) target.initialization.referenceDiscovery = { ...referenceDiscoverySummary(snapshot), referenceFile }; });
      }
      reportedUsage = result.usage ?? reportedUsage;
      if (current.controller.signal.aborted || this.closed) throw Object.assign(new Error('初始化取消'), { code: 'aborted' });
      if (result.status !== 'ready') throw Object.assign(new Error('没有可用于初始化的模型。'), { code: 'configured_model_required' });
      validateProjectGenome(result.genome);
      const genomeValidation = result.genomeValidation?.executed === true ? result.genomeValidation : await smokeProjectGenome(result.genome, { signal: current.controller.signal });
      if (!genomeValidation.passed) throw Object.assign(new Error(`生成工具未通过实际冒烟校验：${JSON.stringify(genomeValidation.results.filter(row => !row.passed)).slice(0, 4000)}`), { code: 'invalid_bootstrap' });
      if (Array.isArray(result.repairEvidence) && result.repairEvidence.length) {
        const dir = join(`${this.store.file}.initialization`, project.id); validationFile = join(dir, `${randomUUID()}.json`); repairEvidenceCount = result.repairEvidence.length;
        await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(validationFile, JSON.stringify({ projectId: project.id, createdAt: now(), status: 'validated-unpublished-draft', attempts: result.attempts, repairEvidence: result.repairEvidence, usage: result.usage }, null, 2), { flag: 'wx', mode: 0o600 });
      }
      const scheduleWarnings = [], initialSchedules = [];
      for (const [index, draft] of (result.initialSchedules ?? []).entries()) {
        const intent = initialScheduleIntent(draft, { ...project, userMessages: prior.userMessages });
        if (!intent.allowed) { scheduleWarnings.push({ title: draft.title, rule: draft.rule, ...intent }); continue; }
        initialSchedules.push({ ...createProjectSchedule({ id: `bootstrap-${project.id}-${index}`, title: draft.title, task: draft.task, rule: draft.rule, destinationSessionId: project.primarySessionId }), source: 'model-project-initialization', requestEvidence: draft.requestEvidence, intent });
      }
      const assignment = await registry.resolve(result.assignments);
      const versionId = randomUUID(), evidenceId = randomUUID();
      prepared = await this.genomes.prepare(project, { genome: result.genome, versionId, parentVersionId: project.activeVersionId ?? null, signal: current.controller.signal });
      await prepared.commit(); current.controller.signal.throwIfAborted();
      this.store.mutate(state => {
        const target = state.projects.find(p => p.id === project.id);
        if (!target || target.archivedAt || this.closed || current.controller.signal.aborted || sourceHash(target) !== current.hash) throw Object.assign(new Error('项目已变化，初始化结果未发布'), { code: 'stale_initialization' });
        const additions = { skillIds: prepared.skillManifests.map(skill => skill.id), toolIds: prepared.toolDescriptors.map(tool => tool.id), mcpServerIds: [], reasons: [...prepared.skillManifests.map(skill => ({ kind: 'skill', id: skill.id, reason: skill.acquired ? `从技能市场获取原始包：${skill.source.repository} @ ${skill.source.commit.slice(0, 12)}` : `模型为本项目生成：${skill.description}` })), ...prepared.toolDescriptors.map(tool => ({ kind: 'tool', id: tool.id, reason: `模型生成并通过实际冒烟校验：${tool.description}` }))] };
        const assignments = mergeAssignments(externalAssignments(target.assignments, managedIds), result.assignments, additions);
        state.capabilities ??= { skills: builtinSkills(), tools: [], mcpServers: [], installations: [], revision: 0 }; state.capabilities.skills ??= builtinSkills();
        // Generated names are the project's, stable across versions (EVO-3): this project's own managed manifest of the
        // same id is replaced (one manifest per id); any other row of that id is a real conflict.
        const incoming = new Set(prepared.skillManifests.map(skill => skill.id)), own = row => row?.managed === 'project-genome' && row.projectId === target.id;
        if (state.capabilities.skills.some(existing => incoming.has(existing.id) && !own(existing))) throw Object.assign(new Error('项目技能版本标识冲突'), { code: 'version_conflict' });
        state.capabilities.skills = [...state.capabilities.skills.filter(existing => !incoming.has(existing.id)), ...prepared.skillManifests];
        state.capabilities.revision = (state.capabilities.revision ?? 0) + 1;
        if (!current.migration || !target.overview) target.overview = result.overview;
        if (!current.migration || !target.focus) target.focus = result.focus;
        if (Array.isArray(result.skillQueries) && result.skillQueries.length) target.skillQueries = [...result.skillQueries];
        target.facts ??= []; for (const text of result.facts) if (!target.facts.some(fact => fact.text === text)) target.facts.push({ id: randomUUID(), text, evidenceId, source: 'model-project-initialization', confidence: null, createdAt: now(), simulated: false });
        target.openQuestions = [...new Set([...(target.openQuestions ?? []), ...result.openQuestions])]; target.milestones ??= [];
        for (const milestone of result.milestones) if (!target.milestones.some(item => item.title === milestone.title)) target.milestones.push({ id: randomUUID(), ...milestone, status: 'pending' });
        target.assignments = assignments; target.capabilityRevision = (target.capabilityRevision ?? 0) + 1; target.unmetCapabilities = result.unmetCapabilities;
        target.schedules ??= [];
        target.scheduleCreationReceipts ??= [];
        const addedSchedules = [];
        for (const schedule of initialSchedules) {
          if (target.scheduleCreationReceipts.some(row => row.id === schedule.id && row.deletedAt)) { scheduleWarnings.push({ title: schedule.title, rule: schedule.rule, code: 'schedule_previously_deleted' }); continue; }
          const existing = target.schedules.find(saved => saved.id === schedule.id || saved.title === schedule.title);
          if (existing) {
            if (existing.task !== schedule.task || JSON.stringify(existing.rule) !== JSON.stringify(schedule.rule) || existing.destinationSessionId !== schedule.destinationSessionId) scheduleWarnings.push({ title: schedule.title, rule: schedule.rule, code: 'schedule_existing_contract_preserved' });
            continue;
          }
          if (target.schedules.length >= 32 || target.scheduleCreationReceipts.length >= 4096) { scheduleWarnings.push({ title: schedule.title, rule: schedule.rule, code: 'schedule_limit_reached' }); continue; }
          target.schedules.push(schedule); addedSchedules.push(schedule);
          target.scheduleCreationReceipts.push({ id: schedule.id, source: schedule.source, createdAt: schedule.createdAt });
        }
        target.initialization.scheduleWarnings = scheduleWarnings;
        target.systemPrompt = result.genome.systemPrompt;
        if (result.judgmentPolicy && mainReceipt?.complete && SDK_GENERATORS.has(this.generate) && (target.judgmentPolicy?.revision ?? null) === judgmentPolicyRevision) {
          const policy = prepareJudgmentPolicy(result.judgmentPolicy, { project: target, source: { kind: 'main_model', method: 'initialization', providerId: model.providerId, modelId: model.modelId, receiptId: mainReceipt.id, createdAt: now() }, reason: '项目初始化主模型提供的判断选项与评分标准' });
          if (validJudgmentPolicy(target)?.revision !== policy.revision) target.judgmentPolicy = policy;
        }
        target.capabilitySnapshot = { skillHashes: { ...Object.fromEntries(Object.entries(target.capabilitySnapshot?.skillHashes ?? {}).filter(([id]) => !generatedId(id) && !managedIds.has(id))), ...Object.fromEntries(assignment.skills.map(skill => [skill.id, skill.contentHash])), ...Object.fromEntries(prepared.skillManifests.map(skill => [skill.id, skill.contentHash])) }, tools: [...assignment.tools.map(tool => ({ id: tool.id, name: tool.name, permission: tool.permission })), ...prepared.toolDescriptors], mcpServers: assignment.mcpServers, failures: capabilities.failures };
        target.versions ??= []; target.versions.push({ id: versionId, version: `0.${target.versions.length + 1}.0`, title: current.migration ? '迁移后的模型生成项目能力包' : '模型生成的项目初始能力包', state: 'baseline', parentVersionId: prepared.record.parentVersionId, bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, systemPrompt: result.genome.systemPrompt, evaluationSuite: result.genome.evaluationSuite, genomeValidation, assignments: structuredClone(assignments), overview: result.overview, focus: result.focus, policy: { cacheGuard: 'unverified', concise: false }, evidenceIds: [evidenceId], createdAt: now(), simulated: false });
        if (target.initialization?.referenceDiscovery) target.versions.at(-1).referenceDiscovery = structuredClone(target.initialization.referenceDiscovery);
        target.activeVersionId = versionId; target.trialVersionId = null; target.decisionMode = 'rna-model'; target.simulated = false;
        const coverage = target.initialization.referenceDiscovery?.coverage ?? [];
        // The brief carries no marketplace skills: queue the skill step (market list → one JEV pick → install).
        if (result.method === 'brief-v1') target.skillFoundation = { schemaVersion: 1, status: 'queued', basisVersionId: versionId, requestedAt: now(), method: 'market-pick-after-brief' };
        else target.skillFoundation = { schemaVersion: 1, status: coverage.length && coverage.some(row => row.status !== 'selected') ? 'partial' : 'ready', basisVersionId: versionId, versionId, sourceCount: result.genome.skills.filter(skill => skill.source).length, coverage: structuredClone(coverage), completedAt: now(), method: 'project-initialization', evaluationPerformed: false };
        if (target.initiative && target.initiative.budgetVersion !== 1) { if (target.initiative.tokenBudget === 50000 || target.initiative.tokenBudget === undefined) target.initiative.tokenBudget = null; target.initiative.budgetVersion = 1; }
        target.initialization = { ...target.initialization, status: 'ready', phase: 'complete', completedAt: now(), usage: result.usage, attempts: result.attempts, sdkVersion: SDK_VERSION, genomeHash: prepared.record.hash, versionId, smokePassed: true }; target.updatedAt = now();
        for (const key of ['code', 'reason', 'message', 'diagnostic', 'lastError', 'providerFinishReason']) delete target.initialization[key];
        if (validationFile) { Object.assign(target.initialization, { validationFile, repairEvidenceCount }); target.versions.at(-1).bootstrapEvidenceFile = validationFile; }
        const session = state.sessions.find(s => s.id === target.primarySessionId && !s.archivedAt);
        if (session && (!session.modelSelection || session.modelSelection.providerId === 'demo')) { session.modelSelection = { providerId: model.providerId, modelId: model.modelId, reasoning: model.reasoningSelection ?? model.reasoning }; session.modelConfig = structuredClone(model); session.model = `${model.providerName} · ${model.name}`; session.context.capacity = model.contextWindow; }
        session?.items.push({ id: randomUUID(), turnId: null, kind: 'assistant', source: 'project-initialization', text: initializationMessage(result, { addedSchedules, scheduleWarnings, language: interfaceLanguageOf(state) }), createdAt: now(), simulated: false });
        state.events.push({ id: ++state.sequence, type: 'project.initialized', projectId: target.id, at: now(), message: '配置模型生成了项目专属系统说明、技能、可执行工具和初始评估标准。', model: result.model, versionId, genomeHash: prepared.record.hash, simulated: false }); state.events = state.events.slice(-1000);
        expectedPublication = structuredClone({ projectId: target.id, versionId, record: prepared.record, assignments, skills: prepared.skillManifests });
      });
      published = true;
    } catch (error) {
      if (error.usage) reportedUsage = structuredClone(error.usage);
      if (prepared && !published && error.committed === true && expectedPublication) {
        const proof = expectedPublication, target = this.store.state.projects.find(row => row.id === proof.projectId), versions = target?.versions?.filter(row => row.id === proof.versionId) ?? [];
        published = target?.activeVersionId === proof.versionId && target?.initialization?.versionId === proof.versionId && versions.length === 1 && JSON.stringify(versions[0].bundle) === JSON.stringify(proof.record) && JSON.stringify(target.assignments) === JSON.stringify(proof.assignments) && proof.skills.every(manifest => { const matches = this.store.state.capabilities?.skills?.filter(row => row.id === manifest.id) ?? []; return matches.length === 1 && JSON.stringify(matches[0]) === JSON.stringify(manifest); });
        this.lastError = 'initialization_durability_unknown';
        // The authoritative state may already refer to these immutable files.
        // A durability failure cannot authorize deleting a published generation.
        if (published) return;
      }
      if (prepared && !published && error.committed !== true) await prepared.rollback();
      const providerFinishReason = finishReasonDiagnostic(error.providerFinishReason);
      if (error.bootstrapDraft || error.repairEvidence?.length || providerFinishReason !== undefined) {
        const dir = join(`${this.store.file}.initialization`, project.id), file = join(dir, `${randomUUID()}.json`);
        try { await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(file, JSON.stringify({ projectId: project.id, createdAt: now(), attempts: error.attempts, error: { code: error.code, message: error.message, ...(providerFinishReason !== undefined ? { providerFinishReason } : {}) }, draft: error.bootstrapDraft, repairEvidence: error.repairEvidence, usage: reportedUsage }, null, 2), { flag: 'wx', mode: 0o600 }); error.draftFile = file; } catch { /* Keep the original failure if private diagnostics cannot be written. */ }
      }
      const incompleteResearch = error.code === 'reference_research_incomplete';
      const failureMessage = incompleteResearch ? '基础技能尚有未处理项，检索记录已保留，尚未生成项目能力包。可查看来源准备详情后重试。' : error.code === 'budget' ? '真实模型 token 限额余量不足；调整限额后可以重试。' : '项目初始化未完成，旧版本与对话已保留。请检查模型或查看诊断后重试。';
      this.store.mutate(state => { const target = state.projects.find(p => p.id === project.id); if (!target || target.archivedAt) return; const stale = sourceHash(target) !== current.hash; target.initialization = { ...target.initialization, status: stale ? 'queued' : current.controller.signal.aborted ? 'paused' : 'failed', code: error.code ?? 'initialization_failed', ...(incompleteResearch || ['invalid_bootstrap', 'invalid_genome'].includes(error.code) ? { diagnostic: error.message.slice(0, 2000) } : {}), message: failureMessage, updatedAt: now() }; if (providerFinishReason === undefined) delete target.initialization.providerFinishReason; else target.initialization.providerFinishReason = providerFinishReason; });
      if (error.draftFile) this.store.mutate(state => { const target = state.projects.find(p => p.id === project.id); if (target && !target.archivedAt) Object.assign(target.initialization, { draftFile: error.draftFile, validationFile: error.draftFile, repairEvidenceCount: error.repairEvidence?.length ?? 0 }); });
    } finally {
      // Normally each request has already settled, even after cancellation.
      // The fallback covers injected generators that do not emit SDK events.
      if (reserved && (requestTracking ? pendingRequest : modelRequested && !reportedUsage)) reportedUsage = { ...(reportedUsage ?? {}), totalTokens: (reportedUsage?.totalTokens ?? 0) + reserved, estimatedTokens: (reportedUsage?.estimatedTokens ?? 0) + reserved };
      if (reserved || reportedUsage) settleUsage();
      await registry?.close();
    }
  }
  retry(projectId) {
    const existing = this.store.state.projects.find(p => p.id === projectId);
    if (!existing) throw Object.assign(new Error('项目不存在'), { status: 404 });
    if (existing.archivedAt) throw Object.assign(new Error('项目已归档，请先恢复后重试初始化。'), { status: 409 });
    if (existing.initialization?.status === 'ready' && hasBundle(existing)) throw Object.assign(new Error('项目已完成初始化；不能通过重试覆盖现有项目版本。'), { status: 409 });
    if (this.running.has(projectId)) throw Object.assign(new Error('项目正在初始化'), { status: 409 });
    return this.store.mutate(state => { const project = state.projects.find(p => p.id === projectId), sourceWasDemo = project.initialization?.sourceWasDemo ?? project.simulated !== false; project.simulated = false; project.decisionMode = 'uninitialized'; project.initialization = { ...project.initialization, status: 'queued', sourceWasDemo, requestedAt: now(), migration: Boolean(project.versions?.length) }; delete project.initialization.diagnostic; delete project.initialization.lastError; delete project.initialization.code; delete project.initialization.providerFinishReason; return project; });
  }
  retryFoundation(projectId, { acquisitionPolicy } = {}) {
    if (acquisitionPolicy !== undefined && !['automatic', 'reuse_only'].includes(acquisitionPolicy)) throw Object.assign(new Error('基础技能策略需要 automatic 或 reuse_only。'), { status: 400 });
    const project = this.store.state.projects.find(row => row.id === projectId);
    if (!project || project.archivedAt || project.initialization?.status !== 'ready' || !hasBundle(project)) throw Object.assign(new Error('项目尚未具备可用的基础版本。'), { status: 409 });
    if (this.running.has(projectId)) {
      const activePolicy = project.skillFoundation?.acquisitionPolicy ?? 'automatic';
      if (acquisitionPolicy !== undefined && acquisitionPolicy !== activePolicy) throw Object.assign(new Error('基础技能正在准备，获取策略尚未修改；请在准备完成后重试。'), { status: 409, code: 'foundation_busy' });
      return structuredClone(project.skillFoundation ?? { status: 'preparing' });
    }
    return this.store.mutate(state => { const target = state.projects.find(row => row.id === projectId); target.skillFoundation = { ...target.skillFoundation, ...(acquisitionPolicy ? { acquisitionPolicy } : {}), schemaVersion: 1, status: 'queued', failureCount: 0, nextRetryAt: 0, requestedAt: now() }; return structuredClone(target.skillFoundation); });
  }
  async close() { this.closed = true; this.unsubscribe(); for (const current of this.running.values()) current.controller.abort(); await Promise.allSettled([...this.running.values()].map(current => current.promise)); }
}
