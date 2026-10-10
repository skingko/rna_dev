import { randomUUID } from 'node:crypto';
import { evaluateProjectCandidate, runProjectPolicy } from './project-evaluator.mjs';
import { workspaceText } from './workspace-directories.mjs';
import { PROJECT_EVALUATION_RUNTIME_HASH } from '../../packages/sdk/src/project-evolution.mjs';
import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';

// Deterministic demo adapter. A production model adapter may return the same proposal,
// but never bypass the budget, presence, evidence or delivery gates below.
const now = () => new Date().toISOString();
const error = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const string = (value, label, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) error(`${label} 必须为 1–${max} 字符文本`);
  return value.trim();
};
const finite = (value, min, max, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) error(`${label} 超出范围`);
  return value;
};
export const getProject = (state, id) => state.projects.find(p => p.id === id) ?? error('项目不存在', 404);
const event = (state, type, project, text, extra = {}) => {
  state.events.push({ id: ++state.sequence, type: `project.${type}`, projectId: project.id, message: text, at: now(), ...extra });
  state.events = state.events.slice(-1000);
};
const bool = (value, label) => { if (typeof value !== 'boolean') error(`${label} 必须为布尔值`); return value; };
export const PROJECT_SCHEDULE_DEFAULTS = Object.freeze({ reviewMinMs: 30000, reviewMaxMs: 900000, cooldownMs: 300000, minIntervalMs: 3600000 });
// Presets only select limits. They never create evidence or a scheduled task.
export const PROJECT_SCHEDULE_PRESETS = Object.freeze({
  active: Object.freeze({ reviewMinMs: 15000, reviewMaxMs: 300000, cooldownMs: 30000, minIntervalMs: 900000 }),
  balanced: PROJECT_SCHEDULE_DEFAULTS,
  quiet: Object.freeze({ reviewMinMs: 300000, reviewMaxMs: 3600000, cooldownMs: 900000, minIntervalMs: 21600000 })
});
export function normalizeProjectSchedule(project) {
  project.initiative ??= {}; project.evolution ??= {};
  project.rhythm ??= { control: 'auto' };
  for (const key of ['reviewMinMs', 'reviewMaxMs', 'cooldownMs']) project.initiative[key] ??= PROJECT_SCHEDULE_DEFAULTS[key];
  project.evolution.minIntervalMs ??= PROJECT_SCHEDULE_DEFAULTS.minIntervalMs;
  project.evolution.lastAutonomousStartedAt ??= null;
  return project;
}
export function autonomousLearningNotBefore(project) {
  const last = Date.parse(project.evolution?.lastAutonomousStartedAt);
  return Number.isFinite(last) ? last + (project.evolution.minIntervalMs ?? PROJECT_SCHEDULE_DEFAULTS.minIntervalMs) : 0;
}
export function makeProject(input = {}) {
  if (input.demo !== undefined) bool(input.demo, 'demo');
  const id = randomUUID(), baselineId = randomUUID();
  const project = {
    id, name: string(input.name ?? '自主协作工作台', '项目名称', 160),
    description: string(input.description ?? '持续理解项目现状，在有新证据时主动协作。', '项目说明', 4000),
    workspace: workspaceText(input.workspace ?? 'Pi_agent'), focus: string(input.focus ?? '让主动沟通融入日常对话', '项目焦点', 1000),
    sessionIds: [], primarySessionId: null, facts: [], commitments: [], observations: [], decisions: [], jobs: [], attention: [], opportunities: [], rhythm: { control: 'auto' },
    initiative: { enabled: true, notificationMuted: false, deferWhileTyping: true, reviewMinMs: PROJECT_SCHEDULE_DEFAULTS.reviewMinMs, reviewMaxMs: PROJECT_SCHEDULE_DEFAULTS.reviewMaxMs, cooldownMs: PROJECT_SCHEDULE_DEFAULTS.cooldownMs, minRelevance: 0.5, budgetUsd: 0.5, tokenBudget: null, budgetVersion: 1, spentUsd: 0, tokens: 0, quietUntil: null, lastSpokeAt: null },
    versions: [{ id: baselineId, version: '0.1.0', title: '项目技能包 · 基线', state: 'baseline', policy: { cacheGuard: 'signal-only', concise: false }, evidenceIds: [], createdAt: now(), simulated: true }],
    activeVersionId: baselineId, trialVersionId: null, evolution: { enabled: true, lastEvaluatedAt: null, minIntervalMs: PROJECT_SCHEDULE_DEFAULTS.minIntervalMs, lastAutonomousStartedAt: null, scope: 'project-skill-pack', candidateCount: 0 },
    decisionMode: 'demo-policy', createdAt: now(), updatedAt: now(), archivedAt: null, lastDecisionKey: null, simulated: true
  };
  if (input.initiative !== undefined || input.evolution !== undefined || input.rhythm !== undefined) updateProject(project, { initiative: input.initiative, evolution: input.evolution, rhythm: input.rhythm });
  return project;
}
export function updateProject(project, input) {
  if (input.rhythm !== undefined) {
    if (!input.rhythm || typeof input.rhythm !== 'object' || Array.isArray(input.rhythm) || Object.keys(input.rhythm).some(key => key !== 'control') || !['auto', 'manual'].includes(input.rhythm.control)) error('rhythm.control 必须为 auto 或 manual');
    project.rhythm = { control: input.rhythm.control };
  }
  for (const [key, max] of [['name', 160], ['description', 4000], ['focus', 1000]]) if (input[key] !== undefined) project[key] = string(input[key], key, max);
  if (input.workspace !== undefined) project.workspace = workspaceText(input.workspace);
  if (input.initiative !== undefined) {
    const values = input.initiative;
    if (!values || typeof values !== 'object' || Array.isArray(values)) error('initiative 必须为对象');
    if (values.enabled !== undefined) project.initiative.enabled = bool(values.enabled, 'enabled');
    if (values.notificationMuted !== undefined) project.initiative.notificationMuted = bool(values.notificationMuted, 'notificationMuted');
    if (values.deferWhileTyping !== undefined) project.initiative.deferWhileTyping = bool(values.deferWhileTyping, 'deferWhileTyping');
    // P3 tiered reach: desktop notifications are opt-in; digest hour is local time.
    if (values.desktopNotifications !== undefined) project.initiative.desktopNotifications = bool(values.desktopNotifications, 'desktopNotifications');
    if (values.digestHour !== undefined) { if (!Number.isInteger(values.digestHour) || values.digestHour < 0 || values.digestHour > 23) error('digestHour 必须为 0–23 的整数（本地时间）'); project.initiative.digestHour = values.digestHour; }
    const schedule = { ...PROJECT_SCHEDULE_DEFAULTS, ...project.initiative, ...values };
    for (const key of ['reviewMinMs', 'reviewMaxMs', 'cooldownMs']) if (values[key] !== undefined) {
      if (!Number.isSafeInteger(values[key])) error(`${key} 必须为整数毫秒`);
      finite(values[key], key === 'cooldownMs' ? 0 : 1000, 86400000, key);
    }
    if (schedule.reviewMinMs > schedule.reviewMaxMs) error('最短复查间隔不能大于最长复查间隔');
    for (const key of ['reviewMinMs', 'reviewMaxMs', 'cooldownMs']) if (values[key] !== undefined) project.initiative[key] = values[key];
    if (values.minRelevance !== undefined) project.initiative.minRelevance = finite(values.minRelevance, 0, 1, '相关度');
    if (values.budgetUsd !== undefined) project.initiative.budgetUsd = finite(values.budgetUsd, project.initiative.spentUsd, 10000, '项目预算');
    if (values.tokenBudget !== undefined) { if (values.tokenBudget !== null && !Number.isInteger(values.tokenBudget)) error('主动 token 预算必须为整数或 null'); project.initiative.tokenBudget = values.tokenBudget === null ? null : finite(values.tokenBudget, 0, 100000000, '主动 token 预算'); project.initiative.budgetVersion = 1; }
    if (values.quietUntil !== undefined) {
      if (values.quietUntil !== null && (typeof values.quietUntil !== 'string' || !Number.isFinite(Date.parse(values.quietUntil)))) error('quietUntil 必须为时间或 null');
      project.initiative.quietUntil = values.quietUntil;
    }
  }
  if (input.evolution !== undefined) {
    if (!input.evolution || typeof input.evolution !== 'object' || Array.isArray(input.evolution)) error('evolution 必须为对象');
    if (input.evolution.enabled !== undefined) project.evolution.enabled = bool(input.evolution.enabled, 'evolution.enabled');
    if (input.evolution.minIntervalMs !== undefined) { if (!Number.isSafeInteger(input.evolution.minIntervalMs)) error('自主进化最小间隔必须为整数毫秒'); project.evolution.minIntervalMs = finite(input.evolution.minIntervalMs, 0, 604800000, '自主进化最小间隔'); }
  }
  project.updatedAt = now();
  return project;
}
export function observationInput(input) {
  if (!['context', 'ci_failure', 'ci_recovered', 'preference', 'research_result', 'note', 'conversation'].includes(input.kind)) error('不支持的观察类型');
  const text = string(input.text, '观察内容', 8000);
  const eventId = string(input.eventId ?? randomUUID(), 'eventId', 160);
  const relevance = finite(input.relevance ?? (input.kind === 'note' ? 0.25 : 0.9), 0, 1, '相关度');
  const data = input.data ?? {};
  if (!data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 6000) error('data 必须为不超过 6000 字符的对象');
  if (data.variant !== undefined && !['improve', 'noop'].includes(data.variant)) error('variant 必须为 improve 或 noop');
  return { id: randomUUID(), eventId, kind: input.kind, text, relevance, data: structuredClone(data), status: 'pending', createdAt: now(), simulated: true, source: data.messageId ? 'conversation' : 'demo-event' };
}
export function addObservation(state, project, input) {
  const observation = observationInput(input);
  if (project.simulated === false || project.decisionMode === 'rna-model') { observation.simulated = false; observation.source = observation.data.messageId ? 'conversation' : 'user-observation'; }
  const existing = project.observations.find(o => o.eventId === observation.eventId);
  if (existing) {
    if (JSON.stringify([existing.kind, existing.text, existing.relevance, existing.data]) !== JSON.stringify([observation.kind, observation.text, observation.relevance, observation.data])) error('同一 eventId 不能关联不同证据', 409);
    return { project, observation: existing, duplicate: true };
  }
  project.observations.push(observation);
  project.facts.push({ id: randomUUID(), evidenceId: observation.id, text: observation.text, source: observation.source, confidence: 1, createdAt: now(), simulated: observation.simulated });
  project.updatedAt = now();
  event(state, 'observation', project, `收到新项目证据：${observation.kind}`, { evidenceId: observation.id });
  return { project, observation };
}
/** How long one presence report lasts: typing (sent every 2.5 s while typing) and reading (a 30 s heartbeat while the conversation is in front). */
export const TYPING_PRESENCE_MS = 10000, READING_PRESENCE_MS = 45000;
export function projectPresence(state, projectId, input) {
  const project = getProject(state, projectId);
  if (project.archivedAt) error('项目已归档，请先恢复。', 409);
  const sessionId = string(input.sessionId, 'sessionId', 160);
  if (!project.sessionIds.includes(sessionId)) error('会话不属于此项目', 409);
  if (state.sessions.find(session => session.id === sessionId)?.archivedAt) error('会话已归档，请先恢复。', 409);
  if (input.expectedReceiptId !== undefined && input.expectedReceiptId !== null && (typeof input.expectedReceiptId !== 'string' || !input.expectedReceiptId.length || input.expectedReceiptId.length > 160)) error('expectedReceiptId 必须是有效回执字符串或 null');
  const typing = bool(input.typing, 'typing'), visible = bool(input.visible, 'visible');
  // Typing is refreshed every few seconds and must lapse quickly; reading is a slower heartbeat.
  return { receiptId: randomUUID(), sessionId, typing, visible, at: now(), expiresAt: new Date(Date.now() + (visible && !typing ? READING_PRESENCE_MS : TYPING_PRESENCE_MS)).toISOString() };
}
function activePresence(presence) { return presence && Date.parse(presence.expiresAt) > Date.now() ? presence : null; }
function deliverySession(project, state, presence) {
  const present = activePresence(presence);
  const eligible = state.sessions.filter(session => session.projectId === project.id && !session.archivedAt && session.kind !== 'side');
  return (present?.visible ? eligible.find(session => session.id === present.sessionId) : undefined) ?? eligible.find(session => session.id === project.primarySessionId) ?? eligible[0];
}
function candidateProposal(project, observation) {
  if (observation.relevance < project.initiative.minRelevance) return { action: 'wait', reason: '与当前项目焦点相关度不足；保持安静', consume: true };
  if (observation.kind === 'conversation') return { action: 'wait', reason: '已保留用户发言为项目上下文；普通发言不自动制造后台任务', consume: true };
  if (observation.kind === 'ci_failure' || observation.kind === 'preference') {
    if (!project.evolution.enabled) return { action: 'wait', reason: '项目自主进化已暂停，证据保留', defer: true };
    return { action: 'learn', reason: observation.kind === 'ci_failure' ? '新的失败证据值得提炼项目技能候选，并与基线独立比较' : '新的沟通偏好可形成项目回复策略候选，先评估再建议试用' };
  }
  if (observation.kind === 'context') return { action: 'work', reason: '项目现状出现可检查的空缺，先做后台检查再决定是否打扰用户' };
  return { action: 'share', reason: observation.kind === 'research_result' ? '后台检查产生新结论，可以在当前对话接上讨论' : '项目出现与当前讨论相关的新信息，值得主动说明' };
}
export function proposeInitiative(project, observation) { return { ...candidateProposal(project, observation), evidenceIds: [observation.id], decisionMode: 'demo-policy' }; }
function shareBlock(project, state, presence) {
  // Mute means pause (F9), as the settings, the schedule list and REACH_GUIDANCE say: no speaking up, schedules pause.
  if (project.initiative.notificationMuted) return inLanguage(interfaceLanguageOf(state), { zh: '主动发言已暂停：不主动开口，定时任务也暂停；后台研究和进化仍可继续', en: 'Proactive messages are paused: no speaking up, and scheduled tasks pause too; background research and learning continue' });
  const currentPresence = activePresence(presence);
  if (project.initiative.deferWhileTyping !== false && currentPresence?.typing && currentPresence.visible) return '用户正在输入，暂存主动消息，等输入结束再接话';
  const session = deliverySession(project, state, presence);
  if (!session) return '项目还没有可投递的会话，主动消息与预算保留';
  if (session.activeTurnId) return '当前用户回合尚未结束，主动结论已保留，不抢占回复通道';
  if (project.initiative.lastSpokeAt && Date.now() - Date.parse(project.initiative.lastSpokeAt) < project.initiative.cooldownMs) return '刚刚主动沟通过，等待沟通冷却窗口';
  return null;
}
function next(project, state, presence) {
  if (project.archivedAt) return null;
  const unavailableEvidence = new Set(project.observations.filter(observation => observation.data?.sessionId && !state.sessions.some(session => session.id === observation.data.sessionId && !session.archivedAt)).map(observation => observation.id));
  const queuedJobs = project.jobs.filter(j => j.status === 'queued' && !j.evidenceIds?.some(id => unavailableEvidence.has(id)) && (!j.sessionId || state.sessions.some(session => session.id === j.sessionId && !session.archivedAt)));
  let job = queuedJobs.find(j => j.kind !== 'evolution' || project.evolution.enabled);
  const pending = project.observations.filter(o => o.status === 'pending' && !unavailableEvidence.has(o.id)).sort((a, b) => b.relevance - a.relevance || a.createdAt.localeCompare(b.createdAt));
  const blockedShare = shareBlock(project, state, presence);
  // A deferred delivery must not monopolize the independent background lane.
  const actionable = pending.filter(o => !candidateProposal(project, o).defer);
  const observation = (blockedShare ? actionable.find(o => ['work', 'learn'].includes(candidateProposal(project, o).action)) : null) ?? actionable[0] ?? pending[0];
  if (!job && !observation) job = queuedJobs[0];
  if (!job && !observation) return null;
  const evidenceIds = job ? job.evidenceIds : [observation.id];
  let proposal = job ? { action: 'complete-job', reason: '执行已获预算的项目后台检查', evidenceIds } : proposeInitiative(project, observation);
  const defer = reason => ({ action: 'wait', reason, defer: true, evidenceIds, observation, job });
  if (!project.initiative.enabled) return defer('项目主动能力已暂停');
  if (job?.kind === 'evolution' && !project.evolution.enabled) return defer('项目自主进化已暂停，后台候选检查点保留');
  if (project.initiative.quietUntil && Date.parse(project.initiative.quietUntil) > Date.now()) return defer('处于用户设置的免打扰时间');
  if (!job && observation?.data.messageId && state.sessions.some(s => s.projectId === project.id && s.inbox.some(m => m.id === observation.data.messageId))) return defer('用户消息仍在待发队列，等待消费后再更新项目判断');
  if (proposal.action === 'share' && blockedShare) return defer(blockedShare);
  const charge = { work: 0.012, learn: 0.024, share: 0.004 }[proposal.action] ?? 0;
  const tokens = { work: 620, learn: 1240, share: 180 }[proposal.action] ?? 0;
  const daily = state.usage.day === now().slice(0, 10) ? state.usage : { usd: 0, tokens: 0 };
  if (project.initiative.spentUsd + charge > project.initiative.budgetUsd + 1e-8 || daily.usd + charge > state.settings.dailyBudget + 1e-8 || daily.tokens + tokens > state.settings.tokenBudget) return defer('模拟预算不足，新观察和通知保留，尚未产生费用');
  return { ...proposal, observation, job, charge, tokens };
}
const keyOf = proposal => JSON.stringify([proposal.action, proposal.reason, proposal.evidenceIds]);
export function hasProjectWork(state, presences) {
  return state.projects.some(project => {
    if (project.archivedAt || project.initialization || project.decisionMode !== 'demo-policy') return false;
    const proposal = next(project, state, presences.get(project.id));
    return proposal && (proposal.action !== 'wait' || keyOf(proposal) !== project.lastDecisionKey);
  });
}
function recordDecision(state, project, proposal) {
  const decision = { id: randomUUID(), action: proposal.action === 'complete-job' ? 'work' : proposal.action, reason: proposal.reason, evidenceIds: proposal.evidenceIds, status: proposal.defer ? 'deferred' : 'completed', at: now(), decisionMode: 'demo-policy', simulated: true };
  project.decisions.push(decision);
  project.lastDecisionKey = keyOf(proposal);
  project.updatedAt = now();
  event(state, `initiative.${decision.action}`, project, decision.reason, { decisionId: decision.id, evidenceIds: decision.evidenceIds });
  project.attention = proposal.defer ? [{ id: decision.id, text: proposal.reason, evidenceIds: proposal.evidenceIds }] : [];
  return decision;
}
function completeJob(state, project, job) {
  const evidence = project.observations.find(o => o.id === job.evidenceIds[0]);
  if (job.kind === 'research' && job.contextSnapshot.focus !== project.focus) {
    job.status = 'superseded'; job.completedAt = now(); job.output = '项目焦点已被用户修正，旧检查结果不覆盖新上下文，也不发送过时建议。';
    return;
  }
  if (job.kind === 'research') {
    addObservation(state, project, { kind: 'research_result', eventId: `result-${job.id}`, text: `我重新看了「${project.name}」的现状，有个值得先对齐的地方：${project.focus}。目前还有 ${project.observations.filter(o => o.kind === 'ci_failure').length} 条失败证据。我可以在后台检查这些证据；你可以直接继续原来的讨论，不用另建目标。`, data: { jobId: job.id }, relevance: 0.9 });
    job.output = '形成了与项目现状关联的讨论提示；由明确的演示模板生成。';
  } else {
    const baseline = project.versions.find(v => v.id === job.baseVersionId);
    const policy = structuredClone(baseline.policy);
    if (evidence.data.variant !== 'noop') {
      if (evidence.kind === 'ci_failure') policy.cacheGuard = 'signal-and-revision-and-smoke';
      else policy.concise = true;
    }
    const version = { id: randomUUID(), version: `0.${++project.evolution.candidateCount + 1}.0`, title: evidence.kind === 'ci_failure' ? '依赖缓存校验技能' : '先给结论的项目沟通策略', state: 'evaluating', policy, parentVersionId: baseline.id, evidenceIds: [evidence.id], jobId: job.id, createdAt: now(), notifiedAt: null, simulated: true };
    version.evaluation = evaluateProjectCandidate(baseline.policy, version.policy);
    version.state = !version.evaluation.gatePassed ? 'rejected' : baseline.id !== project.activeVersionId ? 'stale' : 'ready';
    project.versions.push(version);
    project.evolution.lastEvaluatedAt = now();
    job.versionId = version.id;
    job.output = version.state === 'stale' ? '项目基线在评测期间变化；此候选已过时，不推送或试用。' : version.evaluation.gatePassed ? '候选通过独立合成评测，待主动提醒用户试用；尚未覆盖当前版本。' : '候选未优于基线，已保留评测记录，不向用户推送更新。';
    if (version.state === 'ready') {
      project.opportunities.push({ id: randomUUID(), versionId: version.id, title: `可试用项目版本 ${version.version}`, evidenceIds: [evidence.id], status: 'available' });
      addObservation(state, project, { kind: 'research_result', eventId: `version-ready-${version.id}`, text: `刚才这条${evidence.kind === 'ci_failure' ? '失败记录' : '沟通偏好'}给了我一个改进线索。我在后台做出了项目技能包 ${version.version}，独立合成评测从 ${version.evaluation.baseline}/${version.evaluation.cases} 提高到 ${version.evaluation.score}/${version.evaluation.cases}。想让你试用看看；当前版本没有被替换，随时可以退出试用。`, relevance: 1, data: { versionId: version.id, jobId: job.id } });
    }
  }
  job.status = 'completed'; job.completedAt = now();
}
export function advanceProjects(state, presences) {
  for (const project of state.projects) {
    if (project.archivedAt || project.initialization || project.decisionMode !== 'demo-policy') continue;
    const proposal = next(project, state, presences.get(project.id));
    if (!proposal || (proposal.action === 'wait' && keyOf(proposal) === project.lastDecisionKey)) continue;
    const decision = recordDecision(state, project, proposal);
    if (proposal.action === 'wait') {
      if (proposal.consume) { proposal.observation.status = 'ignored'; proposal.observation.processedAt = now(); }
      continue;
    }
    project.initiative.spentUsd = +(project.initiative.spentUsd + proposal.charge).toFixed(3);
    project.initiative.tokens += proposal.tokens;
    state.usage.usd = +(state.usage.usd + proposal.charge).toFixed(3); state.usage.tokens += proposal.tokens;
    if (proposal.action === 'complete-job') { completeJob(state, project, proposal.job); continue; }
    const observation = proposal.observation;
    observation.status = 'handled'; observation.processedAt = now();
    if (proposal.action === 'work' || proposal.action === 'learn') {
      const job = { id: randomUUID(), projectId: project.id, kind: proposal.action === 'learn' ? 'evolution' : 'research', status: 'queued', evidenceIds: proposal.evidenceIds, decisionId: decision.id, createdAt: now(), simulated: true, lane: 'background', decisionMode: 'demo-policy', baseVersionId: project.activeVersionId, contextSnapshot: { focus: project.focus, commitmentIds: project.commitments.map(c => c.id) } };
      project.jobs.push(job);
    } else if (proposal.action === 'share') {
      const session = deliverySession(project, state, presences.get(project.id));
      if (!session) continue;
      const version = project.versions.find(v => v.id === observation.data.versionId);
      // Marking delivery and appending the item happen within the same store mutation.
      // Durable evidence IDs and this version marker prevent restart notification duplication.
      if (version?.notifiedAt) continue;
      const item = { id: randomUUID(), turnId: null, kind: 'assistant', text: observation.text, createdAt: now(), simulated: true, source: 'initiative', reason: proposal.reason, evidenceIds: proposal.evidenceIds, decisionId: decision.id, projectId: project.id, decisionMode: 'demo-policy', initiative: { kind: version ? 'version_ready' : observation.kind === 'ci_recovered' ? 'insight' : 'question', jobId: observation.data.jobId ?? null }, originContext: { projectId: project.id, focus: project.focus, evidenceIds: version ? [...proposal.evidenceIds, ...version.evidenceIds] : proposal.evidenceIds }, ...(version ? { versionId: version.id } : {}) };
      session.items.push(item); session.updatedAt = now();
      session.usage.usd = +(session.usage.usd + proposal.charge).toFixed(3); session.usage.tokens += proposal.tokens;
      session.context.tokens = Math.min(session.context.capacity, session.context.tokens + proposal.tokens);
      project.initiative.lastSpokeAt = now();
      if (version) { version.notifiedAt = now(); version.notificationItemId = item.id; version.notificationSessionId = session.id; }
    }
  }
}
export function controlVersion(state, project, versionId, action) {
  const version = project.versions.find(v => v.id === versionId) ?? error('项目版本不存在', 404);
  if (['trial', 'adopt'].includes(action) && version.evaluationRevision) error('此记录使用修订评估标准，仅供独立复评；不能直接试用或采用。请先审阅并采用新的评估标准。', 409);
  if (['trial', 'adopt'].includes(action) && (version.sourceDeleted || version.contextRevoked)) error('候选来源会话已删除，评估证据已撤销；请基于保留的项目证据重新生成评估。', 409);
  const actual = project.simulated === false || project.decisionMode === 'rna-model';
  if (actual && ['trial', 'adopt'].includes(action)) {
    const parent = project.versions.find(item => item.id === version.parentVersionId);
    if (!version.bundle || version.evaluation?.simulated !== false || version.evaluation?.candidateHash !== version.bundle.hash || version.evaluation?.baselineHash !== parent?.bundle?.hash) error('候选缺少对应实际能力包的冻结评测证据', 409);
    if (version.evaluationRuntimeHash !== PROJECT_EVALUATION_RUNTIME_HASH || version.evaluation?.evaluationRuntimeHash !== PROJECT_EVALUATION_RUNTIME_HASH) error('评估运行环境已变化或旧记录缺少运行指纹；请在当前环境重新评估后试用。', 409);
  }
  if (action === 'trial') {
    if (!['ready', 'trial'].includes(version.state) || !version.evaluation?.gatePassed || version.parentVersionId !== project.activeVersionId) error('只有通过评测且更优的候选可以试用', 409);
    if (project.trialVersionId && project.trialVersionId !== version.id) project.versions.find(v => v.id === project.trialVersionId).state = 'ready';
    project.trialVersionId = version.id; version.state = 'trial'; version.trialAt = now();
  } else if (action === 'rollback') {
    if (project.trialVersionId === version.id) { project.trialVersionId = null; version.state = 'ready'; }
    else if (actual && project.activeVersionId === version.id && !project.trialVersionId && version.parentVersionId) {
      const parent = project.versions.find(item => item.id === version.parentVersionId);
      if (!parent?.bundle) error('没有可恢复的已验证父版本', 409);
      project.activeVersionId = parent.id; parent.state = 'active'; version.state = 'archived';
    } else error('只能退出当前试用或将已采用版本回退到其父版本', 409);
    version.rolledBackAt = now();
  } else if (action === 'adopt') {
    if (project.trialVersionId !== version.id || !version.evaluation?.gatePassed) error('先试用通过评测的版本，再明确采用', 409);
    const previous = project.versions.find(v => v.id === project.activeVersionId); previous.state = 'archived';
    project.activeVersionId = version.id; project.trialVersionId = null; version.state = 'active'; version.adoptedAt = now();
    for (const sibling of project.versions) if (sibling.id !== version.id && sibling.state === 'ready' && sibling.parentVersionId !== version.id) {
      sibling.state = 'stale';
      for (const observation of project.observations) if (observation.status === 'pending' && observation.data.versionId === sibling.id) observation.status = 'superseded';
    }
  } else error('不支持的版本操作');
  project.updatedAt = now();
  event(state, `version.${action}`, project, `${action} 项目版本 ${version.version}；${actual ? '从下一轮开始使用所选提示词、技能与工具，已有轮次保持原版本。' : '仅影响此项目模拟技能策略。'}`, { versionId });
  return { project, version };
}
export function checkProject(project, input) {
  if (project.decisionMode !== 'demo-policy') error('合成样本检查仅适用于演示项目；真实候选需通过 SDK 的项目评测器。', 409);
  for (const field of ['signal', 'revision', 'smoke']) bool(input[field], field);
  const version = project.versions.find(v => v.id === (project.trialVersionId ?? project.activeVersionId));
  return { projectId: project.id, versionId: version.id, version: version.version, reuse: runProjectPolicy(version.policy, input), result: runProjectPolicy(version.policy, input) ? '复用缓存（模拟决策）' : '拒绝复用，要求重新验证（模拟决策）', simulated: true };
}
