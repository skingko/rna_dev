import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';
import { SessionCommandService } from '../session-command-service.mjs';
import { projectLearningEpisodes, projectLearningSourceRecords, freezeProjectLearningFiles } from '../project-learning-evidence.mjs';
import { createProjectLearningContext, validateProjectLearningContext } from '../../../packages/sdk/src/learning-context.mjs';

const at = offset => new Date(Date.UTC(2026, 8, 25, 0, 0, offset)).toISOString();
const questions = [{ id: 'direction', question: 'Which result needs improvement?', options: [{ id: 'behavior', label: 'Actual behavior' }, { id: 'visual', label: 'Visual composition' }] }];
const answers = [{ id: 'direction', selected: ['visual'], custom: 'Use a restrained ink landscape.' }];
function data() {
  const project = { id: 'p', simulated: false, observations: [], jobs: [] }, session = { id: 's', projectId: project.id, turns: [], items: [], commandHistory: [] };
  return { project, session, state: { projects: [project], sessions: [session] } };
}
function turn(f, id = 't', patch = {}) {
  const row = { id, status: 'completed', simulated: false, modelConfig: { execution: 'rna' }, createdAt: at(0), completedAt: at(3), userItemId: `${id}-user`, steering: [], ...patch }; f.session.turns.push(row);
  f.session.items.push({ id: `${id}-user`, turnId: id, kind: 'user', text: 'Build the real thing.', simulated: false, createdAt: at(0) },
    { id: `${id}-tool`, turnId: id, kind: 'tool', simulated: false, createdAt: at(1), tool: { id: `${id}-call`, name: 'project_exec', status: 'completed', args: { command: 'test' }, output: 'The actual check passed.' } },
    { id: `${id}-assistant`, turnId: id, kind: 'assistant', text: 'All behavior is perfect.', simulated: false, createdAt: at(2) });
  return row;
}
function card(f, id = 'card', patch = {}) {
  const row = { id, kind: 'question', source: 'interaction', simulated: false, createdAt: at(1), interaction: { id: `interaction-${id}`, kind: 'question', source: 'initiative', status: 'answered', answeredAt: at(2), questions, answers, ...patch } };
  f.session.items.push(row); return row;
}
const collect = f => projectLearningEpisodes(f.state, f.project, 'scope', { since: 0 });
function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-learning-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'); mkdirSync(root);
  return { directory, root };
}

test('real interaction service answers are independent episodes, using structured answers rather than rendered text', t => {
  const { root } = workspace(t), store = new Store(join(root, 'host.json'));
  const { project, session } = store.createProject({ name: 'Real user answer', workspace: root });
  const service = new UserInteractionService(store); t.after(() => service.close());
  const record = service.publishInitiative({ projectId: project.id, sessionId: session.id, actionId: 'real-question', questions });
  assert.equal(projectLearningEpisodes(store.state, store.state.projects[0], 'scope').episodes.length, 0);
  service.answer(session.id, record.id, { requestId: 'real-answer', answers });
  store.mutate(state => { state.sessions[0].items.find(row => row.source === 'interaction-answer').text = 'Forged rendered text must not override the selected answer'; });
  const result = projectLearningEpisodes(store.state, store.state.projects[0], 'scope');
  assert.equal(result.episodes.length, 1);
  const episode = result.episodes[0], detail = JSON.parse(episode.summary);
  assert.equal(episode.kind, 'user_feedback'); assert.ok(episode.id.length <= 160);
  assert.deepEqual(episode.sourceIds, [`session:${session.id}`, 'scope:scope']);
  assert.equal(detail.questions[0].selected[0].label, 'Visual composition');
  assert.equal(detail.questions[0].custom, answers[0].custom); assert.doesNotMatch(episode.summary, /Forged/);
  assert.equal(projectLearningEpisodes(store.state, store.state.projects[0], 'scope').episodes[0].fingerprint, episode.fingerprint);
  const source = JSON.parse(projectLearningSourceRecords(store.state, project, [episode]).evidence[0].content);
  assert.equal(source.coverage.sourceUnavailable, false); assert.equal(JSON.parse(source.records[0].content).answers[0].custom, answers[0].custom);
});

