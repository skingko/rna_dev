import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { InitiativeCoordinator } from '../src/initiative.mjs';

const hold = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async fn => { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error('Control fixture did not settle'); await delay(2); } };
const action = (id = 'work-a') => ({ id, action: 'work', status: 'queued', content: `Inspect ${id}`, reason: 'External project evidence', evidenceIds: ['e1'], revision: 1, nextReviewAfterMs: 1000, createdAt: 1 });
const state = (actions = [action()]) => ({ schemaVersion: 1, revision: 1, events: [{ id: 'e1', type: 'user_message', summary: 'Inspect project evidence', at: 1 }], seenEventIds: ['e1'], actions, decisionRevision: 1, nextReviewAt: 999999, lastSharedAt: null, usedTokens: 0, reservedTokens: 0 });
const fixture = options => new InitiativeCoordinator({ state: state(), actionControlKinds: ['work'], handlers: { work: async () => ({ usage: { totalTokens: 0 } }) }, ...options });
const command = (id, kind, expectedRevision = 0, instruction) => ({ id, kind, expectedRevision, ...(instruction === undefined ? {} : { instruction }) });

test('control admission is explicit, validated, CAS protected and idempotent across retries', async () => {
  const legacy = fixture({ actionControlKinds: [] }); await assert.rejects(legacy.requestActionControl('work-a', command('p1', 'pause')), { code: 'action_control_unavailable' }); await legacy.close();
  const c = fixture();
  for (const input of [{ id: 'p1', kind: 'pause' }, command('p1', 'steer', 0, ' '), command('p1', 'pause', 0, 'hidden payload'), { ...command('p1', 'pause'), extra: true }]) await assert.rejects(c.requestActionControl('work-a', input), { code: 'invalid_action_control' });
  const first = await c.requestActionControl('work-a', command('p1', 'pause'));
  assert.equal(first.status, 'applied'); assert.equal(c.snapshot().actions[0].status, 'paused');
  assert.deepEqual(await c.requestActionControl('work-a', command('p1', 'pause')), first);
  await assert.rejects(c.requestActionControl('work-a', command('p1', 'cancel')), { code: 'action_control_conflict' });
  await assert.rejects(c.requestActionControl('work-a', command('r1', 'resume')), { code: 'action_control_conflict' });
  const resumed = await c.requestActionControl('work-a', command('r1', 'resume', 1)); assert.equal(resumed.revision, 2); assert.equal(c.snapshot().actions[0].status, 'queued'); await c.close();
});

test('failed admission rolls back pause and resume and hides commands until persistence succeeds', async () => {
  const entered = hold(), release = hold(); let failing = true;
  const c = fixture({ saveState: async saved => { if (saved.actions[0].controlRevision === 1) { entered.resolve(); await release.promise; if (failing) throw new Error('Disk unavailable'); } } });
  const pending = c.requestActionControl('work-a', command('s1', 'steer', 0, 'Check compatibility')); const rejection = assert.rejects(pending, /Disk unavailable/);
  await entered.promise; assert.deepEqual(c.pendingActionControls('work-a'), []); release.resolve(); await rejection;
  assert.equal(c.snapshot().actions[0].controlRevision, undefined); assert.equal(c.snapshot().actions[0].controls, undefined);
  failing = false; await c.requestActionControl('work-a', command('p1', 'pause')); const before = c.snapshot();
  c.saveState = async () => { throw new Error('Cannot resume'); };
  await assert.rejects(c.requestActionControl('work-a', command('r1', 'resume', 1)), /Cannot resume/);
  assert.deepEqual(c.snapshot(), before); c.saveState = async () => {}; await c.requestActionControl('work-a', command('r1', 'resume', 1)); await c.close();
});

