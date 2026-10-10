import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { UserInteractionService } from '../user-interaction-service.mjs';
import { ProjectPermissionService } from '../project-permissions.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 64000, maxOutputTokens: 1000 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { const value = fn(); if (value) return value; await delay(5); } throw Error('Did not settle'); }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-permission-')), store = new Store(join(dir, 'state.json'));
  const { project, session } = store.createProject({ name: 'Permissions', workspace: dir });
  const interactions = new UserInteractionService(store), permissions = new ProjectPermissionService(store, interactions);
  t.after(() => { interactions.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, project, session, interactions, permissions, current: () => store.state.projects.find(row => row.id === project.id) };
}
test('project permission settings assign exact builtin scopes and persist independently of model-generated text', t => {
  const f = fixture(t);
  assert.equal(f.permissions.get(f.project.id).inheritedAssignments, false);
  assert.equal(f.permissions.get(f.project.id).settings.workspace, 'execute');
  assert.equal(f.permissions.get(f.project.id).effective.background, 'read');
  f.permissions.update(f.project.id, { workspace: 'execute', background: 'inherit' });
  assert.ok(f.current().assignments.toolIds.includes('project_exec'));
  assert.deepEqual(f.permissions.get(f.project.id).effective, { foreground: 'execute', background: 'execute' });
  f.permissions.update(f.project.id, { workspace: 'write', background: 'read' });
  assert.ok(f.current().assignments.toolIds.includes('project_write')); assert.ok(!f.current().assignments.toolIds.includes('project_exec'));
  const revision = f.store.state.revision;
  assert.throws(() => f.permissions.update(f.project.id, { workspace: 'execute', background: 'inherit', grantEverything: true }), error => error.status === 400);
  assert.equal(f.store.state.revision, revision);
  assert.equal(new Store(f.store.file).state.projects.find(row => row.id === f.project.id).permissions.workspace, 'write');
});

test('an existing write grant restores removed builtins without another approval or broader execution rights', async t => {
  const f = fixture(t); f.permissions.update(f.project.id, { workspace: 'write', background: 'read' });
  f.store.mutate(state => { state.projects.find(row => row.id === f.project.id).assignments.toolIds = ['project_read']; });
  const request = f.permissions.request(f.project.id, { workspace: 'write', background: 'read', reason: 'Continue the already-authorized file edit' });
  assert.equal(request.alreadyAllowed, true); assert.ok(f.current().assignments.toolIds.includes('project_write')); assert.ok(!f.current().assignments.toolIds.includes('project_exec'));
  const revision = f.permissions.get(f.project.id).revision;
  f.permissions.request(f.project.id, { workspace: 'write', background: 'read', reason: 'Same scope' });
  assert.equal(f.permissions.get(f.project.id).revision, revision);
  const handle = await createRnaRuntime({ project: f.current(), getProject: f.current, cwd: f.dir, stateDir: join(f.dir, 'restored-runtime'), sessionId: f.session.id, model, capabilityService: new CapabilityService(f.store), provider: async function* (input) {
    assert.ok(!input.tools.some(tool => tool.name === 'project_exec'));
    if (!input.messages.some(message => message.role === 'toolResult')) yield { type: 'tool_call', id: 'restored-write', name: 'project_write', arguments: { path: 'restored.txt', content: 'authorized', expectedHash: null } };
    else yield { type: 'text_delta', delta: 'Saved' };
    yield { type: 'done' };
  } });
  t.after(() => handle.dispose()); await handle.prompt('Continue file edit');
  assert.equal(readFileSync(join(f.dir, 'restored.txt'), 'utf8'), 'authorized');
  assert.equal(f.store.state.sessions.find(row => row.id === f.session.id).items.some(item => item.interaction), false);
});

