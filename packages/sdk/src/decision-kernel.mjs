import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { canonicalJSON } from './journal.mjs';
import { specTemplate, validateSpecTemplate } from './decision-templates.mjs';
import { DECISION_STATE_ROOTS } from './decision-state.mjs';

// Protocol reference: mu 1272e53/packages/kyrn-judge, TypeSafe System One.
// Independently implemented for Rna; this module never executes an action,
// grants permission, changes an evaluation rubric, or accepts an evolution.
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const DECISION_KERNEL_VERSION = 2;
const POINTS = new Set(['gene.consolidate', 'initiative.review', 'work.coverage', 'work.completion', 'evolution.review', 'chat.preflight', 'chat.route', 'turn.route', 'delivery.reach', 'skill.screen', 'candidate.prescore', 'tool.risk', 'message.check', 'message.value', 'memory.filter', 'mind.judge', 'initiative.direct', 'turn.settled', 'tool.admission', 'input.interjection', 'guard.triage', 'turn.review', 'invite.stale', 'standard.link', 'skill.retire', 'answer.match', 'lesson.applied', 'diagnostics.delivery', 'schedule.suggest', 'tool.constraint', 'turn.drift', 'turn.rewind', 'plan.better', 'commitment.due', 'share.resolved', 'reply.target', 'attention.now', 'evidence.select', 'capability.disclosure', 'context.forget', 'notes.worth', 'feedback.signal', 'ask.necessity', 'gene.route', 'gene.review', 'session.resume', 'effort.decision', 'effort.work', 'effort.narrator', 'effort.setup', 'effort.compaction']);
// Foreground points score the current user turn; they never need a main review.
const FOREGROUND = new Set(['chat.preflight', 'chat.route', 'turn.route', 'turn.settled', 'tool.admission', 'input.interjection', 'ask.necessity', 'tool.risk', 'memory.filter']);
// Points that only score one already-made choice; project review signals
// (due schedules, failures, pending questions) do not route them to a main review.
const UNGATED = new Set([...FOREGROUND, 'gene.consolidate', 'work.coverage', 'work.completion', 'delivery.reach', 'message.check', 'message.value', 'mind.judge', 'initiative.direct', 'guard.triage', 'turn.review', 'invite.stale', 'standard.link', 'skill.retire', 'answer.match', 'lesson.applied', 'diagnostics.delivery', 'schedule.suggest', 'tool.constraint', 'turn.drift', 'turn.rewind', 'plan.better', 'commitment.due', 'share.resolved', 'reply.target', 'attention.now', 'evidence.select', 'capability.disclosure', 'context.forget', 'notes.worth', 'feedback.signal', 'gene.route', 'gene.review', 'session.resume', 'effort.decision', 'effort.work', 'effort.narrator', 'effort.setup', 'effort.compaction']);
// Points whose questions come only from versioned host code templates.
const LEGACY_TEMPLATES = new Set(['chat.route', 'delivery.reach', 'skill.screen', 'candidate.prescore']);
// Spec templates (decision-templates.mjs) add turn.route, tool.risk,
// message.check, memory.filter and host atomic questions for initiative.review.
const TEMPLATE_POINTS = new Set([...LEGACY_TEMPLATES, 'gene.consolidate', 'work.coverage', 'work.completion', 'turn.route', 'turn.settled', 'tool.risk', 'message.check', 'message.value', 'memory.filter', 'initiative.review', 'mind.judge', 'initiative.direct', 'tool.admission', 'input.interjection', 'guard.triage', 'turn.review', 'invite.stale', 'standard.link', 'skill.retire', 'answer.match', 'lesson.applied', 'diagnostics.delivery', 'schedule.suggest', 'tool.constraint', 'turn.drift', 'turn.rewind', 'plan.better', 'commitment.due', 'share.resolved', 'reply.target', 'attention.now', 'evidence.select', 'capability.disclosure', 'context.forget', 'notes.worth', 'feedback.signal', 'ask.necessity', 'gene.route', 'gene.review', 'session.resume', 'effort.decision', 'effort.work', 'effort.narrator', 'effort.setup', 'effort.compaction']);
// Main-model plan points that may carry a host-template supplement in the same request.
const SUPPLEMENT_POINTS = new Set(['initiative.review']);
export const DELIVERY_REACH_TEMPLATE_VERSION = 1;
const REACH_OPTIONS = ['digest', 'inbox', 'inline', 'notify'];
export const DECISION_BACKENDS = Object.freeze(['typesafe', 'llm']);
export const CHAT_ROUTE_TEMPLATE_VERSION = 1;
export const CHAT_ROUTE_BUDGET_MS = 900;
export const MAX_ROUTE_SKILLS = 4;
// P4 host templates: marketplace candidate screening and candidate prior scoring.
export const SKILL_SCREEN_TEMPLATE_VERSION = 1;
export const CANDIDATE_PRESCORE_TEMPLATE_VERSION = 1;
export const MAX_SCREEN_CANDIDATES = 8;
const SCREEN_KEY = /^fit_[0-9]{1,2}$/;
const MODES = new Set(['off', 'shadow', 'active']);
export const BACKOFF_BASE_MS = 100, BACKOFF_ATTEMPTS = 3;
const ESCAPES = new Set(['other', 'unknown', 'unclear', 'none']);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const unit = (value, fallback = .5) => typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : fallback;
const rounded = value => Math.round(value * 1000) / 1000;
const failure = code => Object.assign(new Error(`Decision kernel: ${code}`), { code });
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const record = value => value && typeof value === 'object' && !Array.isArray(value);

/** Conservative bounded policy generated anew from host-verified conditions.
 * These are routing thresholds, not estimated model accuracy. Higher novelty
 * lowers the cost of investigating, never the bar for accepting an evolution.
 * Suppressing a review always needs a stronger negative than recommending it.
 */
