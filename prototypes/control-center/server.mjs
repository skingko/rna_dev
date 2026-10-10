import { ApplicationMaintenanceGate, maintenancePaths, maintenanceFailure } from './application-maintenance-state.mjs';
import { ApplicationMaintenanceService } from './application-maintenance.mjs';
import { MaintenanceSelfHeal } from './maintenance-self-heal.mjs';
import { MaintenanceQuestionHandoff } from './application-maintenance-questions.mjs';
import { assertStateRecoveryReady } from './state-checkpoint.mjs';
import { atomicWrite } from './durable-files.mjs';
import { SDK_VERSION } from '../../packages/sdk/src/version.mjs';
import { sandboxAvailable } from '../../packages/sdk/src/workspace-exec.mjs';
import { runtimeImplementationIdentity } from './runtime-identity.mjs';
import http from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
const HOST_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
import { randomUUID } from 'node:crypto';
import { instrument, LoopDelay, routeName } from './loop-histograms.mjs';
import { createHostMetrics } from './host-metrics.mjs';
import { acquireProcessLease } from './process-lease.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, DomainError } from './store.mjs';
import { browseDirectories, createDirectory, matchingWorkspaces } from './workspace-directories.mjs';
import { RuntimeController } from './runtime-controller.mjs';
import { UsageLedger, CacheSurvival, cacheSurvivalFile, legacyCacheSurvivalFile, cacheUsageResponse } from './usage-cache-service.mjs';
import { IdleCompactionService } from './idle-compaction-service.mjs';
import { CacheKeepAlive, chargeKeepAlive, keepAliveBlocked } from './cache-keepalive.mjs';
import { priceResolver } from './model-pricing.mjs';
import { memorySyncHealth } from './memory-sync.mjs';
import { memoryHealthDiagnostic } from './memory-service.mjs';
import { CapabilityService } from './capability-service.mjs';
import { refreshCodexClientVersion } from '../../packages/sdk/src/codex-client.mjs';
import { ProjectInitializer } from './project-initializer.mjs';
import { CapabilityInstallService } from './capability-install-service.mjs';
import { SkillMarketplaceService } from './skill-marketplace-service.mjs';
import { ProjectEvolutionService } from './project-evolution-service.mjs';
import { ProjectEvolutionController } from './project-evolution-controller.mjs';
import { evolutionApiRoute } from './evolution-api.mjs';
import { ProjectGenomeStore } from './project-genome-store.mjs';
import { ProjectInitiativeController } from './project-initiative-controller.mjs';
import { ProjectScheduleService } from './project-schedule-service.mjs';
import { UserInteractionService } from './user-interaction-service.mjs';
import { ProjectPermissionService } from './project-permissions.mjs';
import { SessionDeletionService } from './session-deletion.mjs';
import { ProjectLearningController } from './project-learning-controller.mjs';
import { ProjectObservationService } from './project-observation-service.mjs';
import { saveAttachment, saveAttachmentStream, readAttachment, MAX_ATTACHMENT_BYTES } from './session-attachments.mjs';
import { SessionCommandService } from './session-command-service.mjs';
import { BuiltinAgentService, builtinAgents, builtinPlugins } from './builtin-agent-service.mjs';
import { WorkspaceInspectionService } from './workspace-inspection-service.mjs';
import { DecisionService } from './decision-service.mjs';
import { reasoningRoute } from './reasoning-api.mjs';
import { MediaToolsService } from './media-tools-service.mjs';
import { VisionService } from './vision-service.mjs';
import { checkForUpdate } from './update-check.mjs';
import { recordSystemTargets } from './project-evolution-rrsi.mjs';
import { JudgmentPolicyService } from './judgment-policy-service.mjs';
import { createApiV2 } from './api-v2.mjs';
import { createAgentRoutes, AGENT_CANCEL_ROUTE } from './agent-routes.mjs';
import { createInboxRoutes } from './inbox-routes.mjs';
import { streamCompletion } from '../../packages/sdk/src/providers.mjs';
import { createMindRoutes } from './mind-routes.mjs';
import { createMemorySyncRoutes } from './memory-sync-routes.mjs';
import { InvitationService } from './session-invitations.mjs';
import { GeneEvolutionService } from './gene-evolution-service.mjs';
import { TaskAttentionService } from './task-attention.mjs';
import { DiagnosticsService } from './diagnostics-service.mjs';
import { ToolPolicy } from './tool-policy.mjs';
import { createGeneRoutes } from './gene-routes.mjs';
import { createWorkspaceGitRoutes } from './workspace-git-routes.mjs';
import { WorkspaceGitService } from './workspace-git-service.mjs';
import { IsolationEngine, IsolationStorage, ISOLATION_ERRORS } from './git-isolation/index.mjs';
import { RootResolver } from './workspace-roots.mjs';
import { WorktreeService } from './worktree-service.mjs';
import { SessionWorktreeService } from './session-worktree-service.mjs';
import { TurnCheckpoint } from './turn-checkpoint.mjs';
import { createApplyRoutes } from './apply-routes.mjs';
import { createWorktreeRoutes } from './worktree-routes.mjs';
import { GeneDeepCheck } from './gene-deep-check.mjs';
import { experienceReport } from './experience-report.mjs';
import { SessionSuggestions } from './session-suggestions.mjs';
import { ProjectMindService, liveNotes, standingLessons } from './project-mind.mjs';
import { RevocationDispatcher } from './revocation-dispatcher.mjs';
import { MemoryRewind } from './memory-rewind.mjs';
import { createMetricsRoute } from './benchmark/metrics-route.mjs';
import { EffortReplay } from './benchmark/internal-effort-replay.mjs';
import { CompactionForkProbe, pruneProbeSummaries } from './benchmark/compaction-fork-probe.mjs';
import { ScheduleTextReplay, pruneScheduleReplayReports } from './benchmark/schedule-text-replay.mjs';
import { pruneEffortCaptures } from './internal-reasoning.mjs';
import { createWebStatic } from './web-static.mjs';
import { TerminalService, createTerminalRoutes } from './terminal-service.mjs';
import { SideChatService, createSideChatRoutes } from './side-chat.mjs';
import { sweepProjectFiles, pruneRunJournals } from './project-files.mjs';
import { readSeenInConversation } from './proactive-delivery.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { localizeErrorBody } from './api-error-text.mjs';


const root = dirname(fileURLToPath(import.meta.url));
const headers = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Cache-Control': 'no-store'
};
/**
 * A legacy whole-state reader's answer: deprecated with its v2 successor. RFC 9745 makes the value a Structured Field
 * Date, `@<unix seconds>` (an early draft's `true` is not one): the day B9 deprecated them, 2026-10-05T00:00:00Z.
 */