test('only a matching explicit permission choice grants; deny, cancellation, custom input and stale cards do not', t => {
  const f = fixture(t); f.permissions.update(f.project.id, { workspace: 'read', background: 'read' });
  const publish = id => { const request = f.permissions.request(f.project.id, { workspace: 'execute', background: 'inherit', reason: 'Build the current project' }); return f.interactions.publishInitiative({ projectId: f.project.id, sessionId: f.session.id, actionId: id, questions: request.questions, metadata: request.metadata }); };
  const denied = publish('deny'); f.interactions.answer(f.session.id, denied.id, { requestId: 'deny-response', answers: [{ id: 'permission', selected: ['deny'] }] });
  assert.equal(f.permissions.get(f.project.id).settings.workspace, 'read');
  const custom = publish('custom'); assert.throws(() => f.interactions.answer(f.session.id, custom.id, { requestId: 'custom', answers: [{ id: 'permission', selected: ['allow'], custom: 'yes' }] }));
  const cancelled = publish('cancel'); f.interactions.cancel(f.session.id, cancelled.id, { requestId: 'cancel-response' }); assert.equal(f.permissions.get(f.project.id).settings.workspace, 'read');
  const stale = publish('stale'); f.permissions.update(f.project.id, { workspace: 'write', background: 'read' });
  assert.throws(() => f.interactions.answer(f.session.id, stale.id, { requestId: 'stale-response', answers: [{ id: 'permission', selected: ['allow'] }] }), error => error.status === 409);
  const allow = publish('allow'), answer = { requestId: 'allow-response', answers: [{ id: 'permission', selected: ['allow'] }] };
  const result = f.interactions.answer(f.session.id, allow.id, answer); assert.equal(result.interaction.permissionChanged, true);
  const revision = f.permissions.get(f.project.id).revision; assert.equal(f.interactions.answer(f.session.id, allow.id, answer).replayed, true); assert.equal(f.permissions.get(f.project.id).revision, revision);
  assert.deepEqual(f.permissions.get(f.project.id).effective, { foreground: 'execute', background: 'execute' });
});

test('a real SDK loop awaits the host permission card and writes a file on the next tool boundary', async t => {
  const f = fixture(t); f.permissions.update(f.project.id, { workspace: 'read', background: 'read' }); f.store.message(f.session.id, { text: 'Create the project file' });
  const turnId = f.store.state.sessions.find(row => row.id === f.session.id).activeTurnId; let requests = 0;
  const handle = await createRnaRuntime({ project: f.current(), getProject: f.current, sessionId: f.session.id, cwd: f.dir, stateDir: join(f.dir, 'private-runtime'), model, capabilityService: new CapabilityService(f.store), managementTools: f.permissions.createTools({ projectId: f.project.id, sessionId: f.session.id, turnId }), provider: async function* (input) {
    requests++;
    if (requests === 1) { assert.ok(!input.tools.some(tool => tool.name === 'project_write')); yield { type: 'tool_call', id: 'grant', name: 'request_project_permission', arguments: { workspace: 'write', background: 'read', reason: 'Create index.html in this project' } }; }
    else if (requests === 2) { assert.ok(input.tools.some(tool => tool.name === 'project_write')); yield { type: 'tool_call', id: 'write', name: 'project_write', arguments: { path: 'index.html', content: '<h1>real file write</h1>', expectedHash: null } }; }
    else if (requests === 4) { assert.match(JSON.stringify(input.messages.at(-1)), /host-delivery-observation/); yield { type: 'tool_call', id: 'read-back', name: 'project_read', arguments: { path: 'index.html' } }; }
    else if (requests === 5) { assert.match(JSON.stringify(input.messages.at(-1).content), /real file write/); yield { type: 'text_delta', delta: 'File saved and read back; the rendered page was not visually inspected.' }; }
    else yield { type: 'text_delta', delta: 'Draft file saved.' };
    yield { type: 'usage', usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 } };
    yield { type: 'done', stopReason: [1, 2, 4].includes(requests) ? 'toolUse' : 'stop' };
  } });
  t.after(() => handle.dispose()); const running = handle.prompt('Create index.html');
  const card = await until(() => f.store.state.sessions.find(row => row.id === f.session.id).items.find(item => item.interaction)?.interaction);
  assert.equal(requests, 1); assert.equal(existsSync(join(f.dir, 'index.html')), false);
  f.interactions.answer(f.session.id, card.id, { requestId: 'approved', answers: [{ id: 'permission', selected: ['allow'] }] }); await running;
  assert.equal(readFileSync(join(f.dir, 'index.html'), 'utf8'), '<h1>real file write</h1>'); assert.equal(requests, 5);
  assert.equal(handle.snapshot().usage.totalTokens, 35);
  assert.equal(handle.snapshot().messages.filter(message => message.source === 'finish-feedback').length, 1);
  assert.deepEqual(handle.snapshot().messages.filter(message => message.role === 'toolResult').map(message => message.toolName), ['request_project_permission', 'project_write', 'project_read']);
});