export function deriveDecisionPolicy(point, signals = {}) {
  const novelty = unit(signals.novelty), evidence = unit(signals.evidenceStrength), maturity = unit(signals.maturity), load = unit(signals.load, 0);
  const consequence = unit(signals.consequence, FOREGROUND.has(point) ? .2 : .6);
  const recurring = signals.recurring === true, completed = signals.completed === true;
  const taskType = ['research', 'coding', 'creative', 'analysis', 'recurring', 'chat'].includes(signals.taskType) ? signals.taskType : 'unknown';
  const uncertainty = (1 - evidence) * .12 + consequence * .1;
  const confidence = clamp(.68 + uncertainty + maturity * .025 + (point === 'evolution.review' ? .035 : 0), .68, .92);
  const urgent = signals.dueSchedule === true || signals.severeFailure === true;
  const yes = clamp(confidence - novelty * .09 + load * .025 - (urgent ? .04 : 0), .68, .94);
  const no = clamp(.13 - novelty * .055 - (signals.hasPendingWork === true ? .035 : 0) + (completed && !signals.hasPendingWork ? .025 : 0), .035, .17);
  const margin = clamp(.12 + uncertainty + (taskType === 'research' || taskType === 'creative' ? .035 : 0), .14, .34);
  const ttlMs = FOREGROUND.has(point) ? 0 : Math.round(clamp(12000 + maturity * 30000 + load * 18000 + (recurring ? 20000 : 0) - novelty * 30000, 2000, 60000));
  return Object.freeze({ version: 1, yes: rounded(yes), no: rounded(no), confidence: rounded(confidence), margin: rounded(margin),
    timeoutMs: Math.round(['chat.route', 'turn.route', 'tool.risk'].includes(point) ? CHAT_ROUTE_BUDGET_MS : point === 'memory.filter' ? 700 : point === 'mind.judge' ? 2500 : point === 'chat.preflight' ? clamp(1600 + novelty * 600 - load * 500, 900, 2400) : clamp(3000 + evidence * 1000 - load * 1000, 1600, 4500)),
    ttlMs, maxStateChars: point === 'chat.route' ? 4000 : point === 'turn.route' ? 16000 : point === 'lesson.applied' ? 20000 : point === 'memory.filter' || point === 'mind.judge' || point === 'work.coverage' || point === 'gene.consolidate' ? 10000 : point === 'chat.preflight' ? 5600 : 8000, taskType,
    rationale: { novelty, evidenceStrength: evidence, maturity, load, consequence, recurring, completed, dueSchedule: signals.dueSchedule === true, unansweredQuestion: signals.unansweredQuestion === true, deliveryJustCompleted: signals.deliveryJustCompleted === true, severeFailure: signals.severeFailure === true },
  });
}

function secretText(value, known) {
  let text = String(value);
  for (const item of known) {
    if (typeof item !== 'string' || item.length < 4) continue;
    for (const variant of [item, encodeURIComponent(item)]) text = text.split(variant).join('[redacted]');
  }
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b(?:sk-[\w-]{16,}|apikey_[\w-]{16,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,})/g, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z\d._~+/=-]{8,}/gi, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|credential)["']?\s*[:=]\s*)["']?[^\s,"';}]+["']?/gi, '$1[redacted]')
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:key|api_key|token|signature|password)=)[^&\s)]+/gi, '$1[redacted]');
}

/** Only explicitly named small fields may leave for the auxiliary model.
 * Unknown fields (transcripts, raw tools, full genomes, provider config) drop.
 * `knownSecrets` supplements shape redaction; it is never included in output.
 */
/** The most state text one judgment reads. D1 raised it from 10000 for the two points that carry rule bodies (turn.route with its
 * rulebook: 16000; lesson.applied with its turn digest and rules: 20000). gene.consolidate was declared 24000 but has always been cut
 * to 10000 by the old ceiling; it is pinned to what it was measured at (docs/research/gene-contradicts-probe-20261005.md,
 * gene-place-instructions-probe-20261005.md) rather than silently changed here. */
export const STATE_CHARS_CEILING = 24000;
export function minimizeDecisionState(input = {}, { maxChars = 8000, knownSecrets = [] } = {}) {
  let remaining = clamp(Number.isFinite(maxChars) ? maxChars : 8000, 256, STATE_CHARS_CEILING);
  const text = (value, max = 1000) => {
    if (typeof value !== 'string' || remaining <= 0) return undefined;
    const clean = secretText(value, knownSecrets).slice(0, Math.min(max, remaining)); remaining -= clean.length; return clean;
  };
  const fields = (source, names, max = 1000) => {
    const output = {};
    for (const name of names) {
      const value = source?.[name];
      const clean = typeof value === 'string' ? text(value, max) : typeof value === 'boolean' ? value : typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      if (clean !== undefined) output[name] = clean;
    }
    return output;
  };
  const output = {};
  for (const [key, max] of [['userMessage', 2400], ['currentAction', 700]]) { const value = text(input?.[key], max); if (value !== undefined) output[key] = value; }
  if (record(input.task)) output.task = fields(input.task, ['title', 'goal', 'phase', 'summary', 'completed', 'recurring', 'taskTypes'], 1000);
  if (record(input.pending)) output.pending = fields(input.pending, ['work', 'delivery', 'questions', 'learning'], 200);
  if (record(input.rhythm)) output.rhythm = fields(input.rhythm, ['lifecycle', 'initiativeMode', 'evolutionMode', 'nextRunAt'], 200);
  if (Array.isArray(input.evidence)) output.evidence = input.evidence.slice(-6).map(row => fields(row, ['id', 'type', 'summary', 'novelty', 'verified'], 600));
  if (record(input.candidate)) {
    output.candidate = fields(input.candidate, ['summary', 'hypothesis', 'failureCount'], 900);
    if (Array.isArray(input.candidate.changedAreas)) output.candidate.changedAreas = input.candidate.changedAreas.filter(value => ['prompt', 'skills', 'tools', 'evaluation', 'policy', 'memory', 'workflow', 'rhythm', 'communication', 'mcp'].includes(value)).slice(0, 10);
  }
  // Marketplace metadata only (skill.screen): never source bodies or project prose.
  if (Array.isArray(input.candidates)) output.candidates = input.candidates.slice(0, MAX_SCREEN_CANDIDATES).map(row => fields(row, ['name', 'description', 'source', 'maintenance', 'compatibility'], 400));
  if (Array.isArray(input.recentSummaries)) output.recentSummaries = input.recentSummaries.slice(-3).map(value => text(value, 1200)).filter(value => value !== undefined);
  // buildDecisionState roots: strings/booleans only (no numbers reach the judge),
  // bounded depth, width and length; every string is secret-redacted.
  const tree = (value, depth) => {
    if (typeof value === 'string') return text(value, 2400);
    if (typeof value === 'boolean') return value;
    if (depth >= 4 || !value || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) return value.slice(0, 16).map(item => tree(item, depth + 1)).filter(item => item !== undefined);
    const clean = {};
    for (const [key, item] of Object.entries(value).slice(0, 24)) { if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)) continue; const next = tree(item, depth + 1); if (next !== undefined) clean[key] = next; }
    return clean;
  };
  for (const key of BUILT_ROOTS) if (input[key] !== undefined && !Object.hasOwn(output, key)) { const value = tree(input[key], 0); if (value !== undefined) output[key] = value; }
  return output;
}

