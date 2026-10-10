import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { experienceReport } from '../experience-report.mjs';
import { createServer } from '../server.mjs';

// Plan 2026-09-30 §5 (D6): `./rna doctor` experience metrics — counts only.
const now = Date.parse('2026-09-30T12:00:00Z'), ago = hours => new Date(now - hours * 3600000).toISOString();
function state({ language = 'zh' } = {}) {
  const inbox = [...['replied', 'ignored', 'ignored', 'ignored', 'dismissed'].map((outcome, index) => ({ id: `m${index}`, createdAt: ago(10 + index), tier: 'inline', feedback: { outcome } })), { id: 'old', createdAt: ago(24 * 20), tier: 'inline', feedback: { outcome: 'replied' } }];
  const wake = { history: [...['work', 'quiet', 'failed', 'failed', 'failed', 'thought', 'failed'].map((outcome, index) => ({ at: ago(index + 1), outcome, ...(outcome === 'failed' && index < 6 ? { reason: index === 4 ? 'provider_timeout' : 'maintenance_held' } : {}) })), { at: ago(24 * 30), outcome: 'failed', reason: 'old' }] };
  return {
    settings: { interfaceLanguage: language },
    projects: [{ id: 'p1', name: '小说', inbox, mind: { pacing: { wake } }, genes: { genes: [{ id: 'system:a', layer: 'system', status: 'active', title: '浏览器服务连不上', body: { count: 2, lastAt: ago(3) } }, { id: 'g', layer: 'guard', status: 'trial' }], generations: [{ n: 4 }], contrast: { at: ago(5), turns: 12, trouble: 3, clusters: [{}, {}] } } }, { id: 'gone', name: 'x', archivedAt: ago(1) }],
    sessions: [{ id: 's1', projectId: 'p1', invitations: [{ id: 'i1', kind: 'gene', createdAt: ago(2) }], invitationHistory: [{ id: 'i2', kind: 'lesson', outcome: 'answered', createdAt: ago(5) }, { id: 'i3', kind: 'lesson', outcome: 'dismissed', createdAt: ago(6) }, { id: 'i4', kind: 'feedback', outcome: 'expired', createdAt: ago(7) }, { id: 'i5', kind: 'feedback', outcome: 'answered', createdAt: ago(24 * 40) }] }],
    decisionKernelRuntime: { recent: [...Array.from({ length: 22 }, (_, index) => ({ point: 'turn.route', at: now - index * 1000, source: 'judge' })), { point: 'message.value', at: now - 5000, source: 'judge', label: { value: 'useful' } }, { point: 'message.value', at: now - 6000, source: 'fallback' }, { point: 'turn.route', at: now - 30 * 86400000, source: 'judge', label: { value: 'x' } }] },
  };
}

