import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createFastCrwTools, FastCrwError, normalizeFastCrwBaseUrl } from '../src/fastcrw-tools.mjs';

const json = (res, body, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const result = toolResult => JSON.parse(toolResult.content[0].text);
async function server(t, handler) {
  const requests = [], service = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const request = { method: req.method, path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
    requests.push(request); try { await handler(request, res); } catch { if (!res.destroyed) res.destroy(); }
  });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  t.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  return { baseUrl: `http://127.0.0.1:${service.address().port}`, requests };
}
const call = (tools, name, args, signal) => tools.find(tool => tool.name === name).execute('test-call', args, signal);

test('actual search HTTP protocol sends only public parameters, Bearer auth, and no optional LLM request', async t => {
  const key = randomUUID(), f = await server(t, (_req, res) => json(res, { success: true, data: [{ url: 'https://example.com/one', title: 'Source', snippet: 'Live snippet', score: 9.5, position: 1, category: 'general' }] }));
  const tools = createFastCrwTools({ ...f, apiKey: key });
  assert.deepEqual(tools.map(({ name, permission, effect, idempotent }) => ({ name, permission, effect, idempotent })), ['web_search', 'web_fetch'].map(name => ({ name, permission: 'read', effect: 'read', idempotent: true })));
  assert.ok(!JSON.stringify(tools).includes(key));
  const output = await call(tools, 'web_search', { query: 'source query', lang: 'zh-CN', tbs: 'qdr:h', sources: ['web', 'news'], limit: 3 });
  assert.equal(output.isError, undefined); const data = result(output);
  assert.equal(data.returnedResults, 1); assert.equal(data.truncated, false); assert.equal(data.results[0].snippet, 'Live snippet'); assert.match(data.evidence, /not full-page verification/);
  assert.equal(f.requests[0].method, 'POST'); assert.equal(f.requests[0].path, '/v1/search'); assert.equal(f.requests[0].headers.authorization, `Bearer ${key}`);
  assert.deepEqual(f.requests[0].body, { query: 'source query', lang: 'zh-CN', sources: ['web', 'news'], limit: 3 }); assert.equal(f.requests.length, 1);
  assert.equal(Object.hasOwn(tools[0].parameters.properties, 'tbs'), false);
});

test('self-hosted search data.results and grouped web/news/images are normalized without claiming generated answers as sources', async t => {
  const f = await server(t, (_req, res) => json(res, { success: true, data: { results: { web: [{ url: 'https://example.com/a', title: 'A', description: 'A snippet' }], news: [{ url: 'https://example.com/b', title: 'B', snippet: 'B snippet' }], images: [{ imageUrl: 'https://example.com/c.png', title: 'C' }] }, answer: 'UNVERIFIED_GENERATED_ANSWER', citations: [{ injected: true }], warnings: ['Search backend notice'] } }));
  const data = result(await call(createFastCrwTools(f), 'web_search', { query: 'q', sources: ['web', 'news', 'images'] }));
  assert.deepEqual(data.results.map(row => row.source), ['web', 'news', 'images']); assert.equal(data.results[0].snippet, 'A snippet'); assert.deepEqual(data.warnings, ['Search backend notice']); assert.ok(!JSON.stringify(data).includes('UNVERIFIED_GENERATED_ANSWER'));
  assert.equal(f.requests[0].headers.authorization, undefined);
});

test('search result limit, malformed rows and long snippets retain explicit coverage limits', async t => {
  const f = await server(t, (_req, res) => json(res, { success: true, data: [{ url: 'javascript:bad', title: 'bad' }, { url: 'https://example.com/a', title: 'A', snippet: '中'.repeat(4000) }, { url: 'https://example.com/b', title: 'B' }] }));
  const data = result(await call(createFastCrwTools(f), 'web_search', { query: 'q', limit: 1 }));
  assert.equal(data.returnedResults, 1); assert.equal(data.omittedResults, 1); assert.equal(data.truncated, true); assert.equal(data.results[0].snippet.length, 3000);
});

