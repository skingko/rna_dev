import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stream, GUARD_ANSWER, setup, keepsRule } from './helpers/gene-fixture.mjs';
import { createMindEntry } from '../project-mind.mjs';
import { geneTree, geneDetail } from '../project-genes.mjs';
import { GUARD_AUTHOR_SYSTEM, CONTRAST_SYSTEM } from '../gene-evolution-service.mjs';
import { GeneDeepCheck } from '../gene-deep-check.mjs';

// Evolution v3 phase 3 (plan §9 D5): lane C contrast analysis, the system
// strand, skill merges that can be undone, and the optional deep check.
// Models, judges and the evaluator are local stubs.
const CONTRAST_ANSWER = {
  clusters: [{ theme: '人名前后不一致', cause: 'method', turns: ['T0', 'T2'] }, { theme: '浏览器服务连不上', cause: 'system', turns: ['T4'] }],
  patches: [{ skillId: 'project-workflow', title: '先列出场人物', summary: '写章节前先列出本章出场人物并核对设定集。', section: '- 动笔前列出本章出场人物。\n- 逐个对照设定集核对名字、称谓与关系。', when: '写章节', expectation: '人名不再前后不一', turns: ['T0', 'T2'] }],
  system: [{ title: '浏览器服务连不上', summary: '网页查看工具多次连接失败，不是写作方法的问题。', detail: 'The browser MCP service refused connections in two turns (ECONNREFUSED).', turns: ['T4'] }],
  retire: [{ geneId: 'guard:guard_nightwatch', reason: '这几轮的纠正都和它无关，它也没拦下过问题。' }],
  merge: [],
};
const contrastRequests = calls => calls.filter(input => (input.messages.find(row => row.role === 'system')?.content ?? '').includes(CONTRAST_SYSTEM.slice(0, 60)));