test('uncommitted resume never dispatches a paused action', async () => {
  const entered = hold(), release = hold(); let calls = 0;
  const c = fixture({ handlers: { work: async () => { calls++; } } }); await c.requestActionControl('work-a', command('pause', 'pause'));
  c.saveState = async saved => { if (saved.actions[0].controls.at(-1).kind === 'resume') { entered.resolve(); await release.promise; throw new Error('No durable admission'); } };
  const pending = c.requestActionControl('work-a', command('resume', 'resume', 1)), rejected = assert.rejects(pending, /No durable admission/); await entered.promise;
  await c.tick({ decisionEnabled: false }); assert.equal(calls, 0); release.resolve(); await rejected; assert.equal(c.snapshot().actions[0].status, 'paused'); c.saveState = async () => {}; await c.requestActionControl('work-a', command('resume', 'resume', 1)); await c.close();
});

test('one work action pauses at its boundary while ordinary evidence and foreground judgment invalidation leave peers running', async () => {
  const exits = new Map([['work-a', hold()], ['work-b', hold()]]), entered = new Map(), calls = [], facts = [];
  const c = fixture({ state: state([action('work-a'), action('work-b')]), policy: { maxConcurrent: 2 }, handlers: { work: async (a, input) => {
    calls.push({ id: a.id, checkpoint: a.checkpoint }); entered.set(a.id, input);
    if (a.checkpoint) { assert.deepEqual(a.checkpoint, { sessionId: a.id, turnId: 'turn-a' }); return { summary: 'Continued after the retained checkpoint', usage: { totalTokens: 3 } }; }
    facts.push(a.id); const control = await exits.get(a.id).promise;
    return control ? { control, usage: { totalTokens: 2 } } : { summary: 'Peer work completed', usage: { totalTokens: 2 } };
  } } });
  await c.tick({ decisionEnabled: false }); await until(() => entered.size === 2);
  await c.observe({ id: 'e2', type: 'user_message', summary: 'A normal follow-up question' }); c.invalidateDecision('foreground_message');
  assert.equal(entered.get('work-a').signal.aborted, false); assert.equal(entered.get('work-b').signal.aborted, false);
  const receipt = await c.requestActionControl('work-a', command('pause-a', 'pause')); assert.equal(receipt.status, 'pending');
  assert.equal(c.snapshot().actions[0].status, 'running'); assert.equal(entered.get('work-a').signal.aborted, false); assert.equal(c.pendingActionControls('work-b').length, 0);
  exits.get('work-a').resolve({ commandId: receipt.id, kind: 'pause', checkpoint: { sessionId: 'work-a', turnId: 'turn-a' }, summary: 'Request and tools settled' }); exits.get('work-b').resolve(); await c.idle();
  assert.deepEqual(c.snapshot().actions.map(a => a.status), ['paused', 'completed']); assert.equal(c.snapshot().actions[0].controls[0].status, 'applied');
  assert.equal(c.snapshot().events.filter(e => e.type === 'action_completed').length, 1, 'pausing must not invent completion evidence');
  await c.requestActionControl('work-a', command('resume-a', 'resume', 1)); await c.tick({ decisionEnabled: false }); await c.idle();
  assert.deepEqual(calls.map(row => row.id), ['work-a', 'work-b', 'work-a']); assert.deepEqual(facts, ['work-a', 'work-b'], 'host reused the checkpoint instead of replaying completed work'); assert.equal(c.snapshot().actions[0].status, 'completed'); await c.close();
});