// Every root a point's template may reference (decision-state.mjs) reaches the judge; nothing else does.
const BUILT_ROOTS = [...new Set(Object.values(DECISION_STATE_ROOTS).flat())];
const NECESSITY_KEYS = ['initiative_need', 'initiative_pause', 'schedule_need', 'evolution_need', 'memory_need'];
const PLAN_KEYS = ['task_state', ...NECESSITY_KEYS, 'user_satisfaction'];
const POINT_QUESTIONS = Object.freeze({
  'initiative.review': ['task_state', 'initiative_need', 'initiative_pause', 'schedule_need'],
  'evolution.review': ['task_state', 'evolution_need', 'user_satisfaction'],
  'chat.preflight': ['task_state', 'user_satisfaction', 'memory_need'],
});
const planText = { type: 'string', minLength: 1, maxLength: 400, pattern: '\\S' };
const instructionsSchema = { type: 'string', minLength: 1, maxLength: 1200, pattern: '\\S' };
const booleanSchema = { type: 'object', additionalProperties: false, required: ['type', 'instructions', 'criteria'], properties: {
  type: { type: 'string', const: 'boolean' }, instructions: instructionsSchema,
  criteria: { type: 'object', additionalProperties: false, required: ['true', 'false'], properties: { true: planText, false: planText } },
} };
/** Main-model authored content only. Provenance is attested separately by the
 * host using an actual model-turn receipt, never accepted from this document.
 * Higher user_satisfaction positions always mean more satisfied; neither that
 * score nor task_state can complete work, grant authority or adopt a version.
 */
export const DECISION_ASSESSMENT_PLAN_SCHEMA = Object.freeze({ type: 'object', description: 'Return {version:1,questions:{question_id:{type,instructions,criteria}}}. version is the number 1. Every question includes its type next to instructions and criteria, never inside criteria. memory_need means whether retrieving project memory before answering is needed, not whether to store the current message. Write options and anchors from the project evidence; do not supply scores.', additionalProperties: false, required: ['version', 'questions'], properties: {
  version: { type: 'integer', const: 1 }, questions: { type: 'object', minProperties: 1, maxProperties: 7, additionalProperties: false, properties: {
    ...Object.fromEntries(NECESSITY_KEYS.map(key => [key, booleanSchema])),
    task_state: { type: 'object', additionalProperties: false, required: ['type', 'instructions', 'criteria'], properties: {
      type: { type: 'string', const: 'choice' }, instructions: instructionsSchema,
      criteria: { type: 'object', minProperties: 2, maxProperties: 8, required: ['unknown'], additionalProperties: planText, description: 'Each option ID must match ^[a-z][a-z0-9_]{0,31}$; the unknown option is required. All descriptions are authored by the main model.' },
    } },
    user_satisfaction: { type: 'object', additionalProperties: false, required: ['type', 'instructions', 'criteria'], properties: {
      type: { type: 'string', const: 'score' }, instructions: instructionsSchema,
      criteria: { type: 'array', minItems: 2, maxItems: 2, items: planText, description: 'Main-model authored anchors: index 0 means dissatisfied, index 1 means satisfied.' },
    } },
  } },
} });
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const boundedPlanText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
export function validateDecisionAssessmentPlan(value) {
  const invalid = () => { throw failure('invalid_assessment_plan'); };
  if (!exactKeys(value, ['version', 'questions']) || value.version !== 1 || !record(value.questions)) invalid();
  const entries = Object.entries(value.questions);
  if (!entries.length || entries.length > 7 || entries.some(([id]) => !PLAN_KEYS.includes(id))) invalid();
  const questions = {};
  for (const [id, question] of entries) {
    if (!exactKeys(question, ['type', 'instructions', 'criteria']) || !boundedPlanText(question.instructions, 1200)) invalid();
    const clean = { type: question.type, instructions: question.instructions, criteria: null };
    if (NECESSITY_KEYS.includes(id)) {
      if (question.type !== 'boolean' || !exactKeys(question.criteria, ['true', 'false']) || Object.values(question.criteria).some(text => !boundedPlanText(text, 400))) invalid();
      clean.criteria = { true: question.criteria.true, false: question.criteria.false };
    } else if (id === 'task_state') {
      if (question.type !== 'choice' || !record(question.criteria)) invalid();
      const options = Object.entries(question.criteria);
      if (options.length < 2 || options.length > 8 || !Object.hasOwn(question.criteria, 'unknown') || options.some(([key, text]) => !/^[a-z][a-z0-9_]{0,31}$/.test(key) || !boundedPlanText(text, 400))) invalid();
      clean.criteria = Object.fromEntries(options);
    } else {
      if (question.type !== 'score' || !Array.isArray(question.criteria) || question.criteria.length !== 2 || [0, 1].some(index => !boundedPlanText(question.criteria[index], 400))) invalid();
      clean.criteria = [...question.criteria];
    }
    questions[id] = clean;
  }
  const output = { version: 1, questions };
  if (JSON.stringify(output).length > 16000) invalid();
  return output;
}
export function decisionAssessmentPlanHash(value) {
  return createHash('sha256').update(canonicalJSON(validateDecisionAssessmentPlan(value))).digest('hex');
}
/** Host-code question templates: versioned and hashed, with no main-model
 * receipt. They only ask the judge to choose among options the host
 * enumerated; a template never adds actions, permissions or free-form output. */
