import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { DirectFixRecorder } from '../direct-fix-store.mjs';

// Plan §4.4: background writes are snapshotted, kept by default, reported in
// one line, and revertible in one click without overwriting later edits.
function host(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rna-bgchange-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, '.state', 'state.json'));
  const { project, session } = store.createProject({ name: 'Novel', workspace: dir, initiative: { enabled: false } });
  const self = Object.create(ProjectInitiativeController.prototype);
  Object.assign(self, { store, now: () => Date.now(), project: id => store.state.projects.find(row => row.id === id), presenceFor: () => ({ session: store.state.sessions.find(row => row.id === session.id) }), mutate: fn => store.mutate(fn) });
  return { dir, store, self, projectId: project.id, sessionId: session.id };
}

test('a background change set is kept, reported once in the conversation, and reverts only files nobody changed since', t => {
  const f = host(t);
  writeFileSync(join(f.dir, 'ch1.md'), '第一章 原文\n'); writeFileSync(join(f.dir, 'ch2.md'), '第二章 原文\n');
  const recorder = new DirectFixRecorder(f.dir);
  for (const path of ['ch1.md', 'ch2.md', 'ch3.md']) recorder.capture(path);
  writeFileSync(join(f.dir, 'ch1.md'), '第一章 后台改过\n'); writeFileSync(join(f.dir, 'ch2.md'), '第二章 后台改过\n'); writeFileSync(join(f.dir, 'ch3.md'), '第三章 新建\n');
  const id = f.self.keepBackgroundChanges({ projectId: f.projectId }, { id: 'act-1' }, recorder);
  const project = f.store.state.projects.find(row => row.id === f.projectId), change = project.backgroundChanges[0];
  assert.equal(change.id, id); assert.equal(change.status, 'kept'); assert.deepEqual(change.files.map(row => row.path).sort(), ['ch1.md', 'ch2.md', 'ch3.md']);
  const line = f.store.state.sessions.find(row => row.id === f.sessionId).items.at(-1);
  assert.match(line.text, /^后台改了 3 个文件，改动都在下面/); assert.equal(line.initiative.backgroundChange, id);
  // The deliverables under that line: every file's before and after, for its diff and preview.
  const detail = f.self.backgroundChangeDetail(f.projectId, id), byPath = Object.fromEntries(detail.files.map(row => [row.path, row]));
  assert.deepEqual([byPath['ch1.md'].before, byPath['ch1.md'].after, byPath['ch1.md'].created], ['第一章 原文\n', '第一章 后台改过\n', false]);
  assert.deepEqual([byPath['ch3.md'].before, byPath['ch3.md'].after, byPath['ch3.md'].created], [null, '第三章 新建\n', true]);
  // The user edits ch2 afterwards: that file is left alone on revert.
  writeFileSync(join(f.dir, 'ch2.md'), '第二章 用户又改了\n');
  const later = f.self.backgroundChangeDetail(f.projectId, id).files.find(row => row.path === 'ch2.md');
  assert.equal(later.after, '第二章 后台改过\n', 'the diff shows what the work did, not the later edit'); assert.equal(later.changedSince, true);
  const result = f.self.revertBackgroundChange(f.projectId, id);
  assert.deepEqual(result.outcome.restored.sort(), ['ch1.md', 'ch3.md']); assert.deepEqual(result.outcome.conflicts, ['ch2.md']);
  assert.equal(readFileSync(join(f.dir, 'ch1.md'), 'utf8'), '第一章 原文\n'); assert.equal(existsSync(join(f.dir, 'ch3.md')), false); assert.equal(readFileSync(join(f.dir, 'ch2.md'), 'utf8'), '第二章 用户又改了\n');
  assert.equal(f.store.state.projects.find(row => row.id === f.projectId).backgroundChanges[0].status, 'reverted');
  assert.match(f.store.state.sessions.find(row => row.id === f.sessionId).items.at(-1).text, /已回退 2 个文件[\s\S]*ch2\.md 之后又被改过/);
  assert.equal(f.self.revertBackgroundChange(f.projectId, id).status, 'reverted', 'a second revert does nothing');
  assert.throws(() => f.self.revertBackgroundChange(f.projectId, 'nope'), /不存在/);
  assert.deepEqual(f.self.backgroundChangeDetail(f.projectId, id).files.map(row => [row.path, row.available]).sort(), [['ch1.md', false], ['ch2.md', false], ['ch3.md', false]], 'reverted: snapshots are gone, the list stays');
});

