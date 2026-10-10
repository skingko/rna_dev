// D4 scenario (token-burn T2, design 2026-10-05 §5 P1): a scheduled run declares only the tools it can execute. The
// purpose-only stubs (agent_*, ask_user, capability_*, project_schedule…) were never called in 177 background runs and
// cost about 5K tokens on every request, so a due occurrence's requests no longer carry them; the system prompt and the
// shared context stay the foreground's, the authorization block names what was left out, and a call to one gets the
// session's "not assigned" receipt while the run goes on to finish and deliver. The foreground and a decision-started
// background run in the same world keep the full array; a paused scheduled run resumes with the surface it began with;
// the tool hooks (here an evolution guard) fire on the lean run's writes as on any other run.
// Crosses the schedule service, the initiative's scheduled work, createRnaRuntime, the SDK session and the host ToolPolicy.
// Only the model, JEV and the clock are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorld, gitReady, until } from '../harness/world.mjs';
import { replayJournal, summarize } from '../../benchmark/surface-replay.mjs';
import { scenario } from '../harness/scenario.mjs';
import { ProjectGenomeStore } from '../../project-genome-store.mjs';
import { GENOME } from '../helpers/gene-fixture.mjs';

const MINUTE = 60000, HOUR = 3600000;
const names = request => (request.tools ?? []).map(tool => tool.name);
// The host-authorization block of a request: the context message's text is `<label>\n[{"source":…,"text":"<json>"}]`.
const authorizationOf = request => {
  const text = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).map(part => part.text ?? '').find(part => part.includes('[{"source":"host-authorization"'));
  assert.ok(text, 'the request carries the authorization block');
  return JSON.parse(JSON.parse(text.slice(text.indexOf('[{"source":"host-authorization"')))[0].text);
};
const NOT_ASSIGNED = /Tool is not assigned to this session/;

// The evolution guard of tool-hooks-every-purpose.test.mjs: flags a TODO in a note written under notes/.
const GUARD_TOOL = { id: 'todo_guard', name: 'TODO check', description: 'Flags lines that still say TODO. Takes {path}.', permission: 'read',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  script: "const text = await api.readFile(input.path); const hits = []; text.split('\\n').forEach((line, index) => { if (/TODO/.test(line)) hits.push({ line: index + 1, excerpt: line.slice(0, 160), note: 'left a TODO' }); }); return { hits, summary: hits.length + ' found' };",
  smokeCases: [{ input: { path: 'sample.md' }, expected: { hits: [{ line: 1, excerpt: 'TODO here', note: 'left a TODO' }], summary: '1 found' }, workspace: { files: [{ path: 'sample.md', content: 'TODO here\n' }] } }] };
async function installGuard(world) {
  const prepared = await new ProjectGenomeStore(world.store).prepare(world.project(), { genome: { ...GENOME, tools: [GUARD_TOOL] } }); await prepared.commit();
  world.store.mutate(state => {
    const target = state.projects.find(row => row.id === world.projectId), at = new Date().toISOString();
    target.versions = [{ id: prepared.record.versionId, version: '0.1.0', title: 'baseline', state: 'active', source: 'initialization', bundle: prepared.record, generatedSkills: prepared.skillManifests, generatedTools: prepared.toolDescriptors, createdAt: at, simulated: false }];
    target.activeVersionId = prepared.record.versionId;
    target.genes = { genes: [{ id: 'guard:todo_guard', layer: 'guard', key: 'todo_guard', title: 'TODO check', summary: 'No TODO left in the notes.', status: 'active', level: 0, body: { toolId: 'todo_guard', trigger: { onWrite: ['notes/**/*.md'] } }, createdAt: at, updatedAt: at, history: [] }], generations: [] };
  });
}