const ROUTE_SKILL_KEY = /^skill_[a-z0-9_]{1,40}$/;
export const routeSkillKey = id => `skill_${String(id).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'unnamed'}`;
export function validateHostTemplatePlan(value) {
  const invalid = () => { throw failure('invalid_assessment_plan'); };
  if (exactKeys(value, ['version', 'source', 'template', 'templateVersion', 'questions']) && value.version === 1 && value.source === 'host-template' && specTemplate(value) && value.templateVersion <= 1000) return validateSpecTemplate(value) ?? invalid();
  if (!exactKeys(value, ['version', 'source', 'template', 'templateVersion', 'questions']) || value.version !== 1 || value.source !== 'host-template' || !LEGACY_TEMPLATES.has(value.template)
    || !Number.isSafeInteger(value.templateVersion) || value.templateVersion < 1 || value.templateVersion > 1000 || !record(value.questions)) invalid();
  const entries = Object.entries(value.questions), template = value.template;
  const limit = template === 'chat.route' ? 2 + MAX_ROUTE_SKILLS : template === 'skill.screen' ? 1 + MAX_SCREEN_CANDIDATES : template === 'delivery.reach' ? 1 : 2;
  if (!entries.length || entries.length > limit || entries.filter(([id]) => ROUTE_SKILL_KEY.test(id)).length > MAX_ROUTE_SKILLS) invalid();
  const booleanQuestion = question => question.type === 'boolean' && exactKeys(question.criteria, ['true', 'false']) && Object.values(question.criteria).every(text => boundedPlanText(text, 400));
  const scoreQuestion = question => question.type === 'score' && Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 5 && question.criteria.every(text => boundedPlanText(text, 400));
  const questions = {};
  for (const [id, question] of entries) {
    if (!exactKeys(question, ['type', 'instructions', 'criteria']) || !boundedPlanText(question.instructions, 1200)) invalid();
    if (template === 'delivery.reach' && id === 'reach_tier') {
      // Options are tiers no more intrusive than the host already allows, plus unknown.
      const options = record(question.criteria) ? Object.entries(question.criteria) : [];
      if (question.type !== 'choice' || options.length < 3 || !Object.hasOwn(question.criteria, 'unknown') || options.some(([key, text]) => !(key === 'unknown' || REACH_OPTIONS.includes(key)) || !boundedPlanText(text, 400))) invalid();
      questions[id] = { type: 'choice', instructions: question.instructions, criteria: Object.fromEntries(options) };
    } else if (template === 'chat.route' && id === 'reasoning_effort') {
      const options = record(question.criteria) ? Object.entries(question.criteria) : [];
      if (question.type !== 'choice' || options.length < 3 || options.length > 10 || !Object.hasOwn(question.criteria, 'unknown') || options.some(([key, text]) => !/^[a-z][a-z0-9_]{0,31}$/.test(key) || !boundedPlanText(text, 400))) invalid();
      questions[id] = { type: 'choice', instructions: question.instructions, criteria: Object.fromEntries(options) };
    } else if (template === 'chat.route' ? id === 'memory_need' || ROUTE_SKILL_KEY.test(id) : template === 'skill.screen' ? SCREEN_KEY.test(id) : template === 'candidate.prescore' && id === 'candidate_better') {
      if (!booleanQuestion(question)) invalid();
      questions[id] = { type: 'boolean', instructions: question.instructions, criteria: { true: question.criteria.true, false: question.criteria.false } };
    } else if (template === 'skill.screen' && id === 'overall_fit' || template === 'candidate.prescore' && id === 'expected_gain') {
      if (!scoreQuestion(question)) invalid();
      questions[id] = { type: 'score', instructions: question.instructions, criteria: [...question.criteria] };
    } else invalid();
  }
  if (template === 'skill.screen' && !Object.keys(questions).some(id => SCREEN_KEY.test(id)) || template === 'candidate.prescore' && !questions.candidate_better || template === 'delivery.reach' && !questions.reach_tier) invalid();
  const output = { version: 1, source: 'host-template', template, templateVersion: value.templateVersion, questions };
  if (JSON.stringify(output).length > 16000) invalid();
  return output;
}
export const hostTemplateHash = value => createHash('sha256').update(canonicalJSON(validateHostTemplatePlan(value))).digest('hex');
const effortText = (ratio, count) => ratio === 0 ? 'Lightest adequate depth: greetings, acknowledgements, simple factual lookups or formatting answerable directly.'
  : ratio >= .999 ? 'Deepest depth: hard multi-step design, debugging, proofs or high-stakes changes where a mistake is costly.'
  : ratio < .5 || count === 2 ? 'Light depth: routine questions or small, clearly specified edits.' : 'Substantial depth: multi-step analysis, non-trivial code changes or planning.';