async function withGuard(t, contrastAnswer = CONTRAST_ANSWER) {
  const f = await setup(t, (input, res) => {
    const system = input.messages.find(row => row.role === 'system')?.content ?? '';
    if (system.includes(GUARD_AUTHOR_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(GUARD_ANSWER));
    if (system.includes(CONTRAST_SYSTEM.slice(0, 60))) return stream(res, JSON.stringify(contrastAnswer));
    stream(res, 'ok');
  });
  let lessonId;
  f.app.store.mutate(state => { const project = state.projects.find(row => row.id === f.project.id); lessonId = createMindEntry(project, 'lessons', { text: '正文里不得出现“守夜”字样。', kind: 'constraint' }).id; });
  f.app.genes.decisions = { geneRoute: async () => ({ guard: true, everyWrite: true, method: false }), geneReview: async () => ({ pass: true, problems: [] }) };
  keepsRule(f.workspace);
  assert.equal((await f.app.genes.routeLesson(f.current(), f.current().mind.lessons.find(row => row.id === lessonId))).outcome, 'active');
  // A foreground turn; `capture` marks how the user's message that opened it read (correction / approval).
  const turn = (text, { status = 'completed', capture = null } = {}) => {
    const turnId = randomUUID(), userItemId = randomUUID(), at = new Date().toISOString();
    f.app.store.mutate(state => { const s = state.sessions.find(row => row.id === f.session.id); s.turns.push({ id: turnId, status, userItemId, createdAt: at, completedAt: at, modelConfig: { execution: 'rna' }, simulated: false, ...(status === 'failed' ? { errorCode: 'mcp_unavailable' } : {}) }); s.items.push({ id: userItemId, turnId, kind: 'user', text, createdAt: at, simulated: false, ...(capture ? { capture } : {}) }); s.items.push({ id: randomUUID(), turnId, kind: 'assistant', text: `回复：${text}`, final: true, createdAt: at, simulated: false }); });
    return turnId;
  };
  return { ...f, turn };
}

test('lane C: the review sees the user\'s own corrections, whether the patch cites turns loosely (t0, 2) or not at all', async t => {
  for (const turns of [['t0', '2'], []]) {
    const f = await withGuard(t, { ...CONTRAST_ANSWER, patches: CONTRAST_ANSWER.patches.map(row => ({ ...row, turns })), system: [], retire: [] });
    f.app.genes.enabled = true; let reviewed = null;
    f.app.genes.decisions = { ...f.app.genes.decisions, geneReview: async (_project, input) => { reviewed = input; return { pass: true, problems: [] }; } };
    f.turn('写第 1 章'); f.turn('人名又前后不一致了', { capture: { correction: true } }); f.turn('写第 3 章', { capture: { approval: true } });
    f.turn('还是不一致', { capture: { correction: true } }); f.turn('打开网页核对资料', { status: 'failed' }); f.turn('好', { capture: { approval: true } });
    const result = await f.app.genes.contrast(f.project.id);
    assert.equal(result.patches[0].outcome, 'trial', JSON.stringify(result.patches));
    const patch = f.current().genes.genes.find(row => row.id === result.patches[0].geneId);
    assert.match(patch.origin.quote, /人名又前后不一致了/); assert.match(patch.origin.quote, /还是不一致/);
    assert.doesNotMatch(patch.origin.quote, /写章节前先列出本章出场人物/, 'never the proposal quoting itself');
    assert.match(reviewed.origin, /人名又前后不一致了/); assert.match(reviewed.origin, /还是不一致/);
  }
});

const post = (f, path, body) => fetch(f.url(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const genePath = (f, id) => `/api/v2/projects/${f.project.id}/genes/${encodeURIComponent(id)}`;

test('lane C: corrected and failed turns pile up, one analysis contrasts them with good ones; a patch, a system record and a retire invitation follow', async t => {
  const f = await withGuard(t);
  f.app.genes.enabled = true;
  f.turn('写第 1 章');
  f.turn('人名又前后不一致了', { capture: { correction: true } });
  f.turn('写第 3 章', { capture: { approval: true } });
  f.turn('还是不一致', { capture: { correction: true } });
  f.turn('打开网页核对资料', { status: 'failed' });
  f.turn('继续写第 5 章');
  f.turn('好', { capture: { approval: true } });
  const outcomes = f.app.genes.contrastOutcomes(f.current());
  assert.deepEqual(outcomes.map(row => row.outcome), ['corrected', 'approved', 'corrected', 'accepted', 'failed', 'approved']);
  assert.equal(f.app.genes.contrastDue(f.current()), true, 'three troubled turns are enough');
  const result = await f.app.genes.contrast(f.project.id);
  assert.equal(result.analyzed, true);
  assert.equal(result.patches[0].outcome, 'trial', JSON.stringify(result.patches));
  // One analysis call, with every troubled turn and the good ones for contrast, plus the genes in force.
  const [request] = contrastRequests(f.calls), input = JSON.parse(request.messages.find(row => row.role === 'user').content.map?.(part => part.text).join('') ?? request.messages.find(row => row.role === 'user').content);
  assert.deepEqual(input.turns.map(row => row.outcome), ['corrected', 'approved', 'corrected', 'accepted', 'failed', 'approved']);
  assert.equal(input.turns[0].correction, '人名又前后不一致了'); assert.match(input.turns[4].error, /mcp_unavailable/);
  assert.ok(input.genes.some(row => row.id === 'guard:guard_nightwatch')); assert.equal(input.primarySkill, 'project-workflow');
  const project = f.current(), genome = project.versions.find(row => row.id === project.activeVersionId).bundle.genome;
  assert.match(genome.skills[0].instructions, /## 先列出场人物\n- 动笔前列出本章出场人物/);
  const patch = project.genes.genes.find(row => row.id === result.patches[0].geneId);
  assert.equal(patch.origin.kind, 'contrast'); assert.match(patch.origin.quote, /人名又前后不一致了/);
  // Where the quoted words came from stays on the rule (review X-6: deleting or rewinding them takes the quote off); the model never saw it.
  const quoted = f.app.store.state.sessions.find(row => row.id === f.session.id).items.find(item => item.text === '人名又前后不一致了');
  assert.ok(patch.origin.sources.some(row => row.sessionId === f.session.id && row.itemId === quoted.id)); assert.ok(input.turns.every(row => row.source === undefined));
  assert.equal(project.genes.generations.at(-1).trigger, 'contrast');
  assert.deepEqual({ turns: project.genes.contrast.turns, trouble: project.genes.contrast.trouble }, { turns: 6, trouble: 3 });
  assert.deepEqual(project.genes.contrast.clusters.map(row => row.cause), ['method', 'system']);
  // The system strand: a problem in the app, not the project's method; no generation for it.
  const system = project.genes.genes.find(row => row.layer === 'system');
  assert.equal(system.status, 'active'); assert.equal(system.body.count, 1); assert.match(system.body.detail, /ECONNREFUSED/);
  const tree = geneTree(project, { genome });
  assert.deepEqual(tree.strands.find(row => row.layer === 'system').genes.map(row => [row.title, row.seen]), [['浏览器服务连不上', 1]]);
  assert.match(geneDetail(project, system.id, { genome }).content.detail, /ECONNREFUSED/);
  // The retire proposal is the user's decision.
  const invitation = f.app.store.state.sessions.find(row => row.id === f.session.id).invitations.find(row => row.kind === 'gene');
  assert.deepEqual([invitation.geneId, invitation.usage, invitation.reason], ['guard:guard_nightwatch', 'no_effect', '这几轮的纠正都和它无关，它也没拦下过问题。']);
  const said = [...f.app.genes.announcements.map(row => row.text), ...f.app.store.state.sessions.find(row => row.id === f.session.id).items.filter(item => item.source === 'initiative').map(item => item.text)];
  assert.ok(said.some(text => /对照了最近 6 轮，补充了一条做法/.test(text)), said.join(' | '));
  // Recorded: the next analysis waits for new evidence and a day.
  assert.equal(f.app.genes.contrastDue(f.current()), false);
  // Seen again, a system record counts up; 已解决 retires it without a generation; seen again, it reopens.
  f.app.genes.recordSystem(f.project.id, { title: '浏览器服务连不上', summary: 's', detail: 'd' });
  assert.equal(f.current().genes.genes.find(row => row.id === system.id).body.count, 2);
  const generations = f.current().genes.generations.length;
  const solved = await post(f, genePath(f, system.id), { action: 'revoke' });
  assert.equal(solved.status, 200, await solved.clone().text());
  assert.equal(f.current().genes.genes.find(row => row.id === system.id).status, 'retired');
  assert.equal(f.current().genes.generations.length, generations, 'a system record never forms a generation');
  f.app.genes.recordSystem(f.project.id, { title: '浏览器服务连不上', summary: 's', detail: 'd' });
  assert.deepEqual([f.current().genes.genes.find(row => row.id === system.id).status, f.current().genes.genes.find(row => row.id === system.id).body.count], ['active', 3]);
});

test('lane C waits: too little trouble and too little time since the last analysis mean no call', async t => {
  const f = await withGuard(t);
  f.app.genes.enabled = true;
  f.turn('写第 1 章'); f.turn('人名错了', { capture: { correction: true } }); f.turn('好');
  assert.equal(f.app.genes.contrastDue(f.current()), false, 'one correction, a new project');
  // A week later with ten outcomes it is due even without trouble.
  f.app.store.mutate(state => { state.projects.find(row => row.id === f.project.id).createdAt = new Date(Date.now() - 8 * 86400000).toISOString(); });
  for (let index = 0; index < 10; index++) f.turn(`写第 ${index + 2} 章`);
  assert.equal(f.app.genes.contrastDue(f.current()), true);
  f.app.genes.contrasted.set(f.project.id, Date.now());
  assert.equal(f.app.genes.contrastDue(f.current()), false, 'at most once a day');
});

test('skill merge: two overlapping skills become one on trial; retiring the merge brings both back as they were', async t => {
  const f = await withGuard(t);
  await f.app.genes.genes.commitGeneration(f.project.id, { summary: '加入技能', genes: [], change: draft => { draft.skills.push({ id: 'chapter-writing', name: '章节写作', description: '写章节', instructions: `# 章节写作\n\n${'每章先写提纲，再写正文。'.repeat(40)}`, resources: [] }); return draft; } });
  const before = f.current().versions.find(row => row.id === f.current().activeVersionId).bundle.genome.skills.map(row => [row.id, row.instructions]);
  const merged = `# 项目工作流\n\n1. 读设定集。\n2. 每章先写提纲，再写正文。\n3. 写章节，写完核对设定。\n${'- 保持人名、称谓与设定集一致。\n'.repeat(10)}`;
  assert.equal(await f.app.genes.mergeSkills(f.project.id, { keep: 'chapter-writing', absorb: 'project-workflow', instructions: merged }, { primary: 'project-workflow' }), null, 'the primary skill is never absorbed');
  assert.equal(await f.app.genes.mergeSkills(f.project.id, { keep: 'project-workflow', absorb: 'chapter-writing', instructions: merged.repeat(8) }, { primary: 'project-workflow' }), null, 'a merge must be shorter than both together');
  const result = await f.app.genes.mergeSkills(f.project.id, { keep: 'project-workflow', absorb: 'chapter-writing', instructions: merged, summary: '把章节写作并进项目工作流。' }, { primary: 'project-workflow' });
  assert.equal(result.outcome, 'trial', JSON.stringify(result));
  let project = f.current(), genome = project.versions.find(row => row.id === project.activeVersionId).bundle.genome;
  assert.deepEqual(genome.skills.map(row => row.id), ['project-workflow']); assert.equal(genome.skills[0].instructions, merged.trim());
  const gene = project.genes.genes.find(row => row.id === result.geneId);
  assert.deepEqual(gene.body.mergedFrom, ['project-workflow', 'chapter-writing']);
  assert.deepEqual(geneTree(project, { genome }).strands.find(row => row.layer === 'skill').genes.find(row => row.id === result.geneId).mergedFrom, ['project-workflow', 'chapter-writing']);
  const revoked = await post(f, genePath(f, result.geneId), { action: 'revoke' });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  project = f.current(); genome = project.versions.find(row => row.id === project.activeVersionId).bundle.genome;
  assert.deepEqual(genome.skills.map(row => [row.id, row.instructions]).sort(), before.sort());
  // A skill patch whose text was merged away retires as a record alone.
  f.app.store.mutate(state => { const target = state.projects.find(row => row.id === f.project.id); target.genes.genes.push({ id: 'skill-patch:gone', layer: 'skill', key: 'gone', title: '旧做法', summary: 's', status: 'active', generation: 1, history: [], body: { skillId: 'project-workflow', note: '\n\n## 旧做法\n不存在的段落' } }); });
  const gone = await post(f, genePath(f, 'skill-patch:gone'), { action: 'revoke' });
  assert.equal(gone.status, 200, await gone.clone().text()); assert.equal(f.current().genes.genes.find(row => row.id === 'skill-patch:gone').status, 'retired');
});

test('deep check: a gene that formed a generation is compared with its parent on the evaluation cases, only when asked', async t => {
  const f = await withGuard(t);
  const evaluated = [];
  const deep = new GeneDeepCheck(f.app.store, { genes: f.app.genes.genes, evaluate: async input => { evaluated.push(input); return { baselineScore: .6, candidateScore: .8, gatePassed: true, details: [{}, {}], usage: { totalTokens: 120 } }; }, browserAdapterFactory: () => ({}) });
  t.after(() => deep.close());
  const project = f.current(), genome = project.versions.find(row => row.id === project.activeVersionId).bundle.genome;
  const view = geneTree(project, { genome }).strands.find(row => row.layer === 'guard').genes.find(row => row.id === 'guard:guard_nightwatch');
  assert.equal(view.deepCheckable, true);
  assert.deepEqual(deep.start(f.project.id, 'guard:guard_nightwatch').status, 'running');
  assert.throws(() => deep.start(f.project.id, 'guard:guard_nightwatch'), /正在做一次深入检查/);
  const shown = await deep.running.get(f.project.id).promise;
  assert.deepEqual({ status: shown.status, verdict: shown.verdict, baselineScore: shown.baselineScore, candidateScore: shown.candidateScore, cases: shown.cases }, { status: 'done', verdict: 'better', baselineScore: .6, candidateScore: .8, cases: 2 });
  // The parent has no guard tool; this generation does.
  assert.equal(evaluated[0].baseline.tools.length, 0); assert.equal(evaluated[0].candidate.tools.length, 1);
  const record = f.current().genes.genes.find(row => row.id === 'guard:guard_nightwatch');
  assert.equal(record.deepCheck.verdict, 'better');
  assert.equal(f.app.store.state.realUsage.reservations[`deep-check:${f.project.id}:guard:guard_nightwatch`], undefined, 'the reservation is released');
  // A gene without a parent generation cannot be deep-checked (served as a 409 by the route).
  f.app.genes.recordSystem(f.project.id, { title: '某个服务', summary: 's', detail: 'd' });
  const systemId = f.current().genes.genes.find(row => row.layer === 'system').id;
  const refused = await post(f, genePath(f, systemId), { action: 'deep_check' });
  assert.equal(refused.status, 409); assert.match((await refused.json()).error ?? '', /没有可以对比的上一代/);
});

test('lane C counterfactual gate: a patch that names only turns that went well is dropped; the counterfactual of an accepted one is kept on the gene', async t => {
  const answer = { ...CONTRAST_ANSWER, system: [], retire: [], patches: [
    // Outcomes come from the next user message: T0 corrected, T1 approved, T2 corrected, T3 accepted, T4 failed.
    { ...CONTRAST_ANSWER.patches[0], turns: ['T1', 'T3'], counterfactual: '' },
    { skillId: 'project-workflow', title: '先核对时间线', summary: '写章节前先核对事件时间线。', section: '- 动笔前列出本章涉及的事件顺序。\n- 对照大纲核对先后关系。', when: '写章节', expectation: '时间线不再前后矛盾', turns: ['T0', 'T2'], counterfactual: '第 1 轮和第 3 轮的纠正都源于时间顺序写反，先核对就不会写反。' },
  ] };
  const f = await withGuard(t, answer);
  f.app.genes.enabled = true;
  f.app.genes.decisions = { ...f.app.genes.decisions, geneReview: async () => ({ pass: true, problems: [] }) };
  f.turn('写第 1 章'); f.turn('人名又前后不一致了', { capture: { correction: true } }); f.turn('写第 3 章', { capture: { approval: true } });
  f.turn('还是不一致', { capture: { correction: true } }); f.turn('打开网页核对资料', { status: 'failed' }); f.turn('好', { capture: { approval: true } });
  const result = await f.app.genes.contrast(f.project.id);
  assert.equal(result.patches.length, 1, JSON.stringify(result.patches));
  assert.equal(f.current().genes.funnel.C.patches_no_counterfactual, 1);
  const patch = f.current().genes.genes.find(row => row.id === result.patches[0].geneId);
  assert.equal(patch.title, '先核对时间线'); assert.match(patch.body.counterfactual, /时间顺序写反/);
  assert.match(patch.origin.quote, /人名又前后不一致了/, 'the review origin is the cited corrections');
});

test('cost rule: a prompt half again as large with four rules recalled many times and never followed makes an analysis focused on merging due', async t => {
  const f = await withGuard(t);
  f.app.genes.enabled = true;
  f.app.store.mutate(state => {
    const project = state.projects.find(row => row.id === f.project.id), registry = project.genes;
    registry.generations = [{ n: 1, at: new Date().toISOString(), promptChars: 1000 }, { n: 2, at: new Date().toISOString(), promptChars: 1650 }];
    for (let index = 0; index < 4; index++) registry.genes.push({ id: `skill-patch:p${index}`, layer: 'skill', key: `p${index}`, title: `规则 ${index}`, summary: 's', status: 'trial', level: 0, stats: { recalled: 9, applied: 0 }, body: { skillId: 'project-workflow' } });
    registry.genes.find(row => row.id === 'guard:guard_nightwatch').body.standardLinkedAt = new Date().toISOString();
  });
  assert.equal(f.app.genes.contrastDue(f.current()), false, 'no trouble: an ordinary analysis is not due');
  assert.equal(f.app.genes.bloatDue(f.current()), true);
  let ran = false;
  for (let attempt = 0; attempt < 4 && !ran; attempt++) { const job = f.app.genes.housekeeping(); if (!job) break; await job(); ran = contrastRequests(f.calls).length > 0; }
  assert.ok(ran, 'idle work reached the focused analysis');
  const input = JSON.parse(contrastRequests(f.calls)[0].messages.find(row => row.role === 'user').content);
  assert.match(input.focus, /165%/); assert.match(input.focus, /merging/);
  assert.equal(f.current().genes.funnel.C.focus_bloat, 1);
  assert.equal(f.app.genes.bloatDue(f.current()), false, 'once a day, like any analysis');
});
