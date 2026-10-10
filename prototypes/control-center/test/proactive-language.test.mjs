import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { ProjectPermissionService } from '../project-permissions.mjs';
import { composeDigest, digestLines } from '../proactive-delivery.mjs';
import { narrate, composeWelcomeBack, resolveThreads, firstLine, untitledThread } from '../proactive-narrator.mjs';
import { directFixTask, directFixDetail, directFixCard } from '../direct-fix-text.mjs';

// F10: text the user reads follows settings.interfaceLanguage; text the model reads is fixed English. With the default
// language (zh) every user-visible string is byte-identical to what shipped before the setting reached these paths.

const CJK = /[一-鿿]/;
const HOUR = 3600000;
const local = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
async function until(check, label = 'condition') { const deadline = Date.now() + 12000; while (Date.now() < deadline) { if (check()) return; await delay(10); } throw new Error(`Timed out: ${label}`); }
const wait = async function* () { yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', content: '', reason: 'No other task', evidenceIds: [], nextReviewAfterMs: 86400000 }) }; yield { type: 'usage', usage: { totalTokens: 0 } }; yield { type: 'done', stopReason: 'stop' }; };

// ------------------------------------------------------------ digest

const digestRows = [{ text: 'Two dependencies have minor updates available. Nothing is urgent.' }, { text: '文档里有三处旧版截图需要更新。其余没有变化。' }];

test('composeDigest: English and Chinese text, one entry or several; digestLines is the same first line the text renders', () => {
  assert.equal(composeDigest(digestRows, 'zh'), '今日摘要（2 条）：\n1. Two dependencies have minor updates available.\n2. 文档里有三处旧版截图需要更新。');
  assert.equal(composeDigest(digestRows, 'en'), 'Today\'s digest (2 items):\n1. Two dependencies have minor updates available.\n2. 文档里有三处旧版截图需要更新。');
  assert.equal(composeDigest(digestRows), composeDigest(digestRows, 'zh'), 'the default stays Chinese');
  assert.equal(composeDigest(digestRows.slice(0, 1), 'zh'), '今日摘要：Two dependencies have minor updates available.');
  assert.equal(composeDigest(digestRows.slice(0, 1), 'en'), 'Today\'s digest: Two dependencies have minor updates available.');
  assert.deepEqual(digestLines(digestRows), ['Two dependencies have minor updates available.', '文档里有三处旧版截图需要更新。']);
  for (const language of ['zh', 'en']) {
    const lines = digestLines(digestRows), text = composeDigest(digestRows, language);
    assert.deepEqual(text.split('\n').slice(1).map(line => line.replace(/^\d+\. /, '')), lines, `${language}: the numbered lines are exactly initiative.lines`);
  }
  assert.ok(!CJK.test(composeDigest(digestRows.slice(0, 1), 'en')), 'an English digest of English entries has no Chinese in it');
});

// ------------------------------------------------------------ welcome-back

const held = [
  { id: 'h1', threadId: 't1', threadTitle: 'Level two regression', text: 'The regression case now passes.', value: .9 },
  { id: 'h2', threadId: 't2', threadTitle: '难度曲线', text: '难度曲线已落地。', value: .8 }];

test('composeWelcomeBack: the header and the quotes follow the language, the topics keep the text the agent wrote', () => {
  const zh = composeWelcomeBack(held, 'zh'), en = composeWelcomeBack(held, 'en');
  assert.equal(zh.text, '你不在时的进展（2 个话题）：\n\n1. 「Level two regression」\nThe regression case now passes.\n\n2. 「难度曲线」\n难度曲线已落地。');
  assert.equal(en.text, 'While you were away (2 topics):\n\n1. "Level two regression"\nThe regression case now passes.\n\n2. "难度曲线"\n难度曲线已落地。');
  assert.equal(composeWelcomeBack(held).text, zh.text, 'the default stays Chinese');
  assert.deepEqual(en.topics, zh.topics, 'structured topics are language-independent');
  assert.equal(composeWelcomeBack(held.slice(0, 1), 'en').text.split('\n')[0], 'While you were away (1 topic):');
});

test('composeWelcomeBack: the overflow line (topics beyond the first five) follows the language and agrees in number', () => {
  const many = count => Array.from({ length: count }, (_, index) => ({ id: `h${index}`, threadId: `t${index}`, threadTitle: `Topic ${index}`, text: `Message ${index}.`, value: 1 - index / 100 }));
  const seven = composeWelcomeBack(many(7), 'en'), six = composeWelcomeBack(many(6), 'en');
  assert.deepEqual([seven.overflowCount, six.overflowCount], [2, 1]);
  assert.match(seven.text, /\n\n2 more messages were filed in the inbox\.$/);
  assert.match(six.text, /\n\n1 more message was filed in the inbox\.$/);
  assert.match(composeWelcomeBack(many(7), 'zh').text, /\n\n另有 2 条放进了收件箱。$/);
  assert.ok(!CJK.test(seven.text), 'an English welcome-back of English topics has no Chinese in it');
});

// ------------------------------------------------------------ thread close

const closable = (extra = {}) => ({ id: 't1', title: 'Level two regression', kind: 'topic', status: 'open', ref: { agendaId: 'a1' }, awaitingUser: true, messageItemIds: ['i0'], messageSessions: {}, held: [], reactions: {}, lastMessageAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...extra });
const withAgenda = (agenda, thread = closable()) => ({ id: 'p', mind: { threads: [thread], agenda: [{ id: 'a1', ...agenda }] } });

test('resolveThreads: the close text follows the language and the row carries title, resolution and status as structured fields', () => {
  const project = withAgenda({ status: 'done', resolvedBy: 'The regression case now passes.' });
  assert.deepEqual(resolveThreads(project, { language: 'en' }), [{ threadId: 't1', close: '"Level two regression" is done: The regression case now passes.', status: 'done', title: 'Level two regression', resolution: 'The regression case now passes.' }]);
  assert.deepEqual(resolveThreads(project, { language: 'zh' }), [{ threadId: 't1', close: '「Level two regression」已完成：The regression case now passes.', status: 'done', title: 'Level two regression', resolution: 'The regression case now passes.' }]);
  assert.deepEqual(resolveThreads(project), resolveThreads(project, { language: 'zh' }), 'the default stays Chinese');
});

test('resolveThreads: without a resolution text the close ends on a full stop and `resolution` is null; `reason` stands in when nothing resolved it', () => {
  const bare = withAgenda({ status: 'resolved' });
  assert.deepEqual(resolveThreads(bare, { language: 'en' }).map(row => [row.close, row.status, row.resolution]), [['"Level two regression" is done.', 'resolved', null]]);
  assert.deepEqual(resolveThreads(bare, { language: 'zh' }).map(row => [row.close, row.status, row.resolution]), [['「Level two regression」已完成。', 'resolved', null]]);
  assert.equal(resolveThreads(withAgenda({ status: 'done', reason: 'Shipped in the last build.' }), { language: 'en' })[0].resolution, 'Shipped in the last build.');
});

test('resolveThreads: title is cut at 30 characters, the same as in the close text, and resolution at 200; no close when nobody waits or the source was dropped', () => {
  const long = withAgenda({ status: 'done', resolvedBy: 'r'.repeat(500) }, closable({ title: 't'.repeat(100) }));
  for (const language of ['zh', 'en']) {
    const [row] = resolveThreads(long, { language });
    assert.ok(row.title.length <= 30 && row.title.startsWith('tttt')); assert.ok(row.resolution.length <= 200 && row.resolution.startsWith('rrrr'));
    assert.ok(row.close.includes(row.title), 'a client rendering from title shows the same title as the text row');
    assert.ok(row.close.length < 30 + 200 + 20, 'the close line stays one short line');
  }
  const quiet = resolveThreads(withAgenda({ status: 'done', resolvedBy: 'Done.' }, closable({ awaitingUser: false })), { language: 'en' });
  assert.deepEqual([quiet[0].close, quiet[0].title, quiet[0].resolution, quiet[0].status], [null, 'Level two regression', 'Done.', 'done'], 'the thread still resolves silently, with its structured facts');
  assert.equal(resolveThreads(withAgenda({ status: 'dropped', reason: 'No longer needed.' }), { language: 'en' })[0].close, null, 'a dropped item is never announced as done');
  assert.deepEqual(resolveThreads(withAgenda({ status: 'open' }), { language: 'en' }), []);
});

test('the new-topic fallback title follows the language through firstLine, and a thread opened by narrate gets the language\'s label', async () => {
  assert.deepEqual([untitledThread(), untitledThread('zh'), untitledThread('en')], ['新话题', '新话题', 'New topic']);
  assert.equal(firstLine('   '), '新话题'); assert.equal(firstLine('   ', 60, untitledThread('en')), 'New topic'); assert.equal(firstLine('# Heading\nbody', 60, untitledThread('en')), 'Heading');
  const now = Date.parse('2026-09-28T10:00:00Z');
  for (const [language, title] of [['en', 'New topic'], ['zh', '新话题']]) {
    const project = { id: 'p', inbox: [], mind: {} }, plan = await narrate({ project, sessions: [{ id: 's', items: [] }], candidate: { kind: 'share', text: '---', evidenceIds: ['e1'] }, now, language });
    assert.equal(plan.thread.title, title, `${language}: a message with no usable first line opens a thread with the language's label`);
  }
  const titled = await narrate({ project: { id: 'p', inbox: [], mind: {} }, sessions: [{ id: 's', items: [] }], candidate: { kind: 'share', text: '# Heading\nBody of the message.', evidenceIds: ['e1'] }, now, language: 'en' });
  assert.equal(titled.thread.title, 'Heading', 'a message with a first line titles its own thread in either language');
});

// ------------------------------------------------------------ direct fix

test('directFixTask: the worker model reads English whatever the interface language, and is told which language to report in', () => {
  const finding = 'Section 2 says the limit is 30 but section 5 says 40.';
  for (const language of ['zh', 'en']) assert.ok(!CJK.test(directFixTask(finding, language)), `${language}: no Chinese in what the model reads`);
  assert.ok(!CJK.test(directFixTask(finding)), 'the default too');
  assert.match(directFixTask(finding, 'en'), /report written in English:/);
  assert.match(directFixTask(finding, 'zh'), /report written in Simplified Chinese:/);
  assert.match(directFixTask(finding), /report written in Simplified Chinese:/);
  for (const language of ['zh', 'en']) assert.ok(directFixTask(finding, language).endsWith(`\n\nBackground finding:\n${finding}`), 'the finding rides along verbatim at the end');
  assert.ok(directFixTask('第二节写的上限是 30，第五节写的是 40。', 'zh').endsWith('第二节写的上限是 30，第五节写的是 40。'), 'a Chinese finding is passed through untouched');
  assert.match(directFixTask(finding, 'en'), /project_edit \/ project_write/);
});

test('directFixDetail: the worker report, file list, marks and the revert caveat follow the language; zh stays byte-identical', () => {
  const files = [{ path: 'docs/a.md', mark: null }, { path: 'docs/b.md', mark: 'new' }, { path: 'docs/c.md', mark: 'deleted' }];
  assert.equal(directFixDetail({ report: '改了三处。', files, skipped: ['x.bin', 'y.bin'], language: 'zh' }),
    '改了三处。\n\n修改的文件：\n- docs/a.md\n- docs/b.md（新建）\n- docs/c.md（删除）\n\n另有 2 个文件改动未留快照，回退时不会还原：x.bin、y.bin');
  assert.equal(directFixDetail({ report: 'Fixed three places.', files, skipped: ['x.bin', 'y.bin'], language: 'en' }),
    'Fixed three places.\n\nChanged files:\n- docs/a.md\n- docs/b.md (new)\n- docs/c.md (deleted)\n\n2 more changed files have no snapshot and will not be restored on revert: x.bin, y.bin');
  assert.match(directFixDetail({ files: [], skipped: ['x.bin'], language: 'en' }), /1 more changed file has no snapshot/);
  assert.equal(directFixDetail({ files: [{ path: 'a.md' }] }), '已按后台结论完成修正。\n\n修改的文件：\n- a.md', 'no report: the one-line fallback, Chinese by default');
  assert.equal(directFixDetail({ files: [{ path: 'a.md' }], language: 'en' }), 'The fixes from the background finding are done.\n\nChanged files:\n- a.md');
  assert.equal(directFixDetail({ report: 'ok', secret: 'Some content was not applied.', language: 'en' }).split('\n').at(-1), 'Some content was not applied.');
  assert.equal(directFixDetail({ report: 'x'.repeat(9000) }).length, 8000);
});

test('directFixCard: header, question and option labels follow the language; the option ids are the contract in both', () => {
  const detail = 'Fixed.\n\nChanged files:\n- a.md';
  const zh = directFixCard({ count: 2, detail, language: 'zh' }), en = directFixCard({ count: 2, detail, language: 'en' });
  assert.deepEqual([zh.id, zh.header, zh.question, zh.detail, zh.allowCustom], ['decision', '已直接处理', '我发现了几处明确的问题，已经直接修正（2 个文件）。要保留这些修改吗？', detail, true]);
  assert.deepEqual(zh.options, [{ id: 'keep', label: '确认保留' }, { id: 'revert', label: '回退这些修改', description: '把 2 个文件还原到修改前' }]);
  assert.deepEqual([en.id, en.header, en.question, en.detail, en.allowCustom], ['decision', 'Handled directly', 'I found a few clear-cut problems and fixed them directly (2 files). Keep these changes?', detail, true]);
  assert.deepEqual(en.options, [{ id: 'keep', label: 'Keep changes' }, { id: 'revert', label: 'Revert these changes', description: 'Restore 2 files to how they were before' }]);
  assert.deepEqual(directFixCard({ count: 1, detail }), directFixCard({ count: 1, detail, language: 'zh' }), 'the default stays Chinese');
  assert.match(directFixCard({ count: 1, detail, language: 'en' }).question, /\(1 file\)/);
  assert.match(directFixCard({ count: 1, detail, language: 'en' }).options[1].description, /^Restore 1 file to/);
});

// ------------------------------------------------------------ permission card

test('the permission card is the user\'s to read: it follows the interface language, with the ids `allow` and `deny` unchanged', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-proactive-language-permissions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'state.json')), { project } = store.createProject({ rhythm: { control: 'manual' }, name: 'Permission fixture', description: 'A generic project', workspace: directory });
  store.mutate(state => { const target = state.projects.find(row => row.id === project.id); target.permissions = { workspace: 'read', background: 'read', revision: 1 }; });
  const service = new ProjectPermissionService(store, null), input = { workspace: 'write', background: 'inherit', reason: 'Drafting needs to edit files.' };
  const [zh] = service.request(project.id, input).questions, [en] = service.request(project.id, input, { language: 'en' }).questions;
  assert.deepEqual([zh.header, zh.question], ['项目权限', '是否允许此项目使用以下权限？']);
  assert.match(zh.detail, /目录：.*\n申请：读写项目文件；后台自主工作也使用此权限$/);
  assert.deepEqual(zh.options.map(row => [row.id, row.label]), [['allow', '允许此项目使用'], ['deny', '保持现有权限']]);
  assert.deepEqual([en.header, en.question], ['Project permissions', 'Allow this project to use the following permissions?']);
  assert.match(en.detail, /^Drafting needs to edit files\.\nFolder: .*\nRequested: Read and write project files; background autonomous work uses this permission too$/);
  assert.deepEqual(en.options.map(row => [row.id, row.label]), [['allow', 'Allow for this project'], ['deny', 'Keep current permissions']]);
  assert.equal(en.options[0].description, 'Read and write project files; background autonomous work uses this permission too');
  assert.equal(en.options[1].description, 'Permissions stay as they are, and the restricted action is not carried out.');
  store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  assert.equal(service.request(project.id, input).questions[0].header, 'Project permissions', 'without an explicit language the saved interface language applies');
  assert.equal(service.request(project.id, { ...input, background: 'read' }, { language: 'en' }).questions[0].options[0].description, 'Read and write project files; background work stays read-only');
  assert.equal(service.request(project.id, { ...input, workspace: 'execute' }, { language: 'en' }).questions[0].options[0].description, 'Read and write project files and run commands; background autonomous work uses this permission too');
});

