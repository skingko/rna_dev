import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mineProjectSignals, deliverableSignals, replayCasesFromSignals, replayEvaluationCase, realSignalScore, toolFailureCause } from '../project-interaction-signals.mjs';

const at = minutes => new Date(Date.parse('2026-09-28T00:00:00Z') + minutes * 60000).toISOString();
function fixture(workspace) {
  const turn = (id, minute, status, extra = {}) => ({ id, status, createdAt: at(minute), startedAt: at(minute), completedAt: at(minute + (extra.duration ?? 1)), userItemId: `u-${id}`, projectVersionId: 'v1', ...extra });
  const items = [
    { id: 'u-t1', turnId: 't1', kind: 'user', text: 'Summarize the report in reports/a.md with token=sk-SECRETSECRETSECRETSECRET' }, { id: 'a-t1', turnId: 't1', kind: 'assistant', text: 'Summary...' },
    { id: 'w-t1', turnId: 't1', kind: 'tool', tool: { name: 'project_write', status: 'succeeded', args: { path: 'reports/a.md', content: 'kept content' } } },
    { id: 'w2-t1', turnId: 't1', kind: 'tool', tool: { name: 'project_write', status: 'succeeded', args: { path: 'reports/b.md', content: 'original b' } } },
    { id: 'w3-t1', turnId: 't1', kind: 'tool', tool: { name: 'project_write', status: 'succeeded', args: { path: 'reports/c.md', content: 'removed later' } } },
    { id: 'u-t2', turnId: 't2', kind: 'user', text: '不对，我要的是中文摘要，而且先给结论' }, { id: 'f-t2', turnId: 't2', kind: 'tool', tool: { name: 'web_fetch', status: 'failed', output: 'HTTP 403' } },
    { id: 'u-t3', turnId: 't3', kind: 'user', text: 'Deploy the site now' }, { id: 'u-t4', turnId: 't4', kind: 'user', text: 'deploy the site now' },
    { id: 'u-t5', turnId: 't5', kind: 'user', text: 'Long refactor' },
  ];
  const state = { projects: [{ id: 'p', workspace, proactiveOutcomes: [{ label: 'dismissed', at: at(50) }, { label: 'acted', at: at(51) }] }],
    sessions: [{ id: 's', projectId: 'p', turns: [turn('t1', 0, 'completed'), turn('t2', 5, 'completed'), turn('t3', 10, 'stopped'), turn('t4', 12, 'completed', { runtimeAttempts: 2 }), turn('t5', 20, 'completed', { duration: 30 })], items }],
    decisionKernelRuntime: { recent: [{ id: 'd1', point: 'initiative.review', at: Date.parse(at(40)), scope: { projectId: 'p', sessionId: 's' }, label: { value: 'reply', at: Date.parse(at(41)) } }, { id: 'd2', point: 'initiative.review', at: Date.parse(at(42)), scope: { projectId: 'other' }, label: { value: 'dismiss' } }] } };
  return state;
}

test('real interaction signals: corrections, retries, aborts, tool failures, overlong turns and proactive outcomes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-signals-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const state = fixture(dir), redact = text => String(text).replace(/sk-[A-Z]+/g, '[REDACTED]');
  const signals = mineProjectSignals(state, 'p', { redact, now: Date.parse(at(100)) });
  const kinds = signals.map(row => row.kind);
  for (const kind of ['user_correction', 'retry', 'aborted_turn', 'tool_failure', 'overlong_turn', 'proactive_outcome']) assert.ok(kinds.includes(kind), kind);
  const correction = signals.find(row => row.kind === 'user_correction'); assert.equal(correction.turnId, 't1'); assert.match(correction.detail.correction, /先给结论/); assert.doesNotMatch(correction.input, /sk-SECRET/);
  assert.ok(signals.some(row => row.kind === 'retry' && row.detail.via === 'repeated_request')); assert.ok(signals.some(row => row.kind === 'retry' && row.detail.via === 'runtime_attempts'));
  assert.deepEqual(signals.filter(row => row.kind === 'proactive_outcome').map(row => row.detail.label).sort(), ['acted', 'dismissed', 'replied']);
  // Deliverables: kept / modified / reverted by comparing the last write with the workspace now.
  await mkdir(join(dir, 'reports'));
  await writeFile(join(dir, 'reports/a.md'), 'kept content'); await writeFile(join(dir, 'reports/b.md'), 'user rewrote b');
  const deliverables = await deliverableSignals(state, 'p');
  assert.deepEqual(Object.fromEntries(deliverables.map(row => [row.detail.path, row.detail.status])), { 'reports/a.md': 'kept', 'reports/b.md': 'modified', 'reports/c.md': 'reverted' });
  const score = realSignalScore([...signals, ...deliverables]); assert.ok(score.score > 0 && score.score < 0.5); assert.ok(score.negatives >= 5);
  // Replay cases: input + workspace snapshot + checks, stable split; held-out never becomes a selection case.
  const replay = await replayCasesFromSignals(signals, { workspace: dir, sessions: state.sessions });
  const fromCorrection = replay.find(row => row.kind === 'user_correction');
  assert.ok(fromCorrection.workspaceSnapshot.files.some(row => row.path === 'reports/a.md' && row.sha256)); assert.equal(fromCorrection.followUp, correction.detail.correction); assert.equal(fromCorrection.checks[0].kind, 'rubric');
  assert.ok(replay.every(row => ['evolve', 'heldout'].includes(row.split)));
  const evolveCase = replayEvaluationCase({ ...fromCorrection, split: 'evolve' }, { toolIds: [] }); assert.equal(evolveCase.followUps[0].input, fromCorrection.followUp); assert.equal(evolveCase.weight, 2);
  assert.equal(replayEvaluationCase({ ...fromCorrection, split: 'heldout' }), null);
  const toolCase = replay.find(row => row.kind === 'tool_failure'); assert.deepEqual(replayEvaluationCase({ ...toolCase, split: 'evolve' }, { toolIds: ['web_fetch'] }).requiredToolIds, ['web_fetch']);
});

