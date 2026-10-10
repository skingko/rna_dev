import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationPassages, bm25Index } from '../project-mind.mjs';

// conversationPassages: the evidence windows the reconcile judge reads (docs/research/jev-delivery-evidence-probe-20261010.md).
// Windows are 420 characters long, a new one starts every 360, a message is cut at 6000 characters; the deliverables a proactive
// message presented get windows of their own after the message text.
const AT = '2026-10-01T00:00:00.000Z';
const stateOf = (items, jobs = []) => ({ sessions: [{ id: 's', projectId: 'p', items }], projects: [{ id: 'p', jobs }] });
const delivered = (text, deliverables, extra = {}) => ({ id: 'd', kind: 'assistant', source: 'initiative', text, createdAt: AT, ...(deliverables ? { initiative: { deliverables } } : {}), ...extra });
const user = (text, extra = {}) => ({ id: 'u', kind: 'user', text, createdAt: AT, ...extra });
const job = (extra = {}) => ({ id: 'j', status: 'completed', completedAt: AT, ...extra });
const textOf = passages => passages.map(row => row.text);
// Distinct characters so a window can be located in its message by its content.
const stream = length => Array.from({ length }, (_, index) => String.fromCharCode(0x4e00 + index % 3000)).join('');

test('windows: 420 characters, a new window every 360, the last window ends the message; a message cut at 6000', () => {
  const windows = length => conversationPassages(stateOf([user(stream(length))]), 'p').map(row => [row.id, row.text.length]);
  assert.deepEqual(windows(1), [['u:0', 1]]);
  assert.deepEqual(windows(420), [['u:0', 420]], 'exactly one window of text');
  assert.deepEqual(windows(421), [['u:0', 420], ['u:360', 61]], 'one character over: a second window carrying the 60-character overlap and the extra character');
  assert.deepEqual(windows(780), [['u:0', 420], ['u:360', 420]]);
  assert.deepEqual(windows(781), [['u:0', 420], ['u:360', 420], ['u:720', 61]]);
  const long = conversationPassages(stateOf([user(stream(9000))]), 'p'), text = stream(6000);
  assert.equal(long.length, 17, 'starts 0, 360, … 5760');
  assert.equal(long.at(-1).id, 'u:5760'); assert.equal(long.at(-1).text, text.slice(5760), 'the last window ends at character 6000, nothing after it');
  assert.equal(long[1].text.slice(0, 60), long[0].text.slice(360), 'neighbouring windows overlap by 60 characters');
  assert.deepEqual(windows(0), [], 'an empty message gives no window');
});

test('deliverables get windows of their own: a message past the 6000-character cut keeps them', () => {
  const body = stream(9000), deliverables = [{ path: 'reports/2026-10-08/news.json', name: 'news.json', description: '机读清单：49 条，每条含证据 sha256' }, { path: 'reports/2026-10-08/daily.md', name: 'daily.md', description: '日报正文' }];
  const passages = conversationPassages(stateOf([delivered(body, deliverables)]), 'p'), files = passages.filter(row => row.id.startsWith('d:files'));
  assert.equal(passages.filter(row => !row.id.startsWith('d:files')).length, 17, 'the text windows are the same as without deliverables');
  assert.equal(passages.filter(row => !row.id.startsWith('d:files')).some(row => /Delivered|news\.json/.test(row.text)), false, 'nothing is appended to the text');
  assert.deepEqual(textOf(files), ['Delivered files: reports/2026-10-08/news.json (机读清单：49 条，每条含证据 sha256); reports/2026-10-08/daily.md (日报正文)']);
  assert.deepEqual([files[0].id, files[0].role, files[0].at, files[0].itemId, files[0].sessionId], ['d:files', 'delivered', AT, 'd', 's'], 'same role, time and item as the message, so own-item exclusion and the anchor work');
});

