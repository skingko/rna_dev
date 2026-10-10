import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFastCrwTools } from '../src/fastcrw-tools.mjs';

const json = (res, body, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const rows = { success: true, data: { results: [{ url: 'https://example.com/source', title: 'Source', snippet: 'Publication date must be checked.' }] } };
const degraded = { success: false, errorCode: 'search_degraded', error: 'untrusted server details' };
const read = output => JSON.parse(output.content[0].text);
async function fixture(t, handler) {
  const requests = [], server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const row = { path: req.url, method: req.method, headers: req.headers, body: JSON.parse(raw) }; requests.push(row);
    await handler(row, res, requests.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const options = { baseUrl: `http://127.0.0.1:${server.address().port}` };
  const execute = (args, signal, overrides = {}) => createFastCrwTools({ ...options, ...overrides })[0].execute('search', args, signal);
  return { requests, execute, tools: createFastCrwTools(options) };
}

test('new model schema excludes time filtering and makes exactly one ordinary search request', async t => {
  const f = await fixture(t, (_req, res) => json(res, rows));
  assert.equal(Object.hasOwn(f.tools[0].parameters.properties, 'tbs'), false); assert.doesNotMatch(f.tools[0].description, /fallback|filterApplied|qdr:/);
  const args = { query: 'new AI model release announcement', limit: 10, lang: 'zh-CN', sources: ['web', 'news'] };
  const output = await f.execute(args, undefined, { apiKey: 'isolated-credential' }), value = read(output);
  assert.equal(output.isError, undefined); assert.equal(value.ok, true); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/v1/search'); assert.equal(f.requests[0].method, 'POST'); assert.deepEqual(f.requests[0].body, args);
  for (const field of ['filterApplied', 'filterStatus', 'requestedFilters', 'submittedFilters', 'attempts', 'notice']) { assert.equal(Object.hasOwn(value, field), false); assert.equal(Object.hasOwn(output.details, field), false); }
  assert.deepEqual(value.warnings, []); assert.ok(!JSON.stringify(output).includes('isolated-credential'));
});

test('persisted legacy calls discard every old valid tbs value before dispatch, preserving other supported arguments', async t => {
  const f = await fixture(t, (request, res) => json(res, Object.hasOwn(request.body, 'tbs') ? degraded : rows, Object.hasOwn(request.body, 'tbs') ? 503 : 200));
  for (const tbs of ['qdr:h', 'qdr:d', 'qdr:w', 'qdr:m', 'qdr:y']) {
    const args = { query: 'old persisted query', tbs, limit: 8, lang: 'en', sources: ['news'] }, before = f.requests.length;
    const output = await f.execute(args); assert.equal(output.isError, undefined); assert.equal(f.requests.length, before + 1);
    assert.deepEqual(f.requests.at(-1).body, { query: args.query, limit: 8, lang: 'en', sources: ['news'] }); assert.deepEqual(args, { query: 'old persisted query', tbs, limit: 8, lang: 'en', sources: ['news'] });
  }
});

for (const [name, status, payload, headers] of [
  ['search_degraded', 503, degraded],
  ['generic upstream 503', 503, { success: false, error: 'failed' }],
  ['disabled backend', 503, { success: false, errorCode: 'search_disabled' }],
  ['gateway failure', 502, degraded],
  ['auth failure', 401, degraded],
  ['rate limit', 429, degraded],
  ['success HTTP with rejected operation', 200, degraded],
  ['retry-after backoff', 503, degraded, { 'Retry-After': '30' }],
]) test(`${name} remains one failed request even when replaying legacy tbs input`, async t => {
  const f = await fixture(t, (_req, res) => json(res, payload, status, headers));
  const output = await f.execute({ query: 'ai tools', tbs: 'qdr:w' });
  assert.equal(output.isError, true); assert.equal(f.requests.length, 1); assert.equal(Object.hasOwn(f.requests[0].body, 'tbs'), false);
  assert.equal(Object.hasOwn(output.details, 'attempts'), false); assert.ok(!JSON.stringify(output).includes('untrusted server details'));
});

test('empty ordinary results keep absence limits without a synthetic time-filter notice', async t => {
  const f = await fixture(t, (_req, res) => json(res, { success: true, data: [] }));
  const value = read(await f.execute({ query: 'ai tools', tbs: 'qdr:w' }));
  assert.equal(value.ok, true); assert.equal(value.returnedResults, 0); assert.equal(value.notice, undefined); assert.deepEqual(value.warnings, []); assert.match(value.evidence, /do not prove absence/); assert.equal(f.requests.length, 1);
});

test('malformed search response does not cause a second request', async t => {
  const f = await fixture(t, (_req, res) => json(res, { success: true, data: { unexpected: true } }));
  assert.equal(read(await f.execute({ query: 'ai tools', tbs: 'qdr:w' })).code, 'FASTCRW_RESPONSE_INVALID'); assert.equal(f.requests.length, 1);
});

test('single deadline bounds a stalled response body and does not retry without tbs', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200); res.write('{'); });
  const value = read(await f.execute({ query: 'ai tools', tbs: 'qdr:w' }, undefined, { timeoutMs: 50 }));
  assert.equal(value.code, 'FASTCRW_TIMEOUT'); assert.equal(f.requests.length, 1); assert.equal(Object.hasOwn(f.requests[0].body, 'tbs'), false);
});

test('cancellation propagates without dispatching a replacement request', async t => {
  const controller = new AbortController(), f = await fixture(t, (_req, res) => { res.writeHead(200); res.write('{'); controller.abort(); });
  await assert.rejects(f.execute({ query: 'ai tools', tbs: 'qdr:w' }, controller.signal), { code: 'FASTCRW_ABORTED' }); assert.equal(f.requests.length, 1);
});