test('background inherits only explicit project authorization and mid-batch revocation prevents a second write', async t => {
  const f = fixture(t); f.permissions.update(f.project.id, { workspace: 'write', background: 'read' });
  const create = extra => createRnaRuntime({ project: f.current(), getProject: f.current, sessionId: 'background', cwd: f.dir, stateDir: join(f.dir, 'background'), model, capabilityService: new CapabilityService(f.store), permissionScope: 'background', ...extra });
  // Tiered tools: the read background grant keeps project_write declared (same
  // tools array as the foreground) and rejects the call at execution.
  let blocked = 0, h = await create({ provider: async function* () { if (++blocked === 1) yield { type: 'tool_call', id: 'blocked', name: 'project_write', arguments: { path: 'blocked.txt', content: 'x', expectedHash: null } }; yield { type: 'done' }; } });
  assert.ok(h.snapshot().tools.includes('project_write')); await h.prompt('Try a write'); assert.equal(existsSync(join(f.dir, 'blocked.txt')), false);
  assert.match(JSON.stringify(h.snapshot().messages.find(message => message.role === 'toolResult' && message.toolCallId === 'blocked')), /authorization_read_only|Read-only authorization: writes are rejected/); await h.dispose();
  f.permissions.update(f.project.id, { workspace: 'write', background: 'inherit' }); let requests = 0;
  h = await create({ provider: async function* () { if (++requests === 1) for (const path of ['first.txt', 'second.txt']) yield { type: 'tool_call', id: path, name: 'project_write', arguments: { path, content: path, expectedHash: null } }; yield { type: 'done' }; }, onEvent: event => { if (event.type === 'tool_execution_end' && event.toolCallId === 'first.txt') f.permissions.update(f.project.id, { workspace: 'read', background: 'read' }); } });
  t.after(() => h.dispose()); await h.prompt('Write files'); assert.equal(existsSync(join(f.dir, 'first.txt')), true); assert.equal(existsSync(join(f.dir, 'second.txt')), false); assert.equal(h.snapshot().recovery.uncertainTools.length, 0);
});

test('under full access a permission request is granted at once, background included, with no card', t => {
  const f = fixture(t); f.permissions.update(f.project.id, { workspace: 'execute', background: 'read' });
  const request = f.permissions.request(f.project.id, { workspace: 'write', background: 'inherit', reason: 'Background edit of the chapter file' });
  assert.equal(request.alreadyAllowed, true); assert.equal(request.autoGranted, true); assert.equal(request.questions, undefined);
  assert.deepEqual(f.permissions.get(f.project.id).effective, { foreground: 'execute', background: 'execute' });
  assert.equal(f.store.state.sessions.find(row => row.id === f.session.id).items.some(item => item.interaction), false);
});