/** A world with a daily schedule at 10:00 (Shanghai) and a conversation turn behind it, so the foreground's tools are on record. */
async function scheduledWorld(t, { guard = false, schedule = true } = {}) {
  // 2026-10-05T01:00Z is 09:00 in Shanghai; the schedule is due at 10:00 there.
  const world = await createWorld(t, { initiative: true, start: '2026-10-05T01:00:00.000Z', files: { 'evidence.txt': 'Measured result: seven verified sources.\n', 'notes/.keep': '', '.gitignore': 'dist/\n' } });
  const s = scenario(world);
  if (guard) await installGuard(world);
  if (schedule) {
    const created = await world.post(`/api/projects/${world.projectId}/schedules`, { requestId: 'daily-report', title: 'Daily report', task: 'Read evidence.txt and report the measured result.', destinationSessionId: world.sessionId, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } });
    assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  }
  const foreground = await s.send('Say hello.', { reply: 'Hello.' });
  const foregroundTools = names(world.faux.of('foreground')[0].request);
  assert.ok(foregroundTools.includes('agent_consult') && foregroundTools.includes('project_read'), 'the foreground declares the full surface');
  return { world, s, foreground, foregroundTools };
}
const delivered = world => () => world.project().scheduleRuntime?.occurrences?.find(row => row.status === 'delivered');

test('a due scheduled run declares only what it can execute; a call to a tool it was not given is answered and the run delivers', async t => {
  const { world, s, foregroundTools } = await scheduledWorld(t);
  world.faux.script('background-work',
    { toolCalls: [{ id: 'try-consult', name: 'agent_consult', args: { role: 'scout', task: 'Look at evidence.txt.' } }] },
    { toolCalls: [{ name: 'project_read', args: { path: 'evidence.txt' } }] },
    'The measured result is seven verified sources.\nHandoff: reported the measured result from evidence.txt; nothing left.');
  const due = await s.advanceClock(HOUR, { label: 'the schedule comes due', until: delivered(world) });
  await due.expect({
    requests: rows => {
      const work = rows.filter(row => row.tag === 'background-work');
      assert.equal(work.length, 3, 'the call that could not run, the read, the report');
      const declared = names(work[0].request);
      assert.ok(declared.length > 10 && declared.length < foregroundTools.length, `a lean array (${declared.length} of the foreground's ${foregroundTools.length})`);
      const left = foregroundTools.filter(name => !declared.includes(name));
      for (const name of ['agent_consult', 'agent_delegate', 'ask_user', 'capability_install', 'project_schedule', 'request_project_permission']) assert.ok(left.includes(name), `${name} is not declared in the scheduled run`);
      for (const name of ['project_read', 'project_write', 'project_edit', 'project_exec', 'project_history', 'web_fetch', 'web_search']) if (foregroundTools.includes(name)) assert.ok(declared.includes(name), `${name} is declared in the scheduled run`);
      assert.deepEqual(declared, foregroundTools.filter(name => declared.includes(name)), 'the lean array is the foreground\'s without those tools, in the foreground\'s order');
      for (const row of work.slice(1)) assert.deepEqual(names(row.request), declared, 'one array for the whole run');
      // The system prompt does not change (the delegation paragraph stays), and the shared context is the foreground's.
      const foreground = world.faux.of('foreground')[0].request;
      assert.equal(work[0].request.systemPrompt, foreground.systemPrompt, 'the system prompt is byte-identical to the foreground\'s');
      assert.match(work[0].request.systemPrompt, /agent_consult \/ agent_delegate so they run in parallel/);
      // The authorization block names what was left out.
      const block = authorizationOf(work[0].request);
      assert.deepEqual(block.notDeclaredHere, [...left].filter(name => !declared.includes(name)).sort((a, b) => a.localeCompare(b, 'en')), 'every tool the foreground has and this run lacks is named');
      assert.equal(block.notDeclaredRule, 'Tools in notDeclaredHere are not available in this run; do not call them.');
      assert.ok(block.executableTools.includes('project_read') && !block.executableTools.includes('agent_consult'));
      // The model called agent_consult anyway: the session's receipt, then the run read the file and finished.
      assert.match(work[1].wire, NOT_ASSIGNED, 'the model was told it is not assigned');
      assert.doesNotMatch(work[0].wire, NOT_ASSIGNED);
      assert.match(work[2].wire, /seven verified sources/, 'the read came back');
    },
    state: state => {
      const project = state.projects.find(row => row.id === world.projectId), [occurrence] = project.scheduleRuntime.occurrences;
      assert.equal(occurrence.status, 'delivered'); assert.equal(project.scheduleRuntime.occurrences.length, 1);
      const rows = state.sessions.find(row => row.id === world.sessionId).items.filter(item => item.scheduleOccurrenceKey === occurrence.key);
      assert.equal(rows.length, 1, 'delivered once'); assert.match(rows[0].text, /seven verified sources/);
      const job = project.jobs.find(row => row.scheduleId);
      assert.equal(job.status, 'completed'); assert.equal(job.surface, 'executable', 'the job records the surface the run began with');
    },
  });
  // The equivalence check reads the run's real journal: lean, every call named an executable tool, the one refused call is the unassigned one.
  const replay = replayJournal(readFileSync(world.project().jobs.find(row => row.scheduleId).runtimeFile, 'utf8'), { file: 'scheduled' });
  assert.equal(replay.lean, true); assert.deepEqual(replay.violations, []); assert.equal(replay.stubHits, 0);
  assert.deepEqual(replay.notAssigned.map(row => row.tool), ['agent_consult']); assert.equal(replay.calls, 1, 'only the read was dispatched');
  // And the acceptance check does not call this run clean: one of its two asked-for calls was not assigned, far over the 0.5% roll-back line.
  const verdict = summarize([replay]);
  assert.equal(verdict.failures.length, 0, 'nothing that ran was outside the surface'); assert.deepEqual([verdict.leanNotAssigned.asked, verdict.leanNotAssigned.notAssigned, verdict.leanNotAssigned.over, verdict.ok], [2, 1, true, false]);
  // The foreground of the same world still declares the full array.
  const again = await s.send('Say hello again.', { reply: 'Hello again.' });
  await again.expect({ requests: rows => assert.deepEqual(names(rows.filter(row => row.tag === 'foreground')[0].request), foregroundTools, 'the foreground array did not change') });
});

