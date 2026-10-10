import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { projectInitiativeAvailability } from '../project-initiative-availability.mjs';
import { geneTree, geneDetail, skillLabel, userRetireNote } from '../project-genes.mjs';
import { createGeneRoutes } from '../gene-routes.mjs';
import { assembleProjectBootstrap, isBootstrapWorkflowSkill, PROJECT_WORKFLOW_DESCRIPTION } from '../../../packages/sdk/src/bootstrap-lite.mjs';

// UX audit 2026-10-03 (texts): host-written text follows the interface language, and host
// defaults the user never wrote (the bootstrap skill's English name, fixed history notes) read as the app's own words.

test('admission titles and messages follow the interface language; reasons and details are unchanged', () => {
  const project = { id: 'p', initiative: { enabled: true }, decisionMode: 'rna-model', initialization: { status: 'ready' } };
  const state = { configuration: {}, settings: { interfaceLanguage: 'en' }, sessionDeletions: [{ projectId: 'p', localStatus: 'pending', attempts: 2, code: 'SESSION_EVIDENCE_JOURNAL_UNKNOWN' }] };
  const english = projectInitiativeAvailability(state, project, { modelResolver: () => ({ execution: 'rna' }) });
  assert.equal(english.reason, 'session_cleanup_pending'); assert.equal(english.title, 'Background paused · session cleanup pending');
  assert.match(english.message, /^Data linked to a deleted conversation/); assert.deepEqual(english.details.codes, ['SESSION_EVIDENCE_JOURNAL_UNKNOWN']);
  state.settings.interfaceLanguage = 'zh';
  assert.equal(projectInitiativeAvailability(state, project, { modelResolver: () => ({ execution: 'rna' }) }).title, '后台暂缓 · 会话清理待完成');
  state.sessionDeletions = []; state.settings = {};
  assert.equal(projectInitiativeAvailability(state, project, { modelResolver() { throw new Error('x'); } }).title, '后台等待可用模型', 'unset language is Chinese');
  state.settings.interfaceLanguage = 'en';
  for (const [resolver, reason] of [[() => { throw Object.assign(new Error('x'), { code: 'interactive_subscription_only' }); }, 'interactive_subscription_only'], [() => ({ execution: 'simulation' }), 'real_model_required'], [() => ({ execution: 'rna' }), 'admitted']]) {
    const value = projectInitiativeAvailability(state, project, { modelResolver: resolver });
    assert.equal(value.reason, reason); assert.doesNotMatch(`${value.title}${value.message}`, /[一-鿿]/, reason);
  }
  state.emergency = true; const off = projectInitiativeAvailability(state, project);
  assert.deepEqual([off.state, off.reason, off.title, off.message], ['disabled', 'emergency', 'Emergency stop is on', 'Emergency stop is on']);
});

const brief = { overview: 'o', focus: 'f', facts: [], openQuestions: [], milestones: [], charter: 'c', workflow: '1. 读设定 2. 写章节', criteria: [{ id: 'c1', description: '一致' }], sampleTasks: [], skillQueries: ['x'], catalogSkillIds: [], mcpServerIds: [], reasons: [], unmetCapabilities: [] };
const projectWith = (genome, genes = []) => ({ id: 'p', name: '玄幻小说撰写项目', activeVersionId: 'v', versions: [{ id: 'v', bundle: { genome } }], genes: { genes, generations: [] } });
const skillOf = (tree, id) => tree.strands.find(row => row.layer === 'skill').genes.find(row => row.id === id);

test('the bootstrap workflow skill reads as the host\'s own words in the interface language, never "<project> workflow" with an English original', () => {
  const genome = assembleProjectBootstrap(brief, {}, { title: '玄幻小说撰写项目' }).genome;
  assert.equal(genome.skills[0].name, '玄幻小说撰写项目 workflow', 'the model-facing name is unchanged');
  assert.equal(isBootstrapWorkflowSkill(genome.skills[0]), true);
  assert.deepEqual([skillLabel(genome.skills[0]), skillLabel(genome.skills[0], 'en'), skillLabel({ id: 'x', name: 'novel-writing', description: 'd' }, 'en')], ['项目做法', 'Project workflow', 'novel-writing']);
  // A zh one-liner the summary service once wrote for the English description no longer surfaces the English under it.
  const project = projectWith(genome, [{ id: 'skill:project-workflow', layer: 'skill', key: 'project-workflow', plainSummaries: { zh: '本项目的工作方法' }, history: [] }]);
  const zh = skillOf(geneTree(project, { language: 'zh' }), 'skill:project-workflow');
  assert.equal(zh.title, '项目做法'); assert.match(zh.summary, /^这个项目的做事方法/); assert.equal(zh.original, undefined); assert.equal(zh.hostText, undefined);
  const en = skillOf(geneTree(project, { language: 'en' }), 'skill:project-workflow');
  assert.equal(en.title, 'Project workflow'); assert.equal(en.original, undefined); assert.doesNotMatch(en.summary, /[一-鿿]/);
  assert.equal(geneDetail(project, 'skill:project-workflow', { language: 'en' }).content.name, '玄幻小说撰写项目 workflow', 'the full skill keeps its real name');
  // Once the description is the project's own (rewritten, merged), it is shown as written.
  const own = projectWith({ ...genome, skills: [{ ...genome.skills[0], description: '章节写作流程' }] });
  assert.deepEqual([skillOf(geneTree(own), 'skill:project-workflow').title, skillOf(geneTree(own), 'skill:project-workflow').summary], ['玄幻小说撰写项目 workflow', '章节写作流程']);
  // A user rewrite of the summary still wins.
  project.genes.genes[0].summary = '我自己的说明';
  assert.equal(skillOf(geneTree(project, { language: 'en' }), 'skill:project-workflow').summary, '我自己的说明');
  assert.notEqual(PROJECT_WORKFLOW_DESCRIPTION, '');
});

