import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { StreamHub, bootstrap, projectDetail, projectSummary, sessionSummary, MAX_EVENT_BYTES } from '../api-v2.mjs';
import { projectRhythmEvidenceKey } from '../project-rhythm.mjs';
import { ARCHIVED_PROJECT_SUMMARY_FIELDS, PROJECT_SUMMARY_FIELDS, SESSION_SUMMARY_FIELDS } from '../index-schema.mjs';

// A5 (stream-protocol-v2 §1): index rows are allowlists and a function of committed state. Live 0.67 measured an
// 821 KB bootstrap (51% evidence outbox), project rows of 64–106 KB (each change a `resync` and a full bootstrap
// reload) and a `resync` every 5 s while idle (rhythm `nextAt = now`).
const ROW_BUDGET = 16 * 1024, BOOTSTRAP_BUDGET = 150 * 1024;
const HOUR = 3600000, DAY = 24 * HOUR;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const prose = (n, seed = '') => `${seed}依据最新对话与交付记录，项目节奏保持适时复查；没有新证据时保持安静。`.repeat(n);
const iso = at => new Date(at).toISOString();

function liveShaped(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-index-rows-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const created = [0, 1].map(index => store.createProject({ name: `长篇项目 ${index}`, workspace: dir, initiative: { enabled: false } }));
  const now = Date.now();
  store.mutate(state => {
    for (const [index, { project: { id }, session: { id: sessionId } }] of created.entries()) {
      const project = state.projects.find(row => row.id === id), session = state.sessions.find(row => row.id === sessionId);
      // 2,000 conversation entries over 60 turns, with the host bookkeeping a long conversation carries.
      for (let turn = 0; turn < 60; turn++) session.turns.push({ id: `turn-${turn}`, status: 'completed', createdAt: iso(now - (60 - turn) * HOUR), completedAt: iso(now - (60 - turn) * HOUR + 60000), memoryContext: { text: prose(20) }, modelConfig: { execution: 'rna', providerId: 'p', modelId: 'm' } });
      for (let item = 0; item < 2000; item++) session.items.push({ id: `item-${index}-${item}`, turnId: `turn-${Math.floor(item / 34)}`, kind: item % 3 === 0 ? 'user' : item % 3 === 1 ? 'assistant' : 'tool', text: prose(4, `第 ${item} 条 `), createdAt: iso(now - (2000 - item) * 60000), simulated: false });
      // A 60-row evidence outbox (live: 197 KB on one conversation), and the rest of a live session's records.
      session.memoryEvidenceOutbox = Array.from({ length: 60 }, (_, row) => ({ id: `ev-${row}`, schemaVersion: 1, sourceKind: 'autonomous_delivery', status: row % 10 === 0 ? 'failed' : row % 7 === 0 ? 'pending' : 'completed', sourceRefs: [{ itemId: `item-${index}-${row}`, sourceHash: 'a'.repeat(64) }], text: prose(30), resourceIndex: { uri: `viking://resources/x/${row}.md`, status: 'completed', receipt: { complete: true, contentVerified: true, files: Array.from({ length: 6 }, (_, f) => `f-${f}`) } }, updatedAt: iso(now) }));
      session.memoryEvidenceState = { seen: Array.from({ length: 200 }, (_, row) => `item-${index}-${row}`) };
      session.invitationHistory = Array.from({ length: 40 }, (_, row) => ({ id: `inv-${row}`, kind: 'feedback', subject: prose(2), closedAt: iso(now) }));
      session.commandHistory = Array.from({ length: 20 }, (_, row) => ({ id: `cmd-${row}`, command: 'compact', at: iso(now) }));
      // The project records whose full form made the 64–106 KB rows.
      project.initiative.enabled = true; project.evolution.enabled = true; project.decisionMode = 'rna-model'; project.simulated = false;
      project.rhythmRuntime = {
        assessment: { lifecycle: 'active', reason: prose(6), evidenceIds: Array.from({ length: 12 }, (_, row) => `event-${row}`), scheduleIds: [], initiative: { mode: 'adaptive', reviewAfterMs: HOUR }, evolution: { mode: 'evidence', maxPerDay: 2, maxPerWeek: 7, minIntervalMs: HOUR } },
        assessmentSourceIds: ['s-1', 's-2'], assessedAt: now - HOUR, lastInitiativeAt: null,
        history: Array.from({ length: 12 }, (_, row) => ({ at: now - (12 - row) * HOUR, lifecycle: 'active', reason: prose(9), initiativeMode: 'adaptive', evolutionMode: 'evidence', evidenceIds: Array.from({ length: 8 }, (_, e) => `event-${row}-${e}`), sourceIds: [`s-${row}`], source: 'model' })),
      };
      // Pending learning, nothing learned yet: the evolution lane is due with no anchor (live: nextAt = the read time).
      project.learningRuntime = { sdkState: { episodes: [{ id: 'ep-1', status: 'pending' }], reviews: [] } };
      project.memorySummary = { schemaVersion: 1, status: 'completed', code: null, message: '摘要已更新。', updatedAt: iso(now), uri: 'viking://x', expectedFiles: Array.from({ length: 300 }, (_, row) => `viking://resources/projects/x/novel/chapter-${row}.md`), expectedDirectories: Array.from({ length: 40 }, (_, row) => `viking://d/${row}`), verification: { files: 300 } };
      project.skillFoundation = { schemaVersion: 1, status: 'ready', attemptedAt: iso(now), completedAt: iso(now), coverage: Array.from({ length: 12 }, (_, row) => ({ id: `area-${row}`, status: 'selected', skillIds: ['a', 'b'] })), referenceDiscovery: { rows: Array.from({ length: 40 }, (_, row) => ({ id: `ref-${row}`, summary: prose(2) })) }, screening: { areas: Array.from({ length: 6 }, (_, row) => ({ id: `a${row}`, candidates: 8 })) } };
      project.initialization = { status: 'ready', phase: 'done', requestedAt: iso(now - DAY), startedAt: iso(now - DAY), completedAt: iso(now - DAY), preservedState: { overview: prose(40) }, referenceDiscovery: { rows: prose(10) }, modelSelection: { providerId: 'p', modelId: 'm' } };
      project.judgmentPolicy = { options: Array.from({ length: 12 }, (_, row) => ({ id: `o-${row}`, text: prose(2) })) };
      project.assignments = { skillIds: ['a', 'b'], toolIds: Array.from({ length: 20 }, (_, row) => `tool-${row}`), reasons: Object.fromEntries(Array.from({ length: 20 }, (_, row) => [`tool-${row}`, prose(1)])) };
      project.scheduleManagementReceipts = Array.from({ length: 30 }, (_, row) => ({ actionId: `plan-${row}`, scheduleId: 'daily', operation: 'create', summary: prose(3), committedAt: iso(now) }));
      project.schedules = [{ id: 'daily', title: '每日简报', task: prose(40), enabled: true, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, destinationSessionId: sessionId, nextRunAt: iso(now + 3 * HOUR), source: 'initiative', initiativeProvenance: { reason: prose(10) }, revision: 2, createdAt: iso(now - 30 * DAY), updatedAt: iso(now) }];
      project.scheduleRuntime = { schemaVersion: 1, occurrences: Array.from({ length: 60 }, (_, row) => ({ key: `daily:${row}`, scheduleId: 'daily', scheduledAt: iso(now - (60 - row) * DAY), status: 'delivered', deliveredAt: iso(now - (60 - row) * DAY + 60000), deliveryItemId: `item-${index}-${row}`, actionId: `act-${row}`, deliveryActionId: `deliver-${row}`, claimedAt: iso(now), scheduleRevision: 2, coalescedFrom: null })) };
      project.milestones = Array.from({ length: 10 }, (_, row) => ({ id: `m-${row}`, text: prose(2) }));
      project.openQuestions = Array.from({ length: 6 }, (_, row) => ({ id: `q-${row}`, text: prose(2) }));
      project.capabilitySnapshot = { tools: Array.from({ length: 30 }, (_, row) => ({ id: `tool-${row}`, description: prose(1) })) };
      project.backgroundChanges = Array.from({ length: 12 }, (_, row) => ({ id: `bg-${row}`, actionId: `act-${row}`, at: iso(now), status: 'kept', files: Array.from({ length: 10 }, (_, f) => ({ path: `novel/chapter-${row}-${f}.md`, before: prose(5), after: prose(5) })) }));
    }
    // One of them archived, with everything still on it.
    state.projects.find(row => row.id === created[1].project.id).archivedAt = iso(now);
  });
  // The evidence watermark as dispatch records it: no fresh evidence, so the lanes stand on their anchors.
  store.mutate(state => { for (const project of state.projects) project.rhythmRuntime.evidenceKey = projectRhythmEvidenceKey(state, project); });
  return { store, created, now };
}