test('the week in numbers: proactive outcomes, invitations, wakes with reasons, JEV label coverage, evolution', () => {
  const report = experienceReport(state(), { now });
  assert.equal(report.days, 7); assert.equal(report.projects.length, 1, 'archived projects are left out');
  const [row] = report.projects;
  assert.deepEqual({ ...row.proactive }, { delivered: 5, pending: 0, replied: 1, acted: 0, dismissed: 1, ignored: 3, usefulShareRate: .2, ignoreRate: .6 });
  assert.deepEqual({ offered: row.invitations.offered, open: row.invitations.open, answered: row.invitations.answered, dismissed: row.invitations.dismissed, expired: row.invitations.expired, answerRate: row.invitations.answerRate }, { offered: 4, open: 1, answered: 1, dismissed: 1, expired: 1, answerRate: .333 });
  assert.deepEqual(row.invitations.byKind.lesson, { answered: 1, dismissed: 1 });
  assert.deepEqual({ total: row.wakes.total, work: row.wakes.work, quiet: row.wakes.quiet, thought: row.wakes.thought, failed: row.wakes.failed, failureRate: row.wakes.failureRate }, { total: 7, work: 1, quiet: 1, thought: 1, failed: 4, failureRate: .571 });
  assert.deepEqual(row.wakes.failureReasons, { maintenance_held: 2, provider_timeout: 1, unrecorded: 1 }, 'a failure from before reasons were kept is counted apart');
  assert.equal(row.evolution.generation, 4); assert.equal(row.evolution.trial, 1);
  assert.deepEqual(row.evolution.systemOpen.map(issue => [issue.title, issue.seen]), [['浏览器服务连不上', 2]]);
  assert.deepEqual(row.evolution.contrast, { at: ago(5), turns: 12, trouble: 3, clusters: 2 });
  assert.deepEqual(report.jev.points['turn.route'], { decisions: 22, judged: 22, labeled: 0, labelCoverage: 0, labels: { outcome: 0, self: 0, heuristic: 0 } });
  assert.deepEqual(report.jev.points['message.value'], { decisions: 2, judged: 1, labeled: 1, labelCoverage: 1, labels: { outcome: 1, self: 0, heuristic: 0 } });
  assert.equal(report.jev.totals.labelCoverage, .043);
  // Plain notes only where something needs a look.
  assert.equal(report.notes.length, 4, report.notes.join('\n'));
  assert.match(report.notes[0], /「小说」近 7 天的主动消息有一半以上没人理（60%）/);
  assert.match(report.notes[1], /后台唤醒失败 3 次，主要原因：maintenance_held/);
  assert.match(report.notes[2], /系统问题仍在发生：浏览器服务连不上（2 次）/);
  assert.match(report.notes[3], /已判 20 次以上还没有真实结果标签：turn\.route/);
  assert.match(experienceReport(state({ language: 'en' }), { now }).notes[0], /over half of the proactive messages/);
});

test('GET /api/v2/experience serves the report', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-experience-')), app = createServer({ stateFile: join(dir, 'state.json'), ticks: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/experience?days=3`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.days, 3); assert.ok(Array.isArray(body.projects)); assert.deepEqual(body.notes, []);
});

test('deferred wakes with their reasons, the evolution funnel per lane, and labels read from the 30-day index', () => {
  const day = new Date(now).toISOString().slice(0, 10);
  const wake = { history: [{ at: ago(1), outcome: 'work' }, { at: ago(2), outcome: 'deferred', reason: 'nothing_actionable' }, { at: ago(3), outcome: 'deferred', reason: 'judged_idle' }, { at: ago(4), outcome: 'deferred', reason: 'nothing_actionable' }] };
  const funnel = { since: ago(48), A: { routed: 4, guard_committed: 1, practice_author_skipped: 2, guard_smoke_failed: 1 }, B: { corrections: 3, queued: 2, cooldown: 1, judged_no: 2 }, C: { analyses: 1, clusters_system: 1, patches_proposed: 0 } };
  const value = {
    settings: { interfaceLanguage: 'zh' },
    projects: [{ id: 'p1', name: '游戏', inbox: [], mind: { pacing: { wake } }, genes: { genes: [], generations: [{ n: 2 }], funnel } }],
    sessions: [],
    decisionKernelRuntime: { recent: [{ id: 'r1', point: 'initiative.review', at: now - 1000, source: 'judge', label: { value: 'wake_unneeded' } }],
      index: { [day]: [{ id: 'r1', point: 'initiative.review', at: now - 1000, source: 'judge' }, { id: 'r0', point: 'initiative.review', at: now - 2000, source: 'rule' }, { id: 'old', point: 'initiative.review', at: now - 3000, source: 'judge' }, { id: 'f', point: 'initiative.review', at: now - 4000, source: 'fallback' }] },
      labels: { old: { value: 'defer_missed', at: now } } },
  };
  const report = experienceReport(value, { now });
  const [row] = report.projects;
  assert.deepEqual({ total: row.wakes.total, work: row.wakes.work, deferred: row.wakes.deferred, deferredReasons: row.wakes.deferredReasons }, { total: 4, work: 1, deferred: 3, deferredReasons: { nothing_actionable: 2, judged_idle: 1 } });
  assert.deepEqual(row.evolution.funnel, funnel);
  // Four judgments in the index: a host rule counts as judged; the fallback does not; labels come from the hot row and the index alike.
  // Both are the main model's own next decisions: self labels, counted by source and never as label coverage (PDL-7).
  assert.deepEqual(report.jev.points['initiative.review'], { decisions: 4, judged: 3, labeled: 0, labelCoverage: 0, labels: { outcome: 0, self: 2, heuristic: 0 } }, 'the main model\'s own next decisions are self-labels');
});