/** Builds the chat.route template from host-owned model efforts and skills. */
export function chatRouteTemplate({ efforts = [], memory = true, skills = [] } = {}) {
  const questions = {};
  const ids = efforts.map(effort => typeof effort === 'string' ? { id: effort, label: effort } : effort).filter(effort => /^[a-z][a-z0-9_]{0,31}$/.test(effort?.id) && effort.id !== 'unknown');
  if (ids.length >= 2) questions.reasoning_effort = { type: 'choice', instructions: 'Choose the least reasoning depth that will still answer this user message well. Options are ordered from lightest to deepest.',
    criteria: { ...Object.fromEntries(ids.map((effort, index) => [effort.id, `${String(effort.label ?? effort.id).slice(0, 40)} (${effort.id}): ${effortText(index / (ids.length - 1), ids.length)}`])), unknown: 'Cannot tell from the message which depth is appropriate.' } };
  if (memory) questions.memory_need = { type: 'boolean', instructions: 'Does answering this message need facts, decisions or history stored in project memory (beyond the message itself and recent conversation)?',
    criteria: { true: 'The answer depends on earlier project facts, decisions, preferences or prior work.', false: 'The message is self-contained or only concerns the current conversation.' } };
  for (const skill of skills.slice(0, MAX_ROUTE_SKILLS)) questions[routeSkillKey(skill.id)] = { type: 'boolean', instructions: 'Will this request need the named skill?',
    criteria: { true: `Needs the skill "${String(skill.name ?? skill.id).slice(0, 80)}": ${String(skill.description ?? '').slice(0, 280) || 'as named.'}`, false: 'This skill is not needed for this request.' } };
  return { version: 1, source: 'host-template', template: 'chat.route', templateVersion: CHAT_ROUTE_TEMPLATE_VERSION, questions };
}
const REACH_TEXT = {
  digest: 'Batch it into the next daily summary: useful background, nothing the user needs before then.',
  inbox: 'File it quietly for the user to read later: useful but not time-sensitive.',
  inline: 'Append it to the conversation now: a useful finding the user should see soon.',
  notify: 'Also raise a desktop notification: time-sensitive, worth interrupting the user.'
};
/** delivery.reach: may the host deliver less intrusively than the main model
 * asked? Options are only tiers at or below the already-capped request, so a
 * verdict can lower intrusiveness but never escalate it. Null when there is
 * nothing lower to choose. */
export function deliveryReachTemplate({ maxTier } = {}) {
  const limit = REACH_OPTIONS.indexOf(maxTier);
  if (limit < 1) return null;
  const criteria = Object.fromEntries(REACH_OPTIONS.slice(0, limit + 1).map(tier => [tier, REACH_TEXT[tier]]));
  criteria.unknown = 'Cannot tell from the message and context; keep the requested tier.';
  return { version: 1, source: 'host-template', template: 'delivery.reach', templateVersion: DELIVERY_REACH_TEMPLATE_VERSION,
    questions: { reach_tier: { type: 'choice', instructions: 'A proactive message from the project assistant is ready. Considering the message, the user\'s recent activity and how they reacted to earlier messages, choose the least intrusive delivery that still serves the user. Options are ordered from least to most intrusive.', criteria } } };
}
/** skill.screen: one boolean per marketplace candidate ("fits this project's
 * task types") plus an overall coverage score. Candidates and task types come
 * from host search metadata; JEV cannot add candidates or install anything. */
export const screenCandidateKey = index => `fit_${index}`;
export function skillScreenTemplate({ taskTypes = [], candidates = [] } = {}) {
  const types = taskTypes.filter(type => typeof type === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(type)).slice(0, 6), label = types.length ? types.join(', ') : 'the project described in state.task';
  const questions = {};
  candidates.slice(0, MAX_SCREEN_CANDIDATES).forEach((candidate, index) => { questions[screenCandidateKey(index)] = { type: 'boolean', instructions: `Is marketplace candidate ${index} (state.candidates[${index}]) a reusable method that fits task types: ${label}? Judge only its published name, description, source and compatibility notes.`,
    criteria: { true: `Candidate "${String(candidate?.name ?? candidate?.id ?? index).slice(0, 80)}" directly supports these task types and needs no unavailable credentials or services.`, false: 'The candidate is unrelated, too generic to help, a discovery/meta tool, or depends on credentials or services the project lacks.' } }; });
  if (Object.keys(questions).length) questions.overall_fit = { type: 'score', instructions: `How well would the best of these candidates cover the needs of task types: ${label}?`, criteria: ['None of the candidates is useful.', 'Partial coverage: at least one candidate helps with part of the work.', 'Good coverage: the best candidates clearly fit the main task types.'] };
  return { version: 1, source: 'host-template', template: 'skill.screen', templateVersion: SKILL_SCREEN_TEMPLATE_VERSION, questions };
}
/** candidate.prescore: comparative prior for an evolution candidate. It may
 * only decide whether a candidate is worth evaluating; it never adopts one. */
export function candidatePrescoreTemplate() {
  return { version: 1, source: 'host-template', template: 'candidate.prescore', templateVersion: CANDIDATE_PRESCORE_TEMPLATE_VERSION, questions: {
    candidate_better: { type: 'boolean', instructions: 'Given state.candidate (its hypothesis and changed components) and state.evidence (observed real interaction problems), is the candidate likely to perform better than the current project agent on this kind of work?',
      criteria: { true: 'The change plausibly addresses an observed problem without harming other work.', false: 'The change is unrelated to the observed problems, cosmetic, or likely to regress other work.' } },
    expected_gain: { type: 'score', instructions: 'Expected size of the improvement if the candidate is adopted.', criteria: ['No improvement or a regression.', 'Small improvement.', 'Clear improvement on the observed problems.'] },
  } };
}
function questionsFor(point, plan, known) {
  const entries = plan.source === 'host-template' ? Object.entries(plan.questions) : POINT_QUESTIONS[point].filter(id => Object.hasOwn(plan.questions, id)).map(id => [id, plan.questions[id]]);
  return Object.fromEntries(entries.map(([id, question]) => [id, {
    type: question.type, instructions: secretText(question.instructions, known),
    criteria: Array.isArray(question.criteria) ? question.criteria.map(text => secretText(text, known)) : Object.fromEntries(Object.entries(question.criteria).map(([key, text]) => [key, secretText(text, known)])),
  }]));
}

