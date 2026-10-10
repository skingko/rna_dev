import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSession } from '../src/session.mjs';
import { prepareContext } from '../src/context.mjs';
import { buildRequest } from '../src/providers.mjs';
import { USAGE_PURPOSES, CORE_TOOL_NAMES, normalizePurpose, purposeDetail, authorizationRejection, authorizationContext, NOT_DECLARED_RULE, purposeContext, surfaceStub, HOST_INSTRUCTION_LABEL } from '../src/prompt-layers.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64000, maxOutputTokens: 1000 };
const tool = (name, permission = 'read') => ({ name, permission, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: 'text', text: name }] }) });
const shared = [{ key: 'skill-catalog', source: 'capability-catalog', text: 'catalog' }, { key: 'project-orientation', source: 'workspace-orientation', text: 'orientation' }];

test('purpose enum matches the v2 contract and unknown purposes normalize to other', () => {
  assert.deepEqual(USAGE_PURPOSES, ['foreground', 'initiative', 'background-work', 'learning', 'evaluation', 'compaction', 'summary', 'initialization', 'jev', 'jev-llm', 'skill-foundation', 'subagent', 'vision', 'narrator', 'mind', 'evolution', 'other']);
  assert.equal(normalizePurpose('learning'), 'learning'); assert.equal(normalizePurpose('response'), 'other');
  // TC-10 / EVO-11: the mind's small calls and gene authoring get their own purposes; the raw one stays as `detail`.
  assert.equal(normalizePurpose('mind-capture'), 'mind'); assert.equal(normalizePurpose('mind'), 'mind'); assert.equal(normalizePurpose('session-suggestions'), 'mind');
  assert.equal(normalizePurpose('gene-author'), 'evolution'); assert.equal(normalizePurpose('narrator'), 'narrator'); assert.equal(normalizePurpose('mindful'), 'other'); assert.equal(normalizePurpose(undefined), 'other');
  assert.equal(purposeDetail('gene-author'), 'gene-author'); assert.equal(purposeDetail('mind-capture'), 'mind-capture'); assert.equal(purposeDetail('mind'), undefined); assert.equal(purposeDetail('response'), 'response');
  assert.equal(purposeDetail('Bad Detail'), undefined); assert.equal(purposeDetail('x'.repeat(41)), undefined);
  assert.deepEqual([...CORE_TOOL_NAMES], [...CORE_TOOL_NAMES].sort((a, b) => a.localeCompare(b, 'en')), 'core tools are listed in canonical order');
});

test('execution-time rejection is explicit and machine-readable; surface stubs never execute', async () => {
  const receipt = authorizationRejection('authorization_read_only', { tool: { name: 'project_write', permission: 'write' }, purpose: 'background-work', level: 'read', readOnly: true });
  assert.equal(receipt.isError, true); assert.match(receipt.content[0].text, /Read-only authorization: writes are rejected/);
  assert.deepEqual(receipt.details, { code: 'authorization_read_only', executed: false, tool: 'project_write', purpose: 'background-work', authorization: 'read', readOnly: true, writes: true });
  const stub = surfaceStub({ name: 'ask_user', description: 'Ask', parameters: { type: 'object', properties: {} }, permission: 'read' }, 'background-work');
  assert.equal((await stub.execute('call', {})).details.code, 'tool_unavailable_for_purpose');
  const note = JSON.parse(authorizationContext({ purpose: 'background-work', level: 'read', readOnly: true, executable: ['project_read', 'project_grep'], unavailable: ['project_write'] }).text);
  assert.deepEqual(note.executableTools, ['project_grep', 'project_read']); assert.equal(note.readOnly, true);
  assert.equal(note.notDeclaredHere, undefined, 'a block without not-declared tools is byte-identical to the one before a lean surface existed');
  assert.equal(authorizationContext({ purpose: 'background-work', level: 'execute', executable: ['project_read'], notDeclared: [] }).text, authorizationContext({ purpose: 'background-work', level: 'execute', executable: ['project_read'] }).text);
  // A lean surface (a scheduled run) names the tools it did not declare, sorted, with one fixed English rule.
  const lean = JSON.parse(authorizationContext({ purpose: 'background-work', level: 'execute', executable: ['project_read'], unavailable: [], notDeclared: ['ask_user', 'agent_consult'] }).text);
  assert.deepEqual(lean.notDeclaredHere, ['agent_consult', 'ask_user']); assert.equal(lean.notDeclaredRule, NOT_DECLARED_RULE);
  assert.equal(NOT_DECLARED_RULE, 'Tools in notDeclaredHere are not available in this run; do not call them.');
});

