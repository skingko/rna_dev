import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { BuiltinAgentService } from '../builtin-agent-service.mjs';

async function until(check, ms = 5000) { const deadline = Date.now() + ms; while (!check()) { if (Date.now() > deadline) throw new Error('Fixture did not settle'); await delay(5); } }
const hold = () => { let release; const held = new Promise(resolve => { release = resolve; }); return { held, release }; };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-read-once-')), store = new Store(join(directory, 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'read-once-secret', models: [{ id: 'fixture', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = store.createProject({ name: 'Read once', workspace: directory, initiative: { enabled: false } });
  store.message(session.id, { text: 'Parent task' });
  const current = () => store.state.sessions.find(row => row.id === session.id), turnId = current().activeTurnId;
  // A child whose runtime is a stub answering at once.
  const factory = async () => { let messages = []; return { snapshot: () => ({ tools: [], messages, recovery: { uncertainTools: [], pendingTools: 0, interrupted: false, pendingFinish: false }, queue: { steering: [] }, usage: { totalTokens: 0 } }),
    prompt: async task => { messages = [{ role: 'user', source: 'user', content: [{ type: 'text', text: task }] }, { role: 'assistant', content: [{ type: 'text', text: 'Child answer text' }], stopReason: 'stop' }]; }, resume: async () => {}, steer: async () => {}, abort: async () => {}, dispose: async () => {} }; };
  const agents = new BuiltinAgentService(store, { factory });
  t.after(async () => { await agents.close(); rmSync(directory, { recursive: true, force: true }); });
  const tools = agents.createTools({ sessionId: session.id, turnId });
  const call = async (name, args, id = `${name}-${Math.random()}`) => JSON.parse((await tools.find(row => row.name === name).execute(id, args, new AbortController().signal)).content[0].text);
  return { store, session, project, turnId, current, agents, call };
}

test('reading a settled result with agent_status withdraws its queued notice: the parent reads it once', async t => {
  const f = fixture(t);
  const handle = await f.call('agent_consult', { role: 'scout', task: 'Inspect.' });
  await until(() => f.agents.record(f.session.id, handle.agentId)?.delivery?.status === 'steered');
  assert.equal(f.current().inbox.filter(row => row.source === 'subagent').length, 1);
  const read = await f.call('agent_status', { agentId: handle.agentId });
  assert.equal(read.output, 'Child answer text', JSON.stringify(read));
  assert.equal(f.current().inbox.filter(row => row.source === 'subagent').length, 0, 'the queued notice is consumed');
  assert.equal(f.agents.record(f.session.id, handle.agentId).delivery.status, 'reported');
  assert.equal(f.current().items.find(row => row.kind === 'subagent').subagent.delivery, 'reported');
  // agent_wait on an already settled child also counts as the read.
  const second = await f.call('agent_consult', { role: 'reviewer', task: 'Review.' });
  await until(() => f.agents.record(f.session.id, second.agentId)?.delivery?.status === 'steered');
  const waited = await f.call('agent_wait', { agentIds: [second.agentId] });
  assert.equal(waited.agents[0].output, 'Child answer text'); assert.equal(f.current().inbox.length, 0);
});

test('a notice already accepted by the runtime is only removed after the runtime withdrew it', async t => {
  const f = fixture(t);
  const handle = await f.call('agent_consult', { role: 'scout', task: 'Inspect.' });
  await until(() => f.agents.record(f.session.id, handle.agentId)?.delivery?.status === 'steered');
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).inbox[0].deliveryStatus = 'accepted'; });
  assert.equal(f.store.agentRead(f.session.id, handle.agentId), false); assert.equal(f.current().inbox.length, 1);
  assert.equal(f.store.agentRead(f.session.id, handle.agentId, { runtimeWithdrawn: true }), true); assert.equal(f.current().inbox.length, 0);
});

test('Claude Code subscription consultations are withdrawn: none is offered, and one left running by an older release is closed on load', async t => {
  // Anthropic allows Claude subscription logins only in Claude Code and Claude.ai (2026-02-19), so the consult is gone.
  const f = fixture(t);
  assert.equal(f.agents.createTools({ sessionId: f.session.id, turnId: f.turnId }).some(tool => tool.name === 'agent_claude_consult'), false);
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns[0].officialDelegations = [{ id: 'official-legacy', engine: 'claude-code', status: 'running', readOnly: true, background: true, task: 'Old review', delivery: { status: 'awaiting' } }]; });
  await f.store.flush?.();
  const reopened = new Store(f.store.file), record = reopened.state.sessions.find(row => row.id === f.session.id).turns[0].officialDelegations[0];
  assert.equal(record.status, 'interrupted'); assert.equal(record.code, 'official_agent_withdrawn'); assert.equal(record.delivery.status, 'none');
  // It stays readable history in the session's agent list.
  assert.equal(new BuiltinAgentService(reopened, {}).list(f.session.id).find(row => row.agentId === 'official-legacy')?.status, 'interrupted');
});