test('choosing full access settles cards asked earlier: allowed on the user\'s behalf with a notice, not a user answer', t => {
  const f = fixture(t); f.permissions.update(f.project.id, { workspace: 'read', background: 'read' });
  const request = f.permissions.request(f.project.id, { workspace: 'execute', background: 'read', reason: 'Run the build script' });
  const card = f.interactions.publishInitiative({ projectId: f.project.id, sessionId: f.session.id, actionId: 'before-full-access', questions: request.questions, metadata: request.metadata });
  f.permissions.update(f.project.id, { workspace: 'execute', background: 'read' });
  assert.deepEqual(f.permissions.settleFullAccess(f.project.id), []);
  const items = f.store.state.sessions.find(row => row.id === f.session.id).items, settled = items.find(item => item.interaction?.id === card.id).interaction;
  assert.equal(settled.status, 'answered'); assert.equal(settled.answeredVia, 'full-access'); assert.equal(settled.permissionChanged, false);
  assert.ok(items.some(item => item.kind === 'notice' && item.source === 'full-access' && item.interactionId === card.id && /完全访问/.test(item.text) && item.text.includes('Run the build script')));
  assert.equal(items.some(item => item.source === 'interaction-answer'), false);
  assert.deepEqual(f.permissions.get(f.project.id).settings, { workspace: 'execute', background: 'inherit' });
  const revision = f.store.state.revision; f.permissions.settleFullAccess(null); assert.equal(f.store.state.revision, revision);
});

test('without full access, cards stay for the user and a card whose scope is already covered just closes', t => {
  const f = fixture(t); f.permissions.update(f.project.id, { workspace: 'read', background: 'read' });
  const request = f.permissions.request(f.project.id, { workspace: 'write', background: 'read', reason: 'Edit the outline' });
  const card = f.interactions.publishInitiative({ projectId: f.project.id, sessionId: f.session.id, actionId: 'covered', questions: request.questions, metadata: request.metadata });
  f.permissions.update(f.project.id, { workspace: 'write', background: 'read' });
  f.permissions.settleFullAccess(null);
  const pending = () => f.store.state.sessions.find(row => row.id === f.session.id).items.find(item => item.interaction?.id === card.id).interaction;
  assert.equal(pending().status, 'pending');
  const result = f.interactions.answer(f.session.id, card.id, { requestId: 'covered-allow', answers: [{ id: 'permission', selected: ['allow'] }] });
  assert.equal(result.interaction.permissionChanged, false); assert.deepEqual(f.permissions.get(f.project.id).settings, { workspace: 'write', background: 'read' });
});

test('full access answers a tool card the running turn awaits, and names paused turns for resume', async t => {
  const f = fixture(t); f.permissions.update(f.project.id, { workspace: 'read', background: 'read' }); f.store.message(f.session.id, { text: 'Write the file' });
  const turnId = f.store.state.sessions.find(row => row.id === f.session.id).activeTurnId, [tool] = f.permissions.createTools({ projectId: f.project.id, sessionId: f.session.id, turnId });
  const card = () => f.store.state.sessions.find(row => row.id === f.session.id).items.findLast(item => item.interaction)?.interaction;
  const live = tool.execute('live-call', { workspace: 'write', background: 'read', reason: 'Write index.html' });
  await until(() => card()?.status === 'pending');
  f.permissions.update(f.project.id, { workspace: 'execute', background: 'read' });
  assert.deepEqual(f.permissions.settleFullAccess(f.project.id), []);
  assert.match((await live).content[0].text, /"status":"answered"/);
  f.permissions.update(f.project.id, { workspace: 'read', background: 'read' });
  const paused = tool.execute('paused-call', { workspace: 'write', background: 'read', reason: 'Write style.css' }).catch(error => error);
  await until(() => card()?.status === 'pending' && card().toolCallId === 'paused-call');
  f.store.controlSession(f.session.id, 'pause'); await paused; assert.equal(card().status, 'interrupted');
  f.permissions.update(f.project.id, { workspace: 'execute', background: 'read' });
  assert.deepEqual(f.permissions.settleFullAccess(null), [f.session.id]); assert.equal(card().answeredVia, 'full-access');
});