test('live-shaped index rows stay small allowlists and the bootstrap stays small', t => {
  const { store, created } = liveShaped(t);
  const live = store.state.projects.find(row => row.id === created[0].project.id), archived = store.state.projects.find(row => row.id === created[1].project.id);
  // The fixture is live-shaped: the project as stored (the old denylist row, now the project route) passes the event cap.
  assert.ok(bytes(projectDetail(store, live)) > MAX_EVENT_BYTES, `detail ${bytes(projectDetail(store, live))} B`);
  assert.ok(bytes(store.state.sessions[0].memoryEvidenceOutbox) > 100 * 1024);
  const body = bootstrap(store, {});
  for (const row of [...body.projects, ...body.sessions]) assert.ok(bytes(row) <= ROW_BUDGET, `${row.name ?? row.title}: ${bytes(row)} B`);
  assert.ok(bytes(body) <= BOOTSTRAP_BUDGET, `bootstrap ${bytes(body)} B`);
  // Allowlists, field by field; an archived project has the short row.
  const rows = Object.fromEntries(body.projects.map(row => [row.id, row]));
  assert.deepEqual(Object.keys(rows[live.id]).filter(key => !PROJECT_SUMMARY_FIELDS.includes(key)), []);
  assert.deepEqual(Object.keys(rows[archived.id]).filter(key => !ARCHIVED_PROJECT_SUMMARY_FIELDS.includes(key)), []);
  assert.ok(bytes(rows[archived.id]) < 1024, `archived row ${bytes(rows[archived.id])} B`);
  for (const row of body.sessions) assert.deepEqual(Object.keys(row).filter(key => !SESSION_SUMMARY_FIELDS.includes(key)), []);
  // The projections keep what the web reads.
  const row = rows[live.id];
  assert.deepEqual(row.memorySummary, { status: 'completed', message: '摘要已更新。', code: null, updatedAt: live.memorySummary.updatedAt });
  assert.deepEqual(row.skillFoundation, { status: 'ready', attemptedAt: live.skillFoundation.attemptedAt, completedAt: live.skillFoundation.completedAt });
  assert.equal(row.rhythmStatus.history.length, 5); assert.equal(row.rhythmStatus.history[4].reason, live.rhythmRuntime.history[11].reason.slice(0, 800));
  assert.equal(row.rhythmRuntime, undefined); assert.equal(row.scheduleManagementReceipts, undefined); assert.equal(row.presence, undefined);
  assert.equal(row.schedules[0].task, undefined); assert.equal(row.schedules[0].title, '每日简报');
  assert.deepEqual(row.scheduleRuntime.occurrences.map(item => item.key), ['daily:59'], 'the latest run, which is also the latest delivered one');
  const session = body.sessions.find(item => item.id === created[0].session.id);
  assert.equal(session.memoryEvidenceOutbox, undefined); assert.equal(session.memoryEvidenceState, undefined);
  assert.deepEqual(session.memoryEvidence, { total: 60, pending: 8, failed: 6 });
  assert.equal(session.itemCount, 2000);
});