test('answered tool questions are retained without a separate user item; revoked, simulated, pending, invalid answers are absent', () => {
  const f = data(); turn(f, 'active', { status: 'running' });
  card(f, 'good-tool', { source: 'tool', turnId: 'active' });
  for (const status of ['pending', 'cancelled', 'interrupted']) card(f, status, { status });
  card(f, 'fake', { simulated: true }); card(f, 'revoked', { contextRevoked: true });
  card(f, 'foreign', { projectId: 'foreign' }); card(f, 'unowned', { source: 'tool', turnId: 'missing' });
  card(f, 'invalid', { answers: [{ id: 'direction', selected: ['invented'] }] });
  const removed = card(f, 'removed-answer');
  f.session.items.push({ id: 'removed', kind: 'user', source: 'interaction-answer', interactionId: removed.interaction.id, text: 'revoked text', simulated: false, sourceDeleted: true });
  const result = collect(f); assert.equal(result.episodes.length, 1);
  assert.match(result.episodes[0].id, /good-tool/); assert.doesNotMatch(result.episodes[0].summary, /revoked text/);
});

test('only consumed steering is feedback; initial or queued requests are not, and terminal turn does not duplicate it', () => {
  const f = data(), owner = turn(f, 'active', { status: 'running' });
  f.session.items.find(row => row.id === owner.userItemId).delivery = 'steer'; owner.steering.push(owner.userItemId);
  f.session.inbox = [{ id: 'queued', text: 'Not consumed yet', deliveryStatus: 'accepted', simulated: false }];
  const steer = { id: 'steer', kind: 'user', text: 'Confirmed correction unique to steering.', turnId: owner.id, delivery: 'steer', simulated: false, createdAt: at(2) };
  f.session.items.push(steer, { ...steer, id: 'unclaimed', text: 'Not claimed' });
  assert.equal(collect(f).episodes.length, 0);
  owner.steering.push('steer'); const first = collect(f).episodes; assert.equal(first.length, 1); assert.match(first[0].summary, /Confirmed correction/);
  owner.status = 'completed';
  const result = collect(f).episodes; assert.equal(result.length, 2);
  const detail = JSON.parse(result.find(row => row.kind === 'conversation_result').summary);
  assert.equal(detail.coverage.separatelyRecordedUserFeedback, 1); assert.ok(!detail.requests.some(row => row.id === 'steer'));
  steer.contextRevoked = true; assert.equal(collect(f).episodes.filter(row => row.kind === 'user_feedback').length, 0);
});

test('actual completed feedback command is independently collected with durable command/notice/observation linkage', async t => {
  const { root } = workspace(t), store = new Store(join(root, 'host.json'));
  const { project, session } = store.createProject({ name: 'Feedback', workspace: root });
  const service = new SessionCommandService(store);
  await service.execute(session.id, { requestId: 'feedback-test', command: 'feedback', args: { text: 'The preview never ran.', rating: 'negative' } });
  const get = () => projectLearningEpisodes(store.state, store.state.projects.find(row => row.id === project.id), 'scope').episodes;
  assert.equal(get().length, 1); assert.equal(JSON.parse(get()[0].summary).source, 'completed_feedback_command');
  const source = JSON.parse(projectLearningSourceRecords(store.state, project, get()).evidence[0].content);
  assert.equal(source.coverage.sourceUnavailable, false); assert.equal(JSON.parse(source.records[0].content).text, 'The preview never ran.');
  store.mutate(state => { state.sessions[0].commandHistory[0].status = 'running'; }); assert.equal(get().length, 0);
  store.mutate(state => { state.sessions[0].commandHistory[0].status = 'completed'; state.projects[0].observations.find(row => row.data?.command === 'feedback').sourceDeleted = true; }); assert.equal(get().length, 0);
});

test('bootstrap remains newest twelve real records, bounded feedback IDs and redacted summaries', () => {
  const f = data();
  for (let n = 0; n < 17; n++) card(f, `card-${n}`, { answeredAt: at(n) });
  card(f, 'long!'.repeat(80), { answeredAt: at(40), answers: [{ id: 'direction', selected: ['visual'], custom: 'secret-' + '学'.repeat(3800) }] });
  f.session.id = 'session!'.repeat(40);
  const result = projectLearningEpisodes(f.state, f.project, 'scope', { redact: text => text.replaceAll('secret-', '[REDACTED]') });
  assert.equal(result.coverage.availableRecords, 18); assert.equal(result.episodes.length, 12); assert.equal(result.coverage.olderRecordsOmitted, 6);
  for (const episode of result.episodes) { assert.ok(episode.id.length <= 160); assert.ok(episode.summary.length <= 6000); assert.doesNotMatch(episode.summary, /secret-/); }
});

