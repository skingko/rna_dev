import { freshRealUsage, migrateRealBudgets } from './budget-service.mjs';
import { migrateGenomeIdentities } from './genome-identity.mjs';
import { migrateRhythmEvidenceKeys } from './project-rhythm.mjs';
import { AsyncResource } from 'node:async_hooks';
import { mkdirSync, readFileSync, copyFileSync, constants, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { canonicalDirectory, matchingWorkspaces, registeredWorkspacePath, workspaceText } from './workspace-directories.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { atomicWrite, syncDirectory } from './durable-files.mjs';
import { ShardedStateFile, readStateFile, legacyStateBackups } from './state-shards.mjs';
import { draft, finalize, isCommitted, seal } from './state-draft.mjs';
import { ConfigurationService, initialConfiguration, resolveModel, modelSelection, contextUsageFor } from './configuration.mjs';
import { migrateReasoningSelections } from './reasoning-capability.mjs';
import { MemoryService, memoryNamespace, validateNamespace } from './memory-service.mjs';
import { enqueueMemoryCheckpoint } from './memory-checkpoints.mjs';
import { makeProject, getProject, updateProject, addObservation, projectPresence, hasProjectWork, advanceProjects, controlVersion, checkProject, normalizeProjectSchedule } from './project-proactivity.mjs';
import { resolveAttachmentRefs } from './session-attachments.mjs';
import { expireFeedbackInvitations } from './session-invitations.mjs';
import { scrubSessionEvidence, resolveDeletedProjectActions } from './session-evidence-cleanup.mjs';
import { scrubLegacySourceQuotes } from './source-revocation.mjs';
import { deletionRecord, queueDeletion } from './session-deletion.mjs';
import { describeEvolutionAssessment } from './project-evolution-assessment.mjs';
import { projectRhythmStatus } from './project-rhythm.mjs';
import { INTERFACE_LANGUAGES, inLanguage, interfaceLanguageOf } from './interface-language.mjs';
import { planView } from './project-mind.mjs';
import { projectInitiativeAvailability } from './project-initiative-availability.mjs';
import { scheduleReceiptsView } from './project-schedule-service.mjs';
import { removeProjectFiles } from './project-files.mjs';

const now = () => new Date().toISOString();
const copy = (value) => structuredClone(value);
/**
 * project.git (worktree design 0.63 §11): the new-conversation worktree default and the isolation records. Old
 * state has none; the lists are kept as they are when present.
 */
function projectGit(git) {
  const value = git && typeof git === 'object' && !Array.isArray(git) ? git : {};
  const { isolationPilot, ...rest } = value;
  return { ...rest, sessionWorktreeDefault: value.sessionWorktreeDefault === true, ...(isolationPilot === true ? { isolationPilot: true } : {}), worktrees: Array.isArray(value.worktrees) ? value.worktrees : [], applies: Array.isArray(value.applies) ? value.applies : [] };
}
// A detached copy that costs nothing until used: plain data is finalized into
// committed (immutable) form and handed out as a copy-on-write draft
// (state-draft.mjs); other objects are cloned as before.
function detach(value, finals) {
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  return Array.isArray(value) || proto === Object.prototype || proto === null ? draft(finalize(value, finals)) : structuredClone(value);
}
export class DomainError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new DomainError(message, status); };
function text(value, key, max, required = true) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) fail(`${key} 必须为 1–${max} 字符的文本`);
  return value.trim();
}
function number(value, key, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${key} 必须在 ${min}–${max} 之间`);
  return value;
}
function entry(state, type, message, taskId = null, extra = {}) {
  state.events.push({ id: ++state.sequence, type, message, taskId, at: now(), ...extra });
  state.events = state.events.slice(-1000);
}
const DEFAULT_MODEL = 'Rna · 演示模型';
function sessionItem(session, kind, content, extra = {}) {
  const item = { id: randomUUID(), turnId: session.activeTurnId, kind, text: content, createdAt: now(), simulated: true, ...extra };
  session.items.push(item);
  session.updatedAt = now();
  return item;
}
function makeSession(input = {}) {
  const title = text(input.title ?? '新会话', '会话标题', 160);
  const workspace = workspaceText(input.workspace ?? process.cwd());
  const model = text(input.model ?? DEFAULT_MODEL, '模型标签', 120);
  const mode = input.mode ?? 'build';
  if (!['build', 'plan'].includes(mode)) fail('mode 必须为 build 或 plan');
  return {
    id: randomUUID(), title, workspace, model, mode, status: 'idle', pauseReason: null,
    createdAt: now(), updatedAt: now(), archivedAt: null, activeTurnId: null, items: [], turns: [], inbox: [],
    artifacts: [], plan: [], context: { tokens: 0, capacity: 128000, compactions: 0 },
    usage: { usd: 0, tokens: 0 }, submissions: [], simulated: true
  };
}
const getSession = (state, id) => state.sessions.find(s => s.id === id) ?? fail('会话不存在', 404);
const sessionArchived = (state, session) => Boolean(session?.archivedAt || state.projects.find(project => project.id === session?.projectId)?.archivedAt);
function requireActiveSession(state, session) { if (session.appRecovery?.required) fail('此会话已从恢复点还原，保留用于核查；请新建会话继续工作。', 409); if (sessionArchived(state, session)) fail('会话或所属项目已归档，请先恢复后再操作。', 409); }
function requireActiveProject(project) { if (project.archivedAt) fail('项目已归档，请先恢复后再操作。', 409); }
function validateArchive(input) {
  if (input.archived !== undefined && typeof input.archived !== 'boolean') fail('archived 必须为布尔值');
  if (input.archivedAt !== undefined) fail('归档时间由系统记录，请使用 archived 布尔值');
}
const currentTurn = session => session.turns.find(t => t.id === session.activeTurnId);
// The latest moment anything in a turn happened: where an attempt paused before pausedAt was recorded.
function lastActivity(session, turn) {
  let last = null;
  for (const item of session?.items ?? []) if (item.turnId === turn.id) for (const at of [item.createdAt, item.endedAt, item.tool?.endedAt]) if (typeof at === 'string' && (!last || at > last)) last = at;
  return last;
}
/** A turn's clock counts its attempts, not the idle gap between a failure or pause and the next try
 * (contract C-a): `activeMs` sums the attempts before the one that began at `attemptStartedAt`. */
export function startAttempt(session, turn, at = now()) {
  const started = Date.parse(turn.attemptStartedAt ?? turn.startedAt ?? turn.createdAt), ended = Date.parse(turn.completedAt ?? turn.pausedAt ?? lastActivity(session, turn) ?? '');
  turn.activeMs = Math.max(0, turn.activeMs ?? 0) + (Number.isFinite(started) && Number.isFinite(ended) && ended > started ? ended - started : 0);
  turn.attemptStartedAt = at; delete turn.pausedAt;
}
const getGoal = (state, id) => state.goals.find(g => g.id === id) ?? fail('目标不存在', 404);
const liveGoal = goal => !['completed', 'cancelled'].includes(goal.status);
const after = ms => new Date(Date.now() + ms).toISOString();
const AUTONOMY_STAGES = ['observe', 'repair', 'validate', 'evolve', 'evaluate', 'promote', 'accept'];
const AUTONOMY_ACTIONS = {
  observe: '检查长期目标、验收条件与依赖', repair: '依赖就绪后继续修复示例工具缓存策略',
  validate: '运行模拟验证并识别重复失败', evolve: '从失败记录提炼候选技能',
  evaluate: '用独立固定样例比较候选与基线', promote: '按演示门禁晋升此目标的策略',
  accept: '复用候选策略，再次验证并验收目标'
};
function goalHistory(state, goal, type, message, extra = {}) {
  const row = { id: randomUUID(), at: now(), type, message, ...extra };
  goal.history.push(row); goal.updatedAt = row.at;
  entry(state, `goal.${type}`, message, null, { goalId: goal.id, sessionId: goal.sessionId, ...extra });
}
function pauseGoal(state, goal, reason, message) {
  if (!liveGoal(goal)) return;
  goal.resumeStatus = goal.status === 'paused' ? goal.resumeStatus : goal.status;
  goal.status = 'paused'; goal.pauseReason = reason;
  const session = getSession(state, goal.sessionId);
  if (currentTurn(session)?.source === 'autonomy' && session.status === 'running') pauseSession(session, reason, message);
  else sessionItem(session, 'notice', message, { turnId: null, goalId: goal.id });
  goalHistory(state, goal, 'paused', message, { reason });
}
function deliverDependency(state, goal, eventId, source) {
  if (goal.receipts.includes(eventId)) return false;
  goal.receipts.push(eventId);
  const pending = goal.waitingFor;
  if (!pending) fail('当前目标没有等待中的依赖', 409);
  pending.receivedAt = now(); pending.eventId = eventId;
  goal.lastWake = { kind: 'event', reason: `${source}：依赖 ready（模拟事件）`, at: now(), eventId };
  goalHistory(state, goal, 'signal', goal.lastWake.reason, { eventId });
  sessionItem(getSession(state, goal.sessionId), 'notice', `${goal.lastWake.reason}。${goal.status === 'paused' ? '目标仍保持暂停，恢复后才会继续。' : '调度器将自动安排下一轮。'}`, { turnId: null, goalId: goal.id });
  if (goal.status === 'waiting') { goal.status = 'scheduled'; goal.nextWakeAt = now(); goal.waitingFor = null; }
  return true;
}
function autonomousArtifact(session, title, path, content) {
  const artifact = { id: randomUUID(), title, path, content, mime: 'text/markdown', turnId: session.activeTurnId, createdAt: now(), simulated: true };
  session.artifacts.push(artifact);
  return artifact.id;
}
function startAutonomy(state, goal) {
  const session = getSession(state, goal.sessionId);
  if (session.activeTurnId) { goal.nextWakeAt = after(3000); goal.nextAction = '等待本会话的用户轮次结束，再继续自主目标'; return; }
  const charge = 0.024, tokens = 1240;
  if (goal.runCount >= goal.budget.maxRuns || goal.budget.spentUsd + charge > goal.budget.limitUsd + 1e-8 || state.usage.usd + charge > state.settings.dailyBudget + 1e-8 || state.usage.tokens + tokens > state.settings.tokenBudget) {
    pauseGoal(state, goal, 'budget', '自主目标触达模拟预算或轮次上限，已暂停；依赖信号和时间推进不能绕过预算。');
    return;
  }
  goal.budget.spentUsd = +(goal.budget.spentUsd + charge).toFixed(3); goal.budget.tokens += tokens;
  state.usage.usd = +(state.usage.usd + charge).toFixed(3); state.usage.tokens += tokens;
  session.usage.usd = +(session.usage.usd + charge).toFixed(3); session.usage.tokens += tokens;
  session.context.tokens = Math.min(session.context.capacity, session.context.tokens + tokens);
  goal.runCount++;
  const trigger = goal.lastWake?.kind === 'event' && goal.stage === 'repair'
    ? { kind: 'event', reason: goal.lastWake.reason, eventId: goal.lastWake.eventId }
    : { kind: 'timer', reason: goal.runCount === 1 ? '用户启动长期目标后，调度器首次唤醒' : `上次检查点已保存，定时继续：${AUTONOMY_ACTIONS[goal.stage]}` };
  goal.lastWake = { ...trigger, at: now() };
  const turn = { id: randomUUID(), status: 'running', stage: 0, source: 'autonomy', goalId: goal.id, autonomyStage: goal.stage, trigger, mode: 'build', model: session.model, createdAt: now(), userItemId: null, steering: [] };
  session.turns.push(turn); session.activeTurnId = turn.id; session.status = 'running'; session.pauseReason = null;
  goal.status = 'running'; goal.pauseReason = null; goal.nextWakeAt = after(3000); goal.nextAction = AUTONOMY_ACTIONS[goal.stage];
  session.plan = AUTONOMY_STAGES.map(stage => ({ id: stage, text: AUTONOMY_ACTIONS[stage], status: AUTONOMY_STAGES.indexOf(stage) < AUTONOMY_STAGES.indexOf(goal.stage) ? 'completed' : stage === goal.stage ? 'running' : 'pending' }));
  sessionItem(session, 'notice', `自主运行 ${goal.runCount} · ${trigger.reason}`, { goalId: goal.id, source: 'autonomy', trigger });
  sessionItem(session, 'assistant', `${goal.nextAction}。本轮由持久化调度器主动发起，不需要新的用户消息。`, { goalId: goal.id });
  sessionItem(session, 'tool', `${goal.nextAction}（模拟工具）`, { goalId: goal.id, tool: { name: `demo_${goal.stage}`, args: { goalId: goal.id, policy: goal.policyVersion, stage: goal.stage, simulated: true }, status: 'running', output: '' } });
  goalHistory(state, goal, 'run.started', `自主运行 ${goal.runCount}：${goal.nextAction}`, { turnId: turn.id, trigger });
}
// A separate deterministic evaluator reads fixed fixtures and a candidate flag only.
// This demonstrates a gate, not model evaluation, process isolation or a real holdout set.
function evaluateDemoCandidate(candidate) {
  const fixtures = [
    { signal: true, revision: true, smoke: true, expected: true },
    { signal: true, revision: true, smoke: true, expected: true },
    { signal: false, revision: true, smoke: true, expected: false },
    { signal: false, revision: false, smoke: true, expected: false },
    { signal: false, revision: true, smoke: false, expected: false },
    { signal: false, revision: false, smoke: false, expected: false },
    { signal: true, revision: false, smoke: true, expected: false },
    { signal: true, revision: true, smoke: false, expected: false }
  ];
  const baseline = fixtures.filter(f => f.signal === f.expected).length;
  const passed = fixtures.filter(f => (candidate.guard === 'signal-and-revision-and-smoke' && f.signal && f.revision && f.smoke) === f.expected).length;
  return { baseline: baseline / fixtures.length * 100, score: passed / fixtures.length * 100, cases: fixtures.length, passed, isolated: true, isolation: 'independent-function-only', simulated: true, gatePassed: passed === fixtures.length && passed > baseline, evidence: `${baseline}/${fixtures.length} → ${passed}/${fixtures.length}；固定合成样例、独立函数评测，非真实保留集或进程隔离。` };
}
function finishAutonomy(state, goal) {
  const session = getSession(state, goal.sessionId), turn = currentTurn(session);
  if (!turn || turn.source !== 'autonomy') { goal.status = 'scheduled'; goal.nextWakeAt = after(3000); return; }
  let output = '', artifactIds = [];
  if (goal.stage === 'observe') {
    output = '检查发现工具结果缓存所依赖的构建尚未完成。已保存观察结果；进入等待，不进行无效轮询模型。12 秒后的演示依赖事件会自动唤醒，也可手动提前发送模拟信号。';
    goal.waitingFor = { key: 'dependency-build-ready', label: '等待示例依赖构建完成', readyAt: after(12000) };
    goal.status = 'waiting'; goal.nextWakeAt = goal.waitingFor.readyAt;
  } else if (goal.stage === 'repair') {
    output = '依赖事件已消费，恢复同一个长期目标。示例修复先要求收到构建就绪信号才复用工具结果缓存，接下来主动验证这一条件是否足够。没有修改真实工作区文件或 Pi 提示缓存。';
    artifactIds.push(autonomousArtifact(session, '自主修复记录 · 模拟', 'demo/cache-policy-repair.md', '# 工具结果缓存修复记录（模拟）\n\n基线修复：先收到依赖构建就绪信号，再复用工具结果缓存。\n\n下一步：验证仅有信号是否足够，检查版本不匹配、冒烟测试失败时会不会错误复用旧结果。\n\n此次仅生成演示记录，没有调用 Pi、LLM 或修改工作区；后续百分比是合成用例通过率，不是提示缓存命中率。'));
  } else if (goal.stage === 'validate') {
    output = '工具缓存有效性基线验证：6/8 个固定合成样例通过。两个失败来自「有就绪信号，但版本不匹配或冒烟检查未通过」时仍复用了旧结果。这里衡量用例通过率，不是 Pi 提示缓存命中率。没有直接宣告目标完成；自动安排候选提炼。';
    goal.acceptance = [{ label: '基线验证通过全部样例', passed: false, detail: '6/8 · 固定合成用例' }];
  } else if (goal.stage === 'evolve') {
    const candidate = { id: randomUUID(), goalId: goal.id, title: '等待依赖时同时校验版本与冒烟结果', kind: 'Skill policy · 模拟', state: 'draft', baseline: 75, score: null, evidence: '来自本目标的两项合成失败；等待独立模拟评测。', version: `demo-guard-${goal.id.slice(0, 8)}-v2`, previous: 'demo-guard-v1', guard: 'signal-and-revision-and-smoke', simulated: true };
    state.candidates.push(candidate); goal.candidateId = candidate.id;
    output = '从失败轨迹提炼候选技能：依赖信号 + 版本匹配 + 冒烟通过，三项都满足后才执行。候选仍是草稿，未晋升、未改变运行策略。';
    artifactIds.push(autonomousArtifact(session, '候选技能 · 模拟', 'demo/dependency-guard/SKILL.md', '# dependency-guard（模拟候选）\n\n## 适用条件\n等待外部依赖后准备继续。\n\n## 规则\n1. 收到依赖就绪信号。\n2. 检查依赖版本匹配。\n3. 确认冒烟测试通过。\n4. 三项都满足才继续。\n\n本文件只保存在演示状态中，未安装或执行真实技能。'));
  } else if (goal.stage === 'evaluate') {
    const candidate = state.candidates.find(c => c.id === goal.candidateId);
    if (!candidate) fail('演示候选缺失', 409);
    goal.evaluation = evaluateDemoCandidate(candidate);
    candidate.baseline = goal.evaluation.baseline; candidate.score = goal.evaluation.score; candidate.evidence = goal.evaluation.evidence;
    candidate.state = goal.evaluation.gatePassed ? 'evaluated' : 'rejected';
    output = `独立模拟评测：${goal.evaluation.evidence} ${goal.evaluation.gatePassed ? '满足此演示的晋升门禁，下一轮才会应用。' : '未通过门禁，保持基线策略。'}`;
    artifactIds.push(autonomousArtifact(session, '独立评测报告 · 模拟', 'demo/evaluation.md', `# 独立评测（模拟）\n\n${goal.evaluation.evidence}\n\n基线：${goal.evaluation.baseline}%\n候选：${goal.evaluation.score}%\n门禁：${goal.evaluation.gatePassed ? '通过' : '未通过'}\n\n这是独立函数上的固定合成用例，不是真实模型、隐藏保留集或隔离进程评测。`));
  } else if (goal.stage === 'promote') {
    const candidate = state.candidates.find(c => c.id === goal.candidateId);
    if (!candidate || !goal.evaluation?.gatePassed || !['evaluated', 'promoted'].includes(candidate.state)) {
      pauseGoal(state, goal, 'gate', '候选缺少有效评测，晋升门禁未通过；已暂停，未修改目标策略。'); return;
    }
    candidate.state = 'promoted'; goal.policyVersion = candidate.version;
    output = `按已声明演示门禁晋升 ${candidate.version}，只改变此目标的模拟策略版本。接下来用新策略再次验收；没有覆盖真实技能、工具或安全规则。`;
  } else if (goal.stage === 'accept') {
    const candidate = state.candidates.find(c => c.id === goal.candidateId);
    const check = candidate ? evaluateDemoCandidate(candidate) : null;
    const policyApplied = Boolean(candidate && goal.policyVersion === candidate.version && candidate.state === 'promoted');
    goal.acceptance = [
      { label: '依赖事件驱动恢复', passed: goal.receipts.length > 0, detail: '已消费去重事件' },
      { label: '复用晋升后的模拟策略', passed: policyApplied, detail: goal.policyVersion },
      { label: '最终合成验证', passed: Boolean(check?.gatePassed), detail: `${check?.passed ?? 0}/8 · 固定合成样例` },
      { label: '未超模拟预算', passed: goal.budget.spentUsd <= goal.budget.limitUsd && goal.runCount <= goal.budget.maxRuns, detail: `${goal.runCount}/${goal.budget.maxRuns} runs · $${goal.budget.spentUsd.toFixed(3)}` }
    ];
    if (!goal.acceptance.every(a => a.passed)) { pauseGoal(state, goal, 'gate', '最终验收未全部通过，目标保持暂停；不能将部分成功标记为完成。'); return; }
    output = `长期目标已完成演示验收：${goal.runCount} 次自主运行、依赖等待与自动恢复、失败驱动候选提炼、独立模拟评测、晋升后复用验证。此目标将停止调度，记录与产物保留。模型、工具、技能和评测业务结果仍为模拟。`;
    artifactIds.push(autonomousArtifact(session, '自主目标验收记录 · 模拟', 'demo/acceptance.md', `# 自主目标验收（模拟）\n\n${goal.acceptance.map(a => `- ${a.passed ? '通过' : '失败'}：${a.label} · ${a.detail}`).join('\n')}\n\n真实实现：持久化调度、事件去重、暂停/恢复、预算门禁、多轮会话。\n模拟部分：模型推理、工具执行、业务产物、独立评测与策略晋升。`));
    goal.status = 'completed'; goal.completedAt = now(); goal.nextWakeAt = null; goal.nextAction = '目标已验收，调度结束';
  }
  const tool = session.items.findLast(item => item.turnId === turn.id && item.tool?.status === 'running');
  if (tool) { tool.tool.status = 'succeeded'; tool.tool.output = output; }
  sessionItem(session, 'assistant', output, { artifactIds, goalId: goal.id });
  turn.status = 'completed'; turn.completedAt = now(); turn.stage = 1;
  session.status = 'idle'; session.activeTurnId = null; session.pauseReason = null;
  const step = session.plan.find(p => p.id === goal.stage); if (step) step.status = 'completed';
  goalHistory(state, goal, 'run.completed', `自主运行 ${goal.runCount} 完成：${AUTONOMY_ACTIONS[goal.stage]}`, { turnId: turn.id });
  if (goal.status === 'completed') goalHistory(state, goal, 'completed', '长期目标的模拟验收全部通过，停止后续唤醒。');
  else {
    goal.stage = AUTONOMY_STAGES[AUTONOMY_STAGES.indexOf(goal.stage) + 1];
    goal.nextAction = goal.status === 'waiting' ? '等待依赖事件，然后自动继续修复' : AUTONOMY_ACTIONS[goal.stage];
    if (goal.status !== 'waiting') { goal.status = 'scheduled'; goal.nextWakeAt = after(3000); }
  }
}
function beginTurn(session, message, paused = false, project = null, state = null) {
  if (state && session.modelSelection) applyModel(session, state.configuration, session.modelSelection);
  const createdAt = now(), turn = { id: randomUUID(), status: paused ? 'paused' : 'running', stage: 0, mode: session.mode, model: session.model, createdAt, attemptStartedAt: createdAt, activeMs: 0, ...(paused ? { pausedAt: createdAt } : {}), userItemId: null, steering: [] };
  if (session.modelConfig) { turn.modelConfig = copy(session.modelConfig); turn.modelSelection = copy(session.modelSelection); }
  if (project) {
    turn.projectId = project.id; turn.versionId = project.trialVersionId ?? project.activeVersionId;
    if (state) {
      const memory = state.configuration.memory;
      turn.memoryPolicy = { autoRecall: memory.autoRecall !== false, contextBudget: memory.contextBudget ?? 2048, limit: memory.limit };
      turn.memoryContext = { backend: memory.backend === 'embedded' ? 'embedded' : 'openviking', namespace: memoryNamespace(project), strategy: 'progressive', execution: memory.autoRecall !== false && turn.modelConfig?.execution === 'rna' ? 'pending' : 'on-demand', entries: [] };
    }
  }
  session.turns.push(turn);
  session.activeTurnId = turn.id;
  session.status = paused ? 'paused' : 'running';
  session.pauseReason = paused ? 'emergency' : null;
  const item = sessionItem(session, 'user', message.text, { delivery: message.delivery, attachments: message.attachments, skillIds: message.skillIds, submissionId: message.id, ...(message.continues ? { continues: message.continues } : {}) });
  turn.userItemId = item.id;
  expireFeedbackInvitations(session);
  if (turn.modelConfig?.execution === 'rna') { item.simulated = false; session.simulated = false; turn.simulated = false; }
  session.plan = [];
  // Placeholder titles take the first request's first line, so the sidebar is not a column of 项目讨论.
  if (['新会话', '项目讨论'].includes(session.title) && session.items.filter(row => row.kind === 'user').length === 1) session.title = ((message.text || '').split('\n').map(line => line.trim()).find(Boolean) || `附件 · ${message.attachments?.[0]?.name ?? ''}`).slice(0, 52);
  return item;
}
// A step cut off by a pause or restart was interrupted, not failed: the web shows it as stopped, and the
// recovered result replaces it on resume.
function pauseSession(session, reason, message, language = 'zh') {
  session.status = 'paused'; session.pauseReason = reason;
  const turn = currentTurn(session); if (turn) { if (turn.status !== 'paused') turn.pausedAt = now(); turn.status = 'paused'; }
  for (const pending of session.inbox) delete pending.deliveryStatus;
  if (turn?.modelConfig?.execution === 'rna') for (const item of session.items.filter(item => item.turnId === turn.id)) {
    if (item.streaming) item.streaming = false;
    if (item.tool?.status === 'running') { item.tool.status = 'interrupted'; item.tool.output = inLanguage(language, { zh: '这一步被打断了；恢复后按它实际留下的结果接着做。', en: 'This step was interrupted; on resume the turn continues from what it actually left.' }); }
  }
  sessionItem(session, 'notice', message);
}
// A user item carrying a subagent result: the model reads the host prompt in `text`, the
// conversation shows `displayText`, the readable notice line (contract C-c).
const subagentFields = message => ({ source: 'subagent', agentId: message.agentId, ...(typeof message.notice === 'string' && message.notice.trim() ? { displayText: message.notice } : {}) });
/**
 * The steering message queued for a subagent's result (`inboxId`) left the inbox into the conversation: a run took it
 * at a boundary (`steered`, now with the SDK queue id it was taken under and the turn that took it), or it opened the
 * follow-up turn when the turn it waited for completed (`woke`, with that turn). The record then says which message
 * carries the result, so a rewind that cuts that message makes it owed again (cc/subagent-results.mjs owedResult).
 * Only the record whose queued message this was changes; a host notice about the same subagent (让 Rna 处理) is not
 * its result. Call inside a mutate. Returns whether a record changed.
 */