test('two index diffs of the same state at different clocks emit nothing, presence reports included', t => {
  const { store, created, now } = liveShaped(t);
  const live = store.state.projects.find(row => row.id === created[0].project.id);
  assert.equal(projectSummary(store, live, { now }).rhythmStatus.evolution.state, 'ready', 'the fixture has a due lane');
  const hub = new StreamHub(store, { pollMs: 3600000 }), sent = [];
  t.after(() => hub.close());
  hub.channels.set('', { sessionId: '', clients: new Set(), push: (event, json) => sent.push({ event, bytes: Buffer.byteLength(json) }) });
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  hub.diffIndex({ baseline: true, fresh: true });
  for (const offset of [6000, 60000, 10 * 60000]) { Date.now = () => now + offset; hub.diffIndex({ fresh: true }); }
  store.presence(live.id, { sessionId: created[0].session.id, typing: true, visible: true });
  Date.now = () => now + 11 * 60000; hub.diffIndex({ fresh: true });
  Date.now = realNow;
  assert.deepEqual(sent, []);
  // A real change still goes out, and as an index event, not a resync.
  store.mutate(state => { state.projects.find(row => row.id === live.id).focus = '第三卷'; });
  hub.diffIndex();
  assert.deepEqual(sent.map(row => row.event), ['index']);
  assert.ok(sent[0].bytes <= ROW_BUDGET + 256);
});