test('a decision-started background run keeps the foreground\'s full array', async t => {
  const { world, s, foregroundTools } = await scheduledWorld(t, { schedule: false });
  const run = await s.backgroundRun({ task: 'Read evidence.txt and report the measured result.', work: [
    { toolCalls: [{ name: 'project_read', args: { path: 'evidence.txt' } }] },
    'The measured result is seven verified sources.\nHandoff: reported the measured result from evidence.txt; nothing left.',
  ] });
  await run.expect({
    requests: rows => {
      const work = rows.filter(row => row.tag === 'background-work');
      assert.equal(JSON.stringify(work[0].request.tools), JSON.stringify(world.faux.of('foreground')[0].request.tools), 'a decision-started run declares what the foreground declares');
      assert.deepEqual(names(work[0].request), foregroundTools);
      assert.equal(authorizationOf(work[0].request).notDeclaredHere, undefined);
    },
    state: () => assert.equal(run.outcome.job?.surface, undefined, 'only a scheduled run records a surface'),
  });
});

/**
 * A scheduled run paused at a boundary (its second request is in flight when the user pauses; the pending read is not
 * dispatched) and resumed (action.checkpoint: a second work() over the same journal). `rolledBack`: the run starts
 * under RNA_SCHEDULED_SURFACE=full and the switch is cleared before the resume, so the stored surface and today's
 * setting disagree.
 */