export function agentSteerTaken(session, inboxId, delivery) {
  for (const turn of session?.turns ?? []) for (const record of turn.delegations ?? []) {
    if (record.delivery?.status !== 'steered' || record.delivery.inboxId !== inboxId) continue;
    record.delivery = { ...record.delivery, ...delivery, at: now() };
    const item = session.items.find(row => row.kind === 'subagent' && row.subagent?.agentId === record.id); if (item) item.subagent.delivery = record.delivery.status;
    return true;
  }
  return false;
}
// Subagent completion notices queued for a turn that ended before its safe
// boundary: they become visible notices, never an unrequested paid turn. The
// record says so (`noticed`, not `steered`): no request of that turn took the
// result (the runtime removes a row from the inbox as its request takes it), and
// the next request carries it (cc/subagent-results.mjs). A row the runtime had
// already handed to the SDK queue keeps that queue id (`runtimeInboxId`): the
// next run withdraws a steer left behind and the results context carries it, but
// takes an observation left behind, which the journal then shows (claimedInbox),
// so the model never reads it twice.
// `stopped`: the user stopped the turn, so no turn follows to take a result
// queued to wake the parent either: it settles the same way. A host notice about
// a subagent that is not its result (让 Rna 处理) is taken back with the user's
// queued messages instead.
function settleAgentInbox(session, language = 'zh', { stopped = false } = {}) {
  const result = message => session.turns.some(turn => [...(turn.delegations ?? []), ...(turn.officialDelegations ?? [])].some(record => record.id === message.agentId && record.delivery?.status === 'steered' && record.delivery.inboxId === message.id));
  const stale = session.inbox.filter(message => message.source === 'subagent' && (!message.wake || stopped && result(message)));
  if (!stale.length) return;
  session.inbox = session.inbox.filter(message => !stale.includes(message));
  const at = now();
  for (const message of stale) {
    sessionItem(session, 'notice', message.notice ?? inLanguage(language, { zh: '子代理已结束。', en: 'A subagent finished.' }), { simulated: false, source: 'subagent', agentId: message.agentId });
    for (const turn of session.turns) for (const record of [...(turn.delegations ?? []), ...(turn.officialDelegations ?? [])]) {
      if (record.id !== message.agentId || record.delivery?.status !== 'steered' || record.delivery.inboxId !== message.id) continue;
      record.delivery = { status: 'noticed', at, via: 'turn_end', ...(typeof message.runtimeInboxId === 'string' && message.runtimeInboxId ? { runtimeInboxId: message.runtimeInboxId } : {}) };
      const item = session.items.find(row => row.kind === 'subagent' && row.subagent?.agentId === record.id); if (item) item.subagent.delivery = 'noticed';
    }
  }
}
function suspendSession(state, session, reason) {
  const language = interfaceLanguageOf(state);
  if (session.status === 'running') pauseSession(session, reason, inLanguage(language, { zh: '会话已归档或所属项目已归档，本轮和待发送消息已保留；恢复归档后仍需显式继续执行。', en: 'This conversation or its project was archived. The turn and queued messages are kept; after restoring, continue it yourself.' }), language);
  for (const goal of state.goals) if (goal.sessionId === session.id && liveGoal(goal) && goal.status !== 'paused') pauseGoal(state, goal, reason, '归档已暂停此会话的自主目标；恢复归档不会自动继续运行。');
}
function removeSessionReferences(state, removedIds) {
  const goalIds = new Set(state.goals.filter(goal => removedIds.has(goal.sessionId)).map(goal => goal.id));
  state.goals = state.goals.filter(goal => !goalIds.has(goal.id));
  state.candidates = state.candidates.filter(candidate => !removedIds.has(candidate.sessionId) && !goalIds.has(candidate.goalId));
  state.sessions = state.sessions.filter(session => !removedIds.has(session.id));
  state.events = state.events.filter(event => !removedIds.has(event.sessionId));
  for (const project of state.projects) {
    project.sessionIds = project.sessionIds.filter(id => !removedIds.has(id));
    if (removedIds.has(project.primarySessionId)) project.primarySessionId = project.sessionIds.find(id => state.sessions.some(session => session.id === id && !session.archivedAt)) ?? null;
    // Evidence remains auditable, but cannot wake a deleted conversation later.
    const staleEvidence = new Set();
    for (const observation of project.observations) if (removedIds.has(observation.data?.sessionId)) {
      staleEvidence.add(observation.id);
      if (observation.status === 'pending') observation.status = 'superseded';
      observation.text = '源会话已删除。';
      observation.data = { ...observation.data, deletedSessionId: observation.data.sessionId }; delete observation.data.sessionId;
    }
    // facts here are verbatim UI observation copies, not extracted OpenViking
    // project memories. Do not retain the deleted chat in a second projection.
    project.facts = (project.facts ?? []).filter(fact => !staleEvidence.has(fact.evidenceId));
    const staleJobs = new Set();
    for (const job of project.jobs) if (removedIds.has(job.sessionId) || job.evidenceIds?.some(id => staleEvidence.has(id))) {
      staleJobs.add(job.id);
      if (['queued', 'running', 'paused'].includes(job.status)) { job.status = 'cancelled'; job.completedAt = now(); job.output = '源会话已删除，后台任务不再继续。'; }
      if (removedIds.has(job.sessionId)) { job.deletedSessionId = job.sessionId; delete job.sessionId; }
    }
    for (const observation of project.observations) if (observation.status === 'pending' && staleJobs.has(observation.data?.jobId)) observation.status = 'superseded';
    for (const version of project.versions) if (removedIds.has(version.notificationSessionId)) { version.deletedNotificationSessionId = version.notificationSessionId; delete version.notificationSessionId; }
  }
}
function messageInput(input, state, session) {
  const delivery = input.delivery ?? 'send';
  if (!['send', 'steer', 'followup'].includes(delivery)) fail('无效的消息投递方式');
  const attachments = input.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 12) fail('最多允许 12 个附件引用');
  const safeAttachments = resolveAttachmentRefs(session, attachments).map(a => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) fail('附件必须为元数据对象');
    if (a.id) return a;
    const result = { name: text(a.name, '附件名', 240), metadataOnly: true };
    if (a.size !== undefined) result.size = number(a.size, '附件大小', 0, 1e12);
    if (a.type !== undefined) result.type = text(a.type, '附件类型', 160, false);
    if (a.path !== undefined) result.path = text(a.path, '附件引用路径', 1000);
    return result;
  });
  const content = text(input.text === undefined ? '' : input.text, '消息', 16000, false);
  // Empty user text is legitimate only after resolving a real upload owned by
  // this session. Legacy metadata cannot turn an empty request into a turn.
  if (!content && !safeAttachments.some(attachment => attachment.id && attachment.metadataOnly === false)) fail('请输入消息或添加已上传的附件。');
  const skillIds = input.skillIds ?? [];
  if (!Array.isArray(skillIds) || skillIds.length > 20 || skillIds.some(id => typeof id !== 'string' || !state.skills.some(skill => skill.id === id))) fail('技能引用无效');
  const requestId = input.requestId === undefined ? undefined : text(input.requestId, 'requestId', 160);
  // A host-posted "carry on" names the background task it continues (the turn gets that task in full as context), or
  // the owed commitment it continues (the mind links the message to that commitment instead of owing it twice).
  const continues = input.continues === undefined ? undefined : input.continues?.commitmentId !== undefined && input.continues?.actionId === undefined ? { commitmentId: text(input.continues.commitmentId, '承诺', 128) } : { actionId: text(input.continues?.actionId, '后台任务', 160) };
  return { id: randomUUID(), delivery, text: content, attachments: safeAttachments, skillIds: [...new Set(skillIds)], createdAt: now(), ...(requestId ? { requestId } : {}), ...(continues ? { continues } : {}) };
}
function advanceSession(session, project = null, state = null) {
  const turn = currentTurn(session);
  // Steering is committed only at a safe boundary; follow-ups remain outside this turn.
  const steering = session.inbox.filter(message => message.delivery === 'steer');
  session.inbox = session.inbox.filter(message => message.delivery !== 'steer');
  for (const message of steering) {
    const item = sessionItem(session, 'user', message.text, { delivery: 'steer', attachments: message.attachments, skillIds: message.skillIds, submissionId: message.id });
    turn.steering.push(item.id);
    sessionItem(session, 'assistant', `已将这条补充纳入当前轮次：${message.text}\n\n这里只演示中途引导的消费时机；没有调用模型或工具。`);
  }
  // A late steer must still affect an artifact; it cannot be acknowledged then discarded at completion.
  if (steering.length && turn.stage >= 4) turn.stage = 3;
  turn.stage++;
  const user = session.items.find(item => item.id === turn.userItemId);
  const projectVersion = project?.versions.find(v => v.id === turn.versionId);
  const memory = turn.memoryContext;
  const memoryDescription = memory ? '\n本轮记忆：演示模型未检索项目记忆。\n模型执行仍为模拟；不表示模型已理解或采用记忆。' : '';
  if (turn.stage === 1) {
    session.plan = [
      { id: randomUUID(), text: '理解目标与约束', status: 'completed' },
      { id: randomUUID(), text: '查看上下文与工具轨迹', status: 'running' },
      { id: randomUUID(), text: turn.mode === 'plan' ? '形成可讨论的计划' : '整理结果与交付物', status: 'pending' }
    ];
    if (projectVersion?.policy.concise) sessionItem(session, 'assistant', `先给结论：本轮按「${user.text.slice(0, 100)}」继续。项目技能包 ${projectVersion.version} 的简洁沟通策略正在生效（确定性演示）。后台检查独立运行，你可以随时插话。`);
    else sessionItem(session, 'assistant', `我会围绕「${user.text.slice(0, 140)}」展开${turn.mode === 'plan' ? '计划讨论' : '执行演示'}。先展示上下文读取，再整理可预览的结果。\n\n当前为交互演示：不会读取或修改工作区，也不会发送模型请求。`);
  } else if (turn.stage === 2) {
    sessionItem(session, 'tool', '查看会话上下文（模拟）', { tool: { name: 'read_context', args: { workspace: session.workspace, sources: ['conversation', 'skills', 'workspace-notes'], mode: turn.mode, ...(memory ? { memory: { backend: memory.backend, namespace: memory.namespace, level: memory.level, count: memory.entries.length, ids: memory.entries.map(entry => entry.id) } } : {}), ...(projectVersion ? { projectId: project.id, versionId: projectVersion.id, policy: projectVersion.policy } : {}) }, status: 'running', output: '' } });
  } else if (turn.stage === 3) {
    const tool = session.items.findLast(item => item.turnId === turn.id && item.kind === 'tool' && item.tool.status === 'running');
    if (tool) { tool.tool.status = 'succeeded'; tool.tool.output = `模拟读取完成\n工作区标签：${session.workspace}\n本会话已保存 ${session.turns.length} 个轮次\n本轮收到 ${turn.steering.length} 条中途引导${projectVersion ? `\n项目技能包：${projectVersion.version}（本轮开始时固定）\n缓存校验规则：${projectVersion.policy.cacheGuard}` : ''}${memoryDescription}\n没有访问工作区文件系统或外部工具。`; }
    session.plan[1].status = 'completed'; session.plan[2].status = 'running';
    sessionItem(session, 'assistant', '上下文演示已完成。工具参数与输出保存在这条会话轨迹中，可以展开查看；下一步生成本轮的示例交付物。');
  } else if (turn.stage === 4) {
    const artifact = {
      id: randomUUID(), turnId: turn.id, title: turn.mode === 'plan' ? '方案草稿 · 示例' : '工作记录 · 示例',
      path: `preview/${turn.id.slice(0, 8)}.md`, mime: 'text/markdown', createdAt: now(), simulated: true,
      content: `# ${turn.mode === 'plan' ? '方案草稿' : '工作记录'}（模拟示例）\n\n> 此内容由确定性的原型演示生成，不是模型答复；没有创建或修改工作区文件。\n\n## 用户目标\n\n${user.text}\n\n## 本轮补充\n\n${turn.steering.map(id => session.items.find(item => item.id === id).text).join('\n\n') || '无'}\n\n## 下一步\n\n- 复核目标与约束\n- 接入真实 Pi 执行核心\n- 用真实工具结果与验证证据替换此示例\n`
    };
    session.artifacts.push(artifact);
    session.plan.forEach(step => step.status = 'completed');
    sessionItem(session, 'assistant', `${turn.mode === 'plan' ? '方案草稿' : '工作记录'}已生成，可在右侧预览。你可以继续追问、补充约束，或开始下一轮。\n\n这是交互演示产物，不代表真实工作已完成。`, { artifactIds: [artifact.id] });
  } else {
    turn.status = 'completed'; turn.completedAt = now(); session.status = 'idle'; session.activeTurnId = null;
    session.pauseReason = null;
    // A follow-up becomes a new turn, never an extra message in the old one.
    const next = session.inbox.shift();
    if (next) beginTurn(session, next, false, project, state);
  }
  session.updatedAt = now();
}
function seedDemo(session) {
  beginTurn(session, { id: randomUUID(), text: '帮我梳理一个以会话为中心的自主 agent 工作台，保留工具轨迹和可预览产物。', delivery: 'send', attachments: [], skillIds: ['research'] });
  for (let i = 0; i < 5; i++) advanceSession(session);
  session.context.tokens = 2480;
  return session;
}
function fresh() {
  return {
    version: 2, revision: 0, sequence: 0, emergency: false,
    mode: 'simulation', createdAt: now(),
    settings: { dailyBudget: 10, tokenBudget: 100000, realTokenBudget: null, maxConcurrent: 1, proactive: false },
    usage: { day: now().slice(0, 10), usd: 0, tokens: 0 }, realUsage: freshRealUsage(),
    tasks: [], sessions: [], goals: [], projects: [], events: [],
    candidates: [{ id: 'candidate-context-v2', title: '将动态时钟移到上下文末尾', kind: 'Context policy', state: 'evaluated', baseline: 68, score: 84, evidence: '示例评测 · 20 个合成用例；无真实模型或保留集评测', version: 'context-v0.2', previous: 'context-v0.1' }],
    integrations: [
      { id: 'filesystem', name: 'Workspace Files', kind: 'Native tool', description: '项目文件读取与受控写入', status: 'preview', permission: 'workspace:read / write', enabled: false },
      { id: 'github', name: 'GitHub MCP', kind: 'MCP', description: '代码与 Issue 的工具目录示例', status: 'not_connected', permission: 'repository:read', enabled: false },
      { id: 'browser', name: 'Browser MCP', kind: 'MCP', description: '网页观察和交互能力示例', status: 'not_connected', permission: 'browser:observe', enabled: false }
    ],
    skills: [
      { id: 'code-review', name: '代码审查', version: '0.1.0', description: '形成证据、定位缺陷、生成审查记录。', enabled: true },
      { id: 'research', name: '来源可追踪的研究', version: '0.1.0', description: '固定来源、事实与推断分离、维护研究证据。', enabled: true },
      { id: 'evolution', name: '候选策略评测', version: '0.1.0', description: '隔离执行、比较基线、记录晋升条件。', enabled: false }
    ]
  };
}
export { contextUsageFor };
function applyModel(session, configuration, selection) {
  const previous = session.modelConfig, resolved = resolveModel(configuration, selection);
  session.modelSelection = modelSelection(resolved); session.modelConfig = resolved;
  session.model = `${resolved.providerName} · ${resolved.name}`; session.context.capacity = resolved.contextWindow;
  // The last projection measured the conversation against the previous model: keep its size, rescale its
  // limits to this one until the next request projects again, and mark the figure an estimate (contract C2-a).
  const usage = session.context.usage;
  if (usage && Number.isFinite(resolved.contextWindow)) {
    const changed = previous?.providerId !== resolved.providerId || previous?.modelId !== resolved.modelId;
    if (changed || usage.capacity !== resolved.contextWindow || usage.outputReserve !== resolved.maxOutputTokens) session.context.usage = { ...contextUsageFor(usage, resolved), ...(changed || usage.estimated ? { estimated: true } : {}) };
  }
}
function refreshResumedModel(session, turn, configuration, action) {
  if (turn.modelConfig?.execution !== 'rna') return;
  // An explicit restart is a new request boundary, while the journal, tool
  // receipts and pinned project version still belong to this same turn.
  if (!session.modelSelection) fail('请先选择已配置的真实模型，再继续本轮。', 409);
  const previous = { model: turn.model, modelSelection: copy(turn.modelSelection), modelConfig: copy(turn.modelConfig) };
  const resolved = resolveModel(configuration, session.modelSelection);
  if (resolved.execution !== 'rna') fail('真实轮次需要真实模型，不能切换到演示执行器继续。', 409);
  applyModel(session, configuration, session.modelSelection);
  // A per-turn reasoning decision stays fixed for this turn's resume/retry
  // while the selection and model are unchanged (contract v2 §3).
  const decided = previous.modelConfig?.reasoningDecision;
  if (decided && previous.modelConfig.reasoningSelection === session.modelConfig.reasoningSelection && previous.modelConfig.providerId === session.modelConfig.providerId && previous.modelConfig.modelId === session.modelConfig.modelId) Object.assign(session.modelConfig, { reasoning: previous.modelConfig.reasoning, reasoningDecision: copy(decided) });
  const next = { model: session.model, modelSelection: copy(session.modelSelection), modelConfig: copy(session.modelConfig) };
  if (JSON.stringify(previous) !== JSON.stringify(next)) (turn.modelChanges ??= []).push({ at: now(), action, previous, next: copy(next) });
  Object.assign(turn, next);
}
export class Store {
  constructor(file) {
    this.file = file;
    this.persistence = { writes: 0, bytes: 0, writtenBytes: 0, shardFiles: 0, fsyncs: 0, generation: 0, lastSuccessAt: null, lastDurationMs: 0, maxDurationMs: 0, failed: false, errorCode: null };
    this.presences = new Map();
    this.listeners = new Set(); this.controlListeners = new Set();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.shards = new ShardedStateFile(file);
    let loaded;
    try { loaded = this.shards.load(); }
    catch (error) { throw new Error(`状态文件无法读取，已停止以避免覆盖：${error.message}`); }
    this.state = loaded ? loaded.state : fresh();
    const legacy = loaded?.legacy === true;
    if (![1, 2].includes(this.state.version) || !Array.isArray(this.state.tasks) || !Array.isArray(this.state.events)) throw new Error('状态文件版本或结构不受支持');
    if (this.state.version === 1) {
      // Copy the exact original before the first write, and never overwrite an earlier backup.
      let backup = `${file}.v1-backup`;
      try { copyFileSync(file, backup, constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST') throw error; backup = `${file}.v1-backup-${randomUUID()}`; copyFileSync(file, backup, constants.COPYFILE_EXCL); }
      this.state.sessions = this.state.tasks.map(task => {
        const session = makeSession({ title: task.title });
        session.createdAt = task.createdAt;
        session.sourceTaskId = task.id;
        sessionItem(session, 'user', task.description ? `${task.title}\n\n${task.description}` : task.title, { turnId: null });
        sessionItem(session, 'notice', `从旧版任务保留的历史快照：${task.status}，模拟进度 ${task.progress}%。旧任务及其事件仍完整保留；在此发送消息会开启新的会话轮次。`, { turnId: null });
        return session;
      });
      this.state.version = 2;
      this.state.revision++;
      entry(this.state, 'state.migrated', '状态已升级为会话模型，旧任务及迁移前文件完整保留。', null, { backup });
    }
    if (!Array.isArray(this.state.sessions) || this.state.sessions.some(s => !Array.isArray(s.items) || !Array.isArray(s.turns) || !Array.isArray(s.inbox) || !Array.isArray(s.submissions))) throw new Error('会话状态结构不受支持');
    if (this.state.goals === undefined) this.state.goals = [];
    if (!Array.isArray(this.state.goals)) throw new Error('自主目标状态结构不受支持');
    if (this.state.projects === undefined) {
      try { copyFileSync(file, `${file}.before-projects-backup`, constants.COPYFILE_EXCL); } catch (error) { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; }
      this.state.projects = [];
    }
    if (!Array.isArray(this.state.projects)) throw new Error('项目状态结构不受支持');
    this.state.configuration ??= initialConfiguration();
    this.state.configuration.memory = { ...initialConfiguration().memory, ...this.state.configuration.memory, backend: this.state.configuration.memory?.backend === 'embedded' ? 'embedded' : 'openviking' };
    delete this.state.configuration.memory.defaultLevel;
    migrateReasoningSelections(this.state);
    this.state.projectMemories ??= [];
    if (!Array.isArray(this.state.projectMemories)) throw new Error('项目记忆状态结构不受支持');
    for (const project of this.state.projects) { normalizeProjectSchedule(project); project.archivedAt ??= null; project.initiative.notificationMuted ??= false; project.initiative.deferWhileTyping ??= true; project.memory ??= { namespace: memoryNamespace(project) }; project.git = projectGit(project.git); }
    for (const project of this.state.projects) if (project.initialization?.status === 'initializing') project.initialization = { ...project.initialization, status: 'paused', message: '服务重启，中断的初始化不会自动重放；请重试。' };
    for (const session of this.state.sessions) {
      session.archivedAt ??= null;
      // Claude Code subscription consultations were withdrawn (0.58.0): one still running can no longer finish.
      for (const turn of session.turns) for (const row of turn.officialDelegations ?? []) if (row.status === 'running') Object.assign(row, { status: 'interrupted', code: 'official_agent_withdrawn', completedAt: now(), summary: 'Claude Code 订阅咨询已下线，这次咨询没有完成。', ...(row.delivery ? { delivery: { status: 'none', at: now() } } : {}) });
      if (session.modelConfig?.execution === 'pi') session.modelConfig.execution = 'rna';
      const active = currentTurn(session);
      if (active?.modelConfig?.execution === 'pi') {
        active.status = 'stopped'; active.completedAt = now(); session.status = 'idle'; session.activeTurnId = null;
        sessionItem(session, 'notice', '已迁移到独立 Rna SDK。旧 Pi 运行记录作为历史保留；未完成请求不会自动重放，请发送新消息继续。', { turnId: null, simulated: false });
      }
    }
    migrateRealBudgets(this.state);
    // B3: the rhythm evidence key no longer hashes a conversation's mode; consumed keys follow (idempotent, before EVO-3's).
    if (migrateRhythmEvidenceKeys(this.state).changed) this.state.revision++;
    // EVO-3: generated tool and skill names are the project's, not the version's (one time, idempotent).
    if (migrateGenomeIdentities(this.state).changed) this.state.revision++;
    // Quotes of conversations kept from before their sources were tracked (reviews D2-2, D2-4): every start, idempotent.
    scrubLegacySourceQuotes(this.state);
    this.configurationService = new ConfigurationService(this); this.memoryService = new MemoryService(this);
    let recovered = 0;
    for (const task of this.state.tasks) if (task.status === 'running') { task.status = 'paused'; task.updatedAt = now(); recovered++; entry(this.state, 'recovery', 'daemon 重启：模拟任务已暂停，等待显式恢复。', task.id); }
    const language = interfaceLanguageOf(this.state);
    for (const session of this.state.sessions) if (session.status === 'running') {
      // The attempt ended when the old process last did something, not at this restart.
      const turn = currentTurn(session), stopped = turn ? lastActivity(session, turn) : null;
      pauseSession(session, 'recovery', inLanguage(language, { zh: '应用重新启动过，这一轮停在了中途。本轮和待发送的消息都保存着；恢复后从停下的地方接着做，不会自己重新发出请求。', en: 'The app restarted while this turn was running. The turn and queued messages are saved; resume to continue from where it stopped. Nothing is re-sent on its own.' }), language);
      if (turn && stopped) turn.pausedAt = stopped;
      recovered++; entry(this.state, 'session.recovery', '会话重启恢复，已暂停等待显式继续。', null, { sessionId: session.id });
    }
    for (const goal of this.state.goals) if (liveGoal(goal) && goal.status !== 'paused') {
      pauseGoal(this.state, goal, 'recovery', '服务重启：自主目标与截止时间已保存；等待显式恢复，不自动补跑。'); recovered++;
    }
    if (!this.state.events.length) entry(this.state, 'system', '本地控制平面已初始化。模型、工具、缓存和评测均未连接；所有执行结果为模拟。');
    if (recovered) this.state.revision++;
    // A monolithic state is copied aside before the first sharded commit and
    // removed only after the committed generation reads back identically.
    if (legacy) {
      const backup = `${file}.legacy-${Date.now()}-${randomUUID().slice(0, 8)}`;
      copyFileSync(file, backup, constants.COPYFILE_EXCL);
      const fd = openSync(backup, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(dirname(file));
    }
    // From here on committed state is immutable; mutate() and display
    // projections replace it with a new generation sharing unchanged subtrees.
    this.state = seal(this.state);
    this.persist(this.state);
    if (legacy || legacyStateBackups(file).length) {
      const check = readStateFile(file);
      if (check?.legacy !== false || JSON.stringify(check.state) !== JSON.stringify(this.state)) throw new Error('分片状态迁移校验失败；旧状态文件已保留。');
      for (const path of legacyStateBackups(file)) try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.shards.sweep();
  }
  persist(next, options) {
    if (this.persistence.failed) throw new Error('状态持久化先前失败，已停止后续写入；请恢复磁盘并重启服务。');
    const start = performance.now(), plan = this.shards.plan(next);
    let result;
    try { result = this.shards.commit(plan, next, options); }
    catch (error) {
      this.persistence.failed = true; this.persistence.errorCode = error.code ?? 'WRITE_FAILED';
      // If rename succeeded but directory fsync failed, do not let memory and
      // disk diverge or allow another operation on an older state snapshot.
      if (error.committed) this.state = next;
      throw error;
    }
    const duration = performance.now() - start;
    Object.assign(this.persistence, { writes: this.persistence.writes + 1, bytes: result.bytes, writtenBytes: result.written, shardFiles: result.files, fsyncs: result.fsyncs, generation: this.shards.generation, lastSuccessAt: now(), lastDurationMs: duration, maxDurationMs: Math.max(this.persistence.maxDurationMs, duration) });
  }
  archiveRecords(namespace, records) {
    if (typeof namespace !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(namespace) || namespace.length > 240) throw new Error('无效的历史归档命名空间');
    if (!Array.isArray(records)) throw new Error('历史归档必须是记录数组');
    const directory = resolve(`${this.file}.archive`, namespace);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Each content-addressed record is immutable. A crash before pruning may
    // archive it twice, but never loses the original record or overwrites it.
    const references = [];
    for (const record of records) {
      const content = JSON.stringify(record);
      if (content === undefined) throw new Error('归档记录无法序列化');
      const hash = createHash('sha256').update(content).digest('hex');
      const path = resolve(directory, `${hash}.json`);
      try { if (readFileSync(path, 'utf8') !== content) throw new Error('归档指纹冲突或文件损坏'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; atomicWrite(path, content); }
      references.push(`${namespace}/${hash}.json`);
    }
    // Persist the directory chain before the caller removes any hot records.
    let current = directory;
    const archiveRoot = resolve(`${this.file}.archive`);
    while (current !== dirname(archiveRoot)) { syncDirectory(current); current = dirname(current); }
    syncDirectory(dirname(archiveRoot));
    return references;
  }
  // A clean stop checkpoints without a commit log (formatVersion 1), so a
  // rollback to an earlier release reads the same state. Later commits start
  // a new log. Returns whether anything was written.
  close() {
    if (this.persistence.failed || !this.shards.log) return false;
    this.shards.checkpoint(this.shards.plan(this.committed()), this.state, { final: true });
    return true;
  }
  // Committed state is frozen: never edit this.state (or anything read from
  // it) in place; use mutate(). A state assigned wholesale (test fixtures) is
  // adopted by copying it into committed form.
  committed() { if (!isCommitted(this.state)) this.state = finalize(this.state); return this.state; }
  // fn edits a copy-on-write draft; only what it reaches is copied, and an
  // exception or a failed persist simply abandons the draft. `purge` makes the
  // commit a checkpoint so removed content leaves no copy in the commit log
  // (implied when a session or project disappears).
  mutate(fn, { purge = false } = {}) {
    const previous = this.committed(), working = draft(previous);
    const result = fn(working);
    working.revision++;
    const finals = new Map(), next = finalize(working, finals);
    this.persist(next, { purge: purge || (next.sessions?.length ?? 0) < (previous.sessions?.length ?? 0) || (next.projects?.length ?? 0) < (previous.projects?.length ?? 0) });
    this.state = next;
    for (const listener of this.listeners) { try { listener(next.revision); } catch (error) { console.error('state listener:', error.message); } }
    return detach(result ?? next, finals);
  }
  // Display-only streaming snapshots. Execution/control/accounting changes must
  // use mutate(): its next durable snapshot also includes these display fields.
  // Never expose a general non-persisting mutation callback to callers.
  projectRuntimeDisplay(input) {
    const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
    const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
    if (!exact(input, ['sessionId', 'turnId', 'updates']) || !identifier(input.sessionId) || !identifier(input.turnId) || !Array.isArray(input.updates) || input.updates.length > 512) throw new TypeError('Invalid runtime display projection');
    const instant = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
    const thought = value => exact(value, ['text', 'startedAt', 'endedAt', 'tokens', 'visibility']) && typeof value.text === 'string' && value.text.length <= 64000 && instant(value.startedAt) && (value.endedAt === null || instant(value.endedAt)) && (value.tokens === null || Number.isSafeInteger(value.tokens) && value.tokens >= 0) && ['full', 'summary', 'hidden'].includes(value.visibility);
    for (const update of input.updates) {
      const field = update?.type === 'assistant_text' ? 'text' : update?.type === 'tool_output' ? 'output' : update?.type === 'thinking' ? 'thinking' : null;
      // firstTokenAt is optional timing for assistant blocks (text or thinking).
      const keys = ['type', 'itemId', field, ...(field !== 'output' && update && Object.hasOwn(update, 'firstTokenAt') ? ['firstTokenAt'] : [])];
      if (!field || !exact(update, keys) || !identifier(update.itemId) || (field === 'thinking' ? !thought(update.thinking) : typeof update[field] !== 'string' || update[field].length > 64000) || keys.length > 3 && !instant(update.firstTokenAt)) throw new TypeError('Invalid runtime display update');
    }
    // A failed durable barrier cannot be bypassed with a cosmetic update.
    if (this.persistence.failed || this.state.emergency) return false;
    const working = draft(this.committed());
    const session = working.sessions.find(item => item.id === input.sessionId);
    const project = working.projects.find(item => item.id === session?.projectId);
    const turn = session?.turns.find(item => item.id === input.turnId);
    if (!session || (session.projectId && !project) || project?.archivedAt || session.archivedAt || session.status !== 'running' || session.activeTurnId !== input.turnId || turn?.status !== 'running' || turn.modelConfig?.execution !== 'rna') return false;
    let changed = false;
    for (const update of input.updates) {
      const item = session.items.find(item => item.id === update.itemId && item.turnId === input.turnId && item.simulated === false);
      const live = item?.kind === 'assistant' && item.streaming === true && !item.final;
      if (live && update.firstTokenAt) { if (!item.firstTokenAt) { item.firstTokenAt = update.firstTokenAt; changed = true; } if (!turn.firstTokenAt) { turn.firstTokenAt = update.firstTokenAt; changed = true; } }
      if (update.type === 'thinking' && live && JSON.stringify(item.thinking) !== JSON.stringify(update.thinking)) { item.thinking = { ...update.thinking }; changed = true; }
      else if (update.type === 'assistant_text' && live && item.text !== update.text) { item.text = update.text; changed = true; }
      else if (update.type === 'tool_output' && item?.kind === 'tool' && item.tool?.status === 'running' && item.tool.output !== update.output) { item.tool.output = update.output; changed = true; }
    }
    if (!changed) return false;
    // `session.updatedAt` stays the last commit's: it is an index row field, and the index's periodic fresh read sees
    // this display state too (StreamHub poll), so a stamp here sent an index event every 5 s while a reply streamed.
    working.revision++;
    this.state = finalize(working);
    // Only display subscribers (live views) wake for streamed text; control
    // listeners react to mutate() commits, which carry every execution change.
    for (const listener of this.listeners) { if (this.controlListeners.has(listener)) continue; try { listener(this.state.revision); } catch (error) { console.error('state listener:', error.message); } }
    return true;
  }
  /**
   * `display: false` = a control listener: not woken by projectRuntimeDisplay's cosmetic streaming updates.
   * A listener runs in the async context it subscribed in, not in the one of whoever mutated: work it starts (a
   * merge, an apply) must never inherit a lock its mutator holds (the isolation engine's repository FIFO is
   * re-entrant within one chain of calls, and a listener's work is a chain of its own).
   */
  subscribe(listener, { display = true } = {}) {
    const bound = AsyncResource.bind(listener);
    this.listeners.add(bound); if (!display) this.controlListeners.add(bound);
    return () => { this.listeners.delete(bound); this.controlListeners.delete(bound); };
  }
  streamSnapshot(sessionId) {
    // Browser subscriptions only need the revision; CLI subscriptions also
    // need their complete, detached session. Neither consumes configuration,
    // other conversations or project-version projections. Keep this boundary
    // separate from get(), whose full public-state contract is unchanged.
    // The committed session is deeply frozen and never changes in place, so it
    // is already detached: sharing it costs nothing (was ~8 ms structuredClone
    // per event on a large session). Callers serialize it; writes would throw.
    if (!sessionId) return { revision: this.state.revision };
    const session = this.committed().sessions.find(row => row.id === sessionId);
    return { revision: this.state.revision, ...(session ? { session } : {}) };
  }
  // Public state: a fresh top level over the frozen committed structures
  // (shared, never cloned; ~25 ms structuredClone before). Only projected
  // fields get new objects (projects, their versions, deletion receipts).
  // The result is read-only below its top level and each project object.
  get() {
    const committed = this.committed(), { projectMemories: _memories, memories: _legacy, ...state } = committed;
    state.configuration = this.configurationService.public();
    state.mode = 'hybrid';
    const rhythmNow = Date.now();
    state.projects = committed.projects.map(source => {
      const project = { ...source };
      project.presence = this.presences.get(project.id) ?? null; project.workspacePath = registeredWorkspacePath(project.workspace);
      project.rhythmStatus = projectRhythmStatus(committed, source, { now: rhythmNow });
      project.plan = planView(source.mind ?? {}, { done: 3, stale: true });
      // Planning receipts in local words, older rows too (C2-f; the v2 project summary does the same).
      if (Array.isArray(source.scheduleManagementReceipts)) project.scheduleManagementReceipts = scheduleReceiptsView(source, interfaceLanguageOf(committed));
      if (project.decisionMode === 'rna-model') {
        const availability = projectInitiativeAvailability(committed, source);
        project.initiativeRuntime = { ...project.initiativeRuntime, availability, ...(availability.state === 'blocked' ? { status: 'blocked' } : {}) };
      }
      if (project.versions) project.versions = project.versions.map(version => version.simulated !== true ? { ...version, assessment: describeEvolutionAssessment(version, { activeVersionId: project.activeVersionId, project: source }) } : version);
      return project;
    });
    state.sessionDeletions = (committed.sessionDeletions ?? []).map(({ sessionId, projectId, status, localStatus, remoteStatus, createdAt, updatedAt, completedAt, code, retryAt }) => ({ sessionId, projectId, status, localStatus, remoteStatus, createdAt, updatedAt, completedAt, code, retryAt }));
    return state;
  }
  openWorkspace(input = {}) {
    const workspace = canonicalDirectory(input.workspace);
    const matches = matchingWorkspaces(this.state.projects, workspace);
    let project;
    if (input.projectId !== undefined) {
      project = matches.find(project => project.id === input.projectId);
      if (!project) fail('项目不属于所选目录', 409);
    } else if (matches.length > 1) {
      throw Object.assign(new DomainError('此目录有多个历史项目，请选择要打开的项目；不会合并历史记录', 409), { code: 'workspace_ambiguous' });
    } else project = matches[0];
    if (project) {
      requireActiveProject(project);
      const session = this.state.sessions.find(session => session.id === project.primarySessionId && !session.archivedAt) ?? this.state.sessions.find(session => session.projectId === project.id && !session.archivedAt) ?? null;
      return copy({ project, session, reused: true });
    }
    return { ...this.createProject({ ...input, workspace, name: input.name === undefined ? basename(workspace) || workspace : input.name }), reused: false };
  }
  createProject(input = {}) {
    const project = makeProject({ ...input, workspace: input.workspace ?? process.cwd() });
    project.git = projectGit(null);
    // New projects use an explicit ceiling. Legacy compatibility is reserved
    // for projects loaded from earlier state, not silently inherited forever.
    project.permissions = { workspace: 'execute', background: 'read', revision: 0, source: 'default', updatedAt: now() };
    if (!input.workspace && input.initialize === true && !input.demo) {
      project.workspace = resolve(dirname(this.file), 'projects', project.id, 'workspace');
      mkdirSync(project.workspace, { recursive: true, mode: 0o700 });
      project.workspaceManaged = true;
    } else project.workspaceManaged = false;
    if (input.initialize === true && !input.demo) {
      project.initialization = { status: 'queued', requestedAt: now() };
      project.focus = ''; project.versions = []; project.activeVersionId = null;
      project.decisionMode = 'uninitialized'; project.simulated = false;
    }
    return this.mutate(s => {
      const session = makeSession({ title: '项目讨论', workspace: project.workspace });
      session.projectId = project.id;
      applyModel(session, s.configuration, null);
      project.sessionIds.push(session.id); project.primarySessionId = session.id;
      s.projects.unshift(project); s.sessions.unshift(session);
      if (input.demo) addObservation(s, project, { kind: 'context', eventId: `initial-${project.id}`, text: '当前项目正在把任务面板改为持续的主动协作对话。项目有缓存策略与沟通方式两个可独立改进的方向，但尚无用户任务或长期目标。', relevance: 0.9 });
      entry(s, 'project.created', '项目与持续会话已建立；项目主动协作不依赖 Goal。', null, { projectId: project.id, sessionId: session.id });
      return { project, session };
    });
  }
  updateProject(id, input) {
    validateArchive(input);
    // The new-conversation default of 在独立工作树中运行 (design 0.63 §7.1); the rest of project.git is the host's.
    // isolationPilot: isolate this project before the release gate opens (a user-chosen walk-through project).
    if (input.git !== undefined && (!input.git || typeof input.git !== 'object' || Array.isArray(input.git) || !Object.keys(input.git).length || Object.keys(input.git).some(key => !['sessionWorktreeDefault', 'isolationPilot'].includes(key)) || Object.values(input.git).some(value => typeof value !== 'boolean'))) fail('git 只能包含布尔值 sessionWorktreeDefault 或 isolationPilot');
    if (input.workspace !== undefined) {
      input = { ...input, workspace: canonicalDirectory(input.workspace) };
      if (matchingWorkspaces(this.state.projects, input.workspace).some(project => project.id !== id)) fail('此目录已属于其他项目，请直接打开该项目', 409);
    }
    if (this.state.emergency && input.initiative?.enabled === true) fail('急停生效中，请先解除急停', 409);
    const result = this.mutate(s => {
      const project = getProject(s, id), oldFocus = project.focus, oldWorkspace = project.workspace;
      if (input.workspace !== undefined && input.workspace !== oldWorkspace && s.sessions.some(session => session.projectId === id && session.activeTurnId)) fail('项目有正在执行或暂停的轮次，请完成或停止后再更改工作目录', 409);
      if (project.archivedAt && input.archived !== false && (input.initiative?.enabled === true || input.evolution?.enabled === true)) requireActiveProject(project);
      updateProject(project, input);
      if (input.git !== undefined) {
        project.git = projectGit(project.git);
        if (input.git.sessionWorktreeDefault !== undefined) project.git.sessionWorktreeDefault = input.git.sessionWorktreeDefault;
        if (input.git.isolationPilot !== undefined) { if (input.git.isolationPilot) project.git.isolationPilot = true; else delete project.git.isolationPilot; }
      }
      // The user's own switch (or an archive) outranks the emergency stop's mark: lifting the stop leaves it as set.
      if (input.initiative?.enabled !== undefined || input.archived === true) delete project.initiative.pausedByEmergency;
      if (project.workspace !== oldWorkspace) { for (const session of s.sessions.filter(session => session.projectId === id)) session.workspace = project.workspace; project.workspaceManaged = false; }
      if (input.memory !== undefined) {
        if (!input.memory || typeof input.memory !== 'object' || Array.isArray(input.memory)) fail('memory 必须为对象');
        if (input.memory.namespace !== undefined) {
          const namespace = validateNamespace(input.memory.namespace);
          if (s.projects.some(p => p.id !== id && (memoryNamespace(p) === namespace || memoryNamespace(p).startsWith(`${namespace}/`) || namespace.startsWith(`${memoryNamespace(p)}/`)))) fail('项目记忆命名空间不能与其他项目重叠', 409);
          project.memory = { namespace };
        }
      }
      if (input.focus !== undefined && project.focus !== oldFocus) addObservation(s, project, { kind: 'context', text: `用户更新项目焦点：${project.focus}`, relevance: 1 });
      if (input.archived === true && !project.archivedAt) {
        project.archivedAt = now();
        project.initiative.enabled = false; project.initiative.pauseReason = 'archived';
        for (const session of s.sessions.filter(session => session.projectId === id)) suspendSession(s, session, 'project-archived');
        for (const task of s.tasks) if (task.projectId === id && ['queued', 'running'].includes(task.status)) { task.status = 'paused'; task.updatedAt = now(); }
        if (['queued', 'initializing', 'blocked'].includes(project.initialization?.status)) project.initialization = { ...project.initialization, status: 'paused', reason: 'archived', message: '项目已归档，初始化已暂停；恢复归档后请显式重试。' };
        entry(s, 'project.archived', '项目已归档，后台主动能力和运行中的会话已暂停；历史与队列保留。', null, { projectId: id });
      } else if (input.archived === false && project.archivedAt) {
        project.archivedAt = null;
        entry(s, 'project.restored', '项目已恢复，暂停的执行与主动能力需显式恢复。', null, { projectId: id });
      }
      return project;
    });
    if (result.archivedAt) this.presences.delete(id);
    return result;
  }
  /**
   * Run `hook(project)` after a project is deleted, with the project row as it was (id, workspace, git): Rna's
   * worktrees in its folder must be released then (worktree design 0.63 §5.3), and the row (their records) is gone
   * from state by the time any session cleanup runs. Returns the unsubscribe function.
   */
  onProjectDeleted(hook) {
    (this.projectDeletedHooks ??= new Set()).add(hook);
    return () => this.projectDeletedHooks?.delete(hook);
  }
  /**
   * Run `hook(projectId)` synchronously just before a project is deleted, while its state is still there: whoever
   * runs its background work cancels the run handles then (review X-1), so the deletion's host resolutions are the
   * last word on them. Returns the unsubscribe function.
   */
  onProjectDeleting(hook) {
    (this.projectDeletingHooks ??= new Set()).add(hook);
    return () => this.projectDeletingHooks?.delete(hook);
  }
  deleteProject(id) {
    const target = getProject(this.state, id);
    // What the deletion hooks get: the row's identity, folder and git records, copied before they leave state.
    const released = { id: target.id, workspace: target.workspace, git: target.git ? copy(target.git) : null };
    // First its run handles are cancelled: nothing of this project runs on after the deletion.
    for (const hook of this.projectDeletingHooks ?? []) {
      try { hook(id); } catch (error) { console.warn(`project ${id} deleting: ${error?.message ?? error}`); }
    }
    // Skills installed into its genome are deleted with the genome folder below, so their entries go now.
    const genome = `${resolve(`${this.file}.genomes`, id)}${sep}`;
    const result = this.mutate(state => {
      const project = getProject(state, id);
      // No executor will ever resume or reconcile its runs: every action of unknown outcome gets a host resolution
      // (project_deleted), and the deletion records captured next carry it, so its conversations can finish deleting.
      resolveDeletedProjectActions(project, Date.now());
      const deletions = state.sessions.filter(session => session.projectId === id || project.sessionIds.includes(session.id)).map(session => deletionRecord(this, session, state));
      const removedIds = new Set(state.sessions.filter(session => session.projectId === id || project.sessionIds.includes(session.id)).map(session => session.id));
      for (const record of deletions) queueDeletion(state, record);
      removeSessionReferences(state, removedIds);
      for (const record of deletions) scrubSessionEvidence(state, record);
      const projectGoals = new Set(state.goals.filter(goal => goal.projectId === id).map(goal => goal.id));
      state.goals = state.goals.filter(goal => !projectGoals.has(goal.id));
      state.candidates = state.candidates.filter(candidate => candidate.projectId !== id && !projectGoals.has(candidate.goalId));
      state.projects = state.projects.filter(project => project.id !== id);
      state.tasks = state.tasks.filter(task => task.projectId !== id);
      const skills = state.capabilities?.skills;
      if (Array.isArray(skills) && skills.some(skill => typeof skill?.path === 'string' && resolve(skill.path).startsWith(genome))) {
        state.capabilities.skills = skills.filter(skill => !(typeof skill?.path === 'string' && resolve(skill.path).startsWith(genome)));
        state.capabilities.revision = (state.capabilities.revision ?? 0) + 1;
      }
      entry(state, 'project.deleted', '项目及会话已删除，聊天记录与会话专属运行文件正在清理；项目文件和已提取项目记忆保留。', null, { projectId: id, deletedSessionIds: [...removedIds] });
      return { deleted: true, projectId: id, deletedSessionIds: [...removedIds] };
    });
    this.presences.delete(id);
    // Its private folders (genome versions, evolution records, initialization, observations) go with it.
    void removeProjectFiles(this.file, id).catch(() => {});
    // Its folder stays; what Rna keeps in it (session, worker and background worktrees) is released by the hooks.
    for (const hook of this.projectDeletedHooks ?? []) {
      try { void Promise.resolve(hook(copy(released))).catch(error => console.warn(`project ${id} deleted: ${error?.message ?? error}`)); }
      catch (error) { console.warn(`project ${id} deleted: ${error?.message ?? error}`); }
    }
    return result;
  }
  observeProject(id, input) {
    requireActiveProject(getProject(this.state, id));
    // Validate duplicates on a copy first so replays do not change revision or rewrite disk.
    const check = addObservation(draft(this.state), draft(getProject(this.state, id)), input);
    if (check.duplicate) return copy(check);
    return this.mutate(s => addObservation(s, getProject(s, id), input));
  }
  presence(id, input) {
    const presence = projectPresence(this.state, id, input);
    if (Object.hasOwn(input, 'expectedReceiptId')) {
      const current = this.presences.get(id), receiptId = current && Date.parse(current.expiresAt) > Date.now() ? current.receiptId : null;
      if (input.expectedReceiptId !== receiptId) fail('输入状态已由其他客户端更新，请重新读取。', 409);
    }
    this.presences.set(id, presence);
    return copy(presence);
  }
  version(id, versionId, action) { return this.mutate(s => { const project = getProject(s, id); requireActiveProject(project); return controlVersion(s, project, versionId, action); }); }
  projectCheck(id, input) { return checkProject(getProject(this.state, id), input); }

  createAutonomyDemo(input = {}) {
    const limitUsd = number(input.budget ?? 0.3, '目标模拟预算', 0, 10000);
    const maxRuns = number(input.maxRuns ?? 10, '最大自主轮数', 1, 1000);
    if (!Number.isInteger(maxRuns)) fail('最大自主轮数必须为整数');
    const title = text(input.title ?? '自主修复工具结果缓存策略，并把经验沉淀为可复用技能', '目标标题', 160);
    return this.mutate(s => {
      const session = makeSession({ title: '自主能力演示 · 工具缓存修复' });
      const goal = {
        id: randomUUID(), sessionId: session.id, title, status: s.emergency ? 'paused' : 'scheduled',
        pauseReason: s.emergency ? 'emergency' : null, resumeStatus: 'scheduled', stage: 'observe',
        nextAction: AUTONOMY_ACTIONS.observe, nextWakeAt: now(), lastWake: null, waitingFor: null,
        runCount: 0, budget: { limitUsd, maxRuns, spentUsd: 0, tokens: 0 }, candidateId: null,
        evaluation: null, acceptance: [], history: [], receipts: [], policyVersion: 'demo-guard-v1',
        createdAt: now(), updatedAt: now(), simulated: true, automatic: true
      };
      session.goalId = goal.id; s.sessions.unshift(session); s.goals.unshift(goal);
      sessionItem(session, 'notice', `已建立长期目标：${title}\n\n启动后，daemon 会主动检查、等待依赖、恢复执行、验证、提炼候选并完成模拟验收，无需连续发送提示。真实运行的是调度与状态机；模型、工具、产物和业务评测均为确定性模拟。`, { goalId: goal.id, turnId: null });
      goalHistory(s, goal, 'created', '自主演示目标已持久化，等待调度器首次唤醒。');
      return { goal, session };
    });
  }
  controlGoal(id, input) {
    if (input.action === 'signal' && input.eventId !== undefined) {
      const eventId = text(input.eventId, 'eventId', 160), goal = getGoal(this.state, id);
      if (goal.receipts.includes(eventId)) return { goal: copy(goal), session: copy(getSession(this.state, goal.sessionId)), duplicate: true };
    }
    return this.mutate(s => {
      const goal = getGoal(s, id), session = getSession(s, goal.sessionId);
      const action = input.action;
      if (action === 'budget') {
        if (!liveGoal(goal)) fail('已结束目标不能修改预算', 409);
        if (input.limitUsd !== undefined) {
          const limit = number(input.limitUsd, '目标模拟预算', 0, 10000);
          if (limit + 1e-8 < goal.budget.spentUsd) fail('预算不能低于已记账金额', 409);
          goal.budget.limitUsd = limit;
        }
        if (input.maxRuns !== undefined) {
          const limit = number(input.maxRuns, '最大自主轮数', 1, 1000);
          if (!Number.isInteger(limit) || limit < goal.runCount) fail('轮数上限必须为整数且不低于已运行次数', 409);
          goal.budget.maxRuns = limit;
        }
        goalHistory(s, goal, 'budget.updated', '模拟预算已更新，目标当前状态不变；暂停目标须显式恢复。');
      } else if (action === 'signal') {
        if (!liveGoal(goal)) fail('目标已结束，不能发送依赖事件', 409);
        const eventId = text(input.eventId ?? `manual-${randomUUID()}`, 'eventId', 160);
        if (goal.receipts.includes(eventId)) return { goal, session, duplicate: true };
        deliverDependency(s, goal, eventId, '用户提前发送演示信号');
      } else if (action === 'pause') {
        if (!liveGoal(goal) || goal.status === 'paused') fail('目标当前不能暂停', 409);
        pauseGoal(s, goal, 'manual', '自主目标已暂停。会话、等待事件、进度与预算账本保留。');
      } else if (action === 'resume') {
        requireActiveSession(s, session);
        if (goal.status !== 'paused') fail('只有暂停目标可以恢复', 409);
        if (s.emergency) fail('急停生效中，请先解除急停', 409);
        const turn = currentTurn(session);
        if (turn?.source === 'autonomy') { session.status = 'running'; session.pauseReason = null; turn.status = 'running'; goal.status = 'running'; }
        else if (goal.waitingFor && !goal.waitingFor.receivedAt) goal.status = 'waiting';
        else { goal.status = 'scheduled'; goal.waitingFor = null; }
        goal.pauseReason = null; goal.nextWakeAt = goal.status === 'waiting' ? goal.waitingFor.readyAt : now();
        goal.nextAction = goal.status === 'waiting' ? '等待依赖事件，然后自动继续修复' : AUTONOMY_ACTIONS[goal.stage];
        goalHistory(s, goal, 'resumed', '自主目标已显式恢复；下次运行仍须通过预算与会话占用检查。');
        sessionItem(session, 'notice', '自主目标已恢复。调度器将从已保存的检查点继续。', { turnId: turn?.source === 'autonomy' ? turn.id : null, goalId: goal.id });
      } else if (action === 'cancel') {
        if (!liveGoal(goal)) fail('目标已结束', 409);
        const turn = currentTurn(session);
        if (turn?.source === 'autonomy') {
          turn.status = 'stopped'; turn.completedAt = now();
          for (const item of session.items) if (item.turnId === turn.id && item.tool?.status === 'running') { item.tool.status = 'failed'; item.tool.output = '自主目标已取消。'; }
          session.status = 'idle'; session.pauseReason = null; session.activeTurnId = null;
        }
        goal.status = 'cancelled'; goal.cancelledAt = now(); goal.pauseReason = null; goal.nextWakeAt = null; goal.waitingFor = null; goal.nextAction = '目标已取消，记录保留';
        goalHistory(s, goal, 'cancelled', '自主目标已取消，后续信号和定时器不再创建运行。');
        sessionItem(session, 'notice', '自主目标已取消；历史、候选和产物仍可查看。', { turnId: null, goalId: goal.id });
      } else if (action === 'advance') {
        requireActiveSession(s, session);
        if (!liveGoal(goal) || goal.status === 'paused' || s.emergency) fail('目标暂停或已结束，不能推进演示时钟', 409);
        if (goal.waitingFor && !goal.waitingFor.receivedAt) goal.waitingFor.readyAt = now();
        goal.nextWakeAt = now();
        goalHistory(s, goal, 'clock.advanced', '只将本目标已安排的下次时间推进到现在；仍由 daemon 执行下一步与门禁检查。');
      } else fail('未知目标操作');
      return { goal, session };
    });
  }
  createSession(input = {}) {
    // 在独立工作树中运行 is chosen here only (design 0.63 §7.1): the worktree itself is made on the first turn.
    // Whether the project can isolate is the route's question (409 worktree_unavailable) before this is called.
    if (input.worktree !== undefined && typeof input.worktree !== 'boolean') fail('worktree 必须是布尔值');
    if (input.worktree === true && input.projectId === undefined) fail('只有项目里的对话可以在独立工作树中运行');
    const session = makeSession(input);
    if (input.modelSelection !== undefined || input.model === undefined) applyModel(session, this.state.configuration, input.modelSelection);
    if (input.demo !== undefined && typeof input.demo !== 'boolean') fail('demo 必须是布尔值');
    if (input.demo) seedDemo(session);
    return this.mutate(s => {
      if (input.projectId !== undefined) {
        const project = getProject(s, input.projectId); requireActiveProject(project); session.projectId = project.id; session.workspace = project.workspace; project.sessionIds.push(session.id);
        if (!project.primarySessionId) project.primarySessionId = session.id;
        if (input.worktree === true) session.worktree = { id: randomUUID(), state: 'pending' };
      }
      s.sessions.unshift(session);
      entry(s, 'session.created', input.demo ? '已创建可交互的示例会话。' : '已创建会话。', null, { sessionId: session.id });
      return session;
    });
  }
  /**
   * A turn the host starts because the user chose it on a host card (design 0.63 §4.2 "让 Rna 再处理"): the user
   * item reads `text` (interface language, marked `source`); `context` rides the turn's first request as host
   * context for the model. Idle, active conversations only.
   * @returns {{ turnId: string, itemId: string }}
   */
  hostTurn(id, { text: content, source = 'host', context = [] } = {}) {
    const original = getSession(this.state, id);
    requireActiveSession(this.state, original);
    if (this.state.emergency) fail('急停生效中，请先解除急停', 409);
    if (typeof content !== 'string' || !content.trim() || content.length > 8000) fail('宿主轮次需要说明文字', 400);
    return this.mutate(s => {
      const session = getSession(s, id);
      if (session.activeTurnId || session.status !== 'idle') fail('对话正在运行，稍后再试', 409);
      const item = beginTurn(session, { id: randomUUID(), delivery: 'send', text: content, attachments: [], skillIds: [], createdAt: now() }, false, s.projects.find(project => project.id === session.projectId) ?? null, s);
      item.source = text(source, 'source', 80);
      if (context.length) item.hostContext = context.slice(0, 4).map(row => ({ source: text(row.source, 'context.source', 160), text: text(row.text, 'context.text', 64000) }));
      session.updatedAt = now();
      entry(s, 'session.host.turn', '宿主按卡片上的选择开始了一轮。', null, { sessionId: id, source: item.source });
      return { turnId: session.activeTurnId, itemId: item.id };
    });
  }
  // Side chat (辅助对话): a separate session bound to a parent; the parent is only read.
  /**
   * Plan §4.5 "从这里分叉": a new conversation in the same project that starts from one message of
   * another. The earlier messages are copied for reading (never re-run); the model receives them as the
   * fork's context. The original conversation is untouched.
   */
  forkSession(parentId, itemId) {
    const parent = getSession(this.state, parentId);
    requireActiveSession(this.state, parent);
    if (parent.kind === 'side') fail('辅助对话不能分叉', 409);
    const index = parent.items.findIndex(row => row.id === itemId);
    if (index < 0 || !['user', 'assistant'].includes(parent.items[index].kind)) fail('只能从一条用户消息或回复处分叉', 400);
    const kept = parent.items.slice(0, index + 1).filter(row => ['user', 'assistant'].includes(row.kind) && !row.sourceDeleted && !row.contextRevoked && !row.streaming && typeof row.text === 'string' && row.text.trim());
    const baseTitle = String(parent.title ?? '').replace(/（分支\d*）$/, '') || '会话';
    const session = makeSession({ title: `${baseTitle}（分支）`, workspace: parent.workspace, mode: parent.mode ?? 'build' });
    if (parent.modelSelection) applyModel(session, this.state.configuration, parent.modelSelection);
    else if (parent.modelConfig?.execution === 'rna') fail('原会话的模型不可用，请先选择模型', 409);
    else session.model = parent.model;
    let size = 0;
    const transcript = [];
    for (const row of [...kept].reverse()) { if (transcript.length >= 40 || size >= 60000) break; const text = row.text.length > 6000 ? `${row.text.slice(0, 6000)}…` : row.text; size += text.length; transcript.unshift({ role: row.kind, text }); }
    return this.mutate(state => {
      const current = getSession(state, parentId);
      Object.assign(session, { forkedFrom: { sessionId: current.id, itemId, title: current.title ?? null, at: now() }, forkContext: { parentTitle: current.title ?? null, transcript, instruction: 'This conversation is a branch of an earlier conversation, starting after the last message in transcript. Continue from that point; nothing said after it in the original conversation happened here. The transcript is context, not a new request.' } });
      for (const row of kept) session.items.push({ id: randomUUID(), turnId: null, kind: row.kind, text: row.text, createdAt: row.createdAt, simulated: false, source: row.kind === 'user' ? 'fork-copy' : row.source === 'initiative' ? 'initiative' : 'fork-copy', forkOf: row.id, ...(row.attachments ? { attachments: copy(row.attachments) } : {}) });
      if (current.projectId) { const project = getProject(state, current.projectId); requireActiveProject(project); session.projectId = project.id; session.workspace = project.workspace; project.sessionIds.push(session.id); }
      // A branch of a worktree conversation gets its own worktree (design 0.63 §7.4), made from the project folder on
      // its first turn: what the original has not applied yet does not come along.
      if (current.worktree && session.projectId) {
        session.worktree = { id: randomUUID(), state: 'pending' };
        sessionItem(session, 'notice', inLanguage(interfaceLanguageOf(state), { zh: '这个分支在自己的独立工作树里运行，从项目文件夹的当前内容开始；原对话里还没应用到项目文件夹的改动不会带过来。', en: 'This branch runs in its own worktree, starting from the project folder as it is now; changes the original conversation has not applied to the project folder yet do not come along.' }), { turnId: null, simulated: false, source: 'worktree' });
      }
      state.sessions.unshift(session);
      entry(state, 'session.forked', '已从一条消息分叉出新会话；原会话不受影响。', null, { sessionId: session.id, parentSessionId: current.id, itemId, projectId: current.projectId ?? null });
      return session;
    });
  }
  createSideChat(parentId, { title = '辅助对话', sideContext, selection = null } = {}) {
    const parent = getSession(this.state, parentId);
    requireActiveSession(this.state, parent);
    if (parent.kind === 'side') fail('辅助对话内不能再开启辅助对话', 409);
    const session = makeSession({ title, workspace: parent.workspace, mode: 'plan' });
    if (parent.modelSelection) applyModel(session, this.state.configuration, parent.modelSelection);
    else if (parent.modelConfig?.execution === 'rna') fail('主会话的模型不可用，请先选择模型', 409);
    else session.model = parent.model;
    return this.mutate(s => {
      const current = getSession(s, parentId);
      Object.assign(session, { kind: 'side', parentSessionId: current.id, sideChat: { selection, readOnlyDefault: true, createdAt: session.createdAt }, sideContext: copy(sideContext ?? null) });
      if (current.projectId) { const project = getProject(s, current.projectId); requireActiveProject(project); session.projectId = project.id; session.workspace = project.workspace; project.sessionIds.push(session.id); }
      s.sessions.unshift(session);
      entry(s, 'session.side.created', '已创建辅助对话；主会话不受影响。', null, { sessionId: session.id, parentSessionId: current.id, projectId: current.projectId ?? null });
      return session;
    });
  }
  // Explicit user action: show one side-chat answer in the parent as a note.
  // Display-only; it starts no turn and is not delivered to the parent model.
  promoteSideChat(sideId, itemId) {
    const side = getSession(this.state, sideId);
    if (side.kind !== 'side' || !side.parentSessionId) fail('只有辅助对话可以转入主会话', 409);
    const item = side.items.find(row => row.id === itemId);
    if (!item || item.kind !== 'assistant' || item.streaming || typeof item.text !== 'string' || !item.text.trim() || item.sourceDeleted || item.contextRevoked) fail('请选择一条已完成的辅助对话回答', 400);
    const parent = getSession(this.state, side.parentSessionId); requireActiveSession(this.state, parent);
    return this.mutate(s => {
      const target = getSession(s, side.parentSessionId), existing = target.items.find(row => row.sideChat?.sessionId === sideId && row.sideChat?.itemId === itemId);
      if (existing) return { parentSessionId: target.id, item: existing, duplicate: true };
      const note = { id: randomUUID(), turnId: null, kind: 'notice', source: 'side-chat', text: item.text, createdAt: now(), simulated: false, sideChat: { sessionId: sideId, itemId, title: side.title } };
      target.items.push(note); target.updatedAt = now();
      entry(s, 'session.side.promoted', '辅助对话的回答已作为备注加入主会话。', null, { sessionId: target.id, sideSessionId: sideId, itemId });
      return { parentSessionId: target.id, item: note, duplicate: false };
    });
  }
  updateSession(id, input) {
    validateArchive(input);
    const result = this.mutate(s => {
      const session = getSession(s, id);
      const project = s.projects.find(project => project.id === session.projectId);
      if (input.archived === false && project?.archivedAt) requireActiveProject(project);
      if (input.title !== undefined) session.title = text(input.title, '会话标题', 160);
      if (input.worktree !== undefined) fail('是否在独立工作树中运行只能在新建对话时选择', 409);
      if (input.workspace !== undefined) {
        const workspace = canonicalDirectory(input.workspace);
        if (project && workspace !== canonicalDirectory(registeredWorkspacePath(project.workspace))) fail('项目内会话使用项目目录，请通过项目修改工作目录', 409);
        if (session.activeTurnId && workspace !== session.workspace) fail('请完成或停止当前轮次后再更改工作目录', 409);
        session.workspace = workspace;
      }
      if (input.modelSelection !== undefined) applyModel(session, s.configuration, input.modelSelection);
      else if (input.model !== undefined) { session.model = text(input.model, '模型标签', 120); delete session.modelSelection; delete session.modelConfig; }
      if (input.mode !== undefined) {
        if (!['build', 'plan'].includes(input.mode)) fail('mode 必须为 build 或 plan');
        session.mode = input.mode;
      }
      if (input.archived === true && !session.archivedAt) {
        session.archivedAt = now(); suspendSession(s, session, 'archived');
        if (project?.primarySessionId === id) project.primarySessionId = project.sessionIds.find(other => s.sessions.some(session => session.id === other && !session.archivedAt)) ?? null;
        entry(s, 'session.archived', '会话已归档，运行暂停，历史与待发送消息保留。', null, { sessionId: id, projectId: project?.id });
      } else if (input.archived === false && session.archivedAt) {
        session.archivedAt = null;
        if (project && !project.primarySessionId) project.primarySessionId = id;
        entry(s, 'session.restored', '会话已恢复，暂停的轮次需显式继续。', null, { sessionId: id, projectId: project?.id });
      }
      session.updatedAt = now();
      return session;
    });
    if (result.archivedAt && this.presences.get(result.projectId)?.sessionId === id) this.presences.delete(result.projectId);
    return result;
  }
  deleteSession(id) {
    const record = deletionRecord(this, getSession(this.state, id));
    const result = this.mutate(state => {
      const session = getSession(state, id);
      queueDeletion(state, record);
      removeSessionReferences(state, new Set([id]));
      scrubSessionEvidence(state, record);
      state.tasks = state.tasks.filter(task => task.sessionId !== id);
      entry(state, 'session.deleted', '会话已删除，聊天记录与会话专属运行文件正在清理；项目文件和已提取项目记忆保留。', null, { sessionId: id, projectId: session.projectId });
      return { deleted: true, sessionId: id, projectId: session.projectId ?? null };
    });
    if (this.presences.get(result.projectId)?.sessionId === id) this.presences.delete(result.projectId);
    return result;
  }
  message(id, input) {
    const message = messageInput(input, this.state, getSession(this.state, id));
    const original = getSession(this.state, id);
    requireActiveSession(this.state, original);
    const project = this.state.projects.find(p => p.id === original.projectId);
    // Like Pi/Harness, a new project is usable at once: turns run on the baseline agent while the project
    // initialization proceeds in the background; its version applies from the next turn on.
    if (message.requestId) {
      const previous = original.submissions.find(item => item.requestId === message.requestId);
      if (previous) {
        const fingerprint = JSON.stringify({ text: message.text, delivery: message.delivery, attachments: message.attachments, skillIds: message.skillIds });
        if (previous.fingerprint !== fingerprint) fail('同一 requestId 不能用于不同消息', 409);
        return { session: copy(original), queued: original.inbox.some(item => item.id === previous.message.id), entry: copy(previous.message), duplicate: true };
      }
    }
    return this.mutate(s => {
      const session = getSession(s, id);
      const fingerprint = JSON.stringify({ text: message.text, delivery: message.delivery, attachments: message.attachments, skillIds: message.skillIds });
      const goal = s.goals.find(g => g.sessionId === id && liveGoal(g));
      if (goal) {
        if (goal.status !== 'paused') pauseGoal(s, goal, 'manual', '收到用户新消息：自主目标先暂停，将控制权交回当前会话。恢复目标后再继续演示。');
        const interrupted = currentTurn(session);
        if (interrupted?.source === 'autonomy') {
          interrupted.status = 'stopped'; interrupted.completedAt = now();
          for (const item of session.items) if (item.turnId === interrupted.id && item.tool?.status === 'running') { item.tool.status = 'failed'; item.tool.output = '用户插话，自主轮次已停止；目标检查点保留。'; }
          session.status = 'idle'; session.activeTurnId = null; session.pauseReason = null;
          goal.resumeStatus = goal.waitingFor ? 'waiting' : 'scheduled';
        }
      }
      const project = s.projects.find(p => p.id === session.projectId);
      // A side chat never becomes project evidence or the primary conversation;
      // mind-layer capture still runs on its turns (runtime-controller).
      if (project && session.kind !== 'side') {
        // Every message is project evidence as said; nothing in it is matched against phrases (review X-8). Preferences
        // and constraints go through mind capture (JEV), pausing and resuming background work through the model's
        // project_background_control tool and the project's own controls, quiet periods through adaptive pacing, and
        // the focus changes only when the user edits it. Only the scripted demo project still reads its one demo
        // phrase, a reply preference that drives its simulated learning loop.
        const demo = project.decisionMode === 'demo-policy' && project.simulated !== false;
        const preference = demo && /^(请)?(以后)?(回复)?(简洁一点|短一点|先说结论|先给结论)[。！!]?$/u.test(message.text.trim());
        const kind = preference ? 'preference' : 'conversation';
        const attachmentOnly = !message.text;
        addObservation(s, project, { kind, text: attachmentOnly ? `用户提交了 ${message.attachments.length} 个附件：${message.attachments.map(attachment => attachment.name).join('、')}。此记录仅说明附件已提交，内容尚未读取。` : message.text, eventId: `message-${message.id}`, relevance: kind === 'conversation' ? 0.6 : 1, data: { messageId: message.id, sessionId: session.id, parser: attachmentOnly ? 'attachment-submission' : preference ? 'demo-explicit-phrase' : 'message', ...(attachmentOnly ? { attachmentIds: message.attachments.filter(attachment => attachment.id).map(attachment => attachment.id) } : {}) } });
        project.primarySessionId = session.id;
      }
      const queued = Boolean(session.activeTurnId);
      if (queued) {
        if (session.inbox.length >= 50) fail('待发送队列已满，请先撤回或等待消费', 409);
        if (message.delivery === 'send') message.delivery = 'steer';
        session.inbox.push(message);
        if (session.status === 'paused' && session.pauseReason === 'recovery' && !s.emergency) {
          refreshResumedModel(session, currentTurn(session), s.configuration, 'message-resume');
          startAttempt(session, currentTurn(session));
          session.status = 'running'; session.pauseReason = null; currentTurn(session).status = 'running';
        }
      } else beginTurn(session, message, s.emergency, project, s);
      if (message.requestId) session.submissions.push({ requestId: message.requestId, fingerprint, message: copy(message) });
      session.updatedAt = now();
      entry(s, queued ? 'session.message.queued' : 'session.turn.started', queued ? `消息已加入 ${message.delivery} 队列。` : currentTurn(session)?.modelConfig?.execution === 'rna' ? 'Rna 会话轮次已进入执行队列。' : '会话轮次已开始（模拟）。', null, { sessionId: id });
      return { session, queued, entry: message };
    });
  }
  removeInbox(id, messageId, { runtimeWithdrawn = false } = {}) {
    return this.mutate(s => {
      const session = getSession(s, id);
      const index = session.inbox.findIndex(message => message.id === messageId);
      if (index < 0) fail('消息已被消费或不存在，不能撤回', 409);
      if (session.inbox[index].deliveryStatus === 'accepted' && !runtimeWithdrawn) fail('消息已进入执行队列，需由 Rna SDK 确认未消费后撤回。', 409);
      const [recovered] = session.inbox.splice(index, 1);
      const project = s.projects.find(p => p.id === session.projectId);
      for (const observation of project?.observations ?? []) if (observation.data.messageId === recovered.id && observation.status === 'pending') observation.status = 'withdrawn';
      sessionItem(session, 'notice', inLanguage(interfaceLanguageOf(s), { zh: '一条未消费消息已从队列取回，可继续编辑。', en: 'An unprocessed message was taken back from the queue; you can edit it.' }), { recoveredMessages: [copy(recovered)] });
      entry(s, 'session.message.withdrawn', '未消费消息已取回，原文及引用保留在会话通知中。', null, { sessionId: id, messageId });
      return { session, recovered };
    });
  }
  controlSession(id, action, { auto = false } = {}) {
    const original = getSession(this.state, id);
    if (['resume', 'retry'].includes(action)) requireActiveSession(this.state, original);
    const owner = this.state.goals.find(g => g.sessionId === id && liveGoal(g));
    if (owner && currentTurn(original)?.source === 'autonomy' && ['pause', 'resume'].includes(action)) {
      const result = this.controlGoal(owner.id, { action });
      return { session: result.session, recovered: [] };
    }
    return this.mutate(s => {
      const session = getSession(s, id); let turn = currentTurn(session);
      let recovered = [];
      const language = interfaceLanguageOf(s), say = variants => inLanguage(language, variants);
      if (action === 'pause') {
        if (session.status === 'paused' && turn && ['maintenance_question', 'recovery'].includes(session.pauseReason) && ['suspended', 'reattaching'].includes(session.maintenanceQuestion?.phase)) {
          session.maintenanceQuestion.phase = 'user_paused'; session.maintenanceQuestion.updatedAt = now();
          session.pauseReason = 'manual'; session.updatedAt = now(); entry(s, 'session.pause', '用户保持会话暂停；维护完成后不自动恢复。', null, { sessionId: id }); return { session, recovered };
        }
        if (session.status !== 'running' || !turn) fail('只有运行中的会话可以暂停', 409);
        pauseSession(session, 'manual', say({ zh: '当前轮次已暂停，进度与待发送消息保留。', en: 'Turn paused. Progress and queued messages are kept.' }), language);
      } else if (action === 'retry') {
        requireActiveSession(s, session);
        if (s.emergency || session.activeTurnId || session.status !== 'idle') fail('当前会话不能重试', 409);
        turn = session.turns.at(-1);
        if (!turn || turn.status !== 'failed' || turn.modelConfig?.execution !== 'rna') fail('没有可重试的真实轮次', 409);
        refreshResumedModel(session, turn, s.configuration, action);
        const retriedAt = now();
        turn.retryHistory ??= []; turn.retryHistory.push({ status: turn.status, completedAt: turn.completedAt, errorCode: turn.errorCode, retriedAt, ...(auto ? { auto: true } : {}) });
        startAttempt(session, turn, retriedAt);
        delete turn.completedAt; delete turn.errorCode; delete turn.blockingActionId; delete turn.blockingDraining; turn.status = 'running'; session.status = 'running'; session.activeTurnId = turn.id; session.pauseReason = null;
        if (!auto) { delete turn.autoRetry; sessionItem(session, 'notice', say({ zh: '重新尝试上次没完成的请求；已经做完的步骤不会重做。', en: 'Retrying the request that did not finish; steps already done are not redone.' }), { simulated: false }); }
      } else if (action === 'resume') {
        requireActiveSession(s, session);
        if (session.status !== 'paused' || !turn) fail('会话没有可恢复的轮次', 409);
        if (s.emergency) fail('急停生效中，请先解除急停', 409);
        refreshResumedModel(session, turn, s.configuration, action);
        startAttempt(session, turn);
        session.status = 'running'; session.pauseReason = null; turn.status = 'running';
        sessionItem(session, 'notice', turn.modelConfig?.execution === 'rna' ? say({ zh: '接着上次继续，已完成的步骤不会重做。', en: 'Continuing where it left off; finished steps are not redone.' }) : '继续当前轮次（模拟）。', { simulated: turn.modelConfig?.execution !== 'rna' });
      } else if (action === 'stop') {
        if (!turn) fail('会话没有正在进行的轮次', 409);
        const goal = s.goals.find(g => g.sessionId === id && liveGoal(g));
        if (goal && goal.status !== 'paused') pauseGoal(s, goal, 'manual', '用户停止当前自主轮次；长期目标也已暂停，防止后台继续唤醒。');
        settleAgentInbox(session, language, { stopped: true }); recovered = session.inbox.splice(0);
        const project = s.projects.find(p => p.id === session.projectId);
        for (const observation of project?.observations ?? []) if (recovered.some(m => m.id === observation.data.messageId) && observation.status === 'pending') observation.status = 'withdrawn';
        // The user stopped these steps: cancelled (shown as stopped), not failed.
        for (const item of session.items) if (item.turnId === turn.id && item.tool?.status === 'running') {
          item.tool.status = 'cancelled'; item.tool.output = say({ zh: '你停止了这一轮，这一步没有做完。', en: 'You stopped this turn before this step finished.' });
        }
        for (const item of session.items) if (item.turnId === turn.id && item.streaming) item.streaming = false;
        // A turn stopped while paused stopped working at its pause; the clock ends there (C-a).
        if (turn.status === 'paused' && turn.pausedAt) startAttempt(session, turn);
        turn.status = 'stopped'; turn.completedAt = now();
        // A graceful stop says where it stopped (plan §2.5 item 19). Writes are atomic, so the last written file is whole.
        const written = [...session.items].reverse().find(item => item.turnId === turn.id && ['project_write', 'project_edit'].includes(item.tool?.name) && ['completed', 'done', 'succeeded'].includes(item.tool?.status) && typeof item.tool?.args?.path === 'string')?.tool.args.path;
        const where = written ? say({ zh: `停在 ${written}，文件是完整的。`, en: `Stopped at ${written}; the file is complete. ` }) : '';
        // The web puts the user's own queued messages back into the input box (a subagent result is not one of them).
        const returned = recovered.filter(message => message.source !== 'subagent').length;
        sessionItem(session, 'notice', returned ? say({ zh: `本轮已停止。${where}还没处理的 ${returned} 条消息已放回输入框；你可以继续此会话。`, en: `Turn stopped. ${where}${returned === 1 ? 'The message not yet processed was' : `${returned} messages not yet processed were`} put back in the input box; you can keep the conversation going.` }) : say({ zh: `本轮已停止。${where}你可以继续此会话。`, en: `Turn stopped. ${where}You can keep the conversation going.` }), { recoveredMessages: copy(recovered), ...(written ? { stoppedAt: written } : {}) });
        session.status = 'idle'; session.pauseReason = null; session.activeTurnId = null;
      } else if (action === 'compact') {
        if (session.activeTurnId) fail('请在本轮结束后整理上下文', 409);
        if (session.modelConfig?.execution === 'rna') fail('Rna SDK 压缩需要明确的摘要或摘要器；当前 UI 尚未开放此操作', 409);
        const before = session.context.tokens;
        session.context.tokens = Math.round(before * 0.45);
        session.context.compactions++;
        sessionItem(session, 'notice', `演示上下文整理：${before} → ${session.context.tokens} tokens（模拟估算）。完整会话历史仍保留；未调用真实摘要或缓存接口。`);
      } else fail('未知会话操作');
      if (['pause', 'stop', 'resume', 'retry'].includes(action) && ['suspended', 'reattaching'].includes(session.maintenanceQuestion?.phase)) {
        session.maintenanceQuestion.phase = action === 'pause' ? 'user_paused' : 'user_controlled'; session.maintenanceQuestion.updatedAt = now();
      }
      session.updatedAt = now();
      entry(s, `session.${action}`, `会话操作：${action}。`, null, { sessionId: id });
      return { session, recovered };
    });
  }
  pauseRuntimeRecovery(id, turnId, recovery) {
    return this.mutate(state => {
      const session = getSession(state, id), turn = currentTurn(session);
      if (!turn || turn.id !== turnId || session.status !== 'running') return;
      session.status = 'paused'; session.pauseReason = 'recovery'; turn.status = 'paused'; turn.pausedAt = now();
      session.runtime ??= {}; session.runtime.recovery = copy(recovery);
      sessionItem(session, 'notice', inLanguage(interfaceLanguageOf(state), { zh: '有一步操作没能确认是否完成，需要你看一眼再继续。', en: 'One step could not be confirmed as finished. Take a look before continuing.' }), { simulated: false, source: 'runtime-recovery' });
      entry(state, 'session.recovery.required', '等待核对中断操作。', null, { sessionId: id, turnId });
    });
  }
  /** One answer for every uncertain step (plan §2.5 item 8): carry on from the state as it is now, or redo it. */
  resolveRuntimeRecovery(id, input = {}) {
    if (!['continue', 'redo'].includes(input?.choice) || Object.keys(input).some(key => key !== 'choice')) fail('choice 必须是 continue 或 redo');
    return this.mutate(state => {
      const session = getSession(state, id), turn = currentTurn(session);
      requireActiveSession(state, session);
      if (!turn || session.status !== 'paused' || session.pauseReason !== 'recovery') fail('会话没有等待核对的操作', 409);
      const pending = (session.runtime?.recovery?.uncertainTools ?? []).filter(item => !turn.toolResolutions?.[item.callKey]);
      const status = input.choice === 'continue' ? 'abandoned' : 'not-executed';
      const note = input.choice === 'continue' ? 'The user looked at the current state and chose to continue from it as it is. Check the result before relying on it.' : 'The user confirmed this step did not complete. Do it again.';
      turn.toolResolutions ??= {};
      for (const item of pending) turn.toolResolutions[item.callKey] = { status, note, result: { content: [{ type: 'text', text: `User observed outcome (${status}): ${note}` }] }, isError: true };
      sessionItem(session, 'notice', inLanguage(interfaceLanguageOf(state), input.choice === 'continue' ? { zh: '你确认按现在的状态继续。', en: 'You chose to continue from how things are now.' } : { zh: '你确认这一步没有做完，会重做。', en: 'You confirmed this step did not finish; it will be redone.' }), { simulated: false, source: 'runtime-recovery-resolution', resolution: status });
      entry(state, 'session.recovery.resolved', '用户已一次核对全部中断操作。', null, { sessionId: id, turnId: turn.id, resolution: status, count: pending.length });
      return { remaining: 0, session };
    });
  }
  resolveRuntimeTools(id, input) {
    return this.mutate(state => {
      const session = getSession(state, id), turn = currentTurn(session);
      requireActiveSession(state, session);
      if (!turn || session.status !== 'paused' || session.pauseReason !== 'recovery') fail('会话没有等待核对的操作', 409);
      const pending = session.runtime?.recovery?.uncertainTools ?? [];
      if (!pending.some(item => item.callKey === input.callKey)) fail('此中断操作不存在或已过期', 409);
      if (!['completed', 'not-executed', 'abandoned'].includes(input.status)) fail('无效的操作结果');
      const note = text(input.note, '核对说明', 4000);
      turn.toolResolutions ??= {};
      turn.toolResolutions[input.callKey] = { status: input.status, note, result: { content: [{ type: 'text', text: `User observed outcome (${input.status}): ${note}` }] }, isError: input.status !== 'completed' };
      sessionItem(session, 'notice', inLanguage(interfaceLanguageOf(state), { zh: `已记录操作核对：${note}`, en: `Recorded your check: ${note}` }), { simulated: false, source: 'runtime-recovery-resolution', callKey: input.callKey, resolution: input.status });
      entry(state, 'session.recovery.resolved', '用户已记录中断操作的结果。', null, { sessionId: id, turnId: turn.id, callKey: input.callKey, resolution: input.status });
      return { remaining: pending.filter(item => !turn.toolResolutions[item.callKey]).length, session };
    });
  }
  checkpointRuntimeMemory(id, turnId) {
    const original = this.state.sessions.find(session => session.id === id);
    if (!original?.projectId || !this.state.projects.some(project => project.id === original.projectId) || sessionArchived(this.state, original) || original.status !== 'running' || original.activeTurnId !== turnId || this.state.emergency || this.state.configuration.memory.autoStore === false) return;
    const turn = original.turns.find(row => row.id === turnId);
    if (!turn || turn.modelConfig?.execution !== 'rna' || turn.memoryWrite) return;
    const connectionFingerprint = this.memoryService.connectionFingerprint(original.projectId);
    // Check eligibility on a shallow draft to avoid a Store write/SSE pulse
    // after every short slice when no checkpoint is due.
    const draft = { ...turn, memoryCheckpoints: [...(turn.memoryCheckpoints ?? [])] };
    const record = enqueueMemoryCheckpoint(original, draft, { connectionFingerprint });
    if (!record) return;
    return this.mutate(state => {
      const session = state.sessions.find(row => row.id === id), current = session?.turns.find(row => row.id === turnId);
      if (!current || session.status !== 'running' || session.activeTurnId !== turnId) return;
      current.memoryCheckpoints ??= []; current.memoryCheckpoints.push(record);
    });
  }
  finishRuntimeTurn(id, turnId, { status = 'completed', error, errorCode, autoRetry = null } = {}) {
    const original = this.state.sessions.find(session => session.id === id);
    if (!original || sessionArchived(this.state, original) || original.status !== 'running' || original.activeTurnId !== turnId) return;
    const memoryConnection = status === 'completed' && original.projectId && this.state.configuration.memory.autoStore !== false ? this.memoryService.connectionFingerprint(original.projectId) : null;
    return this.mutate(s => {
      const session = s.sessions.find(session => session.id === id), turn = session && currentTurn(session);
      if (!turn || turn.id !== turnId || session.status !== 'running' || sessionArchived(s, session)) return;
      turn.status = status; turn.completedAt = now();
      const code = status === 'failed' && typeof errorCode === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(errorCode) ? errorCode : undefined;
      if (code) turn.errorCode = code; else delete turn.errorCode;
      if (status === 'completed' && turn.modelConfig?.execution === 'rna' && memoryConnection && s.configuration.memory.autoStore !== false && !turn.memoryWrite) {
        if (turn.memoryCheckpoints?.length) enqueueMemoryCheckpoint(session, turn, { connectionFingerprint: memoryConnection, final: true, boundary: 'completed_turn' });
        else {
          const draft = { ...turn, memoryCheckpoints: [] };
          const record = enqueueMemoryCheckpoint(session, draft, { connectionFingerprint: memoryConnection, final: true, boundary: 'completed_turn' });
          if (record) turn.memoryWrite = record;
        }
      }
      // A transient failure that will be retried automatically leaves no notice behind (plan §2.5).
      if (autoRetry) turn.autoRetry = { ...autoRetry }; else delete turn.autoRetry;
      if (error && !autoRetry) sessionItem(session, 'notice', error, { simulated: false, source: 'runtime-error', errorCode: code });
      const final = session.items.findLast(item => item.turnId === turnId && item.kind === 'assistant');
      if (final) final.final = true;
      session.activeTurnId = null; session.status = 'idle'; session.pauseReason = null;
      entry(s, `session.turn.${status}`, error ?? 'Rna 会话轮次已完成。', null, { sessionId: id, turnId, simulated: false, errorCode: code });
      // On an error keep pending messages for explicit retry instead of issuing more paid requests.
      if (status === 'completed') settleAgentInbox(session, interfaceLanguageOf(s));
      if (status === 'completed' && session.inbox.length && !s.emergency) {
        const next = session.inbox.shift(), item = beginTurn(session, next, false, s.projects.find(p => p.id === session.projectId), s);
        // A result queued to wake the parent opens this turn: its prompt is now what carries the result.
        if (next.source === 'subagent') { Object.assign(item, subagentFields(next)); agentSteerTaken(session, next.id, { status: 'woke', turnId: session.activeTurnId }); }
      }
    });
  }
  /** Deliver one settled subagent result exactly once (delegation row
   * `delivery.status` 'pending' → steered | woke | noticed). A running parent
   * receives it as durable steering at its next safe boundary; an idle parent
   * gets a visible notice, plus a follow-up turn only when `wake`.
   * `track: false`: a host notice about the subagent that is not its result
   * (让 Rna 处理): delivered the same way, while the record's delivery, which
   * says how its result reaches the model, is left as it is; returns how it
   * went ({ status, at, inboxId | turnId }). */
  deliverAgentNotice(id, { agentId, turnId, prompt, notice, wake = false, collection = 'delegations', track = true }) {
    if (!['delegations', 'officialDelegations'].includes(collection)) return null;
    const original = this.state.sessions.find(session => session.id === id), held = original?.turns.find(turn => turn.id === turnId)?.[collection]?.find(row => row.id === agentId);
    if (!held || track && held.delivery?.status !== 'pending') return null;
    return this.mutate(s => {
      const session = s.sessions.find(row => row.id === id), record = session?.turns.find(turn => turn.id === turnId)?.[collection]?.find(row => row.id === agentId);
      if (!record || track && record.delivery?.status !== 'pending') return { status: null };
      const at = now(), blocked = s.emergency || sessionArchived(s, session) || session.appRecovery?.required;
      let outcome = null;
      const mark = (status, extra = {}) => {
        outcome = { status, at, ...extra }; if (!track) return;
        record.delivery = outcome; const item = session.items.find(row => row.kind === 'subagent' && row.subagent?.agentId === agentId); if (item) item.subagent.delivery = status;
      };
      if (!blocked && session.activeTurnId && ['running', 'paused'].includes(session.status) && session.inbox.length < 50) {
        const message = { id: randomUUID(), delivery: 'steer', text: prompt, attachments: [], skillIds: [], createdAt: at, source: 'subagent', agentId, notice, ...(wake ? { wake: true } : {}) };
        session.inbox.push(message); mark('steered', { inboxId: message.id });
      } else if (!blocked && wake && !session.activeTurnId && session.status === 'idle') {
        // One visible line: the follow-up turn's message reads as the notice (C-c), not a notice plus the raw prompt.
        const item = beginTurn(session, { id: randomUUID(), delivery: 'send', text: prompt, attachments: [], skillIds: [], createdAt: at }, false, s.projects.find(p => p.id === session.projectId), s);
        Object.assign(item, subagentFields({ agentId, notice })); mark('woke', { turnId: session.activeTurnId });
      } else { sessionItem(session, 'notice', notice, { simulated: false, source: 'subagent', agentId }); mark('noticed'); }
      session.updatedAt = at;
      if (track) entry(s, 'session.agent.delivered', `子代理结果已送达（${outcome.status}）。`, null, { sessionId: id, agentId, delivery: outcome.status });
      else entry(s, 'session.agent.notified', `子代理相关的宿主通知已送达（${outcome.status}）。`, null, { sessionId: id, agentId, delivery: outcome.status });
      return outcome;
    });
  }
  /** The parent read a settled child's result directly (agent_status /
   * agent_wait): its notice must not deliver the same result again. A pending
   * delivery, or one only shown to the user (`noticed`, owed to the next
   * request's results context), becomes `reported`; a queued steering notice is
   * removed unless the runtime already accepted it (then only after the runtime
   * withdrew it). */
  agentRead(id, agentId, { runtimeWithdrawn = false } = {}) {
    const find = s => { const session = s.sessions.find(row => row.id === id); for (const turn of session?.turns ?? []) { const record = turn.delegations?.find(row => row.id === agentId); if (record) return { session, record }; } return {}; };
    const { session: original, record: before } = find(this.state), status = before?.delivery?.status;
    if (!before || before.status === 'running' || !['pending', 'steered', 'noticed'].includes(status)) return false;
    const queued = status === 'steered' ? original.inbox.find(row => row.id === before.delivery.inboxId && row.source === 'subagent') : null;
    if (status === 'steered' && (!queued || queued.deliveryStatus === 'accepted' && !runtimeWithdrawn)) return false;
    return this.mutate(s => {
      const { session, record } = find(s); if (!record || record.delivery?.status !== status) return false;
      if (queued) { const index = session.inbox.findIndex(row => row.id === queued.id); if (index < 0) return false; session.inbox.splice(index, 1); }
      record.delivery = { status: 'reported', at: now(), via: 'read' };
      const item = session.items.find(row => row.kind === 'subagent' && row.subagent?.agentId === agentId); if (item) item.subagent.delivery = 'reported';
      session.updatedAt = now(); return true;
    });
  }
  /** These settled children's results reached the model in a request of
   * `turnId` (BuiltinAgentService#resultsUpdate). `via: 'context'` (default):
   * they rode it as the `subagent-results` context; `noticed`, or an earlier
   * delivery the journal no longer holds (a copy of this key or a steering
   * message a run took, both `reported`; a steer taken in its own turn,
   * `steered` with its queue id; the prompt of a follow-up turn, `woke`),
   * becomes `reported` via `context`. `via: 'steer'`: a run took the steering
   * message the runtime had queued for them after all (the journal holds it);
   * only `noticed` changes, and keeps that queue id. Returns how many changed. */
  agentReported(id, agentIds, { turnId = null, via = 'context' } = {}) {
    const ids = new Set(agentIds ?? []), steer = via === 'steer';
    if (!ids.size || !this.state.sessions.some(row => row.id === id)) return 0;
    return this.mutate(s => {
      const session = s.sessions.find(row => row.id === id), at = now(); let changed = 0;
      for (const turn of session?.turns ?? []) for (const record of turn.delegations ?? []) {
        const delivery = record.delivery ?? {}, cut = delivery.status === 'reported' && ['context', 'steer'].includes(delivery.via) || delivery.status === 'steered' && typeof delivery.runtimeInboxId === 'string' || delivery.status === 'woke';
        if (!ids.has(record.id) || record.status === 'running' || !(delivery.status === 'noticed' || !steer && cut)) continue;
        record.delivery = { status: 'reported', at, via: steer ? 'steer' : 'context', ...(turnId ? { turnId } : {}), ...(steer && delivery.runtimeInboxId ? { runtimeInboxId: delivery.runtimeInboxId } : {}) };
        const item = session.items.find(row => row.kind === 'subagent' && row.subagent?.agentId === record.id); if (item) item.subagent.delivery = 'reported';
        changed++;
      }
      return changed;
    });
  }
  create(input) {
    const title = text(input.title, '任务标题', 160);
    const description = text(input.description ?? '', '任务说明', 4000, false);
    const budget = number(input.budget ?? 2, '任务模拟预算', 0, 10000);
    return this.mutate(s => {
      const task = { id: randomUUID(), title, description, budget, status: s.emergency ? 'paused' : 'queued', progress: 0, spend: 0, tokens: 0, createdAt: now(), updatedAt: now(), simulated: true };
      s.tasks.unshift(task);
      entry(s, 'task.created', '已创建任务，等待模拟执行器调度。', task.id);
      return task;
    });
  }
  task(id, input) {
    return this.mutate(s => {
      const task = s.tasks.find(t => t.id === id) ?? fail('任务不存在', 404);
      if (input.action) {
        const permitted = { pause: ['queued', 'running'], resume: ['paused', 'budget_exhausted'], cancel: ['queued', 'running', 'paused', 'budget_exhausted'] };
        if (!permitted[input.action]) fail('未知任务操作');
        if (!permitted[input.action].includes(task.status)) fail(`不能对 ${task.status} 任务执行 ${input.action}`, 409);
        if (input.action === 'resume' && s.emergency) fail('急停生效中，请先解除急停', 409);
        task.status = { pause: 'paused', resume: 'queued', cancel: 'cancelled' }[input.action];
        entry(s, `task.${input.action}`, { pause: '任务已暂停，进度已保存。', resume: '任务已恢复至模拟队列。', cancel: '任务已取消。' }[input.action], id);
      } else {
        if (input.title !== undefined) task.title = text(input.title, '任务标题', 160);
        if (input.description !== undefined) task.description = text(input.description, '任务说明', 4000, false);
        if (input.budget !== undefined) task.budget = number(input.budget, '任务模拟预算', 0, 10000);
        entry(s, 'task.updated', '任务设置已更新。', id);
      }
      task.updatedAt = now(); return task;
    });
  }
  deleteTask(id) {
    return this.mutate(s => {
      const task = s.tasks.find(t => t.id === id) ?? fail('任务不存在', 404);
      if (['running', 'queued'].includes(task.status)) fail('请先暂停或取消任务再删除', 409);
      s.tasks = s.tasks.filter(t => t.id !== id);
      entry(s, 'task.deleted', `已删除任务：${task.title}`, id);
    });
  }
  settings(input) {
    if (input && typeof input === 'object' && Object.keys(input).length === 1 && input.interfaceLanguage !== undefined) return this.interfaceLanguage(input.interfaceLanguage);
    if (input?.interfaceLanguage !== undefined) fail('interfaceLanguage 需要单独保存');
    return this.mutate(s => {
      for (const [key, range] of Object.entries({ dailyBudget: [0, 100000], tokenBudget: [0, 100000000], maxConcurrent: [1, 4] })) if (input[key] !== undefined) {
        s.settings[key] = number(input[key], key, ...range);
        if (key !== 'dailyBudget' && !Number.isInteger(input[key])) fail(`${key} 必须是整数`);
      }
      if (input.realTokenBudget !== undefined) {
        if (input.realTokenBudget !== null && (!Number.isSafeInteger(input.realTokenBudget) || input.realTokenBudget < 0)) fail('realTokenBudget 必须是非负整数或 null');
        s.settings.realTokenBudget = input.realTokenBudget;
      }
      if (input.proactive !== undefined) { if (typeof input.proactive !== 'boolean') fail('proactive 必须是布尔值'); s.settings.proactive = input.proactive; }
      // Idle background compaction (default on; user decision 2026-10-04): false turns it off.
      if (input.idleCompaction !== undefined) { if (typeof input.idleCompaction !== 'boolean') fail('idleCompaction 必须是布尔值'); s.settings.idleCompaction = input.idleCompaction; }
      entry(s, 'settings.updated', '预算与调度设置已保存。真实模型限额与演示额度分别记录。');
    });
  }
  /** The client's interface language; unchanged values do not touch state (the client sends it on every start). */
  interfaceLanguage(value) {
    if (!INTERFACE_LANGUAGES.includes(value)) fail('interfaceLanguage 只能是 zh 或 en');
    if (this.state.settings?.interfaceLanguage === value) return this.get();
    return this.mutate(s => { s.settings.interfaceLanguage = value; });
  }
  emergency(stop) {
    if (typeof stop !== 'boolean') fail('stop 必须是布尔值');
    return this.mutate(s => {
      s.emergency = stop;
      const language = interfaceLanguageOf(s);
      if (stop) for (const task of s.tasks) if (['running', 'queued'].includes(task.status)) { task.status = 'paused'; task.updatedAt = now(); }
      if (stop) for (const session of s.sessions) if (session.status === 'running') pauseSession(session, 'emergency', inLanguage(language, { zh: '全局急停已启用，本轮和队列已保存。解除后需要显式恢复。', en: 'Emergency stop is on. This turn and the queue are saved; resume it yourself after lifting the stop.' }), language);
      // Projects the stop switched off are marked, and switched back on when it is lifted (contract C-h);
      // one already off, or changed by the user meanwhile, keeps its own setting.
      if (stop) for (const project of s.projects) if (project.initiative.enabled !== false) { project.initiative.enabled = false; project.initiative.pauseReason = 'emergency'; project.initiative.pausedByEmergency = true; }
      if (!stop) for (const project of s.projects) if (project.initiative.pausedByEmergency) {
        delete project.initiative.pausedByEmergency;
        if (!project.archivedAt) { project.initiative.enabled = true; delete project.initiative.pauseReason; }
      }
      if (stop) for (const goal of s.goals) if (liveGoal(goal) && goal.status !== 'paused') pauseGoal(s, goal, 'emergency', '全局急停：自主目标已暂停，解除急停后仍需显式恢复。');
      entry(s, stop ? 'emergency.stop' : 'emergency.reset', stop ? '急停已启用，所有运行和排队任务已暂停。' : '急停已解除，任务保留暂停状态，请逐项恢复。');
    });
  }
  toggle(collection, id, enabled) {
    if (!['skills', 'integrations'].includes(collection) || typeof enabled !== 'boolean') fail('无效配置');
    return this.mutate(s => { const item = s[collection].find(i => i.id === id) ?? fail('条目不存在', 404); item.enabled = enabled; entry(s, 'config.updated', `${item.name} 的演示开关已${enabled ? '启用' : '停用'}；没有安装、连接或执行任何工具。`); });
  }
  candidate(id, action) {
    return this.mutate(s => {
      const c = s.candidates.find(x => x.id === id) ?? fail('候选不存在', 404);
      if (c.goalId) fail('自主场景候选由目标的评测与晋升门禁管理；不能通过通用操作绕过流程', 409);
      if (action === 'promote' && c.state === 'evaluated') c.state = 'promoted';
      else if (action === 'rollback' && c.state === 'promoted') c.state = 'evaluated';
      else fail('候选当前状态不支持此操作', 409);
      entry(s, 'evolution.simulation', `模拟${action === 'promote' ? '晋升' : '回滚'}：${c.title}。仅更新演示状态，未修改技能或策略代码。`);
    });
  }
  tick() {
    const held = this.maintenanceHeld;
    const dueProject = hasProjectWork(this.state, this.presences);
    const dueGoal = this.state.goals.some(g => { const session = this.state.sessions.find(session => session.id === g.sessionId); return session && !sessionArchived(this.state, session) && ['scheduled', 'running', 'waiting'].includes(g.status) && g.nextWakeAt && Date.parse(g.nextWakeAt) <= Date.now(); });
    if (this.state.emergency || (!this.state.tasks.some(t => ['queued', 'running'].includes(t.status)) && !this.state.sessions.some(s => !sessionArchived(this.state, s) && s.status === 'running' && currentTurn(s)?.source !== 'autonomy' && currentTurn(s)?.modelConfig?.execution !== 'rna') && !dueGoal && !dueProject)) return;
    this.mutate(s => {
      if (s.usage.day !== now().slice(0, 10)) s.usage = { day: now().slice(0, 10), usd: 0, tokens: 0 };
      let active = s.tasks.filter(t => t.status === 'running').length + s.goals.filter(g => g.status === 'running').length;
      for (const task of [...s.tasks].reverse()) {
        if (s.projects.find(project => project.id === task.projectId)?.archivedAt) continue;
        if (!held && task.status === 'queued' && active < s.settings.maxConcurrent) { task.status = 'running'; active++; entry(s, 'run.started', '模拟执行开始。无模型调用、无文件或外部工具操作。', task.id); }
        if (task.status !== 'running') continue;
        const charge = 0.012, tokens = 620;
        if (task.spend + charge > task.budget + 1e-8 || s.usage.usd + charge > s.settings.dailyBudget + 1e-8 || s.usage.tokens + tokens > s.settings.tokenBudget) {
          task.status = 'budget_exhausted'; active--; task.updatedAt = now(); entry(s, 'budget.exhausted', '模拟账本预算不足，任务已停止。调整预算后可恢复。', task.id); continue;
        }
        task.spend = +(task.spend + charge).toFixed(3); s.usage.usd = +(s.usage.usd + charge).toFixed(3);
        task.tokens += tokens; s.usage.tokens += tokens; task.progress = Math.min(100, task.progress + 20); task.updatedAt = now();
        const steps = ['组装稳定前缀与任务上下文', '生成模拟计划，检查工具能力边界', '写入模拟工具观察与轨迹证据', '运行示例检查，整理模拟结果', '完成模拟任务，生成可追踪交接'];
        entry(s, 'run.step', steps[Math.round(task.progress / 20) - 1], task.id, { simulated: true, tokens, cost: charge });
        if (task.progress === 100) { task.status = 'succeeded'; active--; entry(s, 'run.completed', '模拟已完成。此状态不表示用户真实任务已执行或验收通过。', task.id); }
      }
      let slots = Math.max(0, s.settings.maxConcurrent - active);
      for (const goal of [...s.goals].reverse()) {
        const session = s.sessions.find(session => session.id === goal.sessionId);
        if (!session || sessionArchived(s, session)) continue;
        if (!held && goal.status === 'waiting' && goal.waitingFor && Date.parse(goal.waitingFor.readyAt) <= Date.now()) deliverDependency(s, goal, `auto-${goal.id}-dependency-ready`, '预设演示依赖计时器到期');
        if (!['scheduled', 'running'].includes(goal.status) || !goal.nextWakeAt || Date.parse(goal.nextWakeAt) > Date.now()) continue;
        if (goal.status === 'running') {
          finishAutonomy(s, goal);
          slots = Math.max(0, s.settings.maxConcurrent - s.tasks.filter(t => t.status === 'running').length - s.goals.filter(g => g.status === 'running').length);
          continue;
        }
        if (held || slots <= 0) continue;
        if (goal.status === 'scheduled' && getSession(s, goal.sessionId).activeTurnId) {
          goal.nextWakeAt = after(3000); goal.nextAction = '等待本会话的用户轮次结束，再继续自主目标';
          continue;
        }
        slots--;
        startAutonomy(s, goal);
      }
      for (const session of [...s.sessions].reverse()) {
        if (sessionArchived(s, session) || session.status !== 'running' || currentTurn(session)?.source === 'autonomy' || currentTurn(session)?.modelConfig?.execution === 'rna' || slots <= 0) continue;
        slots--;
        const charge = 0.012, tokens = 620;
        if (s.usage.usd + charge > s.settings.dailyBudget + 1e-8 || s.usage.tokens + tokens > s.settings.tokenBudget) {
          pauseSession(session, 'budget', '模拟预算不足，本轮已暂停。提高预算后可从原位置恢复。');
          entry(s, 'session.budget.exhausted', '模拟预算不足，会话与队列已保留。', null, { sessionId: session.id });
          continue;
        }
        s.usage.usd = +(s.usage.usd + charge).toFixed(3); s.usage.tokens += tokens;
        session.usage.usd = +(session.usage.usd + charge).toFixed(3); session.usage.tokens += tokens;
        session.context.tokens = Math.min(session.context.capacity, session.context.tokens + tokens);
        advanceSession(session, s.projects.find(p => p.id === session.projectId), s);
      }
      if (!held) advanceProjects(s, this.presences);
    });
  }
}