test('streamed display ticks reach the session channels only; summaries are reused by identity', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-index-display-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { session } = store.createProject({ name: 'Display', workspace: dir, initiative: { enabled: false } });
  store.mutate(state => {
    const target = state.sessions.find(row => row.id === session.id);
    target.items.push({ id: 'u1', turnId: 't1', kind: 'user', text: '写下一章', createdAt: new Date().toISOString(), simulated: false });
    target.items.push({ id: 'a1', turnId: 't1', kind: 'assistant', text: '', streaming: true, createdAt: new Date().toISOString(), simulated: false });
    target.turns.push({ id: 't1', status: 'running', createdAt: new Date().toISOString(), modelConfig: { execution: 'rna' } });
    target.status = 'running'; target.activeTurnId = 't1';
  });
  const hub = new StreamHub(store, { pollMs: 3600000, indexDelayMs: 5, sessionDelayMs: 5 });
  t.after(() => hub.close());
  hub.channels.set(session.id, { sessionId: session.id, clients: new Set(), dirty: false, push() {}, diff() { this.dirty = false; } });
  hub.channels.set('', { sessionId: '', clients: new Set(), push() {} });
  const before = sessionSummary(store.state.sessions.find(row => row.id === session.id));
  assert.equal(before.preview, '写下一章');
  assert.equal(store.projectRuntimeDisplay({ sessionId: session.id, turnId: 't1', updates: [{ type: 'assistant_text', itemId: 'a1', text: '第一段正在写' }] }), true);
  assert.equal(hub.channels.get(session.id).dirty, true, 'the session channel follows the tick');
  assert.equal(hub.indexTimer, null, 'the index does not');
  const after = store.state.sessions.find(row => row.id === session.id);
  assert.equal(sessionSummary(after).preview, '写下一章', 'a reply still streaming is not the preview');
  assert.equal(sessionSummary(after), sessionSummary(after), 'a frozen session row is projected once');
  store.mutate(state => { state.settings.maxConcurrent = state.settings.maxConcurrent; });
  assert.notEqual(hub.indexTimer, null, 'a commit does');
});

