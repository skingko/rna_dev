import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';
import { ProjectPermissionService } from '../project-permissions.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { MediaToolsService } from '../media-tools-service.mjs';
import { renderProjectInstructions } from '../project-instructions.mjs';
import { SCHEDULE_TEXT_V1 } from '../schedule-prompt.mjs';
import { HOST_HANDOFF, deadlineText, excerptHandoff, runOutcomeText, unreportedText, workerSystemPrompt } from '../work-run-text.mjs';
import { agendaForUser, agendaModelText, agendaUserText, evolutionRequestText } from '../agenda-text.mjs';

// Model-visible text is fixed English; what the model writes for the user is written in the interface language (the
// instruction naming it is in the worker prompt, the foreground prompt and the permission tool). Text the user reads
// stays in the interface language, and the Chinese is what it always was, byte for byte.
const cjk = /[㐀-鿿　-〿＀-￯]/;

test('the host-written failure handoffs are English, and the web hides exactly the lines that start like them', () => {
  const lines = [HOST_HANDOFF.versionWithdrawn('t'), HOST_HANDOFF.control('t', false), HOST_HANDOFF.control('t', true), HOST_HANDOFF.unconfirmed('code_x', 't'), HOST_HANDOFF.interrupted('t'), HOST_HANDOFF.unfinished('code_x', 't', 'because'), deadlineText({ task: 't', deadlineMs: 600000, language: 'zh', code: 'code_x', toolUnfinished: true }).handoff];
  const web = readFileSync(new URL('../web/src/lib/task-failure.ts', import.meta.url), 'utf8');
  for (const line of lines) {
    assert.doesNotMatch(line, cjk, line);
    const head = line.match(/^[A-Za-z ]+(?: \(|: )/)?.[0];
    assert.ok(head && web.includes(head.replace('(', '\\(')), `the web hide filter lists "${head}" for: ${line}`);
  }
  // The same wording whatever the interface language: the user never sees these lines.
  assert.equal(deadlineText({ task: 't', deadlineMs: 600000, language: 'en', code: 'c', toolUnfinished: true }).handoff, deadlineText({ task: 't', deadlineMs: 600000, language: 'zh', code: 'c', toolUnfinished: true }).handoff);
});

test('what the user reads about a stopped or unreported run follows the interface language; the Chinese is unchanged', () => {
  const zh = runOutcomeText({ language: 'zh', code: 'run_failed', message: '原因' }), en = runOutcomeText({ language: 'en', code: 'run_failed', message: 'reason' });
  assert.equal(zh.stopped, '后台工作已停止，已完成的操作和结果保留。');
  assert.equal(zh.paused, '后台工作已在执行边界暂停，继续时接续原记录。');
  assert.equal(zh.unfinished, '后台检查未完成（run_failed）：原因');
  assert.equal(zh.learnUnfinished, '学习候选生成未完成（run_failed）：原因；没有应用项目变更。');
  assert.equal(zh.unconfirmed, '后台检查存在未决外部执行（run_failed）：需核对副作用后明确确认；不会在新会话中重放。');
  for (const key of Object.keys(en)) assert.doesNotMatch(en[key], cjk, key);
  assert.equal(en.unfinished, 'The background check did not finish (run_failed): reason');
  assert.equal(excerptHandoff('结果在 a.md', 'zh'), '已完成：结果在 a.md（宿主摘录，未含工作者交接）');
  assert.equal(excerptHandoff('result in a.md', 'en'), 'Completed: result in a.md (host excerpt; the worker left no handoff)');
  const unreportedZh = unreportedText({ task: '整理', language: 'zh' }), unreportedEn = unreportedText({ task: 'tidy up', language: 'en' });
  assert.ok(unreportedZh.summary.startsWith('未交接：') && unreportedZh.handoff.startsWith('未交接：整理；'));
  assert.ok(unreportedEn.summary.startsWith('Unreported: ') && unreportedEn.handoff.startsWith('Unreported: tidy up; '));
  assert.doesNotMatch(`${unreportedEn.summary}${unreportedEn.handoff}`, cjk);
});

test('the worker prompt is English, asks for the HANDOFF: line, and names the interface language for what the user reads', () => {
  for (const level of ['read', 'write', 'execute']) for (const [language, name] of [['zh', 'Simplified Chinese'], ['en', 'English']]) {
    const prompt = workerSystemPrompt({ level, language });
    assert.doesNotMatch(prompt, cjk);
    assert.ok(prompt.includes(`Host authorization level: ${level}`) && prompt.includes('starts with "HANDOFF:"'));
    assert.ok(prompt.includes(`is written in ${name}, whatever language this prompt or the task is in`), language);
  }
  assert.ok(workerSystemPrompt({ level: 'read' }).includes('Simplified Chinese'), 'no language given: the default interface language');
});

test('an evolution request is stored with the English prefix and shown with the interface language; older rows and edited rows are handled', () => {
  assert.equal(evolutionRequestText('make replies shorter'), 'Evolution request: make replies shorter');
  const row = { id: 'a', text: evolutionRequestText('更短的回复'), source: { from: 'evolution_request' } }, legacy = { id: 'b', text: '进化请求：更短的回复', source: { from: 'evolution_request' } }, edited = { id: 'c', text: '改过的文字', source: { from: 'evolution_request' } }, plain = { id: 'd', text: '进化请求：用户自己写的', source: { from: 'user' } };
  assert.equal(agendaModelText(row), 'Evolution request: 更短的回复');
  assert.equal(agendaModelText(legacy), 'Evolution request: 更短的回复', 'a row from before reads as English to the model');
  assert.equal(agendaUserText(row, 'zh'), '进化请求：更短的回复');
  assert.equal(agendaUserText(row, 'en'), 'Evolution request: 更短的回复');
  assert.equal(agendaUserText(legacy, 'zh'), '进化请求：更短的回复');
  assert.equal(agendaUserText(legacy, 'en'), 'Evolution request: 更短的回复');
  assert.equal(agendaForUser(legacy, 'zh'), legacy, 'nothing to change: the row itself');
  for (const left of [edited, plain]) { assert.equal(agendaModelText(left), left.text); assert.equal(agendaUserText(left, 'en'), left.text); assert.equal(agendaForUser(left, 'en'), left); }
});

test('the permission request tool and the media tools are declared in English', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-model-text-')), store = new Store(join(dir, 'state.json'));
  const { project, session } = store.createProject({ name: 'Permissions', workspace: dir });
  const interactions = new UserInteractionService(store), permissions = new ProjectPermissionService(store, interactions);
  t.after(() => { interactions.close(); rmSync(dir, { recursive: true, force: true }); });
  const [tool] = permissions.createTools({ projectId: project.id, sessionId: session.id, turnId: 'turn-fixture' });
  assert.equal(tool.name, 'request_project_permission');
  assert.doesNotMatch(JSON.stringify({ description: tool.description, parameters: tool.parameters }), cjk);
  assert.match(tool.description, /The reason is shown to the user on the card: write it in Simplified Chinese\./, 'the reason the user reads is written in the interface language (zh by default)');
  store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  assert.match(permissions.createTools({ projectId: project.id, sessionId: session.id, turnId: 'turn-fixture' })[0].description, /write it in English\./);
  const provider = store.configurationService.provider(null, { name: 'Media', protocol: 'openai', baseUrl: 'https://media.example.test/v1', apiKey: 'sk-synthetic-media', models: [] });
  store.configurationService.update({ media: { image: { providerId: provider.id, modelId: 'img' }, speech: { providerId: provider.id, modelId: 'tts' }, transcription: { providerId: provider.id, modelId: 'whisper-1' }, video: { providerId: provider.id, modelId: 'sora-2', api: 'openai' } } });
  const media = new MediaToolsService(store).declarations();
  assert.ok(media.length >= 3);
  for (const declaration of media) assert.doesNotMatch(JSON.stringify({ description: declaration.description, parameters: declaration.parameters }), cjk, declaration.name);
});

