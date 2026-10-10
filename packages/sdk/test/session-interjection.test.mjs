import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';

// Plan 2026-09-30 §3.1 input.interjection: a correction sent while the model
// is still writing can stop that response; the run continues with the input.
const model = { providerId: 'test', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 32000, maxOutputTokens: 1000, reasoning: 'off' };

test('interject stops only the streaming response and the run continues with the queued steering', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-interject-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = []; let session, release;
  const gate = new Promise(resolve => { release = resolve; });
  session = await createSession({ sessionId: 'i', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model, provider: async function* (request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: 'text_delta', delta: '第一章：他走进了雨里' };
      release();
      // A long answer keeps streaming until the request signal stops it.
      while (true) { await new Promise(resolve => setTimeout(resolve, 5)); request.signal.throwIfAborted(); yield { type: 'text_delta', delta: '，' }; }
    }
    const last = request.messages.at(-1);
    assert.equal(last.role, 'user'); assert.match(JSON.stringify(last.content), /改成第一人称/);
    assert.ok(request.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('他走进了雨里')), 'the partial answer stays in context');
    yield { type: 'text_delta', delta: '好，改成第一人称：我走进了雨里。' }; yield { type: 'done' };
  } });
  t.after(() => session.dispose());
  assert.equal(session.interject(), false, 'nothing is streaming yet');
  const run = session.prompt('写第一章');
  await gate;
  assert.equal(session.interject(), false, 'no queued input, nothing to interject');
  await session.steer('不对，改成第一人称');
  assert.equal(session.interject(), true);
  await run;
  assert.equal(requests.length, 2);
  const messages = session.snapshot().messages.filter(message => message.role === 'assistant');
  assert.equal(messages[0].interjected, true); assert.equal(messages[0].stopReason, 'stop');
  assert.match(messages.at(-1).content[0].text, /我走进了雨里/);
});