// The index follows commits only. Its 5 s fresh read (the poll) runs between commits and reads the store as it is, the
// streamed text of a running reply included: nothing a display tick writes may reach a row, or a reply streaming for
// longer than 5 s sends every open tab an index event every 5 s.
test('the periodic fresh read during a streamed reply sends no index event: display ticks change no row', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-index-display-poll-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { session } = store.createProject({ name: 'Display poll', workspace: dir, initiative: { enabled: false } });
  store.mutate(state => {
    const target = state.sessions.find(row => row.id === session.id);
    target.items.push({ id: 'u1', turnId: 't1', kind: 'user', text: '写下一章', createdAt: new Date().toISOString(), simulated: false });
    target.items.push({ id: 'a1', turnId: 't1', kind: 'assistant', text: '', streaming: true, createdAt: new Date().toISOString(), simulated: false });
    target.items.push({ id: 'tool1', turnId: 't1', kind: 'tool', createdAt: new Date().toISOString(), simulated: false, tool: { name: 'project_exec', status: 'running', output: '' } });
    target.turns.push({ id: 't1', status: 'running', createdAt: new Date().toISOString(), modelConfig: { execution: 'rna' } });
    target.status = 'running'; target.activeTurnId = 't1';
  });
  const hub = new StreamHub(store, { pollMs: 3600000, indexDelayMs: 3600000, sessionDelayMs: 3600000 }), sent = [];
  t.after(() => hub.close());
  hub.channels.set('', { sessionId: '', clients: new Set(), push: (event, json) => sent.push(`${event} ${json.slice(0, 300)}`) });
  hub.diffIndex({ baseline: true, fresh: true });
  const before = store.state.sessions.find(row => row.id === session.id).updatedAt;
  for (let tick = 1; tick <= 3; tick++) {
    assert.equal(store.projectRuntimeDisplay({ sessionId: session.id, turnId: 't1', updates: [{ type: 'assistant_text', itemId: 'a1', text: `第一段正在写 ${tick}` }, { type: 'tool_output', itemId: 'tool1', output: `line ${tick}` }] }), true);
    hub.diffIndex({ fresh: true });
  }
  assert.equal(hub.indexTimer, null, 'no commit happened (precondition)');
  assert.deepEqual(sent, []);
  const shown = store.state.sessions.find(row => row.id === session.id);
  assert.equal(shown.items.find(item => item.id === 'a1').text, '第一段正在写 3', 'the ticks are visible to the session channel');
  assert.equal(shown.updatedAt, before, 'a display tick is not a session update');
  // The next commit is: it carries the streamed text and its own updatedAt.
  store.mutate(state => { const target = state.sessions.find(row => row.id === session.id); target.title = '第三章'; target.updatedAt = new Date(Date.parse(before) + 1000).toISOString(); });
  hub.diffIndex();
  assert.equal(sent.length, 1); assert.match(sent[0], /^index /);
});

// D4 gate "a schedule coming due changes no index row by itself": the SDK's schedule summary counts the next runs the
// reading clock has passed (`dueCount`). The row keeps the anchors only; the web counts due schedules when it renders.
test('a schedule coming due changes no project row: the row carries its next run, not a count of passed runs', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-index-due-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { project } = store.createProject({ name: 'Daily brief', workspace: dir, initiative: { enabled: false } });
  const now = Date.now(), dueAt = now + 10 * 60000;
  store.mutate(state => { state.projects.find(row => row.id === project.id).schedules = [{ id: 'daily', title: '每日简报', task: 'Summarize the notes.', enabled: true, rule: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' }, destinationSessionId: null, nextRunAt: iso(dueAt), source: 'user', revision: 1 }]; });
  const live = () => store.state.projects.find(row => row.id === project.id);
  // The full status (the project route) still counts it; the row does not.
  assert.equal(projectDetail(store, live(), { now: dueAt + 60000 }).rhythmStatus.schedule.dueCount, 1, 'the schedule is due at that time (precondition)');
  assert.deepEqual(projectSummary(store, live(), { now: dueAt + 60000 }).rhythmStatus.schedule, { activeCount: 1, nextAt: dueAt });
  assert.equal(JSON.stringify(projectSummary(store, live(), { now: dueAt + 60000 })), JSON.stringify(projectSummary(store, live(), { now })));
  // The stream's periodic fresh read across the due instant sends nothing.
  const hub = new StreamHub(store, { pollMs: 3600000 }), sent = [];
  t.after(() => hub.close());
  hub.channels.set('', { sessionId: '', clients: new Set(), push: (event, json) => sent.push(`${event} ${json.slice(0, 200)}`) });
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => now; hub.diffIndex({ baseline: true, fresh: true });
  for (const at of [dueAt - 1000, dueAt, dueAt + 5000, dueAt + 3600000]) { Date.now = () => at; hub.diffIndex({ fresh: true }); }
  Date.now = realNow;
  assert.deepEqual(sent, []);
});
