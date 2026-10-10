import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { rrsiConfig, projectComponentRegistry, diffProjectComponents, tagCandidateEdits, summarizeRrsiHistory, rrsiAuthorDirectives, rrsiCriticPrecheck, calibrateRrsiNoiseBand, rrsiSelect, rrsiBlendedScore, rrsiChangelogEntry, rrsiSmokeCaseIds,
  RRSI_COMPONENT_LABELS, RRSI_COMPONENTS, systemPromptSections } from '../../packages/sdk/src/project-rrsi.mjs';
import { projectGenomeHash } from '../../packages/sdk/src/project-genome.mjs';
import { ProjectGenomeGit } from './project-genome-git.mjs';
import { ProjectGenomeStore } from './project-genome-store.mjs';
import { classifyEvolutionFailure } from './project-evolution-failures.mjs';
import { collectProjectSignals, replayEvaluationCase } from './project-interaction-signals.mjs';
import { ledgerRows, rowLabelSource } from './decision-ledger.mjs';

// P4 host side of RRSI. Per-project evolution history lives under the existing
// checkpointed `.evolution` sidecar (`<projectId>/rrsi/`), one JSONL record per
// edit; the genome git mirror is `<projectId>/rrsi/genome`. Nothing here adopts
// a version: trial/adopt/rollback stay explicit user operations. System-level
// (cross-project) proposals are data + a manual path; auto-adoption is off.

const copy = value => structuredClone(value), nowISO = () => new Date().toISOString();
const clip = (value, max) => String(value ?? '').slice(0, max);
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
export const SYSTEM_EVOLUTION = Object.freeze({ autoAdopt: false });
// Shared (system-level) components evolved from cross-project signals.
export const SYSTEM_COMPONENTS = Object.freeze(['core_prompt_section', 'core_tool_description', 'jev_template', 'communication_rule']);

const changedText = (baseline, candidate) => {
  // Text a candidate ADDS to the model-facing agent: new/changed system
  // sections, authored skill bodies and tool descriptions (source packages are
  // immutable third-party bytes and never scanned as authored text).
  const old = new Map(systemPromptSections(baseline?.systemPrompt).map(row => [row.id, row.hash])), parts = [];
  for (const section of systemPromptSections(candidate?.systemPrompt)) if (old.get(section.id) !== section.hash) parts.push(section.content);
  for (const skill of candidate?.skills ?? []) { if (skill.source) continue; const prior = baseline?.skills?.find(row => row.id === skill.id); if (!prior || prior.instructions !== skill.instructions || prior.description !== skill.description) parts.push(skill.description, skill.instructions, ...(skill.resources ?? []).map(row => row.content ?? '')); }
  for (const tool of candidate?.tools ?? []) { const prior = baseline?.tools?.find(row => row.id === tool.id); if (!prior || prior.description !== tool.description) parts.push(tool.description); }
  return parts.join('\n');
};
const changedAreas = edits => [...new Set(edits.map(row => ({ system_section: 'prompt', skill: 'skills', tool_description: 'tools', evaluation_standard: 'evaluation', mcp_assignment: 'mcp', rhythm: 'rhythm', communication_style: 'communication' })[row.component]).filter(Boolean))];