test('the foreground system prompt, the project instruction wrapper and the tool declarations are English; only the frozen v1 schedule paragraph is Chinese', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-model-text-fg-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'Research', workspace: dir });
  const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 64000, maxOutputTokens: 1000, execution: 'rna' };
  const request = async language => {
    store.mutate(state => { state.settings.interfaceLanguage = language; });
    let seen;
    const handle = await createRnaRuntime({ project: store.state.projects.find(row => row.id === project.id), getProject: () => store.state.projects.find(row => row.id === project.id), projectId: project.id, capabilityService: new CapabilityService(store), cwd: dir, stateDir: join(dir, `rt-${language}`), sessionId: `s-${language}`, model,
      provider: async function* (input) { seen = input; yield { type: 'text_delta', delta: 'ok' }; yield { type: 'usage', usage: { input: 1, output: 1, totalTokens: 2 } }; yield { type: 'done', stopReason: 'stop' }; } });
    try { await handle.prompt('hello'); } finally { await handle.dispose?.(); }
    return seen;
  };
  const zh = await request('zh'), en = await request('en');
  // v1 (the default) keeps its Chinese schedule paragraph byte for byte (the replay baseline); everything around it is English.
  assert.ok(zh.systemPrompt.includes(SCHEDULE_TEXT_V1.foreground));
  assert.doesNotMatch(zh.systemPrompt.replace(SCHEDULE_TEXT_V1.foreground, ''), cjk);
  assert.ok(zh.systemPrompt.includes('(the interface language the user chose)') && zh.systemPrompt.includes('Simplified Chinese'));
  assert.ok(en.systemPrompt.includes('English (the interface language the user chose)'));
  for (const seen of [zh, en]) for (const tool of seen.tools) assert.doesNotMatch(tool.description, cjk, tool.name);
  store.configurationService.update({ schedulePromptVersion: 'v2' });
  assert.doesNotMatch((await request('zh')).systemPrompt, cjk, 'under v2 the whole prompt is English');
  const instructions = renderProjectInstructions({ name: 'AGENTS.md', content: '请用中文回答。', truncated: true });
  assert.doesNotMatch(instructions.replace('请用中文回答。', ''), cjk, "only the user's own file content is Chinese");
});
