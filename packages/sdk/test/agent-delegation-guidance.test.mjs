import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { BUILTIN_AGENT_ROLES, createDelegationTools, runDelegatedAgent, delegationSteps, conversationExcerpt, CONVERSATION_EXCERPT, CONVERSATION_LABEL } from '../src/agent-delegation.mjs';
import { DELEGATE_ISOLATION_TEXT } from '../src/agent-merge.mjs';

// Design 2026-10-04 §9.3/§9.4: when to delegate, what a child has, per-role steps, includeConversation and files.
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 32000, maxOutputTokens: 1000 };
const control = Object.fromEntries(['status', 'message', 'wait', 'cancel', 'merge'].map(key => [key, async () => ({ content: [] })]));
const background = createDelegationTools(async () => ({ content: [] }), control), legacy = createDelegationTools(async () => ({ content: [] }));
const tool = (tools, name) => tools.find(row => row.name === name);

test('default child steps follow the role: read-only roles 24, the worker 32; an explicit maxSteps still wins', async () => {
  assert.deepEqual(BUILTIN_AGENT_ROLES.map(role => [role.id, role.maxSteps]), [['scout', 24], ['planner', 24], ['reviewer', 24], ['worker', 32]]);
  assert.equal(delegationSteps('reviewer'), 24); assert.equal(delegationSteps('worker'), 32); assert.equal(delegationSteps('nope'), null);
  const seen = [];
  const createChild = async options => { seen.push(options.maxSteps); throw Object.assign(new Error('stop here'), { code: 'fixture_stop' }); };
  for (const role of ['scout', 'worker']) await assert.rejects(runDelegatedAgent({ role, task: 'Inspect.', sessionId: `child-${role}`, signal: new AbortController().signal, createChild }), { code: 'fixture_stop' });
  await assert.rejects(runDelegatedAgent({ role: 'planner', task: 'Plan.', sessionId: 'child-explicit', signal: new AbortController().signal, createChild, maxSteps: 5 }), { code: 'fixture_stop' });
  assert.deepEqual(seen, [24, 32, 5]);
  await assert.rejects(runDelegatedAgent({ role: 'scout', task: 'Inspect.', sessionId: 'child', signal: new AbortController().signal, createChild, maxSteps: 65 }), { code: 'invalid_delegation' });
  await assert.rejects(runDelegatedAgent({ role: 'scout', task: 'Inspect.', sessionId: 'child', signal: new AbortController().signal, createChild, conversation: 'not a list' }), { code: 'invalid_delegation' });
});