test('host instruction blocks carry the host label, not the retrieved-data label', () => {
  const ctx = prepareContext({ messages: [{ id: 'a', role: 'user', content: [{ type: 'text', text: 'Host instructions for this request.' }], context: [purposeContext('do bounded work')] }] });
  assert.ok(ctx.messages[0].content.at(-1).text.startsWith(HOST_INSTRUCTION_LABEL));
  const data = prepareContext({ messages: [{ id: 'b', role: 'user', content: [{ type: 'text', text: 'x' }], context: [{ source: 'project-memory', text: 'm' }] }] });
  assert.match(data.messages[0].content.at(-1).text, /^\[Retrieved reference data/);
});

test('initial context precedes the first user message once, so two purposes share a byte-identical provider prefix', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rna-prompt-layers-')), handles = [];
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(directory, { recursive: true, force: true }); });
  const bodies = {};
  const open = async (id, purposeText, extraTool) => {
    const session = await createSession({ sessionId: id, projectId: 'project', cacheScope: 'project:project', stateDir: join(directory, id), cwd: directory, model, autoCompaction: false, systemPrompt: 'Shared base method and project snapshot.',
      tools: [tool('project_read'), tool('project_write', 'write'), extraTool], initialContext: shared,
      beforeRequest: () => ({ contextUpdates: [...shared, purposeContext(purposeText), authorizationContext({ purpose: id, level: 'read', readOnly: true })] }),
      provider: async function* (request) { (bodies[id] ??= []).push(buildRequest({ model, systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools, cache: request.cache }).body); yield { type: 'text_delta', delta: 'ok' }; yield { type: 'done', stopReason: 'stop' }; } });
    handles.push(session); return session;
  };
  const surface = tool('ask_user');
  const foreground = await open('foreground', 'Answer the user.', surface), background = await open('background-work', 'Do one bounded background task.', surfaceStub(surface, 'background-work'));
  await foreground.prompt('user question'); await background.prompt('background intent'); await foreground.prompt('follow up');
  const [fg, bg] = [bodies.foreground[0], bodies['background-work'][0]];
  assert.equal(JSON.stringify(fg.tools), JSON.stringify(bg.tools));
  assert.deepEqual(fg.messages.slice(0, 3), bg.messages.slice(0, 3), 'system + skill catalog + orientation are shared');
  assert.match(fg.messages[3].content, /user question/); assert.match(bg.messages[3].content, /background intent/);
  assert.match(fg.messages.at(-1).content, /host-authorization/);
  const second = bodies.foreground[1];
  assert.deepEqual(second.messages.slice(0, fg.messages.length + 1).slice(0, fg.messages.length), fg.messages, 'later requests append; seeded blocks are not repeated');
  assert.equal(second.messages.filter(message => String(message.content).includes('workspace-orientation')).length, 1);
  assert.equal(foreground.snapshot().cache.sessionKey, background.snapshot().cache.sessionKey, 'cacheScope keys routing per project, not per session');
});

test('compaction requests are tagged for purpose metering', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rna-prompt-layers-compaction-')); const purposes = [];
  const session = await createSession({ sessionId: 's', projectId: 'p', stateDir: join(directory, 's'), cwd: directory, model, autoCompaction: false,
    provider: async function* (request) { purposes.push(request.purpose ?? 'response'); yield { type: 'text_delta', delta: 'summary' }; yield { type: 'done', stopReason: 'stop' }; } });
  t.after(async () => { await session.dispose(); await rm(directory, { recursive: true, force: true }); });
  await session.prompt('one'); await session.prompt('two'); await session.prompt('three');
  await session.compact({ keepLastTurns: 1, generate: true });
  assert.deepEqual(purposes, ['response', 'response', 'response', 'compaction']);
});

