import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { ProjectInitiativeController } from '../project-initiative-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';
import { createProjectSchedule } from '../../../packages/sdk/src/project-schedules.mjs';

// A scheduled run that ends with FOLLOW-UP settles the review of its completion itself (declared-follow-up.mjs): through the real
// controller and SDK coordinator, only provider output scripted. A declared task is admitted as work without a decision request; the
// follow-up declares in turn; a run that declares nothing is reviewed by the model as before; the line never reaches the user.
const origin = Date.parse('2026-09-26T00:00:00Z');
async function until(check, label, timeout = 10000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error(`Timeout: ${label}`); await delay(5); } }
const TASK = 'Re-check the one unverified source against its primary page today';
const DAY = 86400000;

async function fixture(t, { scheduledReply, followUpReply }) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-declared-')), store = new Store(join(dir, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Declared fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { project, session } = store.createProject({ rhythm: { control: 'manual' }, name: 'Daily report', description: 'A daily verified report', workspace: dir });
  let clock = origin + 3600000;
  const decisions = [], runs = [];
  store.mutate(state => {
    const target = state.projects.find(row => row.id === project.id);
    Object.assign(target, { initialization: { status: 'ready' }, simulated: false, decisionMode: 'rna-model', assignments: { skillIds: [], toolIds: ['project_read'], mcpServerIds: [] } });
    Object.assign(target.initiative, { tokenBudget: null, cooldownMs: 0 });
    target.schedules = [createProjectSchedule({ id: 'review', title: 'Daily report', task: 'Inspect evidence.txt and deliver the finding.', destinationSessionId: session.id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now: origin })];
    state.settings.realTokenBudget = null;
  });
  writeFileSync(join(dir, 'evidence.txt'), 'Seven sources, one unverified.');
  // The decision service is the judge's host side; here only what the declared path asks of it (no judge is configured).
  const decisionService = { enabled: () => false, declaredReviewAllowed: () => true, review: async () => ({ review: true }), openWork: () => ({}) };
  const controller = new ProjectInitiativeController(store, { initialDelayMs: 0, tickIntervalMs: 0, independentLearning: true, now: () => clock, evolutionService: { running: new Map() }, decisionService,
    decisionProvider: async function* (request) {
      const text = request.messages.at(-1)?.content?.[0]?.text ?? '', input = JSON.parse(text); decisions.push(text);
      const output = { action: 'wait', content: '', reason: 'Nothing else to do', evidenceIds: [], nextReviewAfterMs: DAY, };
      yield { type: 'text_delta', delta: JSON.stringify(output) }; yield { type: 'usage', usage: { totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' };
    },
    runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
      // The run's own task is the user message the host's instructions follow (the earlier ones are context, and receipts name the occurrence too).
      const taskMessage = request.messages.findLast(message => message.role === 'user' && /^(?:Scheduled occurrence |Re-check )/.test(message.content?.[0]?.text ?? '')), scheduled = /^Scheduled occurrence /.test(taskMessage?.content?.[0]?.text ?? '');
      runs.push(scheduled ? 'scheduled' : 'follow-up');
      yield { type: 'usage', usage: { input: 10, output: 10, totalTokens: 20 } }; yield { type: 'text_delta', delta: scheduled ? scheduledReply : followUpReply }; yield { type: 'done', stopReason: 'stop' };
    } }) });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = () => store.state.projects.find(row => row.id === project.id);
  return { store, project, session, controller, current, decisions, runs, dir,
    actions: () => current().initiativeRuntime?.sdkState?.actions ?? [],
    jobs: () => current().jobs ?? [],
    async step(rounds = 4) { await this.settle(rounds); },
    messages: () => store.state.sessions.flatMap(row => row.items.filter(item => item.source === 'initiative' && typeof item.text === 'string')),
    async settle(rounds = 6) { for (let n = 0; n < rounds; n++) { controller.schedule(); await delay(20); await controller.pendingPump; await controller.contexts.get(project.id)?.reviewPromise; } } };
}

test('a declared follow-up is admitted without a decision request, declares in turn, and the line never reaches the user', async t => {
  const f = await fixture(t, {
    scheduledReply: `Daily report: seven sources, one unverified.\nFOLLOW-UP: ${TASK}\nHANDOFF: report written, one source unverified, next re-check it`,
    followUpReply: 'Re-check done: the source is confirmed.\nFOLLOW-UP: none\nHANDOFF: confirmed, nothing left',
  });
  await until(() => f.runs.includes('scheduled') && f.actions().some(row => row.hostSchedule && row.action === 'work' && row.status === 'completed'), 'the scheduled run completed');
  await until(() => f.runs.includes('follow-up') && f.actions().filter(row => row.action === 'work' && row.status === 'completed').length >= 2, 'the declared follow-up ran');
  await f.step();
  assert.ok(f.decisions.length <= 1, `the model was asked only before the schedule fell due, not about either completion (${f.decisions.length} requests)`);
  const work = f.actions().filter(row => row.action === 'work');
  const declared = work.find(row => row.hostDeclared);
  assert.ok(declared, 'the follow-up was admitted as a declared work'); assert.equal(declared.hostDeclared.kind, 'task'); assert.equal(declared.hostDeclared.depth, 1); assert.ok(declared.content.startsWith(TASK));
  assert.equal(work.filter(row => row.hostSchedule).length, 1);
  // The decision the follow-up's own completion needed was the declared "none": no request for it either.
  const last = f.actions().length && f.current().initiativeRuntime.sdkState.lastDecision;
  assert.equal(last.declared, true); assert.equal(last.action, 'wait');
  // The scheduled report reached the user without the protocol lines.
  const texts = f.messages().map(item => item.text).join('\n');
  assert.match(texts, /Daily report: seven sources, one unverified\./); assert.doesNotMatch(texts, /FOLLOW-UP|HANDOFF/i);
  // Every wake of these two completions is on the record as not asked.
  const rows = f.current().mind?.pacing?.wake?.history ?? [];
  assert.ok(rows.some(row => row.outcome === 'work' && row.reason === 'declared_follow_up'), JSON.stringify(rows.map(row => [row.outcome, row.reason])));
  assert.ok(rows.some(row => row.outcome === 'deferred' && row.reason === 'declared_no_follow_up'));
  for (const row of rows.filter(row => row.reason?.startsWith('declared_'))) assert.equal(row.tokens, 0);
  // The jobs hold what the runs declared.
  assert.deepEqual(f.jobs().filter(job => job.lane === 'background' && job.followUp).map(job => job.followUp.kind).sort(), ['none', 'task']);
  assert.ok(f.decisions.every(text => !text.includes(TASK)), 'no decision request read the declared follow-up');
});

test('a scheduled run that declared nothing is reviewed by the model, as before', async t => {
  const f = await fixture(t, { scheduledReply: 'Daily report: seven sources.\nHANDOFF: report written', followUpReply: 'unused\nHANDOFF: unused' });
  await until(() => f.runs.includes('scheduled') && f.actions().some(row => row.hostSchedule && row.action === 'work' && row.status === 'completed'), 'the scheduled run completed');
  const before = f.decisions.length;
  await f.step();
  assert.equal(f.runs.filter(run => run === 'follow-up').length, 0);
  assert.ok(f.decisions.length > before, 'the model reviewed the run: it was asked');
  assert.notEqual(f.current().initiativeRuntime.sdkState.lastDecision?.declared, true, 'no declaration, no host decision');
  assert.ok(!f.current().initiativeRuntime.sdkState.actions.some(row => row.hostDeclared));
});