test('frozen source contains real output beyond summary, supports reader paging, and cannot change after asynchronous entry', async t => {
  const { root } = workspace(t), f = data(); f.project.workspace = root; turn(f);
  const receipt = f.session.items.find(row => row.tool), original = 'a'.repeat(2000) + 'EXACT-MIDDLE-RECEIPT' + 'b'.repeat(15000);
  receipt.tool.output = original; receipt.tool.args = { command: 'genuine check', apiKey: 'must not leak', nested: { expected: 'kept' } };
  const episodes = collect(f).episodes; assert.doesNotMatch(episodes[0].summary, /EXACT-MIDDLE/);
  const pending = freezeProjectLearningFiles(f.project, episodes, { sourceState: f.state });
  receipt.tool.output = 'later replacement'; f.session.items[0].text = 'later user text';
  const { context, coverage } = await pending;
  const document = JSON.parse(context.evidence[0].content), raw = JSON.parse(document.records.find(row => row.kind === 'tool_receipt').content);
  assert.equal(raw.output, original); assert.equal(raw.args.command, 'genuine check'); assert.equal(raw.args.apiKey, '[REDACTED]');
  assert.equal(JSON.parse(document.records.find(row => row.kind === 'assistant_narration').content).independentlyVerified, false);
  assert.equal(document.coverage.privateJournalRead, false); assert.equal(coverage.evidence.truncatedRecords, 0);
  assert.doesNotMatch(context.evidence[0].content, /later replacement|later user text|must not leak/);
  const reader = createProjectLearningContext(context, episodes), tool = reader.tools.find(row => row.name === 'learning_context_read');
  let offset = 0, all = '';
  do { const response = JSON.parse((await tool.execute('read', { id: `evidence:${episodes[0].id}`, offset, limit: 800 })).content[0].text); all += response.content; offset = response.nextOffset; } while (offset !== null);
  assert.equal(all, context.evidence[0].content); assert.match(all, /EXACT-MIDDLE-RECEIPT/); assert.ok(reader.reads().length > 1);
});

test('raw sources are exact same-project retained identities, exclude revoked records and never revive stale summary text', () => {
  const f = data(); turn(f); card(f);
  const episodes = collect(f).episodes;
  f.session.items.find(row => row.tool).contextRevoked = true;
  const first = projectLearningSourceRecords(f.state, f.project, episodes);
  assert.doesNotMatch(JSON.stringify(first), /The actual check passed/);
  f.session.items.find(row => row.interaction).interaction.sourceDeleted = true;
  const revoked = projectLearningSourceRecords(f.state, f.project, episodes).evidence.find(row => row.id.includes('feedback'));
  assert.equal(JSON.parse(revoked.content).coverage.sourceUnavailable, true); assert.doesNotMatch(revoked.content, /Visual composition|restrained ink/);
  f.session.projectId = 'foreign';
  for (const row of projectLearningSourceRecords(f.state, f.project, episodes).evidence) assert.equal(JSON.parse(row.content).coverage.sourceUnavailable, true);
});

test('large Unicode sources have explicit truncation, bounded envelopes and total context accepted by SDK', async t => {
  const { root } = workspace(t), f = data(); f.project.workspace = root;
  for (let n = 0; n < 8; n++) { turn(f, `turn-${n}`); f.session.items.find(row => row.id === `turn-${n}-tool`).tool.output = '汉字🧬'.repeat(50000); }
  for (let n = 0; n < 5; n++) writeFileSync(join(root, `source-${n}.js`), 'x'.repeat(100000));
  const episodes = collect(f).episodes, { context, coverage } = await freezeProjectLearningFiles(f.project, episodes, { sourceState: f.state });
  assert.ok(coverage.evidence.bytes <= 512000); assert.ok(coverage.bytes <= 384000); assert.ok(coverage.totalContentBytes < 1048576);
  assert.ok(coverage.evidence.truncatedRecords > 0); assert.equal(validateProjectLearningContext(context, episodes).evidence.length, 8);
  for (const row of context.evidence) { assert.ok(Buffer.byteLength(row.content) <= 128000); assert.doesNotMatch(row.content, /\uFFFD/); assert.ok(JSON.parse(row.content).coverage.truncatedRecords > 0); }
});