test('the line follows the interface language; binary files are listed without their bytes', t => {
  const f = host(t); f.store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  writeFileSync(join(f.dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  const recorder = new DirectFixRecorder(f.dir); recorder.capture('logo.png');
  writeFileSync(join(f.dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 3, 4]));
  const id = f.self.keepBackgroundChanges({ projectId: f.projectId }, { id: 'act-3' }, recorder);
  assert.match(f.store.state.sessions.find(row => row.id === f.sessionId).items.at(-1).text, /^Background work changed 1 file;/);
  const [file] = f.self.backgroundChangeDetail(f.projectId, id).files;
  assert.deepEqual([file.binary, file.before, file.after, file.available], [true, null, null, true]);
});

test('nothing changed: no change set, no line', t => {
  const f = host(t);
  writeFileSync(join(f.dir, 'a.md'), 'x\n');
  const recorder = new DirectFixRecorder(f.dir); recorder.capture('a.md');
  assert.equal(f.self.keepBackgroundChanges({ projectId: f.projectId }, { id: 'act-2' }, recorder), null);
  assert.equal(f.store.state.projects.find(row => row.id === f.projectId).backgroundChanges, undefined);
});

test('the line says what the work did: the worker handoff, else the task; a run stopped on an unsent call says it left no report', t => {
  const f = host(t);
  const change = (id, result) => {
    writeFileSync(join(f.dir, `${id}.md`), 'before\n');
    const recorder = new DirectFixRecorder(f.dir); recorder.capture(`${id}.md`); writeFileSync(join(f.dir, `${id}.md`), 'after\n');
    f.self.keepBackgroundChanges({ projectId: f.projectId }, { id, content: '给第1章补一段结尾。然后逐处核对 E3 人名。' }, recorder, result);
    return f.store.state.sessions.find(row => row.id === f.sessionId).items.at(-1).text;
  };
  assert.equal(change('reported', { summary: '长汇报……', reported: '已给第1章补了结尾段，人名核对留到下一轮。' }), '已给第1章补了结尾段，人名核对留到下一轮。\n\n改了 1 个文件，改动都在下面，可以逐个查看；需要的话可以一键回退。');
  assert.equal(change('silent', { summary: '写好了。' }), '这次后台做的是：给第1章补一段结尾。\n\n改了 1 个文件，改动都在下面，可以逐个查看；需要的话可以一键回退。');
  assert.match(change('unsent', { summary: '未交接：…', reported: null, unreported: true }), /^这次后台在做：给第1章补一段结尾。\n\n它停在半途，没有留下完成汇报，最后一步可能没做完。改了 1 个文件/);
  assert.match(change('handles', { summary: '…', reported: '已按 E16 报告补了结尾（E16），E2E 用例未动。' }), /^已按报告补了结尾，E2E 用例未动。\n\n改了 1 个文件/, 'evidence handles never reach the user');
  const lines = () => f.store.state.sessions.find(row => row.id === f.sessionId).items.filter(item => item.initiative?.backgroundChange);
  assert.deepEqual(lines().at(-1).evidenceIds, ['action:handles:completed'], 'a completed run\'s line cites it, so it is not reported twice');
  assert.match(change('failed', { failed: true, code: 'background_failed' }), /^这次后台在做：给第1章补一段结尾。\n\n它没有做完就停了。停之前已经改了 1 个文件/);
  assert.equal(lines().at(-1).evidenceIds, undefined, 'a failed run completed nothing');
  assert.match(change('cancelled', { cancelled: true }), /^这次后台在做：给第1章补一段结尾。\n\n按你的要求停下了。停之前已经改了 1 个文件/);
  const rows = f.store.state.projects.find(row => row.id === f.projectId).backgroundChanges;
  assert.deepEqual(rows.map(row => [row.actionId, row.unreported === true, row.failed === true, row.cancelled === true]), [['reported', false, false, false], ['silent', false, false, false], ['unsent', true, false, false], ['handles', false, false, false], ['failed', false, true, false], ['cancelled', false, false, true]]);
  f.store.mutate(state => { state.settings.interfaceLanguage = 'en'; });
  assert.match(change('english', { summary: 'Done.', reported: 'Added the closing paragraph to chapter 1.' }), /^Added the closing paragraph to chapter 1\.\n\nChanged 1 file; each change/);
});

test('an unsent tool call at the end of a reply is recognized; the same text in a code block or mid-report is not', async () => {
  const { unsentToolCall } = await import('../project-initiative-controller.mjs');
  assert.equal(unsentToolCall('Wait, let me verify:\n<invoke name="mcp__playwright-browser__browser_wait_for">\n<parameter name="time">6</parameter>\n</invoke>'), true);
  assert.equal(unsentToolCall('已完成三处修订。\n\n交接：已完成三处修订，剩余无。'), false);
  assert.equal(unsentToolCall('示例：\n```xml\n<invoke name="x"><parameter name="a">1</parameter></invoke>\n```\n交接：写好了 MCP 调用示例。'), false);
  assert.equal(unsentToolCall(`<invoke name="old">\n${'正文。'.repeat(800)}`), false, 'only the end of a long reply is checked');
});

// Seen live: a background expansion ran while the conversation still said "说'继续'推进"; its line only appeared when it
// ended. The line now appears when the work starts ("working") and is completed in place with what it did and its files.
test('a writing background run is in the conversation from its start, and its line is completed in place', async t => {
  const f = host(t);
  Object.assign(f.self, { backgroundProject: project => ({ ...project, permissions: { workspace: 'write', background: 'inherit' } }) });
  const items = () => f.store.state.sessions.find(row => row.id === f.sessionId).items.filter(item => item.initiativeActionId?.endsWith('-changes'));
  writeFileSync(join(f.dir, 'ch4.md'), '旧\n');
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.self.work = async (_context, _action, { recorder }) => { await gate; recorder.capture('ch4.md'); writeFileSync(join(f.dir, 'ch4.md'), '新\n'); return { summary: '写好了。', reported: '已把第4章扩写到 3000 字。' }; };
  const running = f.self.recordedWork({ projectId: f.projectId }, { id: 'expand', content: '扩写第4章到 3000 字' }, {});
  assert.equal(items().length, 1);
  assert.match(items()[0].text, /^后台开始做：扩写第4章到 3000 字\n\n正在进行/);
  assert.equal(items()[0].initiative.backgroundWork.status, 'running');
  const id = items()[0].id;
  release(); await running;
  assert.equal(items().length, 1, 'completed in place, not a second message');
  const [line] = items();
  assert.equal(line.id, id); assert.equal(line.initiative.backgroundWork.status, 'done'); assert.ok(line.initiative.backgroundChange);
  assert.equal(line.text, '已把第4章扩写到 3000 字。\n\n改了 1 个文件，改动都在下面，可以逐个查看；需要的话可以一键回退。');
  assert.deepEqual(line.evidenceIds, ['action:expand:completed']);

  // No change: the "working" line is taken back (what the work found is shared the usual way).
  f.self.work = async () => { assert.equal(items().filter(item => item.initiativeActionId === 'look-changes').length, 1); return { summary: '看过了。' }; };
  await f.self.recordedWork({ projectId: f.projectId }, { id: 'look', content: '核对第5章人名' }, {});
  assert.equal(items().some(item => item.initiativeActionId === 'look-changes'), false);

  // Stopped for a new turn in the conversation; paused; deferred before it started.
  writeFileSync(join(f.dir, 'ch6.md'), '旧\n');
  f.self.work = async (_context, _action, { recorder }) => { recorder.capture('ch6.md'); writeFileSync(join(f.dir, 'ch6.md'), '半\n'); throw Object.assign(new Error('stop'), { code: 'foreground_started' }); };
  await assert.rejects(f.self.recordedWork({ projectId: f.projectId }, { id: 'stopped', content: '扩写第6章' }, {}));
  const stopped = items().find(item => item.initiativeActionId === 'stopped-changes');
  assert.match(stopped.text, /^这次后台在做：扩写第6章\n\n你在对话里开始了新的一轮，它先停下，由这一轮接着做。停之前已经改了 1 个文件/);
  assert.equal(stopped.initiative.backgroundWork.status, 'failed'); assert.equal(stopped.evidenceIds, undefined);
  f.self.work = async () => ({ control: { kind: 'pause' } });
  await f.self.recordedWork({ projectId: f.projectId }, { id: 'paused', content: '扩写第7章' }, {});
  const paused = items().find(item => item.initiativeActionId === 'paused-changes');
  assert.equal(paused.initiative.backgroundWork.status, 'paused'); assert.match(paused.text, /^后台在做：扩写第7章\n\n已暂停/);
  f.self.work = async () => ({ deferred: true, reason: 'foreground_busy' });
  await f.self.recordedWork({ projectId: f.projectId }, { id: 'later', content: '扩写第8章' }, {});
  assert.equal(items().some(item => item.initiativeActionId === 'later-changes'), false, 'a run that never started leaves no line');
  // A read-only background has nothing to report this way.
  Object.assign(f.self, { backgroundProject: project => ({ ...project, permissions: { ...project.permissions, background: 'read' } }) });
  f.self.work = async () => ({ summary: '只读。' });
  await f.self.recordedWork({ projectId: f.projectId }, { id: 'read', content: '读一遍' }, {});
  assert.equal(items().some(item => item.initiativeActionId === 'read-changes'), false);
});

test('after a restart a line still "working" says the run was cut off', t => {
  const f = host(t);
  f.store.mutate(state => {
    state.sessions.find(row => row.id === f.sessionId).items.push({ id: 'w1', kind: 'assistant', source: 'initiative', text: '后台开始做：扩写第9章\n\n正在进行。', createdAt: new Date().toISOString(), initiativeActionId: 'gone-changes', initiative: { kind: 'insight', reach: 'inbox', backgroundWork: { actionId: 'gone', status: 'running' } } });
    const project = state.projects.find(row => row.id === f.projectId);
    project.initiativeRuntime = { ...(project.initiativeRuntime ?? {}), sdkState: { ...(project.initiativeRuntime?.sdkState ?? {}), actions: [{ id: 'gone', action: 'work', status: 'needs_review', content: '扩写第9章' }] } };
  });
  f.self.settleWorkLines();
  const line = f.store.state.sessions.find(row => row.id === f.sessionId).items.find(row => row.id === 'w1');
  assert.equal(line.initiative.backgroundWork.status, 'interrupted');
  assert.match(line.text, /^这次后台在做：扩写第9章\n\n服务重启打断了它/);
});

test('a scheduled run is named by its schedule wherever its line is read, never by the host instruction to the worker', async t => {
  // Live, 2026-10-03: "后台开始做：Scheduled occurrence schedule:schedule-82a6…:2698… Due: 2026-10-03T01:00:00.000Z Time rule: {"kind":"daily","time…".
  const f = host(t);
  Object.assign(f.self, { backgroundProject: project => ({ ...project, permissions: { workspace: 'write', background: 'inherit' } }) });
  f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).schedules = [{ id: 's1', title: '每日 AI 新闻与应用调研', task: '执行本项目每日调研职责：采集、核验、写日报。', rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, enabled: true }]; });
  const machine = 'Scheduled occurrence schedule:s1:26981bdb10765e1bbc529558\nDue: 2026-10-03T01:00:00.000Z\nTime rule: {"kind":"daily","time":"09:00"}\n\n执行本项目每日调研职责：采集、核验、写日报。\n\nProduce the requested deliverable using current evidence and authorized tools.';
  const action = id => ({ id, action: 'work', content: machine, hostSchedule: { key: 'schedule:s1:26981bdb10765e1bbc529558', scheduleId: 's1' } });
  const items = () => f.store.state.sessions.find(row => row.id === f.sessionId).items.filter(item => item.initiativeActionId?.endsWith('-changes'));
  writeFileSync(join(f.dir, 'daily.md'), '旧\n');
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.self.work = async (_context, _action, { recorder }) => { await gate; recorder.capture('daily.md'); writeFileSync(join(f.dir, 'daily.md'), '半\n'); throw Object.assign(new Error('boom'), { code: 'background_failed' }); };
  const running = f.self.recordedWork({ projectId: f.projectId }, action('schedule-work-a'), {});
  const [line] = items();
  assert.equal(line.text, '后台开始做：定时任务「每日 AI 新闻与应用调研」\n\n正在进行，做完后会在这里补上做了什么、改了哪些文件。');
  assert.equal(line.initiative.scheduledWork, true, 'badged as the user\'s scheduled task, not an unprompted share');
  release(); await assert.rejects(running);
  const ended = items().find(item => item.initiativeActionId === 'schedule-work-a-changes');
  assert.match(ended.text, /^这次后台在做：定时任务「每日 AI 新闻与应用调研」\n\n它没有做完就停了。/);
  for (const item of items()) assert.doesNotMatch(item.text, /Scheduled occurrence|Due:|Time rule|schedule:s1/);

  // Cut off by a restart; and a schedule deleted meanwhile still reads as a scheduled task, not as machine text.
  f.store.mutate(state => {
    state.sessions.find(row => row.id === f.sessionId).items.push({ id: 'w-sched', kind: 'assistant', source: 'initiative', text: `后台开始做：${machine}`, createdAt: new Date().toISOString(), initiativeActionId: 'schedule-work-b-changes', initiative: { kind: 'insight', reach: 'inbox', scheduledWork: true, backgroundWork: { actionId: 'schedule-work-b', status: 'running' } } });
    const project = state.projects.find(row => row.id === f.projectId);
    project.initiativeRuntime = { ...(project.initiativeRuntime ?? {}), sdkState: { ...(project.initiativeRuntime?.sdkState ?? {}), actions: [{ ...action('schedule-work-b'), status: 'needs_review' }] } };
  });
  f.self.settleWorkLines();
  assert.match(f.store.state.sessions.find(row => row.id === f.sessionId).items.find(row => row.id === 'w-sched').text, /^这次后台在做：定时任务「每日 AI 新闻与应用调研」\n\n服务重启打断了它/);
  // Handoffs (read by the user on the task page and by the next decision): the schedule's name for a scheduled run,
  // the whole instruction for work the model wrote.
  assert.equal(f.self.handoffTask({ projectId: f.projectId }, action('schedule-work-b')), '定时任务「每日 AI 新闻与应用调研」');
  assert.equal(f.self.handoffTask({ projectId: f.projectId }, { id: 'm', content: '扩写第4章。然后核对人名。' }), '扩写第4章。然后核对人名。');
  // Inside a caller's own quotes (已先停下后台的「…」, 后台“…”没做完) the name is not framed a second time.
  assert.equal(f.self.actionName(f.self.project(f.projectId), action('schedule-work-c'), { quoted: true }), '每日 AI 新闻与应用调研（定时任务）');
  assert.equal(f.self.actionName(f.self.project(f.projectId), action('schedule-work-c'), { quoted: true, language: 'en' }), '每日 AI 新闻与应用调研 (scheduled task)');
  // A schedule deleted since is named by the task the run was given; with nothing to go on, as a scheduled task.
  f.store.mutate(state => { state.projects.find(row => row.id === f.projectId).schedules = []; });
  assert.equal(f.self.actionName(f.self.project(f.projectId), action('schedule-work-c')), '定时任务「执行本项目每日调研职责：采集、核验、写日报。」');
  assert.equal(f.self.actionName(f.self.project(f.projectId), { ...action('schedule-work-c'), content: 'Scheduled occurrence k' }, { language: 'en' }), 'a scheduled task');
  // Work the model decided keeps the first sentence it wrote.
  assert.equal(f.self.actionName(f.self.project(f.projectId), { id: 'm', action: 'work', content: '扩写第4章到 3000 字。然后核对人名 E3。' }), '扩写第4章到 3000 字。');
});