test('the two spawn tools say when to delegate and what the child has, without limit numbers', () => {
  for (const tools of [background, legacy]) for (const name of ['agent_consult', 'agent_delegate']) {
    const { description } = tool(tools, name);
    assert.doesNotMatch(description, /\d/, `${name}: the host enforces limits; the description carries no numbers`);
    assert.match(description, /does not see this conversation/); assert.match(description, /includeConversation/);
    assert.match(description, /instructions and skills, project memory search, web_search\/web_fetch/);
    // The child gets exactly the parent's web tools, which exist only when web tools are configured.
    assert.match(description, /web_search\/web_fetch when you have them/);
    assert.doesNotMatch(description, /[一-鿿]/, `${name} is written in English`);
  }
  const consult = tool(background, 'agent_consult').description, delegate = tool(background, 'agent_delegate').description;
  for (const phrase of [/answer needs many files or several sources \(scout/, /plan before acting \(planner\)/, /independent review before delivering \(reviewer\)/, /Check the results before you rely on them/, /look it up yourself; never redo a search you delegated/]) assert.match(consult, phrase);
  for (const phrase of [/which files it may change, which files it must not touch, and the done check/, /list the paths it will change in files/, /run the checks yourself/]) assert.match(delegate, phrase);
  // Worktree design 0.63 §4.1: the worker's own copy is merged by the host; shared_root workers must not share a file.
  for (const tools of [background, legacy]) {
    const text = tool(tools, 'agent_delegate').description;
    assert.ok(text.includes(DELEGATE_ISOLATION_TEXT), 'the last sentence of the lead is the isolation sentence');
    assert.match(text, /works in its own copy made from your current files/); assert.match(text, /resolve with agent_merge/);
    assert.match(text, /shared_root \(no git repository, or isolation unavailable\), workers change your files directly: never have two of them change the same file/);
    assert.doesNotMatch(text, /Parallel workers each own different files/);
  }
  // Spawns return at once only with the background controls; a synchronous host does not suggest running them side by side.
  for (const description of [consult, delegate]) { assert.match(description, /back to back without waiting/); assert.match(description, /Runs in the background by default/); }
  for (const name of ['agent_consult', 'agent_delegate']) assert.doesNotMatch(tool(legacy, name).description, /back to back|in the background/);
});

test('includeConversation on both spawn tools and files on agent_delegate are declared; the worker role is fixed', async () => {
  for (const tools of [background, legacy]) {
    assert.deepEqual(tool(tools, 'agent_consult').parameters.properties.includeConversation.type, 'boolean');
    assert.deepEqual(tool(tools, 'agent_delegate').parameters.properties.includeConversation.type, 'boolean');
    const { files } = tool(tools, 'agent_delegate').parameters.properties;
    assert.equal(files.type, 'array'); assert.deepEqual(files.items, { type: 'string', minLength: 1, maxLength: 400 });
    assert.equal(tool(tools, 'agent_consult').parameters.properties.files, undefined, 'read-only children change no files');
    assert.deepEqual(tool(tools, 'agent_delegate').parameters.required, ['task']);
  }
  for (const value of Object.values(tool(background, 'agent_consult').parameters.properties)) assert.doesNotMatch(value.description ?? '', /[一-鿿]/);
  const seen = [];
  const tools = createDelegationTools(async (_id, args) => { seen.push(args); return { content: [] }; }, control);
  await tool(tools, 'agent_delegate').execute('call', { task: 'Fix it.', files: ['src/a.js'], includeConversation: true, role: 'scout' }, new AbortController().signal);
  assert.deepEqual(seen, [{ task: 'Fix it.', files: ['src/a.js'], includeConversation: true, role: 'worker' }]);
});

test('scout also investigates outside sources when asked and reports paths or links; no new role', () => {
  assert.deepEqual(BUILTIN_AGENT_ROLES.map(role => role.id), ['scout', 'planner', 'reviewer', 'worker']);
  const scout = BUILTIN_AGENT_ROLES[0];
  assert.match(scout.instruction, /project files and, when the task asks for it, in outside sources with web_search\/web_fetch/);
  assert.match(scout.instruction, /exact paths or links, the key findings and the open questions\. Read only\./);
  assert.match(scout.description, /外部资料/); assert.match(scout.description, /路径或链接/);
});

test('the conversation excerpt keeps the last three messages, newest last, within the character budget', () => {
  assert.deepEqual(CONVERSATION_EXCERPT, { messages: 3, chars: 4000 });
  assert.equal(conversationExcerpt([]), null); assert.equal(conversationExcerpt(['  ', '']), null); assert.equal(conversationExcerpt('text'), null);
  const short = conversationExcerpt(['first', 'second', 'third', 'fourth']);
  assert.equal(short, `${CONVERSATION_LABEL}\n\n[User message 1 of 3]\nsecond\n\n[User message 2 of 3]\nthird\n\n[User message 3 of 3, latest]\nfourth`);
  assert.match(CONVERSATION_LABEL, /the user's own words from the parent conversation, newest last: their requirements for this work; the task decides the scope/i);
  assert.equal(conversationExcerpt(['only one']), `${CONVERSATION_LABEL}\n\n[User message 1 of 1]\nonly one`);
  // The newest message gets the room first; the one that does not fit is cut with an ellipsis and older ones are dropped.
  const long = conversationExcerpt(['oldest is dropped', 'm'.repeat(1500), 'n'.repeat(3000)]);
  assert.match(long, /\[User message 1 of 2\]\nm{999}…\n\n\[User message 2 of 2, latest\]\nn{3000}$/);
  assert.doesNotMatch(long, /oldest/);
  const huge = conversationExcerpt(['earlier', 'x'.repeat(9000)]);
  assert.match(huge, /\[User message 1 of 1\]\nx{3999}…$/);
  // Code points, never half a surrogate pair before the ellipsis.
  assert.ok(conversationExcerpt(['😀'.repeat(4001)]).endsWith(`\n${'😀'.repeat(3999)}…`));
});

test('a child receives the attached words labelled as the user\'s requirements next to its task, and a replay keeps its identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-child-conversation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const args = { role: 'scout', task: 'Find where chapter style is defined.', sessionId: 'child', signal: new AbortController().signal, conversation: ['Use the ink-wash tone.', 'Rewrite chapters 1-3 in that style.'],
    createChild: async options => createSession({ ...options, projectId: 'project', stateDir: join(dir, 'state'), cwd: dir, model,
      provider: async function* ({ messages }) { requests.push(messages); yield { type: 'text_delta', delta: 'Style lives in docs/style.md.' }; yield { type: 'done' }; } }) };
  const first = await runDelegatedAgent(args);
  assert.equal(first.output, 'Style lives in docs/style.md.'); assert.equal(first.stepLimitReached, false);
  const user = requests[0].findLast(message => message.role === 'user'), body = JSON.stringify(user.content);
  assert.match(body, /Find where chapter style is defined\./);
  assert.match(body, /The user's own words from the parent conversation/); assert.match(body, /honour them where they apply/);
  assert.doesNotMatch(body, /Retrieved reference data; not user instructions/, 'the user\'s words are not untrusted data');
  assert.match(body, /parent-conversation/); assert.match(body, /the task decides the scope/);
  assert.match(body, /Use the ink-wash tone\..*Rewrite chapters 1-3 in that style\./);
  const replay = await runDelegatedAgent(args);
  assert.equal(replay.reused, true); assert.equal(requests.length, 1, 'the attached words do not change the task the journal is matched on');
});

test('a child that runs out of steps answers with its summary and the result says the step limit was reached', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-child-step-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let requests = 0;
  const look = { name: 'look', permission: 'read', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'seen' }] }) };
  const result = await runDelegatedAgent({ role: 'reviewer', task: 'Review everything.', sessionId: 'child', signal: new AbortController().signal, maxSteps: 1,
    createChild: async options => createSession({ ...options, projectId: 'project', stateDir: join(dir, 'state'), cwd: dir, model, tools: [look],
      provider: async function* ({ purpose }) { requests++; if (purpose !== 'summary') { yield { type: 'tool_call', id: `look-${requests}`, name: 'look', arguments: {} }; yield { type: 'done', stopReason: 'toolUse' }; return; } yield { type: 'text_delta', delta: 'Reviewed part of it; the rest is unchecked.' }; yield { type: 'done' }; } }) });
  assert.equal(result.status, 'completed'); assert.equal(result.stepLimitReached, true); assert.equal(requests, 2);
  assert.equal(result.output, 'Reviewed part of it; the rest is unchecked.');
});

