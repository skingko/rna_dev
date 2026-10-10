import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionService } from '../decision-service.mjs';
import { createDecisionKernel } from '../../../packages/sdk/src/decision-kernel.mjs';

// D4 (docs/research/mind-d4-probes-20261005.md): the decision service's seams for MIND-5 (the capture plan offers the pending
// requests and returns the pick), MIND-4 (turn.settled's promise, with its sentence, kept out of the ledger) and the covered
// notes. A fake System One answers from `pick`; no network, no paid calls.
function fakeJev(pick = {}) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const value = typeof pick === 'function' ? pick(id, question, requests.length) : pick[id];
      if (question.type === 'noul') return [id, { type: 'noul', noul: value ?? .5 }];
      const keys = Object.keys(question.criteria), chosen = value ?? keys.at(-1);
      return [id, { type: 'choice', choice: chosen, probabilities: Object.fromEntries(keys.map(key => [key, key === chosen ? .96 : .04 / (keys.length - 1)])), confidence: .96 }];
    }));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 300, output_tokens: 10 } }));
  };
  return { fetch, requests };
}
function fixture({ pick = {}, modes = {} } = {}) {
  const clock = Date.parse('2026-10-05T10:00:00Z');
  const project = { id: 'p', name: '玄幻小说', description: '长篇连载', workspace: '/fixture/ws', focus: '', schedules: [], versions: [], inbox: [], initiativeRuntime: { sdkState: { actions: [] } } };
  const store = { state: { settings: { realTokenBudget: null }, configuration: { decisionKernel: { mode: 'active', modes: { 'turn.route': 'active', 'mind.judge': 'active', ...modes } }, providers: [] }, projects: [project], sessions: [{ id: 's', projectId: 'p', items: [], turns: [], status: 'idle' }] },
    configurationService: { secrets: { 'judge:jev': 'TEST-ONLY-SECRET' }, writeSecret() {} }, mutate(fn) { return fn(this.state); }, usageLedger: { record() {} } };
  const jev = fakeJev(pick), service = new DecisionService(store, { now: () => clock, kernelFactory: options => createDecisionKernel({ ...options, fetch: jev.fetch }) });
  return { service, store, project, jev };
}
const efforts = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }];

test('MIND-5: turn.route offers the pending requests in its capture plan and hands back the index of the confident pick', async () => {
  const f = fixture({ pick: id => id === 'restates_pending_request' ? 'req_1' : id === 'is_correction' ? .02 : undefined });
  const value = await f.service.route({ project: f.project, sessionId: 's', turnId: 't1', userMessage: '还没写完吧？把第 12 章写完发我。', efforts, memory: false, skills: [], capture: { outputs: [], threads: [], questions: [], requests: [{ commitmentId: 'c1', text: '每周五提醒我备份稿件' }, { commitmentId: 'c2', text: '明天把第 12 章写完发我' }] } });
  const asked = f.jev.requests[0].questions.restates_pending_request;
  assert.deepEqual(Object.keys(asked.criteria), ['req_0', 'req_1', 'none', 'unknown']);
  assert.equal(asked.criteria.req_1, 'Pending request: 明天把第 12 章写完发我');
  assert.equal(value.capture.restates, 1, 'the index into the list the host offered');
  // Nothing pending, nothing asked; an answer of "none" restates nothing.
  const none = fixture({ pick: id => id === 'restates_pending_request' ? 'none' : undefined });
  const second = await none.service.route({ project: none.project, sessionId: 's', turnId: 't2', userMessage: '把第 11 章也写完', efforts, memory: false, skills: [], capture: { outputs: [], threads: [], questions: [], requests: [{ commitmentId: 'c2', text: '明天把第 12 章写完发我' }] } });
  assert.equal(Object.hasOwn(second.capture, 'restates'), false);
  const bare = fixture();
  await bare.service.route({ project: bare.project, sessionId: 's', turnId: 't3', userMessage: 'hi', efforts, memory: false, skills: [], capture: { outputs: [], threads: [], questions: [] } });
  assert.equal(Object.hasOwn(bare.jev.requests[0].questions, 'restates_pending_request'), false);
});