test('a tool-free initiative decision reuses the published agent prefix only where tool use is verifiably disabled', async t => {
  const { decideInitiative } = await import('../src/initiative.mjs');
  const deepseek = { providerId: 'ds', modelId: 'deepseek-v4-pro', protocol: 'openai', baseUrl: 'https://api.deepseek.com', contextWindow: 64000, maxOutputTokens: 1000 };
  const prefix = { systemPrompt: 'Shared base method and project snapshot.', tools: [tool('project_read'), tool('project_write', 'write')].map(({ execute, ...declaration }) => declaration), initialContext: shared, cacheScope: 'project:project' };
  const directory = await mkdtemp(join(tmpdir(), 'rna-prompt-layers-decision-'));
  const captured = [];
  const provider = async function* (request) { captured.push(request); yield { type: 'text_delta', delta: JSON.stringify({ action: 'wait', reason: 'nothing new', evidenceIds: [], content: '', nextReviewAfterMs: 60000 }) }; yield { type: 'done', stopReason: 'stop' }; };
  const session = await createSession({ sessionId: 'fg', projectId: 'project', cacheScope: prefix.cacheScope, stateDir: join(directory, 'fg'), cwd: directory, model: deepseek, autoCompaction: false, systemPrompt: prefix.systemPrompt, tools: [tool('project_read'), tool('project_write', 'write')], initialContext: shared, provider });
  t.after(async () => { await session.dispose(); await rm(directory, { recursive: true, force: true }); });
  await session.prompt('user question');
  assert.equal((await decideInitiative({ project: { id: 'project' }, model: deepseek, provider, sharedPrefix: () => prefix })).status, 'decided');
  const [agent, decision] = captured.map(request => buildRequest({ model: deepseek, systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools, cache: request.cache, toolChoice: request.toolChoice, responseFormat: request.responseFormat }).body);
  assert.equal(decision.tool_choice, 'none', 'declared tools can never be called by the decision');
  assert.equal(JSON.stringify(decision.tools), JSON.stringify(agent.tools));
  assert.deepEqual(decision.messages.slice(0, 3), agent.messages.slice(0, 3), 'system + seeded catalog/orientation are byte-identical to the agent request');
  assert.match(decision.messages[3].content, /host-purpose-instructions/); assert.equal(captured[1].cache.sessionKey, captured[0].cache.sessionKey);
  const unverified = { ...deepseek, baseUrl: 'https://proxy.invalid/v1' };
  await decideInitiative({ project: { id: 'project' }, model: unverified, provider, sharedPrefix: () => prefix });
  assert.deepEqual(captured.at(-1).tools, [], 'without verified tool disabling the decision stays tool-free');
});

test('delegation tools present the same declarations in every purpose; background and proactive stubs refuse to run them', async () => {
  const { createDelegationTools } = await import('../src/agent-delegation.mjs');
  const { declarationOf } = await import('../src/prompt-layers.mjs');
  let ran = 0;
  const control = Object.fromEntries(['status', 'message', 'wait', 'cancel', 'merge'].map(key => [key, async () => { ran++; return { content: [] }; }]));
  const foreground = createDelegationTools(async () => { ran++; return { content: [] }; }, control);
  for (const purpose of ['background-work', 'initiative']) {
    const stubs = foreground.map(row => surfaceStub(declarationOf(row), purpose));
    assert.equal(JSON.stringify(stubs.map(declarationOf)), JSON.stringify(foreground.map(declarationOf)), `${purpose}: identical names, descriptions and schemas (includeConversation, files)`);
    const refused = await stubs.find(row => row.name === 'agent_consult').execute('call', { role: 'scout', task: 'Inspect.' });
    assert.equal(refused.details.code, 'tool_unavailable_for_purpose'); assert.equal(refused.details.executed, false);
    // agent_merge (0.63) is declared alike and refused alike outside the foreground.
    const merge = await stubs.find(row => row.name === 'agent_merge').execute('call', { agentId: 'agent-1' });
    assert.equal(merge.details.code, 'tool_unavailable_for_purpose'); assert.equal(merge.details.executed, false);
  }
  assert.equal(ran, 0, 'delegation stays unavailable outside the foreground');
});