test('a failed tool call is told apart by cause: the model\'s call, a service outside, a rule that refused it, an interruption', () => {
  // Live, 30 days to 2026-10-10: 28 failures were all counted against "the tool's description"; 5 were a service or
  // site that did not answer, 1 a write the user's constraint stopped, 1 a call cut short by a new message.
  const cause = (output, code) => toolFailureCause({ name: 'x', status: 'failed', output, ...(code ? { code } : {}) });
  // The typed code decides when the item has one.
  assert.equal(cause('whatever the text says', 'FASTCRW_UPSTREAM'), 'environment'); assert.equal(cause('x', 'FASTCRW_TARGET_BLOCKED'), 'environment'); assert.equal(cause('x', 'media_rate_limit'), 'environment');
  for (const code of ['WEB_UPSTREAM', 'WEB_AUTH', 'WEB_QUOTA', 'WEB_TARGET_HTTP', 'WEB_TIMEOUT', 'WEB_TOOLS_DISABLED']) assert.equal(cause('x', code), 'environment', code);
  assert.equal(cause('x', 'WEB_ARGUMENTS'), 'call'); assert.equal(cause('x', 'WEB_URL_NOT_PUBLIC'), 'refused', 'a page on this machine or a private network is a rule of the host');
  assert.equal(cause('x', 'FASTCRW_ARGUMENTS'), 'call'); assert.equal(cause('x', 'no_match'), 'call'); assert.equal(cause('x', 'conflict'), 'call'); assert.equal(cause('x', 'path_denied'), 'refused');
  assert.equal(cause('{"ok":false,"code":"FASTCRW_UPSTREAM"}', 'no_match'), 'call', 'a code outranks the text');
  // Items recorded before codes were kept: the host's own result texts, as they stand in the live conversations.
  assert.equal(cause('{"ok":false,"provider":"fastcrw","code":"FASTCRW_UPSTREAM","message":"FastCRW or its upstream service failed.","status":502}'), 'environment');
  assert.equal(cause('{"code":"marketplace_unavailable","message":"Skill source is unavailable","installed":false}'), 'environment');
  assert.equal(cause('### Error Error: browserBackend.callTool: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:60732/index.html'), 'environment');
  assert.equal(cause('这次写入没有执行：它会违反用户说过的约束——「…」。按约束改好再写；如果确实需要例外，先问用户。'), 'refused'); assert.equal(cause('Path is outside the project scope or is private.'), 'refused');
  assert.equal(cause('Interrupted call retired after newer user input. Its prior result is unavailable and its historical outcome is not claimed.'), 'interrupted');
  for (const text of ['File hash changed. Read the current file before retrying; nothing was written.', 'Exact oldText was not found. Read the current file before retrying.', '日程不存在', '{"ok":false,"provider":"fastcrw","code":"FASTCRW_ARGUMENTS"}', 'something no rule here knows']) assert.equal(cause(text), 'call', text);

  const turn = { id: 't', status: 'completed', createdAt: at(0), startedAt: at(0), completedAt: at(1), userItemId: 'u' };
  const tool = (id, name, output, code) => ({ id, turnId: 't', kind: 'tool', tool: { name, status: 'failed', output, ...(code ? { code } : {}) } });
  const state = { projects: [{ id: 'p' }], sessions: [{ id: 's', projectId: 'p', turns: [turn], items: [{ id: 'u', turnId: 't', kind: 'user', text: 'update the report' }, tool('a', 'web_fetch', 'x', 'FASTCRW_UPSTREAM'), tool('b', 'project_edit', 'Exact oldText was not found.', 'no_match'), tool('c', 'project_exec', 'cwd "../.." is outside the project or private. cwd is relative to the project folder', 'path_denied')] }] };
  assert.deepEqual(mineProjectSignals(state, 'p', { now: Date.parse(at(10)) }).filter(row => row.kind === 'tool_failure').map(row => [row.detail.tool, row.detail.cause]), [['web_fetch', 'environment'], ['project_edit', 'call'], ['project_exec', 'refused']]);
});