// ------------------------------------------------------------ the controller's delivery paths

/** A project with one session, a controller on a clock the test owns, and the interface language set in settings. */
async function fixture(t, { language, now }) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-proactive-language-'));
  const store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Isolated fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 3000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Language fixture', description: 'A generic project', workspace: directory, initiative: { cooldownMs: 0, digestHour: 9 } });
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id); target.decisionMode = 'rna-model'; target.simulated = false; target.initialization = { status: 'ready' }; target.assignments = { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] }; target.initiative.tokenBudget = 200000; state.settings.realTokenBudget = null;
    if (language) state.settings.interfaceLanguage = language;
  });
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, feedbackCheckIntervalMs: 0, decisionProvider: wait, now });
  t.after(async () => { await controller.close(); rmSync(directory, { recursive: true, force: true }); });
  await until(() => controller.contexts.size === 1, 'initiative context');
  const current = () => store.state.projects.find(row => row.id === project.id);
  return { store, controller, project, session, current, context: () => controller.contexts.get(project.id), messages: () => store.state.sessions.find(row => row.id === session.id).items.filter(item => item.source === 'initiative') };
}

for (const [language, header] of [['en', 'Today\'s digest (2 items):'], ['zh', '今日摘要（2 条）：']]) {
  test(`the digest message is host-authored in the interface language (${language}) and carries initiative.lines`, async t => {
    let clock = local(28, 10);
    const f = await fixture(t, { language, now: () => clock });
    const signal = new AbortController().signal, context = f.context();
    for (const [id, content] of [['d1', 'Two dependencies have minor updates available.'], ['d2', 'The old screenshots in the docs need replacing.']]) assert.equal((await f.controller.share(context, { id, intentKey: id, revision: context.coordinator.state.revision, urgency: 'digest', content, evidenceIds: [] }, { signal })).reach, 'digest');
    f.controller.deliveryUpkeep(context); assert.equal(f.messages().length, 0, 'held until the digest hour');
    clock = local(29, 9, 1); f.controller.deliveryUpkeep(context); f.controller.deliveryUpkeep(context);
    assert.equal(f.messages().length, 1, 'delivered once');
    const [digest] = f.messages();
    assert.equal(digest.text, `${header}\n1. Two dependencies have minor updates available.\n2. The old screenshots in the docs need replacing.`);
    assert.deepEqual([digest.initiative.kind, digest.initiative.reach, digest.initiative.lines], ['digest', 'digest', ['Two dependencies have minor updates available.', 'The old screenshots in the docs need replacing.']]);
    assert.equal(digest.initiative.entryIds.length, 2);
    assert.deepEqual(digest.text.split('\n').slice(1).map(line => line.replace(/^\d+\. /, '')), digest.initiative.lines, 'a client reads the list from lines, never from the language-dependent header');
  });
}