export const LEGACY_DEPRECATED_AT = Date.UTC(2026, 9, 5) / 1000;
const legacyHeaders = successor => ({ Deprecation: `@${LEGACY_DEPRECATED_AT}`, Link: `<${successor}>; rel="successor-version"` });
async function body(req, limit = 65536) {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new DomainError('写操作要求 application/json', 415);
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new DomainError('请求过大', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new DomainError('请求必须是 JSON 对象'); }
}
export function createServer({ stateFile = resolve(root, '.state/state.json'), ticks = true, tickIntervalMs = 3000, runtime = true, runtimeFactory, projectGenerate, initiative = ticks && runtime, initiativeOptions = {}, idleCompaction: idleCompactionEnabled = ticks && runtime, learningOptions = {}, observationSources = ticks && runtime, observationOptions = {}, storageView = ticks && runtime, shutdownTimeoutMs = 15000, webDist = resolve(root, 'web/dist'), terminalOptions = {}, streamHub = {}, sandboxProbe = sandboxAvailable } = {}) {
  const webStatic = createWebStatic({ root, headers, distDir: webDist });
  const runtimeIdentity = runtimeImplementationIdentity();
  const store = new Store(stateFile);
  // Probe the macOS sandbox once at startup (workspace-exec sandboxAvailable remembers a working one), so the first
  // background command or isolation check does not pay for it. What uses the sandbox asks again; nothing else changes.
  try { sandboxProbe(); } catch { /* A failed probe means unavailable, which each use finds out for itself. */ }
  // Purpose-tagged provider cache receipts (counts only), kept beside state.
  // Learned prompt-cache survival per model (derived from the receipts and journals), kept inside the journal root:
  // a new top-level state sibling would block a rolled-back release's checkpoint.
  // Durable metrics (host-metrics.mjs, inside the journal root): the decision ledger and the daily usage, decision and
  // wake rollups. The usage ledger folds its rows into the usage rollup (tokens and counts, no price) before they leave its 7 days.
  const hostMetrics = createHostMetrics(store, { stateFile });
  store.usageLedger ??= new UsageLedger({ file: `${stateFile}.usage-cache.jsonl`, survival: new CacheSurvival({ file: cacheSurvivalFile(stateFile), legacyFile: legacyCacheSurvivalFile(stateFile) }), rollup: hostMetrics.usage });
  const maintenanceGate = new ApplicationMaintenanceGate(store);
  // Idle prompt-cache keep-alive for official Claude conversations (in memory; metered in the ledger above). Idle
  // compaction reads its warmth from the ledger (`keepAlive.warmUntil`) and waits while it keeps a cache warm. Pings are
  // not active work (they run while the user is away and never hold maintenance or an update); close() stops them.
  // Each ping is re-checked when due (emergency stop, an update, deletion or archive, the key, the real-token budget)
  // and charged like any request.
  if (runtime) store.usageLedger.keepAlive ??= new CacheKeepAlive({ ledger: store.usageLedger, pricing: priceResolver(() => store.state.configuration),
    enabled: () => !store.state.emergency && !maintenanceGate.held,
    allowed: entry => !keepAliveBlocked(store.state, entry, { gate: maintenanceGate, secret: provider => store.configurationService.secret(provider.id, provider) }),
    charge: ({ sessionId, usage }) => { store.mutate(state => { chargeKeepAlive(state, sessionId, usage); }); } });
  // An update held only because its readiness check ran out of time resumes itself (plan §5).
  const maintenanceSelfHeal = ticks && runtime ? new MaintenanceSelfHeal(store, { gate: maintenanceGate }) : null;
  let admittedHttp = 0;
  const decisions = new DecisionService(store);
  // Stage B of the internal-effort rollout: a maintenance-only, user-approved main-model replay of captured decisions.
  // It never holds an update: no call starts while maintenance holds new work, and shutdown aborts it (its report kept).
  const effortReplay = new EffortReplay(store, { decisions, held: () => maintenanceGate.held });
  // C5: the user-approved paid GLM compaction-fork probe; maintenance only, same gating as the effort replay.
  const compactionProbe = new CompactionForkProbe(store, { decisions, held: () => maintenanceGate.held });
  // W2: the user-approved paired replay of the schedule texts (v1 against v2); maintenance only, same gating as the others.
  const scheduleTextReplay = new ScheduleTextReplay(store, { decisions, held: () => maintenanceGate.held });
  const judgmentPolicies = new JudgmentPolicyService(store);
  // Isolation (worktree design 0.63 §16 step 5). One WorkspaceGitService for the panel, the engine, Rna's worktrees and
  // git init, so all of them queue on the same repository FIFO. ISOLATION_READY (git-isolation/contract.mjs) still
  // decides whether worktrees are used at all; checkpoints, rollback and git init work either way.
  const workspaceGit = new WorkspaceGitService(store);
  const execRunning = projectId => executor?.execRunning(projectId) ?? 0;
  const roots = new RootResolver(store, { git: workspaceGit, execRunning });
  const mediaTools = new MediaToolsService(store);
  // Upstream image-input probing makes (tiny) model calls, so only a live service runs it.
  const vision = new VisionService(store, { autoProbe: ticks && runtime });
  // The ChatGPT backend gates models by the Codex version a client presents; a live service reads the current release.
  if (ticks && runtime) { store.configurationService.codexVersion = () => refreshCodexClientVersion(); void refreshCodexClientVersion(); }
  const workspaceInspection = new WorkspaceInspectionService(store, { roots, getDaemonOrigin: () => { const address = server.address(); return address ? `http://127.0.0.1:${address.port}` : null; } });
  const capabilityService = new CapabilityService(store, { workspaceInspection, daemonPort: () => server.address()?.port });
  const interactions = new UserInteractionService(store);
  const engine = new IsolationEngine(store, { git: workspaceGit, execRunning, attributable: (projectId, turnId) => checkpoints.attributable(projectId, turnId), interactions });
  const worktrees = new WorktreeService(store, { git: workspaceGit, engine, roots });
  // What isolation keeps on disk, read only (B8): doctor and GET /api/health report it; only the daily sweeps clean.
  const isolationStorage = new IsolationStorage({ store, engine, worktrees });
  // The panel's discard checkpoints first (§0.3-1); GET …/git/worktrees marks Rna's own worktrees.
  Object.assign(workspaceGit, { engine, owners: path => worktrees.ownerOf(path) });
  const checkpoints = new TurnCheckpoint(store, { engine, roots });
  const sessionWorktrees = new SessionWorktreeService(store, { engine, worktrees, roots, interactions });
  const permissions = new ProjectPermissionService(store, interactions);
  // 完全访问 answers any permission card still waiting (and resumes the turn it paused), at startup and on every change.
  const settleFullAccess = projectId => { try { for (const sessionId of permissions.settleFullAccess(projectId)) if (!maintenanceGate.held && !questionHandoff.holdsAnswer(sessionId)) try { store.controlSession(sessionId, 'resume'); } catch { /* resumed on the next start */ } } catch { /* never blocks the request */ } };
  const capabilityInstaller = new CapabilityInstallService(store, { capabilityService });
  const marketplaceService = new SkillMarketplaceService(store);
  const projectSchedules = new ProjectScheduleService(store);
  const initializer = new ProjectInitializer(store, capabilityService, { generate: projectGenerate, marketplaceService, decisions,
    isBusy: id => evolutionService.running.has(id) || Boolean(projectLearning?.contexts?.get(id)?.promise) ||
      projectLearning?.health().projects.some(row => row.projectId === id && (row.inFlight || row.unsettledOperations)) ||
      projectInitiative?.health().projects.some(row => row.projectId === id && (row.inFlight || row.activeActions || row.unsettledOperations)) ||
      [...builtinAgentService.running.values()].some(row => row.projectId === id) });
  // P4: marketplace candidates are screened by JEV (skill.screen) before the single main-model review.
  initializer.foundation.pick ??= input => decisions.pickSkills(input);
  const builtinAgentService = new BuiltinAgentService(store, { capabilityService, engine, roots, worktrees, sessionWorktrees, decisions });
  // Writes cut off by a crash settle first: every engine write (an interrupted worker's merge just below, an idle
  // session's apply, a cut-off background run) waits for this.
  const isolationRecovery = runtime ? engine.recover().catch(error => { console.warn(`isolation recovery: ${error.code ?? ''} ${error.message}`); return null; }) : null;
  // Children cannot survive a restart: mark them interrupted and notify once (a worker's own worktree is merged first).
  builtinAgentService.recover();
  // Project Mind (K1): lessons, agenda, commitments, notes; shared by foreground, background and evolution.
  // Mind model calls (lesson writer, notes) are background work: off when initiative is off, or when a host injects a fake decision provider without a mindProvider (tests).
  // A turn's digest names what its direct-mode checkpoint attributes to it (what commands wrote too).
  const mind = store.mind = new ProjectMindService(store, { decisions, interactions, provider: initiativeOptions.mindProvider !== undefined ? initiativeOptions.mindProvider : !initiative || initiativeOptions.decisionProvider ? null : undefined, sweepIntervalMs: ticks ? 30000 : 0,
    writtenPaths: ({ projectId, turnId }) => checkpoints.attributable(projectId, turnId).then(row => row.paths) });
  const executor = runtime ? new RuntimeController(store, { mindService: mind, factory: runtimeFactory, capabilityService, capabilityInstaller, interactions, permissions, builtinAgentService, mediaToolsService: mediaTools, visionService: vision, judgmentPolicyService: judgmentPolicies, marketplaceService, projectSchedules, decisionService: decisions, roots, sessionWorktrees, checkpoints, prepareForeground: (projectId, options) => projectInitiative?.prepareForeground(projectId, options), backgroundController: () => projectInitiative }) : null;
  const commands = new SessionCommandService(store, { executor, decisions });
  // Cache survival estimates reach every foreground session (cold economy points); a live service backfills them once
  // from the session journals, read-only, and compacts idle conversations over half their window in the background.
  const survival = store.usageLedger?.survival ?? null;
  if (executor) executor.survival = survival;
  if (ticks && runtime && survival) void survival.backfill({ stateFile, ledger: store.usageLedger }).catch(() => {});
  const secretValues = () => [...Object.values(store.configurationService.secrets ?? {}), ...(store.configurationService.secretValues?.() ?? [])].filter(value => typeof value === 'string' && value);
  // `idleCompaction`: on with the live timers by default; a test host turns it on without them (no Codex version fetch).
  const idleCompaction = idleCompactionEnabled && runtime && executor ? new IdleCompactionService(store, { executor, ledger: store.usageLedger, survival, decisions, gate: maintenanceGate, redactValues: secretValues }).start() : null;
  if (executor) executor.idleCompaction = idleCompaction;
  const evolutionService = new ProjectEvolutionService(store, { provider: initiativeOptions.evolutionProvider, marketplaceService, decisionService: decisions });
  const evolution = new ProjectEvolutionController(store, { service: evolutionService });
  const projectInitiative = initiative ? new ProjectInitiativeController(store, { capabilityService, evolutionService, interactionService: interactions, permissionService: permissions, scheduleService: projectSchedules, decisionService: decisions, foregroundToolSurface: projectId => executor?.managementSurface(projectId) ?? [], engine, worktrees, roots, ...initiativeOptions, narratorProvider: initiativeOptions.narratorProvider ?? (initiativeOptions.decisionProvider ? null : streamCompletion), independentLearning: true }) : null;
  // Evolution v3 (gene tree) replaces the learning controller's whole-genome candidates; the old class stays for the CLI's explicit experiments only.
  const projectLearning = null; void learningOptions; void ProjectLearningController;
  mind.learning = projectLearning; mind.sweep();
  // agent_merge({ changeId }) settles a background change set handed to this conversation (T3 → T5 seam).
  if (projectInitiative) builtinAgentService.backgroundMerge = (input, signal) => projectInitiative.backgroundMerge(input, signal);
  const deletions = new SessionDeletionService(store, { executor, projectInitiative, projectLearning, capabilityService, sessionWorktrees, worktrees });
  const observationService = observationSources ? new ProjectObservationService(store, { ...observationOptions,
    isBusy: id => initializer.running.has(id) || evolutionService.running.has(id) ||
      (projectInitiative?.contexts?.get(id)?.activeHandles?.size ?? 0) > 0 ||
      [...builtinAgentService.running.values()].some(row => row.projectId === id) || observationOptions.isBusy?.(id) === true }) : null;
  // A user's undo (rollback, change-set revert, panel discard) is not a directory change to wake the loop with: the
  // engine hands its writes to the observation, which folds them into its baseline (review F2, K1-2).
  engine.undoWrites = observationService;
  const streams = new Set();
  // Side panel (S1): workspace terminals and side chats; capabilities ride on /api/v2/bootstrap.
  const terminals = new TerminalService(store, { headers, roots, ...terminalOptions });
  const sideChats = new SideChatService(store);
  // streamHub: the v2 stream hub's timings (api-v2.mjs StreamHub), for tests that drive its poll with an injected clock.
  const apiV2 = createApiV2({ store, maintenance: () => maintenanceGate.public(), streams, headers, capabilities: () => ({ terminal: terminals.capability, sideChat: true }), hub: streamHub });
  const terminalRoutes = createTerminalRoutes({ terminals, body });
  const sideChatRoutes = createSideChatRoutes({ sideChats, body });
  const agentRoutes = createAgentRoutes({ store, agents: builtinAgentService, body });
  const inboxRoutes = createInboxRoutes({ store, body, decisions });
  const invitations = store.invitations = new InvitationService(store, { decisions, mind });
  mind.invitations = invitations;
  const genes = store.genes = new GeneEvolutionService(store, { decisions, mind, enabled: initiative });
  genes.invitations = invitations; invitations.genes = genes; invitations.schedules = projectSchedules;
  // Learning health reads the gene lanes (evolution v3), not the retired learning controller.
  mind.genes = genes;
  invitations.initiative = projectInitiative;
  // Evolution learns from each captured user message whether the genes it used held (leveling, lane B).
  mind.onCapture = event => genes.afterCapture(event);
  if (executor) executor.genes = genes;
  // Background work shares the plan tool (plan layer, §4.1).
  if (projectInitiative) projectInitiative.mind = mind;
  // Code diagnostics after edits (§4.2).
  const diagnostics = store.diagnostics = new DiagnosticsService({ store, mind, decisions });
  // One tool policy for every purpose (B1): the constraint gate, guards and diagnostics reach foreground turns,
  // background runs and subagents through the same hooks (tool-policy.mjs).
  const toolPolicy = new ToolPolicy({ decisions, genes, diagnostics });
  for (const owner of [executor, projectInitiative, builtinAgentService]) if (owner) owner.toolPolicy = toolPolicy;
  // The revocation dispatcher (C4, revocation-dispatcher.mjs): a lesson revoked, a check or skill withdrawn, a privacy scope changed
  // reaches the evolution rules, notes and plan items that grew from it, and the conversations' context copies of it.
  const revocations = store.revocations = new RevocationDispatcher(store, { decisions, auditIntervalMs: ticks ? 60000 : 0 });
  // A rewind also releases the remote OpenViking sessions of the removed turns, rolling back the memories their archives
  // created or changed where those are untouched since (D5, memory-rewind.mjs); deleting a whole conversation keeps its memories.
  const memoryRewind = store.memoryRewind = new MemoryRewind(store);
  revocations.register(mind.revocationHandler()).register(genes.revocationHandler()).register(memoryRewind.revocationHandler());
  memoryRewind.reopen();
  genes.genes.onWithdrawn = event => revocations.dispatch(event);
  capabilityInstaller.onWithdrawn = event => revocations.dispatch(event);
  revocations.start();
  genes.start();
  // Task page: whether finished background work needs the user (JEV message.value on its result).
  const taskAttention = store.taskAttention = new TaskAttentionService(store, { decisions, enabled: initiative });
  taskAttention.start();
  const deepCheck = new GeneDeepCheck(store, { genes: genes.genes });
  const suggestions = new SessionSuggestions(store, { mind });
  const geneRoutes = createGeneRoutes({ store, body, genes, mind, deepCheck });
  const workspaceGitRoutes = createWorkspaceGitRoutes({ store, body, git: workspaceGit }); // 工作区改动 panel (layout plan §3)
  // Apply records and rollback, Rna's worktrees (protocol v2 §8.6–8.7). Their writes are held during maintenance like every POST.
  const applyRoutes = createApplyRoutes({ store, body, engine });
  const worktreeRoutes = createWorktreeRoutes({ store, body, worktrees });
  // ask.necessity: skip a question card when a careful, easily changed default will do (JEV, high stakes).
  interactions.decisions = decisions; // answer.match
  interactions.necessity = async ({ sessionId, turnId, questions, signal }) => {
    const session = store.state.sessions.find(row => row.id === sessionId), project = store.state.projects.find(row => row.id === session?.projectId) ?? null;
    const turn = session?.turns.find(row => row.id === turnId), request = session?.items.find(item => item.id === turn?.userItemId)?.text ?? '';
    const live = project ? store.presences?.get(project.id) : null, present = Boolean(live && Date.parse(live.expiresAt) > Date.now() && live.visible !== false);
    // What the project already knows about the user (plan §2.5 item 13): notes, preferences and standing lessons.
    const mind = project?.mind, known = mind ? [...(liveNotes(mind.notes)?.facts ?? []), ...(liveNotes(mind.notes)?.preferences ?? [])].map(row => row.text).concat(standingLessons(mind).map(row => row.text)).filter(Boolean).slice(-10) : [];
    return decisions.askNecessity(project, { sessionId, turnId, request, questions, present, known, detail: true, signal });
  };
  const mindRoutes = createMindRoutes({ store, body, mind, invitations });
  const memorySyncRoutes = createMemorySyncRoutes({ store, body, pump: () => { executor?.memorySync?.pump(); } });
  const metricsRoute = createMetricsRoute({ store });
  const startedAt = new Date().toISOString(), instanceId = randomUUID();
  // Event-loop delay since boot and per 5-minute slot, and which named sections held the loop (loop-histograms.mjs).
  // Diagnostic only: shown in /api/health and `./rna doctor`, never read by any decision.
  const loopDelay = new LoopDelay(), loopHistograms = hostMetrics.histograms;
  // Besides each HTTP route and the scheduler tick: a state commit's write and the v2 index diff (candidates finding
  // D6 named for the unexplained loop maximum), timed wherever they run.
  instrument(store, 'persist', 'store persist', loopHistograms); instrument(apiV2.hub, 'diffIndex', 'index diff', loopHistograms);
  let closing = false, closePromise, lastTickAt = null, lastTickError = null;
  let memoryDependency = { status: ticks && runtime ? 'checking' : 'not_monitored', checkedAt: null };
  const dependencyAbort = new AbortController();
  let checkingMemory = false;
  const checkMemory = async () => {
    if (closing || checkingMemory) return;
    const project = store.state.projects.find(project => !project.archivedAt && project.simulated === false);
    if (!project) { memoryDependency = { status: 'not_required', checkedAt: new Date().toISOString() }; return; }
    checkingMemory = true;
    try {
      const result = await store.memoryService.healthRemote(store.memoryService.remote(project.id), { signal: AbortSignal.any([dependencyAbort.signal, AbortSignal.timeout(5000)]) });
      // /health proves that HTTP is alive, not that retrieval dependencies
      // (including embeddings) are ready. Legacy servers without /ready remain
      // usable through explicit operations, but cannot pass endurance readiness.
      const ready = result?.ready === true;
      memoryDependency = { status: ready ? 'healthy' : 'unverified', checkedAt: new Date().toISOString(), backend: result?.backend === 'embedded' ? 'embedded' : 'openviking',
        ready, liveness: result?.liveness?.status === 'alive' ? 'alive' : 'unknown',
        readiness: ['ready', 'not_supported', 'not_ready'].includes(result?.readiness?.status) ? result.readiness.status : 'unknown',
        // The embedded engine searches by words: no embedding or summarising model is in use, which is not the same as unverified.
        embedding: ['ready', 'not_used'].includes(result?.readiness?.embedding) ? result.readiness.embedding : 'not_verified', vlm: result?.readiness?.vlm === 'not_used' ? 'not_used' : 'not_verified',
        ...(memoryHealthDiagnostic(result?.readiness?.diagnostic) ? { diagnostic: memoryHealthDiagnostic(result.readiness.diagnostic) } : {}) };
    } catch (error) { if (!closing) memoryDependency = { status: 'unavailable', checkedAt: new Date().toISOString(), errorCode: 'MEMORY_UNAVAILABLE',
      ...(memoryHealthDiagnostic(error?.memoryDiagnostic) ? { diagnostic: memoryHealthDiagnostic(error.memoryDiagnostic) } : {}) }; }
    finally { checkingMemory = false; }
  };
  const dependencyTimer = ticks && runtime ? setInterval(() => { void checkMemory(); }, 60000) : null; dependencyTimer?.unref();
  // Recurring cross-project problems are recorded for developers (never applied, not shown in the app).
  const recordSystem = () => recordSystemTargets(store).catch(() => {});
  const systemRecordTimer = ticks && runtime ? setInterval(recordSystem, 6 * 3600000) : null; systemRecordTimer?.unref();
  if (systemRecordTimer) setTimeout(recordSystem, 60000).unref();
  if (dependencyTimer) queueMicrotask(() => { void checkMemory(); });
  let heartbeatAt = Date.now();
  let heartbeatSequence = 0;
  const memoryOperations = () => (executor?.memorySync?.running.size ?? 0) + Number(Boolean(executor?.memorySync?.summarySync.running));
  // builtinAgentService.mergeQueues: host merge actions writing into a parent's files, including a worker merge the
  // host resumed after the user's git operation (its worker already left `running`; review C4).
  const hasOtherActiveWork = () => Boolean(admittedHttp || [...store.configurationService.subscriptionAuth.flows.values()].some(flow => flow.status === 'pending') || store.state.tasks.some(task => task.status === 'running') || store.state.goals.some(goal => goal.status === 'running') || executor?.maintenance.size || idleCompaction?.inFlight.size || decisions.shadows.size || workspaceInspection.inFlight || workspaceInspection.starting?.size || observationService?.health().active || evolution.operations.size || initializer.running.size || evolutionService.running.size || builtinAgentService.running.size || builtinAgentService.mergeQueues?.size || memoryOperations() || deletions.running.size || executor?.handBacks?.size || sessionWorktrees.idle.size || sessionWorktrees.queues?.size || projectLearning?.health().projects.some(row => row.inFlight || row.unsettledOperations) ||
    [...(projectInitiative?.contexts?.values() ?? [])].some(context => context.reviewPromise || context.activeHandles?.size || context.coordinator?.active?.size || context.coordinator?.unsettled?.size));
  const hasActiveWork = () => Boolean(hasOtherActiveWork() || store.state.sessions.some(session => session.status === 'running') || executor?.running.size);
  const questionHandoff = new MaintenanceQuestionHandoff(store, { gate: maintenanceGate, executor, interactions, otherWork: hasOtherActiveWork });
  const sendLiveness = () => {
    heartbeatAt = Date.now();
    if (!process.connected || !process.send) return;
    const activeWork = hasActiveWork();
    // Independent of HTTP, Store snapshots, filesystem and dependency readiness.
    // A degraded dependency must remain visible in /health.
    try { process.send({ type: 'rna-daemon-liveness', pid: process.pid, supervisorRunId: process.env.RNA_AGENT_SUPERVISOR_RUN,
      generation: process.env.RNA_AGENT_GENERATION, sequence: ++heartbeatSequence,
      sentAtMonotonicMs: Number(process.hrtime.bigint() / 1000000n), activeWork, closing }, () => {}); } catch {}
  };
  const heartbeat = setInterval(sendLiveness, 1000); heartbeat.unref();
  const health = () => {
    const initiativeHealth = projectInitiative?.health?.() ?? null;
    const learningHealth = projectLearning?.health?.() ?? null;
    const memorySync = memorySyncHealth(store.state), memorySyncDegraded = !memorySync.healthy;
    const autonomyDegraded = Boolean(learningHealth?.lastError || learningHealth?.projects.some(project => project.lastError || project.persistenceError || project.unsettledOperations) || initiativeHealth?.lastPumpError || initiativeHealth?.projects?.some(project => project.executionBlocked === true || project.unsettledOperations > 0 || project.failureCount > 0 || project.lastObserverError || project.archiveRetryAt));
    return {
    ok: !closing && !store.persistence.failed && !lastTickError && !autonomyDegraded && !memorySyncDegraded && ['healthy', 'not_required', 'not_monitored'].includes(memoryDependency.status),
    autonomyDegraded, memorySyncDegraded, dependencies: { memory: { ...memoryDependency, sync: memorySync }, model: { status: 'observed_through_real_requests' } },
    mode: 'hybrid', version: HOST_VERSION, modelExecution: 'rna', sdkVersion: SDK_VERSION, runtimeIdentity,
    // `rna status` reads these here instead of the whole state (B9): the emergency stop, the revision, and the budget
    // settings with today's usage against them (a few hundred bytes).
    emergency: Boolean(store.state.emergency), revision: store.state.revision, settings: store.state.settings ?? null, usage: store.state.usage ?? null,
    maintenance: { ...maintenanceGate.public(), ...(executor ? { questionHandoff: 1 } : {}) }, memoryBackend: 'openviking', memoryEngine: store.memoryService.backend, decisionMode: projectInitiative ? 'project-model-with-demo-compatibility' : 'disabled',
    node: process.versions.node, tools: 'project-assigned-capabilities',
    process: { pid: process.pid, instanceId, startedAt, uptimeSeconds: process.uptime(), closing,
      supervisorRunId: process.env.RNA_AGENT_SUPERVISOR_RUN ?? null, generation: process.env.RNA_AGENT_GENERATION ?? null },
    heartbeatAt: new Date(heartbeatAt).toISOString(), eventLoop: loopDelay.health(loopHistograms),
    memory: process.memoryUsage(), persistence: { ...store.persistence }, streams: streams.size,
    scheduler: { lastTickAt, lastTickError, initiative: initiativeHealth, learning: learningHealth, observations: observationService?.health() ?? null },
    // Isolation's storage (worktrees, trash, private indexes, refs/rna, object stores and who owns each), computed in
    // the background and cached; never waited for here.
    storage: storageView ? isolationStorage.view() : null,
    workload: { admittedHttp, activeWork: hasActiveWork(), memoryOperations: memoryOperations(), deletionOperations: deletions.running.size,
      activeSessions: store.state.sessions.filter(session => session.status === 'running').length,
      activeExecutions: executor?.running.size ?? 0,
      learningReviews: learningHealth?.projects.filter(project => project.inFlight || project.unsettledOperations).length ?? 0,
      completedScheduledOccurrences: store.state.projects.reduce((sum, project) => sum + (project.scheduleRuntime?.deliveredCount ?? 0), 0),
      initializations: initializer.running.size, evaluations: evolutionService.running.size,
      tokenUsage: { reported: store.state.realUsage?.reportedTokens ?? 0, estimated: store.state.realUsage?.estimatedTokens ?? 0, reserved: store.state.realUsage?.reservedTokens ?? 0 } }
  };
  };
  const maintenanceService = new ApplicationMaintenanceService(store, { gate: maintenanceGate, health });
  const handle = async (req, res) => {
    const send = (status, value, extra = {}) => { res.writeHead(status, { ...headers, ...extra, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(status >= 400 ? localizeErrorBody(value, interfaceLanguageOf(store.state)) : value)); };
    let admitted = false;
    try {
      const address = server.address();
      if (!address || closing) return send(503, { error: 'daemon 正在关闭，请稍后重试' });
      const port = address.port;
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}`) throw new DomainError('Host 不受允许，请使用 127.0.0.1', 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new DomainError('禁止跨站请求', 403);
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new DomainError('禁止跨站请求', 403);
      const requestURL = new URL(req.url, `http://${host}`), pathname = requestURL.pathname;
      if (webStatic(req, res, pathname)) return;
      if (req.method === 'GET' && pathname === '/api/maintenance') return send(200, maintenanceService.status());
      if (req.method === 'POST' && pathname === '/api/maintenance/questions/suspend') return send(200, await questionHandoff.suspend(await body(req)));
      const maintenanceRoute = pathname.match(/^\/api\/maintenance\/(prepare|backup|apply|rollback|restore|cancel|recover)$/);
      if (req.method === 'POST' && maintenanceRoute) return send(202, await maintenanceService.submit(maintenanceRoute[1], await body(req)));
      maintenanceGate.refresh();
      const safeView = req.method === 'GET' && (['/api/health', '/api/state', '/api/events', '/api/projects', '/api/stream', '/api/configuration'].includes(pathname) || pathname.startsWith('/api/v2/'));
      // Reads never start work, so maintenance holds only writes: the file
      // tree, previews, generated images and schedules stay readable while an
      // update waits. Every GET route here only reads; one that ever starts
      // work must be excluded from this test.
      const read = req.method === 'GET' || req.method === 'HEAD';
      if (maintenanceGate.held && !safeView && !read) {
        // Replies may settle an already-running tool; they cannot admit a new
        // turn during draining. Stop is always available, resume is not.
        const answer = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/interactions\/[a-f0-9]{64}\/(answer|cancel)$/);
        const stop = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/control$/);
        if (req.method === 'POST' && AGENT_CANCEL_ROUTE.test(pathname)) { admittedHttp++; admitted = true; if (await agentRoutes(req, { pathname, send })) return; }
        // Stopping the effort replay only ends paid work, so it stays available while an update waits.
        if (req.method === 'POST' && pathname === '/api/v2/maintenance/effort-replay/cancel') { admittedHttp++; admitted = true; await body(req); return send(200, effortReplay.cancel()); }
        if (req.method === 'POST' && pathname === '/api/v2/maintenance/compaction-fork-probe/cancel') { admittedHttp++; admitted = true; await body(req); return send(200, compactionProbe.cancel()); }
        if (req.method === 'POST' && pathname === '/api/v2/maintenance/schedule-text-replay/cancel') { admittedHttp++; admitted = true; await body(req); return send(200, scheduleTextReplay.cancel()); }
        if (req.method === 'POST' && stop) {
          admittedHttp++; admitted = true;
          const input = await body(req); if (!['stop', 'pause'].includes(input.action)) throw maintenanceFailure('应用维护期间暂不开始新工作。', 'maintenance_held', 503);
          return send(200, store.controlSession(stop[1], input.action));
        }
        const auth = pathname.match(/^\/api\/providers\/([^/]+)\/auth(?:\/(complete|cancel))?$/);
        const settlingAuth = auth && store.configurationService.subscriptionAuth.flows.get(decodeURIComponent(auth[1]))?.status === 'pending' && req.method === 'POST' && auth[2] && maintenanceGate.row?.phase === 'waiting_idle';
        if (!settlingAuth && !(req.method === 'POST' && answer && (executor?.running.has(answer[1]) || questionHandoff.canAnswer(answer[1])) && maintenanceGate.row?.phase === 'waiting_idle')) throw maintenanceFailure('应用维护期间暂不开始新工作，草稿已保留。', 'maintenance_held', 503);
      }
      if (!safeView) { admittedHttp++; admitted = true; }
      if (apiV2.handle(req, res, { pathname, url: requestURL, send })) return;
      if (await terminalRoutes(req, res, { pathname, url: requestURL, send })) return;
      if (await sideChatRoutes(req, { pathname, send })) return;
      const browserPreview = req.method === 'GET' && pathname.match(/^\/api\/v2\/projects\/([a-zA-Z0-9-]+)\/preview$/);
      if (browserPreview) return send(200, workspaceInspection.browserPreview(browserPreview[1]));
      // K4 metrics (plan §8); inert when api-v2 already serves the route.
      if (await metricsRoute.handle(req, res, { pathname, url: requestURL, send })) return;
      if (await agentRoutes(req, { pathname, send })) return;
      if (await inboxRoutes(req, { pathname, url: requestURL, send })) return;
      if (await mindRoutes(req, { pathname, url: requestURL, send })) return;
      if (await memorySyncRoutes(req, { pathname, send })) return;
      if (await geneRoutes(req, { pathname, url: requestURL, send })) return;
      if (await workspaceGitRoutes(req, { pathname, url: requestURL, send })) return;
      if (await applyRoutes(req, { pathname, url: requestURL, send })) return;
      if (await worktreeRoutes(req, { pathname, url: requestURL, send })) return;
      if (req.method === 'GET' && pathname === '/api/skill-marketplaces') return send(200, marketplaceService.catalog());
      if (req.method === 'POST' && pathname === '/api/skill-marketplaces/search') return send(200, await marketplaceService.search(await body(req)));
      if (req.method === 'POST' && pathname === '/api/skill-marketplaces/read') return send(200, await marketplaceService.read(await body(req)));
      if (req.method === 'GET' && pathname === '/api/capabilities') return send(200, capabilityService.public());
      const projectCapabilities = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/capabilities(?:\/(inspect|install|assign|remove))?$/);
      if (req.method === 'GET' && projectCapabilities && !projectCapabilities[2]) return send(200, { ...capabilityInstaller.list(projectCapabilities[1]), builtinAgents: builtinAgents(), builtinPlugins: builtinPlugins() });
      if (req.method === 'GET' && pathname === '/api/configuration') return send(200, store.configurationService.public());
      if (req.method === 'POST' && pathname === '/api/web-tools/test') {
        const controller = new AbortController();
        const closingResponse = () => { res.setHeader('Connection', 'close'); return send(503, { error: 'daemon 正在关闭，请稍后重试' }); };
        // Request 'close' also fires after a normal body has been consumed.
        // Only an aborted upload or a response connection closing early ends
        // this explicit external check and prevents its second request.
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        req.once('aborted', disconnected); res.once('close', disconnected);
        try {
          await body(req);
          if (req.aborted || res.destroyed) disconnected();
          controller.signal.throwIfAborted();
          if (closing) return closingResponse();
          const result = await capabilityService.webTools.test({ signal: controller.signal });
          if (!res.destroyed && !controller.signal.aborted) return send(200, result);
          return;
        } catch (error) {
          if (!controller.signal.aborted) {
            if (closing && !res.destroyed) return closingResponse();
            throw error;
          }
        }
        finally { req.off('aborted', disconnected); res.off('close', disconnected); }
        return;
      }
      if (req.method === 'GET' && pathname === '/api/updates/check') return send(200, await checkForUpdate({ current: HOST_VERSION }));
      { const routed = reasoningRoute({ method: req.method, pathname, store, decisions }); if (routed) return send(routed.status, routed.body); }
      // P4 evolution read/propose API (changelog, components, history, signals, failures, system, task types).
      // Durable metrics (plan B7): whole local days, the decision ledger and the rollups, `archived=exclude|include|only`.
      // Their 400s carry the documented `code` (spec §5, §6.1); the shared handler below forwards only its own list.
      const metricsReply = (name, read) => { try { return send(200, loopHistograms.time(name, read)); } catch (error) { if (error.status === 400 && ['archived_invalid', 'ledger_cursor_invalid', 'ledger_point_invalid', 'window_invalid'].includes(error.code)) return send(400, { error: error.message, code: error.code }); throw error; } };
      if (req.method === 'GET' && pathname === '/api/v2/experience') return metricsReply('metrics experience', () => experienceReport(store.state, { days: Number(requestURL.searchParams.get('days') ?? 7), archived: requestURL.searchParams.get('archived') || 'exclude', ledger: store.decisionLedger, decisionRollup: hostMetrics.decisions, wakes: hostMetrics.wakes, outcomes: hostMetrics.outcomeLog }));
      // Suggestion cards of an empty conversation (?projectId=…; none selected → starters).
      if (req.method === 'GET' && pathname === '/api/v2/suggestions') { const projectId = requestURL.searchParams.get('projectId'); if (projectId && !/^[a-zA-Z0-9-]{1,80}$/.test(projectId)) throw new DomainError('项目标识无效', 400); return send(200, await suggestions.get(projectId || null)); }
      { const routed = await evolutionApiRoute({ method: req.method, pathname, searchParams: requestURL.searchParams, store, evolution: evolutionService, readBody: () => body(req) }); if (routed) return send(routed.status, routed.body); }
      if (req.method === 'GET' && pathname === '/api/decision-kernel') return send(200, decisions.public());
      if (req.method === 'GET' && pathname === '/api/v2/usage/cache') return metricsReply('metrics usage', () => cacheUsageResponse(store.usageLedger, requestURL.searchParams, { projects: store.state.projects, modelFor: (providerId, modelId) => { const provider = store.state.configuration.providers?.find(row => row.id === providerId), model = provider?.models?.find(row => row.id === modelId); return provider ? { protocol: provider.protocol, ...(model?.cacheRetention ? { cacheRetention: model.cacheRetention } : {}), ...(model?.compat ? { compat: model.compat } : {}) } : null; } }));
      if (req.method === 'GET' && pathname === '/api/v2/decision-kernel/calibration') return metricsReply('metrics calibration', () => decisions.calibration({ point: requestURL.searchParams.get('point') ?? undefined, window: requestURL.searchParams.get('window') ?? '7d', archived: requestURL.searchParams.get('archived') || 'include' }));
      // The ledger, paged newest first: `limit` (≤200), `before` (a ledger id from `nextBefore`), `projectId`, `point`, `archived`.
      const ledgerQuery = () => Object.fromEntries(['projectId', 'point', 'limit', 'before', 'archived'].flatMap(key => requestURL.searchParams.has(key) ? [[key, requestURL.searchParams.get(key)]] : []));
      if (req.method === 'GET' && pathname === '/api/v2/decision-kernel/ledger') return metricsReply('metrics ledger', () => decisions.ledgerPage(ledgerQuery()));
      if (req.method === 'GET' && pathname === '/api/decision-kernel/ledger') return metricsReply('metrics ledger', () => decisions.ledger(ledgerQuery()));
      // D2 (shadow): the option-B completion gate's verdicts against what the reviews came to (`projectId`, `window` 24h|7d|30d|all, `archived`).
      if (req.method === 'GET' && pathname === '/api/v2/decision-kernel/completion') return metricsReply('metrics completion', () => decisions.completionReport({ projectId: requestURL.searchParams.get('projectId') || undefined, window: requestURL.searchParams.get('window') ?? '7d', archived: requestURL.searchParams.get('archived') || 'exclude' }));
      // Developer probe: one raw JEV call with the configured key (studying question design; not a decision, no ledger).
      if (req.method === 'POST' && pathname === '/api/v2/decision-kernel/probe') return send(200, await decisions.probe(await body(req)));
      // Stage B effort replay (maintenance only, benchmark/internal-effort-replay.mjs; `./rna effort …`): GET reads status and
      // the dry-run plan (skipped while a run is in progress unless options ask for it: the CLI polls this); POST starts
      // only with approved:true within the approved budget; it never changes project state.
      if (pathname === '/api/v2/maintenance/effort-replay' && req.method === 'GET') { const option = name => requestURL.searchParams.has(name) ? Number(requestURL.searchParams.get(name)) : undefined; if (effortReplay.running && ![...requestURL.searchParams.keys()].length) return send(200, { ...effortReplay.status(), plan: null }); return send(200, { ...effortReplay.status(), plan: effortReplay.plan({ cases: option('cases'), baseline: option('baseline'), narrator: option('narrator'), budgetTokens: option('budgetTokens'), ...(requestURL.searchParams.get('projectId') ? { projectId: requestURL.searchParams.get('projectId') } : {}) }) }); }
      if (pathname === '/api/v2/maintenance/effort-replay' && req.method === 'POST') return send(202, effortReplay.start(await body(req)));
      if (pathname === '/api/v2/maintenance/effort-replay/cancel' && req.method === 'POST') { await body(req); return send(200, effortReplay.cancel()); }
      { const report = req.method === 'GET' && pathname.match(/^\/api\/v2\/maintenance\/effort-replay\/reports\/([a-zA-Z0-9-]{1,80})$/); if (report) return send(200, effortReplay.report(report[1])); }
      // C5 GLM compaction-fork probe (benchmark/compaction-fork-probe.mjs; `./rna compaction …`): GET reads status and the
      // preview (chosen points, estimates; skipped while a run is in progress unless options ask for it); POST starts only
      // with approved:true within the approved 2M tokens; it never writes to a conversation.
      if (pathname === '/api/v2/maintenance/compaction-fork-probe' && req.method === 'GET') { const option = name => requestURL.searchParams.has(name) ? Number(requestURL.searchParams.get(name)) : undefined; if (compactionProbe.running && ![...requestURL.searchParams.keys()].length) return send(200, { ...compactionProbe.status(), plan: null }); return send(200, { ...compactionProbe.status(), plan: await compactionProbe.plan({ points: option('points'), budgetTokens: option('budgetTokens'), ...(requestURL.searchParams.get('projectId') ? { projectId: requestURL.searchParams.get('projectId') } : {}) }) }); }
      if (pathname === '/api/v2/maintenance/compaction-fork-probe' && req.method === 'POST') return send(202, await compactionProbe.start(await body(req)));
      if (pathname === '/api/v2/maintenance/compaction-fork-probe/cancel' && req.method === 'POST') { await body(req); return send(200, compactionProbe.cancel()); }
      { const report = req.method === 'GET' && pathname.match(/^\/api\/v2\/maintenance\/compaction-fork-probe\/reports\/([a-zA-Z0-9-]{1,80})$/); if (report) return send(200, compactionProbe.report(report[1])); }
      // W2 paired schedule-text replay (benchmark/schedule-text-replay.mjs; `./rna schedule-text …`): GET reads status and the dry-run
      // plan (skipped while a run is in progress unless options ask for it); POST starts only with approved:true within the approved
      // 1,000,000 tokens; it never writes to a conversation or a schedule.
      if (pathname === '/api/v2/maintenance/schedule-text-replay' && req.method === 'GET') { const option = name => requestURL.searchParams.has(name) ? Number(requestURL.searchParams.get(name)) : undefined; if (scheduleTextReplay.running && ![...requestURL.searchParams.keys()].length) return send(200, { ...scheduleTextReplay.status(), plan: null }); return send(200, { ...scheduleTextReplay.status(), plan: await scheduleTextReplay.plan({ foreground: option('foreground'), planner: option('planner'), budgetTokens: option('budgetTokens'), approveMore: option('approveMore'), ...(requestURL.searchParams.get('baseline') ? { baseline: requestURL.searchParams.get('baseline') } : {}), ...(requestURL.searchParams.get('projectId') ? { projectId: requestURL.searchParams.get('projectId') } : {}) }) }); }
      if (pathname === '/api/v2/maintenance/schedule-text-replay' && req.method === 'POST') return send(202, await scheduleTextReplay.start(await body(req)));
      if (pathname === '/api/v2/maintenance/schedule-text-replay/cancel' && req.method === 'POST') { await body(req); return send(200, scheduleTextReplay.cancel()); }
      { const report = req.method === 'GET' && pathname.match(/^\/api\/v2\/maintenance\/schedule-text-replay\/reports\/([a-zA-Z0-9-]{1,80})$/); if (report) return send(200, scheduleTextReplay.report(report[1])); }
      // Settings API: only apiKey, fastModel (llmModel = legacy alias) and autoModel are user settings; old UI switches (mode/modes/backend) are ignored, never stored.
      if (req.method === 'PATCH' && pathname === '/api/decision-kernel') return send(200, decisions.update(decisions.userSettings(await body(req))));
      if (req.method === 'GET' && pathname === '/api/provider-auth-methods') return send(200, store.configurationService.subscriptionAuth.catalog());
      const providerAuth = pathname.match(/^\/api\/providers\/([^/]+)\/auth(?:\/(start|complete|cancel|logout))?$/);
      if (providerAuth && req.method === 'GET' && !providerAuth[2]) return send(200, store.configurationService.subscriptionAuth.status(decodeURIComponent(providerAuth[1])));
      if (providerAuth && req.method === 'POST' && providerAuth[2]) return send(200, await store.configurationService.subscriptionAuth[providerAuth[2]](decodeURIComponent(providerAuth[1]), await body(req)));
      if (req.method === 'POST' && /^\/api\/providers\/[^/]+\/refresh-models$/.test(pathname)) { const id = decodeURIComponent(pathname.split('/')[3]); await body(req); return send(200, await store.configurationService.refreshModels(id)); }
      const projectPermissions = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/permissions$/);
      if (req.method === 'GET' && projectPermissions) return send(200, permissions.get(projectPermissions[1]));
      // The agent's browser, live (side panel 浏览器 · Rna): state + JPEG frames of the page it is using.
      const browserView = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/browser-view$/);
      if (req.method === 'GET' && browserView) {
        if (!store.state.sessions.some(session => session.id === browserView[1])) throw new DomainError('会话不存在', 404);
        const view = capabilityService.browserPool().view(browserView[1]);
        if (!view) throw new DomainError('浏览器服务已关闭', 503);
        res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        // A slow reader skips frames rather than buffering them; state events always go out.
        const unsubscribe = view.subscribe(event => { if (res.destroyed || event.type === 'frame' && res.writableLength > 512 * 1024) return; res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); });
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': hb\n\n'); }, 15000); heartbeat.unref();
        res.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }
      // Legacy whole-state readers (stream-protocol-v2.md, opening section): /api/stream, /api/state, /api/projects,
      // /api/sessions and /api/sessions/:id. Frozen for QA scripts and the web's legacy read mode: no product reader
      // uses them (web, CLI and desktop read /api/v2), and nothing new is built on them. Each answer says so (RFC 9745
      // Deprecation) and names its successor. /api/stream sends the whole session on every change, display ticks included.
      if (req.method === 'GET' && pathname === '/api/stream') {
        const sessionId = requestURL.searchParams.get('session');
        if (sessionId && !store.state.sessions.some(session => session.id === sessionId)) throw new DomainError('会话不存在', 404);
        if (streams.size >= 32) throw new DomainError('事件订阅过多', 429);
        res.writeHead(200, { ...headers, ...legacyHeaders('/api/v2/stream'), 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        let pending;
        const emit = () => {
          pending = null;
          if (res.destroyed) return;
          if (res.writableLength > 1024 * 1024) return res.end();
          const snapshot = store.streamSnapshot(sessionId);
          res.write(`id: ${snapshot.revision}\nevent: state\ndata: ${JSON.stringify({ revision: snapshot.revision, maintenance: maintenanceGate.public(), ...(sessionId ? { session: snapshot.session } : {}) })}\n\n`);
        };
        const unsubscribe = store.subscribe(() => { pending ??= setTimeout(emit, 50); });
        const heartbeat = setInterval(() => { if (res.destroyed) return; if (res.writableLength > 1024 * 1024) return res.end(); res.write(': heartbeat\n\n'); }, 15000); heartbeat.unref();
        streams.add(res);
        res.on('close', () => { clearTimeout(pending); clearInterval(heartbeat); unsubscribe(); streams.delete(res); });
        emit(); return;
      }
      const memory = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/memory$/);
      if (req.method === 'GET' && memory) return send(200, await store.memoryService.list(memory[1], Object.fromEntries(requestURL.searchParams)));
      const memoryTask = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/memory\/sessions\/([a-zA-Z0-9_-]+)\/tasks\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && memoryTask) return send(200, await store.memoryService.sessionTask(memoryTask[1], memoryTask[2], memoryTask[3]));
      if (req.method === 'GET' && pathname === '/api/state') return send(200, { ...store.get(), maintenance: maintenanceGate.public() }, legacyHeaders('/api/v2/bootstrap'));
      if (req.method === 'GET' && pathname === '/api/events') return send(200, store.get().events);
      if (req.method === 'GET' && pathname === '/api/health') return send(200, health());
      if (req.method === 'GET' && pathname === '/api/projects') return send(200, store.get().projects, legacyHeaders('/api/v2/bootstrap'));
      const foundation = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/skill-foundation$/);
      if (foundation && req.method === 'GET') { const target = store.state.projects.find(row => row.id === foundation[1]); if (!target) throw new DomainError('项目不存在', 404); return send(200, target.skillFoundation ?? { status: 'pending' }); }
      const sourceRoute = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/sources(?:\/([a-zA-Z0-9-]+))?$/);
      if (sourceRoute && ['GET', 'PATCH'].includes(req.method)) {
        if (!observationService) throw new DomainError('目录观察服务未启用', 503);
        if (req.method === 'GET' && !sourceRoute[2]) return send(200, observationService.list(sourceRoute[1]));
        if (req.method === 'PATCH' && sourceRoute[2]) return send(200, await observationService.control(sourceRoute[1], sourceRoute[2], await body(req)));
        throw new DomainError('无效的来源操作', 400);
      }
      const scheduleRoute = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/schedules(?:\/([a-zA-Z0-9-]+))?$/);
      if (scheduleRoute && req.method === 'GET' && !scheduleRoute[2]) return send(200, projectSchedules.list(scheduleRoute[1]));
      const workspaceFiles = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/(files|file|file\/download|file\/raw|preview|preview\/discovery)$/);
      if (req.method === 'GET' && workspaceFiles) {
        const [, id, action] = workspaceFiles, input = Object.fromEntries(requestURL.searchParams);
        if (action === 'files') return send(200, await workspaceInspection.list(id, input));
        if (action === 'file') return send(200, await workspaceInspection.read(id, input));
        if (action === 'preview') return send(200, workspaceInspection.previewStatus(id));
        if (action === 'preview/discovery') return send(200, await workspaceInspection.discoverPreview(id, { sessionId: input.sessionId }));
        if (action === 'file/raw') {
          // Inline bytes for the web preview (fetched into blobs). A direct
          // navigation still gets an opaque, script-less sandboxed document.
          const result = await workspaceInspection.raw(id, input);
          res.writeHead(200, { ...headers, 'Content-Type': result.contentType, 'Content-Disposition': `inline; filename="file"; filename*=UTF-8''${encodeURIComponent(result.filename)}`, 'Content-Length': result.bytes.length, 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'", 'Cross-Origin-Resource-Policy': 'same-origin', 'X-File-Size': String(result.size), ETag: `"${result.version.replaceAll(':', '-')}"` }); res.end(result.bytes); return;
        }
        const result = await workspaceInspection.download(id, input);
        res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(result.filename)}`, 'Content-Length': result.bytes.length }); res.end(result.bytes); return;
      }
      const attachment = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/attachments(?:\/([a-f0-9-]+))?$/);
      const rewindRoute = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/items\/([a-zA-Z0-9:_-]+)\/rewind$/);
      if (req.method === 'POST' && rewindRoute) {
        if (!executor) throw new DomainError('运行时未启用，不能编辑历史消息', 503);
        const input = await body(req);
        if (!['user_edit', 'user_delete'].includes(input?.reason)) throw new DomainError('reason 必须为 user_edit 或 user_delete');
        if (input.dryRun !== true) return send(200, await executor.rewind(rewindRoute[1], rewindRoute[2], { reason: input.reason }));
        // A dry run asks OpenViking about every removed turn: a client that went away must not keep it going.
        const controller = new AbortController(), disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnected);
        try {
          const result = await executor.rewind(rewindRoute[1], rewindRoute[2], { reason: input.reason, dryRun: true, signal: controller.signal });
          if (!res.destroyed && !controller.signal.aborted) return send(200, result);
          return;
        } catch (error) { if (!controller.signal.aborted) throw error; return; }
        finally { res.off('close', disconnected); }
      }
      // Streaming upload (raw body, no size cap): the file goes straight to disk.
      if (req.method === 'POST' && attachment && !attachment[2] && String(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) {
        return send(201, await saveAttachmentStream(store, attachment[1], { name: requestURL.searchParams.get('name') ?? '', type: requestURL.searchParams.get('type') || undefined, stream: req }));
      }
      if (req.method === 'GET' && attachment?.[2]) {
        const result = readAttachment(store, attachment[1], attachment[2]);
        res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(result.attachment.name)}`, 'Content-Length': result.bytes.length }); res.end(result.bytes); return;
      }
      const session = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)$/);
      const command = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/commands$/);
      if (req.method === 'GET' && command) return send(200, commands.describe(command[1]));
      const exportSession = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/export\.zip$/);
      if (req.method === 'GET' && exportSession) {
        const result = commands.export(exportSession[1]);
        res.writeHead(200, { ...headers, 'Content-Type': result.contentType, 'Content-Disposition': `attachment; filename="${result.filename}"`, 'Content-Length': result.bytes.length }); res.end(result.bytes); return;
      }
      if (req.method === 'GET' && pathname === '/api/sessions') return send(200, store.get().sessions, legacyHeaders('/api/v2/bootstrap'));
      if (req.method === 'GET' && session) {
        const found = store.get().sessions.find(item => item.id === session[1]);
        if (!found) throw new DomainError('会话不存在', 404);
        return send(200, found, legacyHeaders(`/api/v2/sessions/${found.id}`));
      }
      const changeDetail = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/background-changes\/([a-zA-Z0-9-]+)$/);
      if (changeDetail && req.method === 'GET') { if (!projectInitiative) throw Object.assign(new DomainError('项目主动运行控制器未启用', 503), { code: 'initiative_unavailable' }); try { return send(200, projectInitiative.backgroundChangeDetail(changeDetail[1], changeDetail[2])); } catch (error) { throw Object.assign(new DomainError(error.message, error.status ?? 500), { code: error.code }); } }
      const changeRevert = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/background-changes\/([a-zA-Z0-9-]+)\/revert$/);
      if (changeRevert && req.method === 'POST') { if (!projectInitiative) throw Object.assign(new DomainError('项目主动运行控制器未启用', 503), { code: 'initiative_unavailable' }); const input = await body(req); try { return send(200, await projectInitiative.revertBackgroundChange(changeRevert[1], changeRevert[2], input)); } catch (error) { throw Object.assign(new DomainError(error.message, error.status ?? 409), { code: error.code }); } }
      const backgroundActions = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/initiative\/actions(?:\/([a-zA-Z0-9-]+)\/control)?$/);
      if (backgroundActions && req.method === 'GET' && !backgroundActions[2]) {
        if (!projectInitiative) throw Object.assign(new DomainError('项目主动运行控制器未启用', 503), { code: 'initiative_unavailable' });
        return send(200, projectInitiative.actionView(backgroundActions[1]));
      }
      if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) throw new DomainError('路径或方法不存在', 404);
      const evolutionRoute = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/evolution$/);
      const input = await body(req, attachment ? Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 2048 : evolutionRoute ? 512 * 1024 : 65536);
      if (req.method === 'POST' && attachment && !attachment[2]) return send(201, saveAttachment(store, attachment[1], input));
      if (req.method === 'POST' && command) return send(200, await commands.execute(command[1], input));
      if (workspaceFiles?.[2] === 'preview' && ['POST', 'DELETE'].includes(req.method)) return send(200, req.method === 'POST' ? await workspaceInspection.startPreview(workspaceFiles[1], input) : await workspaceInspection.stopPreview(workspaceFiles[1]));
      if (req.method === 'PATCH' && projectPermissions) { const view = permissions.update(projectPermissions[1], input); settleFullAccess(projectPermissions[1]); return send(200, permissions.get(projectPermissions[1]) ?? view); }
      const interaction = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/interactions\/([a-f0-9]{64})\/(answer|cancel)$/);
      if (req.method === 'POST' && interaction) {
        const result = interactions[interaction[3]](interaction[1], interaction[2], input);
        if (result.requiresResume && !maintenanceGate.held && !questionHandoff.holdsAnswer(interaction[1])) { store.controlSession(interaction[1], 'resume'); result.requiresResume = false; result.resumed = true; }
        return send(200, result);
      }
      const cleanup = pathname.match(/^\/api\/session-deletions\/([a-zA-Z0-9-]+)\/retry$/);
      if (req.method === 'POST' && cleanup) {
        if (!deletions.status(cleanup[1])) throw new DomainError('清理记录不存在', 404);
        void deletions.clean(cleanup[1], { retry: true }); return send(202, { sessionId: cleanup[1], cleanup: await deletions.wait(cleanup[1]) });
      }
      // The user's decision on a blocked cleanup (review D2-3): { choice } must be the one the record offers.
      const decision = pathname.match(/^\/api\/session-deletions\/([a-zA-Z0-9-]+)\/decide$/);
      if (req.method === 'POST' && decision) {
        if (typeof input.choice !== 'string') throw Object.assign(new DomainError('choice 必须是字符串', 400), { code: 'cleanup_decision_unavailable' });
        void deletions.decide(decision[1], input.choice); return send(202, { sessionId: decision[1], cleanup: await deletions.wait(decision[1]) });
      }
      if (pathname === '/api/workspaces/browse' && req.method === 'POST') {
        const directory = await browseDirectories(input);
        return send(200, { ...directory, projects: matchingWorkspaces(store.state.projects, directory.path).map(project => ({ id: project.id, name: project.name, archivedAt: project.archivedAt })) });
      }
      if (pathname === '/api/workspaces/directories' && req.method === 'POST') return send(201, await createDirectory(input));
      if (pathname === '/api/workspaces/open' && req.method === 'POST') {
        const result = store.openWorkspace({ ...input, initialize: input.demo !== true });
        return send(result.reused ? 200 : 202, result);
      }
      if (evolutionRoute && req.method === 'POST') return input.action === 'adopt-evaluation-standard' ? send(200, await evolution.adoptEvaluationStandard(evolutionRoute[1], input)) : input.preview === true ? send(200, evolution.preview(evolutionRoute[1], input)) : send(202, evolution.start(evolutionRoute[1], input));
      if (scheduleRoute && req.method === 'POST' && !scheduleRoute[2]) {
        const { requestId, ...draft } = input;
        if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(requestId))) throw new DomainError('日程请求标识格式无效');
        return send(201, projectSchedules.create(scheduleRoute[1], draft, { requestId }));
      }
      if (scheduleRoute?.[2] && req.method === 'PATCH') return send(200, projectSchedules.update(scheduleRoute[1], scheduleRoute[2], input));
      if (scheduleRoute?.[2] && req.method === 'DELETE') return send(200, projectSchedules.remove(scheduleRoute[1], scheduleRoute[2]));
      if (backgroundActions && req.method === 'POST' && backgroundActions[2]) {
        if (!projectInitiative) throw Object.assign(new DomainError('项目主动运行控制器未启用', 503), { code: 'initiative_unavailable' });
        return send(200, backgroundActions[2] ? await projectInitiative.controlAction(backgroundActions[1], backgroundActions[2], input) : projectInitiative.actionView(backgroundActions[1]));
      }
      const initiativeResolution = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/initiative\/actions\/([a-zA-Z0-9-]+)\/resolve$/);
      if (initiativeResolution && req.method === 'POST') {
        if (!projectInitiative) throw Object.assign(new DomainError('项目主动运行控制器未启用，无法确认后台动作', 503), { code: 'initiative_unavailable' });
        return send(200, await projectInitiative.resolveAction(initiativeResolution[1], initiativeResolution[2], input));
      }
      if (projectCapabilities && req.method === 'POST') {
        const [, projectId, action] = projectCapabilities;
        if (action === 'inspect') return send(200, await capabilityInstaller.inspect(input, { projectId }));
        if (action === 'install') return send(200, await capabilityInstaller.install(projectId, input));
        if (action === 'assign') return send(200, await capabilityInstaller.assign(projectId, input));
        if (action === 'remove') return send(200, await capabilityInstaller.remove(projectId, input));
      }
      if (pathname === '/api/configuration' && req.method === 'PATCH') return send(200, store.configurationService.update(input));
      if (pathname === '/api/providers' && req.method === 'POST') return send(201, store.configurationService.provider(null, input));
      const provider = pathname.match(/^\/api\/providers\/([a-zA-Z0-9-]+)$/);
      if (provider && ['PATCH', 'DELETE'].includes(req.method)) return send(200, store.configurationService.provider(provider[1], input, req.method === 'DELETE'));
      const providerTest = pathname.match(/^\/api\/providers\/([a-zA-Z0-9-]+)\/test$/);
      if (providerTest && req.method === 'POST') return send(200, await store.configurationService.test(providerTest[1]));
      if (memory && req.method === 'POST') return send(201, await store.memoryService.write(memory[1], null, input));
      const memoryAction = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/memory\/(search|browse|read|health|initialize)$/);
      if (memoryAction && req.method === 'POST') return send(200, await store.memoryService[memoryAction[2]](memoryAction[1], input));
      const memoryWrite = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/memory\/write$/);
      if (memoryWrite && req.method === 'POST') return send(200, await store.memoryService.write(memoryWrite[1], null, input));
      const memorySessions = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/memory\/sessions$/);
      if (memorySessions && req.method === 'POST') return send(201, await store.memoryService.createSession(memorySessions[1], input));
      const memorySessionAction = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/memory\/sessions\/([a-zA-Z0-9_-]+)\/(messages|commit)$/);
      if (memorySessionAction && req.method === 'POST') return send(200, await store.memoryService[memorySessionAction[3] === 'messages' ? 'sessionMessages' : 'sessionCommit'](memorySessionAction[1], memorySessionAction[2], input));
      const memoryEntry = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/memory\/([a-zA-Z0-9-]+)$/);
      if (memoryEntry && ['PATCH', 'DELETE'].includes(req.method)) throw new DomainError('本地记忆 API 已移除。请通过 OpenViking URI 读取或写入项目记忆。', 410);

      const capability = pathname.match(/^\/api\/capabilities\/(skills|mcpServers)$/);
      if (capability && req.method === 'POST') return send(201, capabilityService.register(capability[1], input));
      if (pathname === '/api/projects' && req.method === 'POST') {
        const result = input.workspace !== undefined ? store.openWorkspace({ ...input, initialize: input.demo !== true }) : store.createProject({ ...input, initialize: input.demo !== true });
        return send(result.reused ? 200 : 202, result);
      }
      const initialize = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/initialize$/);
      if (initialize && req.method === 'POST') return send(202, initializer.retry(initialize[1]));
      if (foundation && req.method === 'POST') return send(202, initializer.retryFoundation(foundation[1], input));
      const project = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)$/);
      if (project && req.method === 'PATCH') return send(200, store.updateProject(project[1], input));
      if (project && req.method === 'DELETE') {
        const result = store.deleteProject(project[1]);
        const cleanups = await Promise.all(result.deletedSessionIds.map(async id => ({ sessionId: id, ...await deletions.wait(id) })));
        return send(cleanups.every(row => row.status === 'completed') ? 200 : 202, { ...result, cleanup: { status: cleanups.every(row => row.status === 'completed') ? 'completed' : 'pending', sessions: cleanups } });
      }
      const observation = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/observations$/);
      if (observation && req.method === 'POST') return send(201, store.observeProject(observation[1], input));
      const presence = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/presence$/);
      if (presence && req.method === 'POST') {
        const saved = store.presence(presence[1], input); if (saved?.visible !== false) void invitations.onPresence(presence[1]).catch(() => {});
        // Messages in the conversation the user has in front are read there; the bell keeps only what they have not seen.
        if (saved?.visible === true) try { readSeenInConversation(store, presence[1], saved.sessionId); } catch { /* never blocks presence */ }
        // Typing in a conversation: its next turn's MCP servers start now (zcode-style prewarm), off the request path.
        if (input?.typing === true && typeof input.sessionId === 'string') void executor?.prewarm?.(input.sessionId).catch(() => {});
        return send(200, saved);
      }
      const version = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/versions\/([a-zA-Z0-9-]+)\/control$/);
      if (version && req.method === 'POST') {
        const project = store.state.projects.find(p => p.id === version[1]), candidate = project?.versions.find(v => v.id === version[2]);
        // Validate the generation that will actually serve the next turn. A
        // damaged trial must still be escapable when its baseline is healthy.
        const targetId = input.action === 'rollback' ? project?.trialVersionId === candidate?.id ? project?.activeVersionId : candidate?.parentVersionId : candidate?.id;
        const target = project?.versions.find(v => v.id === targetId);
        if (target?.bundle) {
          const record = await new ProjectGenomeStore(store).read(version[1], target.id);
          if (record.hash !== target.bundle.hash) throw new DomainError('项目版本记录与能力文件不一致，请恢复已验证的版本后重试。', 409);
        }
        const controlled = store.version(version[1], version[2], input.action);
        // RRSI: adopt/rollback after trial are the strongest real verdicts; mirror them in the genome git repo.
        await evolutionService.rrsi?.onVersionControl(version[1], version[2], input.action).catch(() => {});
        return send(200, controlled);
      }
      const checks = pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/checks$/);
      if (checks && req.method === 'POST') return send(200, store.projectCheck(checks[1], input));
      if (pathname === '/api/autonomy/demos' && req.method === 'POST') return send(201, store.createAutonomyDemo(input));
      const goalControl = pathname.match(/^\/api\/goals\/([a-zA-Z0-9-]+)\/control$/);
      if (goalControl && req.method === 'POST') return send(200, store.controlGoal(goalControl[1], input));
      if (pathname === '/api/sessions' && req.method === 'POST') {
        // A conversation in its own worktree (design §7.1) only where isolation holds for its project; the reason says why not.
        if (input.worktree === true && typeof input.projectId === 'string' && store.state.projects.some(row => row.id === input.projectId)) {
          const isolation = await engine.isolation(input.projectId).catch(() => ({ enabled: false, reason: 'git_unavailable' }));
          if (!isolation.enabled) throw Object.assign(new DomainError(inLanguage(interfaceLanguageOf(store.state), { zh: '这个项目现在不能用独立工作树，对话没有创建。', en: 'This project can’t use a separate worktree right now, so the conversation wasn’t created.' }), ISOLATION_ERRORS.worktree_unavailable), { code: 'worktree_unavailable', reason: isolation.reason });
        }
        return send(201, store.createSession(input));
      }
      if (session && req.method === 'PATCH') return send(200, store.updateSession(session[1], input));
      // A conversation whose worktree holds changes not applied to the project folder needs `confirm: true` (design §5.3).
      if (session && req.method === 'DELETE') { await deletions.confirmWorktree(session[1], { confirm: input.confirm === true }); for (const side of store.state.sessions.filter(row => row.kind === 'side' && row.parentSessionId === session[1])) store.deleteSession(side.id); const result = store.deleteSession(session[1]), cleanup = await deletions.wait(session[1]); return send(cleanup?.status === 'completed' ? 200 : 202, { ...result, cleanup }); }
      const message = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/messages$/);
      if (message && req.method === 'POST') {
        const accepted = store.message(message[1], input);
        // answer.match: a typed message may answer an open question card (never a permission request). A resent
        // 接着完成 (it carries `continues`) is the host's own wording for a background task, never an answer.
        if (typeof input?.text === 'string' && input.text.trim() && !input.continues) void interactions.matchMessage(message[1], { text: input.text, itemId: accepted?.item?.id ?? accepted?.itemId ?? null }).catch(() => {});
        return send(200, accepted);
      }
      const control = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/control$/);
      const recoveryResolution = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/recovery$/);
      if (recoveryResolution && req.method === 'POST') return send(200, input?.choice !== undefined ? store.resolveRuntimeRecovery(recoveryResolution[1], input) : store.resolveRuntimeTools(recoveryResolution[1], input));
      if (control && req.method === 'POST') return send(200, store.controlSession(control[1], input.action));
      const inbox = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/inbox\/([a-zA-Z0-9-]+)$/);
      if (inbox && req.method === 'DELETE') return send(200, executor ? await executor.withdraw(inbox[1], inbox[2]) : store.removeInbox(inbox[1], inbox[2]));
      if (pathname === '/api/tasks' && req.method === 'POST') return send(201, store.create(input));
      const task = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)$/);
      if (task && req.method === 'PATCH') return send(200, store.task(task[1], input));
      if (task && req.method === 'DELETE') return send(200, store.deleteTask(task[1]));
      if (pathname === '/api/settings' && req.method === 'PATCH') return send(200, store.settings(input));
      if (pathname === '/api/emergency' && req.method === 'POST') return send(200, store.emergency(input.stop));
      const config = pathname.match(/^\/api\/(skills|integrations)\/([a-zA-Z0-9-]+)$/);
      if (config && req.method === 'PATCH') return send(200, store.toggle(config[1], config[2], input.enabled));
      const candidate = pathname.match(/^\/api\/candidates\/([a-zA-Z0-9-]+)$/);
      if (candidate && req.method === 'PATCH') return send(200, store.candidate(candidate[1], input.action));
      throw new DomainError('接口不存在', 404);
    } catch (error) { if (!res.headersSent) send(error.status ?? 500, { error: error.status ? error.message : '内部错误；状态未确认，请检查 daemon 日志', ...((error.code?.startsWith('maintenance_') || error.code?.startsWith('replay_') || /^(?:TERMINAL|SIDE_CHAT)_/.test(error.code ?? '') || error.code === 'restored_state_review' || ['MEMORY_LAYER_UNAVAILABLE', 'invalid_resolution', 'action_still_running', 'project_not_found', 'action_not_found', 'closed', 'initiative_unavailable', 'interaction_not_found', 'interaction_unavailable', 'interaction_conflict', 'invalid_answer', 'invalid_interaction', 'task_context_revoked', 'task_not_found', 'session_unavailable', 'cleanup_not_found', 'cleanup_running', 'cleanup_decision_unavailable'].includes(error.code)) ? { code: error.code } : {}), ...(error.status && Object.hasOwn(ISOLATION_ERRORS, error.code ?? '') ? { code: error.code, ...Object.fromEntries(['reason', 'unapplied', 'workers', 'secret', 'worktreeId'].filter(key => error[key] !== undefined).map(key => [key, error[key]])) } : {}) }); if (!error.status) console.error(error); } finally { if (admitted) admittedHttp--; }
  };
  // Which route held the loop: each handler's synchronous slice up to its first await (event-loop attribution, diagnostic only).
  const server = http.createServer((req, res) => { const started = performance.now(), done = handle(req, res); loopHistograms.record(routeName(req.method, req.url), performance.now() - started); return done; });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
  const timer = ticks ? setInterval(() => {
    try { loopHistograms.time('store tick', () => store.tick()); lastTickAt = new Date().toISOString(); lastTickError = null; }
    catch (error) { lastTickError = error.code ?? 'TICK_FAILED'; console.error('调度 tick 失败：', lastTickError); }
  }, tickIntervalMs) : null;
  timer?.unref();
  const close = () => {
    if (closePromise) return closePromise;
    closing = true; questionHandoff.close(); maintenanceGate.close(); maintenanceSelfHeal?.close(); store.usageLedger?.keepAlive?.close?.(); clearInterval(isolationTimer); clearInterval(projectFilesTimer); clearInterval(timer); clearInterval(heartbeat); clearInterval(dependencyTimer); clearInterval(systemRecordTimer); dependencyAbort.abort(); loopDelay.close();
    apiV2.close(); for (const response of streams) response.end();
    const httpClosed = new Promise(resolve => { if (!server.listening) return resolve(); server.close(resolve); server.closeIdleConnections(); });
    // Cancel every subsystem before waiting for any one of them. A hung model
    // or tool must not prevent unrelated work from checkpointing and stopping.
    // Each subsystem is named so an undrained shutdown reports what hung or failed instead of only exit 75.
    const subsystems = [['http', httpClosed], ...Object.entries({ effortReplay, compactionProbe, scheduleTextReplay, terminals, genes, deepCheck, taskAttention, diagnostics, revocations, mind, observationService, decisions, judgmentPolicies, mediaTools, vision, subscriptionAuth: store.configurationService.subscriptionAuth, workspaceInspection, capabilityService, projectLearning, projectInitiative, evolution, evolutionService, initializer, interactions, idleCompaction, executor, builtinAgentService, deletions, sessionWorktrees, engine, cacheSurvival: survival, isolationStartup: isolationStartup && { close: () => isolationStartup } }).filter(([, controller]) => controller).map(([name, controller]) => [name, Promise.resolve().then(() => controller.close())])];
    const started = performance.now(), settled = new Map();
    for (const [name, promise] of subsystems) promise.then(() => settled.set(name, { status: 'fulfilled', ms: Math.round(performance.now() - started) }), error => settled.set(name, { status: 'rejected', ms: Math.round(performance.now() - started), code: String(error?.code ?? error?.name ?? 'error').slice(0, 80) }));
    const draining = Promise.allSettled(subsystems.map(([, promise]) => promise));
    closePromise = (async () => {
      let deadline;
      try {
        const result = await Promise.race([draining, new Promise(resolve => { deadline = setTimeout(() => resolve(null), shutdownTimeoutMs); })]);
        const drained = result !== null && result.every(item => item.status === 'fulfilled');
        const diagnostic = { schemaVersion: 1, at: new Date().toISOString(), drained, timeoutMs: shutdownTimeoutMs, pending: subsystems.map(([name]) => name).filter(name => !settled.has(name)), rejected: [...settled].filter(([, row]) => row.status === 'rejected').map(([name, row]) => ({ name, code: row.code })), slowest: [...settled].sort((a, b) => b[1].ms - a[1].ms).slice(0, 5).map(([name, row]) => ({ name, ms: row.ms })) };
        // The rollups' last folds (each fold is safe to lose: its raw rows are still on disk), then the state.
        try { hostMetrics.close(); store.usageLedger?.flush?.(); } catch { /* metrics never block shutdown */ }
        try { store.memoryService.close(); } catch { /* the embedded memory file is already consistent after each request */ }
        // Only a drained stop has no writer left; it leaves the state readable by earlier releases.
        if (drained) try { store.close(); } catch (error) { console.error(`state checkpoint at shutdown failed: ${error.code ?? error.message}`); }
        if (!drained) console.error(`shutdown not drained: pending=${diagnostic.pending.join(',') || '-'} rejected=${diagnostic.rejected.map(row => `${row.name}:${row.code}`).join(',') || '-'}`);
        return { drained, diagnostic };
      } finally { clearTimeout(deadline); server.closeAllConnections(); }
    })();
    return closePromise;
  };
  server.on('close', () => { void close(); });
  // Private folders left by projects deleted before deletion cleaned them up (a deleted project's run files wait until
  // its conversation deletions settled), and live projects' run journals past retention (X-3). At start, then daily.
  const projectFilesSweep = async () => {
    const unsettled = (store.state.sessionDeletions ?? []).filter(row => !['completed', 'blocked'].includes(row.status)).map(row => row.projectId).filter(Boolean);
    await sweepProjectFiles(store.file, store.state.projects.map(project => project.id), { keep: unsettled }).catch(() => {});
    // Captured internal calls past their 14 days (or over their limit), whether capture is on or off (review RPL-2).
    pruneEffortCaptures(store.file, { state: store.state });
    // The compaction-fork probe's summaries of conversations no longer in state (a purge missed, or a deleted project's).
    pruneProbeSummaries(store.file, { state: store.state });
    // The schedule-text replay's reports of conversations no longer in state (they hold the model's proposed task and the words it quoted).
    pruneScheduleReplayReports(store.file, { state: store.state });
    for (const project of [...store.state.projects]) { if (closing) return; await pruneRunJournals(store.file, project).catch(() => {}); }
  };
  if (ticks && runtime) setImmediate(() => { void projectFilesSweep(); });
  const projectFilesTimer = ticks && runtime ? setInterval(() => { if (!closing) void projectFilesSweep(); }, 86400000) : null; projectFilesTimer?.unref();
  // Cards asked before 完全访问 was chosen are settled once the host is up.
  if (ticks && runtime) setImmediate(() => settleFullAccess(null));
  // Isolation at startup (design §3.6, §4.2 "空闲时", §5.3), after crashed writes settled: Rna's worktrees reconciled
  // with git (orphans recorded, gone ones marked missing), idle session worktrees applied, then retention. Background
  // worktrees cut off by the restart settle in the initiative's own upkeep. Retention runs again daily.
  const isolationSweep = () => Promise.allSettled([engine.sweep(), worktrees.sweep()]).then(results => { for (const result of results) if (result.status === 'rejected') console.warn(`isolation sweep: ${result.reason?.message ?? result.reason}`); })
    .then(() => (closing ? null : isolationStorage.refresh().catch(error => console.warn(`isolation storage: ${error.message}`))));
  const isolationStartup = ticks && runtime ? (async () => {
    await isolationRecovery;
    for (const project of [...store.state.projects]) { if (closing) return; await worktrees.reconcile(project.id).catch(error => console.warn(`worktree reconcile ${project.id}: ${error.message}`)); }
    if (closing) return;
    await sessionWorktrees.recover().catch(error => console.warn(`session worktrees at start: ${error.message}`));
    if (!closing) await isolationSweep();
  })() : null;
  const isolationTimer = ticks && runtime ? setInterval(() => { if (!closing) void isolationSweep(); }, 86400000) : null; isolationTimer?.unref();
  return { server, store, mind, genes, taskAttention, apiV2, terminals, sideChats, executor, initializer, capabilityService, capabilityInstaller, projectInitiative, projectLearning, observationService, evolution, interactions, permissions, deletions, commands, builtinAgentService, workspaceInspection, workspaceGit, engine, roots, worktrees, isolationStorage, sessionWorktrees, checkpoints, maintenanceGate, maintenanceService, questionHandoff, effortReplay, scheduleTextReplay, health, checkMemory, close };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.RNA_AGENT_PORT ?? process.env.PI_FORGE_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RNA_AGENT_PORT 必须为 1024–65535');
  const stateFile = resolve(process.env.RNA_AGENT_STATE ?? process.env.PI_FORGE_STATE ?? resolve(root, '.state/state.json'));
  const release = await acquireProcessLease(`${stateFile}.lock`, { supervisorRunId: process.env.RNA_AGENT_SUPERVISOR_RUN ?? null, generation: process.env.RNA_AGENT_GENERATION ?? null, stateFile });
  process.on('exit', release);
  await assertStateRecoveryReady(stateFile);
  const { server, close, health } = createServer({ stateFile });
  server.listen(port, '127.0.0.1', () => console.log(`Rna Agent：http://127.0.0.1:${port}\n状态：${stateFile}\n真实模型经独立 Rna SDK 执行；新项目由配置模型初始化；记忆后端按设置使用 OpenViking 或内置本地记忆。`));
  server.on('error', error => { console.error(error.message); release(); process.exit(1); });
  let stopping = false;
  // Started as the desktop app's own child (Windows, where a parent has no signal that asks for a clean stop): the app
  // asks over their channel, and the channel closing (the app is gone) means the same.
  if (process.env.RNA_AGENT_DIRECT === '1' && process.send) {
    process.on('message', message => { if (message?.type === 'rna-daemon-stop') process.emit('SIGTERM'); });
    process.on('disconnect', () => process.emit('SIGTERM'));
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return; stopping = true;
    const force = setTimeout(() => process.exit(75), 20000); force.unref();
    void close().then(result => { try { if (result.diagnostic) atomicWrite(`${maintenancePaths(stateFile).directory}/shutdown-diagnostic.json`, JSON.stringify(result.diagnostic)); } catch { /* Diagnostics never block shutdown. */ } if (result.drained) { const h = health(); atomicWrite(`${maintenancePaths(stateFile).directory}/drain-receipt.json`, JSON.stringify({ schemaVersion: 1, pid: process.pid, instanceId: h.process.instanceId, runtimeIdentity: h.runtimeIdentity, maintenanceOperationId: h.maintenance.operationId, drained: true, at: new Date().toISOString() })); } process.exit(result.drained ? 0 : 75); }).catch(() => process.exit(75));
  });
}