test('deliverable entry: path once, then the description; the name only as a fallback; strings and bad entries', () => {
  const files = deliverables => textOf(conversationPassages(stateOf([delivered('ok', deliverables)]), 'p').filter(row => row.id.startsWith('d:files')));
  assert.deepEqual(files([{ path: 'a/b.csv', name: 'b.csv', description: 'monthly totals' }]), ['Delivered files: a/b.csv (monthly totals)'], 'the name repeats the path, the description is kept');
  assert.deepEqual(files([{ name: 'b.csv', summary: 'monthly totals' }]), ['Delivered files: b.csv (monthly totals)'], 'no path: the name; summary is read like description');
  assert.deepEqual(files([{ path: 'a/b.csv' }]), ['Delivered files: a/b.csv']);
  assert.deepEqual(files([{ title: 'Totals', description: 'monthly' }]), ['Delivered files: Totals (monthly)']);
  assert.deepEqual(files([' notes/x.md ', { path: 7, description: 8 }, null, 42, {}, { path: '  ', name: '' }]), ['Delivered files: notes/x.md'], 'strings kept, non-text and empty entries dropped');
  assert.deepEqual(files([{ path: 'a/b.csv', description: 'line one\n\n  line   two' }]), ['Delivered files: a/b.csv (line one line two)'], 'whitespace is collapsed');
  assert.deepEqual(files([]), [], 'no deliverables, no window');
  assert.deepEqual(files(['', {}]), [], 'nothing describable, no window');
  assert.deepEqual(textOf(conversationPassages(stateOf([delivered('ok')]), 'p')), ['ok'], 'a message without deliverables is only its text');
});

test('deliverable windows pack whole entries: none is split across windows, each window is at most 420 characters and carries the label', () => {
  const deliverables = Array.from({ length: 8 }, (_, index) => ({ path: `正文/卷一/第00${index + 1}章.md`, name: `第00${index + 1}章.md`, description: `第 ${index + 1} 章正文，约 3000 字，已通过字数与红线词检查，结尾留了钩子，人物状态表已同步更新到设定集`.repeat(2) }));
  const files = conversationPassages(stateOf([delivered('这一轮的产出都在下面。', deliverables)]), 'p').filter(row => row.id.startsWith('d:files'));
  assert.ok(files.length >= 2, 'eight entries need more than one window');
  assert.deepEqual(files.map(row => row.id), files.map((_, index) => index ? `d:files:${index}` : 'd:files'));
  for (const row of files) { assert.ok(row.text.length <= 420, `${row.id} ${row.text.length}`); assert.ok(row.text.startsWith('Delivered files: ')); }
  const entries = deliverables.map(entry => `${entry.path} (${entry.description})`);
  entries.forEach((entry, index) => assert.equal(files.filter(row => row.text.includes(entry)).length, 1, `entry ${index} sits whole in exactly one window`));
  assert.deepEqual(files.flatMap(row => row.text.slice('Delivered files: '.length).split('; ')), entries, 'order kept, nothing lost');
});