test('the cache-prefix measurement of decision requests is averaged per project with where they diverged', () => {
  const wake = { history: [{ at: ago(1), outcome: 'work', prompt: { chars: 120000, shared: .2, divergedIn: 'availableActions' } }, { at: ago(2), outcome: 'thought', prompt: { chars: 100000, shared: .9, divergedIn: 'project.recentConversation' } }, { at: ago(3), outcome: 'thought' }] };
  const report = experienceReport({ settings: { interfaceLanguage: 'zh' }, projects: [{ id: 'p1', name: '游戏', inbox: [], mind: { pacing: { wake } }, genes: { genes: [], generations: [] } }], sessions: [], decisionKernelRuntime: { recent: [] } }, { now });
  assert.deepEqual(report.projects[0].wakes.prompt, { measured: 2, sharedPrefix: .55, chars: 110000, divergedIn: { availableActions: 1, 'project.recentConversation': 1 } });
});

test('prompt growth across generations is reported from the recorded prompt size', () => {
  const generations = [{ n: 1, promptChars: 4000 }, { n: 2 }, { n: 3, promptChars: 5200 }];
  const report = experienceReport({ settings: { interfaceLanguage: 'zh' }, projects: [{ id: 'p1', name: '小说', inbox: [], mind: {}, genes: { genes: [], generations } }], sessions: [], decisionKernelRuntime: { recent: [] } }, { now });
  assert.deepEqual(report.projects[0].evolution.promptGrowth, { first: 4000, latest: 5200, generations: 2, ratio: 1.3 });
  assert.equal(experienceReport({ settings: {}, projects: [{ id: 'p2', name: 'x', inbox: [], mind: {}, genes: { genes: [], generations: [{ n: 1, promptChars: 100 }] } }], sessions: [], decisionKernelRuntime: { recent: [] } }, { now }).projects[0].evolution.promptGrowth, null);
});