for (const [language, expected] of [['en', { close: '"Level two regression" is done: The regression case now passes.' }], ['zh', { close: '「Level two regression」已完成：The regression case now passes.' }]]) {
  test(`a thread close is written in the interface language (${language}) and carries title, resolution and status`, async t => {
    const now = local(28, 15), clock = () => now;
    const f = await fixture(t, { language, now: clock });
    const at = ms => new Date(now - ms).toISOString();
    f.store.mutate(state => {
      state.sessions.find(row => row.id === f.session.id).items.push({ id: 'u0', kind: 'user', text: 'Please fix level two.', createdAt: at(HOUR) }, { id: 'i0', kind: 'assistant', source: 'initiative', text: 'Which regression case should I add?', createdAt: at(HOUR / 2) });
      const target = state.projects.find(row => row.id === f.project.id);
      target.mind = { ...(target.mind ?? {}), threads: [closable({ createdAt: at(2 * HOUR), updatedAt: at(HOUR / 2), lastMessageAt: at(HOUR / 2) })], agenda: [{ id: 'a1', status: 'done', resolvedBy: 'The regression case now passes.' }] };
    });
    f.store.presences.set(f.project.id, { receiptId: 'r', sessionId: f.session.id, typing: false, visible: true, at: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString() });
    f.controller.narratorUpkeep(f.context());
    const closes = f.messages().filter(item => item.initiative?.kind === 'thread_close');
    assert.equal(closes.length, 1, 'one close message');
    assert.equal(closes[0].text, expected.close);
    assert.deepEqual({ ...closes[0].initiative }, { kind: 'thread_close', reach: 'inline', threadId: 't1', title: 'Level two regression', resolution: 'The regression case now passes.', status: 'done' });
    assert.equal(f.current().mind.threads[0].status, 'resolved');
  });
}