test('empty search results remain a bounded query result, not a claim that no source exists', async t => {
  const f = await server(t, (req, res) => json(res, { success: true, data: req.body.query === 'grouped' ? {} : [] }));
  for (const query of ['none', 'grouped']) {
    const data = result(await call(createFastCrwTools(f), 'web_search', { query }));
    assert.equal(data.ok, true); assert.deepEqual(data.results, []); assert.match(data.evidence, /do not prove absence/);
  }
});

test('entirely malformed search rows are a protocol failure rather than a misleading empty success', async t => {
  const f = await server(t, (_req, res) => json(res, { success: true, data: [{ title: 'Missing URL' }, { url: 'javascript:alert(1)', title: 'Invalid URL' }] }));
  const output = await call(createFastCrwTools(f), 'web_search', { query: 'q' }); assert.equal(output.isError, true); assert.equal(result(output).code, 'FASTCRW_RESPONSE_INVALID');
});

test('scrape sends Markdown-only extraction and retains provenance plus exact full-content hash before truncation', async t => {
  const markdown = '# Source\n\n' + '中😀'.repeat(500), f = await server(t, (_req, res) => json(res, { success: true, warning: 'Partial renderer support', data: { markdown, metadata: { title: 'Title', sourceURL: 'https://example.com/canonical', description: 'Description', statusCode: 200, arbitrarySecret: 'NEVER_COPY_METADATA' }, warning: 'Extraction advisory', warnings: ['Another advisory'], html: '<script>UNSAFE_HTML</script>' } }));
  const output = await call(createFastCrwTools({ ...f, maxContentChars: 256 }), 'web_fetch', { url: 'https://example.com/article#part', maxChars: 1000 }); const data = result(output);
  assert.deepEqual(f.requests[0].body, { url: 'https://example.com/article', formats: ['markdown'] }); assert.equal(f.requests[0].path, '/v1/scrape');
  assert.equal(data.sourceUrl, 'https://example.com/canonical'); assert.equal(data.requestedUrl, 'https://example.com/article'); assert.equal(data.title, 'Title'); assert.equal(data.targetStatus, 200);
  assert.equal(data.truncated, true); assert.ok(data.returnedChars <= 256); assert.ok(!/[\uD800-\uDBFF]$/.test(data.markdown)); assert.equal(data.sourceHash, createHash('sha256').update(markdown).digest('hex')); assert.equal(output.details.sourceHash, data.sourceHash);
  assert.equal(data.warnings.length, 3); assert.ok(!JSON.stringify(data).includes('UNSAFE_HTML')); assert.ok(!JSON.stringify(data).includes('NEVER_COPY_METADATA')); assert.match(data.evidence, /not publication time/);
});

test('API responses cannot reflect the configured credential into source content, warnings or URLs', async t => {
  const key = randomUUID(), f = await server(t, (req, res) => req.path.endsWith('/search') ? json(res, { success: true, warnings: [key], data: [{ title: key, url: `https://example.com/${key}`, snippet: key }] }) : json(res, { success: true, data: { markdown: `prefix ${key}`, metadata: { title: key, sourceURL: `https://example.com/${key}` }, warnings: [key] } }));
  const tools = createFastCrwTools({ ...f, apiKey: key });
  for (const output of [await call(tools, 'web_search', { query: key }), await call(tools, 'web_fetch', { url: 'https://example.com' })]) { assert.ok(!JSON.stringify(output).includes(key)); assert.match(JSON.stringify(output), /REDACTED/); }
});

test('configuration validation rejects unsafe endpoints without echoing secret userinfo', () => {
  const credential = randomUUID();
  for (const baseUrl of [undefined, `https://${credential}@example.com`, 'https://example.com?key=x', 'https://example.com/#x', 'http://remote.example.com', 'file:///tmp/x', 'https://example.com\n']) assert.throws(() => createFastCrwTools({ baseUrl }), error => error instanceof FastCrwError && error.code === 'FASTCRW_CONFIGURATION' && !String(error).includes(credential));
  assert.equal(normalizeFastCrwBaseUrl('https://example.com/prefix/v1/'), 'https://example.com/prefix'); assert.equal(normalizeFastCrwBaseUrl('http://[::1]:1234/'), 'http://[::1]:1234');
  for (const overrides of [{ timeoutMs: 0 }, { timeoutMs: 120001 }, { maxResponseBytes: 2 }, { maxContentChars: 255 }, { apiKey: 'bad\r\nheader' }]) assert.throws(() => createFastCrwTools({ baseUrl: 'https://example.com', ...overrides }), { code: 'FASTCRW_CONFIGURATION' });
});