test('steering acknowledgement is durable, ordered, and cannot falsely settle a running pause', async () => {
  const gate = hold(), entered = hold(); let input;
  const c = fixture({ handlers: { work: async (_a, context) => { input = context; entered.resolve(); await gate.promise; return { usage: { totalTokens: 0 } }; } } });
  await c.tick({ decisionEnabled: false }); await entered.promise;
  await c.requestActionControl('work-a', command('s1', 'steer', 0, 'Read the implementation'));
  await c.requestActionControl('work-a', command('s2', 'steer', 1, 'Include compatibility'));
  await c.requestActionControl('work-a', command('p1', 'pause', 2));
  await assert.rejects(input.acknowledgeControl('s2', { status: 'applied', summary: 'Queued' }), { code: 'action_control_order' });
  await assert.rejects(input.acknowledgeControl('p1', { status: 'applied', summary: 'Abort sent' }), { code: 'action_control_state' });
  c.saveState = async saved => { if (saved.actions[0].controls[0].status === 'applied') throw new Error('No receipt'); };
  await assert.rejects(input.acknowledgeControl('s1', { status: 'applied', summary: 'Journal committed' }), /No receipt/); assert.equal(input.pendingControls()[0].id, 's1');
  c.saveState = async () => {};
  const receipt = await input.acknowledgeControl('s1', { status: 'applied', summary: 'Journal committed' }); assert.deepEqual(await input.acknowledgeControl('s1', { status: 'applied', summary: 'Journal committed' }), receipt);
  gate.resolve(); await c.idle(); assert.deepEqual(c.snapshot().actions[0].controls.map(row => row.status), ['applied', 'rejected', 'rejected']); await c.close();
});

test('paused checkpoints survive restart; running or uncertain actions cannot use resume to bypass verification', async () => {
  const paused = { ...action(), status: 'paused', startedAt: 2, checkpoint: { sessionId: 'work-a' }, controlRevision: 1, controls: [{ ...command('pause', 'pause'), revision: 1, status: 'applied', createdAt: 3, settledAt: 4, summary: 'Settled' }] };
  let resumes = 0;
  const c = fixture({ state: state([paused]), handlers: { work: async a => { assert.equal(a.checkpoint.sessionId, a.id); resumes++; return { usage: { totalTokens: 0 } }; } } });
  await c.requestActionControl('work-a', command('resume', 'resume', 1)); await c.tick({ decisionEnabled: false }); await c.idle(); assert.equal(resumes, 1); await c.close();
  const running = fixture({ state: state([{ ...action(), status: 'running' }]) });
  assert.equal(running.snapshot().actions[0].status, 'needs_review'); assert.equal(running.snapshot().actions[0].blocksExecution, true);
  await assert.rejects(running.requestActionControl('work-a', command('resume', 'resume')), { code: 'action_control_state' }); await running.close();
  const broken = fixture({ state: state([{ ...action(), status: 'paused', startedAt: 2 }]) }); await assert.rejects(broken.requestActionControl('work-a', command('resume', 'resume')), { code: 'action_control_state' }); await broken.close();
});

test('bounded control receipts retain pending input and stale evicted ids cannot replay', async () => {
  const c = fixture();
  for (let i = 0; i < 80; i++) {
    await c.requestActionControl('work-a', command(`s${i}`, 'steer', i, `Direction ${i}`));
    await c.acknowledgeActionControl('work-a', `s${i}`, { status: 'applied', summary: 'Durably appended to the original session' });
  }
  assert.equal(c.snapshot().actions[0].controls.length, 64); assert.equal(c.snapshot().actions[0].controlRevision, 80);
  await assert.rejects(c.requestActionControl('work-a', command('s0', 'steer', 0, 'Direction 0')), { code: 'action_control_conflict' });
  for (let i = 80; i < 96; i++) await c.requestActionControl('work-a', command(`s${i}`, 'steer', i, `Direction ${i}`));
  assert.equal(c.pendingActionControls('work-a').length, 16); await assert.rejects(c.requestActionControl('work-a', command('s96', 'steer', 96, 'Overflow')), { code: 'action_control_full' }); assert.equal(c.snapshot().actions[0].controlRevision, 96); await c.close();
});