function parseAnswers(body, questions) {
  if (!record(body) || !record(body.answers)) throw failure('invalid_response');
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = body.answers[id];
    if (!record(raw) || raw.confidence !== undefined && !probability(raw.confidence)) throw failure('invalid_response');
    const answer = { type: question.type, ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}) };
    if (question.type === 'boolean') { if (!probability(raw.noul)) throw failure('invalid_response'); answer.probability = raw.noul; }
    else if (question.type === 'choice') { if (typeof raw.choice !== 'string' || !Object.hasOwn(question.criteria, raw.choice)) throw failure('invalid_response'); answer.choice = raw.choice; }
    else { if (typeof raw.score !== 'number' || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > question.criteria.length - 1) throw failure('invalid_response'); answer.score = raw.score; }
    if (raw.probabilities !== undefined) {
      const expected = question.type === 'choice' ? Object.keys(question.criteria) : question.type === 'score' ? question.criteria.map((_, index) => String(index)) : [];
      if (expected.length) {
        if (!record(raw.probabilities) || Object.keys(raw.probabilities).length !== expected.length || expected.some(key => !probability(raw.probabilities[key])) || Math.abs(expected.reduce((sum, key) => sum + raw.probabilities[key], 0) - 1) > .025) throw failure('invalid_response');
        answer.probabilities = Object.fromEntries(expected.map(key => [key, raw.probabilities[key]]));
        if (answer.choice && answer.probabilities[answer.choice] + .001 < Math.max(...Object.values(answer.probabilities))) throw failure('invalid_response');
      }
    }
    answers[id] = answer;
  }
  const usage = {};
  for (const [wire, name] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens']]) if (Number.isSafeInteger(body.usage?.[wire]) && body.usage[wire] >= 0) usage[name] = body.usage[wire];
  // Warning prose and unknown model metadata can echo submitted content. Keep
  // only a count; a truncation warning means the evidence was incomplete.
  return { answers, usage, warningCount: Array.isArray(body.warnings) ? body.warnings.length : 0 };
}

/** A probability is not a calibrated guarantee. Uncertainty keeps the host's
 * existing path. Scores without confidence are advisory only. */
export function decisionVerdict(answer, policy) {
  if (answer.confidence !== undefined && answer.confidence < policy.confidence) return undefined;
  if (answer.type === 'boolean') return answer.probability >= policy.yes ? true : answer.probability <= policy.no ? false : undefined;
  if (answer.type === 'choice') {
    if (ESCAPES.has(answer.choice)) return undefined;
    if (!answer.probabilities) return undefined;
    const picked = answer.probabilities[answer.choice], runner = Math.max(0, ...Object.entries(answer.probabilities).filter(([id]) => id !== answer.choice).map(([, value]) => value));
    return picked >= policy.confidence && picked - runner >= policy.margin ? answer.choice : undefined;
  }
  return answer.confidence !== undefined && answer.confidence >= policy.confidence ? answer.score : undefined;
}