test('background worker snapshots use only real retained receipts and preserve original host truncation', () => {
  const f = data(), output = 'p'.repeat(800) + 'MIDDLE-WORK-CHECK' + 'q'.repeat(800);
  f.project.initiativeRuntime = { sdkState: { actions: [{ id: 'work-1', action: 'work', status: 'completed', content: 'Check the runtime', resultSummary: 'A model claims it works', evidenceIds: [], finishedAt: Date.parse(at(4)) }, { id: 'learning-1', action: 'learn', status: 'completed', finishedAt: Date.parse(at(5)) }] } };
  f.project.jobs = [{ id: 'work-1', simulated: false, toolReceiptCounts: { total: 3, completed: 2, failed: 1 }, toolReceipts: [{ toolCallId: 'actual', toolName: 'project_exec', status: 'completed', output, truncated: true }, { toolCallId: 'removed', status: 'failed', output: 'revoked private text', sourceDeleted: true }] }];
  const episodes = collect(f).episodes; assert.equal(episodes.length, 1); assert.doesNotMatch(episodes[0].summary, /MIDDLE-WORK-CHECK|revoked private text/);
  const source = JSON.parse(projectLearningSourceRecords(f.state, f.project, episodes).evidence[0].content), raw = JSON.parse(source.records.find(row => row.kind === 'tool_receipt').content);
  assert.equal(raw.output, output); assert.equal(raw.hostAlreadyTruncated, true); assert.equal(source.source.hostReceiptCoverage.total, 3);
  assert.deepEqual(source.episode.sourceIds, ['session:s', 'scope:scope']); assert.equal(source.episode.fingerprint, episodes[0].fingerprint);
  assert.equal(JSON.parse(source.records[0].content).independentlyVerified, false); assert.doesNotMatch(JSON.stringify(source), /revoked private text/);
  f.session.sourceDeleted = true; assert.equal(JSON.parse(projectLearningSourceRecords(f.state, f.project, episodes).evidence[0].content).coverage.sourceUnavailable, true);
});

test('denied host paths clip only their own subtree, deny hardlink aliases, and ignore symlinks and private/build/dependency paths', async t => {
  const { root, directory } = workspace(t), f = data(); f.project.workspace = root;
  const stateFile = join(root, 'custom-state.json'), deniedDir = join(root, 'opaque-runtime');
  writeFileSync(stateFile, 'HOST STATE'); mkdirSync(deniedDir); writeFileSync(join(deniedDir, 'live.json'), 'RUNTIME');
  mkdirSync(`${deniedDir}-public`); writeFileSync(join(`${deniedDir}-public`, 'allowed.json'), '{}');
  linkSync(stateFile, join(root, 'innocent-alias.json'));
  writeFileSync(join(directory, 'outside.js'), 'OUTSIDE'); symlinkSync(join(directory, 'outside.js'), join(root, 'linked.js'));
  symlinkSync(directory, join(root, 'linked-dir'));
  for (const folder of ['node_modules', 'bower_components', '.venv', 'dist', 'build', '.next', 'coverage', 'target', '.state', 'secrets-vault']) { mkdirSync(join(root, folder)); writeFileSync(join(root, folder, 'leak.js'), 'EXCLUDED'); }
  for (const name of ['.env.json', 'frozen-evaluation.json', 'learning-context.json', 'auth.json']) writeFileSync(join(root, name), 'EXCLUDED');
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'main.js'), 'export const ok = true;');
  const deniedPaths = [stateFile, deniedDir, join(root, 'secrets-vault'), join(root, 'missing-runtime')];
  const { context, coverage } = await freezeProjectLearningFiles(f.project, [], { deniedPaths });
  assert.deepEqual(context.files.map(row => row.path).sort(), ['opaque-runtime-public/allowed.json', 'src/main.js']);
  assert.ok(coverage.skipped.some(row => row.path === 'innocent-alias.json' && row.reason === 'host_denied_identity'));
  const all = await freezeProjectLearningFiles(f.project, [], { deniedPaths: [directory] }); assert.equal(all.coverage.rootDenied, true); assert.deepEqual(all.context.files, []);
});

test('canonical denied directory aliases and redaction expansion cannot bypass the source byte cap', async t => {
  const { root, directory } = workspace(t), f = data(); f.project.workspace = root;
  mkdirSync(join(root, 'private')); writeFileSync(join(root, 'private', 'data.json'), 'SECRET');
  symlinkSync(join(root, 'private'), join(directory, 'denied-alias'));
  writeFileSync(join(root, 'main.js'), 'x');
  const result = await freezeProjectLearningFiles(f.project, [], { deniedPaths: [join(directory, 'denied-alias')], maxBytes: 10, redact: text => text === 'x' ? 'expanded'.repeat(10) : text });
  assert.deepEqual(result.context.files, []); assert.ok(result.coverage.bytes <= 10);
});
