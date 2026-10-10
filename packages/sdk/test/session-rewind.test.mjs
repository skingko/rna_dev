import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';

const model = { protocol: 'openai', providerId: 'p', modelId: 'm', input: ['text'], baseUrl: 'http://127.0.0.1:1/v1', maxOutputTokens: 256, contextWindow: 64000, reasoning: 'off' };

test('rewind removes a user message and everything after it from the model context, durably', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-rewind-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [];
  const provider = async function* (request) {
    seen.push(request.messages.map(message => message.role === 'user' ? (message.content.find(part => part.type === 'text')?.text ?? '') : message.role));
    const last = request.messages.at(-1);
    if (last.role === 'user' && /spider/.test(JSON.stringify(last))) { yield { type: 'tool_call', id: 'c1', name: 'note', arguments: {} }; yield { type: 'done' }; return; }
    yield { type: 'text_delta', delta: 'ok' }; yield { type: 'done' };
  };
  const tools = [{ name: 'note', permission: 'read', idempotent: true, parameters: { type: 'object' }, execute: () => ({ content: [{ type: 'text', text: 'noted' }] }) }];
  let s = await createSession({ sessionId: 's', stateDir: dir, cwd: dir, model, provider, tools });
  await s.prompt('first question'); await s.prompt('write a spider'); await s.prompt('third');
  const target = s.snapshot().messages.find(message => message.role === 'user' && JSON.stringify(message).includes('spider'));
  const result = await s.rewind(target.id);
  assert.ok(result.dropped >= 4, 'the message, the tool call, its result and later turns go');
  assert.deepEqual(s.snapshot().messages.map(message => message.role), ['user', 'assistant']);
  await s.prompt('edited question');
  assert.doesNotMatch(JSON.stringify(seen.at(-1)), /spider|third/, 'the model never sees the rewound history again');
  const file = s.snapshot().sessionFile; await s.dispose();
  s = await createSession({ sessionId: 's', stateDir: dir, cwd: dir, model, provider, tools, sessionFile: file });
  t.after(() => s.dispose());
  assert.doesNotMatch(JSON.stringify(s.snapshot().messages), /spider|third/, 'restart replays the rewind');
  assert.match(JSON.stringify(s.snapshot().messages), /edited question/);
  await assert.rejects(s.rewind('missing'), { code: 'invalid_input' });
});