async function pausedThenResumed(t, { rolledBack }) {
  const previous = process.env.RNA_SCHEDULED_SURFACE;
  t.after(() => { if (previous === undefined) delete process.env.RNA_SCHEDULED_SURFACE; else process.env.RNA_SCHEDULED_SURFACE = previous; });
  const { world, s, foregroundTools } = await scheduledWorld(t);
  let release; const held = new Promise(done => { release = done; });
  world.faux.script('background-work',
    { toolCalls: [{ name: 'project_read', args: { path: 'evidence.txt' } }] },
    { hold: held, then: { toolCalls: [{ id: 'second-read', name: 'project_read', args: { path: 'evidence.txt' } }] } },
    'The measured result is seven verified sources.\nHandoff: reported the measured result from evidence.txt; nothing left.');
  const action = () => world.project().initiativeRuntime?.sdkState?.actions?.find(row => row.hostSchedule);
  const control = async (kind, requestId) => {
    const { id, controlRevision } = action();
    const response = await world.post(`/api/projects/${world.projectId}/initiative/actions/${id}/control`, { action: kind, requestId, expectedRevision: controlRevision ?? 0 });
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 300));
    return id;
  };
  const stored = rolledBack ? 'full' : 'executable';
  if (rolledBack) process.env.RNA_SCHEDULED_SURFACE = 'full';
  const paused = await s.step('pause the run while its second request is in flight, then let it reach the boundary', async () => {
    world.clock.advance(HOUR); world.tick();
    await until(() => world.faux.of('background-work').length >= 2, 'the run to be in its second request');
    const id = await control('pause', 'pause-surface');
    release();
    await until(() => action()?.status === 'paused', 'the run to pause at the boundary', 30000);
    await world.quiet();
    return { id };
  });
  await paused.expect({ state: state => assert.equal(state.projects.find(row => row.id === world.projectId).jobs.find(row => row.id === paused.outcome.id).surface, stored, 'the paused job kept the surface it began with') });
  const before = world.faux.of('background-work').length;
  assert.equal(before, 2, 'the pause came before the pending read ran: two requests so far');
  delete process.env.RNA_SCHEDULED_SURFACE; // today's setting is the default again: a new scheduled run would be lean
  const first = names(world.faux.of('background-work')[0].request);
  assert.deepEqual(first, rolledBack ? foregroundTools : first.filter(name => foregroundTools.includes(name)), 'the first half declared the surface the job stored');
  assert.equal(first.length < foregroundTools.length, !rolledBack);
  const resumed = await s.step('resume it', async () => {
    const id = await control('resume', 'resume-surface');
    await until(delivered(world), 'the resumed run to deliver', 60000);
    await world.quiet();
    return { id };
  });
  await resumed.expect({
    requests: rows => {
      const work = rows.filter(row => row.tag === 'background-work');
      assert.ok(work.length >= 1 && world.faux.of('background-work').length > before, 'the resumed run asked again');
      for (const row of work) assert.deepEqual(names(row.request), first, 'the resumed run declares the array the run began with');
    },
    state: state => { const job = state.projects.find(row => row.id === world.projectId).jobs.find(row => row.id === resumed.outcome.id); assert.equal(job.status, 'completed'); assert.equal(job.surface, stored); },
  });
}

test('a scheduled run paused at a boundary resumes with the lean surface it began with', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  await pausedThenResumed(t, { rolledBack: false });
});

test('a scheduled run that began under the rollback switch resumes with the full surface after the switch is cleared', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  await pausedThenResumed(t, { rolledBack: true });
});


test('the tool hooks fire on a lean run: its write is checked by the evolution guard like any other run\'s', { skip: gitReady ? false : 'git 2.38 or later is needed' }, async t => {
  const { world, s } = await scheduledWorld(t, { guard: true });
  world.faux.script('background-work',
    { toolCalls: [{ name: 'project_write', args: { path: 'notes/daily.md', content: 'TODO from the scheduled run\n' } }] },
    'Wrote notes/daily.md.\nHandoff: wrote notes/daily.md; nothing left.');
  const due = await s.advanceClock(HOUR, { label: 'the schedule comes due', until: delivered(world) });
  await due.expect({
    requests: rows => {
      const work = rows.filter(row => row.tag === 'background-work');
      assert.ok(!names(work[0].request).includes('agent_consult'), 'the run is lean');
      assert.match(work[1].wire, /\[Automatic checks\] “TODO check”: 1 hit to fix\\n- line 1: TODO from the scheduled run/, 'the guard checked the lean run\'s write');
    },
    state: () => assert.equal(world.project().genes.genes.find(row => row.id === 'guard:todo_guard').runs, 1, 'the guard ran once'),
  });
});