test('history notes the host wrote read in the current language; a resolved system problem reads confirmed by you', () => {
  const system = { id: 'system:web_fetch', layer: 'system', key: 'web_fetch', title: 'web_fetch 抓取失败', summary: 's', level: 0, status: 'retired', body: { count: 2 },
    history: [{ at: '2026-10-01T00:00:00Z', status: 'active', note: 'Found by contrast analysis' }, { at: '2026-10-02T00:00:00Z', status: 'retired', note: '用户停用' }, { at: '2026-10-02T00:00:01Z', status: 'retired', note: '与「x」重复' }] };
  const guard = { id: 'guard:g', layer: 'guard', key: 'g', title: 'g', summary: 's', level: 0, status: 'retired', history: [{ at: '2026-10-02T00:00:00Z', status: 'retired', note: '用户停用' }] };
  const project = { id: 'p', genes: { genes: [system, guard], generations: [] } };
  const view = (language, id) => geneTree(project, { language }).strands.flatMap(row => row.genes).find(row => row.id === id);
  assert.deepEqual(view('zh', 'system:web_fetch').history.map(row => row.note), ['对照分析发现', '由你确认', '与「x」重复']);
  assert.deepEqual(view('en', 'system:web_fetch').history.map(row => row.note), ['Found by contrast analysis', 'Confirmed by you', '与「x」重复']);
  assert.deepEqual(view('en', 'guard:g').history.map(row => row.note), ['Retired by the user']);
  assert.equal(system.history[1].note, '用户停用', 'the stored record is not rewritten');
  assert.deepEqual([userRetireNote('system', 'zh'), userRetireNote('guard', 'en')], ['由你确认', 'Retired by the user']);
});

test('the revoke route writes a layer-aware note in the interface language', async () => {
  const project = { id: 'p1', genes: { genes: [{ id: 'system:web_fetch', layer: 'system', key: 'web_fetch', status: 'active' }, { id: 'guard:g', layer: 'guard', key: 'g', status: 'active' }], generations: [] } };
  const store = { state: { projects: [project], settings: { interfaceLanguage: 'en' }, revision: 3 } }, reasons = [];
  const handle = createGeneRoutes({ store, body: async () => ({ action: 'revoke' }), genes: { retireByUser: async (_projectId, geneId, reason) => { reasons.push([geneId, reason]); return { versionId: null, generation: null }; } } });
  const sent = [];
  for (const id of ['system:web_fetch', 'guard:g']) assert.equal(await handle({ method: 'POST' }, { pathname: `/api/v2/projects/p1/genes/${encodeURIComponent(id)}`, send: (status, value) => sent.push([status, value]) }), true);
  assert.deepEqual(reasons, [['system:web_fetch', 'Confirmed by you'], ['guard:g', 'Retired by the user']]);
  assert.deepEqual(sent.map(([status]) => status), [200, 200]);
});

test('the desktop directory picker takes its title from the interface language when it opens', async () => {
  const { installDirectoryPicker } = createRequire(import.meta.url)('../desktop/directory-picker.cjs');
  const frame = { url: 'http://127.0.0.1:4317/' }, contents = { mainFrame: frame }, titles = [];
  let handler, language = 'zh';
  installDirectoryPicker({ window: { webContents: contents, isDestroyed: () => false }, origin: 'http://127.0.0.1:4317', title: () => (language === 'en' ? 'Open Project Folder' : '打开项目目录'),
    ipcMain: { handle: (_, fn) => { handler = fn; } }, dialog: { showOpenDialog: async (_window, options) => { titles.push(options.title); return { canceled: true, filePaths: [] }; } } });
  await handler({ sender: contents, senderFrame: frame }); language = 'en'; await handler({ sender: contents, senderFrame: frame });
  assert.deepEqual(titles, ['打开项目目录', 'Open Project Folder']);
});