test('queued cancellation does not launch tools and settles previously pending steering explicitly', async () => {
  let calls = 0; const c = fixture({ handlers: { work: async () => { calls++; } } });
  await c.requestActionControl('work-a', command('steer', 'steer', 0, 'New direction')); await c.requestActionControl('work-a', command('cancel', 'cancel', 1)); await c.tick({ decisionEnabled: false });
  assert.equal(calls, 0); assert.equal(c.snapshot().actions[0].status, 'cancelled'); assert.deepEqual(c.snapshot().actions[0].controls.map(row => row.status), ['rejected', 'applied']); assert.equal(c.pendingActionControls('work-a').length, 0); await c.close();
});

test('safe cancellation must be a matching host boundary receipt and creates no completion evidence', async () => {
  const gate = hold(); const c = fixture({ handlers: { work: async () => ({ control: await gate.promise, usage: { totalTokens: 0 } }) } });
  await c.tick({ decisionEnabled: false }); await c.requestActionControl('work-a', command('cancel', 'cancel'));
  gate.resolve({ commandId: 'cancel', kind: 'cancel', summary: 'All dispatched tools settled; remaining calls never started' }); await c.idle();
  assert.equal(c.snapshot().actions[0].status, 'cancelled'); assert.equal(c.snapshot().actions[0].controls[0].status, 'applied'); assert.equal(c.snapshot().events.length, 1); await c.close();
});

test('unknown side effects dominate pending pause and retain the execution barrier', async () => {
  const gate = hold(); const c = fixture({ handlers: { work: async () => { await gate.promise; throw Object.assign(new Error('External operation outcome unknown'), { code: 'uncertain_tool' }); } } });
  await c.tick({ decisionEnabled: false }); await c.requestActionControl('work-a', command('pause', 'pause')); gate.resolve(); await c.idle();
  const a = c.snapshot().actions[0]; assert.equal(a.status, 'needs_review'); assert.equal(a.blocksExecution, true); assert.equal(a.controls[0].status, 'rejected'); assert.equal(a.checkpoint, undefined);
  await assert.rejects(c.requestActionControl('work-a', command('resume', 'resume', 1)), { code: 'action_control_state' }); await c.close();
});

test('a failed safe-boundary commit cannot leave an in-memory paused action or applied command', async () => {
  const gate = hold(); let saved;
  const c = fixture({ saveState: state => { if (state.actions[0].status === 'paused') throw new Error('Boundary store failed'); saved = state; }, handlers: { work: async () => ({ control: await gate.promise, usage: { totalTokens: 0 } }) } });
  await c.tick({ decisionEnabled: false }); await c.requestActionControl('work-a', command('pause', 'pause')); gate.resolve({ commandId: 'pause', kind: 'pause', checkpoint: { sessionId: 'work-a' }, summary: 'Journal retained' }); await c.idle();
  const a = c.snapshot().actions[0]; assert.equal(a.status, 'needs_review'); assert.equal(a.blocksExecution, true); assert.equal(a.errorCode, 'action_control_persistence'); assert.equal(a.controls[0].status, 'rejected'); assert.equal(a.checkpoint, undefined); assert.equal(saved.actions[0].status, 'needs_review'); await c.close();
});

test('unmatched or malformed host boundary receipts cannot be accepted as a pause', async () => {
  for (const control of [{ commandId: 'pause', kind: 'pause', summary: 'Missing checkpoint' }, { commandId: 'other', kind: 'pause', checkpoint: { sessionId: 'work-a' }, summary: 'Wrong command' }, { commandId: 'pause', kind: 'pause', checkpoint: { sessionId: 'work-a', arbitrary: 'not allowed' }, summary: 'Opaque checkpoint rejected' }]) {
    const gate = hold(), c = fixture({ handlers: { work: async () => ({ control: await gate.promise, usage: { totalTokens: 0 } }) } });
    await c.tick({ decisionEnabled: false }); await c.requestActionControl('work-a', command('pause', 'pause')); gate.resolve(control); await c.idle(); assert.equal(c.snapshot().actions[0].status, 'failed'); assert.equal(c.snapshot().actions[0].controls[0].status, 'rejected'); await c.close();
  }
});