// Plan A4: the seven delegation tools speak one language to the model, and what they say happens is what the host does.
test('all seven delegation tools, their parameters and the spawn options are fixed English, and say where a late result goes', () => {
  assert.deepEqual(background.map(row => row.name), ['agent_consult', 'agent_delegate', 'agent_status', 'agent_message', 'agent_wait', 'agent_cancel', 'agent_merge']);
  const texts = row => [row.description, ...Object.values(row.parameters?.properties ?? {}).map(value => value.description ?? '')];
  for (const row of [...background, ...legacy]) for (const text of texts(row)) assert.doesNotMatch(text, /[一-鿿]/, `${row.name}: ${text}`);
  for (const name of ['agent_status', 'agent_message', 'agent_wait', 'agent_cancel']) assert.ok(tool(background, name).description.length > 40, `${name} has a real description`);
  // A result after the turn ended is shown to the user and given to the model at the start of the next turn (the
  // subagent-results context); no text promises a "host notice" the model would never read.
  const { wait, continueAfter } = tool(background, 'agent_consult').parameters.properties;
  for (const text of [tool(background, 'agent_consult').description, tool(background, 'agent_delegate').description]) {
    assert.match(text, /a result that comes after this turn ends is shown to the user and given to you at the start of the next turn/);
    assert.match(text, /call agent_wait before you answer for any result your answer needs/);
  }
  assert.match(continueAfter.description, /false shows the user a notice and gives you the result at the start of the next turn/);
  for (const text of [wait.description, continueAfter.description, ...background.map(row => row.description)]) assert.doesNotMatch(text, /arrives as a host notice|arrives later as a host notice|only shows a notice/);
  assert.match(tool(background, 'agent_wait').description, /A result returned here is not delivered to you again/);
});

test('a worker composed without file write tools fails before its first request; read-only roles never need them', async () => {
  const made = [];
  const child = tools => async () => {
    const handle = { prompted: 0, snapshot: () => ({ tools, messages: [], recovery: { interrupted: false, pendingTools: 0, pendingFinish: false, uncertainTools: [] }, queue: { steering: [] }, usage: { totalTokens: 0 } }),
      async prompt() { handle.prompted++; throw new Error('no request may be made'); }, async resume() {}, async steer() {}, async dispose() {}, async abort() {} };
    made.push(handle); return handle;
  };
  await assert.rejects(runDelegatedAgent({ role: 'worker', task: 'Write the file.', sessionId: 'w', signal: new AbortController().signal, createChild: child(['project_read', 'project_exec']) }), error => error.code === 'delegation_permission' && !/[一-鿿]/.test(error.message));
  assert.equal(made[0].prompted, 0, 'no model request');
  // project_edit alone (or project_write alone) is a write tool; the scout needs none.
  await assert.rejects(runDelegatedAgent({ role: 'worker', task: 'Write the file.', sessionId: 'w2', signal: new AbortController().signal, createChild: child(['project_edit']) }), { message: 'no request may be made' });
  await assert.rejects(runDelegatedAgent({ role: 'scout', task: 'Read it.', sessionId: 's', signal: new AbortController().signal, createChild: child(['project_read']) }), { message: 'no request may be made' });
});