function endpointURL(value) {
  let url; try { url = new URL(value); } catch { throw failure('invalid_endpoint'); }
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw failure('invalid_endpoint');
  return url.href.replace(/\/$/, '');
}
async function readBody(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw failure('invalid_response');
  const chunks = []; let size = 0;
  try {
    while (true) { signal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 128000) throw failure('response_limit'); chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('invalid_response'); }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

async function boundedCredential(resolve, signal, timeoutMs) {
  let timer, abort;
  const stop = new Promise((_, reject) => {
    abort = () => reject(failure('aborted'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(failure('timeout')), timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(resolve), stop]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

export function createDecisionKernel({ apiKey, endpoint = JEV_ENDPOINT, model = JEV_MODEL, mode = 'shadow', modes = {}, fetch: fetchImpl = globalThis.fetch,
  ledger, knownSecrets = () => [], now = Date.now, timeoutMs, maxCacheEntries = 128, failureThreshold = 3, circuitCooldownMs = 30000,
  backend = 'typesafe', judge, requireCredential = true } = {}) {
  if (!MODES.has(mode) || Object.values(modes).some(value => !MODES.has(value))) throw failure('invalid_mode');
  // A judge function replaces only the transport; answers pass the same
  // parser, thresholds, cache, circuit breaker and content-free ledger.
  if (!DECISION_BACKENDS.includes(backend) || judge !== undefined && typeof judge !== 'function' || backend === 'llm' && !judge) throw failure('invalid_backend');
  if (typeof model !== 'string' || !/^[\w./~-]{1,100}$/.test(model)) throw failure('invalid_model');
  const url = endpointURL(endpoint), salt = randomBytes(32), cache = new Map(), inflight = new Map(), lifecycle = new AbortController();
  const hash = value => createHmac('sha256', salt).update(canonicalJSON(value)).digest('hex');
  const cacheLimit = Number.isSafeInteger(maxCacheEntries) ? clamp(maxCacheEntries, 0, 512) : 128;
  const threshold = Number.isSafeInteger(failureThreshold) ? clamp(failureThreshold, 1, 10) : 3;
  const cooldown = Number.isFinite(circuitCooldownMs) ? clamp(circuitCooldownMs, 1000, 300000) : 30000;
  let failures = 0, openUntil = 0, closed = false, credentialDigest = null;
  const stats = { requests: 0, cacheHits: 0, coalesced: 0, fallbacks: 0, failures: 0, inputTokens: 0, outputTokens: 0 };

  async function transport(state, questions, key, duration, controller, onAttempt) {
    let timer, aborted, timedOut = false;
    const timeLimit = new Promise((_, reject) => {
      aborted = () => reject(failure(timedOut ? 'timeout' : 'aborted'));
      controller.signal.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, duration);
    });
    // 429/529: exponential backoff inside this call's budget (honoring a short
    // retry-after), then the circuit breaker takes over.
    const deadline = performance.now() + duration;
    const backoff = async (attempt, retryAfter) => {
      const wait = Math.min(Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : BACKOFF_BASE_MS * 2 ** attempt * (1 + Math.random() * .25), 4000);
      if (attempt >= BACKOFF_ATTEMPTS || performance.now() + wait + 50 >= deadline) return false;
      await new Promise(resolve => { const timer = setTimeout(resolve, wait); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      return !controller.signal.aborted;
    };
    const run = (async () => {
      if (judge) {
        for (let attempt = 0; ; attempt++) {
          let body; onAttempt();
          try { body = await judge({ state, questions: structuredClone(questions), signal: controller.signal }); }
          catch (error) {
            if (!controller.signal.aborted && [429, 529].includes(error?.status) && await backoff(attempt)) continue;
            throw failure(controller.signal.aborted ? 'aborted' : error?.code === 'invalid_response' ? 'invalid_response' : [401, 403].includes(error?.status) ? 'auth' : error?.status === 429 ? 'rate_limited' : error?.status === 529 ? 'overloaded' : 'unreachable');
          }
          return parseAnswers(body, questions);
        }
      }
      const payload = JSON.stringify({ model, state, questions: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, { ...question, type: question.type === 'boolean' ? 'noul' : question.type }])) });
      for (let attempt = 0; ; attempt++) {
        let response;
        try { onAttempt(); response = await fetchImpl(url, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: payload, signal: controller.signal }); }
        catch { throw failure(controller.signal.aborted ? 'aborted' : 'unreachable'); }
        if (!response.ok) {
          try { await response.body?.cancel(); } catch {}
          if ([429, 529].includes(response.status) && await backoff(attempt, Number(response.headers?.get?.('retry-after') ?? NaN))) continue;
          throw failure(response.status === 401 || response.status === 403 ? 'auth' : response.status === 402 ? 'payment_required' : response.status === 429 ? 'rate_limited' : response.status === 529 ? 'overloaded' : response.status >= 500 ? 'server' : response.status >= 300 && response.status < 400 ? 'redirect_rejected' : 'bad_request');
        }
        return parseAnswers(await readBody(response, controller.signal), questions);
      }
    })();
    try { return await Promise.race([run, timeLimit]); } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', aborted); }
  }

  async function acquire(key, state, questions, credential, policy, signal, duration) {
    const existing = cache.get(key);
    if (existing && existing.until > now()) { stats.cacheHits++; return { ...structuredClone(existing.value), cached: true, usage: {} }; }
    if (existing) cache.delete(key);
    let call = inflight.get(key), joined = !!call;
    if (!call) {
      const controller = new AbortController(); call = { controller, waiters: 0, networkAttempted: false };
      const generation = credentialDigest;
      call.promise = transport(state, questions, credential, duration, controller, () => { call.networkAttempted = true; stats.requests++; })
        .then(value => {
          if (generation === credentialDigest && !closed && !controller.signal.aborted) { failures = 0; openUntil = 0; }
          for (const field of ['inputTokens', 'outputTokens']) stats[field] += value.usage?.[field] ?? 0;
          if (!closed && !controller.signal.aborted && cacheLimit && policy.ttlMs > 0 && !value.warningCount) {
            cache.set(key, { until: now() + policy.ttlMs, value: structuredClone(value) });
            while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
          }
          return value;
        }, error => {
          if (error.code !== 'aborted') { stats.failures++; if (generation === credentialDigest && !closed) { failures++; if (failures >= threshold || ['auth', 'payment_required', 'rate_limited', 'overloaded'].includes(error.code)) openUntil = now() + cooldown; } }
          return { error: error.code ?? 'provider_failure' };
        }).finally(() => { if (inflight.get(key) === call) inflight.delete(key); });
      inflight.set(key, call);
    } else stats.coalesced++;
    call.waiters++;
    let abort;
    const cancellation = new Promise(resolve => { abort = () => resolve({ error: 'aborted' }); if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); });
    try {
      const value = await Promise.race([call.promise, cancellation]);
      const accounted = !value.error && !call.accounted;
      if (accounted) call.accounted = true;
      return { ...structuredClone(value), usage: accounted ? value.usage ?? {} : {}, networkAttempted: !joined && call.networkAttempted, ...(joined ? { coalesced: true } : {}) };
    }
    finally { signal?.removeEventListener('abort', abort); call.waiters--; if (!call.waiters && inflight.get(key) === call) { call.controller.abort(); inflight.delete(key); } }
  }

  async function decide({ point, scope = {}, state = {}, signals = {}, fallback, assessmentPlan, supplement, signal } = {}) {
    if (!POINTS.has(point)) throw failure('invalid_point');
    if (fallback === undefined) fallback = point === 'chat.route' ? { reasoning: 'default', needsMemory: true } : point === 'chat.preflight' ? { needsMemory: true } : { review: true };
    const startedAt = now(), monotonicStart = performance.now(), selectedMode = modes[point] ?? mode, policy = deriveDecisionPolicy(point, signals), ledgerId = randomUUID();
    const budgetMs = Number.isFinite(timeoutMs) ? clamp(timeoutMs, 50, 30000) : policy.timeoutMs;
    signal = signal ? AbortSignal.any([lifecycle.signal, signal]) : lifecycle.signal;
    let reason, evaluation = {}, judged, stateDigest, planRevision, supplementRevision;
    if (closed) reason = 'closed';
    else if (signal?.aborted) reason = 'aborted';
    else if (selectedMode === 'off') reason = 'off';
    else if (!UNGATED.has(point) && signals.explicitRequest === true) reason = 'explicit_request';
    else if (!UNGATED.has(point) && (signals.dueSchedule === true || signals.severeFailure === true || signals.deliveryJustCompleted === true || signals.unansweredQuestion === true)) reason = 'main_review_required';
    else if (assessmentPlan === undefined || assessmentPlan === null) reason = 'assessment_plan_required';
    else {
      try {
        const template = assessmentPlan?.source === 'host-template';
        if (template ? !TEMPLATE_POINTS.has(point) : !Object.hasOwn(POINT_QUESTIONS, point)) throw failure('assessment_point_unconfigured');
        const plan = template ? validateHostTemplatePlan(assessmentPlan) : validateDecisionAssessmentPlan(assessmentPlan);
        planRevision = template ? hostTemplateHash(plan) : decisionAssessmentPlanHash(plan);
        if (template ? plan.template !== point : !POINT_QUESTIONS[point].some(id => Object.hasOwn(plan.questions, id))) throw failure('assessment_point_unconfigured');
        // Host atomic questions ride in the same request as a main-model plan.
        const extra = supplement == null ? null : !template && SUPPLEMENT_POINTS.has(point) ? validateHostTemplatePlan(supplement) : (() => { throw failure('assessment_point_unconfigured'); })();
        if (extra && (extra.template !== point || Object.keys(extra.questions).some(id => Object.hasOwn(plan.questions, id)))) throw failure('assessment_point_unconfigured');
        if (extra) supplementRevision = hostTemplateHash(extra);
        // Spec templates are interpreted by host stake thresholds (decision-templates.mjs).
        const staked = template && specTemplate(plan) || Boolean(extra);
        const key = typeof apiKey === 'function' ? await boundedCredential(apiKey, signal, budgetMs) : apiKey;
        if (!key && requireCredential) reason = 'unconfigured';
        else if (key != null && typeof key !== 'string' || typeof key === 'string' && key.length > 8192 || /[\r\n\0]/.test(key)) reason = 'invalid_credentials';
        else {
          const currentCredential = hash(key ?? '');
          if (credentialDigest !== null && credentialDigest !== currentCredential) { cache.clear(); failures = 0; openUntil = 0; }
          credentialDigest = currentCredential;
          const known = [key ?? '', ...knownSecrets()], minimized = minimizeDecisionState(state, { maxChars: policy.maxStateChars, knownSecrets: known }), questions = { ...questionsFor(point, plan, known), ...(extra ? questionsFor(point, extra, known) : {}) };
          // Numeric routing signals only accompany legacy plans; spec templates read code-computed buckets.
          if (!staked) minimized.routingSignals = { ...policy.rationale, duplicateEvidence: signals.duplicateEvidence === true, hasPendingWork: signals.hasPendingWork === true };
          stateDigest = hash(minimized);
          const cacheKey = hash({ point, scope, ...(typeof scope.projectId !== 'string' || !scope.projectId ? { unscoped: randomUUID() } : {}), state: minimized, questions, planRevision, supplementRevision, policy, credential: currentCredential, version: DECISION_KERNEL_VERSION });
          if (signal?.aborted) reason = 'aborted';
          else if (!UNGATED.has(point) && signals.duplicateEvidence === true && signals.hasPendingWork !== true) reason = 'duplicate_evidence';
          else if (openUntil > now()) reason = 'circuit_open';
          else {
            const remaining = budgetMs - (performance.now() - monotonicStart);
            evaluation = remaining <= 0 ? { error: 'timeout' } : await acquire(cacheKey, minimized, questions, key ?? '', policy, signal, remaining);
            if (evaluation.error) reason = evaluation.error;
            else if (evaluation.warningCount) reason = 'provider_warning';
            else {
              // All prose and candidate options predate this request. JEV only
              // assigns numbers or chooses one of those options. No routing,
              // reasoning level, schedule, next step or candidate acceptance
              // is generated here. Hosts must interpret each bounded answer
              // against the independently attested main-model plan.
              if (staked || Object.values(evaluation.answers).some(answer => decisionVerdict(answer, policy) !== undefined)) judged = { planRevision, assessments: structuredClone(evaluation.answers) };
              else reason = 'abstain';
            }
          }
        }
      } catch (error) { reason = ['timeout', 'aborted', 'invalid_assessment_plan', 'assessment_point_unconfigured'].includes(error?.code) ? error.code : 'invalid_request'; }
    }
    // Caller cancellation must win over a late successful provider reply.
    if (signal?.aborted || closed) { judged = undefined; reason = closed ? 'closed' : 'aborted'; }
    const useJudged = selectedMode === 'active' && judged !== undefined;
    if (!useJudged) stats.fallbacks++;
    const result = { point, backend, mode: selectedMode, source: useJudged ? 'judge' : 'fallback', outcome: structuredClone(useJudged ? judged : fallback), ...(judged !== undefined ? { judged: structuredClone(judged) } : {}), ...(planRevision ? { planRevision } : {}), ...(supplementRevision ? { supplementRevision } : {}), reason: useJudged ? reason ?? 'accepted' : reason ?? 'shadow', policy, ledgerId,
      ...(evaluation.answers ? { answers: evaluation.answers } : {}), usage: evaluation.usage ?? {}, latencyMs: Math.max(0, now() - startedAt), networkAttempted: evaluation.networkAttempted === true, cached: evaluation.cached === true, coalesced: evaluation.coalesced === true };
    const audit = { version: DECISION_KERNEL_VERSION, id: ledgerId, at: now(), point, backend, mode: selectedMode, source: result.source, reason: result.reason, ...(planRevision ? { planRevision } : {}), scopeDigest: hash(scope), stateDigest: stateDigest ?? null, policy, latencyMs: result.latencyMs, usage: result.usage, networkAttempted: result.networkAttempted, cached: result.cached, coalesced: result.coalesced,
      ...(evaluation.answers ? { answers: Object.fromEntries(Object.entries(evaluation.answers).map(([id, answer]) => [id, { ...answer }])) } : {}) };
    // No state, answer prose, error body, credential, or arbitrary custom
    // outcome in the ledger. Broken observability cannot block the agent.
    try { Promise.resolve(ledger?.(structuredClone(audit))).catch(() => {}); } catch {}
    return result;
  }
  return { decide, stats: () => ({ ...stats, circuitOpen: openUntil > now(), circuitOpenUntil: openUntil, cacheEntries: cache.size, inflight: inflight.size }),
    clear: () => { cache.clear(); failures = 0; openUntil = 0; },
    close: () => { closed = true; lifecycle.abort(); cache.clear(); for (const call of inflight.values()) call.controller.abort(); inflight.clear(); },
  };
}