test('invalid query, URL and schema extensions are refused before any network dispatch', async t => {
  const f = await server(t, (_req, res) => json(res, { success: true, data: [] })), tools = createFastCrwTools(f);
  for (const args of [{}, { query: ' ' }, { query: 1 }, { query: 'q', limit: 21 }, { query: 'q', tbs: 'today' }, { query: 'q', lang: '\n' }, { query: 'q', sources: [] }, { query: 'q', sources: ['web', 'web'] }, { query: 'q', scrapeOptions: {} }]) assert.equal(result(await call(tools, 'web_search', args)).code, 'FASTCRW_ARGUMENTS');
  for (const args of [{}, { url: 'file:///etc/passwd' }, { url: 'https://name:password@example.com' }, { url: 'https://example.com', headers: { Authorization: 'secret' } }, { url: 'https://example.com', maxChars: 0 }]) assert.equal(result(await call(tools, 'web_fetch', args)).code, 'FASTCRW_ARGUMENTS');
  assert.equal(f.requests.length, 0);
});

test('cross-origin and same-origin API redirects are never followed with credentials', async t => {
  const sink = await server(t, (_req, res) => json(res, { success: true, data: [] })), key = randomUUID();
  const f = await server(t, (req, res) => { res.writeHead(307, { Location: req.body.query === 'cross' ? `${sink.baseUrl}/steal` : '/redirect' }); res.end(); });
  for (const query of ['cross', 'same']) assert.equal(result(await call(createFastCrwTools({ ...f, apiKey: key }), 'web_search', { query })).code, 'FASTCRW_REDIRECT');
  assert.equal(f.requests.length, 2); assert.equal(sink.requests.length, 0);
});

for (const [status, payload, code] of [
  [401, { success: false, error: 'credential reflected' }, 'FASTCRW_AUTH'],
  [403, { success: false, error: 'denied' }, 'FASTCRW_AUTH'],
  [429, { success: false, error: 'limit' }, 'FASTCRW_RATE_LIMIT'],
  [503, { success: false, errorCode: 'search_disabled', error: 'disabled' }, 'FASTCRW_SEARCH_DISABLED'],
  [502, { success: false, error: 'gateway' }, 'FASTCRW_UPSTREAM'],
  [400, { success: false, error: 'bad request' }, 'FASTCRW_REQUEST_REJECTED'],
  [200, { success: false, error: 'challenge', data: { block: { reason: 'anti_bot' } } }, 'FASTCRW_TARGET_BLOCKED'],
]) test(`HTTP/API failure ${status}/${code} is classified without retry or raw server details`, async t => {
  const key = randomUUID(), f = await server(t, (_req, res) => json(res, { ...payload, error: payload.error + key }, status, { 'Retry-After': '2' }));
  const output = await call(createFastCrwTools({ ...f, apiKey: key }), 'web_search', { query: 'q' });
  assert.equal(output.isError, true); assert.equal(result(output).code, code); assert.equal(result(output).status, status); assert.ok(!JSON.stringify(output).includes(key)); assert.equal(f.requests.length, 1); if (status === 429) assert.equal(result(output).retryAfterMs, 2000);
});

test('HTML HTTP errors retain status classification and never expose upstream text', async t => {
  const f = await server(t, (_req, res) => { res.writeHead(401, { 'Content-Type': 'text/html' }); res.end('<h1>PRIVATE_ERROR_DETAIL</h1>'); });
  const output = await call(createFastCrwTools(f), 'web_search', { query: 'q' }); assert.equal(result(output).code, 'FASTCRW_AUTH'); assert.ok(!JSON.stringify(output).includes('PRIVATE_ERROR_DETAIL'));
});