test('a queued host admission guard rechecks revoked sources before any mutation or persistence', async () => {
  const entered = hold(), release = hold(); let valid = true, writes = 0;
  const c = fixture({ saveState: async saved => { writes++; if (saved.actions[0].controlRevision === 1) { entered.resolve(); await release.promise; } } });
  const first = c.requestActionControl('work-a', command('pause', 'pause')); await entered.promise;
  const second = c.requestActionControl('work-a', command('resume', 'resume', 1), { beforeCommit: () => { if (!valid) throw Object.assign(new Error('Source was revoked'), { code: 'source_revoked' }); } });
  const rejected = assert.rejects(second, { code: 'source_revoked' }); valid = false; release.resolve(); await first; await rejected;
  assert.equal(writes, 1); assert.equal(c.snapshot().actions[0].controlRevision, 1); assert.equal(c.snapshot().actions[0].status, 'paused'); await c.close();
});

test('a pending lifecycle command cannot be replaced by a second pause or cancellation', async () => {
  const gate = hold(), c = fixture({ handlers: { work: async () => ({ control: await gate.promise, usage: { totalTokens: 0 } }) } });
  await c.tick({ decisionEnabled: false }); await c.requestActionControl('work-a', command('pause', 'pause'));
  for (const kind of ['pause', 'cancel']) await assert.rejects(c.requestActionControl('work-a', command(`second-${kind}`, kind, 1)), { code: 'action_control_state' });
  assert.equal(c.snapshot().actions[0].controls.length, 1); gate.resolve({ commandId: 'pause', kind: 'pause', checkpoint: { sessionId: 'work-a' }, summary: 'Safe boundary' }); await c.idle(); await c.close();
});

test('resume can queue during final accounting without redispatching an action whose prior handler still owns its slot', async () => {
  const gate = hold(), accounting = hold(), releaseAccounting = hold(); let calls = 0, pauseSaves = 0;
  const c = fixture({ policy: { maxConcurrent: 2 }, saveState: async saved => {
    if (saved.actions[0].status === 'paused' && ++pauseSaves === 2) { accounting.resolve(); await releaseAccounting.promise; }
  }, handlers: { work: async () => { calls++; return calls === 1 ? { control: await gate.promise, usage: { totalTokens: 0 } } : { summary: 'Retained session continued', usage: { totalTokens: 0 } }; } } });
  await c.tick({ decisionEnabled: false }); await c.requestActionControl('work-a', command('pause', 'pause'));
  gate.resolve({ commandId: 'pause', kind: 'pause', checkpoint: { sessionId: 'work-a' }, summary: 'Safe boundary' }); await accounting.promise;
  // Resume cannot finish persistence behind final accounting, but its tentative
  // queued state is already visible to a concurrently draining scheduler.
  const resume = c.requestActionControl('work-a', command('resume', 'resume', 1)); await delay(0); await c.tick({ decisionEnabled: false }); assert.equal(calls, 1);
  releaseAccounting.resolve(); await resume; await c.idle(); await c.tick({ decisionEnabled: false }); await c.idle(); assert.equal(calls, 2); assert.equal(c.snapshot().actions[0].status, 'completed'); await c.close();
});

test('restart retains confirmed steering but never redelivers unconfirmed commands from interrupted actions', async () => {
  for (const status of ['running', 'needs_review']) {
    const old = { ...action(), status, controls: [
      { ...command('steer-done', 'steer', 0, 'Original accepted direction'), revision: 1, status: 'applied', createdAt: 1, settledAt: 2, summary: 'Journal confirmed' },
      { ...command('steer-unknown', 'steer', 1, 'May already be in the journal'), revision: 2, status: 'pending', createdAt: 3 },
      { ...command('pause-unknown', 'pause', 2), revision: 3, status: 'pending', createdAt: 4 }
    ], controlRevision: 3 };
    const c = fixture({ state: state([old]) }), restored = c.snapshot().actions[0];
    assert.equal(restored.status, 'needs_review'); assert.deepEqual(restored.controls.map(command => command.status), ['applied', 'rejected', 'rejected']);
    assert.equal(restored.controls[1].instruction, 'May already be in the journal'); assert.match(restored.controls[1].summary, /unconfirmed/); assert.equal(restored.controlRevision, 3); assert.deepEqual(c.pendingActionControls('work-a'), []); await c.close();
  }
});