test('an entry longer than a window is cut with an ellipsis inside the window; the next entry starts a new window', () => {
  const files = conversationPassages(stateOf([delivered('ok', [{ path: 'a/huge.md', description: '长'.repeat(900) }, { path: 'b/small.md', description: 'small' }])]), 'p').filter(row => row.id.startsWith('d:files'));
  assert.equal(files.length, 2);
  assert.ok(files[0].text.length <= 420 && files[0].text.length >= 410, `${files[0].text.length}`); assert.match(files[0].text, /^Delivered files: a\/huge\.md \(长+…$/);
  assert.equal(files[1].text, 'Delivered files: b/small.md (small)');
});

test('a deliverable the item mentions is found by the same BM25 ranking the reconcile uses, even behind a long message', () => {
  const noise = Array.from({ length: 150 }, (_, index) => `第 ${index} 条动态：来源已核对，细节与官方页面一致，影响较小。`).join('');
  const passages = conversationPassages(stateOf([user('先别管排版'), delivered(noise, [{ path: 'reports/2026-10-08/news.json', name: 'news.json', description: '机读清单：49 条，每条带证据 sha256' }])]), 'p');
  const ranked = bm25Index(passages).rank('同时产出机读版 news.json（含每条证据的 sha256）').filter(entry => entry.score > 0);
  assert.equal(ranked[0].doc.id, 'd:files');
});

test('roles and filtering: user, last assistant reply, delivered; retained, simulated and streaming rows leave no window and no deliverable window', () => {
  const files = [{ path: 'x/y.md', description: 'd' }];
  const items = [
    user('keep user', { id: 'u1' }), user('from the app', { id: 'u2', source: 'interaction-answer' }), user('not the user', { id: 'u3', source: 'initiative' }),
    { id: 'a1', kind: 'assistant', turnId: 't1', text: 'early reply', createdAt: AT }, { id: 'a2', kind: 'assistant', turnId: 't1', text: 'last reply of turn', createdAt: AT }, { id: 'a3', kind: 'assistant', text: 'final reply', final: true, createdAt: AT },
    delivered('keep delivered', files, { id: 'd1' }),
    delivered('archived', files, { id: 'd2', archivedAt: AT }), delivered('source deleted', files, { id: 'd3', sourceDeleted: true }), delivered('revoked', files, { id: 'd4', contextRevoked: true }),
    delivered('streaming', files, { id: 'd5', streaming: true }), delivered('simulated', files, { id: 'd6', simulated: true }),
  ];
  const passages = conversationPassages(stateOf(items), 'p');
  assert.deepEqual(passages.map(row => `${row.id}:${row.role}`), ['u1:0:user', 'u2:0:user', 'a2:0:assistant', 'a3:0:assistant', 'd1:0:delivered', 'd1:files:delivered']);
  assert.equal(conversationPassages({ sessions: [{ id: 's', projectId: 'other', items }, { id: 's2', projectId: 'p', archivedAt: AT, items }], projects: [{ id: 'p', jobs: [] }] }, 'p').length, 0, 'other projects and archived sessions give nothing');
});

test('job handoffs: the marker label of the worker (both languages, any colon, FINAL) is dropped, the content is the same', () => {
  const textFor = fields => textOf(conversationPassages(stateOf([], [job(fields)]), 'p'));
  const zh = textFor({ handoff: '交接：第 12 章初稿已写完，存于 正文/卷一/' }), en = textFor({ handoff: 'HANDOFF: 第 12 章初稿已写完，存于 正文/卷一/' });
  assert.deepEqual(zh, ['第 12 章初稿已写完，存于 正文/卷一/']); assert.deepEqual(en, zh, 'identical passage whichever marker the worker wrote');
  assert.deepEqual(textFor({ handoff: '交接: done' }), ['done'], 'ASCII colon'); assert.deepEqual(textFor({ handoff: 'handoff：done' }), ['done'], 'case and full-width colon');
  assert.deepEqual(textFor({ handoff: 'FINAL: done' }), ['done']); assert.deepEqual(textFor({ handoff: '**HANDOFF:** done' }), ['done'], 'markdown emphasis around the label');
  assert.deepEqual(textFor({ handoff: '完成了交接：门卡已还' }), ['完成了交接：门卡已还'], 'the word inside a sentence is content');
  assert.deepEqual(textFor({ output: '整理完毕。\n- 写了 3 个文件\n交接：已放入 reports/\n' }), ['整理完毕。 - 写了 3 个文件 已放入 reports/'], 'a marker line inside the output');
  assert.deepEqual(textFor({ output: 'Wrote the files.\nHANDOFF: stored under reports/' }), ['Wrote the files. stored under reports/']);
  assert.deepEqual(textFor({ handoff: '', output: '只有输出' }), ['只有输出'], 'an empty handoff falls back to the output');
  assert.deepEqual(textFor({ handoff: '交接：', output: '只有输出' }), ['只有输出'], 'a handoff that is only the marker falls back to the output');
  assert.deepEqual(textFor({}), [], 'neither: no window');
  const [work] = conversationPassages(stateOf([], [job({ handoff: 'HANDOFF: x' })]), 'p');
  assert.deepEqual([work.id, work.role, work.at, work.jobId], ['j:0', 'work', AT, 'j']);
});

test('jobs: only completed, retained, real ones', () => {
  const jobs = [job({ id: 'j1', handoff: 'ok' }), job({ id: 'j2', status: 'running', handoff: 'running' }), job({ id: 'j3', status: 'failed', handoff: 'failed' }), job({ id: 'j4', handoff: 'sim', simulated: true }), job({ id: 'j5', handoff: 'gone', archivedAt: AT }), job({ id: 'j6', handoff: 'cut', sourceDeleted: true }), job({ id: 'j7', handoff: 'revoked', contextRevoked: true })];
  assert.deepEqual(conversationPassages(stateOf([], jobs), 'p').map(row => row.id), ['j1:0']);
});