test('authentication and rate limit status settle without consuming a hanging response body', async t => {
  const f = await server(t, (_req, res) => { res.writeHead(401); res.write('untrusted body'); });
  const output = await call(createFastCrwTools({ ...f, timeoutMs: 50 }), 'web_search', { query: 'q' }); assert.equal(result(output).code, 'FASTCRW_AUTH');
});

test('successful HTTP with malformed JSON or unsupported envelopes is a protocol error', async t => {
  const f = await server(t, (req, res) => {
    if (req.body.query === 'json') return res.end('{"success":');
    if (req.body.query === 'utf8') return res.end(Buffer.from([0xff]));
    return json(res, req.body.query === 'missing' ? { data: [] } : { success: true, data: { unexpected: [] } });
  });
  for (const query of ['json', 'utf8', 'missing', 'shape']) assert.equal(result(await call(createFastCrwTools(f), 'web_search', { query })).code, 'FASTCRW_RESPONSE_INVALID');
});

test('empty Markdown, challenge pages and target 404 are not presented as verified content', async t => {
  const f = await server(t, (req, res) => json(res, { success: true, data: req.body.url.endsWith('/empty') ? { markdown: '  ' } : req.body.url.endsWith('/block') ? { markdown: 'Challenge', block: {} } : { markdown: 'Not found', metadata: { statusCode: 404 } } }));
  for (const [path, expected] of [['empty', 'FASTCRW_EMPTY_CONTENT'], ['block', 'FASTCRW_TARGET_BLOCKED'], ['missing', 'FASTCRW_TARGET_HTTP']]) assert.equal(result(await call(createFastCrwTools(f), 'web_fetch', { url: `https://example.com/${path}` })).code, expected);
});

test('both advertised and chunked response size are bounded before JSON materialization', async t => {
  const f = await server(t, (req, res) => {
    res.writeHead(200, req.body.query === 'length' ? { 'Content-Length': '2000' } : { 'Transfer-Encoding': 'chunked' });
    res.write('x'.repeat(1500)); if (req.body.query !== 'length') res.end();
  });
  for (const query of ['length', 'chunked']) assert.equal(result(await call(createFastCrwTools({ ...f, maxResponseBytes: 1024 }), 'web_search', { query })).code, 'FASTCRW_RESPONSE_TOO_LARGE');
});

test('timeout bounds both header wait and stalled streaming body; no retries', async t => {
  const f = await server(t, (req, res) => { if (req.body.query === 'body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"success":true,"data":['); } });
  for (const query of ['headers', 'body']) {
    const started = Date.now(), output = await call(createFastCrwTools({ ...f, timeoutMs: 50 }), 'web_search', { query });
    assert.equal(result(output).code, 'FASTCRW_TIMEOUT'); assert.ok(Date.now() - started < 2000);
  }
  assert.equal(f.requests.length, 2);
});

test('caller abort before dispatch or during streaming throws a clean abort rather than a success/error receipt', async t => {
  const key = randomUUID(), f = await server(t, (_req, res) => { res.writeHead(200); res.write('{'); }), tools = createFastCrwTools({ ...f, apiKey: key });
  const already = new AbortController(); already.abort(new Error(key));
  await assert.rejects(call(tools, 'web_search', { query: 'q' }, already.signal), error => error.name === 'AbortError' && error.code === 'FASTCRW_ABORTED' && !String(error).includes(key)); assert.equal(f.requests.length, 0);
  const during = new AbortController(), pending = call(tools, 'web_search', { query: 'q' }, during.signal);
  const timer = setTimeout(() => during.abort(new Error(key)), 40);
  await assert.rejects(pending, { code: 'FASTCRW_ABORTED' }); clearTimeout(timer); assert.equal(f.requests.length, 1);
});

test('network transport exceptions are sanitized, not rethrown with endpoint or credential detail', async () => {
  const key = randomUUID(), tools = createFastCrwTools({ baseUrl: 'https://example.com', apiKey: key, fetchImpl: async () => { throw new Error(`network ${key}`); } });
  const output = await call(tools, 'web_search', { query: 'q' }); assert.equal(result(output).code, 'FASTCRW_NETWORK'); assert.ok(!JSON.stringify(output).includes(key));
});