test('revoked or deleted action sources cannot be resumed or steered by guessing their retained ids', async () => {
  for (const flag of ['contextRevoked', 'sourceDeleted']) {
    const c = fixture({ state: state([{ ...action(), status: 'paused', [flag]: true }]) });
    for (const input of [command('resume', 'resume'), command('steer', 'steer', 0, 'New direction')]) await assert.rejects(c.requestActionControl('work-a', input), { code: 'action_control_unavailable' });
    assert.equal(c.snapshot().actions[0].controlRevision, undefined); await c.close();
  }
});

test('corrupt persisted command histories fail closed instead of delivering unbounded or ambiguous instructions', () => {
  const original = { ...command('steer', 'steer', 0, 'Known instruction'), revision: 1, status: 'pending', createdAt: 1 };
  for (const controls of [[{ ...original, instruction: 'x'.repeat(8001) }], [{ ...original, kind: 'pause' }], [{ ...original, status: 'applied' }], [original, { ...original, id: 'second' }]]) {
    assert.throws(() => fixture({ state: state([{ ...action(), controlRevision: 2, controls }]) }), { code: 'invalid_state' });
  }
});

test('a paused action excludes newly generated work; an illegal paraphrased replacement never reaches a handler', async () => {
  for (const illegal of [false, true]) {
    let works = 0, inspected = false;
    const c = fixture({ model: { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', maxOutputTokens: 1000 },
      state: state([{ ...action(), status: 'paused' }]), handlers: { work: async () => { works++; }, share: async () => {} },
      provider: async function* (request) {
        const input = JSON.parse(request.messages[0].content[0].text); inspected = true;
        assert.equal(input.availableActions.includes('work'), false); assert.equal(input.availableActions.includes('share'), true);
        assert.equal(input.recentActions[0].controlState.paused, true); assert.match(input.recentActions[0].controlState.recovery, /explicitly resumed or stopped/);
        yield { type: 'text_delta', delta: JSON.stringify({ action: illegal ? 'work' : 'wait', content: illegal ? 'A completely new description of the paused duty' : '', reason: 'Observed project state', evidenceIds: illegal ? ['e1'] : [], nextReviewAfterMs: 60000 }) };
        yield { type: 'usage', usage: { totalTokens: 2 } }; yield { type: 'done', stopReason: 'stop' };
      }
    });
    c.state.decisionRevision = -1;
    if (illegal) await assert.rejects(c.tick(), { code: 'invalid_decision' }); else await c.tick();
    assert.equal(inspected, true); assert.equal(works, 0); assert.equal(c.snapshot().actions.length, 1); await c.close();
  }
});

test('pause gates new automatic investigation without stopping admitted peers or independent due schedules', async () => {
  const calls = [], c = fixture({ state: state([{ ...action(), status: 'paused' }, action('independent-existing')]), policy: { maxConcurrent: 3 }, handlers: { work: async a => { calls.push(a.id); return { usage: { totalTokens: 0 } }; } } });
  await c.enqueueHostAction({ id: 'independent-schedule', action: 'work', content: 'Deliver an independent recurring report', reason: 'Registered occurrence is due', source: { id: 'occurrence', type: 'scheduled_occurrence', summary: 'Daily report is due', at: 1 }, hostSchedule: { key: 'occurrence-key', scheduleId: 'report', scheduleRevision: 1, destinationSessionId: 'conversation' } });
  await c.tick({ decisionEnabled: false }); await c.idle(); assert.deepEqual(calls.sort(), ['independent-existing', 'independent-schedule']); assert.equal(c.snapshot().actions[0].status, 'paused'); await c.close();
});

test('explicit stop releases the new-work gate while retaining the paused receipt', async () => {
  let inspected = false;
  const c = fixture({ model: { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', maxOutputTokens: 1000 }, state: state([{ ...action(), status: 'paused' }]), provider: async function* (request) {
    inspected = true; assert.equal(JSON.parse(request.messages[0].content[0].text).availableActions.includes('work'), true);
    yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', content: '', reason: 'No new evidence requires work', evidenceIds: [], nextReviewAfterMs: 60000 }) }; yield { type: 'usage', usage: { totalTokens: 2 } }; yield { type: 'done', stopReason: 'stop' };
  } });
  await c.requestActionControl('work-a', command('cancel', 'cancel')); await c.tick(); assert.equal(inspected, true); assert.equal(c.snapshot().actions[0].status, 'cancelled'); assert.equal(c.snapshot().actions[0].controls[0].status, 'applied'); await c.close();
});

test('pause revokes an in-flight speculative decision before waiting for command persistence', async () => {
  const providerEntered = hold(), providerRelease = hold(), saveEntered = hold(), saveRelease = hold(), workRelease = hold(); let providerSignal;
  const c = fixture({ model: { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', maxOutputTokens: 1000 },
    state: { ...state(), decisionRevision: -1 },
    saveState: async saved => { if (saved.actions[0].controls?.[0]?.status === 'pending') { saveEntered.resolve(); await saveRelease.promise; } },
    handlers: { work: async () => ({ control: await workRelease.promise, usage: { totalTokens: 0 } }) },
    provider: async function* (request) {
      providerSignal = request.signal; providerEntered.resolve(); await providerRelease.promise;
      yield { type: 'text_delta', delta: JSON.stringify({ action: 'work', content: 'A speculative replacement', reason: 'Old evidence', evidenceIds: ['e1'], nextReviewAfterMs: 1000 }) }; yield { type: 'done', stopReason: 'stop' };
    }
  });
  const tick = c.tick(); await providerEntered.promise;
  const pause = c.requestActionControl('work-a', command('pause', 'pause')); await saveEntered.promise;
  assert.equal(providerSignal.aborted, true); assert.equal(c.snapshot().actions.length, 1); providerRelease.resolve(); saveRelease.resolve(); await pause; assert.equal((await tick).status, 'stale'); assert.equal(c.snapshot().actions.length, 1);
  workRelease.resolve({ commandId: 'pause', kind: 'pause', checkpoint: { sessionId: 'work-a' }, summary: 'Safe checkpoint' }); await c.idle(); await c.close();
});

test('host-bound conversation provenance is durable and cannot change or disappear in an idempotent retry', async () => {
  let saved;
  const c = fixture({ saveState: value => { saved = value; } });
  const input = { ...command('steer-from-chat', 'steer', 0, 'Derived direction from the current conversation'), sourceSessionId: 'conversation-b' };
  const receipt = await c.requestActionControl('work-a', input); assert.equal(receipt.sourceSessionId, 'conversation-b');
  assert.equal(c.pendingActionControls('work-a')[0].sourceSessionId, 'conversation-b');
  await c.acknowledgeActionControl('work-a', input.id, { status: 'applied', summary: 'Instruction saved in the original action journal' });
  const acknowledged = await c.requestActionControl('work-a', input); assert.equal(acknowledged.sourceSessionId, 'conversation-b'); assert.equal(acknowledged.status, 'applied');
  await assert.rejects(c.requestActionControl('work-a', { ...input, sourceSessionId: 'different-conversation' }), { code: 'action_control_conflict' });
  const { sourceSessionId: _source, ...withoutSource } = input;
  await assert.rejects(c.requestActionControl('work-a', withoutSource), { code: 'action_control_conflict' });
  await c.close(); const reopened = fixture({ state: saved });
  assert.deepEqual(await reopened.requestActionControl('work-a', input), acknowledged); assert.equal(reopened.snapshot().actions[0].controls[0].sourceSessionId, 'conversation-b'); await reopened.close();
});

test('invalid conversation provenance is rejected on admission and persisted-state restoration', async () => {
  for (const sourceSessionId of ['', ' ', 'x'.repeat(129), 'session\0hidden', null, 42]) {
    const c = fixture(), input = { ...command('steer', 'steer', 0, 'Direction'), sourceSessionId };
    await assert.rejects(c.requestActionControl('work-a', input), { code: 'invalid_action_control' }); assert.equal(c.snapshot().actions[0].controlRevision, undefined); await c.close();
    const controls = [{ ...input, revision: 1, status: 'pending', createdAt: 1 }];
    assert.throws(() => fixture({ state: state([{ ...action(), controlRevision: 1, controls }]) }), { code: 'invalid_state' });
  }
  const c = fixture(); const receipt = await c.requestActionControl('work-a', { ...command('pause', 'pause'), sourceSessionId: 'x'.repeat(128) }); assert.equal(receipt.sourceSessionId.length, 128); await c.close();
});

test('source identities survive receipt eviction; a 129th distinct conversation fails without losing earlier provenance', async () => {
  let saved;
  const c = fixture({ saveState: value => { saved = value; } });
  for (let i = 0; i < 128; i++) {
    await c.requestActionControl('work-a', { ...command(`source-command-${i}`, 'steer', i, `Instruction ${i}`), sourceSessionId: `conversation-${i}` });
    await c.acknowledgeActionControl('work-a', `source-command-${i}`, { status: 'applied', summary: 'Saved in the original journal' });
  }
  const before = c.snapshot(); assert.equal(before.actions[0].controls.length, 64); assert.equal(before.actions[0].controlSourceSessionIds.length, 128);
  assert.equal(before.actions[0].controls.some(command => command.sourceSessionId === 'conversation-0'), false); assert.equal(before.actions[0].controlSourceSessionIds.includes('conversation-0'), true);
  await assert.rejects(c.requestActionControl('work-a', { ...command('source-overflow', 'steer', 128, 'New conversation'), sourceSessionId: 'conversation-128' }), { code: 'action_control_full' }); assert.deepEqual(c.snapshot(), before);
  await c.requestActionControl('work-a', { ...command('retained-source', 'steer', 128, 'Another instruction from an existing source'), sourceSessionId: 'conversation-0' }); assert.equal(c.snapshot().actions[0].controlSourceSessionIds.length, 128);
  await c.close(); const reopened = fixture({ state: saved }); assert.deepEqual(reopened.snapshot().actions[0].controlSourceSessionIds, before.actions[0].controlSourceSessionIds); await reopened.close();
});

test('failed control persistence rolls back newly added provenance, while restored receipts backfill only recorded source ids', async () => {
  const c = fixture({ saveState: async () => { throw new Error('Provenance receipt failed'); } });
  await assert.rejects(c.requestActionControl('work-a', { ...command('with-source', 'steer', 0, 'Instruction'), sourceSessionId: 'new-conversation' }), /Provenance receipt failed/);
  assert.equal(c.snapshot().actions[0].controlSourceSessionIds, undefined); assert.equal(c.snapshot().actions[0].controls, undefined);
  c.saveState = async () => {}; await c.requestActionControl('work-a', command('without-source', 'pause')); await c.close();
  const controls = [{ ...command('recorded-source', 'steer', 0, 'Original instruction'), sourceSessionId: 'known-conversation', revision: 1, status: 'pending', createdAt: 1 }];
  const restored = fixture({ state: state([{ ...action(), controls, controlRevision: 1 }]) }); assert.deepEqual(restored.snapshot().actions[0].controlSourceSessionIds, ['known-conversation']); await restored.close();
});