test('delegation per model: heavy and busy turns that delegated, and how the subagents ended with their tokens', () => {
  const tools = (turnId, n) => Array.from({ length: n }, (_, index) => ({ id: `${turnId}-tool-${index}`, kind: 'tool', turnId }));
  const glm = { execution: 'rna', providerId: 'glm', modelId: 'glm-5.3', name: 'GLM-5.3' }, gpt = { execution: 'rna', providerId: 'oa', modelId: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' };
  const child = (status, tokens, extra = {}) => ({ id: `c-${status}-${tokens}`, role: 'scout', status, usage: { totalTokens: tokens }, ...extra });
  const value = { settings: { interfaceLanguage: 'zh' }, decisionKernelRuntime: { recent: [] },
    projects: [{ id: 'p1', name: '小说', inbox: [], mind: {}, genes: { genes: [], generations: [] } }, { id: 'old', name: 'x', archivedAt: ago(1) }],
    sessions: [
      { id: 's-glm', projectId: 'p1', turns: [
        { id: 'g-heavy', createdAt: ago(5), modelConfig: glm },
        { id: 'g-heavy-delegated', createdAt: ago(4), modelConfig: glm, delegations: [child('completed', 1200), child('completed', 3000, { stepLimit: true }), child('failed', 300)] },
        { id: 'g-busy', createdAt: ago(3), modelConfig: glm },
        { id: 'g-light', createdAt: ago(2), modelConfig: glm, delegations: [child('cancelled', 50)] },
        { id: 'g-simulated', createdAt: ago(2) },
        { id: 'g-old', createdAt: ago(24 * 30), modelConfig: glm, delegations: [child('completed', 9999)] }],
        items: [...tools('g-heavy', 25), ...tools('g-heavy-delegated', 21), ...tools('g-busy', 12), ...tools('g-light', 3), ...tools('g-simulated', 30), ...tools('g-old', 40)] },
      { id: 's-gpt', projectId: 'p1', turns: [{ id: 'o-busy', createdAt: ago(1), modelConfig: gpt, delegations: [child('interrupted', 80, { model: { providerId: 'oa', modelId: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' } }), child('running', 0)] }], items: tools('o-busy', 10) },
      { id: 's-archived-project', projectId: 'old', turns: [{ id: 'x', createdAt: ago(1), modelConfig: glm }], items: tools('x', 50) }
    ] };
  const { delegation } = experienceReport(value, { now });
  assert.deepEqual(delegation.thresholds, { heavy: 20, busy: 10 });
  assert.deepEqual(Object.keys(delegation.byModel).sort(), ['glm-5.3', 'gpt-6.1-sol']);
  const g = delegation.byModel['glm-5.3'], o = delegation.byModel['gpt-6.1-sol'];
  assert.equal(g.name, 'GLM-5.3'); assert.equal(g.turns, 4, 'real turns in the window; simulated, old and archived-project turns are left out');
  assert.deepEqual(g.heavy, { turns: 2, delegated: 1, share: .5 });
  assert.deepEqual(g.busy, { turns: 3, delegated: 1, share: .333 }, 'busy counts every turn with at least 10 calls, heavy ones included');
  assert.deepEqual(g.subagents, { spawned: 4, completed: 1, summarized: 1, failed: 1, cancelled: 1, interrupted: 0, running: 0, tokens: { total: 4550, completed: 1200, summarized: 3000, failed: 300, cancelled: 50, interrupted: 0, running: 0 } });
  assert.deepEqual(o.heavy, { turns: 0, delegated: 0, share: null }); assert.deepEqual(o.busy, { turns: 1, delegated: 1, share: 1 });
  assert.equal(o.subagents.interrupted, 1); assert.equal(o.subagents.running, 1); assert.equal(o.subagents.tokens.total, 80);
  // Sessions recorded before turns or items existed still produce a report.
  assert.deepEqual(experienceReport(state(), { now }).delegation.byModel, {});
});

test('isolation per model: merges, conflicts, continuations that settled them, rollbacks and recovered applies', () => {
  const glm = { execution: 'rna', modelId: 'glm-5.3', name: 'GLM-5.3' }, gpt = { execution: 'rna', modelId: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' };
  const value = { settings: { interfaceLanguage: 'zh' }, decisionKernelRuntime: { recent: [] },
    projects: [{ id: 'p1', name: '小说', inbox: [], mind: {}, genes: { genes: [], generations: [] },
      backgroundChanges: [{ id: 'c1', kind: 'git', at: ago(3), status: 'kept' }, { id: 'c2', kind: 'git', at: ago(2), status: 'merge_conflicted', conflicts: [{ path: 'a', kind: 'content' }] }, { id: 'c3', at: ago(2), status: 'kept' }, { id: 'c4', kind: 'git', at: ago(24 * 30), status: 'kept' }],
      git: { applies: [
        { id: 'w1', kind: 'worker', at: ago(5), source: { sessionId: 's1', turnId: 't1', agentId: 'agent-1' }, state: 'verified' },
        { id: 'r1', kind: 'resolve', at: ago(4), source: { sessionId: 's1', turnId: 't1', agentId: 'agent-2' }, state: 'verified' },
        { id: 'k1', kind: 'rollback', at: ago(3), undoes: 'w1', source: { sessionId: 's1', turnId: 't1' }, state: 'verified' },
        { id: 'k2', kind: 'rollback', at: ago(2), undoesTurn: 't2', source: { sessionId: 's2', turnId: 't2' }, state: 'verified' },
        { id: 'x1', kind: 'turn', at: ago(1), source: { sessionId: 's2', turnId: 't2' }, state: 'verified', recovered: 'completed' },
        { id: 'x2', kind: 'turn', at: ago(1), source: { sessionId: 's2', turnId: 't2' }, state: 'interrupted', recovered: 'interrupted' },
        { id: 'old', kind: 'rollback', at: ago(24 * 30), undoes: 'w1', source: { sessionId: 's1', turnId: 't1' }, state: 'verified' }] } }],
    sessions: [
      { id: 's1', projectId: 'p1', items: [], turns: [{ id: 't1', createdAt: ago(6), modelConfig: glm, delegations: [
        { id: 'agent-1', role: 'worker', status: 'completed', merge: { status: 'merged', applyIds: ['w1'] } },
        { id: 'agent-2', role: 'worker', status: 'completed', merge: { status: 'merged', applyIds: ['r1'] } },
        { id: 'agent-3', role: 'worker', status: 'completed', merge: { status: 'conflict', applyIds: [], conflicts: [{ path: 'b', kind: 'content' }] } },
        { id: 'agent-4', role: 'worker', status: 'completed', merge: { status: 'shared_root', reason: 'no_repository' } },
        { id: 'agent-5', role: 'worker', status: 'cancelled', merge: { status: 'pending', reason: 'cancelled' } },
        { id: 'scout', role: 'scout', status: 'completed' }] }] },
      { id: 's2', projectId: 'p1', items: [], turns: [
        { id: 't2', createdAt: ago(3), modelConfig: gpt, apply: { status: 'applied', applyIds: ['x1'], conflict: { id: 'm', paths: [{ path: 'c', kind: 'content' }], attempts: 1 } } },
        { id: 't3', createdAt: ago(2), modelConfig: gpt, apply: { status: 'conflicted', applyIds: [], conflict: { id: 'n', paths: [], attempts: 2 } } },
        { id: 't4', createdAt: ago(2), modelConfig: gpt, apply: { status: 'applied', applyIds: ['x3'] } },
        { id: 't5', createdAt: ago(1), modelConfig: gpt, apply: { status: 'none', applyIds: [] } }] }] };
  const { isolation } = experienceReport(value, { now });
  const g = isolation.byModel['glm-5.3'], o = isolation.byModel['gpt-6.1-sol'], b = isolation.byModel.background;
  assert.deepEqual({ merges: g.merges, conflicted: g.conflicted, rate: g.conflictRate, rollbacks: g.rollbacks }, { merges: 3, conflicted: 2, rate: .667, rollbacks: 1 }, 'a worker resolved later still counts as conflicted; shared_root, pending and scouts are no merge');
  assert.deepEqual({ merges: o.merges, conflicted: o.conflicted, continuations: o.continuations, rollbacks: o.rollbacks, recoveries: o.recoveries }, { merges: 3, conflicted: 2, continuations: { conflicted: 2, resolved: 1, rate: .5 }, rollbacks: 1, recoveries: { total: 2, completed: 1, interrupted: 1 } });
  assert.deepEqual({ merges: b.merges, conflicted: b.conflicted }, { merges: 2, conflicted: 1 }, 'background change sets without a model, in the window, git ones only');
  assert.deepEqual(isolation.totals, { merges: 8, conflicted: 5, rollbacks: 2, recoveries: 2, conflictRate: .625 });
  assert.deepEqual(experienceReport(state(), { now }).isolation, { byModel: {}, totals: { merges: 0, conflicted: 0, rollbacks: 0, recoveries: 0, conflictRate: null } });
});
