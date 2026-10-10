import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionSuggestions, SUGGEST_SYSTEM, REFRESH_MS } from '../session-suggestions.mjs';

// Empty-conversation suggestion cards come from the project's real state.
const at = '2026-09-30T10:00:00.000Z';
function store({ language = 'zh' } = {}) {
  return { state: {
    settings: { interfaceLanguage: language },
    projects: [{ id: 'p1', name: '赛车小游戏', description: '3D 赛车', workspace: '/tmp/none', mind: {
      agenda: [{ id: 'a1', kind: 'todo', status: 'open', stage: 'doing', text: '赛车冲出赛道后的掉落效果', createdAt: at, updatedAt: at }, { id: 'a2', kind: 'todo', status: 'open', stage: 'next', text: '碰撞分级：掉零件与翻车', createdAt: at, updatedAt: at }, { id: 'q1', kind: 'awaiting_user', status: 'open', text: '翻车后是否自动复位？', createdAt: at }],
      commitments: [{ id: 'c1', status: 'pending', request: '优化夜间赛道的灯光' }],
    } }],
    sessions: [{ id: 's1', projectId: 'p1', title: '美化 UI', items: [{ id: 'u1', kind: 'user', text: '继续美化 UI 并修复 bug', createdAt: at }] }, { id: 'side', kind: 'side', projectId: 'p1', title: 'side', items: [{ id: 'u2', kind: 'user', text: '不该出现', createdAt: at }] }],
  } };
}
const answer = { suggestions: [{ kind: 'continue', title: '接着做掉落感', text: '继续把赛车冲出赛道后的掉落效果做完。' }, { kind: 'answer', title: '定复位规则', text: '翻车后自动复位，三秒后回到赛道。' }, { kind: 'plan', title: '碰撞分级', text: '开始做碰撞分级：轻碰掉零件，重撞翻车。' }] };

test('without a model, the cards are the real state as it is: under way, waiting for the user, requested', async () => {
  const service = new SessionSuggestions(store(), { git: async () => [] });
  const result = await service.get('p1');
  assert.equal(result.source, 'state');
  assert.deepEqual(result.suggestions.map(row => row.kind), ['continue', 'answer', 'continue']);
  assert.match(result.suggestions[0].text, /赛车冲出赛道后的掉落效果/);
  assert.match(result.suggestions[1].text, /翻车后是否自动复位/);
  assert.match(result.suggestions[2].text, /夜间赛道的灯光/);
  // No project selected: starters, in the interface language.
  const none = await new SessionSuggestions(store({ language: 'en' }), { git: async () => [] }).get(null);
  assert.equal(none.source, 'starter'); assert.equal(none.suggestions.length, 3); assert.match(none.suggestions[0].title, /Project overview/);
});

test('the fast model phrases them from the state once; they are served from memory until the state changes', async () => {
  let clock = Date.parse(at); const calls = [];
  const mind = { modelJson: async (projectId, request) => { calls.push({ projectId, request }); return answer; } };
  const s = store(), service = new SessionSuggestions(s, { mind, now: () => clock, git: async () => ['src/car.ts'] });
  const first = await service.get('p1');
  assert.equal(first.source, 'state'); assert.equal(first.refreshing, true, 'the first read does not wait for the model');
  await service.inFlight.get('p1');
  const second = await service.get('p1');
  assert.equal(second.source, 'model'); assert.deepEqual(second.suggestions, answer.suggestions); assert.equal(second.refreshing, false);
  assert.equal(calls.length, 1);
  const { request } = calls[0];
  assert.equal(request.system, SUGGEST_SYSTEM); assert.notEqual(request.allowMain, false, 'the project model stands in when no fast model is set');
  assert.deepEqual(request.input.state.doing, ['赛车冲出赛道后的掉落效果']); assert.deepEqual(request.input.state.waitingForUser, ['翻车后是否自动复位？']);
  assert.deepEqual(request.input.state.recentRequests, ['继续美化 UI 并修复 bug'], 'side chats are left out'); assert.deepEqual(request.input.state.changedFiles, ['src/car.ts']);
  // Same state: no new call. Changed state within the refresh window: still the kept ones.
  await service.get('p1'); assert.equal(calls.length, 1);
  s.state.projects[0].mind.commitments.push({ id: 'c2', status: 'pending', request: '加一段排行榜' });
  await service.get('p1'); assert.equal(calls.length, 1);
  // Past the window, a changed state is phrased again (in the background).
  clock += REFRESH_MS + 1000;
  const later = await service.get('p1'); assert.equal(later.refreshing, true);
  await service.inFlight.get('p1'); assert.equal(calls.length, 2);
});

test('with nothing planned or pending, the latest requests are the cards', async () => {
  const s = store(); s.state.projects[0].mind = {};
  const result = await new SessionSuggestions(s, { git: async () => [] }).get('p1');
  assert.equal(result.suggestions[0].kind, 'continue'); assert.match(result.suggestions[0].text, /继续美化 UI 并修复 bug/);
});

test('a model answer that is not three usable cards falls back to the state', async () => {
  const service = new SessionSuggestions(store(), { mind: { modelJson: async () => ({ suggestions: [{ title: 'only one', text: 'x' }] }) }, git: async () => [] });
  await service.get('p1'); await service.inFlight.get('p1');
  assert.equal((await service.get('p1')).source, 'state');
});

test('GET /api/v2/suggestions answers for a project and for none', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs'), { join } = await import('node:path'), { tmpdir } = await import('node:os'), { createServer } = await import('../server.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rna-suggest-')), app = createServer({ stateFile: join(dir, 'state.json'), ticks: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const { project } = app.store.createProject({ name: 'Game', workspace: dir });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2/suggestions`;
  const none = await (await fetch(base)).json();
  assert.equal(none.suggestions.length, 3); assert.equal(none.source, 'starter');
  const own = await (await fetch(`${base}?projectId=${project.id}`)).json();
  assert.equal(own.projectId, project.id); assert.equal(own.suggestions.length, 3);
  assert.equal((await fetch(`${base}?projectId=bad!id`)).status, 400);
});

test('a scheduled run that needs the user is named by its schedule, in the interface language', async () => {
  // Live, 2026-10-03: a scheduled run's content is the host's instruction to the worker (occurrence key, due time, rule JSON).
  for (const [language, expected] of [['zh', '每日 AI 日报（定时任务）'], ['en', '每日 AI 日报 (scheduled task)']]) {
    const s = store({ language }), project = s.state.projects[0];
    project.schedules = [{ id: 'daily', title: '每日 AI 日报', task: '写今天的日报。' }];
    project.taskMarks = { 'schedule-work-x': { needsUser: true }, own: { needsUser: true } };
    project.initiativeRuntime = { sdkState: { actions: [
      { id: 'schedule-work-x', action: 'work', status: 'completed', content: 'Scheduled occurrence schedule:daily:k\nDue: 2026-10-03T01:00:00.000Z\nTime rule: {}\n\n写今天的日报。\n\nProduce the requested deliverable…', hostSchedule: { key: 'schedule:daily:k', scheduleId: 'daily' } },
      { id: 'own', action: 'work', status: 'completed', content: '核对第 8 章人名。' },
    ] } };
    const state = await new SessionSuggestions(s, { git: async () => [] }).state(project);
    assert.deepEqual(state.needsUser, [expected, '核对第 8 章人名。']);
  }
});