test('MIND-4: turn.settled returns the promise and the sentence that states it; the sentence is never written to the decision ledger', async () => {
  const reply = '第一节已经写好。第二节我会在今晚写完，写完后把全文发给你。';
  const f = fixture({ pick: { instruction_complete: .96, waiting_on_user: .05, deferred_without_cause: .05, commits_to_later_work: .97, promise_sentence: 's_1', feedback_worthwhile: .1 } });
  const verdict = await f.service.settled(f.project, { sessionId: 's', turnId: 't', request: '写第 12 章，今晚发我', reply, effects: ['project_write chapters/12.md'] });
  assert.equal(verdict.promise, true); assert.equal(verdict.promiseText, '第二节我会在今晚写完，写完后把全文发给你。');
  const asked = f.jev.requests[0].questions;
  assert.ok(asked.commits_to_later_work); assert.deepEqual(Object.keys(asked.promise_sentence.criteria), ['s_0', 's_1', 'none', 'unknown']);
  const row = f.store.decisionLedger.rows().at(-1);
  assert.equal(row.point, 'turn.settled'); assert.equal(row.outcome.promise, true);
  assert.ok(!JSON.stringify(row).includes('今晚写完'), 'the promise\'s words are the caller\'s, not the ledger\'s');
  // A reply the judge cannot place a sentence in: the reply's closing words.
  const unplaced = fixture({ pick: { instruction_complete: .96, waiting_on_user: .05, deferred_without_cause: .05, commits_to_later_work: .97, promise_sentence: 'unknown' } });
  assert.equal((await unplaced.service.settled(unplaced.project, { sessionId: 's', turnId: 't', request: 'x', reply })).promiseText, '第一节已经写好。 第二节我会在今晚写完，写完后把全文发给你。');
  // The later work a schedule this turn created carries is not promised twice.
  const scheduled = fixture({ pick: { instruction_complete: .96, waiting_on_user: .05, deferred_without_cause: .05, commits_to_later_work: .97, schedule_requested: .97 } });
  const carried = await scheduled.service.settled(scheduled.project, { sessionId: 's', turnId: 't', request: '每周一汇总新论文', reply: '已经建好每周一 09:00 的定时任务。会自动汇总新论文并发到这个对话里。', scheduled: true });
  assert.equal(carried.promise, false); assert.equal(Object.hasOwn(carried, 'promiseText'), false);
  // A conditional reply: no promise, whatever it says about "later".
  const conditional = fixture({ pick: { instruction_complete: .9, waiting_on_user: .93, deferred_without_cause: .05, commits_to_later_work: .96 } });
  assert.equal((await conditional.service.settled(conditional.project, { sessionId: 's', turnId: 't', request: '开始写第 13 章', reply: '大纲有两种走法，你确认之后我会开始写。' })).promise, false);
});

test('D4 notes: mindCovered asks one batch over the notes and the rules, marks the confident ones, and gives no answer when the judge cannot be reached', async () => {
  const f = fixture({ pick: id => id === 'covered_1' ? .97 : id === 'covered_0' ? .3 : undefined });
  const judged = await f.service.mindCovered(f.project, { rows: [{ text: '每章结尾留悬念' }, { text: '表达不要过于生硬，要有活人感' }], rules: [{ text: '行文要有活人感，别太生硬。' }] });
  assert.deepEqual(judged.covered, [1]); assert.equal(typeof judged.ledgerId, 'string');
  assert.equal(f.jev.requests.length, 1);
  assert.deepEqual(f.jev.requests[0].state.mind.rules, [{ id: 'R0', text: '行文要有活人感，别太生硬。' }]);
  assert.deepEqual(f.jev.requests[0].state.mind.rows.map(row => row.id), ['N0', 'N1']);
  assert.equal(await f.service.mindCovered(f.project, { rows: [], rules: [{ text: 'r' }] }), null);
  assert.equal(await f.service.mindCovered(f.project, { rows: [{ text: 'a' }], rules: [] }), null, 'no rule to be covered by');
  const off = fixture({ modes: { 'mind.judge': 'off' } });
  assert.equal(await off.service.mindCovered(off.project, { rows: [{ text: 'a' }], rules: [{ text: 'r' }] }), null);
  const failing = fixture(); failing.service.kernelFactory = options => createDecisionKernel({ ...options, fetch: async () => { throw new Error('down'); } }); failing.service.kernelRevision = null;
  assert.equal(await failing.service.mindCovered(failing.project, { rows: [{ text: 'a' }], rules: [{ text: 'r' }] }), null);
});