export class ProjectEvolutionRrsi {
  constructor(store, { root = resolve(`${store.file}.evolution`), config = {}, genomeGit, signals = collectProjectSignals, now = Date.now } = {}) {
    this.store = store; this.root = root; this.config = rrsiConfig({ ...(store.state.configuration?.evolutionRrsi ?? {}), ...config }); this.signals = signals; this.now = now; this.writes = new Map();
    this.git = genomeGit === undefined ? new ProjectGenomeGit(store, { root: this.root }) : genomeGit;
  }
  dir(projectId) { if (!safeId(projectId)) throw Object.assign(new Error('invalid project id'), { code: 'rrsi_project' }); return join(this.root, projectId, 'rrsi'); }
  serial(projectId, work) { const previous = this.writes.get(projectId) ?? Promise.resolve(), next = previous.catch(() => {}).then(work); this.writes.set(projectId, next); return next.finally(() => { if (this.writes.get(projectId) === next) this.writes.delete(projectId); }); }
  async records(projectId) {
    let text; try { text = await readFile(join(this.dir(projectId), 'history.jsonl'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    // Read-time redaction: once a version's source session is deleted, its authored hypothesis is no longer shown or reused.
    const revoked = new Set((this.store.state.projects.find(row => row.id === projectId)?.versions ?? []).filter(row => row.sourceDeleted || row.contextRevoked).map(row => row.id));
    return text.split('\n').slice(-20000).filter(Boolean).flatMap(line => { try { const row = JSON.parse(line); return [revoked.has(row.versionId) ? { ...row, hypothesis: '[来源已删除]', detail: undefined, sourceDeleted: true } : row]; } catch { return []; } });
  }
  async frontier(projectId) {
    try { return JSON.parse(await readFile(join(this.dir(projectId), 'frontier.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return { schemaVersion: 1, round: 0, trajectory: [], sStar: null, baselineScores: {}, caseScores: {} }; throw error; }
  }
  async saveFrontier(projectId, value) { const dir = this.dir(projectId), path = join(dir, 'frontier.json'); await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(`${path}.tmp`, path); }
  async append(projectId, rows) { if (!rows.length) return; const dir = this.dir(projectId); await mkdir(dir, { recursive: true, mode: 0o700 }); await appendFile(join(dir, 'history.jsonl'), rows.map(row => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 }); }
  /** δ for the current baseline: repeated baseline evaluations first, else case bootstrap. */
  calibration(frontier, baselineHash) { return calibrateRrsiNoiseBand({ baselineScores: frontier.baselineScores?.[baselineHash] ?? [], caseScores: frontier.caseScores?.[baselineHash] ?? [], z: this.config.deltaZ, minDelta: this.config.minDelta }); }
  /** Proposer context: budget b_t, history, falsified hypotheses, exploration, prune set. */
  async directives(projectId, { baselineHash } = {}) {
    const [records, frontier] = await Promise.all([this.records(projectId), this.frontier(projectId)]), calibration = this.calibration(frontier, baselineHash);
    return { ...rrsiAuthorDirectives({ records, trajectory: frontier.trajectory ?? [], t: frontier.round ?? 0, config: this.config, delta: calibration.delta }), calibration };
  }
  edits({ baseline, candidate, project, proposal }) {
    const edits = diffProjectComponents(projectComponentRegistry({ genome: baseline, project }), projectComponentRegistry({ genome: candidate, project }));
    return tagCandidateEdits({ edits, hypothesis: proposal?.hypothesis ?? proposal?.summary ?? '', changes: proposal?.changes ?? [] });
  }
  /** Deterministic critic layer (the SDK loop grants one bounded repair). */
  critic({ baseline, candidate, project, proposal, directives, context } = {}) {
    const edits = this.edits({ baseline, candidate, project, proposal });
    // Enforce only hypotheses falsified against the same incumbent and model (Rna adaptation of RRSI history).
    const falsified = (directives?.falsified ?? []).filter(row => !context || row.context && row.context.model === context.model && row.context.baseline === context.baseline);
    return { ...rrsiCriticPrecheck({ edits, addedText: changedText(baseline, candidate), evaluationSuite: baseline?.evaluationSuite, budget: directives?.budget ?? Infinity, falsified, exploration: directives?.exploration }), edits };
  }
  smokeCaseIds(suite, replayIds = []) { return rrsiSmokeCaseIds(suite, { preferred: replayIds, n: this.config.smokeCases }); }
  changedAreas(edits) { return changedAreas(edits); }
  /** Real interaction signals + replay cases for a project (computed live; nothing persisted). */
  async realSignals(projectId) { try { return await this.signals(this.store, projectId); } catch { return { projectId, signals: [], replay: [], counts: {}, score: { score: null, signals: 0 }, heldOut: 0 }; } }
  /** Algorithm-2 decision for a measured candidate plus the blended real/JEV score. */
  async select(projectId, { baselineHash, evaluation, edits = [], prescore, replayCaseIds = [] } = {}) {
    const [records, frontier] = await Promise.all([this.records(projectId), this.frontier(projectId)]), calibration = this.calibration(frontier, baselineHash);
    const tokens = side => (evaluation?.details ?? []).reduce((sum, row) => sum + (row[side]?.usage?.totalTokens ?? 0), 0);
    const realRows = (evaluation?.details ?? []).filter(row => replayCaseIds.includes(row.id)), real = realRows.length ? realRows.reduce((sum, row) => sum + row.candidateScore * (row.weight ?? 1), 0) / realRows.reduce((sum, row) => sum + (row.weight ?? 1), 0) : null;
    const jev = finite(prescore?.probability) ?? (typeof prescore?.better === 'boolean' ? (prescore.better ? 0.75 : 0.25) : null);
    const blend = rrsiBlendedScore({ real, jev, realCases: realRows.length, config: this.config });
    const counts = Object.fromEntries(Object.entries(summarizeRrsiHistory(records).accepted).map(([key, rows]) => [key, rows.length]));
    const decision = rrsiSelect({ candidate: { S: finite(evaluation?.candidateScore), C: tokens('candidate') || null, components: edits.map(row => row.component) }, incumbent: { S: finite(evaluation?.baselineScore), C: tokens('baseline') || null }, sStar: finite(frontier.sStar) ?? undefined, delta: calibration.delta, config: this.config, incumbentCounts: counts });
    // Enforced only once δ is measured; until then the frozen-suite gates decide
    // and RRSI is advisory. JEV never adopts alone: without sufficient real
    // signal the blend is absent and the paired evaluation stands.
    return { ...decision, enforced: calibration.measured, calibration, blended: blend, realCases: realRows.length };
  }
  /** Append per-edit records for one evolution outcome and advance the frontier. */
  recordOutcome(projectId, { version, baseline, candidate, project, proposal, evaluation, verdict, selection, tiers, prescore, detail, edits: explicitEdits, context } = {}) {
    return this.serial(projectId, async () => {
      const frontier = await this.frontier(projectId), t = frontier.round ?? 0, at = nowISO(), baselineHash = baseline ? projectGenomeHash(baseline) : null;
      const edits = Array.isArray(explicitEdits) ? explicitEdits : candidate && baseline ? this.edits({ baseline, candidate, project, proposal }) : [];
      const measured = finite(evaluation?.candidateScore) !== null && finite(evaluation?.baselineScore) !== null;
      const deltaS = measured ? evaluation.candidateScore - evaluation.baselineScore : null;
      const tokens = side => (evaluation?.details ?? []).reduce((sum, row) => sum + (row[side]?.usage?.totalTokens ?? 0), 0), deltaC = measured && tokens('baseline') > 0 ? (tokens('candidate') - tokens('baseline')) / tokens('baseline') : null;
      const common = { t, at, versionId: version?.id ?? null, verdict, ...(context ? { context: { model: context.model ?? null, baseline: context.baseline ?? null } } : {}), ...(measured ? { S: evaluation.candidateScore, baselineS: evaluation.baselineScore } : {}), deltaS, deltaC, bundle: edits.length, ...(tiers ? { tiers: copy(tiers) } : {}), ...(selection ? { selection: { admissible: selection.admissible, enforced: selection.enforced, reason: clip(selection.reason, 300), delta: selection.calibration?.delta ?? null, blended: selection.blended?.score ?? null } } : {}), ...(prescore ? { prescore: { source: prescore.source, better: prescore.better ?? null } } : {}), ...(detail ? { detail: clip(detail, 600) } : {}) };
      await this.append(projectId, edits.length ? edits.map(edit => ({ ...common, ...edit })) : [{ ...common, editId: null, component: null }]);
      if (baselineHash && measured) {
        (frontier.baselineScores ??= {})[baselineHash] = [...(frontier.baselineScores[baselineHash] ?? []), evaluation.baselineScore].slice(-12);
        (frontier.caseScores ??= {})[baselineHash] = (evaluation.details ?? []).map(row => row.baselineScore).filter(value => finite(value) !== null).slice(0, 24);
      }
      if (measured || ['critic_rejected', 'smoke_failed', 'prescreen_skipped'].includes(verdict)) { frontier.round = t + 1; frontier.trajectory = [...(frontier.trajectory ?? []), finite(frontier.sStar) ?? finite(evaluation?.baselineScore)].filter(value => value !== null).slice(-64); }
      if (measured && verdict === 'accepted') frontier.sStar = Math.max(finite(frontier.sStar) ?? -Infinity, evaluation.candidateScore);
      else if (measured && finite(frontier.sStar) === null) frontier.sStar = evaluation.baselineScore;
      await this.saveFrontier(projectId, frontier);
      return { t, edits, deltaS, deltaC };
    });
  }
  /** Failure (author/infra/eval) is recorded unmeasured; it never falsifies a hypothesis. */
  recordFailure(projectId, { version, baseline, candidate, project, proposal, context } = {}) {
    const classification = classifyEvolutionFailure(version), verdict = version?.error?.code === 'critic_rejected' ? 'critic_rejected' : `${classification.class}_failed`;
    return this.recordOutcome(projectId, { version, baseline, candidate, project, proposal, verdict, detail: `${classification.cause}`, context });
  }
  /** Trial adopt/rollback turns a candidate's edits into real verdicts (the strongest signal). */
  recordVersionControl(projectId, versionId, action) {
    if (!['adopt', 'rollback'].includes(action)) return Promise.resolve(null);
    return this.serial(projectId, async () => {
      const records = await this.records(projectId), mine = records.filter(row => row.versionId === versionId && row.editId && !['trial_adopted', 'trial_rolled_back'].includes(row.verdict));
      const latest = mine.length ? mine.filter(row => row.t === mine.at(-1).t) : [];
      const verdict = action === 'adopt' ? 'trial_adopted' : 'trial_rolled_back', frontier = await this.frontier(projectId), at = nowISO();
      const signal = await this.realSignals(projectId).then(row => row.score).catch(() => null);
      await this.append(projectId, latest.map(row => ({ ...row, t: frontier.round ?? row.t, at, verdict, realSignal: signal?.score ?? null, detail: action === 'adopt' ? 'user adopted after trial' : 'user rolled back' })));
      return { recorded: latest.length, verdict };
    });
  }
  /** Host hook after POST .../versions/:id/control: real verdicts + git adopt (ff) / rollback (revert). */
  async onVersionControl(projectId, versionId, action, { genomes = new ProjectGenomeStore(this.store) } = {}) {
    const recorded = await this.recordVersionControl(projectId, versionId, action).catch(() => null);
    if (!this.git || !['adopt', 'rollback'].includes(action)) return { recorded, git: null };
    const project = this.store.state.projects.find(row => row.id === projectId), read = async id => { try { return (await genomes.read(projectId, id)).genome; } catch { return null; } };
    let git = null;
    try { git = action === 'adopt' ? await this.git.adopt(projectId, versionId, { genome: await read(versionId), project }) : await this.git.rollback(projectId, versionId, { genome: await read(project?.activeVersionId), project, versionId: project?.activeVersionId }); }
    catch { git = null; }
    return { recorded, git };
  }
  /** "Rna 学到了…" changelog for the versions view. */
  async changelog(projectId, { limit = 50 } = {}) {
    const records = await this.records(projectId), rows = records.filter(row => row.editId && ['accepted', 'trial_adopted', 'trial_rolled_back', 'rejected'].includes(row.verdict));
    const seen = new Set(), out = [];
    for (const row of rows.reverse()) { const key = `${row.versionId}:${row.key}:${row.verdict}`; if (seen.has(key)) continue; seen.add(key); out.push({ ...rrsiChangelogEntry(row), label: RRSI_COMPONENT_LABELS[row.component] ?? row.component }); if (out.length >= Math.max(1, Math.min(200, limit))) break; }
    return out;
  }
  /** Component registry of the active genome with per-component history and git log. */
  async components(projectId, { genome, key } = {}) {
    const project = this.store.state.projects.find(row => row.id === projectId), registry = projectComponentRegistry({ genome, project }), records = await this.records(projectId), summary = summarizeRrsiHistory(records, { t: (await this.frontier(projectId)).round ?? 0, nPrune: this.config.nPrune });
    const rows = registry.filter(row => !key || row.key === key).map(row => { const history = records.filter(item => item.key === row.key).slice(-30).map(item => ({ t: item.t, at: item.at, versionId: item.versionId, verdict: item.verdict, hypothesis: clip(item.hypothesis, 240), deltaS: item.deltaS ?? null, change: item.change })); return { ...row, label: row.label || row.id, componentLabel: RRSI_COMPONENT_LABELS[row.component], attempts: history.length, accepted: history.filter(item => ['accepted', 'trial_adopted'].includes(item.verdict)).length, lastVerdict: history.at(-1)?.verdict ?? null, pruneCandidate: summary.pruneSet.some(item => item.key === row.key), history }; });
    const git = key && this.git ? await this.git.log(projectId, { key, limit: 30 }).catch(() => []) : undefined;
    return { projectId, components: rows, tried: summary.tried, untried: summary.untried, falsified: summary.falsified.slice(-24), pruneSet: summary.pruneSet, ...(git ? { git } : {}) };
  }
  /** Evaluation-standard edit proposal: evolve-split replay cases (held-out never enter selection). */
  async replayStandardProposal(projectId, { genome } = {}) {
    const signals = await this.realSignals(projectId), toolIds = (genome?.tools ?? []).map(row => row.id), existing = new Set((genome?.evaluationSuite?.cases ?? []).map(row => row.id));
    const cases = signals.replay.map(row => replayEvaluationCase(row, { toolIds })).filter(row => row && !existing.has(row.id));
    const room = Math.max(0, 12 - existing.size);
    return { projectId, component: 'evaluation_standard', hypothesis: '用真实交互中出现的问题作为回放用例，评测更贴近实际工作。', cases: cases.slice(0, room), heldOut: signals.replay.filter(row => row.split === 'heldout').map(row => ({ id: row.id, kind: row.kind })), capacity: room, adoption: 'reviewed_evaluation_revision_required' };
  }
}

/** Cross-project aggregate for shared components (core prompt sections, tool
 * descriptions, JEV templates, communication rules). Data plumbing only. */
export async function systemEvolutionAggregate(store, { signals = collectProjectSignals } = {}) {
  const projects = store.state.projects.filter(row => !row.archivedAt && row.simulated === false), perProject = [];
  for (const project of projects) { try { perProject.push(await signals(store, project.id)); } catch { /* one project cannot block the aggregate */ } }
  const toolFailures = {}, toolFailureCauses = {}, lastCall = {}, proactive = { replied: 0, acted: 0, dismissed: 0 }, kinds = {};
  for (const row of perProject) for (const signal of row.signals) {
    kinds[signal.kind] = (kinds[signal.kind] ?? 0) + 1;
    if (signal.kind === 'tool_failure') {
      toolFailures[signal.detail.tool] = (toolFailures[signal.detail.tool] ?? 0) + 1;
      // call: the model's use of the tool; environment, refused, interrupted are not the description's doing.
      const row = toolFailureCauses[signal.detail.tool] ??= { call: 0, environment: 0, refused: 0, interrupted: 0, lastAt: null }, cause = signal.detail.cause ?? 'call';
      row[cause] = (row[cause] ?? 0) + 1;
      if (typeof signal.at === 'string') { if (!row.lastAt || signal.at > row.lastAt) row.lastAt = signal.at; if (cause === 'call' && !(lastCall[signal.detail.tool] >= signal.at)) lastCall[signal.detail.tool] = signal.at; }
    }
    if (signal.kind === 'proactive_outcome') proactive[signal.detail.label] = (proactive[signal.detail.label] ?? 0) + 1;
  }
  // Real labels only (PDL-7, cross-batch constraint 3): a self label — the model's own next step — is no evidence to
  // calibrate a template on, so it never makes a jev_template target.
  const ledger = ledgerRows(store).reduce((out, row) => { const point = out[row.point] ??= { decisions: 0, judged: 0, labeled: 0 }; point.decisions++; if (row.source === 'judge') point.judged++; if (row.label && rowLabelSource(row) !== 'self') point.labeled++; return out; }, {});
  const targets = [
    ...Object.entries(toolFailureCauses).map(([tool, row]) => [tool, row.call, lastCall[tool]]).filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tool, count, lastAt]) => ({ component: 'core_tool_description', key: `core_tool_description:${tool}`, evidence: { failures: count, projects: perProject.filter(row => row.signals.some(signal => signal.kind === 'tool_failure' && signal.detail.tool === tool && (signal.detail.cause ?? 'call') === 'call')).length, ...(lastAt ? { lastAt } : {}) }, hypothesis: `工具「${tool}」的描述未能让模型正确调用；更清晰的参数与失败处理说明会减少失败。` })),
    ...(proactive.dismissed >= 3 && proactive.dismissed > proactive.replied + proactive.acted ? [{ component: 'communication_rule', key: 'communication_rule:proactive', evidence: proactive, hypothesis: '主动消息被忽略多于被回复/采纳；收紧投递门槛并先给结论会提高有用率。' }] : []),
    ...((kinds.user_correction ?? 0) >= 3 ? [{ component: 'core_prompt_section', key: 'core_prompt_section:task-interpretation', evidence: { corrections: kinds.user_correction, projects: perProject.filter(row => row.counts.user_correction).length }, hypothesis: '多个项目中用户纠正频繁；核心提示词中的任务理解段落需要要求先确认关键约束。' }] : []),
    ...Object.entries(ledger).filter(([, row]) => row.labeled >= 5).map(([point, row]) => ({ component: 'jev_template', key: `jev_template:${point}`, evidence: row, hypothesis: `JEV 模板「${point}」已有 ${row.labeled} 个真实标签，可据此校准阈值或选项。` })),
  ];
  return { generatedAt: nowISO(), autoAdopt: SYSTEM_EVOLUTION.autoAdopt, components: SYSTEM_COMPONENTS, projects: perProject.map(row => ({ projectId: row.projectId, counts: row.counts, score: row.score, replayCases: row.replay.length, heldOut: row.heldOut })), signalKinds: kinds, toolFailures, toolFailureCauses, proactive, jevLedger: ledger, targets };
}
/** Manual/CLI-triggered system-level proposal. Written for review; never applied. */
export async function proposeSystemEvolution(store, { component, key, note } = {}, { aggregate = systemEvolutionAggregate } = {}) {
  const data = await aggregate(store), target = data.targets.find(row => (!key || row.key === key) && (!component || row.component === component));
  if (component && !SYSTEM_COMPONENTS.includes(component)) throw Object.assign(new Error('未知的系统组件。'), { status: 400, code: 'system_component_invalid' });
  const id = `sys-${Date.now().toString(36)}`, dir = resolve(`${store.file}.evolution`, '_system');
  const proposal = { schemaVersion: 1, id, createdAt: nowISO(), status: 'proposed', autoAdopt: false, adoption: 'manual_review_required', target: target ?? null, note: clip(note, 1000), evidence: { signalKinds: data.signalKinds, projects: data.projects.length } };
  await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(join(dir, `${id}.json`), `${JSON.stringify(proposal, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return proposal;
}
/** Automatic record of every target the aggregate currently finds, for the
 * developers who change shared components. One file per target key: created
 * the first time it appears, its evidence refreshed when it grows. Records are
 * never applied and never shown in the app. */
export async function recordSystemTargets(store, { aggregate = systemEvolutionAggregate } = {}) {
  const data = await aggregate(store), dir = resolve(`${store.file}.evolution`, '_system');
  if (!data.targets.length) return { created: 0, updated: 0 };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let created = 0, updated = 0;
  for (const target of data.targets) {
    const file = join(dir, `sys-auto-${createHash('sha256').update(target.key).digest('hex').slice(0, 16)}.json`);
    let existing = null; try { existing = JSON.parse(await readFile(file, 'utf8')); } catch {}
    const evidence = { signalKinds: data.signalKinds, projects: data.projects.length, target: target.evidence ?? null };
    if (existing && JSON.stringify(existing.target?.evidence ?? null) === JSON.stringify(target.evidence ?? null)) continue;
    const at = nowISO();
    const record = { schemaVersion: 1, id: existing?.id ?? `sys-auto-${createHash('sha256').update(target.key).digest('hex').slice(0, 16)}`, source: 'automatic', createdAt: existing?.createdAt ?? at, updatedAt: at, observations: (existing?.observations ?? 0) + 1,
      // A problem that keeps growing after it was addressed is reopened: the fix did not hold.
      status: existing?.status === 'addressed' ? 'proposed' : existing?.status ?? 'proposed', ...(existing?.status === 'addressed' ? { reopenedAt: at, previousResolution: existing.resolution ?? null } : existing?.reopenedAt ? { reopenedAt: existing.reopenedAt } : {}),
      ...(existing?.resolution && existing.status !== 'addressed' ? { resolution: existing.resolution } : {}), autoAdopt: false, adoption: 'manual_review_required', target, note: existing?.note ?? '', evidence };
    const temporary = `${file}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, file);
    if (existing) updated++; else created++;
  }
  return { created, updated };
}
/** Developer resolution of a record: addressed (a change shipped) or rejected (not a real problem). */
export async function resolveSystemProposal(store, id, { status, note } = {}) {
  if (typeof id !== 'string' || !/^sys-(?:auto-)?[a-z0-9]+$/.test(id)) throw Object.assign(new Error('提议 ID 无效。'), { status: 400 });
  if (!['addressed', 'rejected', 'proposed'].includes(status)) throw Object.assign(new Error('状态只能是 addressed、rejected 或 proposed。'), { status: 400 });
  const file = join(resolve(`${store.file}.evolution`, '_system'), `${id}.json`);
  let record; try { record = JSON.parse(await readFile(file, 'utf8')); } catch { throw Object.assign(new Error('提议不存在。'), { status: 404 }); }
  const at = nowISO();
  Object.assign(record, { status, updatedAt: at, ...(status === 'proposed' ? { resolution: null } : { resolution: { status, note: clip(note, 2000), at } }) });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, file);
  return record;
}
/** Recorded system-level proposals, newest first. Unreadable files are skipped, never fatal. */
export async function listSystemEvolutionProposals(store, { limit = 50 } = {}) {
  const dir = resolve(`${store.file}.evolution`, '_system');
  let names = [];
  try { names = (await readdir(dir)).filter(name => /^sys-(?:auto-)?[a-z0-9]+\.json$/.test(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rows = [];
  for (const name of names) { try { const row = JSON.parse(await readFile(join(dir, name), 'utf8')); if (row && typeof row.id === 'string') rows.push(row); } catch { /* skip a torn or foreign file */ } }
  rows.sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')) || String(b.id).localeCompare(String(a.id)));
  const size = Math.max(1, Math.min(200, Number(limit) || 50));
  return { total: rows.length, proposals: rows.slice(0, size), autoAdopt: false };
}
export { RRSI_COMPONENTS };
